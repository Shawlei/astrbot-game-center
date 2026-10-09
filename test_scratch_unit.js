// Scratch 类全流程单测（mock settle/stats，无需 DB）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scratch } = require('./lib/scratch.js');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-test-'));
  const QPU = 500000;
  const balances = new Map([[1, 10000 * QPU]]); // 余额单位是 quota（$1 = 500000）
  const ledger = [];
  const settle = {
    async debit(uid, q) { if ((balances.get(uid) || 0) < q) return false; balances.set(uid, balances.get(uid) - q); ledger.push(['debit', q]); return true; },
    async credit(uid, q) { balances.set(uid, (balances.get(uid) || 0) + q); ledger.push(['credit', q]); },
    async balance(uid) { return balances.get(uid) || 0; },
  };
  const recs = [];
  const stats = { recordSolo: (uid, g, net) => recs.push([g, net]) };
  const cfg = { enabled: true, returnRate: 0.65, dailyWinCapUsd: 0, denoms: '5,10,20,50,100' };
  const sc = new Scratch(path.join(tmp, 'scratch.json'), path.join(tmp, 'daily.json'), {
    getQuotaPerUnit: () => 500000, getCfg: () => cfg, settle, stats,
  });

  let pass = 0, fail = 0;
  const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } };

  // 1. 买入：扣款 + 卡面结构
  const b1 = await sc.buy(1, 'tester', 10);
  ok(b1.ok && b1.card, 'buy ok');
  ok(balances.get(1) === 10000 * QPU - 10 * QPU, 'debit $10');
  const cd = b1.card;
  ok(cd.cells.length === 12, '12 cells');
  ok(cd.winNums.length === 2 && cd.winNums[0] !== cd.winNums[1], '2 distinct winNums');
  ok(cd.winNums.every(n => n >= 1 && n <= 30), 'winNums in 1..30');
  // 卡面自洽：命中格奖金(×10)之和 == winUsd
  const winSet = new Set(cd.winNums);
  const calcWin = cd.cells.filter(c => winSet.has(c.num)).reduce((s, c) => s + c.prize * (c.x10 ? 10 : 1), 0);
  ok(calcWin === cd.winUsd, `winUsd consistent (${calcWin} == ${cd.winUsd})`);
  // 非命中格不含中奖号码已由生成保证（winNums 外），命中即派奖逻辑靠 winUsd 存储

  // 2. 结算：按 winUsd 派奖 + 幂等
  const s1 = await sc.settle(1, cd.id);
  ok(s1.ok && s1.winUsd === cd.winUsd, 'settle win matches');
  ok(balances.get(1) === 10000 * QPU - 10 * QPU + cd.winUsd * 500000, 'balance after settle');
  const s2 = await sc.settle(1, cd.id);
  ok(s2.ok && s2.already === true, 'settle idempotent');
  ok(balances.get(1) === 10000 * QPU - 10 * QPU + cd.winUsd * 500000, 'no double credit');
  ok(recs.length === 1 && recs[0][1] === (cd.winUsd - 10) * 500000, 'stats.recordSolo net');

  // 3. 无效面值 / 余额不足
  const b2 = await sc.buy(1, 'tester', 7);
  ok(!b2.ok && /面值/.test(b2.error), 'invalid denom rejected');
  balances.set(1, 100);
  const b3 = await sc.buy(1, 'tester', 100);
  ok(!b3.ok && /余额不足/.test(b3.error), 'insufficient balance rejected');
  balances.set(1, 1000000 * QPU);

  // 4. 每日中奖上限：cap=15 → $50 卡必买不到（面值>cap）, $10 卡 win ≤ 15
  cfg.dailyWinCapUsd = 15;
  const b4 = await sc.buy(1, 'tester', 50);
  ok(!b4.ok && /上限/.test(b4.error), 'denom > cap rejected');
  for (let i = 0; i < 200; i++) {
    const b = await sc.buy(1, 'tester', 10);
    if (b.ok) { const s = await sc.settle(1, b.card.id); if (s.winUsd > 15) { fail++; console.log('FAIL: win over cap', s.winUsd); break; } }
    if (!b.ok) break; // cap 用完后拒售也合规
  }
  ok(sc.usedToday(1) <= 15, `daily won ${sc.usedToday(1)} <= cap 15`);
  cfg.dailyWinCapUsd = 0;

  // 5. 禁用拒售
  cfg.enabled = false;
  const b5 = await sc.buy(1, 'tester', 5);
  ok(!b5.ok, 'disabled rejected');
  cfg.enabled = true;

  // 6. 24h 自动结算：伪造一张老卡
  const b6 = await sc.buy(1, 'tester', 5);
  const raw = sc.state.cards.find(c => c.id === b6.card.id);
  raw.createdAt = Date.now() - 25 * 3600 * 1000;
  await sc.tick();
  ok(raw.settled === true, 'tick auto-settled 24h card');

  // 7. 持久化：重载实例状态一致
  const sc2 = new Scratch(path.join(tmp, 'scratch.json'), path.join(tmp, 'daily.json'), {
    getQuotaPerUnit: () => 500000, getCfg: () => cfg, settle, stats,
  });
  ok(sc2.state.cards.length === sc.state.cards.length, 'reload cards persist');
  ok(sc2.usedToday(1) === sc.usedToday(1), 'reload daily persist');

  // 8. 批量统计：RTP 粗验（$20 × 5000 张）
  const before = await settle.balance(1);
  let paid = 0, costSum = 0;
  for (let i = 0; i < 5000; i++) {
    const b = await sc.buy(1, 't', 20);
    costSum += 20;
    const s = await sc.settle(1, b.card.id);
    paid += s.winUsd;
  }
  const rtp = paid / costSum;
  ok(rtp > 0.58 && rtp < 0.72, `RTP(5000×$20)=${(rtp * 100).toFixed(1)}% in 58%~72%`);

  // 9. info/stats 接口形状
  const info = sc.info();
  ok(info.denoms.length === 5 && info.denoms[0].winRate > 0, 'info shape');
  const st = sc.stats();
  ok(typeof st.soldToday === 'number' && typeof st.unsettled === 'number', 'stats shape');

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
