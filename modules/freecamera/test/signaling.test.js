import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachSignaling } from '../server/signaling.js';
import { AccountStore, SESSION_COOKIE } from '../../../server/accounts.js';
import { DeviceStore } from '../server/devices.js';
import { RemoteDetector } from '../server/remote-detector.js';

function next(ws, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handle); reject(Error(`Timeout ${type}`)); }, 2500);
    function handle(raw) { const m = JSON.parse(raw); if (m.type === type && predicate(m)) { clearTimeout(timer); ws.off('message', handle); resolve(m); } }
    ws.on('message', handle);
  });
}
async function fixture(t, options = {}) {
  const server = http.createServer(); const hub = attachSignaling(server, options); const sockets = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  t.after(async () => { sockets.forEach(s => s.terminate()); await hub.close(); await new Promise(r => server.close(r)); });
  return { hub, async connect(origin = `http://${host}`, token) {
    const ws = new WebSocket(`ws://${host}/signal`, { origin, headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {} }); sockets.push(ws); await once(ws, 'open'); return ws;
  }, host };
}
async function request(ws, m, type, predicate) { const p = next(ws, type, predicate); ws.send(JSON.stringify(m)); return p; }

test('optional compute is unavailable offline; admin provider enables shared detection without changing camera presence', async t => {
  const accounts = new AccountStore(); await accounts.setup('compute', 'test'); const session = await accounts.login('compute', 'test');
  const { connect } = await fixture(t, { accounts, detector: null });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(undefined, session.token);
  const offline = await request(viewer, { type: 'join', code: created.code }, 'detection-state');
  assert.equal(offline.available, false);
  const anonymous = await connect();
  assert.equal((await request(anonymous, { type: 'detection-provider-register' }, 'error')).code, 'login-required');
  const provider = await connect(undefined, session.token);
  const online = next(viewer, 'detection-state', m => m.available === true);
  await request(provider, { type: 'detection-provider-register', name: '家用电脑' }, 'detection-provider-ready');
  assert.equal((await online).status, 'off', 'registration must not load the model');
  provider.on('message', raw => {
    const m = JSON.parse(raw); if (m.type !== 'detection-command') return;
    provider.send(JSON.stringify({ type: 'detection-response', id: m.id, state: { status: m.action === 'disable' ? 'off' : 'on', pid: m.action === 'disable' ? null : 123 },
      ...(m.action === 'detect' ? { boxes: [{ x: .1, y: .2, width: .2, height: .3, score: .9 }] } : {}) }));
  });
  const enabled = next(viewer, 'detection-state', m => m.status === 'on');
  viewer.send(JSON.stringify({ type: 'detection-toggle', enabled: true })); await enabled;
  const result = await request(viewer, { type: 'detection-frame', jpeg: '/9j/AA==' }, 'detection-result');
  assert.deepEqual(result.boxes, [{ x: .1, y: .2, width: .2, height: .3, score: .9 }]);
  const disabled = next(viewer, 'detection-state', m => m.status === 'off');
  viewer.send(JSON.stringify({ type: 'detection-toggle', enabled: false })); assert.equal((await disabled).pid, null);
  const lost = next(viewer, 'detection-state', m => m.available === false); provider.close(); await lost;
  const catalog = await connect(undefined, session.token);
  assert.equal((await request(catalog, { type: 'catalog' }, 'devices')).devices[0].online, true);
  const replacement = await connect(undefined, session.token), recovered = next(viewer, 'detection-state', m => m.available === true);
  await request(replacement, { type: 'detection-provider-register' }, 'detection-provider-ready');
  assert.equal((await recovered).status, 'off');
});

