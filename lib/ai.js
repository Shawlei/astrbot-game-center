'use strict';
// 联机对战「超时托管」AI：当轮到某方思考超时（默认 180s）时，服务端代其走一步，
// 避免对局因挂机卡死。走子质量仅要求「合法且不至于乱走」，不追求棋力。
//
// 输入 gameType('xiangqi'|'gomoku') + room.game（XQ / Gomoku 实例），
// 输出一个合法 move（象棋 {from,to}；五子棋 {r,c}），无合法走法返回 null。

const XQ_VAL = { k: 1000, r: 9, c: 4, n: 4, b: 2, a: 2, p: 1 };

function pickMove(gameType, game) {
  if (gameType === 'xiangqi') return pickXiangqi(game);
  return pickGomoku(game);
}

// 象棋：优先吃大子，其次随机合法走子。
function pickXiangqi(xq) {
  // XQ 封装内部持有原始 Xiangqi 实例；verbose 走法含 captured（被吃子类型，小写）
  const moves = xq.game.moves({ verbose: true });
  if (!moves.length) return null;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const cap = m.captured ? (XQ_VAL[m.captured] || 0) : 0;
    // 吃子价值主导，加随机扰动打散 tie
    const s = cap + Math.random() * 0.001;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return { from: best.from, to: best.to };
}

// 五子棋：贪心评分（进攻 + 防守），在已有棋子周围 2 格内选点。
function pickGomoku(g) {
  const size = g.size;
  const me = g.turn;
  const opp = me === 1 ? 2 : 1;
  const board = g.board;

  // 候选：已有棋子周围 2 格内的空位
  const cand = new Set();
  let hasStone = false;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === 0) continue;
      hasStone = true;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === 0) {
            cand.add(nr * size + nc);
          }
        }
      }
    }
  }
  if (!hasStone) return { r: Math.floor(size / 2), c: Math.floor(size / 2) }; // 空盘下天元

  let bestR = Math.floor(size / 2), bestC = Math.floor(size / 2), bestScore = -Infinity;
  for (const key of cand) {
    const r = Math.floor(key / size);
    const c = key % size;
    const off = scorePoint(board, r, c, me);
    const def = scorePoint(board, r, c, opp);
    const s = off + def * 0.9 + Math.random() * 0.01;
    if (s > bestScore) { bestScore = s; bestR = r; bestC = c; }
  }
  return { r: bestR, c: bestC };
}

// 评估「在 (r,c) 落 color」后四方向的连子强度（不修改棋盘）。
function scorePoint(board, r, c, color) {
  const size = board.length;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  let total = 0;
  for (const [dr, dc] of dirs) {
    let cnt = 1;
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === color) { cnt++; nr += dr; nc += dc; }
    nr = r - dr; nc = c - dc;
    while (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === color) { cnt++; nr -= dr; nc -= dc; }
    if (cnt >= 5) total += 100000;
    else total += cnt * cnt * cnt;
  }
  return total;
}

module.exports = { pickMove };
