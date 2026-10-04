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

// ---- 3 人（斗地主）结算 ----
// 入场：三方各扣 amount（底注，事务，任一方余额不足整体回滚）
async function settleStart3(uid1, uid2, uid3, amount) {
  if (!pool) throw new Error('db not configured');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const uid of [uid1, uid2, uid3]) {
      const [r] = await conn.query(
        'UPDATE users SET quota = quota - ? WHERE id = ? AND quota >= ? AND deleted_at IS NULL',
        [amount, uid, amount],
      );
      if (r.affectedRows !== 1) throw new Error('insufficient');
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

// 结束（3 人）：amount 为底注（入场已各扣），multiplier 为总倍数，landlordWon 地主是否胜。
// 结算公式（相对入场已扣的 amount 做差额，保证总账平衡）：
//   地主赢：地主 +amount*(2*multiplier+1)，每个农民 +amount*(1-multiplier)
//   农民赢：地主 +amount*(1-2*multiplier)，每个农民 +amount*(1+multiplier)
// 结算时若某方余额不足（极端：加倍/炸弹叠加导致远超底注），降级为「各退本金」并标记 degraded。
async function settleEnd3(landlordUid, farmerUid1, farmerUid2, amount, multiplier, landlordWon) {
  if (!pool) throw new Error('db not configured');
  const conn = await pool.getConnection();
  const landlordDelta = landlordWon
    ? amount * (2 * multiplier + 1)
    : amount * (1 - 2 * multiplier);
  const farmerDelta = landlordWon
    ? amount * (1 - multiplier)
    : amount * (1 + multiplier);

  const apply = async (uid, delta) => {
    const q = Math.round(delta);
    if (q >= 0) {
      await conn.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [q, uid]);
    } else {
      const need = -q;
      const [r] = await conn.query(
        'UPDATE users SET quota = quota - ? WHERE id = ? AND quota >= ? AND deleted_at IS NULL',
        [need, uid, need],
      );
      if (r.affectedRows !== 1) throw new Error('insufficient');
    }
  };

  try {
    await conn.beginTransaction();
    await apply(landlordUid, landlordDelta);
    await apply(farmerUid1, farmerDelta);
    await apply(farmerUid2, farmerDelta);
    await conn.commit();
    return { ok: true, degraded: false };
  } catch (e) {
    await conn.rollback();
    // 降级：各退本金 amount
    try {
      await conn.beginTransaction();
      for (const uid of [landlordUid, farmerUid1, farmerUid2]) {
        await conn.query('UPDATE users SET quota = quota + ? WHERE id = ? AND deleted_at IS NULL', [amount, uid]);
      }
      await conn.commit();
      return { ok: true, degraded: true };
    } catch (e2) {
      await conn.rollback();
      return { ok: false };
    }
  } finally {
    conn.release();
  }
}

module.exports = { init, ready, debit, credit, balance, getUserByUsername, settleStart, settleEnd, settleStart3, settleEnd3 };
