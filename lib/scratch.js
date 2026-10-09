// scratch.js —— 刮刮乐（服务端权威）
// 玩法（仿市面福彩刮刮乐「数字比对」）：
//   每张卡 2 个「中奖号码」+ 12 个「我的号码」格，每格藏一个奖金；
//   我的号码命中任一中奖号码即中该格奖金，多格命中兼中兼得；💰 符号格中奖翻 10 倍。
// 随机性：全部 crypto.randomInt —— 是否中奖、奖金档次、号码、格位、分格、💰、擦边球。
// 奖金表：每档面值 8 级奖项 + 权重（每千分之），E[奖金|中奖] 由表决定；
//   中奖率 winRate = returnRate × 面值 / E[奖金|中奖] —— 返奖率恒为 returnRate（默认 65%，与真实彩票一致），
//   面值越大 E[奖金|中奖] 相对面值越小 → 中奖率自然递增（5 元约 28% → 100 元约 41%，同真实彩票）。
// 结算：购卡即生成并持久化卡面（含中奖金额），刮开只是揭示；settle 按存的卡面派奖，不信客户端。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ri = (n) => crypto.randomInt(n);            // 0..n-1
const riRange = (a, b) => a + crypto.randomInt(b - a + 1); // a..b 含端点
const rf = () => crypto.randomInt(0x100000000) / 0x100000000; // [0,1) 加密随机浮点

// 奖金表：prizes 从小到大；weights 为每千分权重（不必凑整，按总权重归一）
const PRIZE_TABLES = {
  5:   { prizes: [5, 10, 15, 25, 50, 100, 500, 2500],        weights: [600, 240, 80, 40, 25, 12, 2, 0.2] },
  10:  { prizes: [10, 20, 30, 50, 100, 250, 1000, 10000],     weights: [620, 240, 75, 35, 18, 8, 1.5, 0.1] },
  20:  { prizes: [20, 40, 60, 100, 200, 500, 2500, 40000],    weights: [645, 240, 68, 28, 13, 3.5, 1, 0.04] },
  50:  { prizes: [50, 100, 150, 250, 500, 1000, 5000, 100000], weights: [680, 225, 50, 20, 12, 2.5, 0.6, 0.02] },
  100: { prizes: [100, 200, 300, 500, 1000, 2500, 10000, 300000], weights: [705, 212, 40, 18, 12, 2, 0.5, 0.012] },
};
const ALL_DENOMS = [5, 10, 20, 50, 100];
const CELL_COUNT = 12;
const NUM_MIN = 1, NUM_MAX = 30;
const X10_CHANCE = 0.04;      // 中奖卡里 💰10倍 符号概率
const NEAR_MISS_CHANCE = 0.4; // 未中奖卡出现擦边号码概率
const AUTO_SETTLE_MS = 24 * 3600 * 1000; // 24h 未刮自动结算
const KEEP_SETTLED_MS = 7 * 24 * 3600 * 1000;

// E[奖金|中奖]（按权重归一）
function expectedWin(denom) {
  const t = PRIZE_TABLES[denom];
  const tw = t.weights.reduce((s, w) => s + w, 0);
  let e = 0;
  for (let i = 0; i < t.prizes.length; i++) e += (t.weights[i] / tw) * t.prizes[i];
  return e;
}
// 中奖率 = 返奖率 × 面值 / E[奖金|中奖]
function winRate(denom, returnRate) {
  return (returnRate * denom) / expectedWin(denom);
}

