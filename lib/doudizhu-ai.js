'use strict';
// 斗地主「超时托管」AI：当轮到某方思考超时（默认 180s）时，服务端代其决策，
// 避免对局因挂机卡死。也用于可选的人机补位。
// 质量目标：合法、合理、不出错（不强求棋力）。

const D = require('./doudizhu');

// 按 rank 分组手牌
function groupByRank(hand) {
  const m = {};
  for (const c of hand) (m[c.rank] = m[c.rank] || []).push(c);
  return m;
}

// 手牌强度评分（用于叫分 / 加倍）
function strength(hand) {
  let s = 0;
  const byRank = groupByRank(hand);
  for (const r in byRank) {
    const rank = parseInt(r, 10);
    const cnt = byRank[r].length;
    if (cnt === 4) s += 6;            // 炸弹
    if (rank === 16 || rank === 17) s += 4;  // 王
    if (rank === 15) s += 2;          // 2
    if (rank === 14) s += 1.5;        // A
    if (cnt >= 3) s += 1;             // 三张
  }
  return s;
}

// 叫分决策：score 0(不叫)/1/2/3，须 > highestBid（否则 0）
function bid(hand, highestBid) {
  const s = strength(hand);
  let want = 0;
  if (s >= 16) want = 3;
  else if (s >= 11) want = 2;
  else if (s >= 7) want = 1;
  else want = 0;
  if (want > 0 && want <= highestBid) want = 0; // 叫不过就放弃
  return want;
}

// 加倍决策：1 不加倍 / 2 加倍 / 4 超级加倍
function double(hand, isLandlord) {
  const s = strength(hand);
  // 地主手握 20 张，阈值略放宽
  if (s >= 18) return 4;
  if (s >= 13) return 2;
  return 1;
}

// 枚举手牌所有可能的出牌组合（去重靠 analyze 的牌型天然去重，此处直接全列）
function listMoves(hand) {
  const moves = [];
  const byRank = groupByRank(hand);
  const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);

  const push = (cards) => { if (cards.length) moves.push(cards); };

  // 单张
  for (const r of ranks) push([byRank[r][0]]);
  // 对子
  for (const r of ranks) if (byRank[r].length >= 2) push(byRank[r].slice(0, 2));
  // 三张
  for (const r of ranks) if (byRank[r].length >= 3) push(byRank[r].slice(0, 3));
  // 三带一
  for (const r of ranks) if (byRank[r].length >= 3) {
    for (const r2 of ranks) if (r2 !== r) push(byRank[r].slice(0, 3).concat(byRank[r2][0]));
  }
  // 三带二
  for (const r of ranks) if (byRank[r].length >= 3) {
    for (const r2 of ranks) if (r2 !== r && byRank[r2].length >= 2) push(byRank[r].slice(0, 3).concat(byRank[r2].slice(0, 2)));
  }
  // 顺子（5~12 连单，3~A）
  for (let len = 5; len <= 12; len++) {
    for (let start = 3; start + len - 1 <= 14; start++) {
      const cs = [];
      let ok = true;
      for (let r = start; r < start + len; r++) { if (!byRank[r]) { ok = false; break; } cs.push(byRank[r][0]); }
      if (ok) push(cs);
    }
  }
  // 连对（3~12 连对，3~A）
  for (let len = 3; len <= 12; len++) {
    for (let start = 3; start + len - 1 <= 14; start++) {
      const cs = [];
      let ok = true;
      for (let r = start; r < start + len; r++) { if (!byRank[r] || byRank[r].length < 2) { ok = false; break; } cs.push(byRank[r][0], byRank[r][1]); }
      if (ok) push(cs);
    }
  }
  // 飞机不带（2~6 组三张，3~A）
  for (let len = 2; len <= 6; len++) {
    for (let start = 3; start + len - 1 <= 14; start++) {
      const cs = [];
      let ok = true;
      for (let r = start; r < start + len; r++) { if (!byRank[r] || byRank[r].length < 3) { ok = false; break; } cs.push(byRank[r][0], byRank[r][1], byRank[r][2]); }
      if (ok) push(cs);
    }
  }
  // 炸弹
  for (const r of ranks) if (byRank[r].length === 4) push(byRank[r]);
  // 火箭
  if (byRank[16] && byRank[17]) push([byRank[16][0], byRank[17][0]]);

  return moves;
}

// 牌型优先级：普通 < 炸弹 < 火箭（用于选「最小能压」时排序）
function typeWeight(t) {
  if (t === 'rocket') return 3;
  if (t === 'bomb') return 2;
  return 1;
}

// 出牌决策：返回 { cards: [...] } 或 { pass: true }
function play(hand, lastPlay) {
  const moves = listMoves(hand);
  if (!lastPlay) {
    // 自由出牌：能一手出完则出完；否则出最小单张
    const all = D.analyze(hand);
    if (all) return { cards: hand };
    return { cards: [hand[0]] };
  }

  // 压牌：找能压的最小牌（普通牌优先，炸弹/火箭兜底）
  let best = null;
  let bestRank = Infinity;
  let bestWeight = Infinity;
  for (const m of moves) {
    const cur = D.analyze(m);
    if (!cur) continue;
    if (!D.canBeat(lastPlay, cur)) continue;
    const w = typeWeight(cur.type);
    // 更小的权值优先；同权值取更小主牌
    if (w < bestWeight || (w === bestWeight && cur.rank < bestRank)) {
      bestWeight = w; bestRank = cur.rank; best = m;
    }
  }
  if (best) return { cards: best };
  return { pass: true };
}

module.exports = { bid, double, play, strength, listMoves };
