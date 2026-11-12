import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer, testCredentials } from './account-test-helper.js';

const require = createRequire(import.meta.url), directory = await mkdtemp(path.join(tmpdir(), 'freecamera-optional-'));
await mkdir('test-results/optional-compute', { recursive: true });
const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const httpsPort = listener.address().port; await new Promise(r => listener.close(r));
const service = await startServers({ detector: null, lanIp: '127.0.0.1', httpsPort, httpPort: 0, relayPort: 0, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'cloud') });
const origin = `https://127.0.0.1:${service.secure.address().port}`;
let blockedConfigs = 0;
const handler = service.secure.listeners('request')[0]; service.secure.off('request', handler);
service.secure.on('request', (req, res) => {
  if (req.url === '/api/config' && req.headers['user-agent']?.includes('Electron') && !blockedConfigs) {
    blockedConfigs++; res.writeHead(503); res.end(); return;
  }
  void handler(req, res);
});
let browser, desktop;
async function launchDesktop() {
  const env = { ...process.env, FREECAMERA_DATA_DIR: path.join(directory, 'desktop') }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.FREECAMERA_DESKTOP_EXECUTABLE || require('electron');
  return electron.launch({ executablePath, args: process.env.FREECAMERA_DESKTOP_EXECUTABLE ? [] : [path.resolve('.')], env });
}
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true }), camera = await context.newPage(), viewer = await context.newPage();
  const errors = []; for (const page of [camera, viewer]) page.on('pageerror', e => errors.push(e.message));
  await camera.addInitScript(base64 => {
    navigator.mediaDevices.getUserMedia = async () => {
      const image = new Image(); image.src = `data:image/jpeg;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); const draw = () => ctx.drawImage(image, 0, 0); draw(); setInterval(draw, 80);
      return canvas.captureStream(15);
    };
  }, (await readFile(new URL('../models/validation-person.jpg', import.meta.url))).toString('base64'));
  await camera.goto(`${origin}/?mode=camera`); await camera.locator('#microphone-toggle').uncheck(); await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  const captureId = await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].id);
  await viewer.goto(`${origin}/?mode=viewer`); await loginViewer(viewer);
  await viewer.locator('#code').fill(await camera.locator('#pair-code').textContent()); await viewer.locator('#join').click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  assert.equal(await viewer.locator('#detection-toggle').isDisabled(), true, 'offline compute must disable advanced controls');
  assert.equal(await viewer.locator('#notifications').isDisabled(), true);
  await mkdir(path.join(directory, 'desktop/data'), { recursive: true });
  await writeFile(path.join(directory, 'desktop/data/desktop-connection.json'), JSON.stringify({ mode: 'remote', origin, ca: await readFile(path.join(directory, 'certs/ca.crt'), 'utf8') }));
  desktop = await launchDesktop(); let page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL(`${origin}/platform*`);
  await page.locator('[name=username]').fill(testCredentials.username); await page.locator('[name=password]').fill(testCredentials.password); await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor();
  await viewer.waitForFunction(() => !document.querySelector('#detection-toggle').disabled, null, { timeout: 6000 });
  assert.equal(blockedConfigs, 1, 'initial cloud configuration failure must recover automatically');
  assert.equal((await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid, null, 'online registration must not create a model process');
  await viewer.locator('#detection-toggle').check();
  await viewer.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('运行中'));
  await viewer.waitForFunction(() => /[1-9]/.test(document.querySelector('#person-count').textContent), null, { timeout: 30000 });
  const model = await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState()); assert.ok(model.pid); process.kill(model.pid, 0);
  await viewer.screenshot({ path: 'test-results/optional-compute/detected.png', fullPage: true });
  await viewer.locator('#detection-toggle').uncheck();
  await viewer.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('模型进程已退出'));
  assert.throws(() => process.kill(model.pid, 0));
  await viewer.locator('#detection-toggle').check();
  await viewer.waitForFunction(() => /[1-9]/.test(document.querySelector('#person-count').textContent));
  const pid = (await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid;
  const before = await viewer.locator('video').evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames);
  await desktop.close(); desktop = null;
  await viewer.waitForFunction(() => document.querySelector('#detection-toggle').disabled);
  assert.throws(() => process.kill(pid, 0));
  await viewer.waitForFunction(frames => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames > frames + 5, before);
  assert.equal(await viewer.locator('#snapshot').isEnabled(), true);
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].id), captureId);
  desktop = await launchDesktop(); page = await desktop.firstWindow(); await page.waitForURL(`${origin}/platform*`);
  await viewer.waitForFunction(() => !document.querySelector('#detection-toggle').disabled && document.querySelector('#detection-status').textContent.includes('运行中'));
  assert.equal(await viewer.locator('#detection-toggle').isChecked(), true, 'reconnect restores the saved enabled state');
  assert.ok((await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid);
  await page.locator('#connection').click(); await page.waitForURL('**/desktop/connect.html');
  await viewer.waitForFunction(() => document.querySelector('#detection-toggle').disabled);
  await page.locator('#return-viewer').click(); await page.waitForURL(`${origin}/platform*`);
  await viewer.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('运行中'));
  // Renderer link interruption must release the native model and reconnect without touching camera/viewer.
  await viewer.locator('#detection-toggle').check();
  await viewer.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('运行中'));
  const networkPid = (await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid;
  await page.context().setOffline(true);
  await viewer.waitForFunction(() => document.querySelector('#detection-toggle').disabled, null, { timeout: 16000 });
  console.log('Network-loss native state:', await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState()));
  // Native shutdown is asynchronous; inspect it from Node, not an async Playwright predicate.
  const stoppedBy = Date.now() + 5000;
  while (Date.now() < stoppedBy && (await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid !== null) await new Promise(r => setTimeout(r, 100));
  assert.throws(() => process.kill(networkPid, 0));
  await page.context().setOffline(false);
  await viewer.waitForFunction(() => !document.querySelector('#detection-toggle').disabled && document.querySelector('#detection-status').textContent.includes('运行中'), null, { timeout: 20000 });
  assert.equal(await viewer.locator('#detection-toggle').isChecked(), true);
  const restoredPid = (await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid; assert.ok(restoredPid);
  await viewer.locator('#detection-toggle').uncheck();
  await viewer.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('模型进程已退出'));
  assert.throws(() => process.kill(restoredPid, 0));
  await desktop.close(); desktop = null;
  await viewer.waitForFunction(() => document.querySelector('#detection-toggle').disabled);
  desktop = await launchDesktop(); page = await desktop.firstWindow(); await page.waitForURL(`${origin}/platform*`);
  await viewer.waitForFunction(() => !document.querySelector('#detection-toggle').disabled);
  assert.equal(await viewer.locator('#detection-toggle').isChecked(), false, 'saved off must prevent model recovery');
  assert.equal((await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState())).pid, null);
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].id), captureId);
  assert.deepEqual(errors, []);
  await writeFile('test-results/optional-compute/report.json', JSON.stringify({ passed: true, time: new Date().toISOString(), checks: ['offline advanced controls disabled', 'default off registration without loading model', 'real native ONNX results on separate browser viewer', 'disable and desktop exit terminate model PID', 'video continues while compute offline', 'saved on restores after app exit/settings return/network loss', 'saved off prevents automatic model start'] }, null, 2));
  console.log('PASS: optional native compute, real person detection, process release and automatic capability recovery; base video uninterrupted.');
} finally { await desktop?.close(); await browser?.close(); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
