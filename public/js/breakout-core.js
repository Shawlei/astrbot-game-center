/* breakout-core.js — 打砖块确定性核心引擎（共享：浏览器 <script> 与 Node require 通用）
 * 设计要点：
 *  - 帧驱动：每 tick 推进固定 1/60s；物理只用 + - * / 与 Math.sqrt/abs/floor（IEEE754 精确），
 *    不用 Math.sin/cos/tan（跨引擎不保证一致），确保客户端游玩与服务端回放结果逐位一致。
 *  - 随机仅来自种子：方块道具分布、发球角度由 mulberry32(seed) 决定。
 *  - 无限波次：清空一波后自动生成更密的一波（行数递增、球更快、横板更短），
 *    直到命用完才结束；所有波次生成同样由 seed 驱动的 rng 决定，保持可回放。
 *  - 输入模型：客户端每帧传入横板目标中心 x（targetX），并逐帧记录；服务端按同一序列回放得权威分数。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BreakoutCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 480, H = 600;
  var PADDLE_W = 84, PADDLE_H = 12, PADDLE_Y = 566;
  var BALL_R = 7, BALL_SPEED = 340;
  var BRICK_COLS = 8, BRICK_ROWS = 6;
  var BRICK_W = 52, BRICK_H = 20, BRICK_GAP = 6, BRICK_TOP = 70, BRICK_LEFT = 11;
  var LIVES = 3;
  var WIDE_TICKS = 600, SLOW_TICKS = 600;
  var POWER_PROB = 0.2;
  var POWER_TYPES = ['wide', 'slow', 'extra'];
  var BRICK_SCORE = 10;
  var EXTRA_SCORE = 50;
  var MAX_TICKS = 60 * 60 * 20; // 服务端回放安全上限（20 分钟），客户端超此自动结算
  // 波次难度参数
  var MAX_ROWS = 10;        // 波次砖行数上限（首波 6 行，逐波 +1）
  var MIN_PADDLE_W = 64;    // 横板最短
  var WIDE_MULT = 1.6;      // 加宽倍数
  var SPEED_STEP = 0.06;    // 每波球速递增比例
  var SPEED_CAP = 1.8;      // 球速上限倍数
  var PADDLE_STEP = 4;      // 每波横板缩短像素

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function waveRows(level) {
    return Math.min(BRICK_ROWS + (level - 1), MAX_ROWS);
  }
  function waveSpeedMult(level) {
    return Math.min(1 + (level - 1) * SPEED_STEP, SPEED_CAP);
  }
  function wavePaddleW(level) {
    return Math.max(PADDLE_W - (level - 1) * PADDLE_STEP, MIN_PADDLE_W);
  }
  function baseSpeed(state) {
    return BALL_SPEED * state.speedMult;
  }

  // 生成当前波次的砖块（用 state.rng 决定道具分布，保持确定性），并更新本波难度。
  function spawnWave(state) {
    var rows = waveRows(state.level);
    var bricks = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < BRICK_COLS; c++) {
        var power = state.rng() < POWER_PROB ? POWER_TYPES[Math.floor(state.rng() * POWER_TYPES.length)] : null;
        bricks.push({
          x: BRICK_LEFT + c * (BRICK_W + BRICK_GAP),
          y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
          w: BRICK_W, h: BRICK_H,
          alive: true, power: power, row: r,
        });
      }
    }
    state.bricks = bricks;
    state.speedMult = waveSpeedMult(state.level);
    state.basePaddleW = wavePaddleW(state.level);
    // 若正处加宽状态，按新的基础宽重算加宽宽；否则收缩为基础宽
    state.paddle.w = state.wideTimer > 0 ? Math.round(state.basePaddleW * WIDE_MULT) : state.basePaddleW;
  }

  function createGame(seed) {
    var rng = mulberry32(seed >>> 0);
    var state = {
      rng: rng,
      paddle: { x: W / 2, w: PADDLE_W },
      ball: null,
      bricks: [],
      powerups: [],
      score: 0,
      lives: LIVES,
      level: 1,
      basePaddleW: PADDLE_W,
      speedMult: 1,
      over: false,
      win: false,
      wideTimer: 0,
      slowTimer: 0,
    };
    spawnWave(state);
    launchBall(state);
    return state;
  }

  function currentSpeed(state) {
    return baseSpeed(state) * (state.slowTimer > 0 ? 0.7 : 1);
  }

  function launchBall(state) {
    var sp = baseSpeed(state);
    var vx = (state.rng() * 0.5 - 0.25) * sp;
    var vy = -Math.sqrt(Math.max(0, sp * sp - vx * vx));
    state.ball = { x: state.paddle.x, y: PADDLE_Y - BALL_R - 1, vx: vx, vy: vy };
  }

  function applyPower(state, type) {
    if (type === 'wide') { state.paddle.w = Math.round(state.basePaddleW * WIDE_MULT); state.wideTimer = WIDE_TICKS; }
    else if (type === 'slow') { state.slowTimer = SLOW_TICKS; }
    else if (type === 'extra') { state.score += EXTRA_SCORE; }
  }

  // 清空一波：进入下一波（更难），并重新发球。
  function nextWave(state) {
    state.level++;
    spawnWave(state);
    launchBall(state);
  }

  function step(state, targetX) {
    if (state.over) return;
    var half = state.paddle.w / 2;
    state.paddle.x = Math.max(half, Math.min(W - half, targetX));
    if (state.wideTimer > 0) { state.wideTimer--; if (state.wideTimer === 0) state.paddle.w = state.basePaddleW; }
    if (state.slowTimer > 0) state.slowTimer--;

    var b = state.ball;
    var px = b.x, py = b.y;
    b.x += b.vx / 60;
    b.y += b.vy / 60;

    if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    else if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

    if (b.vy > 0 && b.y + BALL_R >= PADDLE_Y && b.y + BALL_R <= PADDLE_Y + PADDLE_H + 4 &&
        b.x >= state.paddle.x - half && b.x <= state.paddle.x + half) {
      b.y = PADDLE_Y - BALL_R;
      var hit = (b.x - state.paddle.x) / half; // -1..1
      var sp = currentSpeed(state);
      b.vx = hit * 0.6 * sp;
      b.vy = -Math.sqrt(Math.max(0, sp * sp - b.vx * b.vx));
    }

    for (var i = 0; i < state.bricks.length; i++) {
      var br = state.bricks[i];
      if (!br.alive) continue;
      if (b.x + BALL_R < br.x || b.x - BALL_R > br.x + br.w ||
          b.y + BALL_R < br.y || b.y - BALL_R > br.y + br.h) continue;
      if (py - BALL_R >= br.y + br.h) { b.y = br.y + br.h + BALL_R; b.vy = Math.abs(b.vy); }
      else if (py + BALL_R <= br.y) { b.y = br.y - BALL_R; b.vy = -Math.abs(b.vy); }
      else if (px - BALL_R >= br.x + br.w) { b.x = br.x + br.w + BALL_R; b.vx = Math.abs(b.vx); }
      else { b.x = br.x - BALL_R; b.vx = -Math.abs(b.vx); }
      br.alive = false;
      state.score += BRICK_SCORE;
      if (br.power) state.powerups.push({ x: br.x + br.w / 2, y: br.y + br.h / 2, type: br.power, vy: 130 });
      break;
    }

    if (b.y - BALL_R > H) {
      state.lives--;
      if (state.lives <= 0) { state.over = true; return; }
      launchBall(state);
    }

    for (var k = state.powerups.length - 1; k >= 0; k--) {
      var p = state.powerups[k];
      p.y += p.vy / 60;
      if (p.y >= PADDLE_Y && p.y <= PADDLE_Y + PADDLE_H + 8 &&
          p.x >= state.paddle.x - half && p.x <= state.paddle.x + half) {
        applyPower(state, p.type);
        state.powerups.splice(k, 1);
      } else if (p.y > H) {
        state.powerups.splice(k, 1);
      }
    }

    // 清空本波 → 进入下一波（更密、更快、板更短）
    if (!state.over && state.bricks.every(function (br) { return !br.alive; })) {
      nextWave(state);
    }
  }

  function breakMult(score) {
    if (score >= 1500) return 3;
    if (score >= 800) return 2;
    if (score >= 400) return 1.5;
    if (score >= 200) return 1.2;
    if (score >= 100) return 1;
    if (score >= 60) return 0.8;
    if (score >= 30) return 0.5;
    return 0.2;
  }

  // 服务端权威回放：给定种子与逐帧横板目标 x 序列，重演得 {score, over, win, lives, level}
  function replay(seed, targetXs) {
    var state = createGame(seed);
    var n = Math.min(Array.isArray(targetXs) ? targetXs.length : 0, MAX_TICKS);
    for (var i = 0; i < n && !state.over; i++) {
      var x = typeof targetXs[i] === 'number' ? targetXs[i] : state.paddle.x;
      step(state, x);
    }
    return { score: state.score, over: state.over, win: state.win, lives: state.lives, level: state.level };
  }

  return {
    W: W, H: H, PADDLE_W: PADDLE_W, PADDLE_H: PADDLE_H, PADDLE_Y: PADDLE_Y,
    BALL_R: BALL_R, BALL_SPEED: BALL_SPEED,
    BRICK_COLS: BRICK_COLS, BRICK_ROWS: BRICK_ROWS,
    BRICK_W: BRICK_W, BRICK_H: BRICK_H, BRICK_GAP: BRICK_GAP, BRICK_TOP: BRICK_TOP, BRICK_LEFT: BRICK_LEFT,
    LIVES: LIVES, BRICK_SCORE: BRICK_SCORE, EXTRA_SCORE: EXTRA_SCORE,
    MAX_ROWS: MAX_ROWS, MIN_PADDLE_W: MIN_PADDLE_W, MAX_TICKS: MAX_TICKS,
    createGame: createGame, step: step, breakMult: breakMult, replay: replay,
  };
});
