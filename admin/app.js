'use strict';
// 游戏中心管理后台前端逻辑

const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('gc_admin_token') || '';
let currentTab = 'dash';
let currentSub = 'users';
let logTimer = null;

const CONFIG_SECTIONS = [
  { id: 'config', title: '运行配置', fields: [
    { key: 'port', label: '游戏端口', type: 'number' },
    { key: 'adminPort', label: '管理端口', type: 'number' },
    { key: 'publicUrl', label: '公网地址', type: 'text', ph: 'http://1.2.3.4:46110' },
    { key: 'quotaPerUnit', label: '1 美元 = 多少 quota', type: 'number' },
    { key: 'minBet', label: '押注下限（美元）', type: 'number' },
    { key: 'maxBet', label: '押注上限（美元）', type: 'number' },
    { key: 'turnTimeoutMs', label: '思考超时（毫秒）', type: 'number' },
    { key: 'bindingsFile', label: 'bindings.json 路径', type: 'text', ph: '/app/data/bindings.json' },
    { key: 'statsFile', label: '战绩文件', type: 'text' },
    { key: 'portfolioFile', label: '持仓文件', type: 'text' },
    { key: 'reversalsFile', label: '反转新闻文件', type: 'text' },
  ]},
  { id: 'api', title: 'API 配置', fields: [
    { key: 'newapiBase', label: 'NewAPI 地址', type: 'text', ph: 'https://covisuki.cn' },
    { key: 'newapiKey', label: 'NewAPI Key', type: 'password' },
    { key: 'aiModel', label: 'AI 模型', type: 'text' },
    { key: 'mysql.host', label: 'MySQL 主机', type: 'text' },
    { key: 'mysql.port', label: 'MySQL 端口', type: 'number' },
    { key: 'mysql.user', label: 'MySQL 用户', type: 'text' },
    { key: 'mysql.password', label: 'MySQL 密码', type: 'password' },
    { key: 'mysql.database', label: 'MySQL 库名', type: 'text' },
  ]},
  { id: 'news', title: '新闻设置', fields: [
    { key: 'news.dailyMin', label: '每日最少新闻数', type: 'number' },
    { key: 'news.dailyMax', label: '每日最多新闻数', type: 'number' },
    { key: 'news.ttlHours', label: '新闻时效（小时）', type: 'number' },
    { key: 'adminPassword', label: '管理员密码', type: 'password', ph: '修改后需重新登录' },
  ]},
];

