'use strict';
// 双色球彩票：每日固定时间（默认北京时间 20:00）开奖。
// 玩法：每注 6 红球(1-33) + 1 蓝球(1-16)，支持自选/机选/复式(红球7-16、蓝球2-16)/多倍(1-99)。
// 服务端权威开奖（crypto 安全随机），奖级判定与派奖全在服务端，前端只展示。
// 设奖：一等奖=奖池(每注销售额按 jackpotRate 滚入，无人中则滚存)，二~六等奖=固定倍数。
// 规则无漏洞要点：
//   1) 买票有余额门槛（settle.debit 入场扣款，不足拒绝）；
//   2) 开奖号码用 crypto.randomInt，前端无法影响/预测；
//   3) 每期开奖幂等（status: selling->drawing->drawn + 逐票 paid 标记），重启/重试不重复派奖；
//   4) 一等奖按「中奖注数」均分奖池、余数滚存，固定奖按「注数×倍数」计，总账平衡无超发。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RED_MAX = 33;
const BLUE_MAX = 16;
const RED_PICK = 6;      // 每注红球数
const HISTORY_KEEP = 50; // 保留最近开奖期数

// 组合：从 arr 中取 k 个的所有组合（返回元素数组的数组）
function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  if (k < 0 || k > n) return res;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    res.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return res;
}

// 组合数 C(n,k)
function combCount(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return Math.round(r);
}

// 安全随机整数 [min, max]（含两端）
function randInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

class Lottery {
  // deps: { getQuotaPerUnit(), getCfg(), settle, stats, bindings }
  constructor(file, deps) {
    this.file = file;
    this.deps = deps;
    this.state = { current: null, history: [], lastDrawn: null, jackpot: 0 };
    this._load();
  }

  // ---- 配置（实时读取，支持后台热更新） ----
  cfg() {
    const g = (this.deps.getCfg && this.deps.getCfg()) || {};
    const d = this.deps;
    return {
      enabled: g.enabled !== false,
      drawTime: g.drawTime || '20:00',
      ticketPrice: g.ticketPrice != null ? g.ticketPrice : 1,
      maxMult: g.maxMult != null ? g.maxMult : 99,
      maxZhu: g.maxZhu != null ? g.maxZhu : 20000,
      jackpotRate: g.jackpotRate != null ? g.jackpotRate : 0.2,
      prize2Mult: g.prize2Mult != null ? g.prize2Mult : 200,
      prize3Mult: g.prize3Mult != null ? g.prize3Mult : 100,
      prize4Mult: g.prize4Mult != null ? g.prize4Mult : 20,
      prize5Mult: g.prize5Mult != null ? g.prize5Mult : 5,
      prize6Mult: g.prize6Mult != null ? g.prize6Mult : 2,
      quotaPerUnit: (d.getQuotaPerUnit && d.getQuotaPerUnit()) || 500000,
    };
  }