test('saved detection intent survives provider loss and last-viewer departure, and a shared off cancels restoration', async t => {
  const accounts = new AccountStore(); await accounts.setup('compute', 'test'); const session = await accounts.login('compute', 'test');
  const { connect } = await fixture(t, { accounts, detector: null });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  let viewer = await connect(undefined, session.token);
  await request(viewer, { type: 'join', code: created.code }, 'detection-state');
  async function provider() {
    const ws = await connect(undefined, session.token);
    ws.on('message', raw => {
      const m = JSON.parse(raw); if (m.type !== 'detection-command') return;
      ws.send(JSON.stringify({ type: 'detection-response', id: m.id, state: { status: m.action === 'disable' ? 'off' : 'on', pid: m.action === 'disable' ? null : 123 }, ...(m.action === 'detect' ? { boxes: [] } : {}) }));
    });
    await request(ws, { type: 'detection-provider-register' }, 'detection-provider-ready'); return ws;
  }
  let compute = await provider();
  const enabled = await request(viewer, { type: 'detection-toggle', enabled: true }, 'detection-state', m => m.status === 'on');
  assert.equal(enabled.enabled, true, 'server must expose saved intent separately from runtime state');
  const offline = next(viewer, 'detection-state', m => !m.available); compute.close();
  assert.equal((await offline).enabled, true, 'losing compute must not clear the saved switch');
  const restored = next(viewer, 'detection-state', m => m.status === 'on'); compute = await provider(); await restored;
  const stopped = next(compute, 'detection-command', m => m.action === 'disable'); viewer.close(); await stopped;
  viewer = await connect(undefined, session.token);
  const resumed = await request(viewer, { type: 'watch', deviceId: created.deviceId }, 'detection-state', m => m.status === 'on');
  assert.equal(resumed.enabled, true);
  const second = await connect(undefined, session.token); await request(second, { type: 'watch', deviceId: created.deviceId }, 'detection-state');
  const sharedOff = next(viewer, 'detection-state', m => m.status === 'off' && !m.enabled);
  await request(second, { type: 'detection-toggle', enabled: false }, 'detection-state', m => m.status === 'off'); await sharedOff;
  const lost = next(viewer, 'detection-state', m => !m.available); compute.close(); await lost;
  const online = next(viewer, 'detection-state', m => m.available); compute = await provider();
  assert.equal((await online).enabled, false);
  assert.equal((await request(viewer, { type: 'detection-toggle', enabled: false }, 'detection-state')).status, 'off');
});

test('compute registration cannot take over a live provider and closing one rejects stale inference results', async t => {
  const accounts = new AccountStore(); await accounts.setup('compute', 'test'); const session = await accounts.login('compute', 'test');
  const { connect } = await fixture(t, { accounts, detector: null });
  const first = await connect(undefined, session.token), second = await connect(undefined, session.token);
  await request(first, { type: 'detection-provider-register' }, 'detection-provider-ready');
  assert.equal((await request(second, { type: 'detection-provider-register' }, 'error')).code, 'provider-busy');
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(undefined, session.token); await request(viewer, { type: 'join', code: created.code }, 'detection-state');
  const enabling = next(first, 'detection-command'); viewer.send(JSON.stringify({ type: 'detection-toggle', enabled: true }));
  const command = await enabling;
  const on = next(viewer, 'detection-state', m => m.status === 'on');
  first.send(JSON.stringify({ type: 'detection-response', id: command.id, state: { status: 'on', pid: 10 } })); await on;
  const inference = next(first, 'detection-command', m => m.action === 'detect'); viewer.send(JSON.stringify({ type: 'detection-frame', jpeg: '/9j/AA==' }));
  const stale = await inference;
  const offline = next(viewer, 'detection-state', m => m.available === false); first.close(); await offline;
  second.on('message', raw => {
    const m = JSON.parse(raw); if (m.type !== 'detection-command') return;
    second.send(JSON.stringify({ type: 'detection-response', id: m.id, state: { status: m.action === 'disable' ? 'off' : 'on', pid: m.action === 'disable' ? null : 123 } }));
  });
  await request(second, { type: 'detection-provider-register' }, 'detection-provider-ready');
  second.send(JSON.stringify({ type: 'detection-response', id: stale.id, boxes: [{ x: 0, y: 0, width: 1, height: 1, score: 1 }], state: { status: 'on', pid: 10 } }));
  const pong = await request(viewer, { type: 'ping' }, 'pong'); assert.equal(pong.type, 'pong');
  assert.equal((await request(viewer, { type: 'detection-toggle', enabled: false }, 'detection-state', m => m.status === 'off')).available, true);
});

