'use strict';
// 配置层：config.json（WebUI 可编辑，持久化）> 环境变量（部署引导）> 默认值。
// 仓库内不含任何真实凭据；敏感项（MySQL 密码、NewAPI key）仅存在于 data/config.json 或环境变量中。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 默认配置
const DEFAULTS = {
  // 服务端口
  port: 46110,          // 游戏 / 股市 HTTP + WebSocket
  adminPort: 46111,     // 管理后台（独立端口）
  adminPassword: 'admin',
  publicUrl: '',
  // 额度 / 押注
  quotaPerUnit: 500000, // 1 美元 = 多少 quota
  minBet: 10,           // 押注下限（美元）
  maxBet: 200,          // 押注上限（美元）
  turnTimeoutMs: 180000,// 联机思考超时（毫秒）
  // 文件路径
  bindingsFile: '',     // 插件 bindings.json（QQ -> NewAPI userId）
  statsFile: path.join(DATA_DIR, 'stats.json'),
  portfolioFile: path.join(DATA_DIR, 'portfolio.json'),
  reversalsFile: path.join(DATA_DIR, 'reversals.json'),
  marketMetaFile: path.join(DATA_DIR, 'marketMeta.json'),
  lotteryFile: path.join(DATA_DIR, 'lottery.json'),
  scratchFile: path.join(DATA_DIR, 'scratch.json'),
  scratchDailyFile: path.join(DATA_DIR, 'scratch_daily.json'),
  watermelonFile: path.join(DATA_DIR, 'watermelon_rewards.json'),
  // NewAPI 站点
  newapiBase: '',
  newapiKey: '',
  aiModel: 'agy-gemini-3.8-flash-high',
  // 远程 MySQL（NewAPI 额度库）
  mysql: { host: '', port: 3306, user: '', password: '', database: 'new-api' },
  // AI 新闻调度
  news: {
    dailyMin: 4,          // （弃用：改由 minGapMin/maxGapMin 间隔制控制，保留字段向后兼容）
    dailyMax: 24,         // （弃用）
    ttlHours: 6,          // 新闻时效（小时）
    minGapMin: 2,         // 两次新闻最小间隔（分钟）
    maxGapMin: 90,        // 两次新闻最大间隔（分钟，log-uniform：短间隔多、长间隔少，时密时疏）
    neutralRate: 0.25,    // 中性新闻概率（0~1）：只发文字、不推股价，打破「新闻必然动荡」
  },
  // 各游戏独立配置（后台「游戏设置」按类编辑；enabled=false 时大厅隐藏且拒绝建房）。
  // 押注上下限 / 思考超时未在此指定时，回退到上方全局 minBet/maxBet/turnTimeoutMs（保持向后兼容）。
  games: {
    // ---- 联机对战 ----
    doudizhu:  { enabled: true, allowDouble: true, allowSuperDouble: true, allowSpring: true },
    xiangqi:   { enabled: true },
    gomoku:    { enabled: true },
    // ---- 单机小游戏 ----
    snake:     { enabled: true, maxMult: 5 },
    breakout:  { enabled: true, maxMult: 3 },
    twentyfour:{ enabled: true },
    dice:      { enabled: true, pointOdds: 5 },
    // ---- 合成大西瓜（免费玩，按得分发额度奖励，每日封顶防刷） ----
    watermelon: {
      enabled: true,
      rewardCapUsd: 20,        // 每人每日奖励额度上限（美元），超过不再发放
      rewardMinLevel: 9,       // 领取奖励的最低合成等级（合成到菠萝9级及以上才触发）
      rewardPerScoreUsd: 0.0025, // 每 1 分的奖励美元（约每 400 分 = $1）
      rewardMinUsd: 0.5,       // 单局最低奖励（美元，保底）
      rewardMaxUsd: 5,         // 单局最高奖励（美元，封顶）
      scoreMin: 10,            // 单次合成得分下限（2级合成默认 10 分）
      scoreMax: 1000,          // 单次合成得分上限（11级合成默认 1000 分）
    },
    // ---- 双色球彩票（每日固定时间开奖） ----
    lottery:   {
      enabled: true,
      drawTime: '20:00',     // 每日开奖时间（北京时间 HH:mm）
      ticketPrice: 1,        // 每注价格（美元）
      maxMult: 99,           // 单票最大倍数
      maxZhu: 20000,         // 单次购票最大注数（复式展开上限，防爆炸）
      jackpotRate: 0.2,      // 每注销售额进入一等奖奖池的比例（0~1）
      prize2Mult: 200,       // 二等奖（6+0）单注奖金 = 该倍数 × 每注价格
      prize3Mult: 100,       // 三等奖（5+1）
      prize4Mult: 20,        // 四等奖（5+0 / 4+1）
      prize5Mult: 5,         // 五等奖（4+0 / 3+1）
      prize6Mult: 2,         // 六等奖（中蓝球）
    },
    // ---- 刮刮乐（即开型彩票，数字比对玩法） ----
    scratch:   {
      enabled: true,
      returnRate: 0.65,      // 返奖率（0.1~0.95）：中奖率由奖金表自动反推，返奖率恒定
      dailyWinCapUsd: 0,     // 每人每日中奖总额上限（美元，0=不限）
      denoms: '5,10,20,50,100', // 开放的面值（逗号分隔，可选 5/10/20/50/100）
    },
    // ---- 模拟股市 ----
    market: {
      enabled: true,
      // 交易规则
      minBuyUsd: 1000,        // 单笔最低投入（美元）
      buyFeeRate: 0.001,      // 买入手续费率
      sellFeeRate: 0.002,     // 卖出手续费率（含印花税）
      limitPct: 0.10,         // 涨跌停幅度（相对昨收）
      t0LimitPct: 0.03,       // T+0 涨跌停幅度（更小，只能赚小钱；T+1 用 limitPct 赚大钱）
      t0Every: 3,             // 每 N 只里 1 只为 T+0（当日可买卖）
      tPlusDays: 1,           // T+N 结算：买入后第 N 天可卖（1=T+1 次日，0=T+0 当日）
      entrustEnabled: true,   // 委托开关：false 则买/卖均按现价立即成交（无需等待撮合）
      sellInstant: false,     // 卖出即时成交：true 则卖单不挂单冻结、按现价立即卖出（市价单）
      orderAutoCancel: true,  // 挂单超时自动撤单：未成交委托超过 orderTtlMin 分钟自动撤单解冻
      orderTtlMin: 10,        // 挂单超时分钟数（orderAutoCancel=true 时生效；买退额度、卖解冻持仓）
      delistEnabled: true,    // 跌停退市：股价相对上市价累计跌幅达 delistPct 即退市，持仓归零并补新股
      delistPct: 0.70,        // 退市跌幅阈值（0.70=累计跌 70% 退市）
      mmMaxUsd: 1000000,      // 虚拟做市商单笔接盘深度上限（美元，0=不限；限价单超出部分留挂单）
      // 交易时段开关与起止（HH:mm，北京时间）
      auctionEnabled: true,   // 是否启用集合竞价（9:15~开盘）
      auctionStart: '09:15',  // 集合竞价开始
      auctionEnd: '09:25',    // 集合竞价结束（定开盘价）
      morningStart: '09:30',  // 早盘连续竞价开始（开盘）
      morningEnd: '11:30',    // 早盘结束
      lunchEnabled: true,     // 是否启用午间休市（关闭则早午盘连续）
      afternoonStart: '13:00',// 午盘连续竞价开始
      afternoonEnd: '15:00',  // 收盘
      weekendClosed: true,    // 周末是否休市
      // 交易时段总开关：false 则全天候连续交易（无集合竞价/开盘/收盘/午休/周末休市）
      sessionsEnabled: true,
      // T+N「哪天算过一天」：每天该时刻起才算正式过了一天（HH:mm，默认 00:00）
      dayBoundary: '00:00',
      // AI 全驱动：涨跌停、新闻、舆论、新闻对股价的影响全由 AI 决定（关闭则用确定性随机模型）
      aiDriven: false,
      aiEconomyIntervalMin: 3, // AI 决策周期（分钟）
      // AI 子功能开关（仅 aiDriven=true 时生效）
      aiProfiles: true,        // AI 生成公司名 + 主营业务人设
      aiEarnings: true,        // AI 定期发布财报，改写 eps/bvps（PE/PB 随之变动）
      aiRecap: true,           // AI 收盘复盘（每日收盘后生成当日大盘总结）
      aiDragonTiger: true,     // AI 龙虎榜（标注大资金进出）
      aiLockDecisions: true,   // AI 封板决策（显式决定涨停/跌停封板，否则封板仍由极端新闻触发）
      aiPlayerFlow: true,      // AI 感知玩家资金面（净流入/持仓人数/集中度），据此生成游资进出类新闻与走势
      aiTargetPerturb: 1.5,    // AI 目标价执行扰动（±百分点）：堵玩家精确预测收敛终点（明牌套利）
    },
  },
};

