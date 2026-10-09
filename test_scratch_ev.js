// 刮刮乐奖金表验证：解析法 + 蒙特卡洛
// 目标：每档面值 返奖率(RTP)≈65%、中奖面 28%~42% 随面值递增
'use strict';
const { PRIZE_TABLES, expectedWin, winRate } = require('./lib/scratch.js');

const RETURN_RATE = 0.65;
console.log('=== 解析法（winRate = returnRate × 面值 / E[奖金|中奖]）===');
for (const d of [5, 10, 20, 50, 100]) {
  const t = PRIZE_TABLES[d];
  const tw = t.weights.reduce((s, w) => s + w, 0);
  const e = expectedWin(d);
  const wr = winRate(d, RETURN_RATE);
  // RTP 分解校验：winRate × E = returnRate × 面值
  const rtp = (wr * e) / d;
  console.log(`$${d}: E[win|win]=${e.toFixed(2)} (${(e / d).toFixed(2)}x) 中奖率=${(wr * 100).toFixed(1)}% RTP=${(rtp * 100).toFixed(2)}% 头奖=$${t.prizes[t.prizes.length - 1]} (${(t.prizes[t.prizes.length - 1] / d).toLocaleString()}x)`);
  // 各奖项对 EV 的贡献（检查头奖是否过度主导）
  const contrib = t.prizes.map((p, i) => ((t.weights[i] / tw) * p));
  const topContrib = contrib[contrib.length - 1] / e * 100;
  console.log(`   头奖EV占比=${topContrib.toFixed(1)}%  权重合计=${tw}`);
}

console.log('\n=== 蒙特卡洛（模拟 200 万张/档，含 capMax=Inf）===');
const crypto = require('crypto');
function pickTier(denom) {
  const t = PRIZE_TABLES[denom];
  const tw = t.weights.reduce((s, w) => s + w, 0);
  let r = crypto.randomInt(1 << 30) / (1 << 30) * tw;
  for (let i = 0; i < t.prizes.length; i++) { r -= t.weights[i]; if (r <= 0) return t.prizes[i]; }
  return t.prizes[t.prizes.length - 1];
}
for (const d of [5, 10, 20, 50, 100]) {
  const wr = winRate(d, RETURN_RATE);
  const N = 2000000;
  let wins = 0, paid = 0;
  const tierHit = {};
  for (let i = 0; i < N; i++) {
    if (crypto.randomInt(1 << 30) / (1 << 30) < wr) {
      wins++;
      const p = pickTier(d);
      paid += p;
      tierHit[p] = (tierHit[p] || 0) + 1;
    }
  }
  const rtp = paid / (N * d);
  console.log(`$${d}: 中奖率=${(wins / N * 100).toFixed(1)}% RTP=${(rtp * 100).toFixed(2)}% 头奖命中=${(tierHit[PRIZE_TABLES[d].prizes[7]] || 0)} 次`);
}
console.log('\n校验通过标准：RTP 全档 64.5%~65.5%，中奖率 5→100 递增且落在 28%~42%');