test('compute heartbeat and task deadlines release a stalled provider while preserving camera signaling', async t => {
  const accounts = new AccountStore(); await accounts.setup('compute', 'test'); const session = await accounts.login('compute', 'test');
  const detector = new RemoteDetector({ leaseMs: 200, requestTimeoutMs: 80 });
  const { connect } = await fixture(t, { accounts, detector });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(undefined, session.token); await request(viewer, { type: 'join', code: created.code }, 'detection-state');
  const provider = await connect(undefined, session.token); await request(provider, { type: 'detection-provider-register' }, 'detection-provider-ready');
  const stalled = next(viewer, 'detection-state', m => !m.available), closed = once(provider, 'close');
  viewer.send(JSON.stringify({ type: 'detection-toggle', enabled: true }));
  await stalled; assert.equal((await closed)[0], 4000);
  const another = await connect(undefined, session.token); await request(another, { type: 'detection-provider-register' }, 'detection-provider-ready');
  const expired = next(viewer, 'detection-state', m => !m.available); await expired;
  assert.equal((await request(camera, { type: 'ping' }, 'pong')).type, 'pong');
});

test('a delayed compute fault from an older control cannot cancel a new model start', async t => {
  const accounts = new AccountStore(); await accounts.setup('compute', 'test'); const session = await accounts.login('compute', 'test');
  const { connect } = await fixture(t, { accounts, detector: null });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(undefined, session.token); await request(viewer, { type: 'join', code: created.code }, 'detection-state');
  const provider = await connect(undefined, session.token); await request(provider, { type: 'detection-provider-register' }, 'detection-provider-ready');
  let pending = next(provider, 'detection-command'); viewer.send(JSON.stringify({ type: 'detection-toggle', enabled: true })); const first = await pending;
  const failed = next(viewer, 'detection-state', m => m.status === 'error');
  provider.send(JSON.stringify({ type: 'detection-provider-fault', controlId: first.id })); await failed;
  pending = next(provider, 'detection-command'); viewer.send(JSON.stringify({ type: 'detection-toggle', enabled: true })); const second = await pending;
  const on = next(viewer, 'detection-state', m => m.status === 'on');
  provider.send(JSON.stringify({ type: 'detection-provider-fault', controlId: first.id }));
  provider.send(JSON.stringify({ type: 'detection-response', id: second.id, state: { status: 'on', pid: 123 } }));
  assert.equal((await on).pid, 123);
});

test('public enrollment requires admin for new cameras and allows existing camera credentials after session loss', async t => {
  const accounts = new AccountStore(); await accounts.setup('a', '1'); const session = await accounts.login('a', '1');
  const { connect } = await fixture(t, { accounts, requireCameraLogin: true });
  const anonymous = await connect();
  assert.equal((await request(anonymous, { type: 'create' }, 'error')).code, 'login-required');
  const admin = await connect(undefined, session.token);
  const device = await request(admin, { type: 'create', name: 'registered' }, 'created');
  const closed = once(admin, 'close'); admin.close(); await closed; accounts.logout(session.token);
  const camera = await connect();
  const restored = await request(camera, { type: 'create', deviceId: device.deviceId, cameraKey: device.cameraKey }, 'created');
  assert.equal(restored.deviceId, device.deviceId);
  const invalid = await connect();
  assert.equal((await request(invalid, { type: 'create', deviceId: device.deviceId, cameraKey: 'wrong' }, 'error')).code, 'unauthorized');
});

test('public pending socket limits preserve admin capacity and terminate idle anonymous connections', async t => {
  const accounts = new AccountStore(); await accounts.setup('a', '1'); const session = await accounts.login('a', '1');
  const { connect } = await fixture(t, { accounts, requireCameraLogin: true, registrationTimeout: 200, maxPending: 2, maxPendingPerIp: 2 });
  const pending = await connect(), second = await connect();
  await assert.rejects(connect(), /403/);
  const admin = await connect(undefined, session.token);
  assert.equal((await request(admin, { type: 'catalog' }, 'devices')).type, 'devices');
  const closes = Promise.all([once(pending, 'close'), once(second, 'close')]);
  await closes;
  const replacement = await connect();
  assert.equal((await request(replacement, { type: 'create' }, 'error')).code, 'login-required');
});

