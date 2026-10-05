'use strict';
// 模拟股市（真实化）：18 只虚拟股票，按 A 股交易时段（集合竞价 9:15-9:25、连续竞价 9:30-11:30/13:00-15:00、午休、收盘）运行。
// 价格模型 = 个股噪声 + 板块情绪 + 动量 + 均值回归 + 消息冲击，并受涨跌停约束；
// 限价委托 + 五档盘口撮合（价格优先、时间优先），含手续费、T+1 锁定；持仓/反转 JSON 持久化。
const fs = require('fs');
const path = require('path');
const aiNews = require('./aiNews');

const STOCK_COUNT = 18; // 股票总数（扩容，含 T+0/T+1 混合）
const TICK_MS = 5000; // 每 5s 一次行情
const MAX_HISTORY = 480; // 分时点保留数
const KLINE_DAYS = 60; // 日K 根数
const MIN_BUY_USD = parseFloat(process.env.MARKET_MIN_BUY_USD || '1000'); // 单笔最低投入（美元），无上限
const T0_EVERY = Math.max(1, parseInt(process.env.MARKET_T0_EVERY || '3', 10)); // 每 N 只里 1 只为 T+0（当天可买卖），其余 T+1
const NEWS_TTL_HOURS = parseFloat(process.env.NEWS_TTL_HOURS || '6'); // 新闻保留小时数，过期自动从列表移除

// AI 事件全随机调度：改用 log-uniform 间隔制（时密时疏），不再固定「每天 N 次均匀散布」。
// 每次新闻触发后，用 log-uniform 抽下一次间隔（minGap ~ maxGap，短间隔多、长间隔少），
// 让新闻出现时间更接近真实市场（有时几分钟一条、有时几十分钟甚至更久）。
const NEWS_MIN_GAP_MS = Math.max(30 * 1000, parseFloat(process.env.NEWS_MIN_GAP_MIN || '2') * 60 * 1000);
const NEWS_MAX_GAP_MS = Math.max(NEWS_MIN_GAP_MS, parseFloat(process.env.NEWS_MAX_GAP_MIN || '90') * 60 * 1000);
// 中性新闻概率：约该比例的事件只发文字、不推股价，打破「新闻必然导致动荡」的死板。
const NEWS_NEUTRAL_RATE = Math.max(0, Math.min(1, parseFloat(process.env.NEWS_NEUTRAL_RATE || '0.25')));
const FIRST_NEWS_MIN_MS = 2 * 60 * 1000; // 首次事件最早 2 分钟
const FIRST_NEWS_MAX_MS = 8 * 60 * 1000; // 首次事件最晚 8 分钟
const LOCK_MIN_MS = 30 * 60 * 1000; // 封板最短 30 分钟
const LOCK_MAX_MS = 2 * 60 * 60 * 1000; // 封板最长 2 小时

// 交易规则（可由后台「游戏设置 → 模拟股市」覆盖，经 process.env 注入）
const LIMIT_PCT = parseFloat(process.env.MARKET_LIMIT_PCT || '0.10'); // 涨跌停 ±10%（相对昨收，T+1 股）
const T0_LIMIT_PCT = parseFloat(process.env.MARKET_T0_LIMIT_PCT || '0.03'); // T+0 涨跌停 ±3%（只能赚小钱）
// AI 全驱动：情绪/舆论/个股走势目标/新闻全由 AI 决定（关闭则用确定性随机模型）
const AI_DRIVEN = process.env.MARKET_AI_DRIVEN === 'true';
const AI_ECONOMY_MIN = Math.max(1, parseInt(process.env.MARKET_AI_ECONOMY_MIN || '3', 10)); // AI 每 N 分钟决策一次
const AI_TARGET_K = 0.04; // 每 tick 向 AI 目标收益率收敛的力度
const AI_TARGET_PERTURB = parseFloat(process.env.MARKET_AI_TARGET_PERTURB || '1.5'); // AI 目标价执行扰动（±百分点）：AI 给方向与大致幅度，实际目标加随机噪声，堵「精确预测终点」
// AI 子功能开关（仅 AI_DRIVEN=true 时生效）
const AI_PROFILES = process.env.MARKET_AI_PROFILES !== 'false';       // 公司名 + 主营人设
const AI_EARNINGS = process.env.MARKET_AI_EARNINGS !== 'false';       // 财报改写 eps/bvps
const AI_RECAP = process.env.MARKET_AI_RECAP !== 'false';             // 收盘复盘
const AI_DRAGON_TIGER = process.env.MARKET_AI_DRAGON_TIGER !== 'false'; // 龙虎榜
const AI_LOCK_DECISIONS = process.env.MARKET_AI_LOCK_DECISIONS !== 'false'; // 封板决策
const AI_PLAYER_FLOW = process.env.MARKET_AI_PLAYER_FLOW !== 'false';       // 感知玩家资金面
const AI_EARNINGS_HOURS = 6; // 财报每 N 小时发布一轮（一天约 4 轮）
const AI_EOD_GRACE_MS = 2 * 60 * 1000; // 收盘后 2 分钟触发复盘/龙虎榜，留出最后撮合时间
const BUY_FEE_RATE = parseFloat(process.env.MARKET_BUY_FEE_RATE || '0.001'); // 买入手续费 0.1%
const SELL_FEE_RATE = parseFloat(process.env.MARKET_SELL_FEE_RATE || '0.002'); // 卖出手续费 0.2%（含印花税）
const IMPACT_K = 10; // 买卖冲击系数（成交额 / 流通市值 放大为价格冲击）
const IMPACT_CAP = 0.02; // 单笔冲击封顶 ±2%
// 跌停退市：股价相对「上市价」累计跌幅达到 DELIST_PCT 即触发退市（持仓归零 + 补新股）。
// 引入真实退市风险，堵住「AI 明牌 + 虚拟做市商无限深度」下的无风险套利漏洞。
const DELIST_ENABLED = process.env.MARKET_DELIST_ENABLED !== 'false';
const DELIST_PCT = Math.max(0.1, Math.min(0.95, parseFloat(process.env.MARKET_DELIST_PCT || '0.70')));
// 虚拟做市商单笔接盘深度上限（美元，0=不限）：限价单每次撮合最多成交该额度，超出部分留挂单，
// 打破「虚拟做市无限深度」导致的零流动性约束；市价单（_marketFill）不受此限（市价=按现价立即成交）。
const MM_MAX_USD = Math.max(0, parseFloat(process.env.MARKET_MM_MAX_USD || '1000000'));
const MAX_TRADES = 100; // 成交流历史保留条数（内存，最新在前）
const MAX_MINUTE_BARS = 1200; // 1 分钟 K 线最多保留根数（约 5 个交易日）

// 交易时段（北京时间 Asia/Shanghai，无夏令时 = UTC+8）
const TICK_SIZE = 0.01; // 最小价位（元）

// 'HH:mm' -> 当日分钟数（如 '09:30' -> 570）；非法返回 null
function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return Number.isFinite(v) ? v : null;
}

// 交易时段 / 开关配置（后台「游戏设置 → 模拟股市」可覆盖，经 process.env 注入）
const TRADING = {
  // 交易时段总开关：false 则全天候连续交易（无集合竞价/开盘/收盘/午休/周末休市）
  sessionsEnabled: process.env.MARKET_SESSIONS_ENABLED !== 'false',
  // 委托开关：false 则按现价立即成交（市价单），无需等待撮合
  entrustEnabled: process.env.MARKET_ENTRUST_ENABLED !== 'false',
  // 卖出即时成交：true 则卖单不挂单冻结、按现价立即卖出（市价单），仅作用于卖出侧
  sellInstant: process.env.MARKET_SELL_INSTANT === 'true',
  // 挂单超时自动撤单：未成交委托超过 orderTtlMin 分钟自动撤单解冻（买退额度、卖解冻持仓）
  orderAutoCancel: process.env.MARKET_ORDER_AUTO_CANCEL !== 'false',
  orderTtlMin: Math.max(1, parseInt(process.env.MARKET_ORDER_TTL_MIN || '10', 10)),
  auctionEnabled: process.env.MARKET_AUCTION_ENABLED !== 'false',
  lunchEnabled: process.env.MARKET_LUNCH_ENABLED !== 'false',
  weekendClosed: process.env.MARKET_WEEKEND_CLOSED !== 'false',
  tPlusDays: Math.max(0, parseInt(process.env.MARKET_T_PLUS_DAYS || '1', 10)), // T+N：买入后第 N 天可卖
  // 「哪天算过一天」：每天该时刻起才算正式过了一天（分钟数，默认 00:00 -> 0）
  dayBoundaryMin: toMin(process.env.MARKET_DAY_BOUNDARY) ?? 0,
  auctionStart: toMin(process.env.MARKET_AUCTION_START) ?? 9 * 60 + 15,   // 9:15
  auctionEnd: toMin(process.env.MARKET_AUCTION_END) ?? 9 * 60 + 25,       // 9:25 定开盘价
  morningStart: toMin(process.env.MARKET_MORNING_START) ?? 9 * 60 + 30,   // 9:30
  morningEnd: toMin(process.env.MARKET_MORNING_END) ?? 11 * 60 + 30,      // 11:30
  afternoonStart: toMin(process.env.MARKET_AFTERNOON_START) ?? 13 * 60,   // 13:00
  afternoonEnd: toMin(process.env.MARKET_AFTERNOON_END) ?? 15 * 60,       // 15:00
};

// 新闻冲击模型：一条强度 mag 的新闻，期望最终产生约 mag 的方向性走势。
// 拆成「即时跳价」+「慢速趋势」两段，避免一击涨跌停 + 封板僵死，让走势可见。
// 即时跳价占比 NEWS_JUMP_RATIO；剩余部分通过 newsShock 趋势体现（配合 0.85 衰减，
// 趋势累积系数 ≈ 1/(1-0.85)=6.667，故 DRIFT_K = (1-JUMP)/6.667 使趋势累积恰为该占比）。
const NEWS_JUMP_RATIO = 0.55;
const NEWS_DRIFT_K = (1 - NEWS_JUMP_RATIO) / 6.667; // ≈0.0675

