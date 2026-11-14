const { app, BrowserWindow, ipcMain, dialog, Notification, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile } = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const { certificateMatches, isTrustedUrl } = require('./trust.cjs');
const { loadDesktopModules } = require('./module-host.cjs');
const { connectLocalService, connectRemoteService, validateRoot, loadConnectionProfile, saveConnectionProfile } = require('./service.cjs');
const { createUiSource } = require('./ui-source.cjs');
const { createDesktopTray } = require('./tray.cjs');

const projectRoot = path.resolve(__dirname, '..');
let nativeModules;
const saving = new Set();
const notificationTimes = new Map();
const backgroundContents = new Set();
let window;
let tray;
let service;
let uiSource;
let localService, dataRoot, profileFile, pendingCa = '', settingsError = '', pageMode = 'settings', connectionTask;
let profile = { mode: 'local' };
let profileWrites = Promise.resolve();
const settingsFile = path.join(__dirname, 'connect.html'), settingsUrl = pathToFileURL(settingsFile).href;
const settingsAssets = new Set(['connect.html', 'connect.js', 'connect.css'].map(name => pathToFileURL(path.join(__dirname, name)).href));
let quitting = false;
let shutdownComplete = false;
let settingsReturnUrl = '', lastNavigation = 0;
let pendingNavigation = '', quitTask, unloadTask, allowedUnload = '', navigationGeneration = 0;

// Keep the existing profile and data location across the ATB rename.
app.setName('FreeCamera');
const legacyUserData = app.getPath('userData');
app.setName('ATB');
app.setPath('userData', legacyUserData);
if (process.platform === 'win32') app.setAppUserModelId('local.atb.desktop');
const configuredDataRoot = process.env.ATB_DATA_DIR || process.env.FREECAMERA_DATA_DIR;
if (configuredDataRoot) {
  const profile = path.join(path.resolve(configuredDataRoot), 'desktop-profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('端口必须为 1–65535 的整数');
  return number;
}

function trustedSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== event.sender.mainFrame
      || pageMode !== 'viewer' || !uiSource?.trustedPage(event.senderFrame.url)
      || !uiSource.trustedPage(event.sender.getURL())) throw new Error('Untrusted desktop request');
  return event.sender.id;
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, options = {}) => callback(trustedSender(event), options));
}