test('administrator lists all cameras and watches by id; old pairing credentials cannot bypass login; logout closes viewers', async t => {
  const accounts = new AccountStore(), store = new DeviceStore();
  await accounts.setup('admin', 'camera-password'); const session = await accounts.login('admin', 'camera-password');
  const { connect } = await fixture(t, { accounts, store });
  const camera = await connect(); const created = await request(camera, { type: 'create', name: '<camera>' }, 'created');
  const oldToken = await store.viewerToken(created.deviceId), unauthed = await connect();
  for (const message of [{ type: 'catalog' }, { type: 'watch', deviceId: created.deviceId, viewerToken: oldToken }, { type: 'join', code: created.code }, { type: 'detection-toggle', enabled: true }]) {
    assert.equal((await request(unauthed, message, 'error')).code, 'login-required');
  }
  const admin = await connect(undefined, session.token);
  const listed = await request(admin, { type: 'catalog' }, 'devices');
  assert.deepEqual(listed.devices, [{ deviceId: created.deviceId, name: '<camera>', remark: '', lastSeen: store.devices.get(created.deviceId).lastSeen, online: true, viewers: 0 }]);
  assert.equal(JSON.stringify(listed).includes(oldToken), false); assert.equal(JSON.stringify(listed).includes(created.cameraKey), false);
  const viewer = await connect(undefined, session.token); const ready = next(camera, 'peer-ready');
  const joined = await request(viewer, { type: 'watch', deviceId: created.deviceId }, 'joined'); await ready;
  assert.equal(joined.deviceId, created.deviceId); assert.equal(joined.viewerToken, undefined);
  const offline = next(admin, 'devices', m => m.devices[0]?.online === false); camera.close(); await offline;
  const second = await connect(); const added = next(admin, 'devices', m => m.devices.length === 2);
  await request(second, { type: 'create', name: 'second' }, 'created'); assert.equal((await added).devices.length, 2);
  const adminClosed = once(admin, 'close'), viewerClosed = once(viewer, 'close'); accounts.logout(session.token);
  assert.equal((await adminClosed)[0], 4001); assert.equal((await viewerClosed)[0], 4001);
});

test('observed directory puts online cameras first and authenticated remarks update all catalogs', async t => {
  const accounts = new AccountStore(); await accounts.setup('a', '1'); const session = await accounts.login('a', '1');
  const { connect } = await fixture(t, { accounts });
  const camera = await connect(), first = await request(camera, { type: 'create', name: '离线手机' }, 'created');
  const camera2 = await connect(), second = await request(camera2, { type: 'create', name: '在线手机' }, 'created');
  const catalog = await connect(undefined, session.token); await request(catalog, { type: 'catalog' }, 'devices');
  const offline = next(catalog, 'devices', m => m.devices.find(d => d.deviceId === first.deviceId)?.online === false); camera.close(); await offline;
  const catalog2 = await connect(undefined, session.token), list = await request(catalog2, { type: 'catalog' }, 'devices');
  assert.deepEqual(list.devices.map(d => d.deviceId), [second.deviceId, first.deviceId]);
  const unauthorized = await connect(); assert.equal((await request(unauthorized, { type: 'device-remark', deviceId: second.deviceId, remark: '无权限' }, 'error')).code, 'login-required');
  const changed = next(catalog2, 'devices', m => m.devices[0].remark === '门口 <iPhone>');
  const saved = await request(catalog, { type: 'device-remark', deviceId: second.deviceId, remark: '门口 <iPhone>' }, 'device-remark-saved');
  assert.equal(saved.deviceId, second.deviceId); assert.equal((await changed).devices[0].name, '在线手机');
});

