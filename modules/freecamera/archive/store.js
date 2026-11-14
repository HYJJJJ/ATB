import { mkdir, readdir, readFile, rename, unlink, open, lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export async function atomicJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = await open(temp, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, file);
}
function parts(time) {
  if (!Number.isFinite(time)) throw Error('invalid recording time');
  return new Date(time + 8 * 3600000).toISOString().replace('T', '_').replaceAll(':', '-').slice(0, 19);
}
function base(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.split('/').some(p => ['.', '..'].includes(p)) || /[\x00-\x1f]/.test(value)) throw Error('invalid remote path');
  return value.replace(/\/+$/, '');
}
export function segmentDelay(now, milliseconds = 3600000) {
  const nextHour = Math.floor((now + 8 * 3600000) / 3600000 + 1) * 3600000 - 8 * 3600000;
  return Math.min(milliseconds, nextHour - now);
}
export function remotePath(root, job) {
  root = base(root);
  const from = parts(job.start), to = parts(job.end);
  if (!/^[a-f0-9]{32}$/.test(job.id)) throw Error('invalid recording id');
  if (job.pathFormat !== 'legacy-v1') {
    if (job.pathFormat && job.pathFormat !== 'time-range-v2') throw Error('invalid archive path format');
    return `${root}/${from.slice(0, 4)}年/${from.slice(5, 7)}月/${from.slice(8, 10)}日/${from.slice(11).replaceAll('-', '：')}——${to.slice(11).replaceAll('-', '：')}.webm`;
  }
  const name = String(job.name || '摄像头').replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').slice(0, 40) || '摄像头';
  const device = createHash('sha256').update(String(job.deviceId)).digest('hex').slice(0, 10);
  return `${root}/${from.slice(0, 4)}/${from.slice(5, 7)}/${from.slice(8, 10)}/${name}_${device}_${from}_至_${to}_${job.id}.webm`;
}
export class ArchiveStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root); this.options = { basePath: '/我的资源/视频/ATB/FreeCamera', maxBytes: 2 * 1024 ** 3, reserveBytes: 1024 ** 3, ...options };
    base(this.options.basePath); this.jobs = new Map(); this.processing = false;
  }
  local(id, ext) { if (!/^[a-f0-9]{32}$/.test(id) || !['json', 'part', 'webm', 'remux'].includes(ext)) throw Error('invalid local path'); return path.join(this.root, `${id}.${ext}`); }
  async save(job) { await atomicJson(this.local(job.id, 'json'), job); }
  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const filename = path.join(this.root, file), stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('unsafe archive manifest');
      const job = JSON.parse(await readFile(filename, 'utf8'));
      if (`${job.id}.json` !== file || !['recording', 'interrupted', 'pending', 'verified'].includes(job.state)) throw Error('invalid archive manifest');
      // Unversioned manifests were written before the time-only naming upgrade.
      // Preserve their original destination, including interrupted/in-flight uploads.
      job.pathFormat ??= 'legacy-v1';
      if (job.remotePath && job.remotePath !== remotePath(this.options.basePath, job)) throw Error('archive destination changed');
      this.jobs.set(job.id, job);
      if (job.state === 'verified') { await this.cleanup(job); continue; }
      if (['recording', 'interrupted'].includes(job.state)) {
        job.state = 'interrupted';
        try { const ready = await lstat(this.local(job.id, 'webm')); if (ready.isFile() && !ready.isSymbolicLink() && job.remotePath && ready.size === job.size) job.state = 'pending'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await this.save(job);
      }
    }
  }
  async capacity(extra = 0) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let bytes = 0;
    for (const name of await readdir(this.root)) { const s = await lstat(path.join(this.root, name)); if (s.isFile()) bytes += s.size; }
    const disk = await statfs(this.root);
    if (bytes + extra >= this.options.maxBytes || disk.bavail * disk.bsize - extra < this.options.reserveBytes) throw Error('archive-capacity');
    return bytes;
  }
  async begin({ deviceId, name = '', start = Date.now(), capturedAt = start }) {
    await this.capacity(1024 * 1024);
    const job = { id: randomBytes(16).toString('hex'), deviceId, name, start, capturedAt, end: start, size: 0, state: 'recording', attempts: 0, pathFormat: 'time-range-v2' };
    const f = await open(this.local(job.id, 'part'), 'wx', 0o600); await f.close();
    await this.save(job); this.jobs.set(job.id, job); return job;
  }
  async append(id, bytes, time = Date.now()) {
    const job = this.jobs.get(id); if (!job || job.state !== 'recording' || !Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 ** 2) throw Error('invalid archive chunk');
    await this.capacity(bytes.length);
    const file = this.local(id, 'part'), stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('unsafe recording file');
    const f = await open(file, 'a'); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    job.size += bytes.length; job.end = time; await this.save(job);
  }
  async finish(id, end = Date.now(), remuxed = false) {
    const job = this.jobs.get(id); if (!job || !['recording', 'interrupted'].includes(job.state)) throw Error('invalid recording state');
    const source = this.local(id, remuxed ? 'remux' : 'part'), s = await lstat(source);
    if (!s.isFile() || s.isSymbolicLink() || !s.size) throw Error('empty or unsafe recording');
    job.end = Math.max(job.start + 1, end); job.size = s.size; job.remotePath = remotePath(this.options.basePath, job);
    // Persist the deterministic name before rename, so either side of a crash is recoverable.
    await this.save(job); await rename(source, this.local(id, 'webm'));
    job.state = 'pending'; await this.save(job);
    if (remuxed) await unlink(this.local(id, 'part')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    return job;
  }
  async discardEmpty(id) {
    const job = this.jobs.get(id); if (!job || job.size !== 0 || !['recording', 'interrupted'].includes(job.state)) throw Error('nonempty recording');
    const file = this.local(id, 'part'), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) throw Error('nonempty recording');
    await unlink(file); await unlink(this.local(id, 'json')); this.jobs.delete(id);
  }
  async complete(id, remote) {
    const job = this.jobs.get(id);
    if (!job || !remote || !Number.isSafeInteger(Number(remote.fs_id)) || Number(remote.fs_id) <= 0 || remote.path !== job.remotePath || remote.size !== job.size || remote.isdir === 1) throw Error('remote verification failed');
    const stat = await lstat(this.local(id, 'webm'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.size) throw Error('local verification failed');
    job.state = 'verified'; job.remote = { fs_id: remote.fs_id, path: remote.path, size: remote.size }; await this.save(job);
    await this.cleanup(job);
  }
  async cleanup(job) {
    if (job.state !== 'verified' || job.remote?.path !== job.remotePath || job.remote?.size !== job.size || !(Number(job.remote?.fs_id) > 0)) throw Error('cleanup verification failed');
    for (const ext of ['webm', 'part', 'remux']) {
      const file = this.local(job.id, ext);
      try { const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink()) throw Error('unsafe cleanup'); await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await unlink(this.local(job.id, 'json')); this.jobs.delete(job.id);
  }
  async processOne(drive, now = Date.now()) {
    if (this.processing) return false;
    const job = [...this.jobs.values()].find(j => j.state === 'pending' && !(j.retryAt > now)); if (!job) return false;
    this.processing = true;
    try { const remote = await drive.upload(this.local(job.id, 'webm'), job); await this.complete(job.id, remote); return true; }
    catch (error) {
      job.attempts++; job.retryAt = Date.now() + Math.min(1800000, 10000 * 2 ** Math.min(8, job.attempts));
      job.error = /^baidu-[a-z0-9_-]+$/.test(error.message) ? error.message : 'archive-upload-failed'; await this.save(job); return false;
    } finally { this.processing = false; }
  }
}
