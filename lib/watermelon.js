'use strict';
// 合成大西瓜：免费玩、按「最高合成等级」发小额额度奖励，每日每用户封顶防刷。
// 奖励额度持久化到 JSON（按 userId + 北京时间日期），跨重启生效。
const fs = require('fs');
const path = require('path');

// 北京时间（UTC+8）当日日期，形如 YYYY-MM-DD
function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

class WatermelonRewards {
  constructor(file) {
    this.file = file;
    this.data = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
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

  // 读取当日某用户已累计领取的额度（美元）
  dailyTotal(userId) {
    const uid = String(userId);
    const rec = this.data[uid];
    if (!rec || rec.date !== todayCN()) return 0;
    return rec.totalUsd || 0;
  }

  // 申请奖励：level 为 1~11 的合成等级，score 为本局累计得分。
  // 奖励按「得分」计算：score × rewardPerScoreUsd，夹在 [rewardMinUsd, rewardMaxUsd] 之间；
  // 但必须合成到 rewardMinLevel（默认 9 级菠萝）及以上才触发，否则不发放。
  // 返回 { rewardUsd, remainingUsd, capped, dailyTotalUsd, reached } —— rewardUsd 为本次实发美元。
  claim(userId, level, score, cfg) {
    const uid = String(userId);
    const today = todayCN();

    const minLevel = cfg.rewardMinLevel != null ? cfg.rewardMinLevel : 9;
    const perScore = cfg.rewardPerScoreUsd != null ? cfg.rewardPerScoreUsd : 0.0025;
    const minUsd = cfg.rewardMinUsd != null ? cfg.rewardMinUsd : 0.5;
    const maxUsd = cfg.rewardMaxUsd != null ? cfg.rewardMaxUsd : 5;
    const cap = cfg.rewardCapUsd != null ? cfg.rewardCapUsd : 20;

    const reached = level >= minLevel;

    const rec = this.data[uid];
    if (!rec || rec.date !== today) this.data[uid] = { date: today, totalUsd: 0 };
    const cur = this.data[uid];

    // 未达奖励等级，不发放
    if (!reached) {
      return { rewardUsd: 0, remainingUsd: +(cap - cur.totalUsd).toFixed(4), capped: false, dailyTotalUsd: cur.totalUsd, reached: false };
    }

    // 按分数计算本次应发，夹在 [minUsd, maxUsd]，精确到分
    let full = 0;
    const s = Number(score);
    if (Number.isFinite(s) && s > 0) {
      full = Math.min(maxUsd, Math.max(minUsd, s * perScore));
      full = Math.round(full * 100) / 100;
    } else {
      full = minUsd;
    }

    const remaining = cap - cur.totalUsd;
    if (remaining <= 0) {
      return { rewardUsd: 0, remainingUsd: 0, capped: true, dailyTotalUsd: cur.totalUsd, reached };
    }

    const give = Math.min(full, remaining);
    cur.totalUsd = +(cur.totalUsd + give).toFixed(4);
    this._save();
    return {
      rewardUsd: +give.toFixed(4),
      remainingUsd: +(cap - cur.totalUsd).toFixed(4),
      capped: give < full,
      dailyTotalUsd: +cur.totalUsd.toFixed(4),
      reached,
    };
  }
}

module.exports = { WatermelonRewards };
