'use strict';
// AstrBot 额度小游戏中心 — 对战平台服务
// 职责：H5 站点、房间匹配、WebSocket 对战、额度结算（远程 MySQL）、战绩（JSON）
// 日志缓冲必须最先加载，拦截后续所有 console 输出供管理后台查看
require('./lib/logbuf');

const config = require('./lib/config');
const CONFIG = config.load();
// 把 config.json 的值注入 process.env，供直接读 env 的模块（market.js / aiNews.js 等）拿到一致配置
config.applyEnv(CONFIG);

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { XQ } = require('./lib/xq');
const { Gomoku } = require('./lib/gomoku');
const doudizhu = require('./lib/doudizhu');
const ddzAi = require('./lib/doudizhu-ai');
const settle = require('./lib/settle');
const { Stats } = require('./lib/stats');
const bindings = require('./lib/bindings');
const solo = require('./lib/solo');
const auth = require('./lib/auth');
const ai = require('./lib/ai');
const aiNews = require('./lib/aiNews');
const { Market, MIN_BUY_USD, BUY_FEE_RATE, SELL_FEE_RATE, LIMIT_PCT, T0_LIMIT_PCT, TRADING, AI_DRIVEN, AI_PROFILES, AI_EARNINGS, AI_RECAP, AI_DRAGON_TIGER, AI_LOCK_DECISIONS, AI_PLAYER_FLOW, DELIST_ENABLED, DELIST_PCT, MM_MAX_USD } = require('./lib/market');
const { createAdminApp } = require('./lib/admin');

const stats = new Stats(CONFIG.statsFile);
const market = new Market(CONFIG.portfolioFile, CONFIG.reversalsFile);

const GAME_TYPES = {
  xiangqi: { name: '象棋', url: 'xiangqi.html', create: () => new XQ(), maxPlayers: 2 },
  gomoku: { name: '五子棋', url: 'gomoku.html', create: () => new Gomoku(), maxPlayers: 2 },
  doudizhu: { name: '斗地主', url: 'doudizhu.html', create: (cfg) => new doudizhu.DouDiZhu({
    allowDouble: cfg.allowDouble !== false,
    allowSuperDouble: cfg.allowSuperDouble !== false,
    allowSpring: cfg.allowSpring !== false,
  }), maxPlayers: 3 },
};

// 读取某游戏的独立配置（后台「游戏设置」；未配置项回退到全局默认值）
function gameCfg(gameType) {
  const g = CONFIG.games && CONFIG.games[gameType];
  if (!g) {
    return { enabled: true, minBet: CONFIG.minBet, maxBet: CONFIG.maxBet, turnTimeoutMs: CONFIG.turnTimeoutMs };
  }
  return {
    enabled: g.enabled !== false,
    minBet: g.minBet != null ? g.minBet : CONFIG.minBet,
    maxBet: g.maxBet != null ? g.maxBet : CONFIG.maxBet,
    turnTimeoutMs: g.turnTimeoutMs != null ? g.turnTimeoutMs : CONFIG.turnTimeoutMs,
    maxMult: g.maxMult,
    allowDouble: g.allowDouble,
    allowSuperDouble: g.allowSuperDouble,
    allowSpring: g.allowSpring,
  };
}

// ---- 房间存储 ----
const rooms = new Map(); // id -> room
// 网页邀请/接受 待处理队列（由 bot 轮询处理，bot 负责解析 QQ 身份）
const pending = new Map(); // id -> {type:'invite'|'accept', ...}
// 单机游戏会话（24点题目 / 贪吃蛇门票局）
const soloSessions = new Map(); // id -> session

function key(gameType, groupId) {
  return `${gameType}:${groupId}`;
}

function findWaiting(gameType, groupId) {
  for (const room of rooms.values()) {
    if (room.gameType === gameType && String(room.groupId) === String(groupId) && room.state === 'waiting') {
      return room;
    }
  }
  return null;
}

// 房间码：6 位大写字母+数字，去掉易混淆的 0/O/1/I，便于用户在聊天里手打。
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode() {
  let code;
  do {
    let s = '';
    for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    code = s;
  } while (findByCode(code));
  return code;
}

// 按房间码查房间（大小写不敏感，忽略首尾空格）
function findByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  for (const room of rooms.values()) {
    if (room.code === c) return room;
  }
  return null;
}

function makeRoom(gameType, groupId, player, betUsd) {
  const id = crypto.randomBytes(6).toString('hex');
  const betQuota = Math.max(1, Math.round(betUsd * CONFIG.quotaPerUnit));
  const maxPlayers = (GAME_TYPES[gameType] && GAME_TYPES[gameType].maxPlayers) || 2;
  const players = { 1: player };
  const tokens = { 1: crypto.randomBytes(8).toString('hex') };
  for (let i = 2; i <= maxPlayers; i++) { players[i] = null; tokens[i] = ''; }
  const room = {
    id,
    code: genCode(),
    gameType,
    groupId: String(groupId),
    bet: betUsd,
    betQuota,
    maxPlayers,
    players,
    state: 'waiting', // waiting | playing | finished
    game: null,
    turn: 1,
    timeoutMs: gameCfg(gameType).turnTimeoutMs, // 该游戏的思考超时（毫秒）
    turnDeadline: null, // 当前轮到方的最晚落子时间戳（超时由人机托管）
    autoMoving: false,
    winner: 0,
    reason: '',
    createdAt: Date.now(),
    finishedAt: null,
    tokens,
  };
  rooms.set(id, room);
  return room;
}

function roomPublic(room, withToken) {
  const players = { 1: room.players[1], 2: room.players[2] };
  if (room.maxPlayers >= 3) players[3] = room.players[3];
  const r = {
    id: room.id,
    code: room.code,
    gameType: room.gameType,
    groupId: room.groupId,
    bet: room.bet,
    betQuota: room.betQuota,
    maxPlayers: room.maxPlayers,
    state: room.state,
    turn: room.turn,
    winner: room.winner,
    reason: room.reason,
    players,
    finishedAt: room.finishedAt,
  };
  if (withToken) {
    r.tokens = room.tokens;
  }
  return r;
}

