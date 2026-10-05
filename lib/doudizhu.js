'use strict';
// 斗地主规则引擎（UMD，浏览器 + Node 通用）
// 服务端权威：洗牌、发牌、叫分、加倍、出牌校验、结算全部在服务端完成；
// 前端只负责渲染与把玩家操作发给服务端校验，不信任客户端任何计算结果。
//
// 牌编码：
//   rank：3~10 为数字，11=J，12=Q，13=K，14=A，15=2，16=小王，17=大王
//   suit：0=♠ 1=♥ 2=♣ 3=♦；小王 suit=4，大王 suit=5（仅用于展示，规则不计花色）
//
// 牌型 type：
//   single 单张 / pair 对子 / triple 三张 / triple1 三带一 / triple2 三带二
//   straight 顺子(≥5连) / pairStraight 连对(≥3连对)
//   airplane 飞机(不带) / airplaneSingle 飞机带单 / airplanePair 飞机带对
//   fourTwo 四带二(两单) / fourTwoPair 四带二(两对)
//   bomb 炸弹 / rocket 火箭(王炸)

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DouDiZhu = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ---------- 常量 ----------
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '王', 17: '王' };
  var SUIT_SYMBOL = ['♠', '♥', '♣', '♦'];
  var SEATS = 3;
  var HAND_SIZE = 17;
  var BOTTOM_SIZE = 3;

  // 飞机 / 顺子 / 连对的最大合法 rank（A=14，2 与王不进顺子）
  var MAX_CHAIN_RANK = 14;

  // ---------- 确定性 PRNG（可选 seed，便于测试） ----------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- 牌 ----------
  function createDeck() {
    var deck = [];
    for (var rank = 3; rank <= 15; rank++) {
      for (var suit = 0; suit < 4; suit++) deck.push({ rank: rank, suit: suit });
    }
    deck.push({ rank: 16, suit: 4 });
    deck.push({ rank: 17, suit: 5 });
    return deck;
  }

  function shuffle(deck, rng) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  // 手牌排序：rank 升序，同 rank 按 suit
  function sortCards(cards) {
    return cards.slice().sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.suit - b.suit;
    });
  }

  function cardId(c) { return c.rank * 10 + c.suit; }

  // ---------- 牌型分析 ----------
  function countByRank(cards) {
    var m = {};
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].rank;
      m[r] = (m[r] || 0) + 1;
    }
    return m;
  }

  // 把一手牌按张数分组
  function groupCards(cards) {
    var m = countByRank(cards);
    var fours = [], threes = [], pairs = [], singles = [];
    for (var r in m) {
      var cnt = m[r];
      var rank = parseInt(r, 10);
      if (cnt === 4) fours.push(rank);
      else if (cnt === 3) threes.push(rank);
      else if (cnt === 2) pairs.push(rank);
      else singles.push(rank);
    }
    var asc = function (a, b) { return a - b; };
    fours.sort(asc); threes.sort(asc); pairs.sort(asc); singles.sort(asc);
    return { fours: fours, threes: threes, pairs: pairs, singles: singles, map: m };
  }

  // 升序 rank 数组是否构成「连续且最大 ≤ A」（顺子/连对/飞机的通用判断）
  function isConsecutive(arr) {
    if (!arr.length) return false;
    for (var i = 1; i < arr.length; i++) {
      if (arr[i] !== arr[i - 1] + 1) return false;
    }
    return arr[arr.length - 1] <= MAX_CHAIN_RANK;
  }

  function isRocket(cards) {
    return cards.length === 2 &&
      ((cards[0].rank === 16 && cards[1].rank === 17) ||
       (cards[0].rank === 17 && cards[1].rank === 16));
  }

  // 带牌里是否含有「炸弹」（4 张同点）
  function hasQuad(map) {
    for (var r in map) if (map[r] === 4) return true;
    return false;
  }

  // 分析一手牌，返回 { type, rank, length } 或 null（非法）
  function analyze(cards) {
    if (!cards || !cards.length) return null;
    var n = cards.length;
    if (n === 1) return { type: 'single', rank: cards[0].rank, length: 1 };

    var g = groupCards(cards);
    var fours = g.fours, threes = g.threes, pairs = g.pairs, singles = g.singles;

    if (n === 2) {
      if (isRocket(cards)) return { type: 'rocket', rank: 17, length: 2 };
      if (pairs.length === 1) return { type: 'pair', rank: pairs[0], length: 2 };
      return null;
    }
    if (n === 3) {
      if (threes.length === 1) return { type: 'triple', rank: threes[0], length: 3 };
      return null;
    }
    if (n === 4) {
      if (fours.length === 1) return { type: 'bomb', rank: fours[0], length: 4 };
      if (threes.length === 1 && singles.length === 1) return { type: 'triple1', rank: threes[0], length: 4 };
      return null;
    }
    if (n === 5) {
      // 三带二（唯一可能：1 三张 + 1 对）
      if (threes.length === 1 && pairs.length === 1) return { type: 'triple2', rank: threes[0], length: 5 };
      // 顺子
      if (singles.length === 5 && isConsecutive(singles)) return { type: 'straight', rank: singles[4], length: 5 };
      return null;
    }

    // ---- n >= 6 ----
    // 顺子
    if (singles.length === n && isConsecutive(singles)) {
      return { type: 'straight', rank: singles[n - 1], length: n };
    }
    // 连对
    if (pairs.length === n / 2 && pairs.length * 2 === n && isConsecutive(pairs)) {
      return { type: 'pairStraight', rank: pairs[pairs.length - 1], length: n };
    }
    // 飞机（不带）
    if (threes.length === n / 3 && threes.length * 3 === n && isConsecutive(threes)) {
      return { type: 'airplane', rank: threes[threes.length - 1], length: n };
    }
    // 飞机带单 / 带对
    if (threes.length >= 2 && isConsecutive(threes)) {
      var wings = n - threes.length * 3;
      if (wings === threes.length) {
        // 带牌 = wings 张单牌，不能是炸弹、不能是火箭
        var rest = cards.filter(function (c) { return threes.indexOf(c.rank) === -1; });
        var restMap = countByRank(rest);
        if (!hasQuad(restMap) && !isRocket(rest)) {
          return { type: 'airplaneSingle', rank: threes[threes.length - 1], length: n };
        }
        return null;
      }
      if (wings === threes.length * 2 && pairs.length === threes.length) {
        // 带牌恰为 threes.length 对（无单张、无三张、无四张、无王）
        return { type: 'airplanePair', rank: threes[threes.length - 1], length: n };
      }
    }
    // 四带二（两单）
    if (fours.length === 1 && n === 6) {
      var r2 = cards.filter(function (c) { return c.rank !== fours[0]; });
      if (!isRocket(r2)) return { type: 'fourTwo', rank: fours[0], length: 6 };
      return null;
    }
    // 四带二（两对）
    if (fours.length === 1 && n === 8) {
      var r4 = cards.filter(function (c) { return c.rank !== fours[0]; });
      var rg = groupCards(r4);
      if (rg.pairs.length === 2 && rg.fours.length === 0 && rg.threes.length === 0 && rg.singles.length === 0) {
        return { type: 'fourTwoPair', rank: fours[0], length: 8 };
      }
      return null;
    }
    return null;
  }

  // 需要长度一致的牌型（长度可变的同类型牌，比大小时必须长度相同）
  function chainTypes() {
    return { straight: 1, pairStraight: 1, airplane: 1, airplaneSingle: 1, airplanePair: 1 };
  }

  // 判断 cur 能否压过 prev（prev 为 null 表示自由出牌）
  function canBeat(prev, cur) {
    if (!cur) return false;
    if (!prev) return true;
    if (prev.type === 'rocket') return false; // 火箭最大，不能被压
    if (cur.type === 'rocket') return true;
    if (cur.type === 'bomb') {
      if (prev.type === 'bomb') return cur.rank > prev.rank;
      return true;
    }
    if (prev.type === 'bomb') return false;
    if (cur.type !== prev.type) return false;
    if (chainTypes()[cur.type] && cur.length !== prev.length) return false;
    return cur.rank > prev.rank;
  }

  // ---------- 游戏状态机 ----------
  function DouDiZhu(opts) {
    opts = opts || {};
    this._rng = mulberry32(opts.seed == null ? ((Math.random() * 0x7fffffff) >>> 0) : opts.seed);
    // 规则开关（后台「游戏设置」可配置）：默认全开
    this.rules = {
      allowDouble: opts.allowDouble !== false,        // 是否启用「加倍」阶段
      allowSuperDouble: opts.allowSuperDouble !== false, // 是否允许超级加倍 ×4
      allowSpring: opts.allowSpring !== false,        // 春天 / 反春是否翻倍
    };
    this.reset();
  }

  DouDiZhu.prototype.reset = function () {
    var deck = shuffle(createDeck(), this._rng);
    this.hands = [[], [], []];
    for (var i = 0; i < SEATS; i++) {
      this.hands[i] = sortCards(deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE));
    }
    this.bottom = sortCards(deck.slice(SEATS * HAND_SIZE, SEATS * HAND_SIZE + BOTTOM_SIZE));
    this.landlord = -1;
    this.phase = 'bidding'; // bidding | doubling | playing | finished
    // 叫分
    this.bidStart = Math.floor(this._rng() * SEATS);
    this.bidSeat = this.bidStart;
    this.bids = [-1, -1, -1]; // -1 未表态，0 不叫，1/2/3 叫分
    this.highestBid = 0;
    this.highestBidSeat = -1;
    this.bidRound = 0;
    // 加倍
    this.doubleSeat = -1;
    this.doubleOrder = [];
    this.doubles = [1, 1, 1];
    // 出牌
    this.current = 0;
    this.lastPlay = null; // { seat, cards, type, rank, length }
    this.lastPlaySeat = -1;
    this.passCount = 0;
    this.playCounts = [0, 0, 0];
    this.bombCount = 0;
    // 结果
    this.winner = -1;
    this.landlordWon = false;
    this.spring = 0; // 0 无 / 1 春天 / 2 反春
    this.multiplier = 1;
    this.reason = '';
    this.redealt = false;
  };

  DouDiZhu.prototype.next = function (seat) { return (seat + 1) % SEATS; };
  DouDiZhu.prototype.isOver = function () { return this.phase === 'finished'; };

  // 当前叫分是否结束（叫到 3 分，或三轮结束有最高分）
  function biddingDone(state) {
    if (state.highestBid === 3) return true;
    return state.bidRound >= SEATS;
  }

  // 叫分：score 为 0(不叫)/1/2/3
  DouDiZhu.prototype.bid = function (seat, score) {
    if (this.phase !== 'bidding') return { ok: false, error: '当前不在叫分阶段' };
    if (seat !== this.bidSeat) return { ok: false, error: '还没轮到你叫分' };
    score = parseInt(score, 10);
    if (!(score >= 0 && score <= 3)) return { ok: false, error: '叫分只能是 0~3' };
    if (score > 0 && score <= this.highestBid) {
      return { ok: false, error: '叫分必须高于当前最高分或选择不叫' };
    }
    this.bids[seat] = score;
    if (score > this.highestBid) { this.highestBid = score; this.highestBidSeat = seat; }
    this.bidRound++;

    if (biddingDone(this)) {
      if (this.highestBid === 0) {
        // 流局：全部不叫，重新发牌
        this.redealt = true;
        this.reset();
        return { ok: true, redealt: true, phase: this.phase, bidStart: this.bidStart };
      }
      this._becomeLandlord(this.highestBidSeat);
      return { ok: true, phase: this.phase, landlord: this.landlord, bottom: this.bottom, state: this.getState() };
    }
    this.bidSeat = this.next(this.bidSeat);
    return { ok: true, phase: this.phase, bidSeat: this.bidSeat, highestBid: this.highestBid };
  };

  DouDiZhu.prototype._becomeLandlord = function (seat) {
    this.landlord = seat;
    this.hands[seat] = sortCards(this.hands[seat].concat(this.bottom));
    // 关闭加倍阶段时：直接进入出牌阶段，由地主先手
    if (!this.rules.allowDouble) {
      this.phase = 'playing';
      this.current = this.landlord;
      this.lastPlay = null;
      this.lastPlaySeat = -1;
      this.passCount = 0;
      return;
    }
    this.phase = 'doubling';
    // 加倍顺序：地主下家 → 地主上家 → 地主
    this.doubleOrder = [this.next(seat), this.next(this.next(seat)), seat];
    this.doubleSeat = this.doubleOrder[0];
  };

  // 加倍：factor 1(不加倍)/2(加倍)/4(超级加倍)
  DouDiZhu.prototype.double = function (seat, factor) {
    if (this.phase !== 'doubling') return { ok: false, error: '当前不在加倍阶段' };
    if (seat !== this.doubleSeat) return { ok: false, error: '还没轮到你加倍' };
    factor = parseInt(factor, 10);
    if (!this.rules.allowSuperDouble && factor === 4) {
      return { ok: false, error: '本局未启用超级加倍' };
    }
    if (factor !== 1 && factor !== 2 && factor !== 4) {
      return { ok: false, error: '加倍倍数只能是 1/2/4' };
    }
    this.doubles[seat] = factor;
    var idx = this.doubleOrder.indexOf(seat);
    if (idx >= this.doubleOrder.length - 1) {
      // 加倍结束，进入出牌阶段
      this.phase = 'playing';
      this.current = this.landlord;
      this.lastPlay = null;
      this.lastPlaySeat = -1;
      this.passCount = 0;
      return { ok: true, phase: this.phase, current: this.current, state: this.getState() };
    }
    this.doubleSeat = this.doubleOrder[idx + 1];
    return { ok: true, phase: this.phase, doubleSeat: this.doubleSeat, doubles: this.doubles.slice() };
  };

  // 出牌
  DouDiZhu.prototype.play = function (seat, cardIds) {
    if (this.phase !== 'playing') return { ok: false, error: '当前不在出牌阶段' };
    if (seat !== this.current) return { ok: false, error: '还没轮到你出牌' };
    var cards = this._cardsFromIds(seat, cardIds);
    if (!cards || !cards.length) return { ok: false, error: '请选择要出的牌' };
    var cur = analyze(cards);
    if (!cur) return { ok: false, error: '不是合法的牌型' };
    if (this.lastPlay && !canBeat(this.lastPlay, cur)) {
      return { ok: false, error: '管不上，请选择更大的牌或选择过' };
    }
    // 从手牌移除
    var removed = this._removeCards(seat, cards);
    if (!removed) return { ok: false, error: '手牌不足，出牌无效' };

    this.playCounts[seat]++;
    if (cur.type === 'bomb' || cur.type === 'rocket') this.bombCount++;
    this.lastPlay = { seat: seat, type: cur.type, rank: cur.rank, length: cur.length, cards: sortCards(cards) };
    this.lastPlaySeat = seat;
    this.passCount = 0;

    if (this.hands[seat].length === 0) {
      this._finish(seat);
      return { ok: true, over: true, state: this.getState(), result: this.resultView() };
    }
    this.current = this.next(seat);
    return { ok: true, over: false, state: this.getState() };
  };

  // 过（要不起）
  DouDiZhu.prototype.pass = function (seat) {
    if (this.phase !== 'playing') return { ok: false, error: '当前不在出牌阶段' };
    if (seat !== this.current) return { ok: false, error: '还没轮到你' };
    if (!this.lastPlay) return { ok: false, error: '必须出牌，不能跳过' };
    this.passCount++;
    if (this.passCount >= 2) {
      // 其余两家都过，lastPlay 落地，出牌者自由出牌
      this.lastPlay = null;
      this.current = this.lastPlaySeat;
    } else {
      this.current = this.next(seat);
    }
    return { ok: true, over: false, state: this.getState() };
  };

  DouDiZhu.prototype._finish = function (who) {
    this.phase = 'finished';
    this.landlordWon = (who === this.landlord);
    this.winner = this.landlordWon ? this.landlord : -2; // -2 表示农民方胜（两个农民）
    // 春天 / 反春
    var farmers = [];
    for (var i = 0; i < SEATS; i++) if (i !== this.landlord) farmers.push(i);
    if (this.landlordWon) {
      if (this.playCounts[farmers[0]] === 0 && this.playCounts[farmers[1]] === 0) this.spring = 1;
    } else {
      if (this.playCounts[this.landlord] <= 1) this.spring = 2;
    }
    // 结算倍数
    var doubleFactor = this.doubles[0] * this.doubles[1] * this.doubles[2];
    var springFactor = (this.spring && this.rules.allowSpring) ? 2 : 1;
    this.multiplier = this.highestBid * doubleFactor * Math.pow(2, this.bombCount) * springFactor;
    this.reason = this.spring === 1 ? '春天' : (this.spring === 2 ? '反春' : '正常结束');
  };

  DouDiZhu.prototype._cardsFromIds = function (seat, cardIds) {
    if (!Array.isArray(cardIds)) return null;
    var hand = this.hands[seat];
    var out = [];
    var used = {};
    for (var i = 0; i < cardIds.length; i++) {
      var id = parseInt(cardIds[i], 10);
      var found = null;
      for (var j = 0; j < hand.length; j++) {
        if (cardId(hand[j]) === id && !used[j]) { found = hand[j]; used[j] = true; break; }
      }
      if (!found) return null;
      out.push(found);
    }
    return out;
  };

  DouDiZhu.prototype._removeCards = function (seat, cards) {
    var hand = this.hands[seat];
    var removeIds = {};
    for (var i = 0; i < cards.length; i++) removeIds[cardId(cards[i])] = (removeIds[cardId(cards[i])] || 0) + 1;
    var remaining = [];
    var removedCount = 0;
    for (var j = 0; j < hand.length; j++) {
      var id = cardId(hand[j]);
      if (removeIds[id] > 0) { removeIds[id]--; removedCount++; }
      else remaining.push(hand[j]);
    }
    if (removedCount !== cards.length) return false;
    this.hands[seat] = remaining;
    return true;
  };

  // 完整状态（仅服务端）
  DouDiZhu.prototype.getState = function () {
    return {
      phase: this.phase,
      landlord: this.landlord,
      bottom: this.bottom,
      rules: this.rules,
      handSizes: [this.hands[0].length, this.hands[1].length, this.hands[2].length],
      hands: this.hands,
      current: this.current,
      bidSeat: this.bidSeat,
      bids: this.bids,
      highestBid: this.highestBid,
      doubleSeat: this.doubleSeat,
      doubleOrder: this.doubleOrder,
      doubles: this.doubles,
      lastPlay: this.lastPlay ? { seat: this.lastPlay.seat, type: this.lastPlay.type, rank: this.lastPlay.rank, length: this.lastPlay.length, cards: this.lastPlay.cards } : null,
      lastPlaySeat: this.lastPlaySeat,
      playCounts: this.playCounts,
      bombCount: this.bombCount,
    };
  };

  // 某座位视角（不含他人手牌）
  DouDiZhu.prototype.viewFor = function (seat) {
    var s = this.getState();
    s.me = this.hands[seat];
    s.hands = undefined;
    delete s.hands;
    return s;
  };

  // 结算结果视图
  DouDiZhu.prototype.resultView = function () {
    return {
      landlord: this.landlord,
      landlordWon: this.landlordWon,
      spring: this.spring,
      reason: this.reason,
      bombCount: this.bombCount,
      highestBid: this.highestBid,
      doubles: this.doubles.slice(),
      multiplier: this.multiplier,
      playCounts: this.playCounts.slice(),
    };
  };

  return {
    RANK_LABEL: RANK_LABEL,
    SUIT_SYMBOL: SUIT_SYMBOL,
    SEATS: SEATS,
    HAND_SIZE: HAND_SIZE,
    BOTTOM_SIZE: BOTTOM_SIZE,
    createDeck: createDeck,
    shuffle: shuffle,
    sortCards: sortCards,
    cardId: cardId,
    analyze: analyze,
    canBeat: canBeat,
    mulberry32: mulberry32,
    DouDiZhu: DouDiZhu,
  };
});
