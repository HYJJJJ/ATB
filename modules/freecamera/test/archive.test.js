import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rename, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore, remotePath, segmentDelay } from '../archive/store.js';
import { BaiduDrive } from '../archive/baidu.js';
import { recorderAuthorized } from '../server/recorder-auth.js';

const start = Date.parse('2026-11-14T15:59:50Z');
async function fixture() { return new ArchiveStore(await mkdtemp(path.join(os.tmpdir(), 'atb-archive-')), { basePath: '/我的资源/视频/ATB/FreeCamera', reserveBytes: 0 }); }
test('Shanghai hourly paths use date units and only a Windows-safe time range filename', () => {
  const result = remotePath('/我的资源/视频/ATB/FreeCamera/', { deviceId: 'cam/a', name: '../../客厅', start, end: start + 10000, id: 'a'.repeat(32) });
  assert.equal(result, '/我的资源/视频/ATB/FreeCamera/2026年/11月/14日/23：59：50——00：00：00.webm');
  assert.equal(result.includes('/../'), false);
  assert.equal(segmentDelay(start), 10000);
  assert.equal(segmentDelay(Date.parse('2026-11-14T05:25:22Z')), 2078000);
  assert.equal(segmentDelay(Date.parse('2026-11-14T06:00:00Z')), 3600000);
  assert.equal(segmentDelay(start - 600000, 300000), 300000);
  assert.equal(remotePath('/base', { start: Date.parse('2026-01-02T01:00:00Z'), end: Date.parse('2026-01-02T02:00:00Z'), id: 'b'.repeat(32) }), '/base/2026年/01月/02日/09：00：00——10：00：00.webm');
  assert.throws(() => remotePath('/safe/../bad', {}));
});
test('existing legacy pending and interrupted jobs survive the hourly naming upgrade without changing destinations', async () => {
  const store = await fixture();
  const pending = await store.begin({ deviceId: 'one', name: 'test', start }); await store.append(pending.id, Buffer.from('clip'));
  const { createHash } = await import('node:crypto');
  pending.end = start + 1000; delete pending.pathFormat;
  const device = createHash('sha256').update('one').digest('hex').slice(0, 10);
  pending.remotePath = `/我的资源/视频/ATB/FreeCamera/2026/11/14/test_${device}_2026-11-14_23-59-50_至_2026-11-14_23-59-51_${pending.id}.webm`;
  pending.state = 'pending'; await rename(store.local(pending.id, 'part'), store.local(pending.id, 'webm')); await store.save(pending);
  const interrupted = await store.begin({ deviceId: 'two', start }); await store.append(interrupted.id, Buffer.from('partial')); delete interrupted.pathFormat; await store.save(interrupted);
  const recovered = new ArchiveStore(store.root, store.options); await recovered.load();
  assert.equal(recovered.jobs.get(pending.id).remotePath, pending.remotePath);
  assert.equal(recovered.jobs.get(interrupted.id).state, 'interrupted');
  const fresh = await recovered.begin({ deviceId: 'one', start }); await recovered.append(fresh.id, Buffer.from('new')); await recovered.finish(fresh.id, start + 2000);
  assert.equal(fresh.remotePath, '/我的资源/视频/ATB/FreeCamera/2026年/11月/14日/23：59：50——23：59：52.webm');
  const reloaded = new ArchiveStore(store.root, store.options); await reloaded.load();
  assert.equal(reloaded.jobs.get(pending.id).remotePath, pending.remotePath);
  await reloaded.complete(pending.id, { fs_id: 22, path: pending.remotePath, size: 4 });
  assert.equal((await readFile(reloaded.local(fresh.id, 'webm'))).toString(), 'new');
  fresh.remotePath = '/different/unsafe.webm'; await reloaded.save(fresh);
  await assert.rejects(new ArchiveStore(store.root, store.options).load(), /destination changed/);
});
test('queue persists final clips and only removes that clip after matching remote verification', async () => {
  let store = await fixture(); const first = await store.begin({ deviceId: 'one', name: 'test', start });
  await store.append(first.id, Buffer.from('clip-one')); await store.finish(first.id, start + 1000);
  const second = await store.begin({ deviceId: 'two', start }); await store.append(second.id, Buffer.from('clip-two'));
  await store.finish(second.id, start + 2000);
  store = new ArchiveStore(store.root, store.options); await store.load();
  await assert.rejects(store.complete(first.id, { fs_id: 1, path: first.remotePath, size: 999 }), /verification/);
  assert.equal((await readdir(store.root)).filter(f => f.endsWith('.webm')).length, 2);
  const job = store.jobs.get(first.id);
  await store.complete(first.id, { fs_id: 123, path: job.remotePath, size: 8 });
  assert.equal(store.jobs.size, 1); assert.equal((await readFile(store.local(second.id, 'webm'))).toString(), 'clip-two');
});
test('restart retains interrupted recording, capacity limits block begin without deleting pending clips', async () => {
  const store = await fixture(); const job = await store.begin({ deviceId: 'one', start }); await store.append(job.id, Buffer.from('retained'));
  const recovered = new ArchiveStore(store.root, { ...store.options, maxBytes: 1 }); await recovered.load();
  assert.equal(recovered.jobs.get(job.id).state, 'interrupted');
  await assert.rejects(recovered.begin({ deviceId: 'two', start }), /capacity/);
  assert.equal((await readFile(store.local(job.id, 'part'))).toString(), 'retained');
  assert.throws(() => store.local('../escape', 'webm'));
});
test('upload errors retain queue and retry can clean once after crash following remote commit', async () => {
  const store = await fixture(); const job = await store.begin({ deviceId: 'one', start });
  await store.append(job.id, Buffer.from('retained')); await store.finish(job.id, start + 2000);
  let calls = 0;
  const failing = { upload: async () => { calls++; throw Error('timeout'); } };
  await store.processOne(failing); assert.equal(store.jobs.size, 1); assert.equal(calls, 1);
  await store.processOne({ upload: async (file, j) => ({ fs_id: 9, path: j.remotePath, size: 8 }) }, Infinity);
  assert.equal(store.jobs.size, 0); await assert.rejects(lstat(store.local(job.id, 'webm')), { code: 'ENOENT' });
});
test('Baidu sends fixed 4MiB chunks, honors missing indices, verifies metadata after create', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atb-baidu-')), file = path.join(root, 'clip');
  await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 5, 3));
  const calls = []; let exists = false;
  const fetcher = async (input, init) => {
    const u = new URL(input), method = u.searchParams.get('method'), form = init.body instanceof URLSearchParams ? init.body : null;
    calls.push({ method, u, form, body: init.body });
    let body;
    if (method === 'list') body = { errno: 0, list: exists ? [{ fs_id: 99, path: '/base/a.webm', size: 4194309, isdir: 0 }] : [] };
    else if (method === 'precreate') body = { errno: 0, uploadid: 'upload', block_list: [1], return_type: 1 };
    else if (method === 'upload') { const { createHash } = await import('node:crypto'); body = { md5: createHash('md5').update(Buffer.alloc(5, 3)).digest('hex') }; }
    else if (method === 'create' && form.get('isdir') === '0') { exists = true; body = { errno: 0, fs_id: 99, path: '/base/a.webm', size: 4194309 }; }
    else if (method === 'filemetas') body = { errno: 0, list: [{ fs_id: 99, path: '/base/a.webm', size: 4194309, isdir: 0 }] };
    else body = { errno: 0, path: form?.get('path'), isdir: 1, fs_id: 2 };
    return Response.json(body);
  };
  const client = new BaiduDrive({ accessToken: 'test', expiresAt: new Date(Date.now() + 86400000).toISOString() }, { fetcher, save: async () => {} });
  assert.equal((await client.upload(file, { remotePath: '/base/a.webm', size: 4194309 })).fs_id, 99);
  const slices = calls.filter(c => c.method === 'upload'); assert.equal(slices.length, 1); assert.equal(slices[0].u.searchParams.get('partseq'), '1');
  assert.equal(JSON.parse(calls.find(c => c.method === 'precreate').form.get('block_list')).length, 2);
  assert.ok(calls.some(c => c.method === 'filemetas'));
  const before = calls.length; await client.upload(file, { remotePath: '/base/a.webm', size: 4194309 });
  assert.equal(calls.slice(before).some(c => c.method === 'precreate'), false, 'retry reconciles an existing remote commit');
});
test('rotated refresh token is persisted before next API use and concurrent refresh is serialized', async () => {
  let saves = 0, refreshes = 0;
  const drive = new BaiduDrive({ accessToken: 'old', refreshToken: 'refresh', appKey: 'app', secretKey: 'secret', expiresAt: '2020-01-01' }, {
    save: async c => { assert.equal(c.refreshToken, 'rotated'); saves++; },
    fetcher: async (url) => { refreshes++; return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }); }
  });
  assert.deepEqual(await Promise.all([drive.token(), drive.token()]), ['new', 'new']); assert.equal(saves, 1); assert.equal(refreshes, 1);
});
test('a crash after file rename before queue commit recovers the finished clip', async () => {
  const store = await fixture(), job = await store.begin({ deviceId: 'one', start }); await store.append(job.id, Buffer.from('video'));
  job.end = start + 1000; job.remotePath = remotePath(store.options.basePath, job); await store.save(job);
  await rename(store.local(job.id, 'part'), store.local(job.id, 'webm'));
  const recovered = new ArchiveStore(store.root, store.options); await recovered.load();
  assert.equal(recovered.jobs.get(job.id).state, 'pending');
});
test('only a direct loopback socket with the private protocol credential qualifies', () => {
  const token = 'a'.repeat(64), req = { headers: { 'sec-websocket-protocol': `atb-archive, ${token}`, 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '203.0.113.1' } };
  assert.equal(recorderAuthorized(req, token), false); req.socket.remoteAddress = '::ffff:127.0.0.1'; assert.equal(recorderAuthorized(req, token), true);
  req.headers['sec-websocket-protocol'] = `atb-archive, ${'b'.repeat(64)}`; assert.equal(recorderAuthorized(req, token), false);
});
test('remote metadata mismatch and nonzero API codes cannot count as a successful upload', async () => {
  const drive = new BaiduDrive({ accessToken: 'sensitive', expiresAt: '2099-01-01' }, { fetcher: async () => Response.json({ errno: 0, list: [{ fs_id: 1, size: 10, path: '/different', isdir: 0 }] }) });
  await assert.rejects(drive.verify({ remotePath: '/wanted', size: 10 }, { fs_id: 1 }), /verification/);
  drive.fetcher = async () => Response.json({ errno: -6, errmsg: 'sensitive' });
  await assert.rejects(drive.api('list'), e => e.message === 'baidu-code--6');
});