// 结束对局：结算额度 + 记录战绩 + 标记 finished
async function finishRoom(room, winner, reason) {
  if (room.state === 'finished') return;
  room.state = 'finished';
  room.winner = winner;
  room.reason = reason;
  room.finishedAt = Date.now();

  const u1 = room.players[1].userId;
  const u2 = room.players[2].userId;
  const gt = room.gameType;

  let settled = true;
  if (settle.ready()) {
    settled = await settle.settleEnd(u1, u2, room.betQuota, winner);
  }
  room.settled = settled;

  // 战绩
  if (winner === 1) {
    stats.record(u1, gt, 'win');
    stats.record(u2, gt, 'lose');
  } else if (winner === 2) {
    stats.record(u1, gt, 'lose');
    stats.record(u2, gt, 'win');
  } else {
    stats.record(u1, gt, 'draw');
    stats.record(u2, gt, 'draw');
  }
}

// ---- HTTP API ----
const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: settle.ready(), quotaPerUnit: CONFIG.quotaPerUnit, minBet: CONFIG.minBet, maxBet: CONFIG.maxBet });
});

// 游戏清单（供大厅动态渲染）：含启用状态与各游戏押注上下限
app.get('/api/games', (req, res) => {
  const catalog = [
    { type: 'doudizhu',  name: '斗地主',   url: 'doudizhu.html',  category: 'pvp' },
    { type: 'xiangqi',   name: '中国象棋', url: 'xiangqi.html',   category: 'pvp' },
    { type: 'gomoku',    name: '五子棋',   url: 'gomoku.html',    category: 'pvp' },
    { type: 'snake',     name: '贪吃蛇',   url: 'snake.html',     category: 'solo' },
    { type: 'breakout',  name: '打砖块',   url: 'breakout.html',  category: 'solo' },
    { type: 'twentyfour', name: '24点',    url: 'twentyfour.html', category: 'solo' },
    { type: 'market',    name: '虚拟股市', url: 'market.html',    category: 'market' },
  ];
  const list = catalog.map((g) => {
    const c = gameCfg(g.type);
    return {
      type: g.type, name: g.name, url: g.url, category: g.category,
      enabled: c.enabled !== false,
      minBet: c.minBet, maxBet: c.maxBet,
      turnTimeoutMs: c.turnTimeoutMs,
    };
  });
  res.json({ list });
});

// ---- 登录 ----
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const r = await auth.login(username, password);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ code: 'ok', token: r.token, userId: r.userId, username: r.username, quota: r.quota });
});

app.get('/api/auth/me', async (req, res) => {
  const s = auth.resolve(req.query.token);
  if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
  const quota = settle.ready() ? await settle.balance(s.userId) : null;
  res.json({ code: 'ok', userId: s.userId, username: s.username, quota });
});

app.post('/api/auth/logout', (req, res) => {
  auth.logout((req.body || {}).token);
  res.json({ code: 'ok' });
});

// 创建房间（自由押注：发起人定 bet 美元）。同群同游戏已有 waiting 房间则返回之。
app.post('/api/room', async (req, res) => {
  const { gameType, groupId, player, bet } = req.body || {};
  if (!GAME_TYPES[gameType]) return res.status(400).json({ error: '不支持的游戏类型' });
  if (!groupId || !player || !player.userId) return res.status(400).json({ error: '参数缺失' });

  const cfg = gameCfg(gameType);
  if (!cfg.enabled) return res.status(400).json({ error: '该游戏已被管理员禁用' });

  let betUsd = parseFloat(bet);
  if (!(betUsd > 0)) betUsd = cfg.minBet;
  if (betUsd < cfg.minBet) return res.status(400).json({ error: `最低押注 $${cfg.minBet}` });
  if (betUsd > cfg.maxBet) return res.status(400).json({ error: `最高押注 $${cfg.maxBet}` });

  const existing = findWaiting(gameType, groupId);
  if (existing) {
    return res.json({ code: 'existing', room: roomPublic(existing, false) });
  }

  // 创建房间前检查发起方余额，避免对手加入时才因余额不足失败
  const betQuota = betQuotaOf(betUsd);
  if (settle.ready()) {
    const bal = await settle.balance(player.userId);
    if (bal != null && bal < betQuota) {
      return res.status(400).json({ error: `余额不足（本局押注 $${betUsd}），当前可用额度 $${usd(bal).toFixed(2)}` });
    }
  }

  const room = makeRoom(gameType, groupId, player, betUsd);
  res.json({ code: 'created', room: roomPublic(room, true) });
});

// 加入房间（接受对方押注额），满员后扣款并开战（斗地主 3 人）
app.post('/api/room/:id/join', async (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在或已结束' });
  if (room.state !== 'waiting') return res.status(400).json({ error: '房间已满或已开始' });

  const { player } = req.body || {};
  if (!player || !player.userId) return res.status(400).json({ error: '参数缺失' });

  // 不能和自己对战（检查所有已加入座位）
  for (const p of Object.values(room.players)) {
    if (!p) continue;
    if (String(player.qq) === String(p.qq) || String(player.userId) === String(p.userId)) {
      return res.status(400).json({ error: '不能和自己对战' });
    }
  }

  // 找空座位
  const maxPlayers = room.maxPlayers || 2;
  let seat = 0;
  for (let i = 1; i <= maxPlayers; i++) { if (!room.players[i]) { seat = i; break; } }
  if (!seat) return res.status(400).json({ error: '房间已满' });

  room.players[seat] = player;
  room.tokens[seat] = crypto.randomBytes(8).toString('hex');

  // 是否满员
  let full = true;
  for (let i = 1; i <= maxPlayers; i++) { if (!room.players[i]) { full = false; break; } }

  if (!full) {
    // 斗地主：还差人，继续等待
    return res.json({ code: 'joined', room: roomPublic(room, true) });
  }

  // 满员开战：各方扣款（事务）
  if (settle.ready()) {
    const uids = [];
    for (let i = 1; i <= maxPlayers; i++) uids.push(room.players[i].userId);
    let ok;
    if (maxPlayers === 3) ok = await settle.settleStart3(uids[0], uids[1], uids[2], room.betQuota);
    else ok = await settle.settleStart(uids[0], uids[1], room.betQuota);
    if (!ok) {
      // 扣款失败回滚座位
      room.players[seat] = null;
      room.tokens[seat] = '';
      return res.status(400).json({ error: '余额不足，无法开战（每位玩家需 $' + room.bet + '）' });
    }
  }

  room.game = GAME_TYPES[room.gameType].create(gameCfg(room.gameType));
  room.state = 'playing';
  room.turnDeadline = Date.now() + room.timeoutMs;

  res.json({ code: 'started', room: roomPublic(room, true) });
});