const SECTORS = ['科技', '能源', '医药', '消费'];
// 板块基准市盈率（估值锚）：新股初始 EPS 按其定价，使 PE 贴合板块，PE/PB 不再随意跳动。
const SECTOR_PE = { '科技': 35, '能源': 12, '医药': 40, '消费': 25 };
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
  constructor(file, reversalFile, metaFile) {
    this.file = file;
    this.reversalFile = reversalFile || path.join(path.dirname(file), 'reversals.json');
    this.metaFile = metaFile || path.join(path.dirname(file), 'marketMeta.json');
    this.meta = {}; // code -> { name, desc, eps, bvps, listingPrice, prevClose, price }（AI 人设/基本面/上市价持久化）
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
    this.lastUnlockDay = this._cnDateStr();
    this.lockedStocks = {}; // code -> { price, until, dir }
    this.reversals = []; // 待触发的后续新闻（持久化，方向独立随机）
    this.generatingNews = false;
    this.aiDriven = AI_DRIVEN;         // AI 全驱动开关
    this.aiTargets = {};               // code -> targetPct（AI 决定的目标涨跌幅 %，相对昨收）
    this.aiSentiment = { overall: 0, sectors: {} }; // AI 情绪/舆论
    this.aiNarrative = '';             // AI 盘面解读文案
    this.aiEconomyRunning = false;     // AI 决策进行中标记
    this.lastEconomyAt = 0;            // 上次 AI 决策时间戳
    this.aiProfilesDone = false;       // 公司人设是否已生成
    this.lastEarningsAt = 0;           // 上次财报时间戳
    this.aiRecapDoneDay = '';          // 当天是否已生成收盘复盘（按日期防重）
    this.dragonTiger = [];             // 龙虎榜列表（当日）
    this.recap = { narrative: '', at: 0 }; // 收盘复盘文案
    this.nextNewsAt = 0; // 下一条新闻的触发时间戳（log-uniform 间隔制，0=未排）
    this.phase = 'closed';       // 市场阶段：call_auction|morning|lunch|afternoon|closed
    this.auctionDone = false;    // 当日集合竞价是否已撮合
    this.orders = {};            // code -> { bids:[], asks:[] } 限价委托盘口（未成交）
    this.orderSeq = 0;           // 委托自增 id
    this.orderById = new Map();  // 委托 id -> order（快速撤单 / 查询）
    this.pendingCredits = [];    // 待入账额度（逐 tick 撮合的卖方回款 / 买方退款 / EOD 撤单退款）[{userId, quota}]
    this.quotaPerUnit = parseInt(process.env.QUOTA_PER_UNIT || '500000', 10);
    this.minuteBars = {};        // code -> 1 分钟 K 线数组 [{t,o,h,l,c,v}]（实时累积）
    this.lastMinute = {};        // code -> { day, min } 当前分钟戳（判断滚动）
    this._loadPortfolio();
    this._loadReversals();
    this._loadMeta();       // 加载持久化的人设/基本面/上市价（并恢复 aiProfilesDone，避免重启换脸）
    this._seed();
    this._applyMeta();      // 用持久化数据覆盖随机播种值（公司名/eps/bvps/上市价/昨收/现价）
    this._scheduleNews();
    this._scheduleAiEconomy(10 * 1000); // AI 全驱动：首次 10s 后决策
    this._scheduleAiProfiles(15 * 1000); // AI 公司人设：启动 15s 后生成
    this._tick();
    this._saveMeta(); // 启动即落盘一次当前快照，确保首次重启也能恢复（不再依赖等 AI/换日）
    setInterval(() => this._tick(), TICK_MS).unref();
  }

  // 北京时间当前时刻（服务器可能 UTC，固定 +8h；中国无夏令时）
  _cnNow() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return { day: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }

  // 北京日期字符串（YYYY-MM-DD，用于换日判断 / 集合竞价按日重置）
  _cnDateStr() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // T+N 结算日（YYYY-MM-DD）：当天时刻早于 dayBoundary 时仍算「前一天」，
  // 即每天 dayBoundary 时刻起才算正式过了一天（默认 00:00 则等同自然日）。
  _settlementDate() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    if (mins < TRADING.dayBoundaryMin) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // 当前市场阶段
  _phase() {
    if (!TRADING.sessionsEnabled) return 'morning'; // 关闭交易时段规则：全天候连续交易
    const t = this._cnNow();
    if (TRADING.weekendClosed && (t.day === 0 || t.day === 6)) return 'closed'; // 周末休市
    const mins = t.h * 60 + t.m;
    // 集合竞价 9:15~开盘（9:25 定开盘价，之后到开盘为揭示静默期，只挂单不撮合）
    if (TRADING.auctionEnabled && mins >= TRADING.auctionStart && mins < TRADING.morningStart) return 'call_auction';
    if (mins >= TRADING.morningStart && mins < TRADING.morningEnd) return 'morning';
    if (TRADING.lunchEnabled && mins >= TRADING.morningEnd && mins < TRADING.afternoonStart) return 'lunch';
    if (mins >= TRADING.afternoonStart && mins < TRADING.afternoonEnd) return 'afternoon';
    return 'closed';
  }

  // 是否连续竞价阶段（价格可动、可撮合成交）
  _isContinuous() { return this.phase === 'morning' || this.phase === 'afternoon'; }

  // 市场状态快照（供前端展示时段 / 判断是否可交易）
  status() {
    this.phase = this._phase(); // 实时计算，避免仅依赖 tick 的缓存值
    if (!TRADING.sessionsEnabled) {
      return { phase: 'morning', text: '连续交易中', continuous: true, auctionDone: true };
    }
    const t = this._cnNow();
    const weekend = TRADING.weekendClosed && (t.day === 0 || t.day === 6);
    const phaseText = {
      call_auction: '集合竞价', morning: '早盘交易中', lunch: '午间休市',
      afternoon: '午盘交易中', closed: weekend ? '周末休市' : '已收盘',
    };
    return { phase: this.phase, text: phaseText[this.phase] || this.phase, continuous: this._isContinuous(), auctionDone: this.auctionDone };
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

  // 排定「下一条」新闻触发时间（log-uniform 间隔制：时密时疏，不再固定节奏）。
  // 首次启动 2~8 分钟先来一条（避免冷启动等太久，也避免一启动就动荡）。
  _scheduleNews() {
    this.nextNewsAt = Date.now() + randInt(FIRST_NEWS_MIN_MS, FIRST_NEWS_MAX_MS);
  }

  // 每次新闻触发后，用 log-uniform 抽下一次间隔（minGap ~ maxGap，短间隔多、长间隔少）。
  _scheduleNextNews() {
    const u = Math.random();
    const gap = NEWS_MIN_GAP_MS * Math.pow(NEWS_MAX_GAP_MS / NEWS_MIN_GAP_MS, u);
    this.nextNewsAt = Date.now() + gap;
  }

  // AI 全驱动：调度下一次 AI 市场决策（间隔由 aiEconomyIntervalMin 决定，首轮可用短延迟）
  _scheduleAiEconomy(delayMs) {
    if (!this.aiDriven) return;
    let d;
    if (delayMs != null) d = delayMs; // 首轮用固定短延迟（10s）
    else d = AI_ECONOMY_MIN * 60 * 1000 * (0.6 + Math.random() * 0.8); // 后续间隔 ±抖动，不再死板每 N 分钟
    setTimeout(() => this._aiEconomy(), d).unref();
  }

  // 调用 AI 生成整体市场指令（情绪 + 舆论 + 个股走势目标 + 新闻），失败则保留现状继续随机游走。
  async _aiEconomy() {
    if (!this.aiDriven || this.aiEconomyRunning) return;
    this.aiEconomyRunning = true;
    try {
      if (!aiNews.ready()) return; // 无 AI 配置，静默保持随机模型
      const flow = AI_PLAYER_FLOW ? this._playerFlow() : null;
      const ctx = this.stocks.map((s) => {
        const f = flow ? flow[s.code] : null;
        const base = {
          code: s.code, name: s.name, sector: s.sector, price: s.price,
          prevClose: s.prevClose,
          changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0,
          t0: !!s.t0, limitPct: this._limitPct(s),
        };
        if (f) {
          base.inflow = f.inflow;
          base.holders = f.holders;
          base.concentration = f.concentration;
          base.heldShares = f.heldShares;
        }
        return base;
      });
      const eco = await aiNews.generateEconomy(ctx);
      if (eco) this._applyEconomy(eco);
    } catch (e) {
      /* AI 异常不影响市场运行 */
    } finally {
      this.aiEconomyRunning = false;
      this._scheduleAiEconomy();
    }
  }

  // 应用 AI 市场指令：更新情绪/舆论，写入个股走势目标（供逐 tick 收敛），并触发新闻冲击。
  _applyEconomy(eco) {
    this.lastEconomyAt = Date.now();
    // 1) 情绪 / 舆论
    if (eco.sentiment) {
      this.aiSentiment.overall = eco.sentiment.overall || 0;
      for (const k of Object.keys(eco.sentiment.sectors || {})) {
        this.aiSentiment.sectors[k] = eco.sentiment.sectors[k];
      }
      // 板块情绪直接向 AI 值靠拢（AI 驱动取代随机游走）
      for (const sec of SECTORS) {
        const v = eco.sentiment.sectors[sec];
        if (v != null) this.sectors[sec] = v;
      }
    }
    if (eco.narrative) this.aiNarrative = eco.narrative;
    // 2) 个股走势目标（相对昨收的目标涨跌幅 %）+ 封板决策
    const fresh = {};
    for (const t of (eco.stocks || [])) {
      const s = this.find(t.code);
      if (!s) continue;
      // 执行扰动：AI 只给方向与大致幅度，实际目标加随机噪声（±AI_TARGET_PERTURB 个百分点），
      // 并受该股涨跌停幅度封顶——玩家即便看到方向，也无法精确预测收敛终点，堵「明牌套利」。
      const lpPct = this._limitPct(s) * 100;
      const tp = clamp(t.targetPct + (Math.random() - 0.5) * 2 * AI_TARGET_PERTURB, -lpPct, lpPct);
      fresh[t.code] = round2(tp);
      // AI 封板决策：显式封涨停/跌停（仅 AI_LOCK_DECISIONS 开启时生效）
      if (AI_LOCK_DECISIONS && t.lock && (t.lock === 'up' || t.lock === 'down')) {
        const { up, down } = this._limits(s);
        const px = t.lock === 'up' ? up : down;
        this.lockedStocks[s.code] = { price: px, until: Date.now() + randInt(LOCK_MIN_MS, LOCK_MAX_MS), dir: t.lock };
        s.price = px;
      }
    }
    this.aiTargets = fresh;
    for (const s of this.stocks) s.aiTargetPct = this.aiTargets[s.code] != null ? this.aiTargets[s.code] : null;
    // 3) 新闻：沿用既有新闻冲击管线（即时跳价 + 慢速趋势 + 板块联动 + 后续反转）
    for (const ev of (eco.news || [])) this._applyEvent(ev);
    if (this.handlers.onSentiment) this.handlers.onSentiment(this.sentiment());
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  // 情绪/舆论快照（供前端展示 + WS 广播）。
  // 注意：AI 的「盘面解读 narrative」不再实时对外（那是 AI 的底牌，实时给=告知玩家未来走向），
  // 仅保留整体情绪值 + 板块情绪，供玩家感知大方向；详细解读留到收盘复盘（recap）再给。
  sentiment() {
    return {
      aiDriven: this.aiDriven,
      overall: this.aiSentiment.overall || 0,
      sectors: this.aiSentiment.sectors || {},
      at: this.lastEconomyAt || 0,
    };
  }

  // 新闻对外脱敏：隐藏 magnitude（冲击强度）与 followup（后续反转）——这些是 AI 的「底牌」，
  // 暴露给玩家等于告知未来涨跌幅度与反转时机，构成无风险套利。对外只留方向 + 客观文案。
  _publicNews(n) {
    return {
      id: n.id, time: n.time, expireAt: n.expireAt,
      code: n.code, name: n.name, sector: n.sector,
      text: n.text, detail: n.detail, direction: n.direction, delist: n.delist,
    };
  }

  // 玩家资金面快照：每只股票的净流入 / 持仓人数 / 最大持仓集中度 / 玩家总持仓股数。
  // 供 AI 感知「谁在买、谁在卖、筹码是否集中」，据此生成游资进出类新闻与走势。
  _playerFlow() {
    const holders = {};    // code -> 持仓人数
    const heldShares = {}; // code -> 玩家总持仓股数
    const maxHeld = {};    // code -> 最大单一持仓股数
    for (const uid in this.portfolio) {
      const p = this.portfolio[uid];
      for (const code in p) {
        if (code === '_name') continue;
        const sh = p[code] && p[code].shares || 0;
        if (!(sh > 0)) continue;
        holders[code] = (holders[code] || 0) + 1;
        heldShares[code] = (heldShares[code] || 0) + sh;
        if (sh > (maxHeld[code] || 0)) maxHeld[code] = sh;
      }
    }
    const flow = {};
    for (const s of this.stocks) {
      const hc = holders[s.code] || 0;
      const hs = heldShares[s.code] || 0;
      const mh = maxHeld[s.code] || 0;
      flow[s.code] = {
        inflow: round2(s.inflow || 0),   // 净流入（元，主动买-主动卖累计）
        holders: hc,                      // 持仓人数
        heldShares: round4(hs),           // 玩家总持仓股数
        concentration: hs > 0 ? round2(mh / hs) : 0, // 最大单一持仓占玩家总持仓比例 0~1
      };
    }
    return flow;
  }

  // ---- AI 公司人设：启动后生成一次，替换随机公司名并附主营业务 ----
  _scheduleAiProfiles(delayMs) {
    if (!this.aiDriven || !AI_PROFILES) return;
    setTimeout(() => this._aiProfiles(), delayMs != null ? delayMs : 15 * 1000).unref();
  }

  async _aiProfiles() {
    if (!this.aiDriven || !AI_PROFILES || this.aiProfilesDone) return;
    try {
      if (!aiNews.ready()) return;
      const ctx = this.stocks.map((s) => ({ code: s.code, sector: s.sector, price: s.price }));
      const p = await aiNews.generateProfiles(ctx);
      if (p && p.stocks) {
        const byCode = new Map(p.stocks.map((x) => [x.code, x]));
        for (const s of this.stocks) {
          const it = byCode.get(s.code);
          if (it) {
            s.name = it.name;
            s.desc = it.desc || '';
          }
        }
        this.aiProfilesDone = true;
        this._saveMeta(); // 持久化公司名/主营，重启不换脸
        if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
      }
    } catch (e) {
      /* AI 人设失败：保留随机名，不影响市场 */
    }
  }

  // ---- AI 财报：定期改写 eps/bvps，让 PE/PB 随业绩变化 ----
  _scheduleEarnings(delayMs) {
    if (!this.aiDriven || !AI_EARNINGS) return;
    setTimeout(() => this._aiEarnings(), delayMs != null ? delayMs : AI_EARNINGS_HOURS * 3600 * 1000).unref();
  }

  async _aiEarnings() {
    if (!this.aiDriven || !AI_EARNINGS) return;
    try {
      if (!aiNews.ready()) return;
      const ctx = this.stocks.map((s) => ({ code: s.code, name: s.name, sector: s.sector, price: s.price, eps: s.eps, bvps: s.bvps }));
      const er = await aiNews.generateEarnings(ctx);
      if (er && er.reports) {
        for (const r of er.reports) {
          const s = this.find(r.code);
          if (!s) continue;
          // 财报连贯性：业绩不随意断崖跳变——EPS 单期变动限制在 0.4x~2.5x，净资产(每股)限制在 0.7x~1.4x，
          // 让 PE/PB 随业绩「渐进」变动，而非每次财报都跳到一个随机值。
          s.eps = round4(clamp(r.eps, (s.eps || 1) * 0.4, (s.eps || 1) * 2.5));
          s.bvps = round2(clamp(r.bvps, (s.bvps || 1) * 0.7, (s.bvps || 1) * 1.4));
          // 财报配一条新闻，走既有冲击管线（即时跳价 + 慢速趋势 + 板块联动）
          this._applyEvent({
            code: r.code, headline: r.headline, detail: r.detail,
            direction: r.direction, magnitude: 0.06, sector: s.sector,
          });
        }
        this.lastEarningsAt = Date.now();
        this._saveMeta(); // 财报改写 eps/bvps 后持久化，重启不丢基本面
        if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
      }
    } catch (e) {
      /* AI 财报失败不影响市场 */
    } finally {
      this._scheduleEarnings();
    }
  }

  // ---- AI 收盘复盘：收盘后生成一次当日总结 ----
  async _aiRecap() {
    if (!this.aiDriven || !AI_RECAP || this.aiRecapDoneDay === this._cnDateStr()) return;
    try {
      if (!aiNews.ready()) return;
      const snap = {
        index: this.index, indexChangePct: this.indexChangePct,
        breadth: { up: this.stocks.filter((s) => s.price > s.prevClose).length, down: this.stocks.filter((s) => s.price < s.prevClose).length, flat: this.stocks.filter((s) => s.price === s.prevClose).length },
        stocks: this.stocks.map((s) => ({ name: s.name, changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0, lock: (this.lockedStocks[s.code] && this.lockedStocks[s.code].dir) || null })),
        sectors: this.sectorRank(),
      };
      const rc = await aiNews.generateRecap(snap);
      if (rc && rc.narrative) {
        this.recap = { narrative: rc.narrative, at: Date.now() };
        this.aiRecapDoneDay = this._cnDateStr();
        if (this.handlers.onRecap) this.handlers.onRecap(this.recap);
      }
    } catch (e) {
      /* AI 复盘失败不影响市场 */
    }
  }

  // ---- AI 龙虎榜：收盘后标注大资金进出 ----
  async _aiDragonTiger() {
    if (!this.aiDriven || !AI_DRAGON_TIGER) return;
    try {
      if (!aiNews.ready()) return;
      const flow = AI_PLAYER_FLOW ? this._playerFlow() : null;
      const ctx = this.stocks.map((s) => {
        const f = flow ? flow[s.code] : null;
        const o = { code: s.code, name: s.name, sector: s.sector };
        if (f) { o.inflow = f.inflow; o.holders = f.holders; o.concentration = f.concentration; }
        return o;
      });
      const dt = await aiNews.generateDragonTiger(ctx);
      if (dt && dt.list) {
        // 绑定股票名 + 方向 + 金额
        const rows = dt.list.map((r) => {
          const s = this.find(r.code);
          return {
            code: r.code, name: s ? s.name : r.code, sector: s ? s.sector : '',
            direction: r.direction, amount: r.amount, reason: r.reason || '',
          };
        });
        this.dragonTiger = rows;
        if (this.handlers.onDragonTiger) this.handlers.onDragonTiger(rows);
      }
    } catch (e) {
      /* AI 龙虎榜失败不影响市场 */
    }
  }

  // 收盘后触发复盘 + 龙虎榜（每天一次，收盘 2 分钟后执行）
  _maybeAiEod() {
    if (!this.aiDriven) return;
    const t = this._cnNow();
    if (TRADING.weekendClosed && (t.day === 0 || t.day === 6)) return;
    const mins = t.h * 60 + t.m + t.s / 60;
    const closeAt = TRADING.sessionsEnabled ? TRADING.afternoonEnd : 24 * 60; // 全天候模式：23:59 视为"收盘"
    if (mins >= closeAt + AI_EOD_GRACE_MS / 60000) {
      this._aiRecap();
      this._aiDragonTiger();
    }
  }

  _seed() {
    if (this.stocks.length) return;
    for (let i = 0; i < STOCK_COUNT; i++) {
      const code = 'SIM' + String(i + 1).padStart(2, '0');
      const s = this._makeStock(code, i);
      this.stocks.push(s);
      this.minuteBars[code] = this._genMinuteBars(s.price);
      this.lastMinute[code] = null;
    }
    for (const sec of SECTORS) this.sectors[sec] = 0;
    this._snapshotIndex();
  }

  // 生成一只随机股票（供初始播种与退市补新股共用）。name 与当前在售股票不重名。
  _makeStock(code, i) {
    const taken = new Set(this.stocks.map((s) => s.name));
    let name;
    do {
      name = PREFIX[Math.floor(Math.random() * PREFIX.length)] +
             SUFFIX[Math.floor(Math.random() * SUFFIX.length)];
    } while (taken.has(name));
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
    // 估值锚定：初始 EPS 按板块基准市盈率定价（PE ≈ 板块基准 ±~35%），每股净资产按合理市净率（PB≈1.5~5），
    // 避免 PE/PB 完全随机乱跳，给玩家一个可参考的基本面基准。
    const basePe = SECTOR_PE[sector] || 20;
    const eps = round4(Math.max(0.01, price / basePe * (0.75 + Math.random() * 0.7)));
    const bvps = round2(Math.max(0.5, price / (1.5 + Math.random() * 3.5)));
    const floatShares = Math.max(1, Math.round(circulation / price)); // 流通股本（股）
    const totalShares = Math.round(floatShares * (1.1 + Math.random() * 0.8)); // 总股本
    return {
      code, name, sector, prevClose, open, high, low, price, prev: prevClose,
      history, kline, volume, amount, circulation,
      eps, bvps, floatShares, totalShares,
      desc: '',          // 主营业务（AI 人设生成后填充）
      inflow: 0,       // 主力净流入（元，主动买-主动卖累计）
      momentum: 0, newsShock: 0,
      listingPrice: prevClose, // 上市价（退市跌幅基准）
      t0: i % T0_EVERY === 0, // T+0：当天买入当天可卖；否则 T+1
    };
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

  // 合成近 2 个交易日的 1 分钟 K 线（随机游走，终点对齐现价），供多周期 K 线有历史深度
  _genMinuteBars(price) {
    const N = 480; // 2 个交易日
    const bars = [];
    let p = round2(price * (1 - (Math.random() - 0.5) * 0.1));
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      const o = p;
      const c = round2(Math.max(0.01, o * (1 + (Math.random() - 0.5) * 0.004)));
      const h = round2(Math.max(o, c) * (1 + Math.random() * 0.002));
      const l = round2(Math.min(o, c) * (1 - Math.random() * 0.002));
      const v = Math.round(500 + Math.random() * 5000);
      bars.push({ t: now - (N - i) * 60000, o, h, l, c, v });
      p = c;
    }
    const last = bars[bars.length - 1];
    last.c = price; if (price > last.h) last.h = price; if (price < last.l) last.l = price;
    return bars;
  }

  // 每日收盘：昨收重新锚定（涨跌停基准）、日K 追加、T+1 解锁
  _maybeNewDay() {
    const day = this._cnDateStr();
    if (day === this.lastUnlockDay) return;
    this.lastUnlockDay = day;
    for (const s of this.stocks) {
      s.prevClose = s.price;
      s.open = s.price;
      s.high = s.price;
      s.low = s.price;
      s.prev = s.price;
      s.momentum = 0;
      s.aiTargetPct = null;
      s.history = [s.price];
      const k = { o: s.price, h: s.price, l: s.price, c: s.price, v: Math.round(50000 + Math.random() * 200000) };
      s.kline.push(k);
      if (s.kline.length > KLINE_DAYS) s.kline.shift();
    }
    for (const uid in this.portfolio) {
      const p = this.portfolio[uid];
      for (const code in p) {
        if (code === '_name') continue;
        const h = p[code];
        if (h.locked) h.locked = 0; // 旧格式锁定：换日清零
        if (h.frozen) h.frozen = 0; // 挂单冻结随撤单一起解冻
        // T+N 分桶：清理已到解锁日的桶（按结算日判断，避免 dayBoundary 未到就提前解锁）
        if (h.lockBuckets) {
          const settle = this._settlementDate();
          for (const d of Object.keys(h.lockBuckets)) {
            if (this._unlockable(d, settle)) delete h.lockBuckets[d];
          }
          if (!Object.keys(h.lockBuckets).length) delete h.lockBuckets;
        }
      }
    }
    this.lockedStocks = {}; // 换日解封所有涨跌停封板
    this.aiTargets = {}; // 换日清空 AI 走势目标，等待下一轮 AI 决策
    this.dragonTiger = []; // 换日清空龙虎榜
    this.recap = { narrative: '', at: 0 }; // 换日清空收盘复盘
    this.aiRecapDoneDay = ''; // 换日重置复盘标记
    this._scheduleEarnings(10 * 1000); // 新交易日：AI 财报首轮 10s 后（之后每 6h 一轮）
    this.auctionDone = false; // 新交易日：集合竞价待撮合
    if (TRADING.sessionsEnabled) this._cancelAllOpenEOD(); // 收盘：撤掉所有未成交委托（全天候交易模式下不撤单）
    this._scheduleNextNews(); // 换日：按间隔制排下一条新闻（而非强制 2~8 分钟）
    this._savePortfolio();
    this._saveMeta(); // 每日快照昨收/现价，重启后从最近一个交易日恢复，避免价格大漂移
  }

  // 该股票涨跌停幅度：T+0 用更小的 T0_LIMIT_PCT（只能赚小钱），T+1 用 LIMIT_PCT（赚大钱）
  _limitPct(s) {
    return s && s.t0 ? T0_LIMIT_PCT : LIMIT_PCT;
  }

  _limits(s) {
    const lp = this._limitPct(s);
    return { down: round2(s.prevClose * (1 - lp)), up: round2(s.prevClose * (1 + lp)) };
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
    // 中性新闻：约 NEWS_NEUTRAL_RATE 概率市场不反应（只发文字、不跳价不趋势），打破「新闻必然动荡」
    const mag = (Math.random() < NEWS_NEUTRAL_RATE) ? 0 : (ev.magnitude || 0.05);
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
    if (this.handlers.onNews) this.handlers.onNews(this._publicNews(item));
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
    if (this.handlers.onNews) this.handlers.onNews(this._publicNews(item));
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
    // 中性新闻概率 + 冲击幅度随机化：约 25% 不推股价，其余 3%~8% 随机强度
    const mag = (Math.random() < NEWS_NEUTRAL_RATE) ? 0 : (0.03 + Math.random() * 0.05);
    this._applyShock(s, sign, mag, false);
    const item = {
      id: ++this.newsSeq, time: Date.now(), expireAt: Date.now() + NEWS_TTL_HOURS * 3600 * 1000,
      code: s.code, name: s.name, sector: s.sector,
      text, detail: text, direction: good ? 'good' : 'bad', magnitude: mag, followup: false,
    };
    this.news.unshift(item);
    if (this.news.length > 50) this.news.pop();
    if (this.handlers.onNews) this.handlers.onNews(this._publicNews(item));
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

  // 加载 AI 人设/基本面/上市价持久化数据（code -> {...}），并恢复 aiProfilesDone 标记。
  _loadMeta() {
    try {
      if (fs.existsSync(this.metaFile)) {
        const j = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
        this.meta = (j && j.stocks && typeof j.stocks === 'object') ? j.stocks : {};
        if (j && j.aiProfilesDone) this.aiProfilesDone = true;
      }
    } catch (e) {
      this.meta = {};
    }
  }

  // 用持久化数据覆盖随机播种值：公司名/主营/eps/bvps/上市价/昨收/现价，实现「重启不换脸、价格不漂移」。
  _applyMeta() {
    for (const s of this.stocks) {
      const mm = this.meta[s.code];
      if (!mm) continue;
      if (typeof mm.name === 'string' && mm.name) s.name = mm.name;
      if (typeof mm.desc === 'string') s.desc = mm.desc;
      if (typeof mm.eps === 'number' && mm.eps > 0) s.eps = mm.eps;
      if (typeof mm.bvps === 'number' && mm.bvps > 0) s.bvps = mm.bvps;
      if (typeof mm.listingPrice === 'number' && mm.listingPrice > 0) s.listingPrice = mm.listingPrice;
      if (typeof mm.prevClose === 'number' && mm.prevClose > 0) s.prevClose = mm.prevClose;
      if (typeof mm.price === 'number' && mm.price > 0) {
        s.price = mm.price;
        s.open = s.price; s.high = s.price; s.low = s.price; s.prev = s.price;
        // 用「昨收→现价」生成当天模拟分时（90 点），避免收盘后重启时分时图只剩 1 个点而空白
        s.history = this._genIntraday(s.prevClose, s.price);
        s.kline = this._genKline(s.prevClose, s.price, s.price, s.price, s.price);
        this.minuteBars[s.code] = this._genMinuteBars(s.price);
        this.lastMinute[s.code] = null;
      }
    }
  }

  // 持久化人设/基本面/上市价/昨收/现价 + aiProfilesDone 标记。
  _saveMeta() {
    try {
      const stocks = {};
      for (const s of this.stocks) {
        stocks[s.code] = {
          name: s.name, desc: s.desc || '', eps: s.eps, bvps: s.bvps,
          listingPrice: s.listingPrice, prevClose: s.prevClose, price: s.price,
        };
      }
      fs.mkdirSync(path.dirname(this.metaFile), { recursive: true });
      fs.writeFileSync(this.metaFile, JSON.stringify({ aiProfilesDone: !!this.aiProfilesDone, stocks }, null, 2));
    } catch (e) { /* ignore */ }
  }

  _saveReversals() {
    try {
      fs.mkdirSync(path.dirname(this.reversalFile), { recursive: true });
      fs.writeFileSync(this.reversalFile, JSON.stringify(this.reversals, null, 2));
    } catch (e) { /* ignore */ }
  }

  // 集合竞价开盘价：最大成交量原则。
  // ob = { bids:[{price,qty}...], asks:[{price,qty}...] }（限价委托，qty 为股数）
  _auctionPrice(ob, s) {
    const prevClose = s.prevClose;
    const bids = (ob.bids || []).slice().sort((a, b) => b.price - a.price); // 买价降序
    const asks = (ob.asks || []).slice().sort((a, b) => a.price - b.price); // 卖价升序
    if (!bids.length && !asks.length) return prevClose; // 无竞价委托 → 平开（昨收）
    const lp = this._limitPct(s);
    const up = round2(prevClose * (1 + lp));
    const down = round2(prevClose * (1 - lp));
    const clampP = (p) => round2(clamp(p, down, up));
    // 候选价：所有委托价 + 昨收（均按 tick 取整、限涨跌停区间）
    const cand = new Set([prevClose]);
    for (const b of bids) cand.add(clampP(b.price));
    for (const a of asks) cand.add(clampP(a.price));
    let best = null;
    for (const p of cand) {
      let cumBuy = 0, cumSell = 0;
      for (const b of bids) if (b.price >= p) cumBuy += b.qty;
      for (const a of asks) if (a.price <= p) cumSell += a.qty;
      const vol = Math.min(cumBuy, cumSell);   // 该价位可成交总量
      const imb = Math.abs(cumBuy - cumSell);  // 剩余不平衡量（越小越好）
      if (!best || vol > best.vol ||
          (vol === best.vol && imb < best.imb) ||
          (vol === best.vol && imb === best.imb && Math.abs(p - prevClose) < Math.abs(best.p - prevClose))) {
        best = { p, vol, imb };
      }
    }
    return best ? round2(best.p) : prevClose;
  }

  // 集合竞价撮合：9:25 首次进入时按最大成交量定开盘价，复位当日 OHLC 与分时。
  // 成交明细与仓位/额度结算由限价委托撮合（placeOrder / _matchOrders）统一处理。
  _runCallAuction() {
    this.auctionDone = true;
    for (const s of this.stocks) {
      const ob = this.orders[s.code] || { bids: [], asks: [] };
      const open = this._auctionPrice(ob, s);
      s.open = round2(open);
      s.price = s.open;
      s.high = s.open;
      s.low = s.open;
      s.history = [s.open];
      const k = s.kline[s.kline.length - 1];
      if (k) { k.o = s.open; k.c = s.open; if (s.open > k.h) k.h = s.open; if (s.open < k.l) k.l = s.open; }
    }
    this._snapshotIndex();
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  _tick() {
    this._maybeNewDay();
    this.phase = this._phase();

    // 集合竞价（9:15~9:30）：9:25 首次进入定开盘价，其余时间价格冻结、只挂单不撮合
    if (this.phase === 'call_auction') {
      const t = this._cnNow();
      if (!this.auctionDone && (t.h * 60 + t.m) >= TRADING.auctionEnd) this._runCallAuction();
      return;
    }

    // 午休 / 收盘：行情冻结，不触发新闻、不产生新成交
    if (!this._isContinuous()) return;

    // 服务中途启动 / 直接进入连续竞价：集合竞价已错过，开盘价沿用现有 open
    if (!this.auctionDone) this.auctionDone = true;

    // 到点触发一条新闻（log-uniform 间隔制：先排下一次再触发）
    if (this.nextNewsAt && Date.now() >= this.nextNewsAt) {
      this._scheduleNextNews();
      this._fireNews();
    }
    this._checkReversals();
    this._pruneNews();
    this._maybeAiEod(); // AI 收盘复盘 + 龙虎榜（每天收盘后一次）
    // 板块情绪：AI 全驱动下向 AI 目标情绪靠拢；否则随机游走 + 均值回归到 0
    for (const sec of SECTORS) {
      const cur = this.sectors[sec] || 0;
      if (this.aiDriven) {
        const target = this.aiSentiment.sectors[sec];
        const tv = target != null ? target : 0;
        this.sectors[sec] = clamp(cur + (tv - cur) * 0.05 + (Math.random() - 0.5) * 0.01, -1, 1);
      } else {
        this.sectors[sec] = clamp(cur + (Math.random() - 0.5) * 0.03 - cur * 0.02, -1, 1);
      }
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
          this._pushMinute(s);
          continue;
        }
      }
      const noise = (Math.random() - 0.5) * 0.002; // 个股噪声 ±0.1%
      const sectorDrift = (this.sectors[s.sector] || 0) * 0.0006; // 板块情绪
      const momentum = s.momentum * 0.3; // 动量延续
      const dev = s.prevClose > 0 ? (s.price - s.prevClose) / s.prevClose : 0;
      let meanRev = -dev * 0.002; // 均值回归拉力
      let aiDrift = 0;
      if (s.aiTargetPct != null) {
        // AI 全驱动：向 AI 指定的目标涨跌幅收敛（取代均值回归到 0）
        aiDrift = (s.aiTargetPct / 100 - dev) * AI_TARGET_K;
        meanRev = 0;
      }
      const shock = s.newsShock || 0; // 消息冲击
      const change = noise + sectorDrift + momentum + meanRev + shock + aiDrift;
      let newPrice = round2(Math.max(0.01, s.price * (1 + change)));
      // 涨跌停约束（相对昨收，基准价先 round2 避免浮点尾数；T+0 用更小幅度）
      const lp = this._limitPct(s);
      const limitDown = round2(s.prevClose * (1 - lp));
      const limitUp = round2(s.prevClose * (1 + lp));
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
      this._pushMinute(s);
    }
    // 撮合盘口内已交叉的挂单，以及价格到位触及虚拟做市商的挂单
    const tickEffects = this._matchBook();
    if (tickEffects.length) this.pendingCredits.push(...tickEffects);
    this._cancelExpiredOrders(); // 挂单超时自动撤单（买退额度、卖解冻持仓）
    this._checkDelist(); // 跌停退市：累计跌幅达阈值即退市 + 补新股 + 持仓归零
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
    // 挂单盘口（orders / orderById）是纯内存态，服务重启后必然没有任何未成交挂单；
    // 但「卖出挂单冻结」frozen 会随 portfolio.json 持久化残留，形成「僵尸冻结」——
    // 持仓明明无单可撤，可卖却被扣成 0。因此启动加载时统一清空 frozen（对应挂单已随重启消失）。
    // 注意：只清 frozen，不清 lockBuckets（T+N 锁定是持久化的正确行为）与旧 locked（_maybeNewDay 换日清）。
    for (const uid in this.portfolio) {
      const p = this.portfolio[uid];
      if (!p || typeof p !== 'object') continue;
      for (const code in p) {
        if (code === '_name') continue;
        const h = p[code];
        if (h && h.frozen) h.frozen = 0;
      }
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
      desc: s.desc || '',
      prevClose: s.prevClose, open: s.open, high: s.high, low: s.low,
      change: round2(s.price - s.prevClose),
      changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0,
      limitUp: round2(s.prevClose * (1 + this._limitPct(s))), limitDown: round2(s.prevClose * (1 - this._limitPct(s))),
      volume: s.volume, amount: s.amount, circulation: s.circulation,
      eps: s.eps, bvps: s.bvps,
      pe: s.eps > 0 ? round2(s.price / s.eps) : null,
      pb: s.bvps > 0 ? round2(s.price / s.bvps) : null,
      sectorPe: SECTOR_PE[s.sector] || null,
      totalShares: s.totalShares, floatShares: s.floatShares,
      totalCap: round2(s.price * (s.totalShares || 0)),
      turnoverRate: s.floatShares > 0 ? round2(s.volume * 100 / s.floatShares * 100) : 0,
      inflow: round2(s.inflow || 0),
      lock: (this.lockedStocks[s.code] && this.lockedStocks[s.code].dir) || null,
      t0: !!s.t0,
      listingPrice: round2(s.listingPrice || s.prevClose),
      fromListPct: (s.listingPrice > 0) ? round2((s.price - s.listingPrice) / s.listingPrice * 100) : 0,
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
      news: this.news.filter((n) => !n.expireAt || n.expireAt > Date.now()).slice(0, 20).map((n) => this._publicNews(n)),
      newsTtlHours: NEWS_TTL_HOURS,
      status: this.status(),
      sentiment: this.sentiment(),
      dragonTiger: this.dragonTiger,
      recap: this.recap,
      sectorRank: this.sectorRank(),
    };
  }

  find(code) {
    return this.stocks.find((s) => s.code === code);
  }

  // 板块排行：按板块内成分股平均涨跌幅降序
  sectorRank() {
    const rows = [];
    for (const sec of SECTORS) {
      const members = this.stocks.filter((s) => s.sector === sec);
      if (!members.length) continue;
      const avgChg = members.reduce((a, s) => a + (s.prevClose > 0 ? (s.price - s.prevClose) / s.prevClose : 0), 0) / members.length;
      const inflow = members.reduce((a, s) => a + (s.inflow || 0), 0);
      const up = members.filter((s) => s.price > s.prevClose).length;
      rows.push({ sector: sec, changePct: round2(avgChg * 100), inflow: round2(inflow), stocks: members.length, up, down: members.length - up });
    }
    rows.sort((a, b) => b.changePct - a.changePct);
    return rows;
  }

  detail(code) {
    const s = this.find(code);
    return s ? this._public(s) : null;
  }

  // 当前现价（供 server 侧市价单冻结额度用）
  currentPrice(code) {
    const s = this.find(code);
    return s ? s.price : null;
  }

  // 逐 tick 累积 1 分钟 K 线（连续竞价时段调用；分钟滚动时开新根）
  _pushMinute(s) {
    if (!s) return;
    const t = this._cnNow();
    const min = t.h * 60 + t.m;
    const day = this._cnDateStr();
    const last = this.lastMinute[s.code];
    const bars = this.minuteBars[s.code] || (this.minuteBars[s.code] = []);
    if (last && last.day === day && last.min === min && bars.length) {
      const bar = bars[bars.length - 1];
      bar.c = s.price;
      if (s.price > bar.h) bar.h = s.price;
      if (s.price < bar.l) bar.l = s.price;
      bar.v = Math.round((bar.v || 0) + Math.random() * 3000);
    } else {
      this.lastMinute[s.code] = { day, min };
      bars.push({ t: Date.now(), o: s.price, h: s.price, l: s.price, c: s.price, v: Math.round(500 + Math.random() * 3000) });
      if (bars.length > MAX_MINUTE_BARS) bars.shift();
    }
  }

  // K 线聚合：每 n 根合成一根（分钟周期用 n=5/15/30/60，周/月用日线 n=5/20）
  _aggregate(bars, n) {
    const out = [];
    for (let i = 0; i < bars.length; i += n) {
      const chunk = bars.slice(i, i + n);
      if (!chunk.length) break;
      const o = chunk[0].o, c = chunk[chunk.length - 1].c;
      const h = Math.max.apply(null, chunk.map((b) => b.h));
      const l = Math.min.apply(null, chunk.map((b) => b.l));
      const v = chunk.reduce((a, b) => a + (b.v || 0), 0);
      out.push({ t: chunk[0].t, o, h, l, c, v });
    }
    return out;
  }

  // 多周期 K 线：1m/5m/15m/30m/60m/day/week/month
  klinePeriod(code, period) {
    const s = this.find(code);
    if (!s) return [];
    if (!period || period === 'day') return s.kline;
    if (period === 'week') return this._aggregate(s.kline, 5);
    if (period === 'month') return this._aggregate(s.kline, 20);
    const step = parseInt(period, 10) || 1;
    return this._aggregate(this.minuteBars[code] || [], step);
  }

  // 实时推送精简行情（不含 history/kline）
  quote() {
    const ticks = this.stocks.map((s) => ({
      code: s.code, name: s.name, desc: s.desc || '', price: s.price, sector: s.sector,
      eps: s.eps, bvps: s.bvps,
      change: round2(s.price - s.prevClose),
      changePct: s.prevClose > 0 ? round2((s.price - s.prevClose) / s.prevClose * 100) : 0,
      high: s.high, low: s.low, volume: s.volume, amount: s.amount,
      lock: (this.lockedStocks[s.code] && this.lockedStocks[s.code].dir) || null,
      fromListPct: (s.listingPrice > 0) ? round2((s.price - s.listingPrice) / s.listingPrice * 100) : 0,
    }));
    const up = this.stocks.filter((s) => s.price > s.prevClose).length;
    const down = this.stocks.filter((s) => s.price < s.prevClose).length;
    const flat = STOCK_COUNT - up - down;
    return { index: { value: this.index, changePct: this.indexChangePct }, breadth: { up, down, flat }, ticks, status: this.status() };
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
      const locked = this._lockedShares(h);
      const frozen = h.frozen || 0;
      const costUsd = h.costUsd || 0;
      const marketValue = round2(shares * s.price);
      rows.push({
        code, name: s.name, shares: round4(shares), price: s.price,
        locked: round4(locked), frozen: round4(frozen), available: round4(Math.max(0, shares - locked - frozen)),
        costUsd: round2(costUsd), marketValue, pnl: round2(marketValue - costUsd),
        pnlPct: costUsd > 0 ? round2((marketValue - costUsd) / costUsd * 100) : 0,
        t0: !!s.t0,
      });
    }
    return rows;
  }

  // 美元 -> 额度（quota），供结算对账
  _toQuota(usd) { return Math.round((usd || 0) * this.quotaPerUnit); }

  // 判断买入日期 buyDate 在 today 是否已可卖（T+N：today - buyDate >= tPlusDays）
  _unlockable(buyDate, today) {
    if (TRADING.tPlusDays <= 0) return true; // T+0：当日可卖
    const b = new Date(buyDate + 'T00:00:00Z');
    const t = new Date(today + 'T00:00:00Z');
    if (Number.isNaN(b) || Number.isNaN(t)) return false;
    return Math.round((t - b) / 86400000) >= TRADING.tPlusDays;
  }

  // 该持仓当前「未解锁」的总锁定股数（T+N 分桶 + 兼容旧 locked 字段）
  _lockedShares(h) {
    let locked = h.locked || 0; // 旧格式：整数字段
    const buckets = h.lockBuckets;
    if (buckets) {
      const today = this._settlementDate();
      for (const d in buckets) {
        if (!this._unlockable(d, today)) locked += buckets[d];
      }
    }
    return round4(locked);
  }

  // 限价委托：买/卖统一挂单，连续竞价即时撮合（价格优先、时间优先），集合竞价只挂单待 9:25 统一撮合。
  // 买：冻结额度（server 侧先 debit，frozenQuota 传入）；卖：冻结可卖持仓（h.frozen）。
  // 返回 { ok, orderId, filled, avgPx, status, effects:[{userId,quota}] } —— effects 为本次撮合产生的卖方净回款与买方价差退款。
  placeOrder(userId, code, sideArg, priceArg, qtyArg, username, frozenQuota) {
    this.phase = this._phase();
    const s = this.find(code);
    if (!s) return { error: '股票不存在' };
    const inAuction = this.phase === 'call_auction';
    if (!this._isContinuous() && !inAuction) {
      return { error: '当前为' + this.status().text + '，仅连续竞价（9:30-11:30 / 13:00-15:00）与集合竞价（9:15-9:25）时段可挂单' };
    }
    const uid = String(userId);
    const side = sideArg === 'sell' ? 'sell' : 'buy';
    const qty = round4(parseFloat(qtyArg));
    if (!(qty > 0)) return { error: '委托数量无效' };
    const instant = !TRADING.entrustEnabled || (side === 'sell' && TRADING.sellInstant); // 委托开关关闭 或 卖出即时开关 → 市价单
    let price = round2(parseFloat(priceArg));
    if (!instant) {
      if (!(price > 0)) return { error: '委托价格无效' };
      const lp = this._limitPct(s);
      const limitUp = round2(s.prevClose * (1 + lp));
      const limitDown = round2(s.prevClose * (1 - lp));
      if (price > limitUp || price < limitDown) return { error: `委托价需在涨跌停区间 ${limitDown.toFixed(2)}~${limitUp.toFixed(2)} 内` };
    } else {
      price = s.price; // 市价单：按现价成交
    }

    if (side === 'buy') {
      const notional = round2(price * qty);
      if (notional < MIN_BUY_USD) return { error: `买入金额（价格×股数）需 ≥ $${MIN_BUY_USD}` };
    } else {
      const h = (this.portfolio[uid] || {})[code];
      if (!h || !(h.shares > 0)) return { error: '没有该股票持仓' };
      const locked = this._lockedShares(h);
      const frozen = h.frozen || 0;
      const available = round4(Math.max(0, h.shares - locked - frozen));
      if (qty > available) return { error: `可卖 ${available} 股（T+${TRADING.tPlusDays} 锁定 ${round4(locked)}、挂单冻结 ${round4(frozen)}）` };
    }

    const order = {
      id: ++this.orderSeq, userId: uid, username: username || '', code, name: s.name,
      side, price, qty, filled: 0, status: 'open', time: Date.now(),
      frozenQuota: side === 'buy' ? (frozenQuota || 0) : 0, spentUsd: 0, netUsd: 0,
    };
    this.orderById.set(order.id, order);

    if (side === 'sell') {
      if (!this.portfolio[uid]) this.portfolio[uid] = {};
      const h = this.portfolio[uid][code];
      h.frozen = round4((h.frozen || 0) + qty);
    }

    let fills = [], effects = [];
    if (instant) {
      // 委托开关关闭：按现价立即成交（市价单），无需挂单等待撮合
      const mf = this._marketFill(order);
      fills = mf.fills; effects = mf.effects;
    } else if (this._isContinuous()) {
      this._insert(order);
      const m = this._match(order);
      fills = m.fills; effects = m.effects;
      // 先撮真实盘口（价格优先），剩余部分与虚拟做市商成交（保证市价单可即时成交）
      if (order.filled < order.qty) {
        const mv = this._matchVirtual(order);
        fills = fills.concat(mv.fills);
        effects = effects.concat(mv.effects);
      }
      if (order.status === 'done') {
        const book = this.orders[order.code];
        const arr = order.side === 'buy' ? book.bids : book.asks;
        const i = arr.indexOf(order);
        if (i >= 0) arr.splice(i, 1);
      }
    } else {
      this._insert(order); // 集合竞价：只挂单，9:25 统一撮合
    }

    this._savePortfolio();
    if (fills.length && this.handlers.onQuote) this.handlers.onQuote(this.quote());

    const filledQty = order.filled;
    const avgPx = filledQty > 0 ? round2(fills.reduce((a, f) => a + f.price * f.qty, 0) / filledQty) : 0;
    const res = {
      ok: true, orderId: order.id, side, code, name: s.name, price, qty,
      filled: filledQty, status: order.status, avgPx, effects,
    };
    if (side === 'buy') {
      res.frozenUsd = round2(price * qty * (1 + BUY_FEE_RATE));
      res.spentUsd = round2(order.spentUsd || 0);
    } else {
      res.netUsd = round2(order.netUsd || 0);
    }
    return res;
  }

  // 盘口挂单：买价降序 / 卖价升序（同价先到优先）
  _insert(order) {
    const book = this.orders[order.code] || (this.orders[order.code] = { bids: [], asks: [] });
    const arr = order.side === 'buy' ? book.bids : book.asks;
    let i = 0;
    if (order.side === 'buy') { while (i < arr.length && arr[i].price >= order.price) i++; }
    else { while (i < arr.length && arr[i].price <= order.price) i++; }
    arr.splice(i, 0, order);
  }

  // 连续竞价撮合：新单与对手盘逐笔成交（成交价=对手方挂单价）
  _match(order) {
    const fills = [];
    const effects = [];
    const s = this.find(order.code);
    const book = this.orders[order.code] || { bids: [], asks: [] };
    const opp = order.side === 'buy' ? book.asks : book.bids;
    while (order.filled < order.qty && opp.length) {
      const best = opp[0];
      const cross = order.side === 'buy' ? best.price <= order.price : best.price >= order.price;
      if (!cross) break;
      const q = round4(Math.min(order.qty - order.filled, best.qty - best.filled));
      const px = best.price;
      const buyO = order.side === 'buy' ? order : best;
      const sellO = order.side === 'buy' ? best : order;
      const { buyCost, sellNet } = this._executeFill(buyO, sellO, px, q);
      fills.push({ price: px, qty: q, amount: buyCost });
      if (s) s.inflow = round2((s.inflow || 0) + (order.side === 'buy' ? buyCost : -round2(px * q)));
      effects.push({ userId: sellO.userId, quota: this._toQuota(sellNet) }); // 卖方净回款
      // 成交流：以主动方方向记录一次
      const trade = this.recordTrade({
        type: order.side, username: order.username || '', code: order.code, name: order.name,
        price: px, amount: order.side === 'buy' ? buyCost : round2(px * q), shares: round4(q),
      });
      if (this.handlers.onTrade) this.handlers.onTrade(trade);
      if (best.filled >= best.qty) {
        opp.shift();
        best.status = 'done';
        if (best.side === 'buy') effects.push({ userId: best.userId, quota: Math.max(0, (best.frozenQuota || 0) - this._toQuota(best.spentUsd || 0)) });
      }
      if (order.filled >= order.qty) { order.status = 'done'; break; }
    }
    if (order.filled >= order.qty) order.status = 'done';
    // 主动买方全部成交 → 价差优化退款
    if (order.side === 'buy' && order.status === 'done') {
      effects.push({ userId: order.userId, quota: Math.max(0, (order.frozenQuota || 0) - this._toQuota(order.spentUsd || 0)) });
    }
    return { fills, effects };
  }

  // 虚拟做市商接盘价：默认买一=现价+1tick、卖一=现价-1tick；
  // 封涨停(dir=up)时卖方可在涨停价立即成交（有买单排队）、封跌停(dir=down)时买方可在跌停价立即成交（有卖单排队）。
  // 解决「涨停封板卖不掉 / 跌停封板买不进」的死锁。
  _virtualPx(s, side) {
    const lock = this.lockedStocks[s.code];
    if (lock && lock.dir === 'up' && side === 'sell') return round2(s.price);
    if (lock && lock.dir === 'down' && side === 'buy') return round2(s.price);
    return side === 'buy' ? round2(s.price + TICK_SIZE) : round2(s.price - TICK_SIZE);
  }

  // 与虚拟做市商（市场）撮合：限价单剩余部分按现价上下 tick 成交，并施加供需冲击。
  // 受 MM_MAX_USD 深度上限约束（超出的部分留挂单等下一 tick / 真实对手盘），保证市场始终可交易但流动性有限。
  _matchVirtual(order) {
    const s = this.find(order.code);
    const fills = [];
    const effects = [];
    if (order.filled >= order.qty) return { fills, effects };
    const px = this._virtualPx(s, order.side);
    const crossed = order.side === 'buy' ? order.price >= px : order.price <= px;
    if (!crossed) return { fills, effects };
    let q = round4(order.qty - order.filled);
    if (MM_MAX_USD > 0) {
      const capQty = Math.floor(MM_MAX_USD / px);
      if (capQty <= 0) return { fills, effects }; // 深度耗尽：留挂单，下一 tick 再试
      q = round4(Math.min(q, capQty));
    }
    const virt = {
      userId: null, username: '', code: order.code, name: s.name,
      side: order.side === 'buy' ? 'sell' : 'buy', price: px, qty: q, filled: 0,
      netUsd: 0, spentUsd: 0, frozenQuota: 0, status: 'done',
    };
    const buyO = order.side === 'buy' ? order : virt;
    const sellO = order.side === 'buy' ? virt : order;
    const { buyCost, sellNet } = this._executeFill(buyO, sellO, px, q);
    fills.push({ price: px, qty: q, amount: buyCost });
    if (sellO.userId != null) effects.push({ userId: sellO.userId, quota: this._toQuota(sellNet) });
    s.inflow = round2((s.inflow || 0) + (order.side === 'buy' ? buyCost : -round2(px * q))); // 主动方向资金流
    // 供需冲击：买入推高、卖出压低（受涨跌停约束）
    const notional = round2(px * q);
    const impact = Math.min(IMPACT_CAP, (notional / (s.circulation || 1e9)) * IMPACT_K);
    const lp = this._limitPct(s);
    if (order.side === 'buy') {
      s.price = round2(clamp(s.price * (1 + impact), s.prevClose * (1 - lp), s.prevClose * (1 + lp)));
      if (s.price > s.high) s.high = s.price;
    } else {
      s.price = round2(clamp(s.price * (1 - impact), s.prevClose * (1 - lp), s.prevClose * (1 + lp)));
      if (s.price < s.low) s.low = s.price;
    }
    if (order.filled >= order.qty) {
      order.status = 'done';
      if (order.side === 'buy') effects.push({ userId: order.userId, quota: Math.max(0, (order.frozenQuota || 0) - this._toQuota(order.spentUsd || 0)) });
    }
    // 成交流：以主动方方向记录一次
    const trade = this.recordTrade({ type: order.side, username: order.username || '', code: order.code, name: order.name, price: px, amount: order.side === 'buy' ? buyCost : round2(px * q), shares: round4(q) });
    if (this.handlers.onTrade) this.handlers.onTrade(trade);
    return { fills, effects };
  }

  // 委托开关关闭时的市价单成交：整单按现价立即成交，无需等待撮合。
  _marketFill(order) {
    const s = this.find(order.code);
    const fills = [];
    const effects = [];
    const q = round4(order.qty - order.filled);
    if (!s || q <= 0) return { fills, effects };
    const px = s.price;
    const virt = {
      userId: null, username: '', code: order.code, name: s.name,
      side: order.side === 'buy' ? 'sell' : 'buy', price: px, qty: q, filled: 0,
      netUsd: 0, spentUsd: 0, frozenQuota: 0, status: 'done',
    };
    const buyO = order.side === 'buy' ? order : virt;
    const sellO = order.side === 'buy' ? virt : order;
    const { buyCost, sellNet } = this._executeFill(buyO, sellO, px, q);
    fills.push({ price: px, qty: q, amount: buyCost });
    if (sellO.userId != null) effects.push({ userId: sellO.userId, quota: this._toQuota(sellNet) });
    s.inflow = round2((s.inflow || 0) + (order.side === 'buy' ? buyCost : -round2(px * q)));
    // 供需冲击（受涨跌停约束）
    const notional = round2(px * q);
    const impact = Math.min(IMPACT_CAP, (notional / (s.circulation || 1e9)) * IMPACT_K);
    const lp = this._limitPct(s);
    if (order.side === 'buy') {
      s.price = round2(clamp(s.price * (1 + impact), s.prevClose * (1 - lp), s.prevClose * (1 + lp)));
      if (s.price > s.high) s.high = s.price;
    } else {
      s.price = round2(clamp(s.price * (1 - impact), s.prevClose * (1 - lp), s.prevClose * (1 + lp)));
      if (s.price < s.low) s.low = s.price;
    }
    order.status = 'done';
    if (order.side === 'buy') effects.push({ userId: order.userId, quota: Math.max(0, (order.frozenQuota || 0) - this._toQuota(order.spentUsd || 0)) });
    const trade = this.recordTrade({ type: order.side, username: order.username || '', code: order.code, name: order.name, price: px, amount: order.side === 'buy' ? buyCost : round2(px * q), shares: round4(q) });
    if (this.handlers.onTrade) this.handlers.onTrade(trade);
    return { fills, effects };
  }

  // 逐 tick 撮合：价格随机游走后，撮合盘口内已交叉的挂单（最高买价 >= 最低卖价），
  // 以及触及虚拟做市商买卖盘的挂单（价格到位即成交）。产生的额度变动登记到 pendingCredits。
  _matchBook() {
    const effects = [];
    for (const code of Object.keys(this.orders)) {
      const s = this.find(code);
      const book = this.orders[code];
      if (!book) continue;
      // 1) 盘口内部交叉撮合（价格优先、时间优先）
      while (book.bids.length && book.asks.length && book.bids[0].price >= book.asks[0].price) {
        const bb = book.bids[0], ba = book.asks[0];
        const q = round4(Math.min(bb.qty - bb.filled, ba.qty - ba.filled));
        const px = ba.price;
        const { buyCost, sellNet } = this._executeFill(bb, ba, px, q);
        effects.push({ userId: ba.userId, quota: this._toQuota(sellNet) });
        if (s) s.inflow = round2((s.inflow || 0) + buyCost); // 买方主动吃掉卖单 → 净流入
        const trade = this.recordTrade({ type: 'buy', username: bb.username || '', code, name: bb.name, price: px, amount: buyCost, shares: round4(q) });
        if (this.handlers.onTrade) this.handlers.onTrade(trade);
        if (bb.filled >= bb.qty) { book.bids.shift(); bb.status = 'done'; effects.push({ userId: bb.userId, quota: Math.max(0, (bb.frozenQuota || 0) - this._toQuota(bb.spentUsd || 0)) }); }
        if (ba.filled >= ba.qty) { book.asks.shift(); ba.status = 'done'; }
        if (s) { s.price = px; if (px > s.high) s.high = px; if (px < s.low) s.low = px; }
      }
      if (!s) continue;
      // 2) 触及虚拟做市商（价格到位即成交，最优价优先）
      for (const side of ['bids', 'asks']) {
        const arr = book[side];
        while (arr.length) {
          const o = arr[0];
          if (o.status !== 'open') { arr.shift(); continue; }
          const vpx = this._virtualPx(s, o.side);
          const crossed = side === 'bids' ? o.price >= vpx : o.price <= vpx;
          if (!crossed) break; // 最优价未触及，更差的价位也不会触及
          const mv = this._matchVirtual(o);
          effects.push(...mv.effects);
          if (o.status === 'done') arr.shift();
          else break; // 部分成交（做市深度耗尽）：本 tick 不再继续吃虚拟盘，剩余留到下一 tick
        }
      }
      if (!book.bids.length && !book.asks.length) delete this.orders[code];
    }
    this._savePortfolio();
    return effects;
  }

  // 逐笔成交：更新双方持仓与委托，返回 { buyCost, sellNet }
  // userId 为 null 的一方代表「虚拟做市商（市场）」，不更新持仓、不入账（其份额/资金由市场吸收）。
  _executeFill(buyOrder, sellOrder, px, q) {
    const s = this.find(buyOrder.code);
    const t0 = s.t0;
    // 买方
    const buyCost = round2(px * q);
    const buyFee = round2(buyCost * BUY_FEE_RATE);
    const buySpent = round2(buyCost + buyFee);
    buyOrder.filled = round4((buyOrder.filled || 0) + q);
    buyOrder.spentUsd = round2((buyOrder.spentUsd || 0) + buySpent);
    if (buyOrder.userId != null) {
      if (!this.portfolio[buyOrder.userId]) this.portfolio[buyOrder.userId] = {};
      if (buyOrder.username) this.portfolio[buyOrder.userId]._name = String(buyOrder.username);
      const hb = this.portfolio[buyOrder.userId][buyOrder.code] || { shares: 0, locked: 0, frozen: 0, costUsd: 0 };
      hb.shares = round4((hb.shares || 0) + q);
      hb.costUsd = round2((hb.costUsd || 0) + buySpent);
      if (!t0 && TRADING.tPlusDays > 0) {
        // T+N 锁定：按买入结算日分桶记录，换日时按 tPlusDays 解锁
        const today = this._settlementDate();
        const buckets = hb.lockBuckets || (hb.lockBuckets = {});
        buckets[today] = round4((buckets[today] || 0) + q);
      }
      this.portfolio[buyOrder.userId][buyOrder.code] = hb;
    }
    // 卖方
    const sellProceeds = round2(px * q);
    const sellFee = round2(sellProceeds * SELL_FEE_RATE);
    const sellNet = round2(sellProceeds - sellFee);
    sellOrder.filled = round4((sellOrder.filled || 0) + q);
    sellOrder.netUsd = round2((sellOrder.netUsd || 0) + sellNet);
    if (sellOrder.userId != null) {
      const hs = (this.portfolio[sellOrder.userId] || {})[buyOrder.code];
      if (hs) {
        const avgCost = hs.shares > 0 ? hs.costUsd / hs.shares : 0;
        hs.shares = round4(Math.max(0, (hs.shares || 0) - q));
        hs.costUsd = round2(Math.max(0, (hs.costUsd || 0) - q * avgCost));
        hs.frozen = round4(Math.max(0, (hs.frozen || 0) - q));
        if (hs.shares <= 0.0001) delete this.portfolio[sellOrder.userId][buyOrder.code];
      }
    }
    return { buyCost, sellNet };
  }

  // 撤单：买退冻结额度、卖解冻持仓
  cancelOrder(orderId, userId) {
    const o = this.orderById.get(orderId);
    if (!o) return { error: '委托不存在或已结束' };
    if (String(o.userId) !== String(userId)) return { error: '无权撤销该委托' };
    if (o.status !== 'open') return { error: '委托已结束' };
    const book = this.orders[o.code];
    const arr = o.side === 'buy' ? book.bids : book.asks;
    const i = arr.indexOf(o);
    if (i >= 0) arr.splice(i, 1);
    o.status = 'cancelled';
    let refundQuota = 0, unfrozenShares = 0;
    if (o.side === 'buy') {
      refundQuota = Math.max(0, (o.frozenQuota || 0) - this._toQuota(o.spentUsd || 0));
    } else {
      unfrozenShares = round4((o.qty || 0) - (o.filled || 0));
      const h = (this.portfolio[o.userId] || {})[o.code];
      if (h) { h.frozen = round4(Math.max(0, (h.frozen || 0) - unfrozenShares)); this._savePortfolio(); }
    }
    return { ok: true, orderId: o.id, refundQuota, unfrozenShares };
  }

  // 五档盘口：虚拟做市深度（随现价平移）+ 叠加真实用户挂单（按价位累加）。
  orderBook(code) {
    const s = this.find(code);
    if (!s) return { bids: [], asks: [] };
    const book = this.orders[code] || { bids: [], asks: [] };
    const hash = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
    const hh = hash(code);
    const synth = (side) => {
      const rows = [];
      for (let i = 1; i <= 5; i++) {
        const p = side === 'bid' ? round2(s.price - i * TICK_SIZE) : round2(s.price + i * TICK_SIZE);
        const vol = 1500 + ((hh + i * 137) % 5000); // 1500~6500 股，稳定不跳动
        rows.push({ price: p, qty: vol });
      }
      return rows;
    };
    const overlay = (baseRows, arr) => {
      const m = new Map(baseRows.map((b) => [b.price.toFixed(2), b.qty]));
      for (const o of arr) {
        if (o.status !== 'open') continue;
        const rem = round4((o.qty || 0) - (o.filled || 0));
        if (rem <= 0) continue;
        const k = o.price.toFixed(2);
        m.set(k, round4((m.get(k) || 0) + rem));
      }
      return [...m.entries()].map(([p, q]) => ({ price: parseFloat(p), qty: round4(q) }));
    };
    return {
      bids: overlay(synth('bid'), book.bids).sort((a, b) => b.price - a.price).slice(0, 5),
      asks: overlay(synth('ask'), book.asks).sort((a, b) => a.price - b.price).slice(0, 5),
    };
  }

  // 我的当日委托
  myOrders(userId) {
    const uid = String(userId);
    const list = [];
    for (const o of this.orderById.values()) {
      if (o.userId !== uid) continue;
      list.push({ id: o.id, code: o.code, name: o.name, side: o.side, price: o.price, qty: o.qty, filled: o.filled, status: o.status, time: o.time });
    }
    list.sort((a, b) => b.id - a.id);
    return list;
  }

  // 取走待入账额度（server 周期性调用，落账后清空）
  drainCredits() { const r = this.pendingCredits; this.pendingCredits = []; return r; }

  // 收盘撤单：未成交买委托登记退款（卖方冻结股数在新日循环统一清零）
  _cancelAllOpenEOD() {
    for (const o of this.orderById.values()) {
      if (o.status !== 'open') continue;
      o.status = 'cancelled';
      if (o.side === 'buy') {
        const refund = Math.max(0, (o.frozenQuota || 0) - this._toQuota(o.spentUsd || 0));
        if (refund > 0) this.pendingCredits.push({ userId: o.userId, quota: refund });
      }
    }
    this.orders = {};
    this.orderById.clear();
  }

  // 挂单超时自动撤单：未成交委托超过 orderTtlMin 分钟自动撤单解冻。
  // 由 _tick 在连续竞价阶段驱动，覆盖全天候模式（无收盘 EOD 撤单）下挂单永久冻结的缺口。
  _cancelExpiredOrders() {
    if (!TRADING.orderAutoCancel) return;
    const now = Date.now();
    const ttlMs = TRADING.orderTtlMin * 60 * 1000;
    let changed = false;
    for (const o of this.orderById.values()) {
      if (o.status !== 'open') continue;
      if (now - o.time < ttlMs) continue;
      this._cancelOne(o);
      changed = true;
    }
    if (changed) this._savePortfolio();
  }

  // 单笔内部撤单（超时自动撤单用）：不做用户权限校验；买退额度入 pendingCredits、卖解冻持仓。
  _cancelOne(o) {
    const book = this.orders[o.code];
    if (book) {
      const arr = o.side === 'buy' ? book.bids : book.asks;
      const i = arr.indexOf(o);
      if (i >= 0) arr.splice(i, 1);
      if (!book.bids.length && !book.asks.length) delete this.orders[o.code];
    }
    o.status = 'cancelled';
    if (o.side === 'buy') {
      const refund = Math.max(0, (o.frozenQuota || 0) - this._toQuota(o.spentUsd || 0));
      if (refund > 0) this.pendingCredits.push({ userId: o.userId, quota: refund });
    } else {
      const unfrozen = round4((o.qty || 0) - (o.filled || 0));
      const h = (this.portfolio[o.userId] || {})[o.code];
      if (h) h.frozen = round4(Math.max(0, (h.frozen || 0) - unfrozen));
    }
  }

  // 跌停退市检查：任一股票相对上市价累计跌幅达到 DELIST_PCT 即触发退市。
  _checkDelist() {
    if (!DELIST_ENABLED) return;
    for (const s of this.stocks) {
      if (s.listingPrice > 0 && (s.listingPrice - s.price) / s.listingPrice >= DELIST_PCT) {
        this._delist(s);
      }
    }
  }

  // 退市：撤销该股全部挂单（买退额度）、清空所有玩家该股持仓（资金归零不退款）、发公告、同 code 上新随机股票。
  _delist(s) {
    const oldName = s.name;
    const oldCode = s.code;
    const idx = this.stocks.indexOf(s);
    // 1) 撤销该股所有挂单：买退冻结额度（入 pendingCredits 落账），卖单随持仓清空无需解冻
    const book = this.orders[oldCode];
    if (book) {
      for (const o of [...(book.bids || []), ...(book.asks || [])]) {
        if (o.status !== 'open') continue;
        if (o.side === 'buy') {
          const refund = Math.max(0, (o.frozenQuota || 0) - this._toQuota(o.spentUsd || 0));
          if (refund > 0) this.pendingCredits.push({ userId: o.userId, quota: refund });
        }
        o.status = 'cancelled';
        this.orderById.delete(o.id);
      }
      delete this.orders[oldCode];
    }
    delete this.lockedStocks[oldCode];
    delete this.aiTargets[oldCode];
    // 2) 清空所有玩家该股持仓（资金归零，不退款——这正是退市的风险所在）
    let holders = 0;
    for (const uid in this.portfolio) {
      const p = this.portfolio[uid];
      if (!p || typeof p !== 'object') continue;
      if (p[oldCode]) { holders++; delete p[oldCode]; }
    }
    this._savePortfolio();
    // 3) 退市公告（走新闻流，前端消息栏可见）
    const dItem = {
      id: ++this.newsSeq, time: Date.now(), expireAt: Date.now() + NEWS_TTL_HOURS * 3600 * 1000,
      code: oldCode, name: oldName, sector: s.sector,
      text: `【退市】${oldName}（${oldCode}）连续下跌触发退市，累计跌幅达 ${Math.round(DELIST_PCT * 100)}%，${holders} 名玩家持仓作废归零`,
      detail: `监管认定 ${oldName} 触及退市标准，即日摘牌。持有该股的投资者持仓全部作废、资金归零。同代码将重新上市一只新股。`,
      direction: 'bad', magnitude: 0, followup: false, delist: true,
    };
    this.news.unshift(dItem);
    if (this.news.length > 50) this.news.pop();
    if (this.handlers.onNews) this.handlers.onNews(this._publicNews(dItem));
    // 4) 同 code 上新一只随机股票
    const fresh = this._makeStock(oldCode, idx);
    this.stocks[idx] = fresh;
    this.minuteBars[oldCode] = this._genMinuteBars(fresh.price);
    this.lastMinute[oldCode] = null;
    delete this.meta[oldCode]; // 旧股人设/基本面作废
    this._saveMeta();          // 立即持久化新股初始状态（上市价/eps/bvps），AI 人设随后由 _regenerateProfile 补
    // 5) 新上市公告
    const lItem = {
      id: ++this.newsSeq, time: Date.now(), expireAt: Date.now() + NEWS_TTL_HOURS * 3600 * 1000,
      code: oldCode, name: fresh.name, sector: fresh.sector,
      text: `【新上市】${fresh.name} 于 ${oldCode} 重新上市，发行价 ¥${fresh.price}`,
      detail: `${oldName} 退市后，${fresh.name} 以发行价 ¥${fresh.price} 在 ${oldCode} 重新挂牌，重新开始交易。`,
      direction: 'good', magnitude: 0, followup: false, delist: true,
    };
    this.news.unshift(lItem);
    if (this.news.length > 50) this.news.pop();
    if (this.handlers.onNews) this.handlers.onNews(this._publicNews(lItem));
    // 6) AI 人设：为新股生成公司名/主营（若开启且可用）
    this._regenerateProfile(fresh);
    if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
  }

  // 为单只新股重新生成 AI 公司人设（退市补新股时调用，不触碰全局 aiProfilesDone）
  _regenerateProfile(stock) {
    if (!this.aiDriven || !AI_PROFILES || !aiNews.ready()) return;
    aiNews.generateProfiles([{ code: stock.code, sector: stock.sector, price: stock.price }])
      .then((p) => {
        if (!p || !p.stocks || !p.stocks.length) return;
        const it = p.stocks[0];
        const cur = this.find(stock.code);
        if (cur && it && it.name) { cur.name = it.name; cur.desc = it.desc || ''; }
        this._saveMeta(); // 新股人设落盘，重启不再换回随机名
        if (this.handlers.onQuote) this.handlers.onQuote(this.quote());
      })
      .catch(() => {});
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

module.exports = { Market, MIN_BUY_USD, BUY_FEE_RATE, SELL_FEE_RATE, LIMIT_PCT, T0_LIMIT_PCT, TRADING, T0_EVERY, AI_DRIVEN, AI_PROFILES, AI_EARNINGS, AI_RECAP, AI_DRAGON_TIGER, AI_LOCK_DECISIONS, AI_PLAYER_FLOW, DELIST_ENABLED, DELIST_PCT, MM_MAX_USD };