// 扁平键（点分路径）-> 环境变量名
const ENV_MAP = {
  'port': 'GAME_PORT',
  'adminPort': 'ADMIN_PORT',
  'adminPassword': 'ADMIN_PASSWORD',
  'publicUrl': 'PUBLIC_URL',
  'quotaPerUnit': 'QUOTA_PER_UNIT',
  'minBet': 'MIN_BET',
  'maxBet': 'MAX_BET',
  'turnTimeoutMs': 'TURN_TIMEOUT_MS',
  'bindingsFile': 'BINDINGS_FILE',
  'statsFile': 'STATS_FILE',
  'portfolioFile': 'PORTFOLIO_FILE',
  'reversalsFile': 'REVERSALS_FILE',
  'marketMetaFile': 'MARKET_META_FILE',
  'lotteryFile': 'LOTTERY_FILE',
  'newapiBase': 'NEWAPI_BASE',
  'newapiKey': 'NEWAPI_KEY',
  'aiModel': 'AI_MODEL',
  'mysql.host': 'MYSQL_HOST',
  'mysql.port': 'MYSQL_PORT',
  'mysql.user': 'MYSQL_USER',
  'mysql.password': 'MYSQL_PASS',
  'mysql.database': 'MYSQL_NAME',
  'news.dailyMin': 'NEWS_DAILY_MIN',
  'news.dailyMax': 'NEWS_DAILY_MAX',
  'news.ttlHours': 'NEWS_TTL_HOURS',
  'news.minGapMin': 'NEWS_MIN_GAP_MIN',
  'news.maxGapMin': 'NEWS_MAX_GAP_MIN',
  'news.neutralRate': 'NEWS_NEUTRAL_RATE',
  // 股市规则（market.js 在 require 时经 process.env 读取，applyEnv 已注入）
  'games.market.minBuyUsd': 'MARKET_MIN_BUY_USD',
  'games.market.buyFeeRate': 'MARKET_BUY_FEE_RATE',
  'games.market.sellFeeRate': 'MARKET_SELL_FEE_RATE',
  'games.market.limitPct': 'MARKET_LIMIT_PCT',
  'games.market.t0LimitPct': 'MARKET_T0_LIMIT_PCT',
  'games.market.t0Every': 'MARKET_T0_EVERY',
  'games.market.tPlusDays': 'MARKET_T_PLUS_DAYS',
  'games.market.entrustEnabled': 'MARKET_ENTRUST_ENABLED',
  'games.market.sellInstant': 'MARKET_SELL_INSTANT',
  'games.market.orderAutoCancel': 'MARKET_ORDER_AUTO_CANCEL',
  'games.market.orderTtlMin': 'MARKET_ORDER_TTL_MIN',
  'games.market.delistEnabled': 'MARKET_DELIST_ENABLED',
  'games.market.delistPct': 'MARKET_DELIST_PCT',
  'games.market.mmMaxUsd': 'MARKET_MM_MAX_USD',
  'games.market.auctionEnabled': 'MARKET_AUCTION_ENABLED',
  'games.market.auctionStart': 'MARKET_AUCTION_START',
  'games.market.auctionEnd': 'MARKET_AUCTION_END',
  'games.market.morningStart': 'MARKET_MORNING_START',
  'games.market.morningEnd': 'MARKET_MORNING_END',
  'games.market.lunchEnabled': 'MARKET_LUNCH_ENABLED',
  'games.market.afternoonStart': 'MARKET_AFTERNOON_START',
  'games.market.afternoonEnd': 'MARKET_AFTERNOON_END',
  'games.market.weekendClosed': 'MARKET_WEEKEND_CLOSED',
  'games.market.sessionsEnabled': 'MARKET_SESSIONS_ENABLED',
  'games.market.dayBoundary': 'MARKET_DAY_BOUNDARY',
  'games.market.aiDriven': 'MARKET_AI_DRIVEN',
  'games.market.aiEconomyIntervalMin': 'MARKET_AI_ECONOMY_MIN',
  'games.market.aiProfiles': 'MARKET_AI_PROFILES',
  'games.market.aiEarnings': 'MARKET_AI_EARNINGS',
  'games.market.aiRecap': 'MARKET_AI_RECAP',
  'games.market.aiDragonTiger': 'MARKET_AI_DRAGON_TIGER',
  'games.market.aiLockDecisions': 'MARKET_AI_LOCK_DECISIONS',
  'games.market.aiPlayerFlow': 'MARKET_AI_PLAYER_FLOW',
  'games.market.aiTargetPerturb': 'MARKET_AI_TARGET_PERTURB',
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, over) {
  const out = clone(base || {});
  if (!isObj(over)) return out;
  for (const k of Object.keys(over)) {
    if (over[k] === undefined || over[k] === null) continue;
    if (isObj(out[k]) && isObj(over[k])) out[k] = deepMerge(out[k], over[k]);
    else out[k] = clone(over[k]);
  }
  return out;
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const p of dotted.split('.')) {
    if (!isObj(cur) && !(cur && typeof cur === 'object')) return undefined;
    cur = cur[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setPath(obj, dotted, val) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

function readFileConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return isObj(j) ? j : {};
    }
  } catch (e) { /* ignore */ }
  return {};
}