// 按房间码加入：网页已登录（NewAPI token），服务端按 userId 匹配玩家身份，
// 返回该玩家对应的 roomId/player/wsToken，前端据此连 WebSocket。
app.post('/api/room/join-by-code', (req, res) => {
  const { code, token } = req.body || {};
  const sess = auth.resolve(token);
  if (!sess) return res.status(401).json({ error: '未登录或登录已过期，请先登录 NewAPI 账号' });

  const room = findByCode(code);
  if (!room) return res.status(404).json({ error: '房间码不存在或已失效，请核对后重试' });

  const uid = String(sess.userId);
  let player = 0;
  const maxPlayers = room.maxPlayers || 2;
  for (let i = 1; i <= maxPlayers; i++) {
    if (room.players[i] && String(room.players[i].userId) === uid) { player = i; break; }
  }
  if (!player) return res.status(403).json({ error: '你不是该房间的玩家，请确认已用绑定账号登录' });

  res.json({
    code: 'ok',
    roomId: room.id,
    player,
    wsToken: room.tokens[player],
    gameType: room.gameType,
    state: room.state,
    bet: room.bet,
  });
});

// 查询房间状态（插件轮询用）
app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const r = roomPublic(room, false);
  r.stats = {};
  for (let i = 1; i <= (room.maxPlayers || 2); i++) {
    r.stats[i] = room.players[i] ? stats.summary(room.players[i].userId, room.gameType) : null;
  }
  if (room.ddzResult) r.ddzResult = room.ddzResult;
  res.json(r);
});

// 取消 waiting 房间
app.post('/api/room/:id/cancel', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  if (room.state !== 'waiting') return res.status(400).json({ error: '房间已开始' });
  rooms.delete(room.id);
  res.json({ ok: true });
});

// 个人战绩
app.get('/api/stats', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: '缺少 userId' });
  res.json({ userId, stats: stats.get(userId) });
});

// ---- 单机下注小游戏（服务端权威结算） ----

const usd = (q) => (q == null ? 0 : q / CONFIG.quotaPerUnit);
const betQuotaOf = (betUsd) => Math.round(parseFloat(betUsd) * CONFIG.quotaPerUnit);
const round2 = (n) => Math.round(n * 100) / 100;

// 解析登录 token + 校验押注，返回 { player, betUsd, betQuota } 或 { error }
function resolveBet(token, bet, gameType) {
  const s = auth.resolve(token);
  if (!s) return { error: '未登录或登录已过期，请先在大厅登录 NewAPI 账号' };
  const cfg = gameCfg(gameType);
  const betUsd = parseFloat(bet);
  if (!(betUsd >= cfg.minBet && betUsd <= cfg.maxBet)) {
    return { error: `押注金额需在 $${cfg.minBet}~$${cfg.maxBet} 之间` };
  }
  return { player: { userId: s.userId, username: s.username }, betUsd, betQuota: betQuotaOf(betUsd) };
}

// 单机「门票制」统一结算：入场已扣 betQuota，按服务端权威倍率 mult 派奖。
// 返回 net（净输赢 quota）；payout = round(betQuota * mult)。
async function settleTicket(userId, gameType, betQuota, mult) {
  const payout = Math.round(betQuota * mult);
  let net = -betQuota;
  if (payout > 0) {
    if (settle.ready()) await settle.credit(userId, payout);
    net = payout - betQuota;
  }
  stats.recordSolo(userId, gameType, net);
  return net;
}

