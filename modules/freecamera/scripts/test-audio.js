import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer, testCredentials } from './account-test-helper.js';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-audio-'));
const desktopMode = process.argv.includes('--desktop'), mode = desktopMode ? 'desktop' : 'browser';
const require = createRequire(import.meta.url);
await mkdir('test-results/audio', { recursive: true });
const wav = Buffer.alloc(44 + 48000 * 2 * 10);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 480000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 8000), 44 + i * 2);
const tone = path.join(directory, 'tone.wav'); await writeFile(tone, wav);
const httpsPort = await freePort(), httpPort = await freePort();
const service = desktopMode ? null : await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort, httpPort, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') });
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, '--mute-audio'] });
let desktop;
function viewerProbe() {
  window.showSaveFilePicker = undefined; window.testPeers = [];
  const Original = RTCPeerConnection;
  window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.testAudioEnergy = async () => {
    let energy = 0;
    for (const peer of window.testPeers) if (peer.connectionState === 'connected') (await peer.getStats()).forEach(report => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') energy += report.totalAudioEnergy || 0;
    });
    return energy;
  };
}
async function saveRecording(page, filename, nativeWindow) {
  if (nativeWindow) {
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#capture-info').textContent.includes('录像已保存'));
  } else {
    const download = page.waitForEvent('download'); await page.locator('#record').click(); await (await download).saveAs(filename);
  }
  return page.evaluate(async base64 => {
    const context = new AudioContext();
    try {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const audio = await context.decodeAudioData(bytes.buffer); let peak = 0;
      for (const sample of audio.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      return { channels: audio.numberOfChannels, duration: audio.duration, peak };
    } finally { await context.close(); }
  }, (await readFile(filename)).toString('base64'));
}
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], acceptDownloads: true });
  const camera = await context.newPage(); let viewer;
  if (desktopMode) {
    const env = { ...process.env, TURN_PORT: '0', FREECAMERA_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort) }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.env.FREECAMERA_DESKTOP_EXECUTABLE;
    desktop = await electron.launch({ executablePath: executable || require('electron'), args: executable ? ['--mute-audio'] : [path.resolve('.'), '--mute-audio'], env });
    viewer = await desktop.firstWindow();
  } else viewer = await context.newPage();
  const errors = [];
  for (const page of [camera, viewer]) page.on('pageerror', error => errors.push(error.message));
  await camera.addInitScript(() => {
    window.testMicrophones = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints); window.testMicrophones.push(...stream.getAudioTracks()); return stream;
    };
  });
  await viewer.addInitScript(viewerProbe);
  const base = `https://127.0.0.1:${httpsPort}`;
  await camera.goto(`${base}/?mode=camera`); await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  assert.equal(await camera.locator('video').evaluate(video => video.srcObject.getAudioTracks().length), 1, 'camera must capture a real microphone track');
  await viewer.goto(`${base}/?mode=viewer`);
  await loginViewer(viewer);
  await viewer.locator('#code').fill(await camera.locator('#pair-code').textContent()); await viewer.locator('#join').click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await viewer.waitForFunction(async () => await window.testAudioEnergy() > .001);
  assert.equal(await viewer.locator('video').evaluate(video => video.muted), true, 'listening starts muted');
  await viewer.locator('#listen').click();
  assert.equal(await viewer.locator('video').evaluate(video => video.muted), false);
  await viewer.locator('#volume').evaluate(input => { input.value = '35'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await viewer.locator('video').evaluate(video => video.volume), .35);
  await viewer.locator('#listen').click();
  assert.equal(await viewer.locator('video').evaluate(video => video.muted), true);
  await viewer.locator('#volume').evaluate(input => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const filename = path.resolve(`test-results/audio/${mode}-with-sound.webm`);
  if (desktop) await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filename);
  await viewer.locator('#record').click(); await viewer.waitForTimeout(700);
  const peersBefore = await viewer.evaluate(() => window.testPeers.length);
  await camera.locator('#microphone-toggle').uncheck();
  await viewer.waitForFunction(() => document.querySelector('#audio-status').textContent.includes('麦克风已关闭'));
  assert.equal(await camera.evaluate(() => window.testMicrophones.every(track => track.readyState === 'ended')), true, 'switching microphone off must release capture tracks');
  assert.equal(await viewer.locator('#record').textContent(), '停止录像', 'microphone toggles must preserve recording');
  const secondContext = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const second = await secondContext.newPage(); await second.addInitScript(viewerProbe); second.on('pageerror', error => errors.push(error.message));
  await second.goto(`${base}/?mode=viewer`); await loginViewer(second); await second.locator('#code').fill(await camera.locator('#pair-code').textContent()); await second.locator('#join').click();
  await second.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  assert.equal(await second.locator('#listen').isDisabled(), true, 'late viewer must see the disabled microphone');
  await second.locator('#record').click(); await second.waitForTimeout(500);
  const energyBefore = await viewer.evaluate(() => window.testAudioEnergy());
  await camera.locator('#microphone-toggle').check();
  await viewer.waitForFunction(async previous => await window.testAudioEnergy() > previous + .005, energyBefore);
  await second.waitForFunction(async () => await window.testAudioEnergy() > .001);
  assert.equal(await viewer.evaluate(() => window.testPeers.length), peersBefore, 'enabling microphone must not replace the video peer');
  await viewer.waitForTimeout(1000);
  const decodedAudio = await saveRecording(viewer, filename, desktop);
  assert.ok(decodedAudio.channels > 0 && decodedAudio.duration > 1 && decodedAudio.peak > .01,
    'recording must contain decoded non-silent microphone audio even when viewer volume is zero');
  assert.equal(await camera.evaluate(() => window.testMicrophones.at(-1).readyState), 'live', 'stopping a recording must not stop the camera microphone');
  const lateAudio = await saveRecording(second, path.resolve(`test-results/audio/${mode}-late-sound.webm`));
  assert.ok(lateAudio.peak > .01, 'recording started before microphone enable must capture sound when it returns');
  await camera.locator('#stop').click();
  assert.equal(await camera.evaluate(() => window.testMicrophones.every(track => track.readyState === 'ended')), true);
  const deniedContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera'] });
  const denied = await deniedContext.newPage(); denied.on('pageerror', error => errors.push(error.message));
  // Fake capture UI bypasses browser denials; simulate only that external permission boundary.
  await denied.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => constraints.audio
      ? Promise.reject(new DOMException('Microphone permission denied', 'NotAllowedError')) : capture(constraints);
  });
  await denied.goto(`${base}/?mode=camera`);
  await denied.locator('#start').click();
  await denied.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  assert.equal(await denied.locator('video').evaluate(video => video.srcObject.getVideoTracks()[0].readyState), 'live');
  assert.equal(await denied.locator('#microphone-toggle').isChecked(), false);
  assert.match(await denied.locator('#microphone-status').textContent(), /未获授权/);
  await denied.locator('#stop').click();
  const raceContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const race = await raceContext.newPage(); race.on('pageerror', error => errors.push(error.message));
  await race.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints);
      if (constraints.audio) { window.testLateMicrophone = stream; await new Promise(resolve => { window.releaseMicrophone = resolve; }); }
      return stream;
    };
  });
  await race.goto(`${base}/?mode=camera`); await race.locator('#start').click();
  await race.waitForFunction(() => !!window.releaseMicrophone); await race.locator('#stop').click();
  await race.evaluate(() => window.releaseMicrophone());
  await race.waitForFunction(() => window.testLateMicrophone.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(await race.locator('video').evaluate(video => video.srcObject), null);
  assert.equal(await race.locator('#pair-code').textContent(), '');
  assert.deepEqual(errors, []);
  await writeFile(`test-results/audio/${mode}-report.json`, JSON.stringify({ passed: true, time: new Date().toISOString(), mode, decodedAudio, lateAudio, checks: ['real non-silent WebRTC audio', 'listening/mute/volume', 'recorded audio independent of viewer mute', 'microphone stop releases capture', 'multiple viewers', 'live audio toggle preserves video/recording', 'recording starts before microphone enable', 'permission denied keeps video', 'stop cancels pending microphone'] }, null, 2));
  console.log(`PASS (${mode}): real WebRTC audio, listening/mute/volume, recordings with decoded non-silent audio, microphone release/live toggles, late viewer/recording, permission denial, pending capture cancellation`);
} finally { await desktop?.close(); await browser.close(); await service?.close(); await rm(directory, { recursive: true, force: true }); }