test('talkback grants one authenticated speaker and releases on stop, peer restart, camera loss and logout', async t => {
  const accounts = new AccountStore(); await accounts.setup('a', '1'); const session = await accounts.login('a', '1');
  const { connect } = await fixture(t, { accounts });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const unauth = await connect(); assert.equal((await request(unauth, { type: 'talkback-start' }, 'error')).code, 'login-required');
  const viewer = await connect(undefined, session.token), viewer2 = await connect(undefined, session.token);
  const first = await request(viewer, { type: 'watch', deviceId: created.deviceId }, 'joined');
  await request(viewer2, { type: 'watch', deviceId: created.deviceId }, 'joined');
  let received = next(camera, 'talkback-state', m => m.active);
  const grant = await request(viewer, { type: 'talkback-start' }, 'talkback-state', m => m.source);
  assert.equal(grant.source, true); assert.equal((await received).peerId, first.peerId);
  assert.equal((await request(viewer2, { type: 'talkback-start' }, 'error')).code, 'talkback-busy');
  assert.equal((await request(viewer2, { type: 'talkback-stop' }, 'talkback-state')).source, false);
  received = next(camera, 'talkback-state', m => !m.active); await request(viewer, { type: 'talkback-stop' }, 'talkback-state'); await received;
  await request(viewer2, { type: 'talkback-start' }, 'talkback-state', m => m.source);
  received = next(camera, 'talkback-state', m => !m.active); viewer2.send(JSON.stringify({ type: 'restart' })); await received;
  await request(viewer, { type: 'talkback-start' }, 'talkback-state', m => m.source);
  received = next(viewer, 'talkback-state', m => !m.active); camera.close(); await received;
  assert.equal((await request(viewer, { type: 'talkback-start' }, 'error')).code, 'camera-offline');
  const replacement = await connect(); const restored = next(viewer, 'joined');
  await request(replacement, { type: 'create', deviceId: created.deviceId, cameraKey: created.cameraKey }, 'created'); await restored;
  await request(viewer, { type: 'talkback-start' }, 'talkback-state', m => m.source); received = next(replacement, 'talkback-state', m => !m.active);
  accounts.logout(session.token); await received;
});
test('stale talkback cancellation cannot release a newer speaking request', async t => {
  const { connect } = await fixture(t);
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(); await request(viewer, { type: 'join', code: created.code }, 'joined');
  await request(viewer, { type: 'talkback-start', requestId: 'first' }, 'talkback-state', m => m.source);
  await request(viewer, { type: 'talkback-start', requestId: 'second' }, 'talkback-state', m => m.source);
  const current = await request(viewer, { type: 'talkback-stop', requestId: 'first' }, 'talkback-state');
  assert.equal(current.active, true); assert.equal(current.source, true); assert.equal(current.requestId, 'second');
});

test('expired administrator session closes an existing catalog socket', async t => {
  const accounts = new AccountStore(null, null, { sessionMs: 80 });
  await accounts.setup('admin', 'camera-password'); const session = await accounts.login('admin', 'camera-password');
  const { connect } = await fixture(t, { accounts }); const socket = await connect(undefined, session.token);
  const closed = once(socket, 'close'); await request(socket, { type: 'catalog' }, 'devices');
  assert.equal((await closed)[0], 4001);
});

for (const reason of ['logout', 'expiry']) test(`${reason} immediately detaches media even when a viewer ignores the close handshake`, async t => {
  const accounts = new AccountStore(null, null, { sessionMs: reason === 'expiry' ? 200 : 60000 });
  await accounts.setup('admin', 'camera-password'); const session = await accounts.login('admin', 'camera-password');
  const { connect } = await fixture(t, { accounts });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(undefined, session.token);
  const ready = next(camera, 'peer-ready');
  await request(viewer, { type: 'watch', deviceId: created.deviceId }, 'joined');
  const { peerId } = await ready;
  // Simulate an unresponsive client: receiving Close must not acknowledge or close TCP.
  viewer._receiver.removeAllListeners('conclude');
  const left = next(camera, 'peer-left');
  if (reason === 'logout') accounts.logout(session.token);
  assert.equal((await left).peerId, peerId);
  assert.equal(viewer.readyState, WebSocket.OPEN, 'camera must stop media before the viewer finishes closing');
  assert.equal(accounts.session(session.token), null);
});