// 打砖块：开始（扣门票 + 发种子）
app.post('/api/solo/breakout/start', async (req, res) => {
  try {
    const rb = resolveBet(req.body && req.body.token, req.body && req.body.bet, 'breakout');
    if (rb.error) return res.status(400).json({ error: rb.error });
    if (settle.ready() && !(await settle.debit(rb.player.userId, rb.betQuota))) {
      return res.status(400).json({ error: '余额不足' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const seed = (Math.random() * 0x7fffffff) >>> 0;
    soloSessions.set(id, {
      id, gameType: 'breakout', userId: rb.player.userId, username: rb.player.username,
      bet: rb.betUsd, betQuota: rb.betQuota, seed, state: 'playing', createdAt: Date.now(),
    });
    res.json({ code: 'ok', sessionId: id, bet: rb.betUsd, seed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 打砖块：结束（服务端回放横板轨迹得权威分数 + 结算）
app.post('/api/solo/breakout/end', async (req, res) => {
  try {
    const s = soloSessions.get(req.body && req.body.sessionId);
    if (!s || s.state !== 'playing') return res.status(404).json({ error: '对局不存在或已结束' });
    const targetXs = Array.isArray(req.body && req.body.targetXs) ? req.body.targetXs : [];
    const rep = solo.breakoutReplay(s.seed, targetXs);
    const mult = solo.breakoutMult(rep.score, gameCfg('breakout').maxMult);
    const net = await settleTicket(s.userId, 'breakout', s.betQuota, mult);
    soloSessions.delete(s.id);
    res.json({
      code: 'ok', bet: s.bet, score: rep.score, mult, win: rep.win, lives: rep.lives, level: rep.level,
      netUsd: usd(net), quota: settle.ready() ? await settle.balance(s.userId) : null,
      username: s.username,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 贪吃蛇：开始（扣门票 + 发种子）
app.post('/api/solo/snake/start', async (req, res) => {
  try {
    const rb = resolveBet(req.body && req.body.token, req.body && req.body.bet, 'snake');
    if (rb.error) return res.status(400).json({ error: rb.error });
    if (settle.ready() && !(await settle.debit(rb.player.userId, rb.betQuota))) {
      return res.status(400).json({ error: '余额不足' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const seed = (Math.random() * 0x7fffffff) >>> 0;
    soloSessions.set(id, {
      id, gameType: 'snake', userId: rb.player.userId, username: rb.player.username,
      bet: rb.betUsd, betQuota: rb.betQuota, seed, state: 'playing', createdAt: Date.now(),
    });
    res.json({
      code: 'ok', sessionId: id, bet: rb.betUsd, seed,
      w: solo.SNAKE_W, h: solo.SNAKE_H,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 贪吃蛇：结束（服务端回放 dirs 得权威分数 + 结算）
app.post('/api/solo/snake/end', async (req, res) => {
  try {
    const s = soloSessions.get(req.body && req.body.sessionId);
    if (!s || s.state !== 'playing') return res.status(404).json({ error: '对局不存在或已结束' });
    const dirs = Array.isArray(req.body && req.body.dirs) ? req.body.dirs : [];
    const replay = solo.snakeReplay(s.seed, dirs);
    const mult = solo.snakeMult(replay.score, gameCfg('snake').maxMult);
    const net = await settleTicket(s.userId, 'snake', s.betQuota, mult);
    soloSessions.delete(s.id);
    res.json({
      code: 'ok', bet: s.bet, score: replay.score, mult, reason: replay.reason || '主动结束',
      netUsd: usd(net), quota: settle.ready() ? await settle.balance(s.userId) : null,
      username: s.username,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 24点：出题（不扣款）
app.post('/api/solo/twentyfour/new', (req, res) => {
  const nums = solo.twentyfourGen();
  const id = crypto.randomBytes(8).toString('hex');
  soloSessions.set(id, { id, gameType: 'twentyfour', numbers: nums, createdAt: Date.now() });
  res.json({ code: 'ok', sessionId: id, numbers: nums });
});

// 24点：提交答案（下注 + 判定 + 结算）
app.post('/api/solo/twentyfour/submit', async (req, res) => {
  try {
    const { sessionId, token, bet, expression } = req.body || {};
    const s = soloSessions.get(sessionId);
    if (!s) return res.status(404).json({ error: '题目不存在或已过期' });
    const rb = resolveBet(token, bet, 'twentyfour');
    if (rb.error) return res.status(400).json({ error: rb.error });
    const v = solo.twentyfourValidate(s.numbers, expression);
    if (!v.ok && v.kind !== 'wrong') {
      return res.status(400).json({ error: v.reason });
    }
    if (settle.ready() && !(await settle.debit(rb.player.userId, rb.betQuota))) {
      return res.status(400).json({ error: '余额不足' });
    }
    let net = -rb.betQuota;
    if (v.ok) {
      if (settle.ready()) await settle.credit(rb.player.userId, rb.betQuota * 2);
      net = rb.betQuota;
    }
    stats.recordSolo(rb.player.userId, 'twentyfour', net);
    soloSessions.delete(sessionId);
    res.json({
      code: 'ok', win: v.ok, bet: rb.betUsd, numbers: s.numbers, expression,
      netUsd: usd(net), quota: settle.ready() ? await settle.balance(rb.player.userId) : null,
      username: rb.player.username,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 排行榜：分游戏榜（单机按净赢额，联机按胜场）
app.get('/api/leaderboard', (req, res) => {
  const { gameType, limit } = req.query;
  if (!gameType) return res.status(400).json({ error: '缺少 gameType' });
  const rows = stats.leaderboard(String(gameType), parseInt(limit, 10) || 20);
  const list = rows.map((r) => ({
    userId: r.userId,
    name: bindings.usernameByUserId(r.userId) || `用户${r.userId}`,
    win: r.win || 0, lose: r.lose || 0, draw: r.draw || 0, total: r.total || 0,
    games: r.games || 0,
    netUsd: usd(r.netQuota || 0),
    bestUsd: usd(r.bestQuota || 0),
  }));
  res.json({ gameType, list });
});

// ---- 模拟股市 ----
app.get('/api/market/stocks', (req, res) => {
  const d = market.list();
  res.json({
    list: d.list, index: d.index, breadth: d.breadth, news: d.news,
    newsTtlHours: d.newsTtlHours,
    minBuyUsd: MIN_BUY_USD,
    status: d.status,
    sentiment: d.sentiment,
    dragonTiger: d.dragonTiger,
    recap: d.recap,
    fees: {
      buyFeeRate: BUY_FEE_RATE, sellFeeRate: SELL_FEE_RATE, limitPct: LIMIT_PCT, t0LimitPct: T0_LIMIT_PCT,
      tPlusDays: TRADING.tPlusDays,
      sessionsEnabled: TRADING.sessionsEnabled,
      entrustEnabled: TRADING.entrustEnabled,
      sellInstant: TRADING.sellInstant,
      orderAutoCancel: TRADING.orderAutoCancel,
      orderTtlMin: TRADING.orderTtlMin,
      auctionEnabled: TRADING.auctionEnabled,
      lunchEnabled: TRADING.lunchEnabled,
      weekendClosed: TRADING.weekendClosed,
      aiDriven: AI_DRIVEN,
      aiProfiles: AI_PROFILES,
      aiEarnings: AI_EARNINGS,
      aiRecap: AI_RECAP,
      aiDragonTiger: AI_DRAGON_TIGER,
      aiLockDecisions: AI_LOCK_DECISIONS,
      aiPlayerFlow: AI_PLAYER_FLOW,
      delistEnabled: DELIST_ENABLED,
      delistPct: DELIST_PCT,
      mmMaxUsd: MM_MAX_USD,
      t1: true,
    },
  });
});

// 市场阶段快照（交易时段 / 集合竞价 / 午休 / 收盘，前端据此控制可交易状态）
app.get('/api/market/status', (req, res) => {
  res.json(market.status());
});

app.get('/api/market/stock/:code', (req, res) => {
  const s = market.detail(req.params.code);
  if (!s) return res.status(404).json({ error: '股票不存在' });
  res.json(s);
});

// 限价委托（买/卖统一）：买冻结额度、卖冻结持仓，连续竞价即时撮合。
app.post('/api/market/order', async (req, res) => {
  try {
    if (!gameCfg('market').enabled) return res.status(400).json({ error: '模拟股市已被管理员禁用' });
    const s = auth.resolve((req.body || {}).token);
    if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
    const { code, side, price, qty } = req.body || {};
    let frozenQuota = 0;
    if (side !== 'sell') {
      // 买入：冻结 价格×股数×(1+手续费) 的额度上限；委托开关关闭时按现价冻结（市价单）
      const q = parseFloat(qty);
      if (!(q > 0)) return res.status(400).json({ error: '委托数量无效' });
      let p = round2(parseFloat(price));
      if (!TRADING.entrustEnabled) {
        const cp = market.currentPrice(code);
        if (!cp) return res.status(400).json({ error: '股票不存在' });
        p = cp;
      } else if (!(p > 0)) {
        return res.status(400).json({ error: '委托价格/数量无效' });
      }
      const frozenUsd = round2(p * q * (1 + BUY_FEE_RATE));
      frozenQuota = Math.round(frozenUsd * CONFIG.quotaPerUnit);
      if (settle.ready() && !(await settle.debit(s.userId, frozenQuota))) {
        return res.status(400).json({ error: '余额不足（委托买入需冻结 $' + frozenUsd.toFixed(2) + '，含手续费）' });
      }
    }
    const r = market.placeOrder(s.userId, code, side, price, qty, s.username, frozenQuota);
    if (r.error) {
      if (frozenQuota > 0 && settle.ready()) { try { await settle.credit(s.userId, frozenQuota); } catch (e) { /* ignore */ } }
      return res.status(400).json({ error: r.error });
    }
    // 落账本次撮合产生的额度变动（卖方净回款 / 买方价差退款）
    for (const ef of (r.effects || [])) {
      if (!ef || !(ef.quota > 0)) continue;
      if (settle.ready()) { try { await settle.credit(ef.userId, ef.quota); } catch (e) { /* ignore */ } }
    }
    let bal = null;
    if (settle.ready()) { try { bal = await settle.balance(s.userId); } catch (e) { bal = null; } }
    res.json({ code: 'ok', ...r, effects: undefined, quota: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 撤单：买退冻结额度、卖解冻持仓
app.post('/api/market/order/:id/cancel', async (req, res) => {
  try {
    const s = auth.resolve((req.body || {}).token);
    if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
    const r = market.cancelOrder(parseInt(req.params.id, 10), s.userId);
    if (r.error) return res.status(400).json({ error: r.error });
    if (r.refundQuota > 0 && settle.ready()) { try { await settle.credit(s.userId, r.refundQuota); } catch (e) { /* ignore */ } }
    let bal = null;
    if (settle.ready()) { try { bal = await settle.balance(s.userId); } catch (e) { bal = null; } }
    res.json({ code: 'ok', ...r, quota: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 五档盘口
app.get('/api/market/orderbook/:code', (req, res) => {
  res.json(market.orderBook(req.params.code));
});

// 多周期 K 线（1m/5m/15m/30m/60m/day/week/month）
app.get('/api/market/kline/:code', (req, res) => {
  const period = req.query.period || 'day';
  const bars = market.klinePeriod(req.params.code, period);
  res.json({ code: req.params.code, period, bars });
});

// 板块排行
app.get('/api/market/sectors', (req, res) => {
  res.json({ list: market.sectorRank() });
});

// 我的当日委托
app.get('/api/market/orders', (req, res) => {
  const s = auth.resolve(req.query.token);
  if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
  res.json({ list: market.myOrders(s.userId) });
});

app.get('/api/market/holdings', (req, res) => {
  const s = auth.resolve(req.query.token);
  if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
  res.json({ list: market.holdings(s.userId) });
});

// bot 侧按 userId 查询持仓（无需登录 token，供插件 /持仓 指令使用）
app.get('/api/market/holdings/by-user', (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: '缺少 userId' });
  const rows = market.holdings(userId);
  const totalMarketValue = round2(rows.reduce((a, r) => a + r.marketValue, 0));
  const totalCost = round2(rows.reduce((a, r) => a + r.costUsd, 0));
  const totalPnl = round2(totalMarketValue - totalCost);
  res.json({
    userId,
    list: rows,
    totalMarketValue,
    totalCost,
    totalPnl,
  });
});

app.get('/api/market/leaderboard', (req, res) => {
  const rows = market.leaderboard(parseInt(req.query.limit, 10) || 20);
  const list = rows.map((r) => ({
    userId: r.userId,
    name: r.name || bindings.usernameByUserId(r.userId) || `用户${r.userId}`,
    stocks: r.stocks, marketValue: r.marketValue, pnl: r.pnl,
  }));
  res.json({ list });
});

// 成交流历史（页面刷新后长留，最新在前）
app.get('/api/market/trades', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  res.json({ list: market.trades(limit) });
});

// ---- 网页邀请 / 接受 队列（bot 轮询处理，bot 负责解析 QQ→账号身份） ----

// 发起邀请：网页已登录（token），游戏服务直接解析 userId 交由 bot 建房 + 群广播
app.post('/api/invite', (req, res) => {
  const { gameType, groupId, token, bet } = req.body || {};
  const sess = auth.resolve(token);
  if (!sess) return res.status(401).json({ error: '未登录或登录已过期' });
  if (!GAME_TYPES[gameType]) return res.status(400).json({ error: '不支持的游戏类型' });
  if (!groupId) return res.status(400).json({ error: '缺少群号' });

  const cfg = gameCfg(gameType);
  if (!cfg.enabled) return res.status(400).json({ error: '该游戏已被管理员禁用' });

  let betUsd = parseFloat(bet);
  if (!(betUsd > 0)) betUsd = cfg.minBet;
  if (betUsd < cfg.minBet) return res.status(400).json({ error: `最低押注 $${cfg.minBet}` });
  if (betUsd > cfg.maxBet) return res.status(400).json({ error: `最高押注 $${cfg.maxBet}` });

  const id = crypto.randomBytes(8).toString('hex');
  pending.set(id, {
    id, type: 'invite', gameType, groupId: String(groupId), userId: sess.userId, username: sess.username,
    bet: betUsd, roomId: null, player1Token: '',
    status: 'pending', error: null, createdAt: Date.now(),
  });
  res.json({ code: 'ok', inviteId: id });
});

// 接受邀请：网页已登录（token），游戏服务直接解析 userId 交由 bot 加房
app.post('/api/accept', (req, res) => {
  const { roomId, token } = req.body || {};
  const sess = auth.resolve(token);
  if (!sess) return res.status(401).json({ error: '未登录或登录已过期' });
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: '房间不存在或已结束' });

  const id = crypto.randomBytes(8).toString('hex');
  pending.set(id, {
    id, type: 'accept', roomId, groupId: room.groupId, userId: sess.userId, username: sess.username,
    player2Token: '', status: 'pending', error: null, createdAt: Date.now(),
  });
  res.json({ code: 'ok', acceptId: id });
});

// bot 轮询：某群的待处理邀请/接受
app.get('/api/pending', (req, res) => {
  const gid = req.query.gid ? String(req.query.gid) : '';
  const list = [];
  for (const p of pending.values()) {
    if (p.status !== 'pending') continue;
    if (gid && p.groupId !== gid) continue;
    list.push(p);
  }
  res.json({ list });
});

// bot 建房成功后回填 invite（把 player1 的 token 交给前端）
app.post('/api/invite/:id/resolve', (req, res) => {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: '邀请不存在' });
  p.roomId = req.body.roomId || null;
  p.player1Token = req.body.player1Token || '';
  p.status = 'resolved';
  res.json({ ok: true });
});

app.post('/api/invite/:id/fail', (req, res) => {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: '邀请不存在' });
  p.status = 'failed';
  p.error = req.body.error || '处理失败';
  res.json({ ok: true });
});

// bot join 成功后回填 accept（把 player2 的 token 交给前端）
app.post('/api/accept/:id/resolve', (req, res) => {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: '请求不存在' });
  p.player2Token = req.body.player2Token || '';
  p.status = 'resolved';
  res.json({ ok: true });
});

app.post('/api/accept/:id/fail', (req, res) => {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: '请求不存在' });
  p.status = 'failed';
  p.error = req.body.error || '处理失败';
  res.json({ ok: true });
});

// 前端轮询状态
app.get('/api/invite/:id', (req, res) => {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: '邀请不存在' });
  res.json({ status: p.status, roomId: p.roomId, player1Token: p.player1Token, gameType: p.gameType, error: p.error });
});

app.get('/api/accept/:id', (req, res) => {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: '请求不存在' });
  res.json({ status: p.status, roomId: p.roomId, player2Token: p.player2Token, error: p.error });
});

// favicon：返回 204，避免浏览器每次加载页面都刷一条 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 暴露斗地主规则引擎给前端（与服务端共用同一份，保证规则一致）
app.get('/js/doudizhu.js', (req, res) => {
  res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'lib', 'doudizhu.js')));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const marketWss = new WebSocket.Server({ noServer: true });

// 房间广播：发给该房间所有在线连接（人机托管走子时也复用）
function broadcastRoom(roomId, msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.roomId === roomId && c.readyState === WebSocket.OPEN) {
      try { c.send(data); } catch (e) { /* 单个坏连接不影响整体 */ }
    }
  });
}

// ---- 斗地主（3 人）专属逻辑 ----
// 房间座位 1/2/3 对应斗地主 seat 0/1/2

function sendToSeat(roomId, seat, msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.roomId === roomId && c.player === seat && c.readyState === WebSocket.OPEN) {
      try { c.send(data); } catch (e) { /* 单个坏连接不影响整体 */ }
    }
  });
}

// 斗地主状态广播：每个座位收到定制视角（含各自手牌）
function broadcastDDZ(room, type, extra) {
  for (let seat = 1; seat <= room.maxPlayers; seat++) {
    const view = room.game.viewFor(seat - 1);
    const msg = Object.assign({ type, player: seat, deadline: room.turnDeadline, timeoutMs: room.timeoutMs }, extra || {}, view);
    sendToSeat(room.id, seat, msg);
  }
}

// 当前轮到谁的 room 座位（1/2/3），0 表示无人（对局结束）
function ddzCurrentSeat(room) {
  const g = room.game;
  if (!g) return 0;
  if (g.phase === 'bidding') return g.bidSeat + 1;
  if (g.phase === 'doubling') return g.doubleSeat + 1;
  if (g.phase === 'playing') return g.current + 1;
  return 0;
}

// 结束斗地主：3 人结算 + 战绩
async function finishDoudizhu(room) {
  if (room.state === 'finished') return;
  room.state = 'finished';
  room.finishedAt = Date.now();
  const g = room.game;
  const gt = room.gameType;
  const landlord = g.landlord + 1; // room 座位
  const farmers = [1, 2, 3].filter((s) => s !== landlord);
  const landlordWon = g.landlordWon;
  const multiplier = g.multiplier;

  room.winner = landlordWon ? landlord : -2; // -2 表示农民方胜
  room.reason = g.reason;
  room.ddzResult = { landlordWon, multiplier, spring: g.spring, landlord, bombCount: g.bombCount };

  let settled = true, degraded = false;
  if (settle.ready()) {
    const r = await settle.settleEnd3(
      room.players[landlord].userId,
      room.players[farmers[0]].userId,
      room.players[farmers[1]].userId,
      room.betQuota, multiplier, landlordWon,
    );
    settled = r.ok;
    degraded = r.degraded;
  }
  room.settled = settled;
  room.settledDegraded = degraded;
  room.ddzResult.degraded = degraded;

  const landlordUid = room.players[landlord].userId;
  const f1Uid = room.players[farmers[0]].userId;
  const f2Uid = room.players[farmers[1]].userId;
  if (landlordWon) {
    stats.record(landlordUid, gt, 'win');
    stats.record(f1Uid, gt, 'lose');
    stats.record(f2Uid, gt, 'lose');
  } else {
    stats.record(landlordUid, gt, 'lose');
    stats.record(f1Uid, gt, 'win');
    stats.record(f2Uid, gt, 'win');
  }
}

// 斗地主消息处理（客户端 → 服务端）：bid / double / play / pass
async function handleDDZMessage(ws, room, player, msg) {
  const g = room.game;
  const seat = player - 1;

  if (msg.type === 'bid') {
    const r = g.bid(seat, msg.score);
    if (!r.ok) { sendToSeat(room.id, player, { type: 'error', message: r.error }); return; }
    room.turnDeadline = Date.now() + room.timeoutMs;
    if (r.redealt) {
      broadcastDDZ(room, 'redeal', { bidStart: g.bidStart });
    } else if (r.landlord !== undefined && r.landlord !== -1) {
      broadcastDDZ(room, 'landlord', { landlord: g.landlord, bottom: g.bottom });
    } else {
      broadcastDDZ(room, 'bid', {});
    }
  } else if (msg.type === 'double') {
    const r = g.double(seat, msg.factor);
    if (!r.ok) { sendToSeat(room.id, player, { type: 'error', message: r.error }); return; }
    room.turnDeadline = Date.now() + room.timeoutMs;
    broadcastDDZ(room, 'double', {});
  } else if (msg.type === 'play') {
    const r = g.play(seat, msg.cards);
    if (!r.ok) { sendToSeat(room.id, player, { type: 'error', message: r.error }); return; }
    room.turnDeadline = Date.now() + room.timeoutMs;
    if (r.over) {
      await finishDoudizhu(room);
      broadcastDDZ(room, 'end', { result: g.resultView(), winner: room.winner, reason: g.reason });
    } else {
      broadcastDDZ(room, 'play', {});
    }
  } else if (msg.type === 'pass') {
    const r = g.pass(seat);
    if (!r.ok) { sendToSeat(room.id, player, { type: 'error', message: r.error }); return; }
    room.turnDeadline = Date.now() + room.timeoutMs;
    broadcastDDZ(room, 'pass', {});
  }
}

// 斗地主超时托管：AI 代当前轮到方决策
async function ddzAutoMove(room) {
  if (room.state !== 'playing' || room.autoMoving) return;
  const g = room.game;
  const seat = ddzCurrentSeat(room) - 1;
  if (seat < 0) return;
  room.autoMoving = true;
  try {
    if (g.phase === 'bidding') {
      const score = ddzAi.bid(g.hands[seat], g.highestBid);
      const r = g.bid(seat, score);
      if (r.redealt) broadcastDDZ(room, 'redeal', {});
      else if (r.landlord !== undefined && r.landlord !== -1) broadcastDDZ(room, 'landlord', { landlord: g.landlord, bottom: g.bottom, auto: true });
      else broadcastDDZ(room, 'bid', { auto: true, autoSeat: seat });
    } else if (g.phase === 'doubling') {
      let factor = ddzAi.double(g.hands[seat], seat === g.landlord);
      if (factor === 4 && g.rules && g.rules.allowSuperDouble === false) factor = 2; // 未启用超级加倍，AI 降级为加倍
      g.double(seat, factor);
      broadcastDDZ(room, 'double', { auto: true, autoSeat: seat });
    } else if (g.phase === 'playing') {
      const lastPlay = g.lastPlay ? { type: g.lastPlay.type, rank: g.lastPlay.rank, length: g.lastPlay.length } : null;
      const decision = ddzAi.play(g.hands[seat], lastPlay);
      if (decision.pass) {
        const r = g.pass(seat);
        if (r.ok) broadcastDDZ(room, 'pass', { auto: true, autoSeat: seat });
      } else {
        const ids = decision.cards.map((c) => doudizhu.cardId(c));
        const r = g.play(seat, ids);
        if (r.over) {
          await finishDoudizhu(room);
          broadcastDDZ(room, 'end', { result: g.resultView(), winner: room.winner, reason: g.reason, auto: true });
        } else {
          broadcastDDZ(room, 'play', { auto: true, autoSeat: seat });
        }
      }
    }
    room.turnDeadline = Date.now() + room.timeoutMs;
  } finally {
    room.autoMoving = false;
  }
}

// 超时托管：轮到方超过思考时间未操作，由人机代走一步，避免对局卡死。
async function autoMove(room) {
  if (room.state !== 'playing' || room.autoMoving) return;
  const turn = room.game.turnPlayer();
  const move = ai.pickMove(room.gameType, room.game);
  if (!move) return; // 无合法走法（理论上不会发生）
  room.autoMoving = true;
  try {
    const res = room.game.applyMove(turn, move);
    room.turn = room.game.turnPlayer();
    room.turnDeadline = Date.now() + room.timeoutMs;
    broadcastRoom(room.id, {
      type: 'move',
      move,
      state: room.game.getState(),
      turn: room.game.turnPlayer(),
      auto: true,
      autoPlayer: turn,
      deadline: room.turnDeadline,
      timeoutMs: room.timeoutMs,
    });
    if (res.over) {
      await finishRoom(room, res.winner, '超时托管结束');
      broadcastRoom(room.id, { type: 'end', winner: res.winner, reason: '超时托管结束' });
    }
  } finally {
    room.autoMoving = false;
  }
}

// 手动按 path 分发 upgrade（避免多个 Server 共用 http server 时 path 过滤互相 400）
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/ws-market') {
    marketWss.handleUpgrade(req, socket, head, (ws) => marketWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

function broadcastMarket(msg) {
  let data;
  try { data = JSON.stringify(msg); } catch (e) { return; }
  marketWss.clients.forEach((c) => {
    try {
      if (c.readyState === WebSocket.OPEN) c.send(data);
    } catch (e) { /* 单个坏连接不影响整体广播 */ }
  });
}

// 广播失败不得影响交易结果（买入/卖出已成功扣款+入仓时，不能因推送异常返回失败）
const safeBroadcast = (fn) => (arg) => { try { fn(arg); } catch (e) { /* ignore */ } };

market.setHandlers({
  onQuote: safeBroadcast((d) => broadcastMarket({ type: 'quote', ...d })),
  onTrade: safeBroadcast((t) => broadcastMarket({ type: 'trade', side: t.type, id: t.id, time: t.time, username: t.username, code: t.code, name: t.name, price: t.price, amount: t.amount, shares: t.shares })),
  onNews: safeBroadcast((n) => broadcastMarket({ type: 'news', ...n })),
  onSentiment: safeBroadcast((s) => broadcastMarket({ type: 'sentiment', ...s })),
  onRecap: safeBroadcast((r) => broadcastMarket({ type: 'recap', ...r })),
  onDragonTiger: safeBroadcast((l) => broadcastMarket({ type: 'dragonTiger', list: l })),
});

marketWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  try { ws.send(JSON.stringify({ type: 'quote', ...market.quote() })); } catch (e) { /* ignore */ }
});

// WebSocket 心跳：NAT / 反向代理常因空闲超时静默断开连接，导致对战「下几步就连不上」。
// 每 30s ping 一次，客户端浏览器自动回 pong；未回则视为死连接，主动 terminate。
function heartbeat(wsserver) {
  wsserver.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}
setInterval(() => { heartbeat(wss); heartbeat(marketWss); }, 30000).unref();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  const player = parseInt(url.searchParams.get('player'), 10);
  const token = url.searchParams.get('token');

  const room = roomId ? rooms.get(roomId) : null;
  const maxPlayers = room ? (room.maxPlayers || 2) : 2;
  if (!room || room.state !== 'playing' || player < 1 || player > maxPlayers) {
    ws.send(JSON.stringify({ type: 'error', message: '房间不可用' }));
    ws.close();
    return;
  }
  if (room.tokens[player] !== token) {
    ws.send(JSON.stringify({ type: 'error', message: '鉴权失败' }));
    ws.close();
    return;
  }

  ws.roomId = room.id;
  ws.player = player;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ---- 斗地主（3 人）专属连接处理 ----
  if (room.gameType === 'doudizhu') {
    const names = {};
    for (let i = 1; i <= maxPlayers; i++) {
      names[i] = room.players[i] ? { qq: room.players[i].qq, name: room.players[i].name } : null;
    }
    ws.send(JSON.stringify(Object.assign({
      type: 'hello',
      player,
      gameType: 'doudizhu',
      bet: room.bet,
      you: names[player],
      seats: names,
      deadline: room.turnDeadline,
      timeoutMs: room.timeoutMs,
    }, room.game.viewFor(player - 1))));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (room.state !== 'playing') return;
      await handleDDZMessage(ws, room, player, msg);
    });
    ws.on('close', () => {});
    return;
  }

  const opponent = room.players[player === 1 ? 2 : 1];

  ws.send(JSON.stringify({
    type: 'hello',
    player,
    gameType: room.gameType,
    bet: room.bet,
    state: room.game.getState(),
    opponent: { qq: opponent.qq, name: opponent.name },
    you: { qq: room.players[player].qq, name: room.players[player].name },
    deadline: room.turnDeadline,
    timeoutMs: room.timeoutMs,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (room.state !== 'playing') return;

    if (msg.type === 'move') {
      const res = room.game.applyMove(player, msg.move);
      if (!res.ok) {
        ws.send(JSON.stringify({ type: 'error', message: res.error || '走法无效' }));
        return;
      }
      room.turn = room.game.turnPlayer ? room.game.turnPlayer() : room.turn;
      room.turnDeadline = Date.now() + room.timeoutMs;
      broadcastRoom(room.id, {
        type: 'move', move: msg.move, state: room.game.getState(), turn: room.game.turnPlayer(),
        deadline: room.turnDeadline, timeoutMs: CONFIG.turnTimeoutMs,
      });
      if (res.over) {
        await finishRoom(room, res.winner, '正常结束');
        broadcastRoom(room.id, { type: 'end', winner: res.winner, reason: '正常结束' });
      }
    } else if (msg.type === 'resign') {
      const winner = player === 1 ? 2 : 1;
      await finishRoom(room, winner, '对方认输');
      broadcastRoom(room.id, { type: 'end', winner, reason: '对方认输' });
    }
  });

  ws.on('close', () => {});
});

// ---- 定时清理过期房间 ----
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.state === 'waiting' && now - room.createdAt > 5 * 60 * 1000) {
      rooms.delete(id);
    } else if (room.state === 'finished' && now - room.finishedAt > 30 * 60 * 1000) {
      rooms.delete(id);
    } else if (room.state === 'playing' && now - room.createdAt > 3 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
  for (const [id, p] of pending) {
    if (now - p.createdAt > 5 * 60 * 1000) pending.delete(id);
  }
  for (const [id, s] of soloSessions) {
    // 超过 10 分钟未完成：直接失效（贪吃蛇门票不退回，24点题目失效）
    if (now - s.createdAt > 10 * 60 * 1000) {
      soloSessions.delete(id);
    }
  }
  // 待入账额度（逐 tick 撮合回款 / 买方退款 / EOD 撤单退款）落账
  const credits = market.drainCredits();
  for (const rf of credits) {
    if (!rf || !(rf.quota > 0)) continue;
    settle.credit(rf.userId, rf.quota).catch(() => {});
  }
}, 60 * 1000).unref();

// ---- 思考超时托管：轮到方超过 turnTimeoutMs 未操作，人机代走一步 ----
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state === 'playing' && room.turnDeadline && now > room.turnDeadline) {
      if (room.gameType === 'doudizhu') ddzAutoMove(room);
      else autoMove(room);
    }
  }
}, 1000).unref();

// ---- 启动 ----
(async () => {
  await settle.init(CONFIG.mysql);
  bindings.init(CONFIG.bindingsFile);
  auth.init(CONFIG.newapiBase);
  aiNews.init({ base: CONFIG.newapiBase, key: CONFIG.newapiKey, model: CONFIG.aiModel });
  if (CONFIG.bindingsFile) {
    console.log(`[game-center] bindingsFile=${CONFIG.bindingsFile}`);
  }
  if (CONFIG.newapiBase) {
    console.log(`[game-center] newapiBase=${CONFIG.newapiBase}`);
  }
  console.log(`[game-center] aiNews=${aiNews.ready() ? CONFIG.aiModel : 'DISABLED (no NEWAPI_KEY)'}`);
  server.listen(CONFIG.port, () => {
    console.log(`[game-center] listening on :${CONFIG.port}`);
    console.log(`[game-center] mysql ${settle.ready() ? 'connected' : 'NOT configured'}`);
    console.log(`[game-center] minBet=${CONFIG.minBet} maxBet=${CONFIG.maxBet}`);
    console.log(`[game-center] publicUrl=${CONFIG.publicUrl || '(未配置)'}`);
  });

  // 管理后台（独立端口 + 密码保护）
  const adminApp = createAdminApp({
    configModule: config,
    getConfig: () => CONFIG,
    settle, market, stats, bindings,
    bindingsFresh: () => bindings.list(),
    getRooms: () => rooms,
    getSoloSessions: () => soloSessions,
    logbuf: require('./lib/logbuf'),
    restart: () => process.exit(0),
    version: require('./package.json').version,
  });
  const adminServer = http.createServer(adminApp);
  adminServer.listen(CONFIG.adminPort, () => {
    console.log(`[game-center] admin listening on :${CONFIG.adminPort}（管理后台）`);
  });
})();
