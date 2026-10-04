'use strict';
// 模拟股市（真实化）：10 个虚拟股票，服务端持续产生 24h 行情。
// 价格模型 = 个股噪声 + 板块情绪 + 动量 + 均值回归 + 消息冲击，并受涨跌停约束；
// 买卖按供需撮合反作用于价格；含手续费、T+1 锁定；持仓 JSON 持久化。
const fs = require('fs');
const path = require('path');
const aiNews = require('./aiNews');

const STOCK_COUNT = 18; // 股票总数（扩容，含 T+0/T+1 混合）
const TICK_MS = 5000; // 每 5s 一次行情
const MAX_HISTORY = 480; // 分时点保留数
const KLINE_DAYS = 60; // 日K 根数
const MIN_BUY_USD = 1000; // 单笔最低投入（美元），无上限
const T0_EVERY = 3; // 每 3 只里 1 只为 T+0（当天可买卖），其余 T+1
const NEWS_TTL_HOURS = parseFloat(process.env.NEWS_TTL_HOURS || '6'); // 新闻保留小时数，过期自动从列表移除

// AI 事件全随机调度：每天随机抽取 NEWS_DAILY_MIN~NEWS_DAILY_MAX 个触发时间点，
// 均匀随机散布在未来 24 小时内（可用环境变量覆盖）。首次启动 2~8 分钟先来一条，避免冷启动等太久。
const NEWS_DAILY_MIN = parseInt(process.env.NEWS_DAILY_MIN || '4', 10); // 每天最少事件数
const NEWS_DAILY_MAX = parseInt(process.env.NEWS_DAILY_MAX || '24', 10); // 每天最多事件数（24 次内）
const FIRST_NEWS_MIN_MS = 2 * 60 * 1000; // 首次事件最早 2 分钟
const FIRST_NEWS_MAX_MS = 8 * 60 * 1000; // 首次事件最晚 8 分钟
const LOCK_MIN_MS = 30 * 60 * 1000; // 封板最短 30 分钟
const LOCK_MAX_MS = 2 * 60 * 60 * 1000; // 封板最长 2 小时

// 交易规则
const LIMIT_PCT = 0.10; // 涨跌停 ±10%（相对昨收）
const BUY_FEE_RATE = 0.001; // 买入手续费 0.1%
const SELL_FEE_RATE = 0.002; // 卖出手续费 0.2%（含印花税）
const IMPACT_K = 3000; // 买卖冲击系数
const IMPACT_CAP = 0.03; // 单笔冲击封顶 ±3%
const MAX_TRADES = 100; // 成交流历史保留条数（内存，最新在前）

// 新闻冲击模型：一条强度 mag 的新闻，期望最终产生约 mag 的方向性走势。
// 拆成「即时跳价」+「慢速趋势」两段，避免一击涨跌停 + 封板僵死，让走势可见。
// 即时跳价占比 NEWS_JUMP_RATIO；剩余部分通过 newsShock 趋势体现（配合 0.85 衰减，
// 趋势累积系数 ≈ 1/(1-0.85)=6.667，故 DRIFT_K = (1-JUMP)/6.667 使趋势累积恰为该占比）。
const NEWS_JUMP_RATIO = 0.55;
const NEWS_DRIFT_K = (1 - NEWS_JUMP_RATIO) / 6.667; // ≈0.0675

const SECTORS = ['科技', '能源', '医药', '消费'];
const PREFIX = ['云图', '星辰', '蓝海', '凌霄', '天工', '逐光', '启明', '远航', '鸿蒙', '磐石', '清源', '凌云', '曜石', '听澜'];
const SUFFIX = ['科技', '能源', '医药', '智能', '数据', '航天', '半导体', '新能源', '生物', '传媒', '软件', '材料', '金融', '通信'];

const GOOD_NEWS = [
  '{name}发布新一代产品，市场反响热烈',
  '{name}斩获大额订单，业绩有望超预期',
  '{name}获多家机构上调评级',
  '{name}与行业龙头达成战略合作',
  '{name}新产品获批，打开新增长空间',
  '{name}宣布回购计划，提振市场信心',
  '{name}中标重大项目，机构看好',
];
const BAD_NEWS = [
  '{name}业绩预告不及预期',
  '{name}被曝财务问题，遭监管问询',
  '{name}核心高管减持套现',
  '{name}产品被曝质量问题，面临召回',
  '{name}遭遇反垄断调查',
  '{name}核心客户流失，订单下滑',
];

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function randInt(lo, hi) { return Math.floor(rand(lo, hi + 1)); }

