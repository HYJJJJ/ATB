import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { connect } from 'turn-server';
import { startRelay } from '../server/relay.js';
function event(emitter, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(name, handler); reject(Error(`Timeout: ${name}`)); }, 2000);
    function handler(...args) { clearTimeout(timer); emitter.off(name, handler); resolve(args); }
    emitter.on(name, handler);
  });
}

test('public relay expires unallocated TCP transports despite ongoing anonymous binding traffic', async t => {
  const relay = await startRelay({ addresses: ['127.0.0.1'], relayIp: '127.0.0.1', allowPublic: true, registrationTimeout: 200, maxPending: 2, maxPendingPerIp: 2 });
  const clients = [], timers = [];
  t.after(async () => { timers.forEach(clearInterval); clients.forEach(c => c.destroy?.()); await relay.close(); });
  async function pending() {
    const socket = net.connect(relay.port, '127.0.0.1'); clients.push(socket); socket.on('error', () => {});
    await event(socket, 'connect');
    const binding = Buffer.from('000100002112a442000102030405060708090a0b', 'hex');
    socket.write(binding); timers.push(setInterval(() => { if (!socket.destroyed) socket.write(binding); }, 20));
    return socket;
  }
  const first = await pending(), second = await pending();
  const rejected = net.connect(relay.port, '127.0.0.1'); clients.push(rejected); rejected.on('error', () => {});
  await event(rejected, 'close');
  await Promise.all([event(first, 'close'), event(second, 'close')]);
  const grant = relay.configuration({ room: { deviceId: 'real-camera' } }, []).iceServers[0];
  const valid = connect(grant.urls[0], { username: grant.username, password: grant.credential, autoRefresh: false }); valid.on('error', () => {});
  t.after(() => valid.close());
  await event(valid, 'connect'); const allocation = event(valid, 'allocate:success'); valid.allocate({ lifetime: 600 }); await allocation;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(relay.stats().activeAllocations, 1, 'authenticated allocation must outlive the enrollment deadline');
});

test('TCP relay restricts data to live allocations in the same camera room and releases revoked users', async t => {
  const relay = await startRelay({ addresses: ['127.0.0.1'], relayIp: '127.0.0.1' }), clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await relay.close(); });
  async function allocate(owner) {
    const settings = relay.configuration(owner, []).iceServers[0];
    const client = connect(settings.urls[0], { username: settings.username, password: settings.credential, autoRefresh: false }); clients.push(client);
    client.on('error', () => {});
    const connected = event(client, 'connect'); await connected;
    const allocated = event(client, 'allocate:success'); client.allocate({ lifetime: 600 });
    const [message] = await allocated;
    return { client, peer: message.getAttribute(0x0016) };
  }
  const owner = { room: { deviceId: 'one' } }, first = await allocate(owner), second = await allocate({ room: { deviceId: 'one' } }), other = await allocate({ room: { deviceId: 'other' } });
  const permit = (client, peer) => new Promise((resolve, reject) => client.createPermission([peer], error => error ? reject(error) : resolve()));
  await permit(first.client, second.peer); await permit(second.client, first.peer);
  const received = event(second.client, 'data'); first.client.send(second.peer, Buffer.from('camera-packet'));
  assert.equal(Buffer.from((await received)[1]).toString(), 'camera-packet');
  await permit(first.client, other.peer); let crossRoom = false;
  other.client.on('data', () => { crossRoom = true; }); first.client.send(other.peer, Buffer.from('forbidden'));
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(crossRoom, false);
  const closed = event(first.client, 'close'); relay.release(owner); await closed;
  assert.equal(relay.stats().activeAllocations, 2, 'revocation must immediately release the allocation');
  assert.equal(relay.configuration(owner, []).iceServers[0].username.length > 0, true);
  // The TCP listener is owned by this service, and can be released completely.
  const port = relay.port; clients.forEach(c => c.close()); clients.length = 0; await relay.close();
  const listener = net.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '0.0.0.0', resolve); }); await new Promise(resolve => listener.close(resolve));
});

test('revoking a grant during asynchronous UDP allocation closes the late allocation and TCP connection', async t => {
  const relay = await startRelay({ addresses: ['127.0.0.1'], relayIp: '127.0.0.1' });
  const owner = { room: { deviceId: 'camera' } }, settings = relay.configuration(owner, []).iceServers[0];
  const client = connect(settings.urls[0], { username: settings.username, password: settings.credential, autoRefresh: false });
  client.on('error', () => {});
  const bind = dgram.Socket.prototype.bind;
  t.after(async () => { dgram.Socket.prototype.bind = bind; client.close(); await relay.close(); });
  await event(client, 'connect');
  let revoked = false;
  dgram.Socket.prototype.bind = function(...args) {
    const callback = args.at(-1);
    if (typeof callback === 'function') args[args.length - 1] = function(...values) {
      relay.release(owner); revoked = true;
      return callback.apply(this, values);
    };
    return bind.apply(this, args);
  };
  const closed = event(client, 'close'); client.allocate({ lifetime: 600 }); await closed;
  assert.equal(revoked, true, 'test must revoke after binding starts and before it completes');
  assert.equal(relay.stats().activeAllocations, 0);
  assert.equal(relay.stats().activeConnections, 0);
});
