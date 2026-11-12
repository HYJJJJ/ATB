import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { root, releaseDirectory, fileList, assertRuntimePath } from './package-atb.js';

async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
const outputIndex = process.argv.indexOf('--output');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = outputIndex < 0 ? releaseDirectory(version) : path.resolve(process.argv[outputIndex + 1]);
const results = path.join(root, 'test-results/atb/packaged');
await mkdir(results, { recursive: true });
const report = { passed: false, time: new Date().toISOString(), variants: {} };
for (const variant of ['full', 'core']) {
  const executablePath = path.join(output, variant, 'win-unpacked/ATB.exe');
  const appDir = path.join(output, variant, 'win-unpacked/resources/app');
  const files = await fileList(appDir);
  for (const filename of files) assertRuntimePath(filename, variant);
  if (variant === 'core') assert.equal(files.some(filename => filename.startsWith('modules/')), false);
  const pkg = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['node-forge']);
  const expected = variant === 'full' ? ['assistant', 'freecamera', 'rustdesk'] : [];
  if (variant === 'full') {
    for (const id of expected) await access(path.join(appDir, 'modules', id, 'module.json'));
    await access(path.join(appDir, 'modules/freecamera/models/yolox_tiny.onnx'));
    const require = createRequire(path.join(appDir, 'modules/freecamera/package.json'));
    assert.equal(typeof require('sharp'), 'function');
    assert.ok(require('onnxruntime-node').InferenceSession);
    assert.equal(files.some(filename => /(?:voice-runtime\/|\.venv\/|\.pem$|\.key$|\.crt$)/.test(filename)), false);
  }
  const directory = await mkdtemp(path.join(tmpdir(), `atb-packaged-${variant}-`));
  const environment = { ...process.env, ATB_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(await freePort()), HTTP_PORT: String(await freePort()), TURN_PORT: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'FREECAMERA_DATA_DIR', 'ATB_MODULES_DIR', 'PUBLIC_ORIGIN', 'CERT_DIR', 'DATA_DIR']) delete environment[key];
  let app;
  const checks = [];
  try {
    app = await electron.launch({ executablePath, args: [], env: environment, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('#login').waitFor({ state: 'visible', timeout: 45000 });
    assert.match(page.url(), /\/platform$/);
    assert.equal(await page.evaluate(async () => (await fetch('/api/platform/modules')).status), 401);
    assert.equal(await page.locator('#workspace').isVisible(), false);
    const native = await app.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData'), sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    });
    assert.equal(native.packaged, true); assert.equal(native.version, version);
    assert.equal(native.userData, path.join(directory, 'desktop-profile'));
    assert.deepEqual([native.sandbox, native.contextIsolation, native.nodeIntegration], [true, true, false]);
    checks.push('isolated cold start and account gate', `packaged version ${version}`, 'sandbox and context isolation');
    await page.locator('[name=username]').fill('packaged-admin');
    await page.locator('[name=password]').fill('packaged-validation');
    await page.locator('[name=confirm]').fill('packaged-validation');
    await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor({ state: 'visible' });
    const discovered = await page.evaluate(async () => (await fetch('/api/platform/modules')).json());
    assert.deepEqual(discovered.modules.map(item => item.id).sort(), expected);
    assert.deepEqual(discovered.errors, []);
    assert.equal(await page.locator('#module-count').textContent(), String(expected.length));
    assert.equal(await page.locator('#empty-modules').isVisible(), variant === 'core');
    assert.deepEqual(await page.evaluate(() => ['assistant', 'freecamera', 'rustdesk'].filter(id => window.atbDesktop.hasModule(id))), expected);
    checks.push(`packaged discovery: ${expected.join(', ') || 'empty core'}`);
    const origin = new URL(page.url()).origin;
    await page.locator('[data-page=settings]').click();
    assert.equal(await page.locator('#server-host').inputValue(), '');
    await page.locator('#server-label').fill('Packaged validation');
    await page.locator('#server-host').fill('example.com'); await page.locator('#server-form button').click();
    await page.waitForFunction(() => document.querySelector('#settings-result').textContent.includes('已保存'));
    checks.push('shared server settings start blank and save');
    await page.locator('#connection').click(); await page.locator('#connect-local').waitFor({ state: 'visible' });
    assert.match(await page.locator('#local-url').textContent(), /\/platform$/);
    assert.equal(await page.locator('#remote-address').inputValue(), '');
    assert.equal(await page.locator('#return-viewer').isVisible(), true);
    await page.locator('#return-viewer').click(); await page.waitForURL('**/platform#settings');
    checks.push('generic connection settings and exact page return');
    if (variant === 'full') {
      for (const module of discovered.modules) {
        await page.goto(origin + module.entry);
        assert.equal(await page.evaluate(() => document.body.innerText.length > 100), true, module.id);
      }
      const voice = await page.evaluate(() => window.atbDesktop.invokeModule('assistant', 'voice', { action: 'status' }));
      assert.equal(voice.available, false); assert.equal(voice.status, 'off');
      checks.push('all three packaged module pages load', 'optional speech reports uninstalled and stays off');
      const model = await page.evaluate(async () => {
        const api = window.atbDesktop, opened = await api.invokeModule('freecamera', 'compute-open');
        if (!opened.available) throw Error(opened.error || 'Model unavailable');
        try { const state = await api.invokeModule('freecamera', 'detection-configure', { leaseId: opened.leaseId, enabled: true }); return state; }
        finally { await api.invokeModule('freecamera', 'compute-close', { leaseId: opened.leaseId }); }
      });
      assert.ok(model.pid > 0); assert.equal(model.status, 'on');
      assert.throws(() => process.kill(model.pid, 0), { code: 'ESRCH' });
      checks.push('packaged ONNX native worker loads and exits');
    } else {
      assert.equal(await page.evaluate(async () => (await fetch('/modules/freecamera/')).status), 404);
      checks.push('missing module route returns 404');
    }
    await page.goto(origin + '/platform'); await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(results, `${variant}-workspace.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await app.close(); app = null;
    app = await electron.launch({ executablePath, args: [], env: environment, timeout: 30000 });
    const reopened = await app.firstWindow();
    await reopened.waitForURL('**/platform');
    await reopened.waitForFunction(() => document.querySelector('#workspace')?.hidden === false || document.querySelector('#login')?.hidden === false);
    if (await reopened.locator('#login').isVisible()) {
      assert.equal(await reopened.locator('#confirm-row').isVisible(), false);
      await reopened.locator('[name=username]').fill('packaged-admin'); await reopened.locator('[name=password]').fill('packaged-validation');
      await reopened.locator('#login-form button').click(); await reopened.locator('#workspace').waitFor({ state: 'visible' });
    }
    assert.equal(await reopened.evaluate(async () => (await (await fetch('/api/platform/settings')).json()).server.publicHost), 'example.com');
    checks.push('cold restart preserves account and shared configuration', 'no renderer errors');
    report.variants[variant] = { passed: true, executablePath, appDir, files: files.length, modules: expected, checks, build: JSON.parse(await readFile(path.join(appDir, 'build-info.json'), 'utf8')) };
    console.log(`PASS packaged ${variant}: ${checks.join('; ')}`);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
report.passed = true;
await writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
