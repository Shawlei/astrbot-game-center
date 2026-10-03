'use strict';
// 战绩存储：JSON 文件持久化，按 userId + gameType 记录 胜/负/平。
const fs = require('fs');
const path = require('path');

class Stats {
  constructor(file) {
    this.file = file;
    this.data = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (e) {
      this.data = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      /* ignore */
    }
  }

  // result: 'win' | 'lose' | 'draw'
  record(userId, gameType, result) {
    if (!userId) return;
    const uid = String(userId);
    if (!this.data[uid]) this.data[uid] = {};
    if (!this.data[uid][gameType]) this.data[uid][gameType] = { win: 0, lose: 0, draw: 0, total: 0 };
    const s = this.data[uid][gameType];
    s[result] = (s[result] || 0) + 1;
    s.total = s.win + s.lose + s.draw;
    this._save();
  }

  get(userId) {
    return this.data[String(userId)] || {};
  }

  // 指定游戏的战绩摘要，用于对局结果展示
  summary(userId, gameType) {
    const s = this.get(userId)[gameType] || { win: 0, lose: 0, draw: 0, total: 0 };
    return { win: s.win || 0, lose: s.lose || 0, draw: s.draw || 0, total: s.total || 0 };
  }

  // 单机下注游戏：记录一局净赢配额（正=赢，负=输）
  recordSolo(userId, gameType, netQuota) {
    if (!userId) return;
    const uid = String(userId);
    if (!this.data[uid]) this.data[uid] = {};
    if (!this.data[uid][gameType]) this.data[uid][gameType] = { games: 0, netQuota: 0, bestQuota: 0 };
    const s = this.data[uid][gameType];
    s.games = (s.games || 0) + 1;
    s.netQuota = (s.netQuota || 0) + netQuota;
    s.bestQuota = Math.max(s.bestQuota || 0, netQuota);
    this._save();
  }

  // 排行榜：按 gameType 聚合。
  // 单机类型（有 netQuota）按净赢配额降序；联机类型（有 win）按胜场降序（平手按净胜）。
  leaderboard(gameType, limit = 20) {
    const rows = [];
    for (const uid in this.data) {
      const s = this.data[uid][gameType];
      if (!s) continue;
      if (s.games != null) {
        // 单机
        rows.push({ userId: uid, games: s.games || 0, netQuota: s.netQuota || 0, bestQuota: s.bestQuota || 0 });
      } else {
        // 联机
        const win = s.win || 0, lose = s.lose || 0, draw = s.draw || 0;
        rows.push({ userId: uid, win, lose, draw, total: win + lose + draw, netQuota: 0 });
      }
    }
    rows.sort((a, b) => {
      if (a.netQuota !== b.netQuota && (a.games != null || b.games != null)) return (b.netQuota || 0) - (a.netQuota || 0);
      if (a.win != null && b.win != null) {
        if (b.win !== a.win) return b.win - a.win;
        return (b.win - b.lose) - (a.win - a.lose);
      }
      return (b.netQuota || 0) - (a.netQuota || 0);
    });
    return rows.slice(0, limit);
  }
}

module.exports = { Stats };
