import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron as electron, chromium } from 'playwright';
import { PNG } from 'pngjs';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const output = path.join(root, 'test-results', 'desktop');
await mkdir(output, { recursive: true });
const dataRoot = await mkdtemp(path.join(tmpdir(), 'freecamera-desktop-'));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function launch(httpsPort, httpPort) {
  const environment = { ...process.env, TURN_PORT: '0', FREECAMERA_DATA_DIR: dataRoot, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const packagedExecutable = process.env.FREECAMERA_DESKTOP_EXECUTABLE;
  return electron.launch({ executablePath: packagedExecutable ? path.resolve(packagedExecutable) : require('electron'), args: packagedExecutable ? [] : [root], env: environment, timeout: 30000 });
}

const httpsPort = await freePort();
const httpPort = await freePort();
let desktop;
let reused;
let cameraBrowser;
try {
  desktop = await launch(httpsPort, httpPort);
  const page = await desktop.firstWindow();
  await page.waitForURL("**/platform*");
  await page.goto(`https://127.0.0.1:${httpsPort}/?mode=viewer`);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(async () => (await import("/desktop-bridge.js")).cameraDesktop?.isDesktop === true && document.querySelector('#status'));
  assert.equal(new URL(page.url()).origin, `https://127.0.0.1:${httpsPort}`);
  assert.deepEqual(await page.evaluate(async () => ({ node: typeof require, process: typeof process })), { node: 'undefined', process: 'undefined' });
  assert.deepEqual(await desktop.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(await listening(httpsPort), true, 'desktop must start an HTTPS server');
  assert.equal(await page.locator('#view-workspace').isVisible(), false, 'desktop must show account login before viewing');
  await loginViewer(page, { username: '中', password: '1' });

  assert.equal(await page.evaluate(async () => navigator.windowControlsOverlay?.visible), true,
    'native window controls must be integrated into the application title bar');
  const titleBar = await page.locator('header').evaluate(header => {
    const rect = header.getBoundingClientRect();
    const available = navigator.windowControlsOverlay.getTitlebarAreaRect();
    return { top: rect.top, height: rect.height, drag: getComputedStyle(header).getPropertyValue('app-region'),
      brandDrag: getComputedStyle(header.querySelector('.brand')).getPropertyValue('app-region'),
      contentRight: header.querySelector('.local-tag').getBoundingClientRect().right,
      controlsLeft: available.x + available.width, windowWidth: innerWidth };
  });
  assert.equal(titleBar.top, 0); assert.equal(titleBar.height, 56);
  assert.equal(titleBar.drag, 'drag'); assert.equal(titleBar.brandDrag, 'no-drag');
  assert.ok(titleBar.controlsLeft < titleBar.windowWidth, 'native caption buttons must have reserved space');
  assert.ok(titleBar.contentRight <= titleBar.controlsLeft, 'header content must not overlap caption buttons');
  await page.screenshot({ path: path.join(output, 'titlebar.png') });
  const nativeTitlebar = await desktop.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const win = BrowserWindow.getAllWindows()[0], [width, height] = win.getSize();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
    return sources.find(source => source.id === win.getMediaSourceId())?.thumbnail.toPNG().toString('base64');
  });
  assert.ok(nativeTitlebar, 'capture this ATB window including native controls');
  await writeFile(path.join(output, 'native-titlebar.png'), Buffer.from(nativeTitlebar, 'base64'));

  for (const [event, action, check] of [['maximize', 'maximize', 'isMaximized'], ['unmaximize', 'unmaximize', 'isNormal'], ['minimize', 'minimize', 'isMinimized'], ['restore', 'restore', 'isNormal']]) {
    assert.equal(await desktop.evaluate(({ BrowserWindow }, [event, action, check]) => new Promise(resolve => {
      const win = BrowserWindow.getAllWindows()[0];
      win.once(event, () => resolve(win[check]())); win[action]();
    }), [event, action, check]), true, `native ${action} must still work`);
  }

  const screenshotPath = path.join(output, 'snapshot.png');
  await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, screenshotPath);
  assert.equal(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#e6293f'; context.fillRect(0, 0, 96, 64);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const result = await (await import("/desktop-bridge.js")).cameraDesktop.saveSnapshot({ data: new Uint8Array(await blob.arrayBuffer()) });
    return result.canceled;
  }), false);
  const png = PNG.sync.read(await readFile(screenshotPath));
  assert.equal(png.width, 96); assert.equal(png.height, 64);
  assert.deepEqual([...png.data.subarray(0, 4)], [230, 41, 63, 255]);

  const recordingPath = path.join(output, 'recording.webm');
  await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, recordingPath);
  const recording = await page.evaluate(async () => {
    const api = (await import("/desktop-bridge.js")).cameraDesktop;
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
    document.body.appendChild(canvas);
    const context = canvas.getContext('2d', { willReadFrequently: true }); let frame = 0;
    const draw = () => {
      context.fillStyle = '#e6293f'; context.fillRect(0, 0, 160, 120);
      context.fillStyle = '#38bdf8'; context.fillRect((frame++ * 3) % 120, 20, 40, 60);
      context.getImageData(0, 0, 1, 1);
    };
    draw();
    const stream = canvas.captureStream(0);
    const timer = setInterval(() => { draw(); stream.getVideoTracks()[0].requestFrame(); }, 33);
    const mimeType = 'video/webm;codecs=vp8';
    const { id } = await api.beginRecording({ mimeType });
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = []; let writing = Promise.resolve(); let recorderError;
    recorder.onerror = event => { recorderError = `${event.error?.name}: ${event.error?.message}`; };
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      chunks.push(event.data);
      writing = writing.then(async () => api.writeRecording({ id, data: new Uint8Array(await event.data.arrayBuffer()) }));
    };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(100); await new Promise(resolve => setTimeout(resolve, 2200)); recorder.stop(); await stopped; await writing;
    const result = await api.endRecording({ id });
    if (!chunks.length) throw new Error(`Canvas recorder emitted no video: ${JSON.stringify({ settings: stream.getVideoTracks()[0].getSettings(), frame, state: recorder.state, visibility: document.visibilityState, recorderError, trackMuted: stream.getVideoTracks()[0].muted, trackState: stream.getVideoTracks()[0].readyState })}`);
    clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    const video = document.createElement('video'); video.muted = true;
    const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
    video.src = url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Saved recording could not decode')); });
    const dimensions = { width: video.videoWidth, height: video.videoHeight, path: result.path };
    URL.revokeObjectURL(url);
    canvas.remove();
    return dimensions;
  });
  assert.equal(recording.path, recordingPath); assert.equal(recording.width, 160); assert.equal(recording.height, 120);
  assert.ok((await readFile(recordingPath)).length > 500, 'recording must contain actual encoded video');
  const decoded = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = document.createElement('video'); video.src = url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Disk recording could not decode')); });
    const dimensions = [video.videoWidth, video.videoHeight]; URL.revokeObjectURL(url); return dimensions;
  }, (await readFile(recordingPath)).toString('base64'));
  assert.deepEqual(decoded, [160, 120]);

  await desktop.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.deepEqual(await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.beginRecording({ mimeType: 'video/webm' })), { canceled: true });
  assert.equal(await page.evaluate(async () => window.open('https://example.com/') === null), true);
  await page.screenshot({ path: path.join(output, 'window.png'), fullPage: true });
  assert.deepEqual(errors, []);

  cameraBrowser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const cameraContext = await cameraBrowser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera'] });
  const camera = await cameraContext.newPage();
  await camera.goto(`https://127.0.0.1:${httpsPort}/?mode=camera`);
  await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code')?.textContent));
  await page.locator('#camera-list .device-connect').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await page.locator('#detection-toggle').check();
  await page.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('运行中'));
  const detectorPid = Number((await page.locator('#detection-status').textContent()).match(/PID (\d+)/)[1]);
  assert.equal(processExists(detectorPid), true, 'Electron must run real inference in its child process');
  await page.locator('#detection-toggle').uncheck();
  await page.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('已关闭'));
  assert.equal(processExists(detectorPid), false, 'turning desktop detection off must reap the inference process');
  await page.locator('#detection-toggle').check();
  await page.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('运行中'));
  const closingDetectorPid = Number((await page.locator('#detection-status').textContent()).match(/PID (\d+)/)[1]);
  await page.screenshot({ path: path.join(output, 'window.png'), fullPage: true });
  const closeRecordingPath = path.join(output, 'recording-on-close.webm');
  await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, closeRecordingPath);
  await page.locator('#record').click();
  await page.waitForFunction(() => document.querySelector('#record').textContent === '停止录像');
  await page.waitForTimeout(2200);
  const processExited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop did not finish its active recording and exit')), 10000);
    desktop.process().once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await processExited; desktop = null;
  assert.equal(processExists(closingDetectorPid), false, 'closing the owned desktop service must stop its detector');
  assert.ok((await readFile(closeRecordingPath)).length > 500, 'closing the window must complete the active UI recording');
  const closeDecoded = await camera.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = document.createElement('video'); video.src = url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Recording saved on close could not decode')); });
    const dimensions = [video.videoWidth, video.videoHeight]; URL.revokeObjectURL(url); return dimensions;
  }, (await readFile(closeRecordingPath)).toString('base64'));
  assert.ok(closeDecoded[0] > 0 && closeDecoded[1] > 0);
  await cameraBrowser.close(); cameraBrowser = null;
  assert.equal(await listening(httpsPort), false, 'desktop must close the server it owns');
  assert.equal(await listening(httpPort), false, 'desktop must close both owned listeners');

  reused = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort, httpPort, certDir: path.join(dataRoot, 'certs'), dataDir: path.join(dataRoot, 'data') });
  desktop = await launch(httpsPort, httpPort);
  const reusedPage = await desktop.firstWindow();
  await reusedPage.waitForURL("**/platform*");
  await reusedPage.waitForLoadState("load");
  await desktop.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (contents.isLoading()) contents.once('did-stop-loading', () => setImmediate(resolve));
    else setImmediate(resolve);
  }));
  await reusedPage.goto(`https://127.0.0.1:${httpsPort}/?mode=viewer`);
  await reusedPage.waitForFunction(async () => (await import("/desktop-bridge.js")).cameraDesktop?.isDesktop === true);
  await reusedPage.evaluate(() => { location.href = 'https://example.com/'; });
  await reusedPage.waitForTimeout(150);
  assert.equal(new URL(reusedPage.url()).origin, `https://127.0.0.1:${httpsPort}`, 'external navigation must be denied');
  await desktop.close(); desktop = null;
  assert.equal(await listening(httpsPort), true, 'desktop must preserve an existing service on exit');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({
    passed: true, time: new Date().toISOString(), executable: process.env.FREECAMERA_DESKTOP_EXECUTABLE || require('electron'),
    checks: ['viewer account gate', 'direct camera directory selection', 'integrated native window controls', 'title bar drag regions', 'native minimize/maximize/restore', 'sandbox', 'context isolation', 'no renderer Node globals', 'pinned CA and HTTPS', 'PNG pixels', 'disk WebM decode', 'real CPU detector on/off/quit', 'active UI recording finalized on close', 'native dialog cancellation', 'external navigation denied', 'owned listeners closed', 'reused service preserved'],
    snapshot: screenshotPath, recording: recordingPath, recordingOnClose: closeRecordingPath,
    detectorPidsVerifiedExited: [detectorPid, closingDetectorPid],
  }, null, 2));
  console.log('PASS: secure Electron window, native PNG pixels, disk recording decode, real CPU detector on/off/quit, active UI recording saved on window close, cancellation, navigation protection, owned service cleanup, existing service reuse');
  console.log(`Desktop artifacts: ${output}`);
} finally {
  await desktop?.close();
  await cameraBrowser?.close();
  await reused?.close();
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