// 游戏设置（按类分区：联机对战 / 单机小游戏 / 模拟股市）
// fb=回退到全局字段（押注/超时未按游戏覆盖时继承全局值，输入框留空即继承）
// 游戏设置（按类分组，每个游戏一个折叠块；股市设置项最丰富）。
// fb=回退到全局字段（押注/超时未按游戏覆盖时继承全局值，输入框留空即继承）
const GAME_GROUPS = [
  { cat: '⚔️ 联机对战', games: [
    { key: 'doudizhu', name: '斗地主', icon: '🃏', fields: [
      { key: 'games.doudizhu.enabled', label: '启用', type: 'bool' },
      { key: 'games.doudizhu.minBet', label: '押注下限（$）', type: 'number', fb: 'minBet' },
      { key: 'games.doudizhu.maxBet', label: '押注上限（$）', type: 'number', fb: 'maxBet' },
      { key: 'games.doudizhu.turnTimeoutMs', label: '思考超时（毫秒）', type: 'number', fb: 'turnTimeoutMs' },
      { key: 'games.doudizhu.allowDouble', label: '允许加倍阶段', type: 'bool' },
      { key: 'games.doudizhu.allowSuperDouble', label: '允许超级加倍 ×4', type: 'bool' },
      { key: 'games.doudizhu.allowSpring', label: '春天 / 反春翻倍', type: 'bool' },
    ]},
    { key: 'xiangqi', name: '象棋', icon: '♟️', fields: [
      { key: 'games.xiangqi.enabled', label: '启用', type: 'bool' },
      { key: 'games.xiangqi.minBet', label: '押注下限（$）', type: 'number', fb: 'minBet' },
      { key: 'games.xiangqi.maxBet', label: '押注上限（$）', type: 'number', fb: 'maxBet' },
      { key: 'games.xiangqi.turnTimeoutMs', label: '思考超时（毫秒）', type: 'number', fb: 'turnTimeoutMs' },
    ]},
    { key: 'gomoku', name: '五子棋', icon: '⚫', fields: [
      { key: 'games.gomoku.enabled', label: '启用', type: 'bool' },
      { key: 'games.gomoku.minBet', label: '押注下限（$）', type: 'number', fb: 'minBet' },
      { key: 'games.gomoku.maxBet', label: '押注上限（$）', type: 'number', fb: 'maxBet' },
      { key: 'games.gomoku.turnTimeoutMs', label: '思考超时（毫秒）', type: 'number', fb: 'turnTimeoutMs' },
    ]},
  ]},
  { cat: '🎰 单机小游戏', games: [
    { key: 'snake', name: '贪吃蛇', icon: '🐍', fields: [
      { key: 'games.snake.enabled', label: '启用', type: 'bool' },
      { key: 'games.snake.minBet', label: '押注下限（$）', type: 'number', fb: 'minBet' },
      { key: 'games.snake.maxBet', label: '押注上限（$）', type: 'number', fb: 'maxBet' },
      { key: 'games.snake.maxMult', label: '最高倍率', type: 'number', step: '0.1' },
    ]},
    { key: 'breakout', name: '打砖块', icon: '🎮', fields: [
      { key: 'games.breakout.enabled', label: '启用', type: 'bool' },
      { key: 'games.breakout.minBet', label: '押注下限（$）', type: 'number', fb: 'minBet' },
      { key: 'games.breakout.maxBet', label: '押注上限（$）', type: 'number', fb: 'maxBet' },
      { key: 'games.breakout.maxMult', label: '最高倍率', type: 'number', step: '0.1' },
    ]},
    { key: 'twentyfour', name: '24点', icon: '🧮', fields: [
      { key: 'games.twentyfour.enabled', label: '启用', type: 'bool' },
      { key: 'games.twentyfour.minBet', label: '押注下限（$）', type: 'number', fb: 'minBet' },
      { key: 'games.twentyfour.maxBet', label: '押注上限（$）', type: 'number', fb: 'maxBet' },
    ]},
  ]},
  { cat: '📈 模拟股市', games: [
    { key: 'market', name: '虚拟股市', icon: '📈', fields: [
      { key: 'games.market.enabled', label: '启用', type: 'bool' },
      { key: 'games.market.minBuyUsd', label: '单笔最低投入（$）', type: 'number' },
      { key: 'games.market.buyFeeRate', label: '买入手续费率（0.001=0.1%）', type: 'number', step: '0.0001' },
      { key: 'games.market.sellFeeRate', label: '卖出手续费率', type: 'number', step: '0.0001' },
      { key: 'games.market.limitPct', label: '涨跌停幅度（0.10=±10%）', type: 'number', step: '0.01' },
      { key: 'games.market.t0Every', label: 'T+0 间隔（每 N 只 1 只 T+0）', type: 'number' },
      { key: 'games.market.tPlusDays', label: 'T+N 结算（买入后第 N 天可卖）', type: 'number' },
      { key: 'games.market.auctionEnabled', label: '启用集合竞价', type: 'bool' },
      { key: 'games.market.auctionStart', label: '集合竞价开始（HH:mm）', type: 'text' },
      { key: 'games.market.auctionEnd', label: '集合竞价结束/定开盘价（HH:mm）', type: 'text' },
      { key: 'games.market.morningStart', label: '开盘时间（HH:mm）', type: 'text' },
      { key: 'games.market.morningEnd', label: '早盘结束（HH:mm）', type: 'text' },
      { key: 'games.market.lunchEnabled', label: '启用午间休市', type: 'bool' },
      { key: 'games.market.afternoonStart', label: '午盘开始（HH:mm）', type: 'text' },
      { key: 'games.market.afternoonEnd', label: '收盘时间（HH:mm）', type: 'text' },
      { key: 'games.market.weekendClosed', label: '周末休市', type: 'bool' },
    ]},
  ]},
];