// 把奖金拆成 1~3 格（每格 ≥ 面值，总额为 winUsd）
function splitPrize(winUsd, price) {
  let parts = 1;
  if (winUsd > 10 * price) parts = 1;                    // 大奖单格，更有冲击力
  else if (winUsd > 2 * price) { const r = rf(); parts = r < 0.6 ? 1 : (r < 0.9 ? 2 : 3); }
  parts = Math.min(parts, Math.floor(winUsd / price));   // 每格至少一个面值
  if (parts <= 1) return [winUsd];
  // 随机切分：切 parts-1 刀，每份 ≥ price
  const cuts = [];
  let remain = winUsd, slots = parts;
  while (slots > 1) {
    const maxCut = remain - price * (slots - 1);
    const c = price + ri(Math.max(1, Math.floor((maxCut - price) / price) + 1)) * price;
    cuts.push(Math.min(c, maxCut)); remain -= cuts[cuts.length - 1]; slots--;
  }
  cuts.push(remain);
  return cuts;
}

class Scratch {
  constructor(file, dailyFile, deps) {
    this.file = file;
    this.dailyFile = dailyFile;
    this.deps = deps; // { getQuotaPerUnit, getCfg, settle, stats }
    this.state = { seq: 1, cards: [] };
    this.daily = { date: this._today(), won: {} };
    this._load();
  }
  cfg() { return (this.deps.getCfg && this.deps.getCfg()) || {}; }
  quotaPerUnit() { return this.deps.getQuotaPerUnit(); }
  usdToQuota(usd) { return Math.round(usd * this.quotaPerUnit()); }
  _today() { return new Date().toISOString().slice(0, 10); }

