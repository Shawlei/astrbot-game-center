'use strict';
// 额度结算：直连 NewAPI 远程 MySQL，对 users.quota 做原子扣/加。
const mysql = require('mysql2/promise');

let pool = null;

async function init(cfg) {
  if (!cfg.host) return;
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port || 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || 'new-api',
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
    connectTimeout: 10000,
  });
}

function ready() {
  return !!pool;
}

// 原子扣款（余额不足则失败）
async function debit(uid, amount) {
  if (!pool) throw new Error('db not configured');
  const [r] = await pool.query(
    'UPDATE users SET quota = quota - ? WHERE id = ? AND quota >= ? AND deleted_at IS NULL',
    [amount, uid, amount],
  );
  return r.affectedRows === 1;
}

// 加款
async function credit(uid, amount) {
  if (!pool) throw new Error('db not configured');
  await pool.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [amount, uid]);
  return true;
}

// 查询余额（quota），不存在返回 null
async function balance(uid) {
  if (!pool) return null;
  const [r] = await pool.query('SELECT quota FROM users WHERE id = ? AND deleted_at IS NULL', [uid]);
  return r.length ? Number(r[0].quota) : null;
}

// 按用户名查用户（登录用）
async function getUserByUsername(username) {
  if (!pool) return null;
  const [r] = await pool.query(
    'SELECT id, username, display_name, quota, status FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1',
    [username],
  );
  return r.length ? r[0] : null;
}

// 开战：双方各扣 amount（事务，任一方余额不足整体回滚）
async function settleStart(uid1, uid2, amount) {
  if (!pool) throw new Error('db not configured');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r1] = await conn.query(
      'UPDATE users SET quota = quota - ? WHERE id = ? AND quota >= ? AND deleted_at IS NULL',
      [amount, uid1, amount],
    );
    if (r1.affectedRows !== 1) throw new Error('p1_insufficient');
    const [r2] = await conn.query(
      'UPDATE users SET quota = quota - ? WHERE id = ? AND quota >= ? AND deleted_at IS NULL',
      [amount, uid2, amount],
    );
    if (r2.affectedRows !== 1) throw new Error('p2_insufficient');
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback();
    return false;
  } finally {
    conn.release();
  }
}

// 结束：winner 1/2/0(平局)。赢家拿总额(2*amount)，平局各自退回 amount。
async function settleEnd(uid1, uid2, amount, winner) {
  if (!pool) throw new Error('db not configured');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (winner === 1) {
      await conn.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [amount * 2, uid1]);
    } else if (winner === 2) {
      await conn.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [amount * 2, uid2]);
    } else {
      await conn.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [amount, uid1]);
      await conn.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [amount, uid2]);
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback();
    return false;
  } finally {
    conn.release();
  }
}

module.exports = { init, ready, debit, credit, balance, getUserByUsername, settleStart, settleEnd };
