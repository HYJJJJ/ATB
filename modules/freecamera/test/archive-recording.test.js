import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ArchiveStore } from '../archive/store.js';
import { installReceiver } from '../archive/receiver.js';
import { finalizeSegment } from '../archive/worker.js';
import { attachSignaling } from '../server/signaling.js';

for (const hourly of [false, true]) test(`real WebRTC ${hourly ? 'hour-aligned' : 'short'} receiver makes independent audio/video clips and reconnects`, { timeout: 45000 }, async t => {
  const token = 'a'.repeat(64), server = http.createServer((_, r) => r.end('<!doctype html><video autoplay muted playsinline></video>'));
  const hub = attachSignaling(server, { recorderToken: token, onDiagnostic() {} }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, root = await mkdtemp(path.join(os.tmpdir(), 'atb-recording-'));
  const store = new ArchiveStore(root, { reserveBytes: 0 }); await store.load();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  t.after(async () => { await browser.close(); await hub.close(); await new Promise(r => server.close(r)); });
  const camera = await browser.newPage(); await camera.goto(origin);
  const device = await camera.evaluate(async origin => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const ctx = canvas.getContext('2d'); let frame = 0;
    setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#1286ac' : '#cc6633'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.fillRect(frame % 600, 100, 40, 40); }, 66);
    const stream = canvas.captureStream(15), audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); await audio.resume(); stream.addTrack(destination.stream.getAudioTracks()[0]);
    const peers = new Map(); let saved;
    window.reconnectCamera = () => new Promise(resolve => {
      const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/signal'); window.cameraSocket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'create', name: 'synthetic', ...saved }));
      ws.onmessage = async e => {
        const m = JSON.parse(e.data), send = data => ws.send(JSON.stringify(data));
        if (m.type === 'created') { saved = { deviceId: m.deviceId, cameraKey: m.cameraKey }; resolve(saved); }
        if (m.type === 'peer-ready') {
          const pc = new RTCPeerConnection(); peers.set(m.peerId, pc); stream.getTracks().forEach(t => pc.addTrack(t, stream));
          pc.onicecandidate = e => { if (e.candidate) send({ type: 'candidate', peerId: m.peerId, candidate: e.candidate }); };
          await pc.setLocalDescription(await pc.createOffer()); send({ type: 'offer', peerId: m.peerId, sdp: pc.localDescription });
        }
        if (m.type === 'answer') await peers.get(m.peerId)?.setRemoteDescription(m.sdp);
        if (m.type === 'candidate') await peers.get(m.peerId)?.addIceCandidate(m.candidate);
        if (m.type === 'peer-left') { peers.get(m.peerId)?.close(); peers.delete(m.peerId); }
      };
    });
    return window.reconnectCamera();
  }, origin);
  const page = await browser.newPage();
  if (hourly) await page.addInitScript(() => {
    const now = Date.now.bind(Date), offset = Math.ceil(now() / 3600000) * 3600000 - 5000 - now();
    Date.now = () => now() + offset;
  });
  await page.goto(origin); const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('test-page-error', e.message); });
  await page.exposeFunction('atbArchiveStatus', value => console.log('test-status', value));
  await page.exposeFunction('atbArchive', async data => {
    if (data.type === 'begin') return (await store.begin({ deviceId: device.deviceId, name: 'synthetic', start: data.start })).id;
    if (data.type === 'chunk') await store.append(data.id, Buffer.from(data.bytes, 'base64'), data.time);
    if (data.type === 'empty' || data.type === 'finish' && !store.jobs.get(data.id)?.size) return store.discardEmpty(data.id);
    if (data.type === 'finish') await finalizeSegment(store, store.jobs.get(data.id), { end: data.end, ffmpeg: process.env.ATB_TEST_FFMPEG || 'ffmpeg' });
  });
  await page.evaluate(installReceiver, { origin, credential: token, device, ...(hourly ? {} : { milliseconds: 2200 }) });
  await assertEventually(() => [...store.jobs.values()].filter(j => j.state === 'pending').length >= (hourly ? 1 : 2));
  if (hourly) {
    await assertEventually(() => [...store.jobs.values()].some(j => j.state === 'recording' && j.size > 1000));
    const [first, second] = [...store.jobs.values()];
    assert.equal(first.end % 3600000, 0, 'first partial segment must end on the scheduled hour');
    assert.equal(second.start, first.end, 'next segment must retain the scheduled whole-hour boundary');
    assert.match(first.remotePath, /\/\d{4}年\/\d{2}月\/\d{2}日\/\d{2}：\d{2}：\d{2}——\d{2}：00：00\.webm$/);
    assert.ok(first.end - first.start > 0 && first.end - first.start <= 5000);
  }
  await camera.evaluate(() => window.cameraSocket.close());
  await assertEventually(() => [...store.jobs.values()].every(j => j.state === 'pending'));
  const before = store.jobs.size; await camera.evaluate(() => window.reconnectCamera());
  await assertEventually(() => store.jobs.size > before && [...store.jobs.values()].some(j => j.state === 'recording' && j.size > 1000));
  await page.evaluate(() => window.atbArchiveStop());
  assert.deepEqual(errors, []);
  for (const job of store.jobs.values()) {
    assert.equal(job.state, 'pending');
    const bytes = await readFile(store.local(job.id, 'webm')); assert.ok(bytes.length > 1000);
    const decoded = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), v = document.querySelector('video');
      v.srcObject = null; v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = reject; }); await v.play();
      await new Promise(r => setTimeout(r, 150)); const audio = new AudioContext();
      try { const result = await audio.decodeAudioData(bytes.buffer); return { video: v.videoWidth, duration: v.duration, audio: result.duration, channels: result.numberOfChannels, frames: v.getVideoPlaybackQuality().totalVideoFrames }; }
      finally { await audio.close(); URL.revokeObjectURL(v.src); }
    }, bytes.toString('base64'));
    assert.ok(decoded.video > 0 && decoded.frames > 0 && decoded.duration > 0); assert.ok(decoded.audio > 0 && decoded.channels > 0);
  }
});
async function assertEventually(predicate) { const until = Date.now() + 15000; while (!predicate()) { if (Date.now() > until) throw Error('recording condition timed out'); await new Promise(r => setTimeout(r, 100)); } }