  _load() {
    try { if (fs.existsSync(this.file)) { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (d && Array.isArray(d.cards)) this.state = d; } } catch (_) {}
    try { if (fs.existsSync(this.dailyFile)) { const d = JSON.parse(fs.readFileSync(this.dailyFile, 'utf8')); if (d && d.won) this.daily = d; } } catch (_) {}
    if (this.daily.date !== this._today()) this.daily = { date: this._today(), won: {} };
  }
  _save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state)); } catch (e) { console.error('[scratch] save failed:', e.message); }
    try { fs.writeFileSync(this.dailyFile, JSON.stringify(this.daily)); } catch (_) {}
  }
  _rollDaily() { if (this.daily.date !== this._today()) { this.daily = { date: this._today(), won: {} }; this._save(); } }

  denoms() {
    const csv = String(this.cfg().denoms || ALL_DENOMS.join(','));
    const list = csv.split(',').map(s => parseInt(s.trim(), 10)).filter(d => PRIZE_TABLES[d]);
    return list.length ? list : ALL_DENOMS;
  }
  dailyCapUsd() { return Math.max(0, Number(this.cfg().dailyWinCapUsd) || 0); }
  usedToday(userId) { this._rollDaily(); return Number(this.daily.won[userId]) || 0; }
  capRemaining(userId) {
    const cap = this.dailyCapUsd();
    return cap > 0 ? Math.max(0, cap - this.usedToday(userId)) : Infinity;
  }

  // ---- 卡面生成（服务端权威，买入即定生死）----
  _pickTier(denom, capMax) {
    const t = PRIZE_TABLES[denom];
    // 受每日上限约束：只允许奖金 ≤ capMax 的档次
    const idxs = [];
    for (let i = 0; i < t.prizes.length; i++) if (t.prizes[i] <= capMax) idxs.push(i);
    if (!idxs.length) return 0;
    const tw = idxs.reduce((s, i) => s + t.weights[i], 0);
    let r = rf() * tw;
    for (const i of idxs) { r -= t.weights[i]; if (r <= 0) return t.prizes[i]; }
    return t.prizes[idxs[idxs.length - 1]];
  }

  _genCard(userId, username, denom) {
    const returnRate = Math.min(0.95, Math.max(0.1, Number(this.cfg().returnRate) || 0.65));
    const wr = Math.min(0.9, winRate(denom, returnRate));
    const capMax = this.capRemaining(userId);
    let winUsd = 0;
    if (rf() < wr && capMax >= denom) winUsd = this._pickTier(denom, capMax);

    // 中奖号码（2 个不同）
    const na = riRange(NUM_MIN, NUM_MAX);
    let nb = riRange(NUM_MIN, NUM_MAX);
    while (nb === na) nb = riRange(NUM_MIN, NUM_MAX);
    const winNums = [na, nb].sort((a, b) => a - b);

    const t = PRIZE_TABLES[denom];
    const randPrize = () => t.prizes[ri(t.prizes.length)];
    const randNum = (exclude) => { let n = riRange(NUM_MIN, NUM_MAX); while (exclude.includes(n)) n = riRange(NUM_MIN, NUM_MAX); return n; };

    const cells = [];
    if (winUsd > 0) {
      // 💰10 倍符号：奖金 ≥10 倍面值且能整除 10 才可能出现
      const x10 = winUsd >= 10 * denom && winUsd % 10 === 0 && rf() < X10_CHANCE;
      const parts = x10 ? [winUsd / 10] : splitPrize(winUsd, denom);
      const winPos = new Set();
      while (winPos.size < parts.length) winPos.add(ri(CELL_COUNT));
      let pi = 0;
      for (let i = 0; i < CELL_COUNT; i++) {
        if (winPos.has(i)) cells.push({ num: winNums[ri(2)], prize: parts[pi++], x10 });
        else cells.push({ num: randNum(winNums), prize: randPrize(), x10: false });
      }
    } else {
      for (let i = 0; i < CELL_COUNT; i++) cells.push({ num: randNum(winNums), prize: randPrize(), x10: false });
      // 擦边球：部分未中奖卡放 1~2 个与中奖号码相邻的号码（差 1，纯心理效果，不改变结果）
      if (rf() < NEAR_MISS_CHANCE) {
        const n = 1 + ri(2);
        for (let k = 0; k < n; k++) {
          const wn = winNums[ri(2)];
          const delta = rf() < 0.5 ? -1 : 1;
          const near = wn + delta;
          if (near >= NUM_MIN && near <= NUM_MAX && !winNums.includes(near)) {
            cells[ri(CELL_COUNT)] = { num: near, prize: randPrize(), x10: false };
          }
        }
      }
    }

    return {
      id: this.state.seq++, userId, username, denom,
      winNums, cells, winUsd, costUsd: denom,
      createdAt: Date.now(), settled: false, settledAt: 0,
    };
  }

  // ---- 买入 ----
  async buy(userId, username, denom) {
    const c = this.cfg();
    if (c.enabled === false) return { ok: false, error: '刮刮乐维护中，请稍后再来' };
    denom = parseInt(denom, 10);
    if (!this.denoms().includes(denom)) return { ok: false, error: '面值无效，可选：' + this.denoms().join('/') };
    const cap = this.dailyCapUsd();
    if (cap > 0 && this.capRemaining(userId) < denom) {
      return { ok: false, error: `今日中奖额度已用完（每日上限 $${cap}），明天再来吧` };
    }
    const costQ = this.usdToQuota(denom);
    if (!(await this.deps.settle.debit(userId, costQ))) return { ok: false, error: '余额不足' };
    const card = this._genCard(userId, username, denom);
    this.state.cards.push(card);
    // 只留近 2000 张未结算 + 近 7 天已结算
    const now = Date.now();
    this.state.cards = this.state.cards.filter(cd => !cd.settled || now - cd.settledAt < KEEP_SETTLED_MS);
    if (this.state.cards.length > 2000) this.state.cards = this.state.cards.slice(-2000);
    this._save();
    return { ok: true, card: this._pubCard(card), balance: await this.deps.settle.balance(userId) };
  }

  _pubCard(cd) {
    return {
      id: cd.id, denom: cd.denom, winNums: cd.winNums,
      cells: cd.cells.map(c => ({ num: c.num, prize: c.prize, x10: c.x10 })),
      winUsd: cd.winUsd, costUsd: cd.costUsd,
      settled: cd.settled, createdAt: cd.createdAt,
    };
  }

  // ---- 结算（幂等；按服务端存的 winUsd 派奖）----
  async settle(userId, cardId) {
    const card = this.state.cards.find(c => c.id === Number(cardId));
    if (!card) return { ok: false, error: '卡不存在' };
    if (card.userId !== userId) return { ok: false, error: '这不是你的卡' };
    if (card.settled) return { ok: true, already: true, winUsd: card.winUsd, card: this._pubCard(card) };
    return await this._doSettle(card);
  }

  async _doSettle(card) {
    card.settled = true; card.settledAt = Date.now();
    if (card.winUsd > 0) {
      await this.deps.settle.credit(card.userId, this.usdToQuota(card.winUsd));
      this._rollDaily();
      this.daily.won[card.userId] = (Number(this.daily.won[card.userId]) || 0) + card.winUsd;
    }
    this.deps.stats.recordSolo(card.userId, 'scratch', this.usdToQuota(card.winUsd - card.costUsd));
    this._save();
    return {
      ok: true, winUsd: card.winUsd, card: this._pubCard(card),
      balance: await this.deps.settle.balance(card.userId),
    };
  }

  // ---- 定时：24h 未刮自动结算 ----
  async tick() {
    this._rollDaily();
    const now = Date.now();
    for (const cd of this.state.cards) {
      if (!cd.settled && now - cd.createdAt > AUTO_SETTLE_MS) {
        try { await this._doSettle(cd); } catch (e) { console.error('[scratch] auto settle failed:', e.message); }
      }
    }
  }

  // ---- 查询 ----
  async my(userId) {
    const mine = this.state.cards.filter(c => c.userId === userId);
    const recent = mine.slice(-30).reverse().map(c => this._pubCard(c));
    const unsettled = mine.filter(c => !c.settled).length;
    const cap = this.dailyCapUsd();
    return {
      ok: true, cards: recent, unsettled,
      todayWonUsd: this.usedToday(userId),
      dailyCapUsd: cap,
      balance: await this.deps.settle.balance(userId),
    };
  }

  info() {
    const c = this.cfg();
    const returnRate = Math.min(0.95, Math.max(0.1, Number(c.returnRate) || 0.65));
    const denoms = this.denoms().map(d => ({
      denom: d,
      prizes: PRIZE_TABLES[d].prizes,
      weights: PRIZE_TABLES[d].weights,
      winRate: Math.round(winRate(d, returnRate) * 1000) / 10, // 百分比，一位小数
      topPrize: PRIZE_TABLES[d].prizes[PRIZE_TABLES[d].prizes.length - 1],
    }));
    // 最近大奖（≥100 倍面值）
    const bigWins = this.state.cards
      .filter(cd => cd.settled && cd.winUsd >= 100 * cd.denom)
      .slice(-10).reverse()
      .map(cd => ({ username: cd.username, denom: cd.denom, winUsd: cd.winUsd, at: cd.settledAt }));
    return {
      ok: true, enabled: c.enabled !== false, returnRate, denoms,
      dailyWinCapUsd: this.dailyCapUsd(),
      cellCount: CELL_COUNT, numRange: [NUM_MIN, NUM_MAX],
      x10Chance: X10_CHANCE, bigWins,
    };
  }

  // 管理后台统计
  stats() {
    const now = Date.now();
    const today = this.state.cards.filter(c => now - c.createdAt < 24 * 3600 * 1000);
    const sold = today.length;
    const paid = today.filter(c => c.settled).reduce((s, c) => s + c.winUsd, 0);
    const income = today.reduce((s, c) => s + c.costUsd, 0);
    return { soldToday: sold, incomeTodayUsd: income, paidTodayUsd: paid, unsettled: this.state.cards.filter(c => !c.settled).length, total: this.state.cards.length };
  }
}

module.exports = { Scratch, PRIZE_TABLES, expectedWin, winRate };
