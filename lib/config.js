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
  // NewAPI 站点
  newapiBase: '',
  newapiKey: '',
  aiModel: 'agy-gemini-3.8-flash-high',
  // 远程 MySQL（NewAPI 额度库）
  mysql: { host: '', port: 3306, user: '', password: '', database: 'new-api' },
  // AI 新闻调度
  news: { dailyMin: 4, dailyMax: 24, ttlHours: 6 },
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

// 当前已持久化的配置内容（不含默认值）
function persisted() { return readFileConfig(); }

module.exports = { load, save, persisted, applyEnv, CONFIG_FILE, DATA_DIR, DEFAULTS, ENV_MAP };