class Market {
  constructor(file, reversalFile) {
    this.file = file;
    this.reversalFile = reversalFile || path.join(path.dirname(file), 'reversals.json');
    this.stocks = [];
    this.portfolio = {};
    this.sectors = {}; // 板块 -> 情绪值 [-1,1]
    this.news = []; // 最近消息
    this.newsSeq = 0;
    this.index = 1000;
    this.indexPrev = 1000;
    this.indexChangePct = 0;
    this.indexHistory = [];
    this.handlers = {};
    this.tradeHistory = [];   // 成交流历史（内存，最新在前，刷新页面后从 /api/market/trades 拉回）
    this.tradeSeq = 0;
    this.lastUnlockDay = new Date().toDateString();
    this.lockedStocks = {}; // code -> { price, until, dir }
    this.reversals = []; // 待触发的后续新闻（持久化，方向独立随机）
    this.generatingNews = false;
    this.newsSchedule = []; // 当天已排定的随机触发时间点（毫秒时间戳，升序）
    this._loadPortfolio();
    this._loadReversals();
    this._seed();
    this._scheduleNews();
    this._tick();
    setInterval(() => this._tick(), TICK_MS).unref();
  }

  setHandlers(h) {
    this.handlers = h || {};
  }

  // 记录一条成交流到历史（内存），返回带 id/time 的记录
  recordTrade(t) {
    const item = {
      id: ++this.tradeSeq,
      time: Date.now(),
      type: t.type, username: t.username || '', code: t.code, name: t.name,
      price: t.price, amount: t.amount, shares: t.shares,
    };
    this.tradeHistory.unshift(item);
    if (this.tradeHistory.length > MAX_TRADES) this.tradeHistory.length = MAX_TRADES;
    return item;
  }

  // 返回最近 limit 条成交流（最新在前）
  trades(limit = 50) {
    const n = Math.max(0, Math.min(parseInt(limit, 10) || 50, MAX_TRADES));
    return this.tradeHistory.slice(0, n);
  }

  // 生成当天事件计划：随机 N 次（NEWS_DAILY_MIN~NEWS_DAILY_MAX），均匀随机散布在未来 24 小时
  _scheduleNews() {
    const n = randInt(NEWS_DAILY_MIN, NEWS_DAILY_MAX);
    const start = Date.now() + randInt(FIRST_NEWS_MIN_MS, FIRST_NEWS_MAX_MS);
    const end = Date.now() + 24 * 3600 * 1000;
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(start + Math.random() * (end - start));
    pts.sort((a, b) => a - b);
    this.newsSchedule = pts;
  }

  _seed() {
    if (this.stocks.length) return;
    const used = new Set();
    for (let i = 0; i < STOCK_COUNT; i++) {
      let name;
      do {
        name = PREFIX[Math.floor(Math.random() * PREFIX.length)] +
               SUFFIX[Math.floor(Math.random() * SUFFIX.length)];
      } while (used.has(name));
      used.add(name);
      const code = 'SIM' + String(i + 1).padStart(2, '0');
      const sector = SECTORS[i % SECTORS.length];
      const prevClose = round2(20 + Math.random() * 180);
      const open = round2(prevClose * (1 + (Math.random() - 0.5) * 0.04));
      let price = round2(open * (1 + (Math.random() - 0.5) * 0.03));
      const high = round2(Math.max(open, price) * (1 + Math.random() * 0.015));
      const low = round2(Math.min(open, price) * (1 - Math.random() * 0.015));
      price = clamp(price, low, high);
      const volume = Math.round(20000 + Math.random() * 980000); // 手
      const amount = round2(volume * 100 * price); // 元
      const circulation = round2((5 + Math.random() * 95) * 1e8); // 流通市值 5~100 亿美元
      const history = this._genIntraday(open, price);
      const kline = this._genKline(prevClose, open, high, low, price);
      this.stocks.push({
        code, name, sector, prevClose, open, high, low, price, prev: prevClose,
        history, kline, volume, amount, circulation,
        momentum: 0, newsShock: 0,
        t0: i % T0_EVERY === 0, // T+0：当天买入当天可卖；否则 T+1
      });
    }
    for (const sec of SECTORS) this.sectors[sec] = 0;
    this._snapshotIndex();
  }

