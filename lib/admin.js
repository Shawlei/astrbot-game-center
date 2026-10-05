'use strict';
// 管理后台（独立端口）：管理员密码登录 + 状态概览 + 配置读写 + 重启 + 日志 + 数据查看。
// 与游戏服务解耦，通过 deps 注入运行时依赖；仅挂载到独立 http server。
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const TOKEN_TTL_MS = 24 * 3600 * 1000; // 管理 token 24h

function createAdminApp(deps) {
  const app = express();
  app.use(express.json());

  const tokens = new Map(); // token -> expireAt

  const getConfig = deps.getConfig || (() => ({}));
  const usd = (q) => {
    const c = getConfig();
    return q == null ? 0 : q / (c.quotaPerUnit || 500000);
  };

  // ---- 认证 ----
  function issue() {
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, Date.now() + TOKEN_TTL_MS);
    // 清理过期
    const now = Date.now();
    for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
    return token;
  }
  function auth(req, res, next) {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query.token || '');
    if (t && tokens.has(t) && tokens.get(t) > Date.now()) return next();
    return res.status(401).json({ error: '未登录或登录已过期' });
  }

  app.post('/api/admin/login', (req, res) => {
    const pw = (req.body && req.body.password) || '';
    const cfg = getConfig();
    if (!cfg.adminPassword) return res.status(403).json({ error: '尚未设置管理员密码' });
    if (String(pw) !== String(cfg.adminPassword)) return res.status(401).json({ error: '密码错误' });
    res.json({ code: 'ok', token: issue() });
  });

  app.post('/api/admin/logout', (req, res) => {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query.token || '');
    tokens.delete(t);
    res.json({ code: 'ok' });
  });

  // ---- 状态概览 ----
  app.get('/api/admin/status', auth, (req, res) => {
    const cfg = getConfig();
    const rooms = deps.getRooms ? deps.getRooms() : new Map();
    let waiting = 0, playing = 0, finished = 0;
    for (const r of rooms.values()) {
      if (r.state === 'waiting') waiting++;
      else if (r.state === 'playing') playing++;
      else if (r.state === 'finished') finished++;
    }
    const market = deps.market;
    res.json({
      version: deps.version || '0.0.0',
      uptimeSec: Math.round(process.uptime()),
      db: deps.settle ? deps.settle.ready() : false,
      dbInfo: cfg.mysql ? { host: cfg.mysql.host, port: cfg.mysql.port, database: cfg.mysql.database } : null,
      newapi: cfg.newapiBase || null,
      aiModel: cfg.aiModel || null,
      rooms: { waiting, playing, finished },
      soloSessions: deps.getSoloSessions ? deps.getSoloSessions().size : 0,
      market: market ? {
        stocks: market.stocks ? market.stocks.length : 0,
        index: market.index != null ? market.index : null,
        news: market.news ? market.news.length : 0,
        holdings: market.portfolio ? Object.keys(market.portfolio).length : 0,
      } : null,
      bindingsCount: deps.bindings ? Object.keys(deps.bindingsFresh ? deps.bindingsFresh() : {}).length : 0,
      memory: process.memoryUsage(),
      node: process.version,
    });
  });

  // ---- 配置读写 ----
  app.get('/api/admin/config', auth, (req, res) => {
    res.json({
      config: getConfig(),
      persisted: deps.configModule ? deps.configModule.persisted() : {},
      configFile: deps.configModule ? deps.configModule.CONFIG_FILE : '',
      envMap: deps.configModule ? deps.configModule.ENV_MAP : {},
      defaults: deps.configModule ? deps.configModule.DEFAULTS : {},
    });
  });

  app.post('/api/admin/config', auth, (req, res) => {
    const partial = (req.body && req.body.config) || req.body || {};
    if (!deps.configModule) return res.status(500).json({ error: '配置模块不可用' });
    try {
      const merged = deps.configModule.save(partial);
      // 热更新内存配置，让押注上下限/游戏开关等运行时项立即生效
      if (deps.onConfigSaved) {
        try { deps.onConfigSaved(partial); } catch (e) { /* 热更新失败不影响已落盘结果 */ }
      }
      res.json({ code: 'ok', saved: merged, needRestart: false, liveApplied: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/restart', auth, (req, res) => {
    res.json({ code: 'ok', message: '正在重启，稍后自动恢复…' });
    setTimeout(() => {
      console.log('[admin] 管理员触发重启');
      process.exit(0);
    }, 500);
  });

  // ---- 日志 ----
  app.get('/api/admin/logs', auth, (req, res) => {
    const n = parseInt(req.query.n, 10) || 200;
    res.json({ logs: deps.logbuf ? deps.logbuf.tail(n) : [], size: deps.logbuf ? deps.logbuf.size() : 0 });
  });

  // ---- 数据查看 ----
  // 持仓用户列表（含绑定反查）
  app.get('/api/admin/users', auth, (req, res) => {
    const market = deps.market;
    if (!market) return res.json({ list: [] });
    const rows = [];
    for (const uid in market.portfolio) {
      if (uid === '_name') continue;
      const hs = market.holdings(uid);
      const mv = hs.reduce((a, b) => a + b.marketValue, 0);
      const pnl = hs.reduce((a, b) => a + b.pnl, 0);
      rows.push({
        userId: uid,
        name: market.portfolio[uid]._name || deps.bindings.usernameByUserId(uid) || `用户${uid}`,
        stocks: hs.length,
        marketValue: Math.round(mv * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
      });
    }
    rows.sort((a, b) => b.marketValue - a.marketValue);
    res.json({ list: rows });
  });

  // 指定用户持仓明细
  app.get('/api/admin/holdings', auth, (req, res) => {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    const rows = deps.market ? deps.market.holdings(userId) : [];
    const totalMarketValue = Math.round(rows.reduce((a, r) => a + r.marketValue, 0) * 100) / 100;
    const totalPnl = Math.round(rows.reduce((a, r) => a + r.pnl, 0) * 100) / 100;
    res.json({ userId, list: rows, totalMarketValue, totalPnl });
  });

  // 游戏排行榜（联机战绩 / 单机净赢）
  app.get('/api/admin/game/leaderboard', auth, (req, res) => {
    const gameType = req.query.gameType || 'xiangqi';
    const limit = parseInt(req.query.limit, 10) || 50;
    const rows = deps.stats ? deps.stats.leaderboard(gameType, limit) : [];
    const list = rows.map((r) => ({
      userId: r.userId,
      name: deps.bindings.usernameByUserId(r.userId) || `用户${r.userId}`,
      win: r.win || 0, lose: r.lose || 0, draw: r.draw || 0, total: r.total || 0,
      games: r.games || 0,
      netUsd: Math.round(usd(r.netQuota || 0) * 100) / 100,
      bestUsd: Math.round(usd(r.bestQuota || 0) * 100) / 100,
    }));
    res.json({ gameType, list });
  });

  // 股市排行榜
  app.get('/api/admin/market/leaderboard', auth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const rows = deps.market ? deps.market.leaderboard(limit) : [];
    const list = rows.map((r) => ({
      userId: r.userId,
      name: r.name || deps.bindings.usernameByUserId(r.userId) || `用户${r.userId}`,
      stocks: r.stocks, marketValue: r.marketValue, pnl: r.pnl,
    }));
    res.json({ list });
  });

  // 绑定关系列表（QQ -> userId/username）
  app.get('/api/admin/bindings', auth, (req, res) => {
    const raw = deps.bindingsFresh ? deps.bindingsFresh() : {};
    const list = Object.keys(raw).map((qq) => ({
      qq, userId: raw[qq].user_id, username: raw[qq].username,
    }));
    res.json({ list, count: list.length });
  });

  // ---- 静态前端 ----
  // favicon：返回 204，避免浏览器每次加载都刷一条 404
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use(express.static(path.join(__dirname, '..', 'admin')));

  return app;
}

module.exports = { createAdminApp };
