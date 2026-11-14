import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPresenceRoutes } from '../server/presence-routes.js';
import * as state from '../public/presence-state.js';

const samples = (offset = 0) => [0, .001, -.001].map(delta => Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10 + offset + delta));
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'atb-people-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const accounts = { session: token => ['alice', 'bob'].includes(token) ? { user: { username: token } } : null };
  const handle = createPresenceRoutes({ accounts, dataDir, now: () => Date.parse('2026-11-13T02:00:00Z') });
  const server = http.createServer((req, res) => handle(req, res, '/api/assistant/presence'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const host = `127.0.0.1:${server.address().port}`;
  const call = async (body, owner = 'alice') => {
    const response = await fetch(`http://${host}/api/assistant/presence`, { headers: { cookie: `__Host-freecamera=${owner}`, origin: `https://${host}`, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...await response.json() };
  };
  const filename = path.join(dataDir, 'assistant/presence', createHash('sha256').update('alice').digest('hex') + '.json');
  return { call, handle, filename };
}

test('people CRUD stores profile metadata, preserves face samples on edit, isolates accounts and invalidates claims', async t => {
  const { call, handle, filename } = await fixture(t);
  let result = await call({ action: 'person-save', person: { name: '小明', address: '明明', relationship: '朋友', birthday: '1998-02-28', occupation: '设计师', notes: '喜欢摄影', greeting: '{name}，欢迎来玩。', descriptors: samples() } });
  assert.equal(result.status, 200); assert.equal(result.people.length, 1);
  const id = result.people[0].id; assert.ok(id); assert.equal(result.people[0].relationship, '朋友');
  result = await call({ action: 'person-save', person: { id, name: '小明同学', notes: '周末来访' } });
  assert.equal(result.people[0].descriptors.length, 3); assert.equal(result.people[0].name, '小明同学');
  assert.equal((await call(undefined, 'bob')).people.length, 0);
  assert.equal((await call({ action: 'person-save', person: { id, birthday: '2025-02-30' } })).status, 400);
  assert.equal((await call({ action: 'person-save', person: { id: 'missing', name: 'bad' } })).status, 400);
  assert.equal((await call({ action: 'person-save', person: { name: '其他人', descriptors: samples() } })).status, 400, 'duplicate identities rejected');
  result = await call({ action: 'person-save', person: { name: '本人', isSelf: true, descriptors: samples(.1) } });
  assert.equal(result.people.length, 2);
  assert.equal((await call({ action: 'person-save', person: { name: '第二个本人', isSelf: true } })).status, 400);
  result = await call({ action: 'settings', enabled: true, cameraId: 'camera', quietEnabled: false, aiOpening: true });
  assert.equal((await call({ action: 'claim', revision: result.revision, personId: 'missing' })).claimed, false);
  const claim = await call({ action: 'claim', revision: result.revision, personId: id }); assert.equal(claim.claimed, true);
  const opening = await handle.consumeOpening('alice', result.revision, claim.claimId);
  assert.equal(opening.name, '明明'); assert.equal(opening.person.relationship, '朋友'); assert.equal(opening.allowPersonalContext, false);
  result = await call({ action: 'person-save', person: { id, active: false } });
  assert.equal((await call({ action: 'claim', revision: result.revision, personId: id })).claimed, false);
  const stale = result.revision;
  result = await call({ action: 'person-delete', id }); assert.equal(result.people.length, 1); assert.notEqual(result.revision, stale);
  const stored = JSON.parse(await readFile(filename, 'utf8')); assert.equal(stored.descriptors, undefined, 'modern storage has no duplicated root features');
  const remaining = result.people[0].id;
  result = await call({ action: 'person-delete', id: remaining }); assert.equal(result.enabled, false); assert.equal(result.people.length, 0);
});

test('legacy enrollment migrates without losing settings, cooldown, identity or face samples', async t => {
  const { call, filename } = await fixture(t);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify({ name: '旧称呼', descriptors: samples(), enabled: true, cameraId: 'legacy-camera', revision: 'legacy-rev', lastGreeting: 12345 }));
  const first = await call(), second = await call();
  assert.equal(first.people.length, 1); assert.equal(first.people[0].isSelf, true); assert.equal(first.people[0].id, second.people[0].id);
  assert.equal(first.people[0].lastGreeting, 12345); assert.deepEqual(first.people[0].descriptors, samples()); assert.equal(first.enabled, true);
  const saved = await call({ action: 'person-save', person: { id: first.people[0].id, relationship: '本人', notes: '已迁移' } });
  assert.equal(saved.cameraId, 'legacy-camera'); assert.equal(saved.people[0].name, '旧称呼');
});

test('unique matching ignores disabled records, refuses ambiguous identities and uses correct person greeting and permissions', () => {
  assert.equal(typeof state.matchPerson, 'function');
  const a = { id: 'a', name: '甲', address: '甲老师', active: true, isSelf: false, descriptors: samples() };
  const b = { id: 'b', name: '乙', active: true, isSelf: true, descriptors: samples(.1) };
  assert.equal(state.matchPerson(samples()[0], [a, b])?.id, 'a');
  assert.equal(state.matchPerson(samples()[0], [a, { ...a, id: 'duplicate' }]), null);
  assert.equal(state.matchPerson(samples()[0], [{ ...a, active: false }, b]), null);
  const selected = state.personPresenceSettings({ name: '本人', followUp: true, proactiveEnabled: true, feedback: { state: 'tired', date: '2026-11-13' } }, a);
  assert.equal(selected.name, '甲老师'); assert.equal(selected.followUp, false); assert.equal(selected.proactiveEnabled, false); assert.equal(selected.feedback.state, 'neutral');
});

test('person arrivals retain independent presence across switches and never treat missing frames as departure', () => {
  assert.equal(typeof state.PersonArrivals, 'function');
  const arrivals = new state.PersonArrivals();
  for (const at of [1000, 2000]) assert.equal(arrivals.observe('a', at).arrival, false);
  assert.equal(arrivals.observe('a', 3000).arrival, true);
  assert.equal(arrivals.observe('b', 4000).changed, true);
  arrivals.observe('b', 5000); assert.equal(arrivals.observe('b', 6000).arrival, true);
  assert.equal(arrivals.observe('b', 6500).current.pendingArrival, true, 'arrival survives a busy voice output until it can be attempted');
  assert.equal(arrivals.observe('a', 7000).arrival, false, 'short switch cannot greet A again');
  arrivals.unavailable();
  assert.equal(arrivals.observe('a', 400000).arrival, false, 'offline interval is not absence');
});

test('a clear other or ambiguous face cancels the old interaction; a dropped detection does not switch identity', () => {
  assert.equal(typeof state.presenceIdentityChanged, 'function');
  assert.equal(state.presenceIdentityChanged('a', '', 0), false);
  assert.equal(state.presenceIdentityChanged('a', 'a', 1), false);
  assert.equal(state.presenceIdentityChanged('a', 'b', 1), true);
  assert.equal(state.presenceIdentityChanged('a', '', 1), true);
  assert.equal(state.presenceIdentityChanged('a', '', 2), true);
});