  _genIntraday(open, price) {
    const n = 90;
    const arr = [open];
    let cur = open;
    for (let i = 1; i < n; i++) {
      cur = round2(Math.max(0.01, cur * (1 + (Math.random() - 0.5) * 0.01)));
      arr.push(cur);
    }
    arr[arr.length - 1] = price;
    return arr;
  }

  _genKline(prevClose, open, high, low, price) {
    const arr = [];
    let close = prevClose;
    for (let i = 0; i < KLINE_DAYS; i++) {
      const o = round2(close * (1 + (Math.random() - 0.5) * 0.03));
      const c = round2(o * (1 + (Math.random() - 0.5) * 0.06));
      const h = round2(Math.max(o, c) * (1 + Math.random() * 0.02));
      const l = round2(Math.min(o, c) * (1 - Math.random() * 0.02));
      const v = Math.round(8000 + Math.random() * 992000);
      arr.push({ o, h, l, c, v });
      close = c;
    }
    arr[arr.length - 1] = { o: open, h: high, l: low, c: price, v: arr[arr.length - 1].v };
    return arr;
  }

  // 每日收盘：昨收重新锚定（涨跌停基准）、日K 追加、T+1 解锁
  _maybeNewDay() {
    const day = new Date().toDateString();
    if (day === this.lastUnlockDay) return;
    this.lastUnlockDay = day;
    for (const s of this.stocks) {
      s.prevClose = s.price;
      s.open = s.price;
      s.high = s.price;
      s.low = s.price;
      s.prev = s.price;
      s.momentum = 0;
      s.history = [s.price];
      const k = { o: s.price, h: s.price, l: s.price, c: s.price, v: Math.round(50000 + Math.random() * 200000) };
      s.kline.push(k);
      if (s.kline.length > KLINE_DAYS) s.kline.shift();
    }
    for (const uid in this.portfolio) {
      const p = this.portfolio[uid];
      for (const code in p) {
        if (code === '_name') continue;
        if (p[code].locked) p[code].locked = 0;
      }
    }
    this.lockedStocks = {}; // 换日解封所有涨跌停封板
    this._scheduleNews(); // 换日重新随机排定当天事件
    this._savePortfolio();
  }

  _limits(s) {
    return { down: round2(s.prevClose * (1 - LIMIT_PCT)), up: round2(s.prevClose * (1 + LIMIT_PCT)) };
  }

  // 到点触发一条 AI 事件（失败则降级模板）
  async _fireNews() {
    if (this.generatingNews) return;
    this.generatingNews = true;
    try {
      let ev = null;
      if (aiNews.ready()) {
        const ctx = this.stocks.map((s) => ({
          code: s.code, name: s.name, sector: s.sector, price: s.price,
          changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0,
        }));
        ev = await aiNews.generate(ctx);
      }
      if (ev && ev.code) this._applyEvent(ev);
      else this._applyFallbackNews();
    } finally {
      this.generatingNews = false;
    }
  }

  // 对单只股票施加新闻冲击：即时跳价 + 慢速趋势。
  // driftOnly=true 时只施加慢速趋势（用于同板块弱联动，不直接跳价）。
  _applyShock(s, sign, mag, driftOnly) {
    if (!s) return;
    const { down, up } = this._limits(s);
    if (!driftOnly) {
      const jump = round2(clamp(s.price * (1 + sign * mag * NEWS_JUMP_RATIO), down, up));
      // 仅当跳价触及涨跌停才封板（非常极端的新闻），普通事件不封，让走势自然回归
      if (jump >= up - 0.001) {
        this.lockedStocks[s.code] = { price: up, until: Date.now() + randInt(LOCK_MIN_MS, LOCK_MAX_MS), dir: 'up' };
        s.price = up;
      } else if (jump <= down + 0.001) {
        this.lockedStocks[s.code] = { price: down, until: Date.now() + randInt(LOCK_MIN_MS, LOCK_MAX_MS), dir: 'down' };
        s.price = down;
      } else {
        s.price = jump;
      }
    }
    // 慢速趋势：剩余冲击分摊进 newsShock，逐 tick 衰减体现，形成一段可见的方向性走势
    s.newsShock = (s.newsShock || 0) + sign * mag * NEWS_DRIFT_K;
    if (s.price > s.high) s.high = s.price;
    if (s.price < s.low) s.low = s.price;
  }