  // ---- 时间（北京时间 Asia/Shanghai = UTC+8，无夏令时） ----
  _cnNow() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), day: d.getUTCDay() };
  }
  _cnDateStr() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
  _toMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m) return null;
    const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return Number.isFinite(v) ? v : null;
  }
  // 期号：YYYYDDD（年 + 年内第几天，北京时间）
  _issueOf(dateStr) {
    const [y, mo, dd] = dateStr.split('-').map(Number);
    const start = Date.UTC(y, 0, 1);
    const cur = Date.UTC(y, mo - 1, dd);
    const doy = Math.floor((cur - start) / 86400000) + 1;
    return String(y) + String(doy).padStart(3, '0');
  }
  _nextDate(dateStr) {
    const [y, mo, dd] = dateStr.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1, dd));
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  // 开奖时间戳（北京 drawTime 的 UTC epoch ms）
  _drawAtOf(dateStr, drawTime) {
    const [y, mo, dd] = dateStr.split('-').map(Number);
    const tmin = this._toMin(drawTime) ?? 1200;
    const hh = Math.floor(tmin / 60), mm = tmin % 60;
    return Date.UTC(y, mo - 1, dd, hh, mm, 0) - 8 * 3600 * 1000;
  }
  // 当前「可售期」：drawTime 之前卖当天这期，之后卖明天那期
  _openIssue(now) {
    const today = this._cnDateStr();
    const t = this._cnNow();
    const tmin = this._toMin(this.cfg().drawTime) ?? 1200;
    const date = (t.h * 60 + t.m) < tmin ? today : this._nextDate(today);
    return { date, issue: this._issueOf(date), drawAt: this._drawAtOf(date, this.cfg().drawTime) };
  }

  // ---- 持久化 ----
  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state = Object.assign({ current: null, history: [], lastDrawn: null, jackpot: 0 }, j);
      }
    } catch (e) { /* ignore */ }
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (e) { /* ignore */ }
  }

  // ---- 开奖号码 ----
  _drawNumbers() {
    const red = new Set();
    while (red.size < RED_PICK) red.add(randInt(1, RED_MAX));
    const sortedRed = Array.from(red).sort((a, b) => a - b);
    return { red: sortedRed, blue: randInt(1, BLUE_MAX) };
  }

  // ---- 奖级判定 ----
  _tier(red, blue, winRed, winBlue) {
    const rs = new Set(winRed);
    let r = 0;
    for (const x of red) if (rs.has(x)) r++;
    const b = (blue === winBlue) ? 1 : 0;
    if (r === 6 && b === 1) return 1;
    if (r === 6 && b === 0) return 2;
    if (r === 5 && b === 1) return 3;
    if ((r === 5 && b === 0) || (r === 4 && b === 1)) return 4;
    if ((r === 4 && b === 0) || (r === 3 && b === 1)) return 5;
    if (b === 1) return 6; // 2+1 / 1+1 / 0+1 均中蓝球
    return 0;
  }

  // 固定奖每注奖金（quota）
  _prizeQuota(tier) {
    const c = this.cfg();
    const mult = tier === 2 ? c.prize2Mult
      : tier === 3 ? c.prize3Mult
      : tier === 4 ? c.prize4Mult
      : tier === 5 ? c.prize5Mult
      : c.prize6Mult;
    return Math.round(mult * c.ticketPrice * c.quotaPerUnit);
  }

  // 每注成本（quota）
  _costPerZhu() {
    const c = this.cfg();
    return Math.round(c.ticketPrice * c.quotaPerUnit);
  }

  // ---- 购票 ----
  // sel: { red: number[], blue: number[] }；mult: 倍数 1-99。校验并展开为 combos。
  _buildCombos(sel, mult) {
    const c = this.cfg();
    const red = (sel.red || []).slice();
    const blue = (sel.blue || []).slice();
    const redOk = red.length >= RED_PICK && red.length <= 16 && red.every((x) => Number.isInteger(x) && x >= 1 && x <= RED_MAX) && new Set(red).size === red.length;
    const blueOk = blue.length >= 1 && blue.length <= BLUE_MAX && blue.every((x) => Number.isInteger(x) && x >= 1 && x <= BLUE_MAX) && new Set(blue).size === blue.length;
    if (!redOk) return { error: `红球需为 ${RED_PICK}~16 个不重复的 1~${RED_MAX} 号码` };
    if (!blueOk) return { error: `蓝球需为 1~16 个不重复的 1~${BLUE_MAX} 号码` };
    if (!(Number.isInteger(mult) && mult >= 1 && mult <= c.maxMult)) return { error: `倍数需为 1~${c.maxMult} 的整数` };

    const redCombos = combinations(red.slice().sort((a, b) => a - b), RED_PICK);
    const zhu = redCombos.length * blue.length;
    if (zhu > c.maxZhu) return { error: `注数 ${zhu} 超过单次上限 ${c.maxZhu}，请减少复式号码` };
    const combos = [];
    for (const rc of redCombos) for (const b of blue) combos.push({ red: rc, blue: b });
    return { combos, zhu, mult };
  }

  async buy(userId, username, sel, mult) {
    const c = this.cfg();
    if (!c.enabled) return { error: '彩票已暂停销售' };
    const now = Date.now();
    const open = this._openIssue(now);
    if (!this.state.current || this.state.current.date !== open.date) {
      this.state.current = { issue: open.issue, date: open.date, drawAt: open.drawAt, status: 'selling', tickets: [], sales: 0 };
    }
    const issue = this.state.current;
    if (issue.status !== 'selling') return { error: '当前期已截止投注，请等待下一期' };

    const built = this._buildCombos(sel, mult);
    if (built.error) return { error: built.error };

    const costQuota = Math.round(built.zhu * built.mult * this._costPerZhu());
    if (!(costQuota > 0)) return { error: '投注金额无效' };

    // 入场门槛：余额不足拒绝（与其它游戏一致）
    const settle = this.deps.settle;
    if (settle && settle.ready()) {
      const ok = await settle.debit(userId, costQuota);
      if (!ok) return { error: '余额不足，无法购票' };
    }

    const ticket = {
      id: crypto.randomBytes(8).toString('hex'),
      userId,
      username,
      mode: built.zhu === 1 ? 'single' : 'fushi',
      redSel: (sel.red || []).slice().sort((a, b) => a - b),
      blueSel: (sel.blue || []).slice().sort((a, b) => a - b),
      combos: built.combos,
      mult: built.mult,
      zhu: built.zhu,
      costQuota,
      createdAt: now,
      paid: 0,
      result: null,
    };
    issue.tickets.push(ticket);
    issue.sales = (issue.sales || 0) + costQuota;

    // 一等奖奖池滚入
    this.state.jackpot = (this.state.jackpot || 0) + Math.round(costQuota * c.jackpotRate);
    this._save();

    return {
      ok: true,
      ticketId: ticket.id,
      issue: issue.issue,
      zhu: built.zhu,
      mult: built.mult,
      costQuota,
      jackpot: this.state.jackpot,
      drawAt: issue.drawAt,
    };
  }

  // ---- 开奖（幂等；每期只结算一次） ----
  async _draw(issue) {
    const settle = this.deps.settle;
    // 1) 生成开奖号码（幂等：已有则复用，防重启重抽）
    if (!issue.red) {
      const n = this._drawNumbers();
      issue.red = n.red;
      issue.blue = n.blue;
      issue.status = 'drawing';
      this._save();
    }

    const pool = this.state.jackpot || 0;
    const tier1Tickets = []; // { ticket, winningZhu }
    const fixedWinners = [];  // { ticket, quota }

    // 2) 逐票判定（每张票可能多注；固定奖按注数×倍数，一等奖按注数）
    for (const t of issue.tickets) {
      let fixedQuota = 0;
      let tier1Zhu = 0;
      const tiers = {};
      for (const combo of t.combos) {
        const tier = this._tier(combo.red, combo.blue, issue.red, issue.blue);
        if (tier === 1) tier1Zhu += t.mult;
        else if (tier >= 2) { fixedQuota += this._prizeQuota(tier) * t.mult; tiers[tier] = (tiers[tier] || 0) + t.mult; }
      }
      if (tier1Zhu > 0) tier1Tickets.push({ ticket: t, winningZhu: tier1Zhu });
      if (fixedQuota > 0) fixedWinners.push({ ticket: t, quota: fixedQuota, tiers });
      t._tiers = tiers;
      t._tier1Zhu = tier1Zhu;
      t._fixedQuota = fixedQuota;
    }

    // 3) 一等奖：按中奖注数均分奖池，余数滚存
    const totalZhu = tier1Tickets.reduce((a, x) => a + x.winningZhu, 0);
    const perZhu = totalZhu > 0 ? Math.floor(pool / totalZhu) : 0;
    const payouts = []; // { ticket, quota }
    for (const fw of fixedWinners) payouts.push({ ticket: fw.ticket, quota: fw.quota });
    for (const t1 of tier1Tickets) payouts.push({ ticket: t1.ticket, quota: perZhu * t1.winningZhu });

    // 4) 逐票入账（at-most-once：已 paid 的跳过；入账成功才记账）
    for (const p of payouts) {
      if (p.ticket.paid) continue;
      if (!(p.quota > 0)) continue;
      p.ticket.paid = p.quota;
      this._save();
      try {
        if (settle && settle.ready()) await settle.credit(p.ticket.userId, p.quota);
      } catch (e) {
        p.ticket.paid = 0;
        this._save();
        throw e; // 中止，下次 tick 重试（未入账的票仍 paid=0）
      }
    }

    // 5) 奖池结余：扣除已派一等奖，余数滚存
    this.state.jackpot = pool - perZhu * totalZhu;
    if (this.state.jackpot < 0) this.state.jackpot = 0;

    // 6) 汇总每张票结果（供「我的彩票」展示）+ 战绩
    const stats = this.deps.stats;
    for (const t of issue.tickets) {
      t.result = {
        tiers: t._tiers || {},
        tier1Zhu: t._tier1Zhu || 0,
        prize: t.paid || 0, // paid 已含一等奖派奖
      };
      delete t._tiers; delete t._tier1Zhu; delete t._fixedQuota;
      if (stats) stats.recordSolo(t.userId, 'lottery', (t.paid || 0) - t.costQuota);
    }

    // 7) 移入历史 + 保留最近一期明细
    const record = {
      issue: issue.issue,
      date: issue.date,
      red: issue.red,
      blue: issue.blue,
      jackpot: pool,
      sales: issue.sales || 0,
      ticketCount: issue.tickets.length,
      drawAt: issue.drawAt,
      drawnAt: Date.now(),
      tier1Zhu: totalZhu,
      prizeTotal: payouts.reduce((a, p) => a + p.quota, 0),
    };
    issue.status = 'drawn';
    this.state.lastDrawn = {
      issue: issue.issue,
      date: issue.date,
      red: issue.red,
      blue: issue.blue,
      jackpot: pool,
      drawAt: issue.drawAt,
      drawnAt: record.drawnAt,
      tier1Zhu: totalZhu,
      tickets: issue.tickets,
    };
    this.state.history.unshift(record);
    this.state.history = this.state.history.slice(0, HISTORY_KEEP);
    this.state.current = null;
    this._save();
    return record;
  }

  // ---- 定时驱动：到点开奖、换期、补开漏开 ----
  async tick() {
    const now = Date.now();
    // 1) 到点开奖（含重启后补开漏掉的那期）
    if (this.state.current && this.state.current.status === 'selling' && now >= this.state.current.drawAt) {
      try {
        const rec = await this._draw(this.state.current);
        console.log(`[lottery] 开奖 ${rec.issue} 红[${rec.red.join(',')}] 蓝${rec.blue} 奖池=${rec.jackpot} 销售额=${rec.sales} 一等奖注数=${rec.tier1Zhu}`);
      } catch (e) {
        console.error(`[lottery] 开奖结算失败，稍后重试：${e.message}`);
        return;
      }
    }
    // 2) 若处于 drawing（上次中断），继续结算
    if (this.state.current && this.state.current.status === 'drawing') {
      try { await this._draw(this.state.current); } catch (e) { console.error(`[lottery] 补结算失败：${e.message}`); }
      return;
    }
    // 3) 确保存在当前可售期
    const open = this._openIssue(now);
    if (!this.state.current || this.state.current.date !== open.date) {
      this.state.current = { issue: open.issue, date: open.date, drawAt: open.drawAt, status: 'selling', tickets: [], sales: 0 };
      this._save();
      console.log(`[lottery] 新一期 ${open.issue} 开售，${this.cfg().drawTime} 开奖`);
    }
  }

  // ---- 查询 ----
  prizeTable() {
    const c = this.cfg();
    return [
      { tier: 1, name: '一等奖', cond: '6+1 全中', prize: '奖池均分' },
      { tier: 2, name: '二等奖', cond: '6+0', prize: c.prize2Mult + ' 倍' },
      { tier: 3, name: '三等奖', cond: '5+1', prize: c.prize3Mult + ' 倍' },
      { tier: 4, name: '四等奖', cond: '5+0 / 4+1', prize: c.prize4Mult + ' 倍' },
      { tier: 5, name: '五等奖', cond: '4+0 / 3+1', prize: c.prize5Mult + ' 倍' },
      { tier: 6, name: '六等奖', cond: '中蓝球', prize: c.prize6Mult + ' 倍' },
    ];
  }

  info() {
    const c = this.cfg();
    const open = this._openIssue(Date.now());
    let current = this.state.current;
    if (!current) current = { issue: open.issue, date: open.date, drawAt: open.drawAt, status: 'selling', tickets: [], sales: 0 };
    const latest = this.state.lastDrawn || this.state.history[0] || null;
    return {
      enabled: c.enabled,
      ticketPrice: c.ticketPrice,
      maxMult: c.maxMult,
      drawTime: c.drawTime,
      quotaPerUnit: c.quotaPerUnit,
      currentIssue: current.issue,
      drawAt: current.drawAt,
      status: current.status,
      jackpot: this.state.jackpot || 0,
      prizeTable: this.prizeTable(),
      latest: latest ? { issue: latest.issue, red: latest.red, blue: latest.blue, jackpot: latest.jackpot, drawAt: latest.drawnAt || latest.drawAt, tier1Zhu: latest.tier1Zhu, sales: latest.sales } : null,
    };
  }

  myTickets(userId) {
    const list = [];
    if (this.state.current) {
      for (const t of this.state.current.tickets) {
        if (String(t.userId) === String(userId)) list.push(this._ticketView(t, this.state.current));
      }
    }
    if (this.state.lastDrawn) {
      for (const t of this.state.lastDrawn.tickets) {
        if (String(t.userId) === String(userId)) list.push(this._ticketView(t, this.state.lastDrawn));
      }
    }
    return list;
  }

  _ticketView(t, issue) {
    return {
      id: t.id,
      issue: issue ? issue.issue : '',
      red: t.redSel, blue: t.blueSel,
      mult: t.mult, zhu: t.zhu,
      costQuota: t.costQuota,
      createdAt: t.createdAt,
      paid: t.paid || 0,
      result: t.result || null,
      status: issue ? issue.status : 'selling',
    };
  }

  history(limit) {
    const n = Math.min(parseInt(limit, 10) || 10, 50);
    return this.state.history.slice(0, n);
  }
}

module.exports = { Lottery, combinations, combCount, randInt };
