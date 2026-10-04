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

const { XQ } = require('./lib/xq');
const { Gomoku } = require('./lib/gomoku');
const settle = require('./lib/settle');
const { Stats } = require('./lib/stats');
const bindings = require('./lib/bindings');
const solo = require('./lib/solo');
const auth = require('./lib/auth');
const ai = require('./lib/ai');
const aiNews = require('./lib/aiNews');
const { Market, MIN_BUY_USD, BUY_FEE_RATE, SELL_FEE_RATE, LIMIT_PCT } = require('./lib/market');
const { createAdminApp } = require('./lib/admin');

const stats = new Stats(CONFIG.statsFile);
const market = new Market(CONFIG.portfolioFile, CONFIG.reversalsFile);

const GAME_TYPES = {
  xiangqi: { name: '象棋', url: 'xiangqi.html', create: () => new XQ() },
  gomoku: { name: '五子棋', url: 'gomoku.html', create: () => new Gomoku() },
};

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

function makeRoom(gameType, groupId, player, betUsd) {
  const id = crypto.randomBytes(6).toString('hex');
  const betQuota = Math.max(1, Math.round(betUsd * CONFIG.quotaPerUnit));
  const room = {
    id,
    gameType,
    groupId: String(groupId),
    bet: betUsd,
    betQuota,
    players: { 1: player, 2: null },
    state: 'waiting', // waiting | playing | finished
    game: null,
    turn: 1,
    turnDeadline: null, // 当前轮到方的最晚落子时间戳（超时由人机托管）
    autoMoving: false,
    winner: 0,
    reason: '',
    createdAt: Date.now(),
    finishedAt: null,
    tokens: { 1: crypto.randomBytes(8).toString('hex'), 2: '' },
  };
  rooms.set(id, room);
  return room;
}

