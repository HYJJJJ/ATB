import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { AccountStore } from '../server/accounts.js';

test('server import tolerates Electron debugging flags in argv without starting CLI', () => {
  const moduleUrl = new URL('../server/index.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv[1] = '--inspect=0'; await import(${JSON.stringify(moduleUrl)});`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('CLI starts when systemd launches index through a release directory symlink', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-cloud-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const alias = path.join(directory, 'current'), root = fileURLToPath(new URL('../', import.meta.url));
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const dataDir = path.join(directory, 'data'); const accounts = await AccountStore.load(path.join(dataDir, 'account.json')); await accounts.setup('test', 'test');
  const child = spawn(process.execPath, [path.join(alias, 'server/index.js')], { windowsHide: true, env: { ...process.env,
    LAN_IP: '127.0.0.1', HTTPS_PORT: '18765', TURN_PORT: '0', PUBLIC_ORIGIN: 'https://127.0.0.1:57728', TURN_PUBLIC_PORT: '33365',
    CERT_DIR: path.join(directory, 'certs'), DATA_DIR: dataDir, DETECTION_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Symlinked CLI did not start')), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('All The Best 已启动')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Symlinked CLI exited before listening (${code})`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(child.exitCode, null);
});