  // 应用 AI 事件：即时跳价 + 慢速趋势 + 板块联动 + 反转排队
  _applyEvent(ev) {
    const s = this.find(ev.code);
    if (!s) return this._applyFallbackNews();
    const sign = ev.direction === 'bad' ? -1 : 1;
    const mag = ev.magnitude || 0.05;
    this._applyShock(s, sign, mag, false);
    // 同板块联动（弱冲击，仅趋势不跳价）
    for (const o of this.stocks) {
      if (o.code !== s.code && o.sector === s.sector) this._applyShock(o, sign, mag * 0.3, true);
    }
    const item = {
      id: ++this.newsSeq, time: Date.now(), expireAt: Date.now() + NEWS_TTL_HOURS * 3600 * 1000,
      code: s.code, name: s.name, sector: s.sector,
      text: ev.headline, detail: ev.detail, direction: ev.direction, magnitude: mag, followup: false,
    };
    this.news.unshift(item);
    if (this.news.length > 50) this.news.pop();
    if (this.handlers.onNews) this.handlers.onNews(item);
    // 后续新闻排队（持久化，方向独立随机：可同向延续、可反向反转）
    if (ev.followup && ev.followup.headline) {
      this.reversals.push({
        at: Date.now() + ev.followup.delayHours * 3600 * 1000,
        code: s.code, name: s.name,
        headline: ev.followup.headline, detail: ev.followup.detail,
        direction: ev.followup.direction, magnitude: ev.followup.magnitude || 0.08,
      });
      this._saveReversals();
    }
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  // 后续新闻触发：解除封板 + 按方向冲击（方向独立随机，可能同向也可能反向）
  _applyReversal(r) {
    const s = this.find(r.code);
    if (!s) return;
    const sign = r.direction === 'bad' ? -1 : 1;
    const mag = r.magnitude || 0.08;
    delete this.lockedStocks[s.code];
    this._applyShock(s, sign, mag, false);
    const item = {
      id: ++this.newsSeq, time: Date.now(), expireAt: Date.now() + NEWS_TTL_HOURS * 3600 * 1000,
      code: s.code, name: s.name, sector: s.sector,
      text: r.headline, detail: r.detail, direction: r.direction, magnitude: mag, followup: true,
    };
    this.news.unshift(item);
    if (this.news.length > 50) this.news.pop();
    if (this.handlers.onNews) this.handlers.onNews(item);
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  // 清理过期新闻（新闻有时效，出现 NEWS_TTL_HOURS 小时后自动移除）
  _pruneNews() {
    if (!this.news.length) return;
    const now = Date.now();
    const before = this.news.length;
    this.news = this.news.filter((n) => !n.expireAt || n.expireAt > now);
    if (this.news.length !== before && this.handlers.onNewsExpire) {
      this.handlers.onNewsExpire(this.news.map((n) => n.id));
    }
  }

  _checkReversals() {
    if (!this.reversals.length) return;
    const now = Date.now();
    let changed = false;
    for (let i = this.reversals.length - 1; i >= 0; i--) {
      if (now >= this.reversals[i].at) {
        const r = this.reversals.splice(i, 1)[0];
        this._applyReversal(r);
        changed = true;
      }
    }
    if (changed) this._saveReversals();
  }

  // AI 失败时的降级模板（保证股市始终有消息，且与 AI 事件一样即时影响股价）
  _applyFallbackNews() {
    const s = this.stocks[Math.floor(Math.random() * this.stocks.length)];
    const good = Math.random() < 0.5;
    const pool = good ? GOOD_NEWS : BAD_NEWS;
    const text = pool[Math.floor(Math.random() * pool.length)].replace('{name}', s.name);
    const sign = good ? 1 : -1;
    const mag = 0.05;
    this._applyShock(s, sign, mag, false);
    const item = {
      id: ++this.newsSeq, time: Date.now(), expireAt: Date.now() + NEWS_TTL_HOURS * 3600 * 1000,
      code: s.code, name: s.name, sector: s.sector,
      text, detail: text, direction: good ? 'good' : 'bad', magnitude: mag, followup: false,
    };
    this.news.unshift(item);
    if (this.news.length > 50) this.news.pop();
    if (this.handlers.onNews) this.handlers.onNews(item);
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  _loadReversals() {
    try {
      if (fs.existsSync(this.reversalFile)) {
        const arr = JSON.parse(fs.readFileSync(this.reversalFile, 'utf8'));
        this.reversals = Array.isArray(arr) ? arr.filter((r) => r && r.at && r.code) : [];
      }
    } catch (e) {
      this.reversals = [];
    }
  }

  _saveReversals() {
    try {
      fs.mkdirSync(path.dirname(this.reversalFile), { recursive: true });
      fs.writeFileSync(this.reversalFile, JSON.stringify(this.reversals, null, 2));
    } catch (e) { /* ignore */ }
  }

  _tick() {
    this._maybeNewDay();
    // 到点触发所有已到时间的新闻事件
    while (this.newsSchedule.length && Date.now() >= this.newsSchedule[0]) {
      this.newsSchedule.shift();
      this._fireNews();
    }
    this._checkReversals();
    this._pruneNews();
    // 板块情绪：随机游走 + 均值回归到 0
    for (const sec of SECTORS) {
      const cur = this.sectors[sec] || 0;
      this.sectors[sec] = clamp(cur + (Math.random() - 0.5) * 0.03 - cur * 0.02, -1, 1);
    }
    for (const s of this.stocks) {
      s.prev = s.price;
      // 涨跌停封板：价格钉死在涨跌停价，仅成交继续活跃
      const lock = this.lockedStocks[s.code];
      if (lock) {
        if (Date.now() >= lock.until) {
          delete this.lockedStocks[s.code];
        } else {
          s.price = lock.price;
          s.history.push(s.price);
          if (s.history.length > MAX_HISTORY) s.history.shift();
          const k = s.kline[s.kline.length - 1];
          k.c = s.price;
          if (s.price > k.h) k.h = s.price;
          if (s.price < k.l) k.l = s.price;
          s.volume += Math.round(Math.random() * 9000);
          s.amount = round2(s.amount + Math.random() * 600000);
          continue;
        }
      }
      const noise = (Math.random() - 0.5) * 0.002; // 个股噪声 ±0.1%
      const sectorDrift = (this.sectors[s.sector] || 0) * 0.0006; // 板块情绪
      const momentum = s.momentum * 0.3; // 动量延续
      const dev = s.prevClose > 0 ? (s.price - s.prevClose) / s.prevClose : 0;
      const meanRev = -dev * 0.002; // 均值回归拉力
      const shock = s.newsShock || 0; // 消息冲击
      const change = noise + sectorDrift + momentum + meanRev + shock;
      let newPrice = round2(Math.max(0.01, s.price * (1 + change)));
      // 涨跌停约束（相对昨收，基准价先 round2 避免浮点尾数）
      const limitDown = round2(s.prevClose * (1 - LIMIT_PCT));
      const limitUp = round2(s.prevClose * (1 + LIMIT_PCT));
      newPrice = round2(clamp(newPrice, limitDown, limitUp));
      s.price = newPrice;
      // 动量 EMA
      const ret = s.prev > 0 ? (s.price - s.prev) / s.prev : 0;
      s.momentum = s.momentum * 0.85 + ret * 0.15;
      // 消息冲击衰减
      if (s.newsShock) {
        s.newsShock *= 0.85;
        if (Math.abs(s.newsShock) < 0.0002) s.newsShock = 0;
      }
      if (s.price > s.high) s.high = s.price;
      if (s.price < s.low) s.low = s.price;
      s.history.push(s.price);
      if (s.history.length > MAX_HISTORY) s.history.shift();
      s.volume += Math.round(Math.random() * 9000);
      s.amount = round2(s.amount + Math.random() * 600000);
      const k = s.kline[s.kline.length - 1];
      k.c = s.price;
      if (s.price > k.h) k.h = s.price;
      if (s.price < k.l) k.l = s.price;
    }
    this._snapshotIndex();
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  _snapshotIndex() {
    const sum = this.stocks.reduce((a, s) => a + s.price, 0);
    const base = this.stocks.reduce((a, s) => a + (s.prevClose || s.price), 0);
    this.indexPrev = this.index;
    this.index = round2((sum / (base || 1)) * 1000);
    this.indexChangePct = this.indexPrev > 0 ? round2((this.index - this.indexPrev) / this.indexPrev * 100) : 0;
    this.indexHistory.push(this.index);
    if (this.indexHistory.length > MAX_HISTORY) this.indexHistory.shift();
  }

  _loadPortfolio() {
    try {
      if (fs.existsSync(this.file)) this.portfolio = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.portfolio = {};
    }
  }

  _savePortfolio() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.portfolio, null, 2));
    } catch (e) { /* ignore */ }
  }