test('revoking a session while legacy pairing persists its token cannot attach a late viewer', async t => {
  const accounts = new AccountStore(), store = new DeviceStore();
  await accounts.setup('admin', 'camera-password'); const session = await accounts.login('admin', 'camera-password');
  const { connect } = await fixture(t, { accounts, store });
  const camera = await connect(), created = await request(camera, { type: 'create' }, 'created');
  const messages = []; camera.on('message', raw => messages.push(JSON.parse(raw)));
  let release, started;
  const persisting = new Promise(resolve => { started = resolve; });
  store.viewerToken = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const viewer = await connect(undefined, session.token), closed = once(viewer, 'close');
  viewer.send(JSON.stringify({ type: 'join', code: created.code })); await persisting;
  accounts.logout(session.token); release('legacy-token'); await closed;
  assert.equal(messages.some(message => message.type === 'peer-ready'), false);
});

test('multiple paired viewers receive isolated media and automatically resume after camera reconnects', async t => {
  const { connect } = await fixture(t); const camera = await connect();
  const created = await request(camera, { type: 'create', name: 'iPhone' }, 'created');
  assert.match(created.code, /^\d{8}$/); assert.ok(created.cameraKey);
  const viewer = await connect(); const ready = next(camera, 'peer-ready');
  const joined = await request(viewer, { type: 'join', code: created.code }, 'joined');
  const peer1 = (await ready).peerId; assert.ok(joined.viewerToken); assert.equal(joined.cameraKey, undefined);
  const second = await connect(); const ready2 = next(camera, 'peer-ready');
  await request(second, { type: 'join', code: created.code }, 'joined'); const peer2 = (await ready2).peerId;
  assert.notEqual(peer1, peer2);
  const offer = next(viewer, 'offer'); camera.send(JSON.stringify({ type: 'offer', peerId: peer1, sdp: { type: 'offer', sdp: 'sdp' } }));
  assert.equal((await offer).sdp.sdp, 'sdp');
  assert.equal((await request(viewer, { type: 'offer', peerId: peer2, sdp: { type: 'offer', sdp: 'hack' } }, 'error')).code, 'invalid-message');
  const left = next(viewer, 'camera-left'); camera.close(); await left;
  const reconnect = await connect(); const resumed = next(viewer, 'joined');
  await request(reconnect, { type: 'create', deviceId: created.deviceId, cameraKey: created.cameraKey }, 'created');
  assert.equal((await resumed).deviceId, created.deviceId);
  const watcher = await connect();
  const restored = await request(watcher, { type: 'watch', deviceId: joined.deviceId, viewerToken: joined.viewerToken }, 'joined');
  assert.equal(restored.deviceId, joined.deviceId);
  const unauthorized = await connect();
  assert.equal((await request(unauthorized, { type: 'watch', deviceId: joined.deviceId, viewerToken: 'bad' }, 'error')).code, 'unauthorized');
});

test('unpaired clients cannot run inference; paired off terminates globally; source selection prevents duplicate inference', async t => {
  class Detector extends EventEmitter {
    state = { status: 'off', pid: null, backend: 'CPU' }; calls = 0;
    async enable() { this.state = { status: 'on', pid: 123, backend: 'CPU' }; this.emit('state', this.state); }
    async disable() { this.state = { status: 'off', pid: null, backend: 'CPU' }; this.emit('state', this.state); }
    async detect() { this.calls++; return [{ x: .1, y: .1, width: .3, height: .6, score: .9 }]; }
  }
  const detector = new Detector(); const { connect } = await fixture(t, { detector, detectionInterval: 0 });
  const invalid = await connect(); assert.equal((await request(invalid, { type: 'detection-toggle', enabled: true }, 'error')).code, 'not-joined');
  const camera = await connect(); const created = await request(camera, { type: 'create' }, 'created');
  const a = await connect(); await request(a, { type: 'join', code: created.code }, 'joined');
  await request(a, { type: 'detection-toggle', enabled: true }, 'detection-state');
  const jpeg = '/9j/' + 'a'.repeat(100);
  const result = await request(a, { type: 'detection-frame', jpeg }, 'detection-result'); assert.equal(result.boxes.length, 1);
  const b = await connect(); await request(b, { type: 'join', code: created.code }, 'joined');
  b.send(JSON.stringify({ type: 'detection-frame', jpeg }));
  await new Promise(r => setTimeout(r, 25)); assert.equal(detector.calls, 1);
  await request(a, { type: 'detection-toggle', enabled: false }, 'detection-state');
  assert.equal(detector.state.status, 'off'); assert.equal(detector.state.pid, null);
});

