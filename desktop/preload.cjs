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
}));

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
