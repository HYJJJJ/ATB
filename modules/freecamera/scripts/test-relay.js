import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';

const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-relay-'));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const httpsPort = await port(), httpPort = await port(), origin = `https://127.0.0.1:${httpsPort}`;
const options = { relayPort: 0, lanIp: '127.0.0.1', httpsPort, httpPort, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') };
let service, browser;
try {
  service = await startServers(options);
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    window.testPeers = []; window.testSockets = []; window.testConfigurations = [];
    const Peer = RTCPeerConnection, Socket = WebSocket;
    window.RTCPeerConnection = class extends Peer { constructor(config) { super({ ...config, iceTransportPolicy: 'relay' }); window.testConfigurations.push(config); window.testPeers.push(this); } };
    window.WebSocket = class extends Socket { constructor(...args) { super(...args); window.testSockets.push(this); } };
    const addTrack = RTCPeerConnection.prototype.addTrack;
    RTCPeerConnection.prototype.addTrack = function(...args) {
      const sender = addTrack.apply(this, args);
      if (args[0].kind === 'video') this.getTransceivers().find(t => t.sender === sender).setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(c => c.mimeType === 'video/H264'));
      return sender;
    };
  });
  const camera = await context.newPage(), viewer = await context.newPage(), errors = [];
  for (const page of [camera, viewer]) page.on('pageerror', error => errors.push(error.message));
  await camera.goto(`${origin}/?mode=camera`); await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  await viewer.goto(`${origin}/?mode=viewer`); await loginViewer(viewer); await viewer.locator('.device-connect').click();
  await camera.waitForFunction(() => window.testConfigurations.length > 0);
  assert.equal(await camera.evaluate(() => window.testConfigurations.some(c => c.iceServers?.some(s => s.urls.some(u => u.startsWith('turn:') && u.includes('transport=tcp')) && s.username && s.credential))), true, 'authenticated camera must receive TCP relay configuration');
  const live = page => page.waitForFunction(() => document.querySelector('#status').textContent === '实时画面', null, { timeout: 35000 });
  await live(viewer);
  async function selected(page) {
    return page.evaluate(async () => {
      const pc = window.testPeers.findLast(p => p.connectionState === 'connected'), stats = await pc.getStats();
      const transport = [...stats.values()].find(r => r.type === 'transport' && r.selectedCandidatePairId), pair = stats.get(transport.selectedCandidatePairId);
      const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
      return { local: local.candidateType, remote: remote.candidateType, protocol: local.relayProtocol, bytes: pair.bytesReceived };
    });
  }
  const relay = await selected(viewer); assert.equal(relay.local, 'relay'); assert.equal(relay.remote, 'relay'); assert.equal(relay.protocol, 'tcp');
  await viewer.waitForFunction(() => document.querySelector('#stream-info').textContent.includes('经电脑转发'));
  const original = await camera.evaluate(() => ({ code: document.querySelector('#pair-code').textContent, track: document.querySelector('video').srcObject.getVideoTracks()[0].id, sockets: window.testSockets.length }));
  const late = await context.newPage(); late.on('pageerror', e => errors.push(e.message));
  await late.addInitScript(() => {
    const setRemote = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = async function(...args) { await new Promise(r => setTimeout(r, 12000)); return setRemote.apply(this, args); };
  });
  await late.goto(`${origin}/?mode=viewer`); await live(late);
  assert.equal(await late.evaluate(() => window.testPeers.length), 1, 'a slow first negotiation must not be restarted before it finishes');
  assert.deepEqual(await camera.evaluate(() => ({ code: document.querySelector('#pair-code').textContent, track: document.querySelector('video').srcObject.getVideoTracks()[0].id, sockets: window.testSockets.length })), original);
  await live(viewer);
  const previous = await viewer.locator('video').evaluate(v => v.currentTime);
  await viewer.waitForFunction(time => document.querySelector('video').currentTime > time + 2, previous);
  assert.ok((await selected(viewer)).bytes > relay.bytes, 'the original viewer must keep receiving while another viewer negotiates');
  await late.close();
  await service.close(); service = await startServers(options); await live(viewer);
  const recovered = await selected(viewer); assert.equal(recovered.local, 'relay'); assert.equal(recovered.remote, 'relay');
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject.getVideoTracks()[0].id), original.track);
  assert.deepEqual(errors, []);
  await mkdir('test-results/relay', { recursive: true });
  await writeFile('test-results/relay/report.json', JSON.stringify({ passed: true, time: new Date().toISOString(), relay, recovered, checks: ['real WebRTC video over TCP TURN with all direct candidates disabled', '12-second negotiation completes without resetting', 'second viewer cannot interrupt original viewer or camera signaling', 'service restart grants new relay credentials and preserves camera capture'] }, null, 2));
  console.log('PASS: real TCP relay video, slow negotiation, concurrent viewing and service recovery.');
} finally { await browser?.close(); await service?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
