import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';
const require = createRequire(import.meta.url), desktopMode = process.argv.includes('--desktop');
const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-settings-'));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const httpsPort = await port(), httpPort = await port(), origin = `https://127.0.0.1:${httpsPort}`;
let service, browser, desktop; const pages = [];
function probe() {
  window.showSaveFilePicker = undefined;
  window.testPeers = []; window.testSockets = [];
  const Peer = RTCPeerConnection, Socket = WebSocket;
  window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.WebSocket = class extends Socket { constructor(...args) { super(...args); window.testSockets.push(this); } };
}
try {
  if (!desktopMode) service = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort, httpPort, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') });
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], acceptDownloads: true });
  await context.addInitScript(probe); const camera = await context.newPage();
  await camera.addInitScript(() => {
    window.testVideos = []; window.testMicrophones = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.video) { const s = await capture(constraints); window.testMicrophones.push(...s.getAudioTracks()); return s; }
      const facing = constraints.video.facingMode?.exact || constraints.video.facingMode?.ideal || 'environment';
      if (window.testExclusive && window.testVideos.some(t => t.readyState === 'live')) throw new DOMException('Camera busy', 'NotReadableError');
      if (window.testDeniedFacing === facing) throw new DOMException('Camera permission denied', 'NotAllowedError');
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      canvas.height = constraints.video.height?.ideal || 720; canvas.width = Math.round(canvas.height * 16 / 9);
      const draw = () => { ctx.fillStyle = facing === 'user' ? '#d04030' : '#2090d0'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#fff'; ctx.fillRect((Date.now() / 10) % (canvas.width - 60), canvas.height / 2, 50, 50); };
      draw(); const timer = setInterval(draw, 50), stream = canvas.captureStream(15), track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      track.applyConstraints = async value => { canvas.width = value.width.ideal; canvas.height = value.height.ideal; draw(); };
      window.testVideos.push(track);
      if (window.testDelayCapture) { window.testDelayCapture = false; await new Promise(resolve => { window.testReleaseCapture = resolve; }); }
      return stream;
    };
    const replace = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = function(track) { if (track?.kind === 'video' && window.testRequireNegotiation) { window.testRequireNegotiation = false; return Promise.reject(new DOMException('Envelope changed', 'InvalidModificationError')); } return replace.call(this, track); };
  });
  let viewer;
  if (desktopMode) {
    const env = { ...process.env, TURN_PORT: '0', FREECAMERA_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort) }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.env.FREECAMERA_DESKTOP_EXECUTABLE;
    desktop = await electron.launch({ executablePath: executable || require('electron'), args: executable ? ['--use-fake-device-for-media-stream', '--mute-audio'] : [path.resolve('.'), '--use-fake-device-for-media-stream', '--mute-audio'], env }); viewer = await desktop.firstWindow(); await viewer.waitForURL('**/platform*'); await viewer.goto(`${origin}/?mode=viewer`); await viewer.evaluate(probe);
  } else { viewer = await context.newPage(); await viewer.goto(`${origin}/?mode=viewer`); }
  const errors = []; pages.push(camera, viewer); for (const p of pages) p.on('pageerror', e => errors.push(e.message));
  await camera.goto(`${origin}/?mode=camera`); await camera.locator('#start').click(); await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  await loginViewer(viewer); await viewer.locator('.device-connect').click(); await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  assert.equal(await camera.locator('#facing').isEnabled(), true, 'lens selection must stay enabled during monitoring');
  assert.equal(await camera.locator('#quality').isEnabled(), true, 'quality selection must stay enabled during monitoring');
  const original = await camera.evaluate(() => ({ code: document.querySelector('#pair-code').textContent, audio: document.querySelector('video').srcObject.getAudioTracks()[0].id, socketCount: window.testSockets.length, video: document.querySelector('video').srcObject.getVideoTracks()[0].id }));
  const peerCount = await viewer.evaluate(() => window.testPeers.length);
  if (desktop) {
    const recording = path.resolve('test-results/camera-settings/native-switch.webm'); await mkdir(path.dirname(recording), { recursive: true }); await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, recording);
  }
  await viewer.locator('#record').click(); assert.equal(await viewer.locator('#record').textContent(), '停止录像'); const recordStarted = await viewer.evaluate(() => performance.now()); await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => document.querySelector('#talkback').getAttribute('aria-pressed') === 'true');
  async function frame(height, red, target = viewer) { await target.waitForFunction(({ height, red }) => { const v = document.querySelector('video'), c = document.querySelector('#video-canvas'); if (v.videoHeight !== height || c.height !== height) return false; const pixel = c.getContext('2d').getImageData(10, 10, 1, 1).data; return red ? pixel[0] > pixel[2] + 60 : pixel[2] > pixel[0] + 60; }, { height, red }); }
  await camera.locator('#quality').selectOption('480'); await frame(480, false);
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].id), original.video, 'resolution-only changes should apply constraints on the current track');
  await camera.locator('#facing').selectOption('user'); await frame(480, true);
  assert.equal(await camera.evaluate(() => window.testVideos[0].readyState), 'ended', 'old video capture must be released');
  assert.equal(await viewer.evaluate(() => window.testPeers.length), peerCount, 'ordinary camera changes must preserve the video peer');
  assert.equal(await viewer.locator('#record').textContent(), '停止录像'); assert.equal(await viewer.locator('#talkback').getAttribute('aria-pressed'), 'true');
  await camera.evaluate(() => { window.testDelayCapture = true; }); await camera.locator('#facing').selectOption('environment'); await camera.waitForFunction(() => !!window.testReleaseCapture);
  const late = await context.newPage(); late.on('pageerror', e => errors.push(e.message)); await late.goto(`${origin}/?mode=viewer`); if (desktopMode) await loginViewer(late); await late.locator('.device-connect').click(); await frame(480, true, late);
  await camera.locator('#facing').selectOption('user'); await camera.locator('#quality').selectOption('720'); await camera.evaluate(() => { window.testReleaseCapture(); window.testReleaseCapture = null; }); await frame(720, true);
  await frame(720, true, late); await late.close();
  await camera.evaluate(() => { window.testExclusive = true; }); await camera.locator('#facing').selectOption('environment'); await frame(720, false);
  await camera.evaluate(() => { window.testDeniedFacing = 'user'; }); await camera.locator('#facing').selectOption('user');
  await camera.waitForFunction(() => document.querySelector('#facing').value === 'environment' && document.querySelector('#camera-settings-status').textContent.includes('失败')); await frame(720, false);
  assert.equal(await viewer.locator('#record').textContent(), '停止录像'); assert.equal(await viewer.locator('#talkback').getAttribute('aria-pressed'), 'true');
  const retained = await camera.evaluate(() => ({ code: document.querySelector('#pair-code').textContent, audio: document.querySelector('video').srcObject.getAudioTracks()[0].id, socketCount: window.testSockets.length }));
  assert.deepEqual(retained, { code: original.code, audio: original.audio, socketCount: original.socketCount });
  assert.equal(await camera.evaluate(() => window.testMicrophones[0].readyState), 'live');
  // Let the recorder encode several frames from the final lens before stopping.
  const finalFrameTime = await viewer.locator('video').evaluate(v => v.currentTime);
  await viewer.waitForFunction(time => document.querySelector('video').currentTime > time + .8, finalFrameTime);
  const lastFrameTime = (await viewer.evaluate(() => performance.now()) - recordStarted) / 1000;
  await viewer.locator('#talkback').click();
  if (desktop) {
    const recording = path.resolve('test-results/camera-settings/native-switch.webm'); await mkdir(path.dirname(recording), { recursive: true }); await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, recording);
  }
  const download = desktop ? null : viewer.waitForEvent('download'); await viewer.locator('#record').click(); if (download) { await mkdir('test-results/camera-settings', { recursive: true }); await (await download).saveAs('test-results/camera-settings/browser-switch.webm'); } else await viewer.waitForFunction(() => document.querySelector('#capture-info').textContent.includes('录像已保存'));
  const recorded = await readFile(`test-results/camera-settings/${desktop ? 'native' : 'browser'}-switch.webm`);
  const decoded = await viewer.evaluate(async ({ base64, time }) => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'video/webm' })), v = document.createElement('video'); v.muted = true; v.src = url;
    try { await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = reject; }); await new Promise((resolve, reject) => { v.onseeked = resolve; v.onerror = reject; v.currentTime = Math.max(.1, time - .3); }); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0); return { width: c.width, height: c.height, pixel: [...ctx.getImageData(10, 10, 1, 1).data], time: v.currentTime }; }
    finally { v.src = ''; URL.revokeObjectURL(url); }
  }, { base64: recorded.toString('base64'), time: lastFrameTime });
  assert.ok(decoded.width > 0 && decoded.height > 0 && decoded.pixel[2] > decoded.pixel[0] + 60 && decoded.time > 1, `saved recording must decode frames from after the lens and resolution changes: ${JSON.stringify(decoded)}`);
  await camera.evaluate(() => { window.testExclusive = false; window.testDeniedFacing = null; window.testRequireNegotiation = true; }); await camera.locator('#facing').selectOption('user'); await frame(720, true);
  await viewer.waitForFunction(count => window.testPeers.length > count && document.querySelector('#status').textContent === '实时画面', peerCount);
  await camera.evaluate(() => { window.testDelayCapture = true; }); await camera.locator('#facing').selectOption('environment'); await camera.waitForFunction(() => !!window.testReleaseCapture);
  await camera.locator('#stop').click(); assert.equal(await camera.locator('video').evaluate(v => v.srcObject), null); assert.equal(await camera.locator('#pair-code').textContent(), '');
  await camera.locator('#start').click(); await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  const currentVideoId = await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].id); await camera.evaluate(() => window.testReleaseCapture());
  await camera.waitForFunction(id => window.testVideos.every(t => t.id === id ? t.readyState === 'live' : t.readyState === 'ended'), currentVideoId);
  await camera.locator('#stop').click();
  await camera.waitForFunction(() => window.testVideos.every(t => t.readyState === 'ended') && window.testMicrophones.every(t => t.readyState === 'ended'));
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject), null); assert.equal(await camera.locator('#pair-code').textContent(), ''); assert.deepEqual(errors, []);
  await mkdir('test-results/camera-settings', { recursive: true }); await writeFile(`test-results/camera-settings/${desktopMode ? 'desktop' : 'browser'}-report.json`, JSON.stringify({ passed: true, time: new Date().toISOString(), checks: ['live lens and quality controls', 'real remote frame/color/resolution changes', 'constraints preserve track', 'microphone/peer/socket/identity retained', 'recording and talkback continue', 'recording decodes frames after settings changes', 'new viewer during pending switch', 'rapid changes settle on latest', 'exclusive-camera retry and rollback', 'renegotiation fallback', 'stop and immediate restart discard old capture'], decoded, fixture: 'two canvas camera devices at external capture API, real WebRTC and recording' }, null, 2));
  console.log(`PASS (${desktopMode ? 'desktop' : 'browser'}): live settings, unchanged audio/connection/recording/talkback, rollback, cancellation`);
} catch (error) { console.error('CAMERA SETTINGS FAILURE', await Promise.all(pages.map(p => p.evaluate(() => ({ status: document.querySelector('#status')?.textContent, settings: document.querySelector('#camera-settings-status')?.textContent, error: document.querySelector('#error')?.textContent, facing: document.querySelector('#facing')?.value, quality: document.querySelector('#quality')?.value, video: { width: document.querySelector('video')?.videoWidth, height: document.querySelector('video')?.videoHeight, tracks: document.querySelector('video')?.srcObject?.getTracks().map(t => ({ state: t.readyState, settings: t.getSettings() })) }, fixtureVideos: window.testVideos?.length })).catch(() => null)))); throw error;
} finally { await desktop?.close(); await browser?.close(); await service?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
