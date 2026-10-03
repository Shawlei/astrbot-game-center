'use strict';
// 五子棋规则：15x15 棋盘，黑(1)先手，连五即胜。无禁手（简化）。
// 对外接口与象棋封装一致，供房间框架统一调用。

class Gomoku {
  constructor(state) {
    this.size = 15;
    if (state) {
      this.board = state.board.map((r) => r.slice());
      this.turn = state.turn;
      this.winner = state.winner;
      this.over = state.over;
      this.history = state.history.slice();
    } else {
      this.board = Array.from({ length: this.size }, () => Array(this.size).fill(0));
      this.turn = 1; // 1 黑(先手) 2 白
      this.winner = 0;
      this.over = false;
      this.history = [];
    }
  }

  // 当前轮到谁：1 / 2
  turnPlayer() {
    return this.turn;
  }

  // 合法落点（所有空位，简化不做禁手）
  legalMoves() {
    const m = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.board[r][c] === 0) m.push({ r, c });
      }
    }
    return m;
  }

  _checkWin(r, c, color) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let cnt = 1;
      for (const s of [1, -1]) {
        let nr = r + dr * s;
        let nc = c + dc * s;
        while (nr >= 0 && nr < this.size && nc >= 0 && nc < this.size && this.board[nr][nc] === color) {
          cnt++;
          nr += dr * s;
          nc += dc * s;
        }
      }
      if (cnt >= 5) return true;
    }
    return false;
  }

  // 落子：返回 { ok, error?, state?, over, winner }
  applyMove(player, move) {
    if (this.over) return { ok: false, error: '对局已结束' };
    if (player !== this.turn) return { ok: false, error: '还没轮到你' };
    const r = move.r;
    const c = move.c;
    if (r == null || c == null || r < 0 || r >= this.size || c < 0 || c >= this.size) {
      return { ok: false, error: '坐标越界' };
    }
    if (this.board[r][c] !== 0) return { ok: false, error: '该位置已有棋子' };

    this.board[r][c] = this.turn;
    this.history.push({ p: this.turn, r, c });

    if (this._checkWin(r, c, this.turn)) {
      this.winner = this.turn;
      this.over = true;
    } else if (this.history.length >= this.size * this.size) {
      this.winner = 0; // 平局
      this.over = true;
    } else {
      this.turn = this.turn === 1 ? 2 : 1;
    }
    return { ok: true, over: this.over, winner: this.winner, state: this.getState() };
  }

  getState() {
    return {
      board: this.board,
      turn: this.turn,
      winner: this.winner,
      over: this.over,
      history: this.history,
    };
  }
}

module.exports = { Gomoku };
