import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';

const require = createRequire(import.meta.url), desktopMode = process.argv.includes('--desktop');
const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-talkback-'));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const httpsPort = await port(), httpPort = await port(), origin = `https://127.0.0.1:${httpsPort}`;
const wav = Buffer.alloc(44 + 48000 * 2 * 3); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 144000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 10000), 44 + i * 2);
const tone = path.join(directory, 'tone.wav'); await writeFile(tone, wav);
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, '--mute-audio'];
let service, browser, desktop; const pages = [];
function microphoneProbe() {
  window.testMicrophones = [];
  window.testPeers = []; const Peer = window.RTCPeerConnection; window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.testTalkMessages = []; window.testSockets = [];
  const Socket = window.WebSocket; window.WebSocket = class extends Socket {
    constructor(...args) { super(...args); window.testSockets.push(this); }
    set onmessage(handler) { super.onmessage = event => { const body = JSON.parse(event.data); if (window.testHoldTalkMessages && body.type === 'talkback-state') window.testTalkMessages.push({ body, deliver: () => handler(event) }); else handler(event); }; }
    get onmessage() { return super.onmessage; }
  };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (window.testDenyCapture) throw new DOMException('Denied', 'NotAllowedError');
    const stream = await capture(constraints); window.testMicrophones.push(...stream.getAudioTracks());
    if (window.testHoldCapture) await new Promise(resolve => { window.testReleaseCapture = resolve; });
    return stream;
  };
}
try {
  if (!desktopMode) service = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort, httpPort, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') });
  browser = await chromium.launch({ args });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  await context.addInitScript(microphoneProbe);
  const camera = await context.newPage(); const errors = [];
  camera.on('pageerror', e => errors.push(e.message));
  await camera.addInitScript(() => {
    window.testOutputs = []; window.testContexts = [];
    const Audio = window.AudioContext; window.AudioContext = class extends Audio { constructor(...args) { super(...args); window.testContexts.push(this); } };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...args) {
      if (target === this.context.destination) { const analyser = this.context.createAnalyser(); connect.call(this, analyser); window.testOutputs.push(analyser); }
      return connect.call(this, target, ...args);
    };
    window.testSpeakerEnergy = () => { let peak = 0; for (const a of window.testOutputs) { const samples = new Float32Array(a.fftSize); a.getFloatTimeDomainData(samples); for (const value of samples) peak = Math.max(peak, Math.abs(value)); } return peak; };
  });
  let viewer;
  if (desktopMode) {
    const env = { ...process.env, TURN_PORT: '0', FREECAMERA_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort) }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.env.FREECAMERA_DESKTOP_EXECUTABLE;
    const desktopArgs = args.filter(arg => arg !== '--use-fake-ui-for-media-stream');
    desktop = await electron.launch({ executablePath: executable || require('electron'), args: executable ? desktopArgs : [path.resolve('.'), ...desktopArgs], env }); viewer = await desktop.firstWindow(); await viewer.waitForURL('**/platform*'); await viewer.goto(`${origin}/?mode=viewer`); await viewer.evaluate(microphoneProbe);
  } else { viewer = await context.newPage(); await viewer.goto(`${origin}/?mode=viewer`); }
  viewer.on('pageerror', e => errors.push(e.message));
  pages.push(camera, viewer);
  await camera.goto(`${origin}/?mode=camera`); await camera.locator('#microphone-toggle').uncheck(); await camera.locator('#start').click(); await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  await loginViewer(viewer); await viewer.locator('.device-connect').click(); await viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  assert.equal(await viewer.evaluate(() => window.testMicrophones.length), 0, 'viewing alone must not acquire the viewer microphone');
  if (desktopMode) for (const constraints of [{ video: true }, { video: true, audio: true }]) {
    assert.equal(await viewer.evaluate(async constraints => { try { const s = await navigator.mediaDevices.getUserMedia(constraints); s.getTracks().forEach(t => t.stop()); return 'allowed'; } catch (e) { return e.name; } }, constraints), 'NotAllowedError', 'desktop must keep camera permission denied');
  }
  await viewer.locator('#talkback').click({ timeout: 3000 });
  await camera.waitForFunction(() => window.testSpeakerEnergy() > .01, null, { timeout: 10000 });
  assert.equal(await viewer.locator('#talkback').getAttribute('aria-pressed'), 'true');
  await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => window.testMicrophones.every(t => t.readyState === 'ended'));
  await camera.waitForFunction(() => window.testSpeakerEnergy() < .0001);
  await viewer.evaluate(() => { window.testHoldTalkMessages = true; });
  await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => window.testTalkMessages.some(m => m.body.source));
  await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => window.testTalkMessages.some(m => !m.body.active));
  await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => window.testTalkMessages.filter(m => m.body.source).length === 2);
  await viewer.evaluate(() => { window.testHoldTalkMessages = false; for (const m of window.testTalkMessages.splice(0)) m.deliver(); });
  await viewer.waitForFunction(() => document.querySelector('#talkback').getAttribute('aria-pressed') === 'true', null, { timeout: 3000 });
  await camera.waitForFunction(() => window.testSpeakerEnergy() > .01); await viewer.locator('#talkback').click(); await camera.waitForFunction(() => window.testSpeakerEnergy() < .0001);
  await camera.evaluate(() => window.testContexts.at(-1).suspend());
  await viewer.locator('#talkback').click(); await camera.locator('#enable-talkback-audio').click(); await camera.waitForFunction(() => window.testSpeakerEnergy() > .01);
  if (desktopMode) await loginViewer(await context.newPage().then(async p => { await p.goto(`${origin}/?mode=viewer`); return p; }));
  const contender = await context.newPage(); contender.on('pageerror', e => errors.push(e.message)); await contender.goto(`${origin}/?mode=viewer`);
  if (desktopMode) await contender.locator('.device-connect').click();
  await contender.waitForFunction(() => document.querySelector('#status').textContent === '实时画面');
  await contender.locator('#talkback').click(); await contender.waitForFunction(() => document.querySelector('#talkback-status').textContent.includes('其他观看端'));
  await contender.waitForFunction(() => window.testMicrophones.every(t => t.readyState === 'ended'));
  await viewer.locator('#talkback').click(); await contender.locator('#talkback').click(); await camera.waitForFunction(() => window.testSpeakerEnergy() > .01);
  await contender.close(); await camera.waitForFunction(() => window.testSpeakerEnergy() < .0001);
  await viewer.locator('#talkback').click(); await camera.waitForFunction(() => window.testSpeakerEnergy() > .01);
  const peerCount = await viewer.evaluate(() => window.testPeers.length);
  await camera.evaluate(() => window.testSockets.filter(ws => ws.readyState === WebSocket.OPEN).forEach(ws => ws.close()));
  await viewer.waitForFunction(count => window.testPeers.length > count && document.querySelector('#status').textContent === '实时画面', peerCount);
  await viewer.waitForFunction(() => window.testMicrophones.every(t => t.readyState === 'ended'));
  await viewer.evaluate(async () => {
    const context = new AudioContext(), destination = context.createMediaStreamDestination(), oscillator = context.createOscillator(); oscillator.connect(destination); oscillator.start(); await context.resume();
    window.testUnapprovedTone = { context, destination, oscillator };
    await window.testPeers.at(-1).getSenders().find(s => s.track?.kind === 'audio' || window.testPeers.at(-1).getTransceivers().some(t => t.sender === s && t.receiver.track.kind === 'audio')).replaceTrack(destination.stream.getAudioTracks()[0]);
  });
  await camera.waitForFunction(async () => { let energy = 0; for (const pc of window.testPeers) if (pc.connectionState === 'connected') (await pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') energy += r.totalAudioEnergy || 0; }); return energy > .01; });
  const unapprovedPeaks = await camera.evaluate(async () => { const samples = []; for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 50)); samples.push(window.testSpeakerEnergy()); } return samples; });
  assert.ok(Math.max(...unapprovedPeaks) < .0001, 'camera must discard its old speaking grant when signaling reconnects');
  await viewer.evaluate(async () => { const tone = window.testUnapprovedTone; tone.oscillator.stop(); tone.destination.stream.getTracks().forEach(t => t.stop()); await tone.context.close(); });
  await viewer.evaluate(() => { window.testHoldCapture = true; }); await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => !!window.testReleaseCapture);
  await viewer.locator('#talkback').click(); await viewer.evaluate(() => { window.testHoldCapture = false; window.testReleaseCapture(); }); await viewer.waitForFunction(() => window.testMicrophones.every(t => t.readyState === 'ended'));
  await viewer.evaluate(() => { window.testDenyCapture = true; }); await viewer.locator('#talkback').click(); await viewer.waitForFunction(() => document.querySelector('#talkback-status').textContent.includes('权限'));
  assert.equal(await viewer.locator('#status').textContent(), '实时画面');
  await viewer.evaluate(() => { window.testDenyCapture = false; }); await viewer.locator('#talkback').click(); await camera.waitForFunction(() => window.testSpeakerEnergy() > .01);
  await viewer.locator('#disconnect').click(); await viewer.waitForFunction(() => window.testMicrophones.every(t => t.readyState === 'ended')); await camera.waitForFunction(() => window.testSpeakerEnergy() < .0001);
  assert.deepEqual(errors, []); await mkdir('test-results/talkback', { recursive: true });
  await writeFile(`test-results/talkback/${desktopMode ? 'desktop' : 'browser'}-report.json`, JSON.stringify({ passed: true, time: new Date().toISOString(), checks: ['viewer microphone default off', 'real non-silent audio routed to camera speaker with camera microphone off', 'stop releases capture and silences speaker', 'rapid start-stop-start survives delayed acknowledgments', 'suspended camera playback resumes by user gesture', 'single speaker contention and handoff', 'closing speaker releases slot', 'camera signaling reconnect discards prior speaking grant', 'late permission result canceled', 'permission denial preserves video', 'disconnect releases capture', ...(desktopMode ? ['native permission handler allows microphone and denies camera'] : [])] }, null, 2));
  console.log(`PASS (${desktopMode ? 'desktop' : 'browser'}): real talkback tone, speaker playback, contention, permission cancellation, capture release`);
} catch (error) {
  const snapshots = await Promise.all(pages.map(page => page.evaluate(async () => {
    const stats = []; for (const pc of window.testPeers || []) { try { (await pc.getStats()).forEach(r => { if (['inbound-rtp', 'outbound-rtp', 'media-source'].includes(r.type) && r.kind === 'audio') stats.push({ type: r.type, bytes: r.bytesSent || r.bytesReceived, energy: r.totalAudioEnergy, samples: r.totalSamplesDuration }); }); } catch {} }
    return { url: location.href, status: document.querySelector('#status')?.textContent, talk: document.querySelector('#talkback-status')?.textContent, cameraTalk: document.querySelector('#camera-talkback-status')?.textContent, error: document.querySelector('#error')?.textContent, microphones: window.testMicrophones?.map(t => t.readyState), contexts: window.testContexts?.map(c => c.state), outputs: window.testOutputs?.length, peak: window.testSpeakerEnergy?.(), transceivers: window.testPeers?.flatMap(pc => pc.getTransceivers().map(t => ({ direction: t.direction, current: t.currentDirection, sender: t.sender.track?.kind, receiver: t.receiver.track.kind, muted: t.receiver.track.muted }))), stats };
  }).catch(e => ({ error: e.message }))));
  console.error('TALKBACK FAILURE', JSON.stringify(snapshots)); throw error;
} finally { await desktop?.close(); await browser?.close(); await service?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
