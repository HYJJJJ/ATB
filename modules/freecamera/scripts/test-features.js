import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createDetector } from '../server/detector.js';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';

const dataDir = await mkdtemp(path.join(tmpdir(), 'freecamera-features-'));
await mkdir('test-results', { recursive: true });
const image = await readFile(new URL('../models/validation-person.jpg', import.meta.url));
const detector = createDetector();
const service = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort: 19443, httpPort: 19080, certDir: path.join(dataDir, "certs"), dataDir, detector });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const errors = []; const camera = await context.newPage();
  await camera.addInitScript(base64 => {
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.audio) throw new DOMException('Synthetic video fixture has no microphone', 'NotFoundError');
      const image = new Image(); image.src = `data:image/jpeg;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); window.testPersonVisible = true;
      const draw = () => { if (window.testPersonVisible) ctx.drawImage(image, 0, 0); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); } };
      draw(); setInterval(draw, 100); return canvas.captureStream(15);
    };
  }, image.toString('base64'));
  const viewer = await context.newPage();
  await viewer.addInitScript(() => {
    window.showSaveFilePicker = undefined; window.testFrameSends = 0;
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      get bufferedAmount() { return window.testCongested ? 131072 : super.bufferedAmount; }
      send(data) { if (JSON.parse(data).type === 'detection-frame') window.testFrameSends++; return super.send(data); }
    };
  });
  for (const p of [camera, viewer]) p.on('pageerror', e => errors.push(e.message));
  const base = 'https://127.0.0.1:19443';
  await camera.goto(`${base}/?mode=camera`); await camera.getByRole('button', { name: '开始监控', exact: true }).click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  const code = await camera.locator('#pair-code').textContent();
  await viewer.goto(`${base}/?mode=viewer`); await loginViewer(viewer); await viewer.getByLabel('摄像头配对码').fill(code);
  await viewer.getByRole('button', { name: '连接摄像头', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  assert.equal(detector.state.status, 'off'); assert.equal(detector.state.pid, null);
  const snapshotPending = viewer.waitForEvent('download'); await viewer.getByRole('button', { name: '截图 PNG' }).click();
  const snapshot = await snapshotPending; await snapshot.saveAs('test-results/captured.png');
  const png = await sharp('test-results/captured.png').metadata(); assert.ok(png.height > png.width);
  await viewer.getByRole('button', { name: '开始录像', exact: true }).click();
  await viewer.waitForTimeout(1400);
  const recordingPending = viewer.waitForEvent('download'); await viewer.getByRole('button', { name: '停止录像', exact: true }).click();
  const recording = await recordingPending; await recording.saveAs('test-results/captured.webm');
  const saved = await readFile('test-results/captured.webm'); assert.ok(saved.length > 1000);
  const dimensions = await viewer.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); const v = document.createElement('video');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' })); v.src = url;
    await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = reject; });
    const size = [v.videoWidth, v.videoHeight]; URL.revokeObjectURL(url); return size;
  }, saved.toString('base64'));
  assert.ok(dimensions[1] > dimensions[0]);
  const second = await context.newPage(); second.on('pageerror', e => errors.push(e.message));
  await second.goto(`${base}/?mode=viewer`);
  await second.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await viewer.getByLabel('开启人物检测').check();
  await viewer.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('运行中'), null, { timeout: 30000 });
  const pid = detector.state.pid; assert.ok(pid); process.kill(pid, 0);
  await second.waitForFunction(() => document.querySelector('#detection-toggle').checked);
  await viewer.waitForFunction(() => document.querySelector('#event-list').textContent.includes('出现'), null, { timeout: 15000 });
  assert.match(await viewer.locator('#person-count').textContent(), /[1-9]/);
  await viewer.screenshot({ path: 'test-results/features-detection.png', fullPage: true });
  const frameSends = await viewer.evaluate(() => { window.testCongested = true; return window.testFrameSends; });
  await camera.evaluate(() => { window.testPersonVisible = false; });
  await viewer.waitForFunction(() => document.querySelector('#event-list').textContent.includes('离开'), null, { timeout: 15000 });
  assert.equal(await viewer.evaluate(() => window.testFrameSends), frameSends, 'congested viewer drops frames while another viewer supplies inference');
  await second.getByLabel('开启人物检测').uncheck();
  await second.waitForFunction(() => document.querySelector('#detection-status').textContent.includes('模型进程已退出'));
  assert.equal(detector.state.pid, null); assert.throws(() => process.kill(pid, 0));
  await viewer.waitForFunction(() => !document.querySelector('#detection-toggle').checked);
  await camera.getByRole('button', { name: '停止监控', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('#presence').textContent.includes('离线'));
  await viewer.reload(); await viewer.waitForFunction(() => document.querySelector('#presence').textContent.includes('离线'));
  await camera.getByRole('button', { name: '开始监控', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await second.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  // Slow disk finalization must not revive an offer from a disconnected session.
  const race = await context.newPage(); race.on('pageerror', e => errors.push(e.message));
  await race.addInitScript(() => {
    window.testConnections = 0; window.testOffers = 0;
    const OriginalPeer = RTCPeerConnection, OriginalSocket = WebSocket;
    window.RTCPeerConnection = class extends OriginalPeer { constructor(...args) { super(...args); window.testConnections++; } };
    window.WebSocket = class extends OriginalSocket { constructor(...args) { super(...args); this.addEventListener('message', e => { if (JSON.parse(e.data).type === 'offer') window.testOffers++; }); } };
    window.testWriteBarrier = new Promise(r => { window.releaseTestWrites = r; });
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ async write() { window.testWriteStarted = true; await window.testWriteBarrier; }, async close() {} }) });
  });
  await race.goto(`${base}/?mode=viewer`); await race.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await race.getByRole('button', { name: '开始录像', exact: true }).click();
  await race.waitForFunction(() => window.testWriteStarted === true);
  const offers = await race.evaluate(() => window.testOffers);
  await camera.getByRole('button', { name: '停止监控', exact: true }).click();
  await camera.getByRole('button', { name: '开始监控', exact: true }).click();
  await race.waitForFunction(count => window.testOffers > count, offers);
  await race.getByRole('button', { name: '断开连接', exact: true }).click();
  const connections = await race.evaluate(() => { const n = window.testConnections; window.releaseTestWrites(); return n; });
  await race.waitForTimeout(500);
  assert.equal(await race.evaluate(() => window.testConnections), connections, 'stale offer cannot create a peer after session disconnect');
  await race.close();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await viewer.screenshot({ path: 'test-results/features.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: PNG capture, saved recording decode, multi-view auto reconnect/offline persistence, real person events, source failover, bounded frame sends, model PID release, stale-offer cancellation, no page errors');
} finally { await browser.close(); await service.close(); await rm(dataDir, { recursive: true, force: true }); }
