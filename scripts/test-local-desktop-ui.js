import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { _electron as electron, chromium } from 'playwright';
import { startServers } from '../server/index.js';
import { SESSION_COOKIE } from '../server/accounts.js';
import { loginViewer } from '../modules/freecamera/scripts/account-test-helper.js';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const directory = await mkdtemp(path.join(tmpdir(), 'atb-local-ui-'));
const output = path.join(root, 'test-results', 'local-desktop-ui');
await mkdir(output, { recursive: true });
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const local = await startServers({ lanIp: '127.0.0.1', httpsPort: await freePort(), httpPort: await freePort(), relayPort: 0, publicOrigin: null, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') });
const remote = await startServers({ lanIp: '127.0.0.2', httpsPort: await freePort(), httpPort: await freePort(), relayPort: 0, publicOrigin: null, certDir: path.join(directory, 'remote-certs'), dataDir: path.join(directory, 'remote-data') });
const origin = 'https://127.0.0.1:' + local.secure.address().port;
const remoteOrigin = 'https://127.0.0.2:' + remote.secure.address().port;
let app, browser, remoteClosed = false, remoteAssets = 0, remoteSettings = 0;
const failures = [];
const [remoteHandler] = remote.secure.listeners('request');
remote.secure.removeListener('request', remoteHandler);
remote.secure.on('request', (req, res) => {
  const url = new URL(req.url, remoteOrigin);
  if (url.pathname.startsWith('/api/platform/')) remoteSettings++;
  if (['/platform', '/modules/freecamera/', '/ui.css', '/ui.js', '/style.css', '/app.js'].includes(url.pathname)) {
    remoteAssets++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Old cloud interface</h1>');
  } else void remoteHandler(req, res);
});
async function launch() {
  const env = { ...process.env, ATB_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(local.secure.address().port), HTTP_PORT: String(local.plain.address().port), TURN_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], env });
  app.process().stderr?.on('data', data => failures.push(data.toString()));
  const page = await app.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(new URL(request.url()).pathname + ': ' + request.failure()?.errorText));
  page.setDefaultTimeout(10000);
  await page.waitForURL('**/platform');
  return page;
}
try {
  await local.accounts.setup('local-owner', 'test-fixture-only');
  await remote.accounts.setup('remote-owner', 'test-fixture-only');
  await writeFile(path.join(directory, 'data', 'desktop-connection.json'), JSON.stringify({ mode: 'remote', origin: remoteOrigin, ca: await readFile(path.join(directory, 'remote-certs', 'ca.crt'), 'utf8') }));
  let page = await launch();
  assert.equal(new URL(page.url()).origin, origin, 'saved camera connection must never replace the local ATB interface');
  const session = await local.accounts.login('local-owner', 'test-fixture-only');
  await page.context().addCookies([{ name: SESSION_COOKIE, value: session.token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('runtime-label')?.textContent.includes('本机预览'));
  const sizes = [];
  for (const [width, height] of [[1000, 720], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height]);
    await page.waitForFunction(width => innerWidth === width, width);
    sizes.push(await page.evaluate(() => ({ stage: document.querySelector('.orbit-stage').getBoundingClientRect().width, planet: document.querySelector('.node-symbol').getBoundingClientRect().width, title: parseFloat(getComputedStyle(document.getElementById('module-name')).fontSize) })));
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
    await page.screenshot({ path: path.join(output, 'home-' + width + '.png') });
  }
  assert.ok(sizes[1].stage > sizes[0].stage * 1.2, 'planet scene responds to window resizing');
  assert.ok(sizes[1].planet > sizes[0].planet, 'module planets respond to window resizing');
  assert.ok(sizes[1].title > sizes[0].title, 'module heading responds to window resizing');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  const traveler = page.locator('.orbit-node').first();
  const before = await traveler.evaluate(node => node.style.transform);
  await page.waitForTimeout(250);
  assert.notEqual(await traveler.evaluate(node => node.style.transform), before, 'module orbit animation runs in the desktop preview');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '选择智能助手', exact: true }).dblclick();
  await page.waitForURL(origin + '/modules/assistant/');
  await page.getByRole('link', { name: '返回工作台', exact: true }).click();
  await page.waitForURL(origin + '/platform');
  // Electron must offer a choice for beforeunload instead of silently blocking Back.
  await page.getByRole('button', { name: '选择智能助手', exact: true }).dblclick();
  await page.waitForURL(origin + '/modules/assistant/');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#persona-form').evaluate(form => { form.closest('details').open = true; });
  await page.locator('#prompt').fill('未保存的角色说明');
  assert.equal(await page.locator('#persona-state').textContent(), '未保存');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const assistantDraftUrl = page.url();
  await page.getByRole('link', { name: '返回工作台', exact: true }).click();
  const leaveDialog = page.getByRole('dialog', { name: '有未保存的设置' });
  await leaveDialog.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '继续编辑');
  await page.screenshot({ path: path.join(output, 'themed-unsaved-dialog.png') });
  await page.keyboard.press('Escape');
  await leaveDialog.waitFor({ state: 'hidden' });
  assert.equal(page.url(), assistantDraftUrl, 'cancel keeps the assistant open');
  assert.equal(await page.locator('#prompt').inputValue(), '未保存的角色说明', 'cancel retains unsaved input');
  await page.waitForFunction(() => !document.documentElement.classList.contains('atb-leaving'));
  const returnButton = await page.evaluate(() => { const rect = document.querySelector('.atb-module-return').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
  await page.mouse.click(returnButton.x + returnButton.width / 2, returnButton.y + returnButton.height / 2);
  await leaveDialog.waitFor({ state: 'visible' });
  await leaveDialog.getByRole('button', { name: '放弃修改并离开' }).click();
  await page.waitForURL(origin + '/platform');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '选择FreeCamera', exact: true }).dblclick();
  await page.waitForURL(remoteOrigin + '/modules/freecamera/');
  await page.getByRole('link', { name: '返回工作台', exact: true }).waitFor();
  assert.equal(await page.locator('.atb-shell-header').count(), 1, 'remote camera uses the current local module interface');
  assert.equal(remoteAssets, 0, 'desktop UI assets never come from the remote service');
  assert.equal(remoteSettings, 0, 'desktop platform settings never use the remote platform');
  const cameraConfig = await page.evaluate(async () => (await fetch('/api/config')).json());
  assert.equal(new URL(cameraConfig.cameraUrl).origin, remoteOrigin, 'camera registration and media configuration still come from the selected service');
  try { await loginViewer(page, { username: 'remote-owner', password: 'test-fixture-only' }); }
  catch (error) { console.log('Viewer login diagnostic:', await page.locator('#auth-error').textContent(), failures); await page.screenshot({ path: path.join(output, 'login-failure.png') }); throw error; }
  await page.locator('#view-workspace').waitFor({ state: 'visible' });
  await page.evaluate(async () => (await import('/desktop-bridge.js')).cameraDesktop.detectionState());
  // Keep the remote fixture's browser assets available for a real camera, while
  // the counters above establish that desktop UI was read exclusively locally.
  remote.secure.removeAllListeners('request'); remote.secure.on('request', remoteHandler);
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const camera = await browser.newPage({ ignoreHTTPSErrors: true });
  await camera.goto(remoteOrigin + '/?mode=camera');
  await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.getElementById('pair-code').textContent));
  await page.locator('#camera-list .device-connect').click();
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0);
  await page.screenshot({ path: path.join(output, 'remote-camera-local-interface.png') });
  await page.getByRole('link', { name: '返回工作台', exact: true }).click();
  await page.waitForURL(origin + '/platform');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await browser.close(); browser = null;
  await app.close(); app = null;
  await remote.close(); remoteClosed = true;
  page = await launch();
  assert.equal(new URL(page.url()).origin, origin, 'an offline camera service cannot block local ATB startup');
  await page.locator('#login-form [name=username]').fill('local-owner');
  await page.locator('#login-form [name=password]').fill('test-fixture-only');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, sizes, checks: ['local source with saved remote profile', 'responsive planets and heading', 'running orbit animation', 'local assistant and settings', 'local camera UI with remote login/signaling and real video', 'return to local home', 'unsaved assistant return: cancel retains draft, discard leaves', 'offline remote startup'] }, null, 2));
  console.log('PASS: local desktop interface, responsive animated home, remote camera video and offline-independent startup.');
} finally {
  await browser?.close();
  // Release only this fixture's dirty-page guard so a failed assertion can exit.
  if (app) await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.on('will-prevent-unload', event => event.preventDefault()); }).catch(() => {});
  await app?.close();
  if (!remoteClosed) await remote.close();
  await local.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