  _public(s) {
    return {
      code: s.code, name: s.name, sector: s.sector, price: s.price,
      prevClose: s.prevClose, open: s.open, high: s.high, low: s.low,
      change: round2(s.price - s.prevClose),
      changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0,
      limitUp: round2(s.prevClose * (1 + LIMIT_PCT)), limitDown: round2(s.prevClose * (1 - LIMIT_PCT)),
      volume: s.volume, amount: s.amount, circulation: s.circulation,
      lock: (this.lockedStocks[s.code] && this.lockedStocks[s.code].dir) || null,
      t0: !!s.t0,
      history: s.history, kline: s.kline,
    };
  }

  list() {
    const list = this.stocks.map((s) => this._public(s));
    const up = this.stocks.filter((s) => s.price > s.prevClose).length;
    const down = this.stocks.filter((s) => s.price < s.prevClose).length;
    const flat = STOCK_COUNT - up - down;
    return {
      list,
      index: { value: this.index, changePct: this.indexChangePct, history: this.indexHistory },
      breadth: { up, down, flat },
      news: this.news.filter((n) => !n.expireAt || n.expireAt > Date.now()).slice(0, 20),
      newsTtlHours: NEWS_TTL_HOURS,
    };
  }

  find(code) {
    return this.stocks.find((s) => s.code === code);
  }

