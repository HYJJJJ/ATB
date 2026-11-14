import { readFile, lstat, rename, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { ArchiveStore, atomicJson } from './store.js';
import { BaiduDrive } from './baidu.js';
import { installReceiver } from './receiver.js';

export async function finalizeSegment(store, job, { ffmpeg = 'ffmpeg', end = job.end } = {}) {
  const part = store.local(job.id, 'part'), output = store.local(job.id, 'remux');
  try { const ready = await lstat(store.local(job.id, 'webm')); if (ready.isFile() && !ready.isSymbolicLink() && job.remotePath && ready.size === job.size) { job.state = 'pending'; await store.save(job); return; } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stat = await lstat(part); if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw Error('recording-empty');
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', part, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-f', 'webm', output], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.once('error', () => { clearTimeout(timer); reject(Error('recording-remux-unavailable')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('recording-remux-failed')); });
  });
  await store.finish(job.id, end, true);
}

export async function runArchive(config) {
  if (!/^https:\/\/[^/]+$/.test(config.origin)) throw Error('invalid archive origin');
  const require = createRequire(config.runtimePackage || import.meta.url);
  const { chromium } = require('playwright-core'); const WebSocket = require('ws');
  const credential = (await readFile(config.recorderTokenFile, 'utf8')).trim(); if (!/^[a-f0-9]{64}$/.test(credential)) throw Error('invalid archive credential');
  const ca = await readFile(config.caFile), url = new URL(config.origin);
  // Verify the existing CA/hostname first, then trust only that exact leaf key in the controlled browser.
  const cert = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: Number(url.port || 443), ca, servername: url.hostname, checkServerIdentity: (_, c) => tls.checkServerIdentity(url.hostname, c) }, () => { resolve(socket.getPeerCertificate().raw); socket.end(); });
    socket.setTimeout(10000, () => socket.destroy(Error('tls-timeout'))); socket.once('error', reject);
  });
  const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const store = new ArchiveStore(config.spoolDir, config); await store.load();
  let recovering = false;
  async function recover() {
    if (recovering) return; recovering = true;
    try { for (const job of store.jobs.values()) {
      if (job.state === 'interrupted') { try { await finalizeSegment(store, job, { ffmpeg: config.ffmpeg }); } catch { job.error = 'recording-recovery-pending'; await store.save(job); } }
      if (job.state === 'verified') await store.cleanup(job);
    } } finally { recovering = false; }
  }
  await recover();
  const drive = await BaiduDrive.load(config.baiduCredentialFile);
  const browser = await chromium.launch({ executablePath: config.browserExecutable, headless: true, chromiumSandbox: config.chromiumSandbox !== false,
    args: [`--host-resolver-rules=MAP ${url.hostname} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`, '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const context = await browser.newContext();
  // The synthetic receiver document still talks only to the explicitly configured local service.
  await context.grantPermissions(['local-network-access'], { origin: config.origin });
  const pages = new Map(), known = new Map(); let stopping = false, socket, reconnect, uploadTimer, statusTimer;
  let uploads = 0, lastUpload = null;
  const statusFile = path.join(config.spoolDir, 'status.json');
  const status = async () => {
    const counts = {}; for (const j of store.jobs.values()) counts[j.state] = (counts[j.state] || 0) + 1;
    let capacity = true; try { await store.capacity(1024 * 1024); } catch { capacity = false; }
    for (const device of known.values()) if (device.online && !pages.has(device.deviceId)) void add(device);
    const media = await Promise.all([...pages.values()].map(async entry => { try { return await entry.page?.evaluate(() => window.atbArchiveInspect?.()) || null; } catch { return null; } }));
    await atomicJson(statusFile, { time: new Date().toISOString(), service: 'running', catalogConnected: socket?.readyState === WebSocket.OPEN, cameras: pages.size, states: [...pages.values()].map(p => p.state), media, segments: counts, uploads, lastUpload, capacity, errors: [...new Set([...store.jobs.values()].map(j => j.error).filter(Boolean))] });
  };
  async function add(device) {
    if (pages.has(device.deviceId) || stopping) return;
    const entry = { page: null, state: 'connecting', pending: Promise.resolve() }; pages.set(device.deviceId, entry);
    try {
      const page = entry.page = await context.newPage();
      await page.route(`${config.origin}/__atb_archive`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><video autoplay muted playsinline></video>' }));
      await page.exposeFunction('atbArchiveStatus', state => { entry.state = String(state).slice(0, 80); });
      await page.exposeFunction('atbArchive', data => {
        const operation = entry.pending.then(async () => {
          if (data.type === 'begin') return (await store.begin({ deviceId: device.deviceId, name: device.remark || device.name, start: data.start, capturedAt: data.capturedAt })).id;
          const job = store.jobs.get(data.id); if (!job || job.deviceId !== device.deviceId) throw Error('invalid archive job');
          if (data.type === 'chunk') return store.append(job.id, Buffer.from(data.bytes, 'base64'), data.time);
          if (data.type === 'empty' || data.type === 'finish' && !job.size) return store.discardEmpty(job.id);
          if (data.type === 'finish') return finalizeSegment(store, job, { ffmpeg: config.ffmpeg, end: data.end });
        });
        entry.pending = operation.catch(() => {}); return operation;
      });
      await page.goto(`${config.origin}/__atb_archive`);
      await page.evaluate(installReceiver, { origin: config.origin, credential, device, milliseconds: config.segmentMs || 3600000, localTurn: config.localTurn });
      page.on('crash', () => { pages.delete(device.deviceId); void page.close().catch(() => {}); });
    } catch { pages.delete(device.deviceId); await entry.page?.close().catch(() => {}); console.log('archive-camera-retry'); }
  }
  function connect() {
    if (stopping) return;
    socket = new WebSocket(`${config.origin.replace(/^http/, 'ws')}/signal`, ['atb-archive', credential], { ca, origin: config.origin, lookup: (_, __, cb) => cb(null, '127.0.0.1', 4) });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'catalog' })));
    socket.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'devices') { known.clear(); for (const d of m.devices) { known.set(d.deviceId, d); if (d.online) void add(d); } }
    });
    socket.on('error', () => {}); socket.on('close', () => { if (!stopping) reconnect = setTimeout(connect, 3000); });
  }
  connect();
  uploadTimer = setInterval(() => { void store.processOne(drive).then(success => { if (success) { uploads++; lastUpload = new Date().toISOString(); console.log('archive-upload-verified'); } }).catch(() => console.error('archive-queue-error')); }, 3000);
  statusTimer = setInterval(() => { void status().catch(() => console.error('archive-status-error')); }, 5000);
  const recoveryTimer = setInterval(() => { void recover().catch(() => {}); }, 60000);
  browser.on('disconnected', () => { if (!stopping) { console.error('archive-browser-exited'); process.exitCode = 1; void stop(); } });
  async function stop() {
    if (stopping) return; stopping = true; clearInterval(uploadTimer); clearInterval(statusTimer); clearInterval(recoveryTimer); clearTimeout(reconnect); socket?.close();
    await Promise.allSettled([...pages.values()].map(async e => { await e.page?.evaluate(() => window.atbArchiveStop?.()); await e.pending; }));
    await context.close(); await browser.close(); await atomicJson(statusFile, { time: new Date().toISOString(), service: 'stopped', segments: store.jobs.size });
  }
  await status(); console.log('archive-ready');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
  return { store, browser, stop };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runArchive(JSON.parse(await readFile(process.argv[2], 'utf8'))); }
  catch { console.error('archive-start-failed'); process.exitCode = 1; }
}