function api(path, opts) {
  const o = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  return fetch(path, Object.assign({ headers }, o, { body: o.body ? JSON.stringify(o.body) : undefined }))
    .then(async (r) => {
      let j = {};
      try { j = await r.json(); } catch (e) { /* ignore */ }
      if (r.status === 401) { logout(false); throw new Error('登录已过期'); }
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
}

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function setPath(obj, key, val) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}
function getPath(obj, key) {
  let cur = obj;
  for (const p of key.split('.')) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ---- 登录 ----
function login() {
  const pw = $('pw').value;
  if (!pw) return;
  $('btnLogin').disabled = true;
  api('/api/admin/login', { method: 'POST', body: { password: pw } })
    .then((j) => {
      TOKEN = j.token;
      localStorage.setItem('gc_admin_token', TOKEN);
      showApp();
    })
    .catch((e) => { $('loginErr').textContent = e.message; })
    .finally(() => { $('btnLogin').disabled = false; });
}
function logout(manual) {
  TOKEN = '';
  localStorage.removeItem('gc_admin_token');
  if (manual) toast('已退出登录');
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('pw').value = '';
  if (logTimer) clearInterval(logTimer);
}
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('loginErr').textContent = '';
  loadDash();
  loadConfigForms();
  renderData();
  loadLogs();
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(() => { if ($('autoLogs').checked) loadLogs(); }, 3000);
}

// ---- tab 切换 ----
document.querySelectorAll('#nav a').forEach((a) => {
  a.onclick = () => switchTab(a.dataset.tab);
});
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.add('hidden'));
  $('tab-' + tab).classList.remove('hidden');
  if (tab === 'dash') loadDash();
  if (tab === 'data') renderData();
  if (tab === 'logs') loadLogs();
}
document.querySelectorAll('.tabs-bar a').forEach((a) => {
  a.onclick = () => { currentSub = a.dataset.sub; renderData(); };
});

// ---- 仪表盘 ----
function loadDash() {
  api('/api/admin/status').then((s) => {
    const usd = (q) => (q == null ? '—' : '$' + (q / (s.config ? s.config.quotaPerUnit : 500000)).toFixed(2));
    const cards = [
      ['版本', s.version || '—'],
      ['运行时长', fmtUptime(s.uptimeSec)],
      ['数据库', s.db ? '已连接' : '未连接', s.db ? 'ok' : 'bad'],
      ['房间', `${s.rooms.playing} 对战中 / ${s.rooms.waiting} 等待`],
      ['单机会话', s.soloSessions],
      ['内存', (s.memory.rss / 1048576).toFixed(0) + ' MB'],
    ];
    if (s.market) {
      cards.push(['股市指数', s.market.index != null ? s.market.index.toFixed(2) : '—']);
      cards.push(['股市新闻', s.market.news]);
      cards.push(['持仓用户', s.market.holdings]);
    }
    cards.push(['绑定关系', s.bindingsCount]);
    $('dashCards').innerHTML = cards.map(([k, v, cls]) =>
      `<div class="card"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`).join('');

    $('dashExtra').innerHTML =
      `<table>
        <tr><th>项</th><th>值</th></tr>
        <tr><td>数据库</td><td>${s.db ? `${s.dbInfo.host}:${s.dbInfo.port}/${s.dbInfo.database}` : '未配置'}</td></tr>
        <tr><td>NewAPI</td><td>${s.newapi || '未配置'}</td></tr>
        <tr><td>AI 模型</td><td>${s.aiModel || '—'}</td></tr>
        <tr><td>Node</td><td>${s.node}</td></tr>
        <tr><td>房间状态</td><td>${s.rooms.waiting} 等待 / ${s.rooms.playing} 对战 / ${s.rooms.finished} 已结束</td></tr>
      </table>`;
  }).catch((e) => toast(e.message, 'err'));
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + '天 ' : '') + h + '时 ' + m + '分';
}

