import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const fs = require('node:fs'); const childProcess = require('node:child_process');
const { createDesktopModule, validateRemoteId, clientCandidates } = require('../desktop/index.cjs');

test('connection IDs allow only numeric official client IDs and reject command injection', () => {
  assert.equal(validateRemoteId('123 456 789'), '123456789');
  for (const value of ['', '--password', '123;calc', '123\n456', '123&calc', 'rustdesk://123', {}, '1'.repeat(21)]) assert.throws(() => validateRemoteId(value));
});
test('discovery only builds fixed local installation paths', () => {
  assert.deepEqual(clientCandidates({ ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86', LOCALAPPDATA: 'C:\\User\\Local' }), [
    'C:\\Apps\\RustDesk\\rustdesk.exe', 'C:\\Apps86\\RustDesk\\rustdesk.exe', 'C:\\User\\Local\\Programs\\RustDesk\\rustdesk.exe', 'C:\\User\\Local\\RustDesk\\rustdesk.exe'
  ]);
});
test('native launch uses execFile with a fixed binary and separate validated arguments', async t => {
  if (process.platform !== 'win32') { t.skip('Windows launcher'); return; }
  const expectedPath = clientCandidates(process.env)[0];
  t.mock.method(fs, 'existsSync', file => file === expectedPath);
  const calls = [];
  t.mock.method(childProcess, 'execFile', (file, args, options) => { calls.push({ file, args, options }); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; });
  const instance = createDesktopModule({});
  assert.equal((await instance.handlers.connect(null, { id: '123 456 789', executable: '\\\\evil\\client.exe' })).launched, true);
  assert.equal(calls[0].file, expectedPath); assert.deepEqual(calls[0].args, ['--connect', '123456789']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, undefined);
  await assert.rejects(instance.handlers.connect(null, { id: '--password' })); assert.equal(calls.length, 1);
  await instance.handlers.open(null, {}); assert.deepEqual(calls[1].args, []);
  instance.close();
});
