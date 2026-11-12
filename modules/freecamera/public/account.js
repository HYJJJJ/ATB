import { connectSignal } from './signal.js';
const $ = id => document.getElementById(id);
export function createAccountPanel({ onLogin, onLogout, onSelect, report, camera = false }) {
  let user = null, setup = false, socket = null, timer = null, disposed = false, selected = null, selecting = false, devices = [], version = 0, refreshTask = null, editing = null, savingRemark = false;
  async function api(action, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`/api/auth/${action}`, { signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || '账户请求失败'); return data;
    } finally { clearTimeout(timeout); }
  }
  function stopCatalog() { clearTimeout(timer); const old = socket; socket = null; old?.close(); }
  function finishRemark() { editing = null; savingRemark = false; $('remark-form').hidden = true; $('remark-input').value = ''; }
  function remarkReady(text = '') { savingRemark = false; $('remark-save').disabled = false; $('remark-cancel').disabled = false; $('remark-status').textContent = text; }
  function renderList() {
    const list = $('camera-list'); list.replaceChildren();
    $('camera-list-empty').hidden = devices.length > 0;
    for (const device of devices) {
      const item = document.createElement('li'); item.className = 'device-item'; item.dataset.deviceId = device.deviceId;
      item.classList.toggle('selected', selected === device.deviceId);
      const detail = document.createElement('div'), name = document.createElement('strong'), state = document.createElement('span'), button = document.createElement('button');
      const label = device.remark || device.name;
      name.textContent = label;
      detail.append(name);
      if (device.remark) { const original = document.createElement('span'); original.className = 'device-original muted'; original.textContent = device.name; detail.append(original); }
      state.textContent = `${device.online ? '● 在线' : '○ 离线'} · ${device.viewers} 位观看者`; state.className = device.online ? 'device-online' : 'muted';
      detail.append(state); button.type = 'button'; button.className = 'device-connect';
      button.textContent = selected === device.deviceId ? '重新连接' : device.online ? '连接' : '等待上线';
      button.setAttribute('aria-label', `${device.online ? '连接' : '等待'} ${label}`); button.disabled = selecting;
      button.addEventListener('click', async () => {
        if (selecting) return; selecting = true; renderList();
        try { await onSelect(device); } catch (error) { report(error.message); }
        finally { selecting = false; renderList(); }
      });
      const actions = document.createElement('div'), edit = document.createElement('button'); actions.className = 'device-actions'; edit.type = 'button'; edit.className = 'device-remark text-button'; edit.textContent = '备注'; edit.setAttribute('aria-label', `备注 ${label}`); edit.disabled = savingRemark;
      edit.addEventListener('click', () => { editing = device.deviceId; $('remark-form').hidden = false; $('remark-label').textContent = `备注：${device.name}`; $('remark-input').value = device.remark || ''; remarkReady(); $('remark-input').focus(); });
      actions.append(button, edit); item.append(detail, actions); list.append(item);
      if (selected === device.deviceId) $('device-name').textContent = label;
    }
  }
  $('remark-cancel').addEventListener('click', finishRemark);
  $('remark-form').addEventListener('submit', event => {
    event.preventDefault(); if (!editing || savingRemark) return;
    if (socket?.readyState !== WebSocket.OPEN) { remarkReady('服务尚未连接，请稍后保存'); return; }
    savingRemark = true; $('remark-save').disabled = true; $('remark-cancel').disabled = true; $('remark-status').textContent = '正在保存…'; renderList();
    socket.send(JSON.stringify({ type: 'device-remark', deviceId: editing, remark: $('remark-input').value }));
  });
  async function showLogin(message = '') {
    user = null; stopCatalog(); finishRemark(); devices = []; selected = null; renderList();
    $('account-bar').hidden = true; $('view-workspace').hidden = true; $('auth-panel').hidden = false;
    $('auth-error').textContent = message; $('auth-error').hidden = !message;
    await onLogout();
  }
  function connectCatalog() {
    stopCatalog(); if (!user || disposed) return;
    $('catalog-status').textContent = '正在读取摄像头列表…';
    socket = connectSignal({
    onOpen(ws) { if (socket === ws) ws.send(JSON.stringify({ type: 'catalog' })); },
    onMessage(ws, event) {
      if (socket !== ws) return;
      const message = JSON.parse(event.data);
      if (message.type === 'devices') { devices = message.devices; renderList(); $('catalog-status').textContent = `${devices.filter(device => device.online).length} 台在线 / 共 ${devices.length} 台`; }
      else if (message.type === 'device-remark-saved' && message.deviceId === editing) { finishRemark(); renderList(); }
      else if (message.type === 'error' && message.code === 'invalid-remark') { remarkReady('备注保存失败，请检查设备及备注长度'); renderList(); }
      else if (message.type === 'error' && message.code === 'login-required') void refreshSession();
    },
    onClose(ws, event) {
      if (socket !== ws || disposed) return; socket = null;
      if (savingRemark) { remarkReady('连接中断，恢复后请重新保存'); renderList(); }
      if (event.code === 4001) { void refreshSession(); return; }
      $('catalog-status').textContent = '服务连接中断，正在重连…';
      timer = setTimeout(() => void refreshSession(), 1500);
    },
    });
  }
  function signedIn(nextUser) {
    user = nextUser; setup = false; $('auth-password').value = ''; $('auth-confirm').value = '';
    $('auth-panel').hidden = true; $('account-bar').hidden = false; $('view-workspace').hidden = false;
    $('account-name').textContent = `${user.username} · 管理员`; if (!camera && !socket) connectCatalog();
  }
  async function refreshSession(notify = true) {
    if (disposed) return false;
    if (refreshTask) return refreshTask;
    const expected = version;
    const task = (async () => {
    try {
      const state = await api('session'); if (disposed || expected !== version) return false;
      setup = state.needsSetup;
      $('auth-title').textContent = setup ? '创建管理员账户' : camera ? '登录并添加摄像头' : '登录观看中心';
      $('auth-description').textContent = setup ? (state.canSetup ? '设置账号密码，管理这台电脑下的全部摄像头。' : '请先在运行 FreeCamera 的电脑上创建管理员账户。') : '登录后从列表选择摄像头，查看家中的实时画面。';
      if (camera && !setup) $('auth-description').textContent = '使用管理员账户登录后，点击开始监控。已登记设备以后可自动重连。';
      $('auth-confirm-row').hidden = !setup;
      $('auth-password').autocomplete = setup ? 'new-password' : 'current-password';
      $('auth-submit').textContent = setup ? '创建并登录' : '登录'; $('auth-submit').disabled = setup && !state.canSetup;
      if (state.user) { const wasLoggedIn = !!user; signedIn(state.user); if (!wasLoggedIn && notify) await onLogin(); return true; }
      await showLogin(); return false;
    } catch (error) {
      if (disposed || expected !== version) return false;
      if (!user) { $('auth-panel').hidden = false; $('auth-error').textContent = '服务连接中断，正在自动检测恢复…'; $('auth-error').hidden = false; }
      else $('catalog-status').textContent = '服务连接中断，正在自动检测恢复…';
      timer = setTimeout(() => void refreshSession(), 2000); return false;
    }
    })();
    refreshTask = task;
    try { return await task; } finally { if (refreshTask === task) refreshTask = null; }
  }
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('auth-submit').disabled) return;
    $('auth-error').hidden = true;
    if (setup && $('auth-password').value !== $('auth-confirm').value) { $('auth-error').textContent = '两次密码不一致'; $('auth-error').hidden = false; return; }
    version++; refreshTask = null; stopCatalog(); $('auth-submit').disabled = true;
    try {
      const data = await api(setup ? 'setup' : 'login', { username: $('auth-username').value, password: $('auth-password').value });
      if (disposed) return; signedIn(data.user); await onLogin();
    } catch (error) { $('auth-error').textContent = error.message; $('auth-error').hidden = false; }
    finally { $('auth-submit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    version++; refreshTask = null; stopCatalog();
    $('logout').disabled = true;
    try { await onLogout(); await api('logout', {}); await refreshSession(); }
    catch (error) { report(`退出登录失败：${error.message}`); }
    finally { $('logout').disabled = false; }
  });
  function wake() { if (!disposed && document.visibilityState !== 'hidden' && !socket) { clearTimeout(timer); void refreshSession(); } }
  window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
  return { start: () => refreshSession(false), get loggedIn() { return !!user; }, select(id) { selected = id; renderList(); },
    expired() { return refreshSession(); }, dispose() { disposed = true; version++; stopCatalog(); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); } };
}
