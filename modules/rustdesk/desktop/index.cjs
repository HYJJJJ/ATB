const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { ensureWindowsService } = require('./windows-service.cjs');

function validateRemoteId(value) {
  if (typeof value !== 'string' || !/^[0-9 ]{6,30}$/.test(value)) throw Error('请输入 6 至 20 位数字的 RustDesk ID');
  const id = value.replaceAll(' ', '');
  if (!/^[0-9]{6,20}$/.test(id)) throw Error('请输入 6 至 20 位数字的 RustDesk ID');
  return id;
}
function clientCandidates(env = process.env) {
  const candidates = [];
  for (const root of [env.ProgramW6432 || env.ProgramFiles, env['ProgramFiles(x86)']]) if (typeof root === 'string' && /^[a-z]:\\/i.test(root)) candidates.push(path.win32.join(root, 'RustDesk', 'rustdesk.exe'));
  if (typeof env.LOCALAPPDATA === 'string' && /^[a-z]:\\/i.test(env.LOCALAPPDATA)) {
    candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'RustDesk', 'rustdesk.exe'), path.win32.join(env.LOCALAPPDATA, 'RustDesk', 'rustdesk.exe'));
  }
  return [...new Set(candidates)];
}
function createDesktopModule() {
  let closed = false, servicePreparation = null;
  const findClient = () => process.platform === 'win32' ? clientCandidates().find(candidate => fs.existsSync(candidate)) : undefined;
  async function launch(args) {
    if (closed) throw Error('RustDesk 模块已关闭');
    const executable = findClient();
    if (!executable) return { launched: false, installed: false, error: '未找到已安装的 Windows RustDesk 客户端，请通过官方下载页安装。' };
    if (!servicePreparation) {
      servicePreparation = ensureWindowsService(executable).finally(() => { servicePreparation = null; });
    }
    await servicePreparation;
    if (closed) throw Error('RustDesk 模块已关闭');
    await new Promise((resolve, reject) => {
      const child = childProcess.execFile(executable, args, { shell: false, windowsHide: false, detached: true, maxBuffer: 65536 }, () => {});
      // A GUI may remain open for hours. Drain output without retaining logs or
      // letting execFile's output buffer terminate the user's active session.
      for (const stream of [child.stdout, child.stderr]) { stream?.removeAllListeners('data'); stream?.resume(); }
      child.stdin?.end();
      child.once('error', () => reject(Error('无法启动 RustDesk，请检查客户端安装状态')));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { launched: true, installed: true };
  }
  return {
    handlers: {
      async status() { return { supported: process.platform === 'win32', installed: Boolean(findClient()), configurationMethod: 'manual' }; },
      async open() { return launch([]); },
      async connect(_owner, options = {}) { const id = validateRemoteId(options.id); return launch(['--connect', id]); }
    },
    close() { closed = true; }
  };
}
module.exports = { createDesktopModule, validateRemoteId, clientCandidates };
