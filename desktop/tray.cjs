const path = require('node:path');
function createDesktopTray({ electron = require('electron'), show, quit, companion, open }) {
  let tray;
  if (typeof electron.Tray === 'function') {
    try {
    tray = new electron.Tray(path.join(__dirname, 'tray.png'));
    tray.setToolTip('ATB · 小鲸鱼在这里');
    tray.setContextMenu(electron.Menu.buildFromTemplate([
      { label: '打开主界面', click: show },
      { label: '显示 / 隐藏小鲸鱼', click: companion },
      { label: '语音设置', click: () => open('voice') },
      { label: '平台设置', click: () => open('platform') },
      { type: 'separator' }, { label: '退出 ATB', click: quit },
    ]));
    tray.on('double-click', show); tray.on('click', show);
    } catch { tray?.destroy(); tray = null; }
  }
  return {
    get ready() { return Boolean(tray && !tray.isDestroyed()); },
    hideOnClose(event, hide) { if (!this.ready) return false; event.preventDefault(); hide(); return true; },
    close() { tray?.destroy(); tray = null; },
  };
}
module.exports = { createDesktopTray };