// ---- 配置表单 ----
// 渲染单个字段（bool / number / text / password），返回 HTML 字符串
function renderField(f, config) {
  const v = getPath(config, f.key);
  if (f.type === 'bool') {
    const checked = v === true ? ' checked' : '';
    return `<div class="field" data-key="${f.key}" data-type="bool">
      <label>${f.label}</label>
      <input type="checkbox"${checked}>
    </div>`;
  }
  const val = f.type === 'password' && v ? '••••••••' : (v === undefined || v === null ? '' : v);
  // fb 字段：留空即继承全局值，placeholder 提示当前全局值
  let ph = f.ph || '';
  if (f.fb && (val === '' || val == null)) {
    const fbv = getPath(config, f.fb);
    ph = '继承全局 ' + (fbv === undefined || fbv === null ? '' : fbv);
  }
  return `<div class="field" data-key="${f.key}" data-type="${f.type}">
    <label>${f.label}</label>
    <input type="${f.type}" step="${f.step || ''}" placeholder="${escapeAttr(String(ph))}" value="${escapeAttr(String(val))}" ${f.type === 'password' ? 'data-masked="1"' : ''}>
  </div>`;
}

function loadConfigForms() {
  api('/api/admin/config').then(({ config }) => {
    // 1) 普通配置分区（运行 / API / 新闻）
    CONFIG_SECTIONS.forEach((sec) => {
      const box = $('form-' + sec.id);
      if (!box) return;
      box.innerHTML = sec.fields.map((f) => renderField(f, config)).join('') +
        `<div class="save-row" style="grid-column:1/-1"><button class="btn" data-save="${sec.id}">保存</button></div>`;
    });

    // 2) 游戏设置：按类分组，每个游戏一个折叠块
    const gbox = $('form-games');
    if (!gbox) return;
    gbox.innerHTML = GAME_GROUPS.map((grp) => {
      const gamesHtml = grp.games.map((g) => {
        const enabled = getPath(config, 'games.' + g.key + '.enabled');
        const on = enabled !== false;
        const badge = `<span class="fold-badge ${on ? 'on' : 'off'}">${on ? '已启用' : '已禁用'}</span>`;
        return `<details class="game-fold" data-game="${g.key}">
          <summary>${g.icon} <span class="fold-name">${g.name}</span>${badge}<span class="fold-arrow">▸</span></summary>
          <div class="form-grid">${g.fields.map((f) => renderField(f, config)).join('')}</div>
          <div class="save-row"><button class="btn" data-save="game:${g.key}">保存${g.name}</button></div>
        </details>`;
      }).join('');
      return `<div class="game-group"><div class="section-title">${grp.cat}</div>${gamesHtml}</div>`;
    }).join('');

    // 绑定保存按钮（普通分区 + 游戏折叠块）
    document.querySelectorAll('button[data-save]').forEach((b) => b.onclick = () => saveSection(b.dataset.save));
  }).catch((e) => toast(e.message, 'err'));
}

