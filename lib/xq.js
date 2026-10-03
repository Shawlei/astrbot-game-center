'use strict';
// 象棋封装：把 xiangqi.js 适配为统一的对战接口（turnPlayer / legalMoves / applyMove / getState）
const { Xiangqi } = require('./xiangqi');

class XQ {
  constructor(fen) {
    this.game = fen ? new Xiangqi(fen) : new Xiangqi();
  }

  // 当前轮到谁：1 = 红方(先手)，2 = 黑方
  turnPlayer() {
    return this.game.turn() === 'r' ? 1 : 2;
  }

  legalMoves() {
    return this.game.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to }));
  }

  // player: 1|2；move: { from:'e3', to:'e4' }
  applyMove(player, move) {
    const expected = player === 1 ? 'r' : 'b';
    if (this.game.turn() !== expected) {
      return { ok: false, error: '还没轮到你' };
    }
    const res = this.game.move({ from: move.from, to: move.to });
    if (!res) return { ok: false, error: '非法走法' };

    const over = this.game.game_over();
    let winner = 0;
    if (over) {
      // 将死 / 困毙 / 吃将 → 走棋者胜；三重复 / 无子 / 120回合 → 平局
      winner = this.game.in_draw() ? 0 : player;
    }
    return { ok: true, over, winner, state: this.getState() };
  }

  getState() {
    return {
      fen: this.game.fen(),
      turn: this.turnPlayer(),
      over: this.game.game_over(),
      inCheck: this.game.in_check(),
    };
  }
}

module.exports = { XQ };
