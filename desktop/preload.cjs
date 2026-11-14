const { contextBridge, ipcRenderer } = require('electron');

const validId = value => typeof value === 'string' && value.trim() === value && /^[a-z][a-z0-9-]{0,63}$/.test(value);
let moduleIds = new Set();
try {
  const argument = process.argv.find(value => value.startsWith('--atb-modules='));
  const ids = JSON.parse(decodeURIComponent(argument?.slice('--atb-modules='.length) || '[]'));
  if (Array.isArray(ids) && ids.length <= 256 && ids.every(validId)) moduleIds = new Set(ids);
} catch {}

contextBridge.exposeInMainWorld('atbDesktop', Object.freeze({
  isDesktop: true,
  runtimeInfo: () => ipcRenderer.invoke('atb:runtime-info'),
  hasModule: id => validId(id) && moduleIds.has(id),
  invokeModule: (id, action, options) => {
    if (!validId(id) || typeof action !== 'string' || action.trim() !== action || !/^[a-z][a-zA-Z0-9-]{0,63}$/.test(action)) return Promise.reject(Error('Invalid module request'));
    return ipcRenderer.invoke('atb:module', { id, action, options });
  },
  openConnectionSettings: () => ipcRenderer.invoke('atb:connection-settings'),
  returnToViewer: () => ipcRenderer.invoke('atb:connection-back'),
  saveConnectionDraft: options => ipcRenderer.invoke('atb:connection-draft', options),
  connectionState: () => ipcRenderer.invoke('atb:connection-state'),
  chooseConnectionCertificate: () => ipcRenderer.invoke('atb:connection-certificate'),
  selectConnection: options => ipcRenderer.invoke('atb:connection-select', options),
  notify: options => ipcRenderer.invoke('atb:notify', options),
  onCompanionCommand(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on('atb:companion-command',handler); return () => ipcRenderer.removeListener('atb:companion-command',handler); },
}));

// The desktop owns these controls, so hosted modules and the connection page
// keep the same caption buttons even when a remote service has older assets.
window.addEventListener('DOMContentLoaded', () => {
  const host = document.createElement('div');
  host.id = 'atb-window-controls';
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{all:initial;position:fixed;top:12px;left:calc(100vw - 116px);height:32px;display:flex;gap:4px;z-index:2147483647;-webkit-app-region:no-drag;color:#b9c5d8;color-scheme:dark}
    button{all:unset;box-sizing:border-box;width:32px;height:32px;display:grid;place-items:center;border-radius:6px;cursor:pointer;touch-action:manipulation;-webkit-app-region:no-drag}
    button:hover{background:#ffffff12;color:#edf2f9}button:focus-visible{outline:2px solid #b8cce9;outline-offset:1px}button[data-action=close]:hover{background:#b73b50;color:white}
    svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
  `);
  shadow.adoptedStyleSheets = [sheet];
  const paths = { minimize: 'M4 10h12', maximize: 'M5 5h10v10H5Z', restore: 'M7 5V3h10v10h-2M3 7h10v10H3Z', close: 'm5 5 10 10M15 5 5 15' };
  const buttons = new Map();
  for (const [action, label] of [['minimize', '最小化'], ['maximize', '最大化'], ['close', '关闭']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.action = action;
    button.title = label; button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[action]); svg.append(path); button.append(svg);
    button.addEventListener('click', () => { void ipcRenderer.invoke('atb:window', action).then(update).catch(() => {}); });
    buttons.set(action, button); shadow.append(button);
  }
  function update({ maximized } = {}) {
    const button = buttons.get('maximize'), label = maximized ? '还原' : '最大化';
    button.title = label; button.setAttribute('aria-label', label);
    button.querySelector('path').setAttribute('d', maximized ? paths.restore : paths.maximize);
  }
  ipcRenderer.on('atb:window-state', (_event, state) => update(state));
  document.documentElement.append(host);
  void ipcRenderer.invoke('atb:window', 'state').then(update).catch(() => {});
}, { once: true });

// Consume browser mouse navigation before Chromium traverses file/HTTPS history.
for (const type of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(type, event => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  if (type === 'mouseup') void ipcRenderer.invoke('atb:navigate', event.button === 3 ? 'back' : 'forward').catch(() => {});
}, true);
window.addEventListener('keydown', event => {
  const back = event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft');
  const forward = event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight');
  if (!back && !forward) return;
  event.preventDefault();
  // Some synthetic/browser key events bypass before-input-event; main deduplicates.
  if (!event.repeat) void ipcRenderer.invoke('atb:navigate', back ? 'back' : 'forward').catch(() => {});
}, true);
