'use strict';
// NewAPI 登录：调站点 /api/user/login 验证用户名密码，成功后直连 MySQL 取用户信息，签发 session token。
const crypto = require('crypto');
const settle = require('./settle');

let newapiBase = '';
const sessions = new Map(); // token -> { userId, username, exp }
const TTL = 24 * 60 * 60 * 1000; // 24 小时

function init(base) {
  newapiBase = (base || '').replace(/\/+$/, '');
}

// 简单限流：同一用户名连续失败计数（防爆破）
const failCount = new Map(); // username -> {count, at}

async function login(username, password) {
  if (!newapiBase) return { error: '站点地址未配置' };
  if (!username || !password) return { error: '请输入用户名和密码' };

  const now = Date.now();
  const f = failCount.get(username);
  if (f && now - f.at < 5 * 60 * 1000 && f.count >= 5) {
    return { error: '尝试次数过多，请 5 分钟后再试' };
  }

  let j = null;
  try {
    const resp = await fetch(newapiBase + '/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    j = await resp.json();
  } catch (e) {
    return { error: '登录服务不可用，请稍后再试' };
  }

  if (!j || j.success !== true) {
    const cnt = (f && now - f.at < 5 * 60 * 1000 ? f.count : 0) + 1;
    failCount.set(username, { count: cnt, at: now });
    return { error: (j && j.message) || '用户名或密码错误' };
  }
  failCount.delete(username);

  const user = await settle.getUserByUsername(username);
  if (!user) return { error: '账号不存在或已被删除' };
  if (user.status != null && user.status !== 1) return { error: '账号已被封禁，请联系管理员' };

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: Number(user.id),
    username: String(user.username || username),
    exp: now + TTL,
  });
  return {
    token,
    userId: Number(user.id),
    username: String(user.username || username),
    quota: Number(user.quota || 0),
  };
}

function resolve(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function logout(token) {
  sessions.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.exp) sessions.delete(t);
}, 60 * 1000).unref();

module.exports = { init, login, resolve, logout };
