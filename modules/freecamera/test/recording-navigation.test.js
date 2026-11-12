import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, chromium } from 'playwright';
import { loginViewer } from '../scripts/account-test-helper.js';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('platform and brand navigation preserve a short native recording final chunk before leaving the viewer', { timeout: 45000 }, async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'atb-recording-navigation-'));
  let desktop, browser;
  t.after(async () => { await browser?.close(); await desktop?.close(); await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const httpsPort = await freePort(), httpPort = await freePort(), origin = `https://127.0.0.1:${httpsPort}`;
  const environment = { ...process.env, FREECAMERA_DATA_DIR: dataRoot, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort), TURN_PORT: '0', DETECTION_ENABLED: '0' };
  delete environment.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: require('electron'), args: [root], env: environment, timeout: 15000 });
  const viewer = await desktop.firstWindow(); await viewer.waitForURL('**/platform*');
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const camera = await context.newPage(); await camera.goto(`${origin}/?mode=camera`);
  await camera.locator('#start').click(); await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code')?.textContent));
  const directory = path.join(root, 'test-results', 'atb', 'recording-navigation'); await mkdir(directory, { recursive: true });
  for (const [name, selector] of [['platform', '.platform-link'], ['brand', 'header .brand']]) {
    await viewer.goto(`${origin}/?mode=viewer`); await loginViewer(viewer);
    await viewer.locator('#camera-list .device-connect').click();
    await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
    const filename = path.join(directory, `${name}.webm`);
    await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename);
    await viewer.evaluate(() => {
      window.testNavigationChunks = 0;
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...options) {
        this.addEventListener('dataavailable', event => { if (event.data.size) window.testNavigationChunks++; });
        return start.apply(this, options);
      };
    });
    await viewer.locator('#record').click();
    await viewer.waitForFunction(() => document.querySelector('#record').textContent === '停止录像');
    await viewer.waitForTimeout(180);
    assert.equal(await viewer.evaluate(() => window.testNavigationChunks), 0, `${name}: fixture must navigate before the first periodic chunk`);
    await viewer.locator(selector).click(); await viewer.waitForURL('**/platform*');
    const saved = await readFile(filename);
    assert.ok(saved.length > 0, `${name}: navigation must write the final MediaRecorder chunk before suspending native recording`);
    const dimensions = await camera.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      const video = document.createElement('video'); video.muted = true; video.src = url;
      try {
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(Error('Navigation recording final chunk could not decode')); });
        return [video.videoWidth, video.videoHeight];
      } finally { video.src = ''; URL.revokeObjectURL(url); }
    }, saved.toString('base64'));
    assert.ok(dimensions[0] > 0 && dimensions[1] > 0, `${name}: saved short recording must contain decodable video`);
  }
});