  detail(code) {
    const s = this.find(code);
    return s ? this._public(s) : null;
  }

  // 实时推送精简行情（不含 history/kline）
  quote() {
    const ticks = this.stocks.map((s) => ({
      code: s.code, price: s.price, sector: s.sector,
      change: round2(s.price - s.prevClose),
      changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0,
      high: s.high, low: s.low, volume: s.volume, amount: s.amount,
      lock: (this.lockedStocks[s.code] && this.lockedStocks[s.code].dir) || null,
    }));
    const up = this.stocks.filter((s) => s.price > s.prevClose).length;
    const down = this.stocks.filter((s) => s.price < s.prevClose).length;
    const flat = STOCK_COUNT - up - down;
    return { index: { value: this.index, changePct: this.indexChangePct }, breadth: { up, down, flat }, ticks };
  }

  // 持仓快照（含现价、盈亏、可卖/锁定）
  holdings(userId) {
    const uid = String(userId);
    const p = this.portfolio[uid] || {};
    const rows = [];
    for (const code in p) {
      if (code === '_name') continue;
      const s = this.find(code);
      if (!s) continue;
      const h = p[code];
      const shares = h.shares || 0;
      const locked = h.locked || 0;
      const costUsd = h.costUsd || 0;
      const marketValue = round2(shares * s.price);
      rows.push({
        code, name: s.name, shares: round4(shares), price: s.price,
        locked: round4(locked), available: round4(Math.max(0, shares - locked)),
        costUsd: round2(costUsd), marketValue, pnl: round2(marketValue - costUsd),
        pnlPct: costUsd > 0 ? round2((marketValue - costUsd) / costUsd * 100) : 0,
        t0: !!s.t0,
      });
    }
    return rows;
  }

