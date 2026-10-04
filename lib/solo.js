'use strict';
// 单机小游戏逻辑（服务端权威）：
//   twentyfour 24 点：服务端出题，验证玩家表达式
//   pinball    弹球机：服务端种子 + 逐帧挡板/发射输入回放校验，按得分档倍率结算
//   breakout   打砖块：服务端种子 + 横板轨迹回放校验，按分数档倍率结算
//   snake      贪吃蛇：服务端种子 + 走位回放校验，按吃食数倍率结算
//
// 结算模型（新游戏统一）：入场门票（押注）= betQuota，先扣；
// 服务端权威得出「倍率 mult(0~3)」，奖励 = round(betQuota * mult)。

const breakout = require('../public/js/breakout-core');
const pinball = require('../public/js/pinball-core');

// ---------- 确定性 PRNG（mulberry32），用于贪吃蛇种子回放 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 24 点 ----------
// 生成 4 个 1~13 的数字（有解）
function twentyfourGen() {
  for (let tries = 0; tries < 200; tries++) {
    const nums = [];
    for (let i = 0; i < 4; i++) nums.push(1 + Math.floor(Math.random() * 13));
    if (twentyfourHasSolution(nums)) return nums;
  }
  // 兜底：一个必有解的固定题
  return [3, 3, 8, 8];
}

// 是否存在 (a,b,c,d) 通过 + - * / 得到 24
function twentyfourHasSolution(nums) {
  const EPS = 1e-6;
  const values = nums.map((n) => [n]);
  const search = (arr) => {
    if (arr.length === 1) return Math.abs(arr[0] - 24) < EPS;
    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < arr.length; j++) {
        if (i === j) continue;
        const rest = arr.filter((_, k) => k !== i && k !== j);
        const a = arr[i], b = arr[j];
        const nexts = [a + b, a - b, b - a, a * b];
        if (Math.abs(b) > EPS) nexts.push(a / b);
        if (Math.abs(a) > EPS) nexts.push(b / a);
        for (const v of nexts) {
          if (search(rest.concat(v))) return true;
        }
      }
    }
    return false;
  };
  return search(values);
}

// 安全求值：仅数字 + - * / ( ) 与空格，返回数值或 NaN
function evalExpr(expr) {
  const tokens = expr.match(/\d+(\.\d+)?|[+\-*/()]/g);
  if (!tokens) return NaN;
  let pos = 0;
  const peek = () => tokens[pos];
  const parseExpr = () => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++];
      const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseFactor = () => {
    if (peek() === '(') {
      pos++;
      const v = parseExpr();
      if (peek() === ')') pos++;
      return v;
    }
    const t = peek();
    if (t === '-') { pos++; return -parseFactor(); }
    pos++;
    return parseFloat(t);
  };
  const result = parseExpr();
  // 必须完全消费，且没有非法字符
  if (pos !== tokens.length) return NaN;
  return result;
}

// 验证：表达式只用这 4 个数字（各一次）且结果=24。
function twentyfourValidate(nums, expr) {
  const val = evalExpr(expr);
  if (Number.isNaN(val)) return { ok: false, kind: 'invalid', reason: '表达式不合法（仅支持数字与 + - * / 括号）' };
  const allNums = (expr.match(/\d+(\.\d+)?/g) || []).map(Number);
  const expect = nums.slice().sort((a, b) => a - b);
  const got = allNums.slice().sort((a, b) => a - b);
  if (JSON.stringify(expect) !== JSON.stringify(got)) {
    return { ok: false, kind: 'wrong_numbers', reason: '必须且只能使用给出的 4 个数字（各一次）' };
  }
  if (Math.abs(val - 24) > 1e-6) return { ok: false, kind: 'wrong', reason: `结果 = ${val}，不等于 24` };
  return { ok: true };
}

// ---------- 弹球机 Pinball（服务端种子回放校验） ----------
// 服务端权威：给定种子 + 逐帧输入 bitmask（左/右挡板 + 发射）序列，重演得 {score, over, balls}。
function pinballReplay(seed, inputs) {
  return pinball.replay(seed, inputs);
}

// ---------- 打砖块 Breakout（服务端种子回放校验） ----------
// 服务端权威：给定种子 + 逐帧横板目标 x 序列，重演得 {score, over, win, lives}。
function breakoutReplay(seed, targetXs) {
  return breakout.replay(seed, targetXs);
}

// ---------- 贪吃蛇 Snake（种子回放校验） ----------
const SNAKE_W = 15;
const SNAKE_H = 15;
const SNAKE_MAX_TICKS = 1500;
const DIR_DELTA = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

// 初始蛇：头在前，向右；初始长度 3。
function snakeInitial() {
  return [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }];
}

// 在蛇身之外随机生成一个食物；无空位返回 null。
function snakeSpawnFood(snake, rng) {
  const occ = new Set(snake.map((s) => s.x + ',' + s.y));
  if (occ.size >= SNAKE_W * SNAKE_H) return null;
  for (let tries = 0; tries < 500; tries++) {
    const x = Math.floor(rng() * SNAKE_W);
    const y = Math.floor(rng() * SNAKE_H);
    if (!occ.has(x + ',' + y)) return { x, y };
  }
  return null;
}

// 倍率：吃食越多奖励越高。
function snakeMult(score) {
  if (score >= 30) return 5;
  if (score >= 20) return 3;
  if (score >= 15) return 2;
  if (score >= 10) return 1.2;
  if (score >= 6) return 0.8;
  if (score >= 3) return 0.5;
  return 0.2;
}

// 回放：给定 seed 与逐 tick 的实际方向序列，服务端重演并得出权威得分。
// dirs[i] 为第 i 个 tick 蛇实际前进方向（U/D/L/R），越界/撞身即结束。
function snakeReplay(seed, dirs) {
  const rng = mulberry32(seed);
  let snake = snakeInitial();
  let score = 0;
  let food = snakeSpawnFood(snake, rng);
  const max = Math.min(Array.isArray(dirs) ? dirs.length : 0, SNAKE_MAX_TICKS);

  for (let i = 0; i < max; i++) {
    const d = dirs[i];
    const delta = DIR_DELTA[d];
    if (!delta) continue; // 非法方向：本 tick 不动（与客户端步进一致）
    const head = snake[0];
    const nx = head.x + delta[0];
    const ny = head.y + delta[1];
    if (nx < 0 || ny < 0 || nx >= SNAKE_W || ny >= SNAKE_H) {
      return { over: true, score, reason: 'wall' };
    }
    const body = snake.slice(0, snake.length - 1); // 尾巴本 tick 让开
    if (body.some((s) => s.x === nx && s.y === ny)) {
      return { over: true, score, reason: 'self' };
    }
    snake.unshift({ x: nx, y: ny });
    if (food && nx === food.x && ny === food.y) {
      score++;
      food = snakeSpawnFood(snake, rng);
    } else {
      snake.pop();
    }
    if (food === null) {
      return { over: true, score, reason: 'full' }; // 吃满全场
    }
  }
  return { over: false, score };
}

module.exports = {
  twentyfourGen, twentyfourValidate, twentyfourHasSolution,
  pinballReplay, pinballMult: pinball.mult,
  breakoutReplay, breakoutMult: breakout.breakMult,
  SNAKE_W, SNAKE_H, SNAKE_MAX_TICKS, snakeReplay, snakeMult, snakeInitial, snakeSpawnFood,
};
