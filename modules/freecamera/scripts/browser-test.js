import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startServers } from '../../../server/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginViewer } from './account-test-helper.js';

const dataDir = await mkdtemp(path.join(tmpdir(), 'freecamera-browser-'));
const server = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort: 18443, httpPort: 18080, certDir: path.join(dataDir, 'certs'), dataDir });
let browser;
try {
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const camera = await context.newPage(); const viewer = await context.newPage();
  // Exercise the iPhone-like H.264 + portrait path, not only Chromium's VP8 default.
  await camera.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.video) return original(constraints);
      const captured = await original(constraints);
      const source = document.createElement('video'); source.muted = true; source.srcObject = captured;
      await source.play();
      const portrait = document.createElement('canvas'); portrait.width = 360; portrait.height = 640;
      const ctx = portrait.getContext('2d');
      const draw = () => { ctx.drawImage(source, 0, 0, 360, 640); requestAnimationFrame(draw); }; draw();
      return portrait.captureStream(15);
    };
    const addTrack = RTCPeerConnection.prototype.addTrack;
    RTCPeerConnection.prototype.addTrack = function (...args) {
      const sender = addTrack.apply(this, args);
      if (args[0].kind !== 'video') return sender;
      const codecs = RTCRtpSender.getCapabilities('video').codecs.filter(c => c.mimeType === 'video/H264');
      this.getTransceivers().find(t => t.sender === sender).setCodecPreferences(codecs);
      return sender;
    };
  });
  const errors = [];
  for (const page of [camera, viewer]) page.on('pageerror', e => errors.push(e.message));
  await camera.goto('https://127.0.0.1:18443/?mode=camera');
  await camera.getByRole('button', { name: '开始监控', exact: true }).click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code')?.textContent));
  const code = await camera.locator('#pair-code').textContent();
  await viewer.goto('https://127.0.0.1:18443/?mode=viewer');
  await loginViewer(viewer);
  await viewer.getByLabel('摄像头配对码').fill(code);
  await viewer.getByRole('button', { name: '连接摄像头', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('video').videoWidth > 0, { timeout: 15000 });
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  const frames = await viewer.locator('video').evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  assert.ok(frames.width > 0); console.log('Received decoded video:', frames);
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector('#video-canvas');
    if (!canvas || canvas.width >= canvas.height) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255, max = 0;
    for (let i = 0; i < pixels.length; i += 64) { min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]); }
    return max - min > 40;
  }, null, { timeout: 5000 });
  await viewer.getByRole('button', { name: '断开连接', exact: true }).click();
  await viewer.getByRole('button', { name: '连接摄像头', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await viewer.screenshot({ path: 'test-results/live.png', fullPage: true });
  await viewer.getByRole('button', { name: '全屏 ↗' }).click();
  await viewer.waitForFunction(() => !!document.fullscreenElement);
  assert.equal(await viewer.evaluate(() => document.fullscreenElement.contains(document.querySelector('#stream-alert'))), true,
    'fullscreen must include the interruption overlay');
  await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].stop());
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '画面已中断');
  assert.equal(await viewer.locator('#stream-alert').isVisible(), true, 'stale frames must be visibly covered');
  await viewer.evaluate(() => document.exitFullscreen());
  await camera.getByRole('button', { name: '停止监控', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '摄像头已停止');
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject), null);
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto('https://127.0.0.1:18443/?mode=camera');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await viewer.screenshot({ path: 'test-results/viewer.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: pairing, decoded video frames, reconnect, frozen-frame detection, stop notification, mobile layout, no page errors');
} finally { await browser?.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); }
