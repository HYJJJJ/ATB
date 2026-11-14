const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

function createPresenceDesktop({ services, voice, suspend, registerBackground, isBusy = () => false, interactionAt = () => 0, onCompanion = () => {} }) {
  let runtime, camera, catalog, catalogUrl, catalogResolve, catalogTimer, catalogTask, cameraKey = '', closed = false, status = { state: 'off', text: '到场问候未运行', history: [] };
  const channel = 'atb:presence-background';
  function closeCamera() { cameraKey = ''; camera?.destroy(); camera = null; }
  function finishCatalog(value) { clearTimeout(catalogTimer); catalog?.destroy(); catalog = null; catalogResolve?.(value); catalogResolve = null; catalogTask = null; }
  function stop() { finishCatalog({ cancelled: true, devices: [] }); closeCamera(); if (runtime && !runtime.isDestroyed()) { void suspend?.(runtime.webContents.id); runtime.destroy(); } runtime = null; status = { ...status, state: 'off', text: '到场问候已停止' }; }
  function makeWindow(url, role) {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'presence-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', additionalArguments: [`--atb-presence-role=${role}`] } });
    const unregister = registerBackground?.(window.webContents); window.once('closed', () => unregister?.());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
    window.webContents.on('render-process-gone', () => { stop(); status = { ...status, state: 'error', text: '后台识别进程已退出，请重新开启' }; });
    void window.loadURL(url).catch(() => { status = { ...status, state: 'error', text: '后台页面无法载入，请检查登录与连接' }; });
    return window;
  }
  ipcMain.handle(channel, async (event, { action, options = {} } = {}) => {
    if (closed || event.senderFrame !== event.sender.mainFrame) throw Error('后台请求无效');
    if (catalog && event.sender === catalog.webContents && action === 'frame' && event.sender.getURL() === catalogUrl) {
      const source = catalog;
      if (options.kind === 'devices' && Array.isArray(options.devices)) {
        const devices = options.devices.slice(0, 1000).map(d => ({ deviceId: String(d.deviceId).slice(0, 160), name: String(d.remark || d.name || '摄像头').slice(0, 160), online: d.online === true }));
        setImmediate(() => { if (catalog === source) finishCatalog({ devices }); });
      } else if (options.kind === 'error') setImmediate(() => { if (catalog === source) finishCatalog({ error: '请先在 FreeCamera 登录当前监控服务' }); });
      return;
    }
    if (camera && event.sender === camera.webContents && action === 'frame') {
      if (event.sender.getURL() !== cameraKey.split('|')[0]) throw Error('后台来源无效');
      if (options.kind === 'frame' && (!(options.bytes instanceof ArrayBuffer) || options.bytes.byteLength > 400000)) throw Error('画面无效');
      if (runtime && !runtime.isDestroyed()) runtime.webContents.send('atb:presence-frame', options);
      return;
    }
    if (!runtime || event.sender !== runtime.webContents || event.sender.getURL() !== `${services().local.origin}/modules/assistant/presence-background.html`) throw Error('后台来源无效');
    if (action === 'availability') return { busy: isBusy(), lastInteraction: interactionAt() };
    if (action === 'companion') { onCompanion(options); return; }
    if (action === 'voice') {
      if (isBusy() && !['close', 'status', 'heartbeat'].includes(options.action)) throw Error('前台正在使用语音，后台暂不打扰');
      return voice(runtime.webContents.id, options);
    }
    if (action === 'camera') {
      const origin = services().camera?.origin || services().local.origin;
      const url = origin + '/modules/freecamera/presence-camera.html';
      if (typeof options.cameraId !== 'string' || !options.cameraId || options.cameraId.length > 160) { closeCamera(); return; }
      const key = `${url}|${options.cameraId}`;
      if (key !== cameraKey) { closeCamera(); cameraKey = key; camera = makeWindow(url, 'camera'); }
      return;
    }
    if (action === 'status') {
      if (typeof options.text === 'string') status.text = options.text.slice(0, 300);
      if (['off', 'running', 'error', 'greeting', 'listening'].includes(options.state)) status.state = options.state;
      if (options.event && typeof options.event === 'string') status.history = [{ time: Date.now(), text: options.event.slice(0, 200) }, ...status.history].slice(0, 20);
      return;
    }
    if (action === 'stop') { setImmediate(stop); return; }
    throw Error('后台操作无效');
  });
  // Separate config channel; only the dedicated camera's own main frame can read it.
  ipcMain.handle(channel + ':camera', event => {
    if (catalog && event.sender === catalog.webContents && event.senderFrame === event.sender.mainFrame && event.sender.getURL() === catalogUrl) return { catalog: true };
    if (!camera || event.sender !== camera.webContents || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== cameraKey.split('|')[0]) throw Error('后台来源无效');
    return { cameraId: cameraKey.slice(cameraKey.indexOf('|') + 1) };
  });
  return {
    owns(owner) { return runtime && !runtime.isDestroyed() && runtime.webContents.id === owner; },
    pause(kind = 'foreground') { if (runtime && !runtime.isDestroyed()) { runtime.webContents.send('atb:presence-frame', { kind }); return suspend?.(runtime.webContents.id); } },
    async invoke(_owner, { action } = {}) {
      if (action === 'devices') {
        if (!catalogTask) {
          catalogTask = new Promise(resolve => { catalogResolve = resolve; });
          catalogUrl = (services().camera?.origin || services().local.origin) + '/modules/freecamera/presence-camera.html';
          catalog = makeWindow(catalogUrl, 'camera');
          catalogTimer = setTimeout(() => finishCatalog({ error: '摄像头列表获取超时，请检查监控服务并重新登录' }), 8000);
        }
        return catalogTask;
      }
      if (action === 'connection') return { cameraOrigin: services().camera?.origin || services().local?.origin };
      if (action === 'status') return { ...status, supported: true };
      if (action === 'stop') { stop(); return { ok: true }; }
      if (action === 'pause') { await this.pause('pause'); return { ok: true }; }
      if (action !== 'start' || closed || !services?.().local) throw Error('后台服务尚未就绪');
      if (!runtime || runtime.isDestroyed()) { runtime = makeWindow(services().local.origin + '/modules/assistant/presence-background.html', 'runtime'); status = { ...status, state: 'running', text: '正在检查到场问候设置' }; }
      return { ...status, supported: true };
    },
    close() { closed = true; finishCatalog({ error: '助手模块已关闭' }); stop(); ipcMain.removeHandler(channel); ipcMain.removeHandler(channel + ':camera'); },
  };
}
module.exports = { createPresenceDesktop };
