/* pinball-core.js — 老式弹球机确定性核心引擎（共享：浏览器 <script> 与 Node require 通用）
 *
 * 设计要点（保证客户端游玩与服务端回放逐位一致）：
 *  - 帧驱动：每 tick 推进固定 1/60s；物理只用 + - * / 与 Math.sqrt/abs/floor/min/max（IEEE754 精确），
 *    不用 Math.sin/cos/tan（跨引擎不保证一致）。
 *  - 随机仅来自种子：发球/踢球抖动均由 mulberry32(seed) 决定。
 *  - 输入模型：每帧传入一个 0~7 的 bitmask（bit0=左挡板、bit1=右挡板、bit2=发射），
 *    客户端逐帧记录，服务端按同一序列重演得权威分数。
 *  - 结算：3 球制；挡板用「线段 bat」碰撞（rest 下垂 → 球可漏过，raised 上扬 → 接球），
 *    球漏到底部即失一球；分数按档倍率（最高 3x，期望 < 1）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PinballCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 版面常量（画布 480 x 640，竖版） ----
  var W = 480, H = 640;
  var BALL_R = 10;
  var G = 1150;            // 重力 px/s^2（模拟台面倾斜）
  var WALL_REST = 0.82;    // 侧墙/顶墙弹性
  var DRAIN_Y = 626;       // 球中心越过此 y 即漏球（下方无地板）
  var SLOPE = 90;          // 底部轻微向中心倾斜，防止球卡死
  var MAX_SPEED = 1400;

  // ---- 挡板（flipper）：线段 bat，rest 下垂 / raised 上扬（端点线性插值，免三角函数） ----
  var FLIP_SPEED = 0.30;
  var KICK_RADIUS = 72;    // 按下瞬间踢球触发半径（到线段的距离）
  var KICK_VX = 400;
  var KICK_VY = 820;
  var FL_L_ANCHOR = { x: 128, y: 552 };
  var FL_L_REST = { x: 100, y: 604 };
  var FL_L_RAISED = { x: 236, y: 542 };
  var FR_ANCHOR = { x: 352, y: 552 };
  var FR_REST = { x: 380, y: 604 };
  var FR_RAISED = { x: 244, y: 542 };

  // ---- 发射区（右侧垂直轨道 + 蓄力） ----
  var LANE_LEFT = 442;
  var LANE_X = 460, LANE_Y = 585;
  var LANE_TOP = 150;
  var DEFLECT_VX = -260;
  var LAUNCH_POWER_RATE = 0.022;
  var LAUNCH_BASE = 680;
  var LAUNCH_RANGE = 460;

  // ---- 得分物件 ----
  var BUMPER_SCORE = 30;
  var TARGET_SCORE = 50;
  var LANE_BONUS = 100;
  var SLING_SCORE = 20;
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
  var SLINGS = [
    { x: 148, y: 474, r: 18 },
    { x: 332, y: 474, r: 18 },
  ];

  var BALLS_PER_GAME = 3;
  var MAX_TICKS = 60 * 75;

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

  function flipperTip(flip, rest, raised) {
    return {
      x: rest.x + (raised.x - rest.x) * flip,
      y: rest.y + (raised.y - rest.y) * flip,
    };
  }

  // 点到线段距离
  function distToSeg(px, py, ax, ay, bx, by) {
    var abx = bx - ax, aby = by - ay;
    var t = ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby);
    t = Math.max(0, Math.min(1, t));
    var cx = ax + abx * t, cy = ay + aby * t;
    var dx = px - cx, dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // 圆-线段碰撞：把球推出并沿法线反射（rest 弹性）
  function collideSegment(ball, ax, ay, bx, by, rest) {
    var abx = bx - ax, aby = by - ay;
    var t = ((ball.x - ax) * abx + (ball.y - ay) * aby) / (abx * abx + aby * aby);
    t = Math.max(0, Math.min(1, t));
    var cx = ax + abx * t, cy = ay + aby * t;
    var dx = ball.x - cx, dy = ball.y - cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d >= BALL_R || d === 0) return false;
    var nx = dx / d, ny = dy / d;
    ball.x = cx + nx * BALL_R;
    ball.y = cy + ny * BALL_R;
    var vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= (1 + rest) * vn * nx;
      ball.vy -= (1 + rest) * vn * ny;
    }
    return true;
  }

  // 圆-圆碰撞
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
    if (s > MAX_SPEED) { var k = MAX_SPEED / s; b.vx *= k; b.vy *= k; }
  }

  function resetBall(state) {
    state.phase = 'launch';
    state.power = 0;
    state.ball = { x: LANE_X, y: LANE_Y, vx: 0, vy: 0 };
    state.flipL = 0; state.flipR = 0;
    state.prevLeft = false; state.prevRight = false;
    state.deflected = false;
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
      phase: 'launch', power: 0, deflected: false,
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
        state.ball.vx = (state.rng() * 2 - 1) * 26; // 发射横向抖动
        state.ball.vy = -sp;
        state.phase = 'play';
        state.power = 0;
      } else {
        state.power = 0;
      }
      updateFlippers(state, left, right);
      return;
    }

    updateFlippers(state, left, right);

    var b = state.ball;

    // 重力 + 底部向中心轻微倾斜
    b.vy += G / 60;
    if (b.y > DRAIN_Y - 120) {
      b.vx += (240 - b.x) >= 0 ? SLOPE / 60 : -(SLOPE / 60);
    }
    b.x += b.vx / 60;
    b.y += b.vy / 60;

    // 侧墙 / 顶墙
    if (b.x - BALL_R < 0) { b.x = BALL_R; if (b.vx < 0) b.vx = -b.vx * WALL_REST; }
    else if (b.x + BALL_R > W) { b.x = W - BALL_R; if (b.vx > 0) b.vx = -b.vx * WALL_REST; }
    if (b.y - BALL_R < 0) { b.y = BALL_R; if (b.vy < 0) b.vy = -b.vy * WALL_REST; }

    // 发射轨道：过顶口向左导流（带抖动）
    if (b.x > LANE_LEFT && !state.deflected && b.y < LANE_TOP && b.vy < 0) {
      b.vx = DEFLECT_VX + (state.rng() * 2 - 1) * 70;
      state.deflected = true;
    }
    // 弱发射回落轨道 → 回到蓄力态可重发
    if (b.x > LANE_LEFT && b.vy > 0 && b.y > LANE_Y + 6) {
      resetBall(state);
      return;
    }

    // 挡板（线段 bat）
    var lt = flipperTip(state.flipL, FL_L_REST, FL_L_RAISED);
    var rt = flipperTip(state.flipR, FR_REST, FR_RAISED);

    if (leftRising && distToSeg(b.x, b.y, FL_L_ANCHOR.x, FL_L_ANCHOR.y, lt.x, lt.y) < KICK_RADIUS) kickBall(state, b, 'L');
    if (rightRising && distToSeg(b.x, b.y, FR_ANCHOR.x, FR_ANCHOR.y, rt.x, rt.y) < KICK_RADIUS) kickBall(state, b, 'R');

    collideSegment(b, FL_L_ANCHOR.x, FL_L_ANCHOR.y, lt.x, lt.y, 1.0);
    collideSegment(b, FR_ANCHOR.x, FR_ANCHOR.y, rt.x, rt.y, 1.0);

    // 圆形挡板（bumper）
    for (var i = 0; i < BUMPERS.length; i++) {
      if (collideCircle(b, BUMPERS[i].x, BUMPERS[i].y, BUMPERS[i].r, 1.3)) {
        state.score += BUMPER_SCORE;
      }
    }

    // 弹射柱（slingshot）
    for (var s = 0; s < SLINGS.length; s++) {
      if (collideCircle(b, SLINGS[s].x, SLINGS[s].y, SLINGS[s].r, 1.15)) {
        state.score += SLING_SCORE;
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

    // 漏球：越过底部
    if (b.y - BALL_R > DRAIN_Y) { drainBall(state); return; }

    clampSpeed(b);
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

  // 倍率档：最高 3x，期望 < 1（典型局得分 300~700 → 0.3x~0.8x 左右）。
  function mult(score) {
    if (score >= 2500) return 3;
    if (score >= 1600) return 2;
    if (score >= 1000) return 1.3;
    if (score >= 600) return 0.8;
    if (score >= 350) return 0.5;
    if (score >= 180) return 0.3;
    return 0.1;
  }

  function replay(seed, inputs) {
    var state = createGame(seed);
    var n = Math.min(Array.isArray(inputs) ? inputs.length : 0, MAX_TICKS);
    for (var i = 0; i < n && !state.over; i++) {
      step(state, inputs[i] | 0);
    }
    return { score: state.score, over: state.over, balls: state.balls };
  }

  return {
    W: W, H: H, BALL_R: BALL_R, DRAIN_Y: DRAIN_Y,
    KICK_RADIUS: KICK_RADIUS,
    FL_L_ANCHOR: FL_L_ANCHOR, FL_L_REST: FL_L_REST, FL_L_RAISED: FL_L_RAISED,
    FR_ANCHOR: FR_ANCHOR, FR_REST: FR_REST, FR_RAISED: FR_RAISED,
    LANE_LEFT: LANE_LEFT, LANE_X: LANE_X, LANE_Y: LANE_Y, LANE_TOP: LANE_TOP,
    BUMPERS: BUMPERS, TARGETS: TARGETS, SLINGS: SLINGS,
    BALLS_PER_GAME: BALLS_PER_GAME, MAX_TICKS: MAX_TICKS,
    BUMPER_SCORE: BUMPER_SCORE, TARGET_SCORE: TARGET_SCORE, LANE_BONUS: LANE_BONUS, SLING_SCORE: SLING_SCORE,
    IN_LEFT: IN_LEFT, IN_RIGHT: IN_RIGHT, IN_LAUNCH: IN_LAUNCH,
    createGame: createGame, step: step, replay: replay, mult: mult,
    flipperTip: flipperTip,
  };
});
