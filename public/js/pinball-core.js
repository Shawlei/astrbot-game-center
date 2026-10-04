/* pinball-core.js — 老式弹球机确定性核心引擎（共享：浏览器 <script> 与 Node require 通用）
 *
 * 设计要点（保证客户端游玩与服务端回放逐位一致）：
 *  - 帧驱动：每 tick 推进固定 1/60s；物理只用 + - * / 与 Math.sqrt/abs/floor/min/max（IEEE754 精确），
 *    不用 Math.sin/cos/tan（跨引擎不保证一致）。
 *  - 随机仅来自种子：发球抖动、踢球抖动均由 mulberry32(seed) 决定。
 *  - 输入模型：每帧传入一个 0~7 的 bitmask（bit0=左挡板、bit1=右挡板、bit2=发射），
 *    客户端逐帧记录，服务端按同一序列重演得权威分数。
 *  - 结算：3 球制，底部中央为漏球口，分数按档倍率（最高 3x，期望 < 1）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PinballCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 版面常量（画布 480 x 640，竖版） ----
  var W = 480, H = 640;
  var BALL_R = 10;
  var G = 1200;            // 重力 px/s^2（模拟台面倾斜）
  var WALL_REST = 0.82;    // 侧墙/顶墙弹性
  var FLOOR_Y = 592;       // 底部平台
  var DRAIN_HALF = 32;     // 漏球口半宽（相对中心 x=240）
  var FLOOR_REST = 0.68;   // 平台弹性
  var SLOPE = 130;         // 底部轻微向中心倾斜，防止球卡死
  var MAX_SPEED = 1400;

  // ---- 挡板（flipper）----
  // 物理上用「挡板尖端圆形」做碰撞体，rest/raised 两个端点线性插值（免三角函数）。
  var FLIP_R = 30;         // 挡板碰撞半径
  var FLIP_SPEED = 0.34;   // 每 tick 挡板开合进度
  var KICK_RADIUS = 66;    // 按下瞬间的踢球触发半径
  var KICK_VX = 420;
  var KICK_VY = 950;
  var FL_L_REST = { x: 178, y: 556 };
  var FL_L_RAISED = { x: 222, y: 546 };
  var FR_REST = { x: 302, y: 556 };
  var FR_RAISED = { x: 258, y: 546 };
  // 渲染用的挡板转轴（画线起点）
  var FL_L_ANCHOR = { x: 140, y: 596 };
  var FR_ANCHOR = { x: 340, y: 596 };

  // ---- 发射区（底部右侧） ----
  var LANE_X = 424, LANE_Y = 558;
  var LAUNCH_POWER_RATE = 0.022; // 每 tick 蓄力增量
  var LAUNCH_BASE = 650;
  var LAUNCH_RANGE = 480;
  var LAUNCH_VX = -150;   // 发射后向左上进入盘面

  // ---- 得分物件 ----
  var BUMPER_SCORE = 30;
  var TARGET_SCORE = 50;
  var LANE_BONUS = 100;
  var BUMPERS = [
    { x: 138, y: 200, r: 26 },
    { x: 240, y: 156, r: 26 },
    { x: 342, y: 200, r: 26 },
  ];
  var TARGETS = [
    { x: 240, y: 84, r: 22 },
    { x: 118, y: 128, r: 22 },
    { x: 362, y: 128, r: 22 },
  ];

  var BALLS_PER_GAME = 3;
  var MAX_TICKS = 60 * 90; // 服务端回放安全上限（90 秒）

  // 输入 bitmask
  var IN_LEFT = 1, IN_RIGHT = 2, IN_LAUNCH = 4;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function flipperCenter(flip, rest, raised) {
    return {
      x: rest.x + (raised.x - rest.x) * flip,
      y: rest.y + (raised.y - rest.y) * flip,
    };
  }

  // 圆-圆碰撞：把球推出并沿法线反射（rest 为弹性系数）
  function collideCircle(ball, cx, cy, cr, rest) {
    var dx = ball.x - cx, dy = ball.y - cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var minD = BALL_R + cr;
    if (d >= minD || d === 0) return false;
    var nx = dx / d, ny = dy / d;
    ball.x = cx + nx * minD;
    ball.y = cy + ny * minD;
    var vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= (1 + rest) * vn * nx;
      ball.vy -= (1 + rest) * vn * ny;
    }
    return true;
  }

  function clampSpeed(b) {
    var s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (s > MAX_SPEED) {
      var k = MAX_SPEED / s;
      b.vx *= k; b.vy *= k;
    }
  }

  function resetBall(state) {
    state.phase = 'launch';
    state.power = 0;
    state.ball = { x: LANE_X, y: LANE_Y, vx: 0, vy: 0 };
    state.flipL = 0; state.flipR = 0;
    state.prevLeft = false; state.prevRight = false;
    state.targets = TARGETS.map(function (t) { return { x: t.x, y: t.y, r: t.r, active: true }; });
    state.laneBonusAvail = true;
  }

  function drainBall(state) {
    state.balls--;
    if (state.balls <= 0) { state.over = true; return; }
    resetBall(state);
  }

  function createGame(seed) {
    var state = {
      rng: mulberry32(seed >>> 0),
      score: 0, balls: BALLS_PER_GAME, over: false,
      phase: 'launch', power: 0,
      ball: { x: LANE_X, y: LANE_Y, vx: 0, vy: 0 },
      flipL: 0, flipR: 0, prevLeft: false, prevRight: false,
      targets: TARGETS.map(function (t) { return { x: t.x, y: t.y, r: t.r, active: true }; }),
      laneBonusAvail: true,
      tick: 0,
    };
    return state;
  }

  function step(state, inp) {
    if (state.over) return;
    state.tick++;
    var n = inp | 0;
    var left = (n & IN_LEFT) !== 0;
    var right = (n & IN_RIGHT) !== 0;
    var launch = (n & IN_LAUNCH) !== 0;

    var leftRising = left && !state.prevLeft;
    var rightRising = right && !state.prevRight;

    // ---- 发射阶段：蓄力 → 释放发射 ----
    if (state.phase === 'launch') {
      if (launch) {
        state.power = Math.min(1, state.power + LAUNCH_POWER_RATE);
      } else if (state.power > 0.04) {
        var sp = LAUNCH_BASE + LAUNCH_RANGE * state.power;
        state.ball.vx = LAUNCH_VX + (state.rng() * 2 - 1) * 40;
        state.ball.vy = -sp;
        state.phase = 'play';
        state.power = 0;
      } else {
        state.power = 0;
      }
      // 挡板动画仍可响应（无踢球）
      updateFlippers(state, left, right);
      return;
    }

    updateFlippers(state, left, right);

    var b = state.ball;

    // 重力 + 底部向中心轻微倾斜
    b.vy += G / 60;
    if (b.y > FLOOR_Y - 44) {
      b.vx += (240 - b.x) >= 0 ? SLOPE / 60 : -(SLOPE / 60);
    }
    b.x += b.vx / 60;
    b.y += b.vy / 60;

    // 侧墙 / 顶墙
    if (b.x - BALL_R < 0) { b.x = BALL_R; if (b.vx < 0) b.vx = -b.vx * WALL_REST; }
    else if (b.x + BALL_R > W) { b.x = W - BALL_R; if (b.vx > 0) b.vx = -b.vx * WALL_REST; }
    if (b.y - BALL_R < 0) { b.y = BALL_R; if (b.vy < 0) b.vy = -b.vy * WALL_REST; }

    // 挡板碰撞
    var lc = flipperCenter(state.flipL, FL_L_REST, FL_L_RAISED);
    var rc = flipperCenter(state.flipR, FR_REST, FR_RAISED);

    if (leftRising && dist(b, lc) < KICK_RADIUS) kickBall(state, b, 'L');
    if (rightRising && dist(b, rc) < KICK_RADIUS) kickBall(state, b, 'R');

    if (collideCircle(b, lc.x, lc.y, FLIP_R, 1.0)) {
      if (state.flipL > 0.5 && b.vy > -120) b.vy = -Math.abs(b.vy) - 160;
    }
    if (collideCircle(b, rc.x, rc.y, FLIP_R, 1.0)) {
      if (state.flipR > 0.5 && b.vy > -120) b.vy = -Math.abs(b.vy) - 160;
    }

    // 圆形挡板（bumper）：命中得分 + 弹开
    for (var i = 0; i < BUMPERS.length; i++) {
      if (collideCircle(b, BUMPERS[i].x, BUMPERS[i].y, BUMPERS[i].r, 1.3)) {
        state.score += BUMPER_SCORE;
      }
    }

    // 一次性靶子
    for (var j = 0; j < state.targets.length; j++) {
      var t = state.targets[j];
      if (t.active && collideCircle(b, t.x, t.y, t.r, 0.9)) {
        t.active = false;
        state.score += TARGET_SCORE;
      }
    }

    // 顶部奖励通道（一次性）
    if (state.laneBonusAvail && b.y < 70) {
      state.laneBonusAvail = false;
      state.score += LANE_BONUS;
    }

    // 底部平台 / 漏球口
    if (b.y + BALL_R > FLOOR_Y) {
      if (Math.abs(b.x - 240) < DRAIN_HALF + BALL_R) {
        // 在漏球口上方：自由下落
      } else {
        b.y = FLOOR_Y - BALL_R;
        if (b.vy > 0) b.vy = -b.vy * FLOOR_REST;
      }
    }
    if (b.y - BALL_R > H) { drainBall(state); return; }

    clampSpeed(b);
  }

  function dist(b, c) {
    var dx = b.x - c.x, dy = b.y - c.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function kickBall(state, b, side) {
    if (side === 'L') {
      b.vx = KICK_VX + (state.rng() * 2 - 1) * 60;
      b.vy = -KICK_VY + (state.rng() * 2 - 1) * 40;
    } else {
      b.vx = -KICK_VX + (state.rng() * 2 - 1) * 60;
      b.vy = -KICK_VY + (state.rng() * 2 - 1) * 40;
    }
  }

  function updateFlippers(state, left, right) {
    if (left) state.flipL = Math.min(1, state.flipL + FLIP_SPEED);
    else state.flipL = Math.max(0, state.flipL - FLIP_SPEED);
    if (right) state.flipR = Math.min(1, state.flipR + FLIP_SPEED);
    else state.flipR = Math.max(0, state.flipR - FLIP_SPEED);
    state.prevLeft = left;
    state.prevRight = right;
  }

  // 倍率档：按最终得分，最高 3x，期望 < 1（典型局得分 400~600 → 0.5x 左右）。
  function mult(score) {
    if (score >= 2500) return 3;
    if (score >= 1600) return 2;
    if (score >= 1000) return 1.3;
    if (score >= 600) return 0.8;
    if (score >= 350) return 0.5;
    if (score >= 180) return 0.3;
    return 0.1;
  }

  // 服务端权威回放：给定种子 + 逐帧输入 bitmask 序列，重演得 {score, over, balls}
  function replay(seed, inputs) {
    var state = createGame(seed);
    var n = Math.min(Array.isArray(inputs) ? inputs.length : 0, MAX_TICKS);
    for (var i = 0; i < n && !state.over; i++) {
      step(state, inputs[i] | 0);
    }
    return { score: state.score, over: state.over, balls: state.balls };
  }

  return {
    W: W, H: H, BALL_R: BALL_R, FLOOR_Y: FLOOR_Y, DRAIN_HALF: DRAIN_HALF,
    FLIP_R: FLIP_R, KICK_RADIUS: KICK_RADIUS,
    FL_L_REST: FL_L_REST, FL_L_RAISED: FL_L_RAISED, FL_L_ANCHOR: FL_L_ANCHOR,
    FR_REST: FR_REST, FR_RAISED: FR_RAISED, FR_ANCHOR: FR_ANCHOR,
    LANE_X: LANE_X, LANE_Y: LANE_Y,
    BUMPERS: BUMPERS, TARGETS: TARGETS,
    BALLS_PER_GAME: BALLS_PER_GAME, MAX_TICKS: MAX_TICKS,
    BUMPER_SCORE: BUMPER_SCORE, TARGET_SCORE: TARGET_SCORE, LANE_BONUS: LANE_BONUS,
    IN_LEFT: IN_LEFT, IN_RIGHT: IN_RIGHT, IN_LAUNCH: IN_LAUNCH,
    createGame: createGame, step: step, replay: replay, mult: mult,
    flipperCenter: flipperCenter,
  };
});
