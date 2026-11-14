import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicJson } from './store.js';

const blockSize = 4 * 1024 ** 2;
const md5 = data => createHash('md5').update(data).digest('hex');
export class BaiduDrive {
  constructor(credential, { fetcher = fetch, save } = {}) { this.credential = credential; this.fetcher = fetcher; this.save = save; this.refreshing = null; this.directories = new Set(); }
  static async load(file) { return new BaiduDrive(JSON.parse(await readFile(file, 'utf8')), { save: c => atomicJson(file, c) }); }
  async request(url, init = {}) {
    let response;
    try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'pan.baidu.com', ...init.headers } }); }
    catch { throw Error('baidu-network'); }
    if (!response.ok) { await response.body?.cancel(); throw Error(`baidu-http-${response.status}`); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 ** 2) throw Error('baidu-response-limit'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    let result; try { result = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Error('baidu-invalid-response'); }
    if (result.error || result.errno && result.errno !== 0) throw Error(`baidu-code-${Number(result.errno || result.error_code) || 'oauth'}`);
    return result;
  }
  async token() {
    if (Date.parse(this.credential.expiresAt) > Date.now() + 300000) return this.credential.accessToken;
    if (!this.refreshing) this.refreshing = (async () => {
      const c = this.credential;
      if (!c.refreshToken || !c.appKey || !c.secretKey || !this.save) throw Error('baidu-authorization-required');
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.appKey, client_secret: c.secretKey });
      const r = await this.request('https://openapi.baidu.com/oauth/2.0/token', { method: 'POST', body });
      if (!r.access_token || !r.refresh_token || !(r.expires_in > 0)) throw Error('baidu-invalid-refresh');
      const fresh = { ...c, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: new Date(Date.now() + r.expires_in * 1000).toISOString(), refreshedAt: new Date().toISOString() };
      await this.save(fresh); this.credential = fresh;
      return fresh.accessToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async api(method, params = {}, body, service = 'file') {
    const url = new URL(`https://pan.baidu.com/rest/2.0/xpan/${service}`);
    url.search = new URLSearchParams({ method, access_token: await this.token(), ...params });
    return this.request(url, body ? { method: 'POST', body: new URLSearchParams(body) } : {});
  }
  async lookup(remotePath) {
    const dir = path.posix.dirname(remotePath);
    for (let start = 0; start < 100000; start += 1000) {
      let r;
      try { r = await this.api('list', { dir, start: String(start), limit: '1000' }); }
      catch (e) { if (['baidu-code--9', 'baidu-code-31066'].includes(e.message)) return null; throw e; }
      if (!Array.isArray(r.list)) throw Error('baidu-invalid-list');
      const file = r.list.find(f => f.path === remotePath); if (file) return file;
      if (r.list.length < 1000) return null;
    }
    throw Error('baidu-list-limit');
  }
  async mkdir(dir) {
    if (this.directories.has(dir) || dir === '/') return;
    await this.mkdir(path.posix.dirname(dir));
    try { const r = await this.api('create', {}, { path: dir, isdir: '1', rtype: '0' }); if (r.isdir !== 1 || r.path !== dir) throw Error('baidu-directory-mismatch'); }
    catch (e) { if (e.message !== 'baidu-code--8') throw e; const found = await this.lookup(dir); if (found?.isdir !== 1) throw Error('baidu-directory-conflict'); }
    this.directories.add(dir);
  }
  async verify(job, expected) {
    if (!(Number(expected?.fs_id) > 0)) throw Error('baidu-verification');
    const r = await this.api('filemetas', { fsids: JSON.stringify([Number(expected.fs_id)]), dlink: '0' }, undefined, 'multimedia');
    const file = r.list?.find(f => Number(f.fs_id) === Number(expected.fs_id));
    if (!file || file.isdir === 1 || file.path !== job.remotePath || file.size !== job.size || expected.md5 && file.md5 && expected.md5 !== file.md5) throw Error('baidu-verification');
    return file;
  }
  async upload(file, job) {
    if (!job.remotePath?.startsWith('/') || job.remotePath.split('/').includes('..')) throw Error('baidu-invalid-path');
    await this.mkdir(path.posix.dirname(job.remotePath));
    const existing = await this.lookup(job.remotePath);
    const fd = await open(file, 'r');
    try {
      if ((await fd.stat()).size !== job.size || job.size <= 0) throw Error('baidu-local-size');
      const hashes = [], whole = createHash('md5');
      for (let offset = 0; offset < job.size; offset += blockSize) {
        const bytes = Buffer.alloc(Math.min(blockSize, job.size - offset)); const r = await fd.read(bytes, 0, bytes.length, offset);
        if (r.bytesRead !== bytes.length) throw Error('baidu-local-truncated'); hashes.push(md5(bytes)); whole.update(bytes);
      }
      const digest = whole.digest('hex');
      if (existing) {
        if (existing.size !== job.size || existing.md5 && existing.md5 !== digest) throw Error('baidu-remote-conflict');
        return this.verify(job, existing);
      }
      const pre = await this.api('precreate', {}, { path: job.remotePath, size: String(job.size), isdir: '0', autoinit: '1', rtype: '0', block_list: JSON.stringify(hashes) });
      if (pre.return_type === 2) { const found = await this.lookup(job.remotePath); return this.verify(job, found); }
      if (!pre.uploadid || !Array.isArray(pre.block_list)) throw Error('baidu-invalid-precreate');
      for (const index of pre.block_list) {
        if (!Number.isInteger(index) || index < 0 || index >= hashes.length) throw Error('baidu-invalid-block');
        const bytes = Buffer.alloc(Math.min(blockSize, job.size - index * blockSize));
        if ((await fd.read(bytes, 0, bytes.length, index * blockSize)).bytesRead !== bytes.length) throw Error('baidu-local-truncated');
        const url = new URL('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2');
        url.search = new URLSearchParams({ method: 'upload', type: 'tmpfile', path: job.remotePath, uploadid: pre.uploadid, partseq: String(index), access_token: await this.token() });
        const form = new FormData(); form.append('file', new Blob([bytes]), 'clip.webm');
        const result = await this.request(url, { method: 'POST', body: form });
        if (result.md5 !== hashes[index]) throw Error('baidu-block-checksum');
      }
      const created = await this.api('create', {}, { path: job.remotePath, size: String(job.size), isdir: '0', rtype: '0', uploadid: pre.uploadid, block_list: JSON.stringify(hashes) });
      return this.verify(job, created);
    } finally { await fd.close(); }
  }
}
