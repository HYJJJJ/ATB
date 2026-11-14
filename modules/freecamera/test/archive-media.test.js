import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { ArchiveStore } from '../archive/store.js';
import { installReceiver } from '../archive/receiver.js';
import { finalizeSegment } from '../archive/worker.js';
import { attachSignaling } from '../server/signaling.js';

test('archive burns upright rotating frames and clock into pixels, retaining late microphone audio', { timeout: 45000 }, async t => {
  const source = await readFile(new URL('../public/camera-peer.js', import.meta.url), 'utf8');
  const server = http.createServer((req, r) => { r.setHeader('Content-Type', req.url === '/camera-peer.js' ? 'text/javascript' : 'text/html'); r.end(req.url === '/camera-peer.js' ? source : '<video muted autoplay playsinline></video>'); });
  const token = 'b'.repeat(64), hub = attachSignaling(server, { recorderToken: token, onDiagnostic() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  t.after(async () => { await browser.close(); await hub.close(); await new Promise(r => server.close(r)); });
  const camera = await browser.newPage(); await camera.goto(origin);
  const device = await camera.evaluate(async origin => {
    const { CameraPeers } = await import('/camera-peer.js');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    for (const [color, x, y] of [['red', 0, 0], ['lime', 320, 0], ['blue', 0, 180], ['yellow', 320, 180]]) { ctx.fillStyle = color; ctx.fillRect(x, y, 320, 180); }
    const generator = new MediaStreamTrackGenerator({ kind: 'video' }), writer = generator.writable.getWriter();
    let rotation = 90, writing = false;
    setInterval(async () => { if (writing) return; writing = true; const f = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000), rotation }); try { await writer.write(f); } finally { f.close(); writing = false; } }, 66);
    const stream = new MediaStream([generator]); document.querySelector('video').srcObject = stream;
    const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
    gain.gain.value = 0.3; oscillator.connect(gain).connect(destination); oscillator.start(); await audio.resume();
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/signal'), send = m => ws.send(JSON.stringify(m));
    const peers = new CameraPeers({ send, diagnostic() {}, state() {} });
    window.testCamera = {
      enableAudio: () => { send({ type: 'microphone-state', enabled: true }); return peers.replaceAudioTrack(destination.stream.getAudioTracks()[0]); },
      disableAudio: () => { send({ type: 'microphone-state', enabled: false }); return peers.replaceAudioTrack(null); },
      rotate: value => { rotation = value; }
    };
    return new Promise(resolve => {
      ws.onopen = () => send({ type: 'create', name: 'synthetic-upright', microphone: false });
      ws.onmessage = async e => {
        const m = JSON.parse(e.data);
        if (m.type === 'created') resolve({ deviceId: m.deviceId });
        if (m.type === 'peer-ready') await peers.offer(m.peerId, stream);
        if (m.type === 'answer') await peers.answer(m.peerId, m.sdp);
        if (m.type === 'candidate') await peers.candidate(m.peerId, m.candidate);
        if (m.type === 'peer-left') peers.close(m.peerId);
      };
    });
  }, origin);
  const root = await mkdtemp(path.join(os.tmpdir(), 'atb-upright-')), store = new ArchiveStore(root, { reserveBytes: 0 }); await store.load();
  const page = await browser.newPage(); await page.goto(origin); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('atbArchive', async data => {
    if (data.type === 'begin') return (await store.begin({ deviceId: device.deviceId, name: 'synthetic', start: data.start })).id;
    if (data.type === 'chunk') return store.append(data.id, Buffer.from(data.bytes, 'base64'), data.time);
    if (data.type === 'empty' || data.type === 'finish' && !store.jobs.get(data.id)?.size) return store.discardEmpty(data.id);
    if (data.type === 'finish') return finalizeSegment(store, store.jobs.get(data.id), { end: data.end, ffmpeg: process.env.ATB_TEST_FFMPEG || 'ffmpeg' });
  });
  await page.evaluate(installReceiver, { origin, credential: token, device, milliseconds: 10000 });
  await page.waitForFunction(() => document.querySelector('video').videoHeight === 640);
  await new Promise(r => setTimeout(r, 800)); await camera.evaluate(() => window.testCamera.enableAudio());
  await new Promise(r => setTimeout(r, 2200)); await camera.evaluate(() => window.testCamera.disableAudio());
  await new Promise(r => setTimeout(r, 500)); await camera.evaluate(() => window.testCamera.enableAudio());
  await new Promise(r => setTimeout(r, 1000));
  await camera.evaluate(() => window.testCamera.rotate(0));
  await page.waitForFunction(() => document.querySelector('video').videoWidth === 640);
  await new Promise(r => setTimeout(r, 2300));
  await page.evaluate(() => window.atbArchiveStop());
  const jobs = [...store.jobs.values()]; assert.equal(jobs.length, 2, 'rotation must finish old clip and start a new independent orientation'); assert.deepEqual(errors, []);
  const bytes = await readFile(store.local(jobs[0].id, 'webm'));
  const probe = await promisify(execFile)(process.env.ATB_TEST_FFMPEG || 'ffmpeg', ['-hide_banner', '-noautorotate', '-i', store.local(jobs[0].id, 'webm')], { encoding: 'utf8' }).catch(error => error);
  const encodedSize = /Video: vp8[^\r\n]*? (\d+)x(\d+)/.exec(probe.stderr);
  assert.ok(encodedSize, 'ffmpeg must identify encoded video dimensions');
  assert.deepEqual(encodedSize.slice(1).map(Number), [360, 640], 'encoded pixels must be upright even when player ignores rotation metadata');
  const result = await decodeClip(page, bytes);
  assert.deepEqual([result.width, result.height], [360, 640], 'CVO portrait must be baked into encoded dimensions');
  assert.ok(result.audioRms > 0.02, `late microphone must produce audible samples: ${result.audioRms}`);
  assert.ok(result.clockPixels > 120, `clock must be actual encoded pixels: ${result.clockPixels}`);
  assert.ok(result.clockDifference > 20, 'clock must change between seconds');
  assert.ok(result.corner[2] > 180 && result.corner[0] < 50, 'clockwise source must retain upright blue top-left');
  const landscape = await decodeClip(page, await readFile(store.local(jobs[1].id, 'webm')));
  assert.deepEqual([landscape.width, landscape.height], [640, 360]);
  assert.ok(landscape.corner[0] > 180 && landscape.corner[2] < 50, 'landscape must retain original red top-left');
  assert.ok(landscape.audioRms > 0.02 && landscape.clockPixels > 120);
  assert.equal(await page.evaluate(() => window.atbArchiveInspect().width), 0, 'stop must release composition resources');
});