test('foreign origins are refused and pairing attempts are rate limited', async t => {
  const { connect, host } = await fixture(t);
  const bad = new WebSocket(`ws://${host}/signal`, { origin: 'https://evil.example' });
  assert.match((await once(bad, 'error'))[0].message, /403/);
  const ws = await connect();
  for (let i = 0; i < 11; i++) assert.equal((await request(ws, { type: 'join', code: '00000000' }, 'error')).code, i === 10 ? 'rate-limited' : 'not-found');
});

test('only the owning camera can publish microphone state; late viewers and offline viewers receive current state', async t => {
  const { connect } = await fixture(t), camera = await connect();
  const created = await request(camera, { type: 'create', microphone: true }, 'created');
  const viewer = await connect(), initial = next(viewer, 'microphone-state');
  const joined = await request(viewer, { type: 'join', code: created.code }, 'joined');
  assert.equal((await initial).enabled, true);
  assert.equal((await request(viewer, { type: 'microphone-state', enabled: false }, 'error')).code, 'invalid-message');
  assert.equal((await request(camera, { type: 'microphone-state', enabled: 'false' }, 'error')).code, 'invalid-message');
  const disabled = next(viewer, 'microphone-state'); camera.send(JSON.stringify({ type: 'microphone-state', enabled: false }));
  assert.equal((await disabled).enabled, false);
  const late = await connect(), lateState = next(late, 'microphone-state');
  await request(late, { type: 'join', code: created.code }, 'joined'); assert.equal((await lateState).enabled, false);
  const enabled = next(viewer, 'microphone-state'), lateEnabled = next(late, 'microphone-state');
  camera.send(JSON.stringify({ type: 'microphone-state', enabled: true }));
  assert.equal((await enabled).enabled, true); assert.equal((await lateEnabled).enabled, true);
  const offline = next(viewer, 'microphone-state'); camera.close(); assert.equal((await offline).enabled, false);
  const restored = await connect(), offlineState = next(restored, 'microphone-state');
  await request(restored, { type: 'watch', deviceId: joined.deviceId, viewerToken: joined.viewerToken }, 'watching');
  assert.equal((await offlineState).enabled, false);
});

test('same viewer can cancel a model that is still loading', async t => {
  class Slow extends EventEmitter {
    state = { status: 'off', pid: null, backend: 'CPU' };
    enable() { this.state = { status: 'starting', pid: 123, backend: 'CPU' }; this.emit('state', this.state); return new Promise(r => { this.ready = r; }); }
    async disable() { this.state = { status: 'off', pid: null, backend: 'CPU' }; this.emit('state', this.state); this.ready?.(); }
  }
  const detector = new Slow(); const { connect } = await fixture(t, { detector });
  const camera = await connect(); const created = await request(camera, { type: 'create' }, 'created');
  const viewer = await connect(); await request(viewer, { type: 'join', code: created.code }, 'joined');
  assert.equal((await request(viewer, { type: 'detection-toggle', enabled: true }, 'detection-state')).status, 'starting');
  const off = await request(viewer, { type: 'detection-toggle', enabled: false }, 'detection-state');
  assert.equal(off.status, 'off');
});

test('detection source moves to another viewer when the original stops supplying frames', async t => {
  class Detector extends EventEmitter {
    state = { status: 'off', pid: null, backend: 'CPU' };
    async enable() { this.state = { status: 'on', pid: 123, backend: 'CPU' }; this.emit('state', this.state); }
    async disable() { this.state = { status: 'off', pid: null, backend: 'CPU' }; }
  }
  const { connect } = await fixture(t, { detector: new Detector(), sourceTimeout: 40, sourceCheckInterval: 10 });
  const camera = await connect(); const created = await request(camera, { type: 'create' }, 'created');
  const first = await connect(); await request(first, { type: 'join', code: created.code }, 'joined');
  const second = await connect(); await request(second, { type: 'join', code: created.code }, 'joined');
  await request(first, { type: 'detection-toggle', enabled: true }, 'detection-state', m => m.status === 'on');
  const promoted = await next(second, 'detection-state', m => m.source === true);
  assert.equal(promoted.status, 'on');
});
