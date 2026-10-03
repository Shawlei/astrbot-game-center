'use strict';
// QQ -> NewAPI 账号绑定解析：直读 AstrBot 插件的 bindings.json（宿主机路径）。
// 用于单机小游戏即时下注结算（无需插件轮询）。只读，带短缓存。
const fs = require('fs');

let file = '';
let cache = { data: {}, at: 0 };
const TTL = 5000; // 5 秒缓存，避免每次请求读盘

function init(f) {
  file = f || '';
}

function load() {
  cache.data = {};
  try {
    if (file && fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache.data = (j && j.bindings) || {};
    }
  } catch (e) {
    cache.data = {};
  }
  cache.at = Date.now();
}

function fresh() {
  if (Date.now() - cache.at > TTL) load();
  return cache.data;
}

// qq -> { userId:number, username:string } 或 null
function resolveQQ(qq) {
  const rec = fresh()[String(qq)];
  if (!rec || rec.user_id == null) return null;
  return { userId: Number(rec.user_id), username: String(rec.username || qq) };
}

// userId -> username（排行榜反查）
function usernameByUserId(userId) {
  const bindings = fresh();
  for (const qq in bindings) {
    const r = bindings[qq];
    if (String(r.user_id) === String(userId)) return String(r.username || qq);
  }
  return null;
}

// 全量绑定关系（管理后台展示用）：{ qq: { user_id, username } }
function list() {
  return fresh();
}

module.exports = { init, resolveQQ, usernameByUserId, list };