  // 买入：投入 amountUsd 美元（≥1000 无上限）。含手续费、冲击价格、T+1 锁定。
  buy(userId, code, amountUsd, username) {
    const s = this.find(code);
    if (!s) return { error: '股票不存在' };
    if (s.price >= s.prevClose * (1 + LIMIT_PCT) - 0.001) return { error: '该股已涨停，暂无法买入' };
    const usd = parseFloat(amountUsd);
    if (!(usd >= MIN_BUY_USD)) return { error: `最低投入 $${MIN_BUY_USD}（无上限）` };
    const fee = round2(usd * BUY_FEE_RATE);
    const shares = usd / s.price;
    const uid = String(userId);
    if (!this.portfolio[uid]) this.portfolio[uid] = {};
    if (username) this.portfolio[uid]._name = String(username);
    const h = this.portfolio[uid][code] || { shares: 0, locked: 0, costUsd: 0 };
    h.shares = round4((h.shares || 0) + shares);
    h.locked = round4((h.locked || 0) + (s.t0 ? 0 : shares)); // T+0 不锁定，T+1 锁定当日买入
    h.costUsd = round2((h.costUsd || 0) + usd + fee);
    this.portfolio[uid][code] = h;
    // 供需撮合：买入推高价格（受涨停约束）
    const impact = Math.min(IMPACT_CAP, (usd / (s.circulation || 1e9)) * IMPACT_K);
    s.price = round2(clamp(s.price * (1 + impact), s.prevClose * (1 - LIMIT_PCT), s.prevClose * (1 + LIMIT_PCT)));
    if (s.price > s.high) s.high = s.price;
    this._savePortfolio();
    const trade = this.recordTrade({ type: 'buy', username: username || '', code, name: s.name, price: s.price, amount: usd, shares: round4(shares) });
    if (this.handlers.onTrade) this.handlers.onTrade(trade);
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
    return {
      ok: true, code, name: s.name, price: s.price, boughtShares: round4(shares),
      costUsd: usd, feeUsd: fee, totalShares: h.shares, lockedShares: h.locked, impactPct: round2(impact * 100),
    };
  }

  // 卖出：shares 股（或 'all' 卖全部可卖）。含手续费、冲击价格。
  sell(userId, code, sharesArg, username) {
    const s = this.find(code);
    if (!s) return { error: '股票不存在' };
    if (s.price <= s.prevClose * (1 - LIMIT_PCT) + 0.001) return { error: '该股已跌停，暂无法卖出' };
    const uid = String(userId);
    const h = (this.portfolio[uid] || {})[code];
    if (!h || !h.shares) return { error: '没有该股票持仓' };
    const locked = h.locked || 0;
    const available = Math.max(0, h.shares - locked);
    if (available <= 0) return { error: '持仓为 T+1 当日买入，次日方可卖出' };
    let shares = sharesArg === 'all' ? available : parseFloat(sharesArg);
    if (!(shares > 0)) return { error: '卖出数量无效' };
    if (shares > available) return { error: `当日可卖 ${round4(available)} 股（T+1 锁定 ${round4(locked)} 股）` };
    const proceeds = round2(shares * s.price);
    const fee = round2(proceeds * SELL_FEE_RATE);
    const avgCost = h.shares > 0 ? h.costUsd / h.shares : 0;
    const costBasis = round2(shares * avgCost);
    h.shares = round4(h.shares - shares);
    h.costUsd = round2(Math.max(0, h.costUsd - costBasis));
    if (h.shares <= 0.0001) delete this.portfolio[uid][code];
    if (username) this.portfolio[uid]._name = String(username);
    // 供需撮合：卖出压低价格（受跌停约束）
    const impact = Math.min(IMPACT_CAP, (proceeds / (s.circulation || 1e9)) * IMPACT_K);
    s.price = round2(clamp(s.price * (1 - impact), s.prevClose * (1 - LIMIT_PCT), s.prevClose * (1 + LIMIT_PCT)));
    if (s.price < s.low) s.low = s.price;
    this._savePortfolio();
    const trade = this.recordTrade({ type: 'sell', username: username || '', code, name: s.name, price: s.price, amount: proceeds, shares: round4(shares) });
    if (this.handlers.onTrade) this.handlers.onTrade(trade);
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
    return {
      ok: true, code, name: s.name, price: s.price, soldShares: round4(shares),
      proceeds, feeUsd: fee, pnl: round2(proceeds - fee - costBasis), impactPct: round2(impact * 100),
    };
  }

  // 排行榜：按持仓总市值降序
  leaderboard(limit = 20) {
    const rows = [];
    for (const uid in this.portfolio) {
      const hs = this.holdings(uid);
      if (!hs.length) continue;
      const marketValue = round2(hs.reduce((a, b) => a + b.marketValue, 0));
      const pnl = round2(hs.reduce((a, b) => a + b.pnl, 0));
      rows.push({ userId: uid, name: this.portfolio[uid]._name || null, stocks: hs.length, marketValue, pnl });
    }
    rows.sort((a, b) => b.marketValue - a.marketValue);
    return rows.slice(0, limit);
  }
}

module.exports = { Market, MIN_BUY_USD, BUY_FEE_RATE, SELL_FEE_RATE, LIMIT_PCT };
