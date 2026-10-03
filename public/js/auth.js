// 登录态管理：localStorage 存 token/username，提供登录/登出/登录条渲染。
(function () {
  const KEY = 'gc_auth';

  function getAuth() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function setAuth(token, username) {
    localStorage.setItem(KEY, JSON.stringify({ token, username }));
  }
  function clearAuth() {
    localStorage.removeItem(KEY);
  }
  function getToken() { return getAuth().token || ''; }
  function getUserName() { return getAuth().username || ''; }

  async function login(username, password) {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json();
    if (r.status !== 200 || j.code !== 'ok') return { error: j.error || '登录失败' };
    setAuth(j.token, j.username);
    return { token: j.token, username: j.username, quota: j.quota };
  }

  async function me() {
    const token = getToken();
    if (!token) return null;
    try {
      const r = await fetch('/api/auth/me?token=' + encodeURIComponent(token));
      if (r.status !== 200) { clearAuth(); return null; }
      const j = await r.json();
      return { token, username: j.username, quota: j.quota };
    } catch (e) { return null; }
  }

  function logout() {
    const token = getToken();
    if (token) fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {});
    clearAuth();
  }

  // 在 container 渲染登录条。onLogin 登录成功后回调。
  async function renderAuthBar(container, onLogin) {
    const state = await me();
    container.innerHTML = '';
    container.className = 'auth-bar';
    if (state) {
      const u = document.createElement('div');
      u.className = 'auth-user';
      u.innerHTML = '👤 <b>' + escapeHtml(state.username) + '</b>';
      if (state.quota != null) {
        const q = document.createElement('span');
        q.className = 'auth-quota';
        q.textContent = '余额 $' + (state.quota / 500000).toFixed(2);
        u.appendChild(q);
      }
      const btn = document.createElement('button');
      btn.className = 'auth-btn';
      btn.textContent = '退出';
      btn.onclick = () => { logout(); renderAuthBar(container, onLogin); };
      u.appendChild(btn);
      container.appendChild(u);
      if (onLogin) onLogin(state);
    } else {
      const form = document.createElement('div');
      form.className = 'auth-form';
      form.innerHTML =
        '<input id="authUser" type="text" placeholder="NewAPI 用户名" autocomplete="username">' +
        '<input id="authPass" type="password" placeholder="密码" autocomplete="current-password">' +
        '<button id="authBtn" class="primary">登录</button>';
      container.appendChild(form);
      container.querySelector('#authBtn').onclick = async () => {
        const u = container.querySelector('#authUser').value.trim();
        const p = container.querySelector('#authPass').value;
        if (!u || !p) { alert('请输入用户名和密码'); return; }
        const r = await login(u, p);
        if (r.error) { alert(r.error); return; }
        await renderAuthBar(container, onLogin);
      };
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 对战重连：按游戏类型保存/读取/清除「最近一次对局」的 room/player/token。
  // 用于玩家中途退出后重新进入对战页时恢复连接。
  const BATTLE_PREFIX = 'gc_battle_';
  function saveBattle(gameType, roomId, player, token) {
    try { localStorage.setItem(BATTLE_PREFIX + gameType, JSON.stringify({ roomId, player, token, at: Date.now() })); } catch (e) { /* ignore */ }
  }
  function loadBattle(gameType) {
    try { return JSON.parse(localStorage.getItem(BATTLE_PREFIX + gameType)) || null; } catch (e) { return null; }
  }
  function clearBattle(gameType) {
    try { localStorage.removeItem(BATTLE_PREFIX + gameType); } catch (e) { /* ignore */ }
  }

  window.GCAuth = { getToken, getUserName, login, logout, me, renderAuthBar, isLoggedIn: () => !!getToken(), saveBattle, loadBattle, clearBattle };
})();