function trustedSettings(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame
      || pageMode !== 'settings' || event.senderFrame.url !== settingsUrl || event.sender.getURL() !== settingsUrl) throw Error('Untrusted connection settings request');
}
async function confirmViewerLeave() {
  if (!window || window.isDestroyed() || pageMode !== 'viewer' || !uiSource?.trustedPage(window.webContents.getURL())) return true;
  const contents = window.webContents, current = contents.getURL();
  const dirty = await contents.executeJavaScript('Boolean(window.atbHasUnsavedChanges?.())');
  if (!dirty) return true;
  const approved = await contents.executeJavaScript('Promise.resolve(window.atbConfirmLeave?.() ?? false)');
  return approved === true && window && !window.isDestroyed() && !contents.isDestroyed() && pageMode === 'viewer' && contents.getURL() === current;
}
async function confirmDesktopAction(details,context={}) {
  context.signal?.throwIfAborted();context.check?.();
  showMain();
  if(!window||window.isDestroyed()||pageMode!=='viewer'||!uiSource?.trustedPage(window.webContents.getURL()))return false;
  const contents=window.webContents,current=contents.getURL();
  const requestId=require('node:crypto').randomUUID();let timer,cancel;
  const approved=await Promise.race([
    contents.executeJavaScript('Promise.resolve(window.atbConfirm?.('+JSON.stringify({...details,requestId})+') ?? false)').catch(()=>false),
    new Promise(resolve=>{cancel=()=>{void contents.executeJavaScript('window.atbCancelConfirm?.('+JSON.stringify(requestId)+')').catch(()=>{});resolve(false);};context.signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,45000);if(context.signal?.aborted)cancel();}),
  ]).finally(()=>{clearTimeout(timer);context.signal?.removeEventListener('abort',cancel);});
  context.signal?.throwIfAborted();context.check?.();
  return approved===true&&!quitting&&!contents.isDestroyed()&&contents.getURL()===current;
}
async function finishViewer() {
  if (!window || window.isDestroyed() || pageMode !== 'viewer' || !uiSource?.trustedPage(window.webContents.getURL())) return;
  let timer;
  try {
    await Promise.race([window.webContents.executeJavaScript('Promise.resolve(window.atbPrepareClose?.())'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('正在完成当前操作，请稍后再试')), 5000); })]);
  } finally { clearTimeout(timer); }
}
function savedRemotes() {
  const remotes = profile.remotes || [];
  return profile.origin && !remotes.some(item => item.origin === profile.origin) ? [...remotes, { origin: profile.origin, ca: profile.ca }] : remotes;
}
function updateProfile(next) {
  profile = next;
  profileWrites = profileWrites.catch(() => {}).then(() => saveConnectionProfile(profileFile, next));
  return profileWrites;
}
async function showSettings(message = '') {
  if (!await confirmViewerLeave()) return;
  await finishViewer(); if (quitting) return;
  const current = window.webContents.getURL();
  if (uiSource?.trustedPage(current)) settingsReturnUrl = current;
  await nativeModules?.suspend(window.webContents.id);
  settingsError = message; pageMode = 'settings'; await window.loadFile(settingsFile);
  window.webContents.navigationHistory.clear();
}
async function returnToViewer() {
  if (pageMode !== 'settings' || !service || connectionTask || saving.has(window.webContents.id) || quitting) return { ok: true };
  connectionTask = (async () => {
    pageMode = 'viewer';
    try {
      await window.loadURL(settingsReturnUrl && uiSource.trustedPage(settingsReturnUrl) ? settingsReturnUrl : `${localService.origin}/platform`);
      window.webContents.navigationHistory.clear();
      return { ok: true };
    } catch (error) {
      await showSettings(error.message);
      return { ok: false, error: error.message };
    }
  })();
  try { return await connectionTask; } finally { connectionTask = null; }
}
async function navigateService(direction) {
  if (Date.now() - lastNavigation < 180) return;
  lastNavigation = Date.now();
  if (pageMode === 'settings') { if (direction === 'back') await returnToViewer(); return; }
  if (!window || !service || connectionTask || quitting) return;
  const contents = window.webContents, history = contents.navigationHistory;
  const destination = history.getAllEntries()[history.getActiveIndex() + (direction === 'back' ? -1 : 1)];
  if (destination && uiSource.trustedPage(contents.getURL()) && uiSource.trustedNavigation(destination.url)) {
    await finishViewer();
    if (direction === 'back') history.goBack(); else history.goForward();
  }
}
async function selectConnection(options, persist = true) {
  let next;
  if (!localService) {
    localService = await connectLocalService({ dataRoot, httpsPort: port(process.env.HTTPS_PORT, 8443), httpPort: port(process.env.HTTP_PORT, 8080) });
  }
  if (options.mode === 'local') {
    next = localService;
    if (!pendingCa) pendingCa = next.ca;
  } else if (options.mode === 'remote') {
    const saved = options.savedOrigin && savedRemotes().find(item => item.origin === options.savedOrigin);
    if (options.savedOrigin && !saved) throw Error('未找到已保存的服务');
    // Restoring a camera endpoint must not require it to be online just to open ATB.
    next = !persist && saved ? { ...saved, remote: true, platform: true }
      : await connectRemoteService({ address: saved ? saved.origin : options.address, ca: saved ? saved.ca : pendingCa });
  }
  else throw Error('请选择本机服务或远程服务');
  if (quitting) return;
  const nextProfile = !persist ? profile : options.mode === 'remote' ? {
    ...profile, mode: 'remote', origin: next.origin, ca: next.ca,
    remotes: [{ origin: next.origin, ca: next.ca }, ...savedRemotes().filter(item => item.origin !== next.origin)].slice(0, 20),
    draft: { address: next.origin, ca: next.ca },
  } : { ...profile, mode: 'local' };
  if (persist) await updateProfile(nextProfile);
  if (persist && options.mode === 'remote') pendingCa = next.ca;
  profile = nextProfile; service = next; pageMode = 'viewer';
  const module = nativeModules.remoteUi[0];
  const destination = persist && module ? `${service.origin}${module.entry}` : `${localService.origin}/platform`;
  await window.loadURL(destination);
  window.webContents.navigationHistory.clear();
}
function installConnectionBridge() {
  handle('atb:connection-settings', async () => {
    if (connectionTask) throw Error('正在切换服务');
    connectionTask = showSettings(); try { await connectionTask; } finally { connectionTask = null; }
  });
  ipcMain.handle('atb:connection-state', async event => {
    trustedSettings(event);
    const { lanAddresses, selectedIp } = await import(pathToFileURL(path.join(projectRoot, 'scripts/network.js')).href);
    const tailscale = lanAddresses().filter(ip => /^100\./.test(ip) && Number(ip.split('.')[1]) >= 64 && Number(ip.split('.')[1]) <= 127);
    return { version: app.getVersion(), mode: profile.mode, origin: profile.draft?.address ?? profile.origin ?? '', remotes: savedRemotes().map(({ origin }) => ({ origin })),
      canReturn: Boolean(service), error: settingsError, certificate: pendingCa ? validateRoot(pendingCa) : null,
      localUrl: `https://${selectedIp()}:${port(process.env.HTTPS_PORT,8443)}/platform`,
      tailscaleUrls: tailscale.map(ip => `https://${ip}:${port(process.env.HTTPS_PORT,8443)}/platform`) };
  });
  ipcMain.handle('atb:connection-back', async event => {
    if (pageMode === 'settings') trustedSettings(event); else trustedSender(event);
    return returnToViewer();
  });
  ipcMain.handle('atb:navigate', async (event, direction) => {
    if (pageMode === 'settings') trustedSettings(event); else trustedSender(event);
    if (!['back', 'forward'].includes(direction)) return;
    await navigateService(direction);
  });
  ipcMain.handle('atb:connection-draft', async (event, options = {}) => {
    trustedSettings(event);
    if (connectionTask || saving.has(event.sender.id)) throw Error('请等待当前操作完成');
    if (typeof options.address !== 'string' || options.address.length > 2048 || /[@?#]/.test(options.address)) throw Error('服务地址不能包含账号、密码或参数');
    await updateProfile({ ...profile, draft: { address: options.address, ...(pendingCa ? { ca: pendingCa } : {}) } });
  });
  ipcMain.handle('atb:connection-certificate', async event => {
    trustedSettings(event); if (connectionTask || saving.has(event.sender.id)) throw Error('请等待当前操作完成');
    saving.add(event.sender.id);
    try {
      const result = await dialog.showOpenDialog(window, { title: '选择目标服务的 ATB 根证书', properties: ['openFile'], filters: [{ name: '根证书', extensions: ['crt','cer','pem'] }] });
      if (result.canceled) return { canceled: true };
      trustedSettings(event);
      const bytes = await readFile(result.filePaths[0]); if (bytes.length > 65536) throw Error('证书文件过大');
      const ca = bytes.toString('utf8'), info = validateRoot(ca); pendingCa = ca;
      await updateProfile({ ...profile, draft: { address: profile.draft?.address ?? profile.origin ?? '', ca } });
      return info;
    } finally { saving.delete(event.sender.id); }
  });
  ipcMain.handle('atb:connection-select', async (event, options = {}) => {
    trustedSettings(event); if (connectionTask || saving.has(event.sender.id)) return { ok: false, error: '请等待当前操作完成' };
    connectionTask = selectConnection(options);
    try { await connectionTask; return { ok: true }; }
    catch (error) { if (!quitting) { settingsError = error.message; pageMode = 'settings'; if (window.webContents.getURL() !== settingsUrl) await window.loadFile(settingsFile); } return { ok: false, error: error.message }; }
    finally { connectionTask = null; }
  });
}

async function chooseFile(owner, options) {
  if (!window || window.isDestroyed() || window.webContents.id !== owner || pageMode !== 'viewer' || !uiSource?.trustedPage(window.webContents.getURL())) throw new Error('Untrusted desktop request');
  if (saving.has(owner)) throw new Error('A save dialog is already open');
  saving.add(owner);
  try {
    const origin = service.origin, url = window.webContents.getURL();
    const result = await dialog.showSaveDialog(window, options);
    if (!window || window.isDestroyed() || window.webContents.id !== owner || pageMode !== 'viewer' || service?.origin !== origin || window.webContents.getURL() !== url) return { canceled: true };
    return result;
  } finally { saving.delete(owner); }
}

function notify(owner, { title, body } = {}) {
  if (typeof title !== 'string' || typeof body !== 'string' || title.length > 120 || body.length > 2000) throw new Error('Invalid notification');
  if (!Notification.isSupported()) return { supported: false };
  const now = Date.now();
  if (now - (notificationTimes.get(owner) || 0) < 1000) return { supported: true, throttled: true };
  notificationTimes.set(owner, now);
  new Notification({ title, body }).show();
  return { supported: true };
}
function installNativeBridge() {
  handle('atb:module', (owner, { id, action, options } = {}) => {
    const remote = uiSource.remoteModule(window.webContents.getURL());
    if (remote && remote.id !== id) throw Error('Untrusted desktop module request');
    return nativeModules.invoke(id, action, owner, options);
  });
  handle('atb:runtime-info', () => ({ version: app.getVersion(), interfaceSource: 'local', preview: !app.isPackaged }));
  handle('atb:notify', notify);
  ipcMain.handle('atb:window', (event, action) => {
    if (pageMode === 'settings') trustedSettings(event);
    else trustedSender(event);
    if (!['state', 'minimize', 'maximize', 'close'].includes(action)) throw Error('Invalid window action');
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
    if (action === 'close') window.close();
    return { maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()) };
  });
}

function showMain() { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
async function navigateDesktop(page,context={}) {
  const guard=()=>{context.signal?.throwIfAborted();context.check?.();};guard();
  const routes = { main:'/platform', platform:'/platform#settings/general', assistant:'/modules/assistant/#assistant', persona:'/modules/assistant/#assistant', voice:'/modules/assistant/#voice', faces:'/modules/assistant/#faces', model:'/modules/assistant/#model',tools:'/modules/assistant/#tools' };
  if (!routes[page] || !localService || !window || window.isDestroyed() || quitting || connectionTask) return false;
  showMain(); if (!await confirmViewerLeave()) return false;
  guard();
  await finishViewer(); if (quitting) return false;
  guard();
  pageMode = 'viewer'; await window.loadURL(localService.origin + routes[page]);
  if (page === 'persona') window.webContents.send('atb:companion-command',{action:'persona'});
  return true;
}

async function openWindow() {
  dataRoot = configuredDataRoot ? path.resolve(configuredDataRoot) : (app.isPackaged ? app.getPath('userData') : projectRoot);
  profileFile = path.join(dataRoot, 'data', 'desktop-connection.json');
  try {
    profile = await loadConnectionProfile(profileFile); pendingCa = profile.draft?.ca || profile.ca || '';
    if (!pendingCa) { try { pendingCa = await readFile(path.join(dataRoot,'certs','ca.crt'),'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  } catch (error) { settingsError = `连接配置无法读取：${error.message}`; }
  nativeModules = loadDesktopModules({
    modulesRoot: path.join(projectRoot, 'modules'),
    context: { dataRoot, app, window: () => window, chooseFile, notify, navigate:navigateDesktop, confirmDesktopAction, quit:() => app.quit(),
      commandAssistant(command) { if (!window || window.isDestroyed() || pageMode !== 'viewer' || !window.webContents.getURL().startsWith(`${localService?.origin}/modules/assistant/`)) return false; window.webContents.send('atb:companion-command',command); return true; },
      services: () => ({ local: localService, camera: service }), registerBackground(contents) { backgroundContents.add(contents); return () => backgroundContents.delete(contents); } },
    onError: ({ id, phase }) => console.error(`ATB desktop module ${id}: ${phase} failed`),
  });
  uiSource = createUiSource({ local: () => localService, selected: () => service, modules: nativeModules.remoteUi });
  window = new BrowserWindow({
    title: 'ATB', width: 1240, height: 860, minWidth: 860, minHeight: 620,
    frame: false,
    backgroundColor: '#0d1017', show: false,
    webPreferences: { additionalArguments: [`--atb-modules=${encodeURIComponent(JSON.stringify(nativeModules.ids))}`], preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  });
  const webContents = window.webContents;
  for (const event of ['maximize', 'unmaximize']) window.on(event, () => {
    if (!webContents.isDestroyed()) webContents.send('atb:window-state', { maximized: window.isMaximized() });
  });
  window.on('app-command', (event, command) => {
    if (!['browser-backward', 'browser-forward'].includes(command)) return;
    event.preventDefault();
    void navigateService(command === 'browser-backward' ? 'back' : 'forward');
  });
  webContents.on('before-input-event', (event, input) => {
    const back = input.key === 'BrowserBack' || (input.alt && input.key === 'ArrowLeft');
    const forward = input.key === 'BrowserForward' || (input.alt && input.key === 'ArrowRight');
    if (!back && !forward) return;
    event.preventDefault();
    if (input.type === 'keyDown') void navigateService(back ? 'back' : 'forward');
  });
  webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { pendingNavigation = _url; navigationGeneration++; void nativeModules.suspend(webContents.id); } });
  webContents.on('render-process-gone', () => { void nativeModules.suspend(webContents.id); });
  webContents.session.setCertificateVerifyProc((request, callback) => {
    const trusted = [localService, service].some(target => target && request.hostname === new URL(target.origin).hostname
      && certificateMatches(request.certificate.data, target.ca, request.hostname));
    callback(trusted ? 0 : -2);
  });
  app.on('certificate-error', (event, contents, url, _error, certificate, callback) => {
    const trusted = (pageMode === 'viewer' && contents === webContents || backgroundContents.has(contents)) && [localService, service].some(target => target && isTrustedUrl(url, target.origin)
      && certificateMatches(certificate.data, target.ca, new URL(target.origin).hostname));
    if (trusted) event.preventDefault();
    callback(trusted);
  });
  webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = permission === 'fullscreen' || (permission === 'media' && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio'));
    const background = backgroundContents.has(contents) && ['presence-background.html','companion.html'].some(page => contents.getURL() === `${localService?.origin}/modules/assistant/${page}`);
    callback(Boolean((background || pageMode === 'viewer' && contents === webContents) && details.isMainFrame !== false && allowed && uiSource.trustedPage(details.requestingUrl || contents.getURL())));
  });
  webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    Boolean((backgroundContents.has(contents) && ['presence-background.html','companion.html'].some(page => contents.getURL() === `${localService?.origin}/modules/assistant/${page}`) || pageMode === 'viewer' && contents === webContents) && (permission === 'fullscreen' || (permission === 'media' && details.mediaType === 'audio')) && uiSource.trustedRequest(requestingOrigin)));
  webContents.session.protocol.handle('https', request => {
    const route = uiSource.route(request.url);
    if (route?.redirect) return Response.redirect(route.redirect, 307);
    if (route?.asset) return webContents.session.fetch(route.asset, { bypassCustomProtocolHandlers: true, method: request.method });
    const headers = new Headers(request.headers);
    // Electron's privileged fetch has no renderer origin. Restore the validated
    // same-origin context so account/API CSRF checks remain enforced.
    if (!['GET', 'HEAD'].includes(request.method) && !headers.has('Origin')) headers.set('Origin', new URL(request.url).origin);
    return webContents.session.fetch(request, { bypassCustomProtocolHandlers: true, credentials: 'include', headers });
  });
  webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = pageMode === 'settings' && settingsAssets.has(details.url);
    // Some requests have no webContentsId; never pass it to Electron.fromId.
    if([...backgroundContents].some(contents => !contents.isDestroyed() && contents.id === details.webContentsId))allowed=uiSource.trustedRequest(details.url);
    if (pageMode === 'viewer' && service) {
      allowed = uiSource.trustedRequest(details.url);
    }
    if (details.url.startsWith('devtools:')) allowed = !app.isPackaged;
    callback({ cancel: !allowed });
  });
  for (const eventName of ['will-navigate', 'will-redirect']) webContents.on(eventName, (event, url) => {
    if (pageMode !== 'viewer' || !uiSource.trustedNavigation(url)) event.preventDefault();
    else { pendingNavigation = url; }
  });
  webContents.on('will-prevent-unload', event => {
    if (shutdownComplete) { event.preventDefault(); return; }
    const current = webContents.getURL();
    if (pageMode !== 'viewer' || !uiSource?.trustedPage(current)) return;
    if (allowedUnload === current) { allowedUnload = ''; event.preventDefault(); return; }
    if (unloadTask || quitting || !uiSource.trustedNavigation(pendingNavigation)) return;
    const destination = pendingNavigation, generation = navigationGeneration;
    unloadTask = webContents.executeJavaScript('Promise.resolve(window.atbConfirmLeave?.() ?? false)').then(async approved => {
      if (approved !== true || quitting || !window || window.isDestroyed() || webContents.isDestroyed()
          || pageMode !== 'viewer' || webContents.getURL() !== current || generation !== navigationGeneration) return;
      allowedUnload = current;
      try { await window.loadURL(destination); } finally { allowedUnload = ''; }
    }).catch(error => console.error('确认离开页面失败:', error.message)).finally(() => { unloadTask = null; });
  });
  webContents.on('will-attach-webview', event => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const owner = webContents.id;
  webContents.once('destroyed', () => {
    void nativeModules.suspend(owner);
    notificationTimes.delete(owner);
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', event => {
    if (shutdownComplete) return;
    if (tray?.hideOnClose(event, () => window.hide())) return;
    event.preventDefault();
    app.quit();
  });
  window.once('closed', () => { window = null; });
  Menu.setApplicationMenu(null);
  installNativeBridge();
  installConnectionBridge();
  tray = createDesktopTray({electron:require('electron'),show:showMain,quit:() => app.quit(),open:page => { void navigateDesktop(page).catch(error => console.error('打开快捷入口失败:',error.message)); },
    companion:() => { if(nativeModules.hasModule?.('assistant')) void nativeModules.invoke('assistant','companion',window.webContents.id,{action:'toggle'}).catch(error => console.error('切换桌面助手失败:',error.message)); }});
  if (settingsError) await showSettings(settingsError);
  else {
    connectionTask = selectConnection({ mode: profile.mode, address: profile.origin, savedOrigin: profile.mode === 'remote' ? profile.origin : undefined }, false);
    try { await connectionTask; } catch (error) { await showSettings(error.message); }
    finally { connectionTask = null; }
  }
  if (localService && nativeModules.hasModule?.('assistant')) await nativeModules.invoke('assistant','companion',window.webContents.id,{action:'start'}).catch(error => console.error('桌面助手启动失败:',error.message));
}

app.on('window-all-closed', () => { if(!tray?.ready) app.quit(); });
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting || quitTask) return;
  quitTask = (async () => {
    if (window && !window.isDestroyed() && pageMode === 'viewer' && uiSource?.trustedPage(window.webContents.getURL())) {
      const current = window.webContents.getURL();
      const dirty = await window.webContents.executeJavaScript('Boolean(window.atbHasUnsavedChanges?.())');
      if (dirty) {
        const approved = await window.webContents.executeJavaScript('Promise.resolve(window.atbConfirmLeave?.() ?? false)');
        if (approved !== true || !window || window.isDestroyed() || window.webContents.getURL() !== current) return;
      }
    }
    quitting = true;
    await connectionTask?.catch(() => {});
    await profileWrites.catch(error => console.error('保存连接设置失败:', error.message));
    if (window && !window.isDestroyed() && uiSource?.trustedPage(window.webContents.getURL())) {
      let timer;
      try {
        await Promise.race([
          window.webContents.executeJavaScript('Promise.resolve(window.atbPrepareClose?.())'),
          new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
        ]);
      } catch (error) { console.error('完成页面收尾失败:', error.message); }
      finally { clearTimeout(timer); }
    }
    await nativeModules?.close();
    tray?.close();
    await localService?.close();
  })().catch(error => console.error('关闭服务失败:', error.message)).finally(() => {
    quitTask = null;
    if (quitting) { shutdownComplete = true; app.quit(); }
  });
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show(); window?.focus();
  });
  app.whenReady().then(openWindow).catch(async error => {
    console.error('ATB 启动失败:', error);
    if (window && !window.isDestroyed()) {
      await showSettings(`ATB 启动失败：${error.message}\n请确认配置的端口没有被其他应用占用，电脑已连接局域网。`);
      window.show();
    } else app.quit();
  });
}