function coerce(template, str) {
  if (typeof template === 'number') {
    if (Number.isInteger(template)) { const n = parseInt(str, 10); return Number.isNaN(n) ? template : n; }
    const n = parseFloat(str); return Number.isNaN(n) ? template : n;
  }
  if (typeof template === 'boolean') return str === 'true' || str === '1' || str === 'yes';
  return String(str);
}

// 读取最终配置：config.json > 环境变量 > 默认值
function load() {
  let cfg = clone(DEFAULTS);
  // 1) 环境变量（部署引导）
  for (const [key, env] of Object.entries(ENV_MAP)) {
    const v = process.env[env];
    if (v !== undefined && v !== '') {
      setPath(cfg, key, coerce(getPath(DEFAULTS, key), v));
    }
  }
  // 2) config.json（WebUI 持久化，最高优先）
  cfg = deepMerge(cfg, readFileConfig());
  return cfg;
}

// 把最终配置写回 process.env，让直接读 env 的模块（market.js / aiNews.js 等）拿到一致的值。
// 须在 require 那些模块之前调用。
function applyEnv(cfg) {
  for (const [key, env] of Object.entries(ENV_MAP)) {
    const v = getPath(cfg, key);
    if (v !== undefined && v !== null) {
      process.env[env] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
}

// 持久化配置（WebUI 保存用）：把 partial 深合并进现有 config.json 并写盘。
function save(partial) {
  const merged = deepMerge(readFileConfig(), partial || {});
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

// 热更新运行中配置：把 partial 原地深合并进内存 target 对象，并重新注入 process.env。
// 用于 WebUI 保存后让 minBet/maxBet、游戏开关、思考超时等「运行时读取」项立即生效，
// 无需重启；对在 require 时就固化进常量的项（market.js 等读 env 的规则）仍需重启。
function applyLive(target, partial) {
  if (!isObj(partial)) return target;
  for (const k of Object.keys(partial)) {
    if (partial[k] === undefined || partial[k] === null) continue;
    if (isObj(target[k]) && isObj(partial[k])) applyLive(target[k], partial[k]);
    else target[k] = clone(partial[k]);
  }
  applyEnv(target);
  return target;
}

// 当前已持久化的配置内容（不含默认值）
function persisted() { return readFileConfig(); }

module.exports = { load, save, applyLive, persisted, applyEnv, CONFIG_FILE, DATA_DIR, DEFAULTS, ENV_MAP };
