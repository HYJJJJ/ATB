import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeviceStore } from '../server/devices.js';
import { PersonEvents } from '../server/person-events.js';

test('device credentials persist, viewer tokens cannot impersonate camera', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freecamera-devices-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'devices.json'); const store = await DeviceStore.load(filename);
  const camera = await store.camera({ name: '门口' }); const token = await store.viewerToken(camera.deviceId);
  const loaded = await DeviceStore.load(filename);
  assert.ok(loaded.authorizeViewer(camera.deviceId, token));
  assert.equal((await loaded.camera(camera)).deviceId, camera.deviceId);
  await assert.rejects(loaded.camera({ deviceId: camera.deviceId, cameraKey: token }), /凭据/);
  assert.equal(loaded.authorizeViewer(camera.deviceId, 'bad'), false);
});
test('directory excludes unobserved legacy identities and persists shared remarks separately from camera names', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freecamera-directory-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'devices.json');
  const legacy = { deviceId: 'legacy', cameraKey: 'key', viewerToken: 'token', name: '旧手机' };
  const store = new DeviceStore(filename, [legacy]);
  assert.deepEqual(store.list(), [], 'unconfirmed historical entries must not populate the viewer list');
  await store.camera({ deviceId: 'legacy', cameraKey: 'key' });
  assert.ok(store.list()[0].lastSeen > 0);
  await store.remark('legacy', ' 客厅 <主机> ');
  assert.equal(store.list()[0].remark, '客厅 <主机>');
  const restored = await DeviceStore.load(filename);
  assert.equal(restored.name('legacy'), '客厅 <主机>');
  await restored.camera({ deviceId: 'legacy', cameraKey: 'key', name: 'iPhone' });
  assert.equal(restored.name('legacy'), '客厅 <主机>');
  assert.equal(restored.list()[0].name, 'iPhone');
  assert.equal(restored.authorizeViewer('legacy', 'token'), true);
  await restored.remark('legacy', ''); assert.equal(restored.name('legacy'), 'iPhone');
  await assert.rejects(restored.remark('missing', 'name'));
});
test('person events confirm presence, debounce movement and do not announce disappearance on stale data', () => {
  const events = new PersonEvents(); const box = { x: .1, y: .1, width: .2, height: .4, score: .9 };
  assert.equal(events.update([box], 0), null);
  assert.equal(events.update([box], 500).kind, 'entered');
  assert.equal(events.update([box], 1000), null);
  assert.equal(events.update([{ ...box, x: .6 }], 7000).kind, 'moved');
  assert.equal(events.update([], 8000), null);
  assert.equal(events.update([], 12000).kind, 'left');
  assert.equal(events.update([], 15000), null);
});