function roomPublic(room, withToken) {
  const r = {
    id: room.id,
    gameType: room.gameType,
    groupId: room.groupId,
    bet: room.bet,
    betQuota: room.betQuota,
    state: room.state,
    turn: room.turn,
    winner: room.winner,
    reason: room.reason,
    players: {
      1: room.players[1],
      2: room.players[2],
    },
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

  let betUsd = parseFloat(bet);
  if (!(betUsd > 0)) betUsd = CONFIG.minBet;
  if (betUsd < CONFIG.minBet) return res.status(400).json({ error: `最低押注 $${CONFIG.minBet}` });
  if (betUsd > CONFIG.maxBet) return res.status(400).json({ error: `最高押注 $${CONFIG.maxBet}` });

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

// 加入房间（接受对方押注额），双方扣款并开战
app.post('/api/room/:id/join', async (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在或已结束' });
  if (room.state !== 'waiting') return res.status(400).json({ error: '房间已满或已开始' });

  const { player } = req.body || {};
  if (!player || !player.userId) return res.status(400).json({ error: '参数缺失' });
  if (String(player.qq) === String(room.players[1].qq)) {
    return res.status(400).json({ error: '不能和自己对战' });
  }
  if (String(player.userId) === String(room.players[1].userId)) {
    return res.status(400).json({ error: '不能和自己对战' });
  }

  // 双方扣款（自由押注：对手接受发起人押注额）
  if (settle.ready()) {
    const ok = await settle.settleStart(room.players[1].userId, player.userId, room.betQuota);
    if (!ok) return res.status(400).json({ error: '余额不足，无法开战（双方各需 $' + room.bet + '）' });
  }

  room.players[2] = player;
  room.tokens[2] = crypto.randomBytes(8).toString('hex');
  room.game = GAME_TYPES[room.gameType].create();
  room.state = 'playing';
  room.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;

  res.json({ code: 'started', room: roomPublic(room, true) });
});

// 查询房间状态（插件轮询用）
app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const r = roomPublic(room, false);
  r.stats = {
    1: stats.summary(room.players[1].userId, room.gameType),
    2: room.players[2] ? stats.summary(room.players[2].userId, room.gameType) : null,
  };
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
function resolveBet(token, bet) {
  const s = auth.resolve(token);
  if (!s) return { error: '未登录或登录已过期，请先在大厅登录 NewAPI 账号' };
  const betUsd = parseFloat(bet);
  if (!(betUsd >= CONFIG.minBet && betUsd <= CONFIG.maxBet)) {
    return { error: `押注金额需在 $${CONFIG.minBet}~$${CONFIG.maxBet} 之间` };
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

// 钉板弹珠：一轮（扣门票 + 服务端随机游走 + 结算）
app.post('/api/solo/plinko', async (req, res) => {
  try {
    const rb = resolveBet(req.body && req.body.token, req.body && req.body.bet);
    if (rb.error) return res.status(400).json({ error: rb.error });
    if (settle.ready() && !(await settle.debit(rb.player.userId, rb.betQuota))) {
      return res.status(400).json({ error: '余额不足' });
    }
    const drop = solo.plinkoDrop();
    const net = await settleTicket(rb.player.userId, 'plinko', rb.betQuota, drop.mult);
    res.json({
      code: 'ok', bet: rb.betUsd, slot: drop.slot, mult: drop.mult, path: drop.path,
      netUsd: usd(net), quota: settle.ready() ? await settle.balance(rb.player.userId) : null,
      username: rb.player.username,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 打砖块：开始（扣门票 + 发种子）
app.post('/api/solo/breakout/start', async (req, res) => {
  try {
    const rb = resolveBet(req.body && req.body.token, req.body && req.body.bet);
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
    const mult = solo.breakoutMult(rep.score);
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
    const rb = resolveBet(req.body && req.body.token, req.body && req.body.bet);
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
    const mult = solo.snakeMult(replay.score);
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
    const rb = resolveBet(token, bet);
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
    fees: {
      buyFeeRate: BUY_FEE_RATE, sellFeeRate: SELL_FEE_RATE, limitPct: LIMIT_PCT,
      t1: true,
    },
  });
});

app.get('/api/market/stock/:code', (req, res) => {
  const s = market.detail(req.params.code);
  if (!s) return res.status(404).json({ error: '股票不存在' });
  res.json(s);
});

app.post('/api/market/buy', async (req, res) => {
  const s = auth.resolve((req.body || {}).token);
  if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
  const { code, amount } = req.body || {};
  const usdAmt = parseFloat(amount);
  if (!(usdAmt >= MIN_BUY_USD)) return res.status(400).json({ error: `最低投入 $${MIN_BUY_USD}（无上限）` });
  // 买入手续费（与 market.buy 内部一致），本金 + 手续费一并扣额度
  const feeUsd = round2(usdAmt * BUY_FEE_RATE);
  const totalUsd = round2(usdAmt + feeUsd);
  const quota = Math.round(totalUsd * CONFIG.quotaPerUnit);

  let debited = false;
  try {
    if (settle.ready()) {
      if (!(await settle.debit(s.userId, quota))) {
        return res.status(400).json({ error: '余额不足（含手续费，共需 $' + totalUsd + '）' });
      }
      debited = true;
    }
    const r = market.buy(s.userId, code, usdAmt, s.username);
    if (r.error) {
      if (settle.ready() && debited) await settle.credit(s.userId, quota); // 回滚本金+手续费
      return res.status(400).json({ error: r.error });
    }
    let bal = null;
    if (settle.ready()) { try { bal = await settle.balance(s.userId); } catch (e) { bal = null; } }
    res.json({ code: 'ok', ...r, quota: bal });
  } catch (e) {
    // 入仓抛异常时回滚已扣额度，避免「提示失败但已扣款」
    if (settle.ready() && debited) { try { await settle.credit(s.userId, quota); } catch (e2) { /* ignore */ } }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/market/sell', async (req, res) => {
  try {
    const s = auth.resolve((req.body || {}).token);
    if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
    const { code, shares } = req.body || {};
    const r = market.sell(s.userId, code, shares, s.username);
    if (r.error) return res.status(400).json({ error: r.error });
    // 卖出：扣除手续费后返还额度（卖出手续费含印花税）
    const netUsd = round2(r.proceeds - r.feeUsd);
    const quota = Math.round(netUsd * CONFIG.quotaPerUnit);
    if (settle.ready()) await settle.credit(s.userId, quota);
    let bal = null;
    if (settle.ready()) { try { bal = await settle.balance(s.userId); } catch (e) { bal = null; } }
    res.json({ code: 'ok', ...r, netUsd, quota: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ---- 网页邀请 / 接受 队列（bot 轮询处理，bot 负责解析 QQ→账号身份） ----

// 发起邀请：网页已登录（token），游戏服务直接解析 userId 交由 bot 建房 + 群广播
app.post('/api/invite', (req, res) => {
  const { gameType, groupId, token, bet } = req.body || {};
  const sess = auth.resolve(token);
  if (!sess) return res.status(401).json({ error: '未登录或登录已过期' });
  if (!GAME_TYPES[gameType]) return res.status(400).json({ error: '不支持的游戏类型' });
  if (!groupId) return res.status(400).json({ error: '缺少群号' });

  let betUsd = parseFloat(bet);
  if (!(betUsd > 0)) betUsd = CONFIG.minBet;
  if (betUsd < CONFIG.minBet) return res.status(400).json({ error: `最低押注 $${CONFIG.minBet}` });
  if (betUsd > CONFIG.maxBet) return res.status(400).json({ error: `最高押注 $${CONFIG.maxBet}` });

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
    room.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
    broadcastRoom(room.id, {
      type: 'move',
      move,
      state: room.game.getState(),
      turn: room.game.turnPlayer(),
      auto: true,
      autoPlayer: turn,
      deadline: room.turnDeadline,
      timeoutMs: CONFIG.turnTimeoutMs,
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
  onTrade: safeBroadcast((t) => broadcastMarket({ type: 'trade', side: t.type, username: t.username, code: t.code, name: t.name, price: t.price, amount: t.amount, shares: t.shares })),
  onNews: safeBroadcast((n) => broadcastMarket({ type: 'news', ...n })),
});

marketWss.on('connection', (ws) => {
  try { ws.send(JSON.stringify({ type: 'quote', ...market.quote() })); } catch (e) { /* ignore */ }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  const player = parseInt(url.searchParams.get('player'), 10);
  const token = url.searchParams.get('token');

  const room = roomId ? rooms.get(roomId) : null;
  if (!room || room.state !== 'playing' || (player !== 1 && player !== 2)) {
    ws.send(JSON.stringify({ type: 'error', message: '房间不可用' }));
    ws.close();
    return;
  }
  if (room.tokens[player] !== token) {
    ws.send(JSON.stringify({ type: 'error', message: '鉴权失败' }));
    ws.close();
    return;
  }

  const opponent = room.players[player === 1 ? 2 : 1];

  ws.roomId = room.id;
  ws.player = player;

  ws.send(JSON.stringify({
    type: 'hello',
    player,
    gameType: room.gameType,
    bet: room.bet,
    state: room.game.getState(),
    opponent: { qq: opponent.qq, name: opponent.name },
    you: { qq: room.players[player].qq, name: room.players[player].name },
    deadline: room.turnDeadline,
    timeoutMs: CONFIG.turnTimeoutMs,
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
      room.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
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
}, 60 * 1000).unref();

// ---- 思考超时托管：轮到方超过 turnTimeoutMs 未操作，人机代走一步 ----
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state === 'playing' && room.turnDeadline && now > room.turnDeadline) {
      autoMove(room);
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