async function decodeClip(page, bytes) {
  return page.evaluate(async base64 => {
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), video = document.querySelector('video');
    video.srcObject = null; video.src = URL.createObjectURL(new Blob([data], { type: 'video/webm' }));
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; }); video.pause();
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; const ctx = canvas.getContext('2d');
    async function snapshot(time) { video.currentTime = time; await new Promise(resolve => video.onseeked = resolve); ctx.drawImage(video, 0, 0); return ctx.getImageData(0, 0, canvas.width, 60).data; }
    const first = await snapshot(1), second = await snapshot(3); let clockPixels = 0, clockDifference = 0;
    for (let i = 0; i < first.length; i += 4) { if (first[i] > 170 && first[i + 1] > 170 && first[i + 2] > 170) clockPixels++; if (Math.abs(first[i] - second[i]) + Math.abs(first[i + 1] - second[i + 1]) + Math.abs(first[i + 2] - second[i + 2]) > 120) clockDifference++; }
    const corner = [...ctx.getImageData(12, 100, 1, 1).data];
    const audio = new AudioContext(); let audioRms = 0;
    try { const decoded = await audio.decodeAudioData(data.buffer); const samples = decoded.getChannelData(0); audioRms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); }
    finally { await audio.close(); URL.revokeObjectURL(video.src); }
    return { width: video.videoWidth, height: video.videoHeight, audioRms, clockPixels, clockDifference, corner };
  }, bytes.toString('base64'));
}
