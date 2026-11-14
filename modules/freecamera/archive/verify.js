// Explicit operator verification with synthetic video/audio only; never touches household camera records.
import https from 'node:https';
import path from 'node:path';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { ensureCertificates } from '../../../scripts/setup-cert.js';
import { attachSignaling } from '../server/signaling.js';
import { runArchive } from './worker.js';
import { atomicJson } from './store.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = process.argv[3]; if (!root || !path.isAbsolute(root)) throw Error('verification root required');
await mkdir(root, { recursive: true, mode: 0o700 });
const certs = await ensureCertificates({ directory: path.join(root, 'certs'), ips: ['127.0.0.1'], rootName: 'ATB isolated archive verification' });
const token = (await readFile(config.recorderTokenFile, 'utf8')).trim();
const server = https.createServer({ cert: certs.cert, key: certs.key }, (_, r) => r.end('<!doctype html><video muted autoplay></video>'));
const hub = attachSignaling(server, { recorderToken: token, onDiagnostic(e) { if (e.stage === '服务连接关闭') console.log('verification-signal-close', e.role, e.detail); } });
server.on('upgrade', req => console.log('verification-upgrade', Boolean(req.headers.origin), req.headers.origin === `https://${req.headers.host}`));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `https://127.0.0.1:${server.address().port}`;
const duration = Number(process.env.ATB_ARCHIVE_VERIFY_MS || 300000);
const worker = await runArchive({ ...config, origin, caFile: path.join(root, 'certs/ca.crt'), spoolDir: path.join(root, 'spool'), reserveBytes: 128 * 1024 ** 2, localTurn: null, segmentMs: duration });
for (const context of worker.browser.contexts()) context.on('page', page => {
  page.on('pageerror', () => console.error('verification-page-error'));
  page.on('console', message => { if (message.type() === 'error') console.error('verification-console', message.text().replace(/[a-f0-9]{64}/g, '[redacted]').slice(0, 240)); });
  page.on('websocket', ws => { ws.on('socketerror', error => console.error('verification-browser-socket-error', String(error).replace(/[a-f0-9]{64}/g, '[redacted]').slice(0, 240))); });
});
const results = { synthetic: true, clips: [], verifiedUploads: 0, removedOnlyAfterVerification: true, startedAt: new Date().toISOString() };
const originalFinish = worker.store.finish.bind(worker.store), originalComplete = worker.store.complete.bind(worker.store);
worker.store.finish = async (...args) => {
  const job = await originalFinish(...args);
  const info = JSON.parse(execFileSync(config.ffprobe || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', worker.store.local(job.id, 'webm')], { encoding: 'utf8' }));
  const video = info.streams.find(s => s.codec_type === 'video');
  console.log('verification-stream-shape', JSON.stringify({ width: video?.width, height: video?.height, seconds: Number(info.format.duration), audio: info.streams.some(s => s.codec_type === 'audio') }));
  // WebRTC adapts resolution under load; assert the source orientation/aspect, not one negotiated scale.
  if (!video || video.width < 180 || video.width > 720 || Math.abs(video.width / video.height - 720 / 1280) > 0.01 || !info.streams.some(s => s.codec_type === 'audio') || !(Number(info.format.duration) > 0)) throw Error('synthetic clip invalid');
  const energy = execFileSync(config.ffmpeg || 'ffmpeg', ['-nostdin', '-v', 'error', '-i', worker.store.local(job.id, 'webm'), '-t', '3', '-vn', '-f', 'f32le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1024 * 1024 });
  let sum = 0; for (let i = 0; i < energy.length; i += 4) sum += energy.readFloatLE(i) ** 2;
  const audioRms = Math.sqrt(sum / (energy.length / 4)); console.log('verification-audio-rms', audioRms); if (!(audioRms > 0.02)) throw Error('verification-audio-silent');
  results.clips.push({ seconds: Number(info.format.duration), bytes: job.size, remotePath: job.remotePath, video: true, audio: true, width: video.width, height: video.height, audioRms }); console.log('verification-clip-playable'); return job;
};
worker.store.complete = async (id, remote) => {
  const file = worker.store.local(id, 'webm'); await lstat(file); await originalComplete(id, remote);
  try { await lstat(file); results.removedOnlyAfterVerification = false; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  results.verifiedUploads++; console.log('verification-upload-and-cleanup');
};
try {
  const camera = await worker.browser.newPage(); await camera.goto(`${origin}/synthetic`);
  await camera.evaluate(async origin => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const context = canvas.getContext('2d'); let frame = 0;
    setInterval(() => { context.fillStyle = '#142334'; context.fillRect(0, 0, 1280, 720); context.fillStyle = '#29a3cc'; context.fillRect(frame++ % 1180, 280, 100, 100); }, 66);
    const generator = new MediaStreamTrackGenerator({ kind: 'video' }), writer = generator.writable.getWriter(); let writing = false;
    setInterval(async () => { if (writing) return; writing = true; const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000), rotation: 90 }); try { await writer.write(frame); } finally { frame.close(); writing = false; } }, 66);
    const stream = new MediaStream([generator]), audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); await audio.resume(); stream.addTrack(destination.stream.getAudioTracks()[0]);
    const peers = new Map(), ws = window.syntheticCamera = new WebSocket(origin.replace(/^http/, 'ws') + '/signal');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'create', name: 'ATB_归档链路验证' }));
    ws.onmessage = async e => {
      const m = JSON.parse(e.data), send = data => ws.send(JSON.stringify(data));
      if (m.type === 'peer-ready') {
        const pc = new RTCPeerConnection(); peers.set(m.peerId, pc); stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.onicecandidate = e => { if (e.candidate) send({ type: 'candidate', peerId: m.peerId, candidate: e.candidate }); };
        await pc.setLocalDescription(await pc.createOffer()); send({ type: 'offer', peerId: m.peerId, sdp: pc.localDescription });
      }
      if (m.type === 'answer') await peers.get(m.peerId)?.setRemoteDescription(m.sdp);
      if (m.type === 'candidate') await peers.get(m.peerId)?.addIceCandidate(m.candidate);
      if (m.type === 'peer-left') { peers.get(m.peerId)?.close(); peers.delete(m.peerId); }
    };
  }, origin);
  const limit = Date.now() + duration + 60000;
  while (!results.clips.some(c => c.seconds >= duration / 1000 - 1)) { if (Date.now() > limit) throw Error('verification-timeout'); await new Promise(r => setTimeout(r, 1000)); }
  await new Promise(r => setTimeout(r, 6000)); await camera.close();
  const uploadLimit = Date.now() + 180000;
  while (worker.store.jobs.size || results.verifiedUploads < 2) { if (Date.now() > uploadLimit) throw Error('verification-upload-timeout'); await new Promise(r => setTimeout(r, 1000)); }
  results.passed = results.removedOnlyAfterVerification && results.clips.length >= 2 && results.clips.some(c => c.seconds >= duration / 1000 - 1);
  if (!results.passed) throw Error('verification-failed');
  console.log('ARCHIVE_SYNTHETIC_END_TO_END_PASS');
} catch (error) { results.passed = false; console.error(/^verification-[a-z-]+$/.test(error.message) ? error.message : 'verification-exception'); console.error('ARCHIVE_SYNTHETIC_END_TO_END_FAILED'); process.exitCode = 1; }
finally { results.finishedAt = new Date().toISOString(); await atomicJson(path.join(root, 'result.json'), results); await worker.stop(); await hub.close(); await new Promise(r => server.close(r)); }
