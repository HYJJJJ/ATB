import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const fs = require('node:fs'); const childProcess = require('node:child_process');
const { createDesktopModule, validateRemoteId, clientCandidates } = require('../desktop/index.cjs');

function launcherFixture(t, { serviceResult = { state: 'running', changed: false }, serviceError, deferred = false } = {}) {
  const expectedPath = clientCandidates(process.env)[0], calls = [];
  let finishService;
  t.mock.method(fs, 'existsSync', file => file === expectedPath);
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.unref = () => {};
    if (file.toLowerCase().endsWith('powershell.exe')) {
      finishService = () => callback(serviceError, JSON.stringify(serviceResult), '');
      if (!deferred) queueMicrotask(finishService);
    } else queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return { expectedPath, calls, finish: () => finishService() };
}

test('connection IDs allow only numeric official client IDs and reject command injection', () => {
  assert.equal(validateRemoteId('123 456 789'), '123456789');
  for (const value of ['', '--password', '123;calc', '123\n456', '123&calc', 'rustdesk://123', {}, '1'.repeat(21)]) assert.throws(() => validateRemoteId(value));
});

test('discovery only builds fixed local installation paths', () => {
  assert.deepEqual(clientCandidates({ ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86', LOCALAPPDATA: 'C:\\User\\Local' }), [
    'C:\\Apps\\RustDesk\\rustdesk.exe', 'C:\\Apps86\\RustDesk\\rustdesk.exe', 'C:\\User\\Local\\Programs\\RustDesk\\rustdesk.exe', 'C:\\User\\Local\\RustDesk\\rustdesk.exe'
  ]);
});

test('native open and connect prepare the Windows service before launching the fixed client', async t => {
  if (process.platform !== 'win32') { t.skip('Windows launcher'); return; }
  const { expectedPath, calls } = launcherFixture(t);
  const instance = createDesktopModule({});
  assert.equal((await instance.handlers.connect(null, { id: '123 456 789', executable: '\\\\evil\\client.exe' })).launched, true);
  assert.match(calls[0].file, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0, 'Service helper is bounded');
  assert.equal(calls[1].file, expectedPath); assert.deepEqual(calls[1].args, ['--connect', '123456789']);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.timeout, undefined, 'GUI and active session are never time limited');
  await assert.rejects(instance.handlers.connect(null, { id: '--password' })); assert.equal(calls.length, 2);
  await instance.handlers.open(null, {}); assert.deepEqual(calls[3].args, []);
  instance.close();
});

test('opening waits for a stopped or missing service to finish starting', async t => {
  if (process.platform !== 'win32') { t.skip('Windows launcher'); return; }
  const { expectedPath, calls, finish } = launcherFixture(t, { serviceResult: { state: 'running', changed: true }, deferred: true });
  const instance = createDesktopModule({});
  const result = instance.handlers.open(null, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'Do not open an unready GUI');
  assert.notEqual(calls[0].file, expectedPath);
  finish();
  assert.equal((await result).launched, true);
  assert.equal(calls[1].file, expectedPath);
  instance.close();
});

test('service failure or cancelled Windows authorization reports an error instead of false success', async t => {
  if (process.platform !== 'win32') { t.skip('Windows launcher'); return; }
  const { calls } = launcherFixture(t, { serviceError: Object.assign(Error('native failure details must not leak'), { code: 1223 }) });
  const instance = createDesktopModule({});
  await assert.rejects(instance.handlers.open(null, {}), error => /RustDesk.*服务|服务.*RustDesk/.test(error.message) && !error.message.includes('native failure'));
  assert.equal(calls.length, 1);
  instance.close();
});

test('concurrent launches share service startup, and closing a module does not open a late window', async t => {
  if (process.platform !== 'win32') { t.skip('Windows launcher'); return; }
  const { calls, finish } = launcherFixture(t, { deferred: true });
  const instance = createDesktopModule({});
  const first = instance.handlers.open(null, {}), second = instance.handlers.connect(null, { id: '123456789' });
  const outcomes = Promise.allSettled([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'Only one service preparation may run at a time');
  instance.close(); finish();
  for (const result of await outcomes) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /已关闭/); }
  assert.equal(calls.length, 1, 'Do not launch windows after module removal');
});

test('malformed service readiness cannot be mistaken for a started service', async t => {
  if (process.platform !== 'win32') { t.skip('Windows launcher'); return; }
  const { calls } = launcherFixture(t, { serviceResult: { state: 'stopped', changed: false } });
  const instance = createDesktopModule({});
  await assert.rejects(instance.handlers.open(null, {}), /服务/);
  assert.equal(calls.length, 1);
  instance.close();
});