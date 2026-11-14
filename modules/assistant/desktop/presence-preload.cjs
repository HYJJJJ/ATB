const { contextBridge, ipcRenderer } = require('electron');
const role = process.argv.find(v => v.startsWith('--atb-presence-role='))?.split('=')[1];
if (role === 'camera') contextBridge.exposeInMainWorld('atbPresenceCamera', {
  config: () => ipcRenderer.invoke('atb:presence-background:camera'),
  publish: options => ipcRenderer.invoke('atb:presence-background', { action: 'frame', options }),
});
if (role === 'runtime') contextBridge.exposeInMainWorld('atbPresence', {
  call: (action, options) => ipcRenderer.invoke('atb:presence-background', { action, options }),
  onFrame: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('atb:presence-frame', listener); return () => ipcRenderer.removeListener('atb:presence-frame', listener); },
});