function saveSection(target) {
  let box;
  let label;
  if (target.startsWith('game:')) {
    const key = target.slice(5);
    box = document.querySelector('details[data-game="' + key + '"]');
    if (!box) return;
    const game = GAME_GROUPS.flatMap((grp) => grp.games).find((g) => g.key === key);
    label = (game && game.name) || key;
  } else {
    box = $('form-' + target);
    if (!box) return;
    label = target;
  }
  const patch = {};
  box.querySelectorAll('.field').forEach((field) => {
    const key = field.dataset.key;
    const type = field.dataset.type;
    const input = field.querySelector('input');
    if (type === 'bool') {
      setPath(patch, key, input.checked);
      return;
    }
    let val = input.value;
    if (input.dataset.masked && val === '••••••••') return; // 未修改密码，跳过
    if (type === 'number') {
      if (val === '') return; // 数字留空视为不修改（保留继承全局值）
      val = Number(val);
      if (Number.isNaN(val)) return;
    } else if (val === '') {
      return; // 文本留空视为不修改（保留默认/全局值）
    }
    setPath(patch, key, val);
  });
  api('/api/admin/config', { method: 'POST', body: { config: patch } })
    .then(() => toast(label + ' 已保存，重启后生效', 'ok'))
    .catch((e) => toast(e.message, 'err'));
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- 数据查看 ----
function renderData() {
  document.querySelectorAll('.tabs-bar a').forEach((a) => a.classList.toggle('active', a.dataset.sub === currentSub));
  const body = $('dataBody');
  body.innerHTML = '<div class="muted">加载中…</div>';
  if (currentSub === 'users') loadUsers();
  else if (currentSub === 'game') loadGameLB();
  else if (currentSub === 'market') loadMarketLB();
  else if (currentSub === 'bindings') loadBindings();
}

function loadUsers() {
  api('/api/admin/users').then(({ list }) => {
    $('dataBody').innerHTML = `<table>
      <tr><th>用户</th><th>ID</th><th class="num">持仓数</th><th class="num">市值</th><th class="num">盈亏</th></tr>
      ${list.map((u) => `<tr data-uid="${u.userId}" style="cursor:pointer">
        <td>${escapeHtml(u.name)}</td><td>${u.userId}</td>
        <td class="num">${u.stocks}</td><td class="num">$${u.marketValue.toFixed(2)}</td>
        <td class="num ${u.pnl >= 0 ? 'up' : 'down'}">${u.pnl >= 0 ? '+' : ''}$${u.pnl.toFixed(2)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无持仓用户</td></tr>'}
    </table>`;
    document.querySelectorAll('tr[data-uid]').forEach((tr) => tr.onclick = () => loadHoldings(tr.dataset.uid));
  }).catch((e) => toast(e.message, 'err'));
}

function loadHoldings(uid) {
  api('/api/admin/holdings?userId=' + uid).then(({ list, totalMarketValue, totalPnl }) => {
    $('dataBody').innerHTML = `<div class="save-row"><button class="btn ghost" id="backUsers">← 返回</button>
      <span class="muted">用户 ${uid} 持仓</span></div>
      <table>
        <tr><th>代码</th><th>名称</th><th class="num">持仓</th><th class="num">可卖</th><th class="num">现价</th><th class="num">市值</th><th class="num">盈亏</th><th></th></tr>
        ${list.map((h) => `<tr>
          <td>${h.code}</td><td>${escapeHtml(h.name)}</td>
          <td class="num">${h.shares}</td><td class="num">${h.available}</td>
          <td class="num">$${h.price.toFixed(2)}</td><td class="num">$${h.marketValue.toFixed(2)}</td>
          <td class="num ${h.pnl >= 0 ? 'up' : 'down'}">${h.pnl >= 0 ? '+' : ''}$${h.pnl.toFixed(2)}</td>
          <td><span class="tag">${h.t0 ? 'T+0' : 'T+1'}</span></td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">空仓</td></tr>'}
      </table>
      <p class="muted" style="margin-top:12px">合计市值 $${totalMarketValue.toFixed(2)} · 合计盈亏 $${totalPnl.toFixed(2)}</p>`;
    $('backUsers').onclick = loadUsers;
  }).catch((e) => toast(e.message, 'err'));
}

function loadGameLB() {
  const games = ['doudizhu', 'xiangqi', 'gomoku', 'snake', 'breakout', 'twentyfour'];
  const names = { doudizhu: '斗地主', xiangqi: '象棋', gomoku: '五子棋', snake: '贪吃蛇', breakout: '打砖块', twentyfour: '24点' };
  let sel = currentGameType || 'doudizhu';
  $('dataBody').innerHTML = `<div class="save-row">
    <select id="gameSel" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font:inherit">
      ${games.map((g) => `<option value="${g}" ${g === sel ? 'selected' : ''}>${names[g]}</option>`).join('')}
    </select>
  </div><div id="lbBox"></div>`;
  $('gameSel').onchange = () => { currentGameType = $('gameSel').value; fetchGameLB(currentGameType); };
  fetchGameLB(sel);
}
function fetchGameLB(gameType) {
  api('/api/admin/game/leaderboard?gameType=' + gameType).then(({ list }) => {
    const isSolo = gameType !== 'doudizhu' && gameType !== 'xiangqi' && gameType !== 'gomoku';
    $('lbBox').innerHTML = `<table>
      <tr><th>#</th><th>用户</th><th>ID</th>${isSolo ? '<th class="num">局数</th><th class="num">净赢($)</th><th class="num">最佳($)</th>' : '<th class="num">胜</th><th class="num">负</th><th class="num">平</th><th class="num">总</th>'}</tr>
      ${list.map((r, i) => `<tr>
        <td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.userId}</td>
        ${isSolo ? `<td class="num">${r.games}</td><td class="num ${r.netUsd >= 0 ? 'up' : 'down'}">${r.netUsd >= 0 ? '+' : ''}${r.netUsd}</td><td class="num">${r.bestUsd}</td>`
                  : `<td class="num">${r.win}</td><td class="num">${r.lose}</td><td class="num">${r.draw}</td><td class="num">${r.total}</td>`}
      </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无数据</td></tr>'}
    </table>`;
  }).catch((e) => toast(e.message, 'err'));
}

function loadMarketLB() {
  api('/api/admin/market/leaderboard').then(({ list }) => {
    $('dataBody').innerHTML = `<table>
      <tr><th>#</th><th>用户</th><th>ID</th><th class="num">持仓数</th><th class="num">市值</th><th class="num">盈亏</th></tr>
      ${list.map((r, i) => `<tr>
        <td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.userId}</td>
        <td class="num">${r.stocks}</td><td class="num">$${r.marketValue.toFixed(2)}</td>
        <td class="num ${r.pnl >= 0 ? 'up' : 'down'}">${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>'}
    </table>`;
  }).catch((e) => toast(e.message, 'err'));
}

function loadBindings() {
  api('/api/admin/bindings').then(({ list }) => {
    $('dataBody').innerHTML = `<table>
      <tr><th>QQ</th><th>userId</th><th>用户名</th></tr>
      ${list.map((b) => `<tr><td>${b.qq}</td><td>${b.userId}</td><td>${escapeHtml(b.username || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">暂无绑定</td></tr>'}
    </table>`;
  }).catch((e) => toast(e.message, 'err'));
}

// ---- 日志 ----
function loadLogs() {
  api('/api/admin/logs?n=300').then(({ logs }) => {
    $('logCount').textContent = logs.length + ' 条';
    $('logBox').innerHTML = logs.map((l) =>
      `<div class="log-line ${l.level}"><span class="ts">${new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>${escapeHtml(l.text)}</div>`
    ).join('');
    $('logBox').scrollTop = $('logBox').scrollHeight;
  }).catch((e) => toast(e.message, 'err'));
}

// ---- 全局事件 ----
$('loginForm').onsubmit = (e) => { e.preventDefault(); login(); };
$('btnLogout').onclick = () => logout(true);
$('btnRestart').onclick = () => {
  if (!confirm('确定重启服务吗？重启期间服务短暂不可用，容器/进程管理器会自动拉起。')) return;
  api('/api/admin/restart', { method: 'POST' }).then(() => toast('正在重启…', 'ok')).catch((e) => toast(e.message, 'err'));
};
$('btnRefreshLogs').onclick = loadLogs;

// 启动
if (TOKEN) showApp();
