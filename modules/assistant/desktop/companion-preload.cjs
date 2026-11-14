const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('atbCompanion', Object.freeze({
  call: (action, options = {}) => ipcRenderer.invoke('atb:companion', { action, options }),
  onEvent(callback) { const listen = (_event, value) => callback(value); ipcRenderer.on('atb:companion-event',listen); return () => ipcRenderer.removeListener('atb:companion-event',listen); },
}));
