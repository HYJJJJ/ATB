import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPresenceRoutes } from '../server/presence-routes.js';

test('presence enrollment is authenticated, bounded, persistent and isolated by account', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'atb-presence-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const accounts = { session: token => ['alice', 'bob'].includes(token) ? { user: { username: token } } : null };
  let handle = createPresenceRoutes({ accounts, dataDir });
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'https://localhost').pathname));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const host = `127.0.0.1:${server.address().port}`, url = `http://${host}/api/assistant/presence`;
  const call = (owner, body, origin = `https://${host}`) => fetch(url, { headers: { cookie: `__Host-freecamera=${owner}`, origin, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  assert.equal((await call('unknown')).status, 401);
  const descriptors = [0, .001, -.001].map(offset => Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10 + offset));
  assert.equal((await call('alice', { action: 'enroll', name: '本人', descriptors }, 'https://evil.example')).status, 403);
  assert.equal((await call('alice', { action: 'settings', enabled: true, cameraId: 'camera-1' })).status, 400);
  assert.equal((await call('alice', { action: 'enroll', name: '本人', descriptors })).status, 200);
  assert.equal((await call('alice', { action: 'settings', enabled: true, cameraId: 'camera-1', greeting: '你好，欢迎回来。', quietEnabled: false })).status, 200);
  handle = createPresenceRoutes({ accounts, dataDir });
  const alice = await (await call('alice')).json(); assert.equal(alice.enabled, true); assert.equal(alice.descriptors.length, 3);
  assert.equal((await (await call('alice', { action: 'claim', revision: 'stale' })).json()).claimed, false);
  assert.equal((await (await call('alice', { action: 'claim', revision: alice.revision })).json()).claimed, true);
  handle = createPresenceRoutes({ accounts, dataDir });
  assert.equal((await (await call('alice', { action: 'claim', revision: alice.revision })).json()).claimed, false);
  assert.equal((await (await call('bob')).json()).descriptors.length, 0);
  assert.equal((await call('alice', { action: 'enroll', name: 'bad', descriptors: [Array(128).fill(0)] })).status, 400);
  await call('alice', { action: 'clear' }); const cleared = await (await call('alice')).json(); assert.equal(cleared.enabled, false); assert.deepEqual(cleared.descriptors, []);
});

test('arrival claims preserve snooze and single-use authorization while legacy proactive claims are denied', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'atb-presence-policy-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-13T02:00:00Z');
  const accounts = { session: () => ({ user: { username: 'alice' } }) };
  let handle = createPresenceRoutes({ accounts, dataDir, now: () => now });
  const server = http.createServer((req, res) => handle(req, res, '/api/assistant/presence'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const host = `127.0.0.1:${server.address().port}`;
  const call = async body => { const r = await fetch(`http://${host}/api/assistant/presence`, { method: 'POST', headers: { origin: `https://${host}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...await r.json() }; };
  const descriptors = [0, .001, -.001].map(offset => Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10 + offset));
  await call({ action: 'enroll', name: '本人', descriptors });
  let saved = await call({ action: 'settings', enabled: true, cameraId: 'test', quietEnabled: false, proactiveEnabled: true, intervalMinutes: 5, dailyLimit: 1, aiOpening: true });
  assert.equal(saved.proactiveEnabled, true);
  assert.equal((await call({ action: 'settings', intervalMinutes: 0 })).status, 400);
  assert.equal((await call({ action: 'settings', restDates: ['2026-02-30'] })).status, 400);
  assert.equal((await call({ action: 'claim', kind: 'proactive', revision: saved.revision })).claimed,false);
  const first = await call({ action: 'claim', kind: 'arrival', revision: saved.revision }); assert.equal(first.claimed, true);
  assert.ok(first.claimId); assert.equal((await call({ action: 'claim', kind: 'proactive', revision: saved.revision })).claimed, false);
  assert.equal(typeof handle.consumeOpening, 'function');
  const opening = await handle.consumeOpening('alice', saved.revision, first.claimId); assert.equal(opening.kind, 'arrival');
  await assert.rejects(handle.consumeOpening('alice', saved.revision, first.claimId));
  handle = createPresenceRoutes({ accounts, dataDir, now: () => now }); now += 6 * 60000;
  assert.equal((await call({ action: 'claim', kind: 'proactive', revision: saved.revision })).claimed, false);
  assert.equal((await call({ action: 'snooze', minutes: 30 })).snoozeUntil, now + 30 * 60000);
  assert.equal((await call({ action: 'claim', revision: saved.revision })).claimed, false);
  assert.equal((await call({ action: 'feedback', state: 'tired' })).feedback.date, '2026-11-13');
  assert.equal((await call({ action: 'feedback', state: 'depressed' })).status, 400);
  await call({ action: 'snooze', minutes: 0 });
  assert.equal((await call({ action: 'claim', revision: saved.revision })).claimed, true);
  now += 24 * 3600000; assert.equal((await call({ action: 'claim', kind: 'proactive', revision: saved.revision })).claimed, false);
});


test('legacy idle claims are denied across restarts and cannot consume or bypass random opportunities', async t => {
 const dataDir=await mkdtemp(path.join(tmpdir(),'atb-no-idle-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 for(let i=0;i<3;i++) { const routes=createPresenceRoutes({accounts:{session:()=>null},dataDir});for(const owner of ['alice','bob'])assert.equal((await routes.claimConversation(owner,30)).allowed,false); }
});
