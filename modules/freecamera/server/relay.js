import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from 'turn-server';
import { privateAddress } from './stun.js';

export async function startRelay({ addresses, relayIp, port = 0, advertisedPort, allowPublic = false, registrationTimeout = 10000, maxPending = 32, maxPendingPerIp = 16 }) {
  const grants = new Map(), users = new Map(), allocations = new Map(), sockets = new Set();
  let closing;
  function closeAllocation(socket) {
    const source = socket.getSession().context.source;
    socket.close();
    // Server-side TURN sockets release UDP allocations but do not end their TCP transport.
    for (const connection of sockets) {
      if (connection.remoteAddress?.replace(/^::ffff:/, '') === source.ip && connection.remotePort === source.port) connection.destroy();
    }
  }
  const relay = createServer({
    auth: { mechanism: 'long-term', realm: 'freecamera' }, relay: { ip: relayIp },
    allowPrivatePeers: true, allowLoopback: relayIp.startsWith('127.'),
    maxConnections: 128, totalQuota: 64, userQuota: 16, maxDataSize: 65535,
    maxPermissionsPerAllocation: 8, maxChannelsPerAllocation: 8,
    unallocatedTimeout: 10000, defaultAllocateLifetime: 600, maxAllocateLifetime: 600,
  });
  relay.on('accept', (info, allow) => allow(allowPublic || privateAddress(info.source.ip)));
  relay.on('authorize', (info, allow) => allow(users.has(info.username)));
  relay.on('allocate', (socket, allocation) => {
    // Allocation binds asynchronously; authorization may have been revoked in the meantime.
    if (!users.has(allocation.username)) { closeAllocation(socket); return; }
    const source = socket.getSession().context.source;
    const transport = [...sockets].find(connection => connection.remoteAddress?.replace(/^::ffff:/, '') === source.ip && connection.remotePort === source.port);
    if (!transport || transport.destroyed) { closeAllocation(socket); return; }
    transport.allocated = true; clearTimeout(transport.registrationTimer);
    allocations.set(allocation.relayAddress.port, { socket, username: allocation.username });
  });
  relay.on('allocate:expired', (_socket, allocation) => allocations.delete(allocation.relayAddress.port));
  const sameRoom = info => {
    const owner = users.get(info.username), target = allocations.get(info.peer.port);
    return !!owner && info.peer.ip === relayIp && !!target && users.get(target.username)?.room === owner.room;
  };
  // Permissions cover an IP; actual packets/channels must target a live allocation in the same camera room.
  relay.on('beforePermission', (info, allow) => allow(users.has(info.username) && info.peer.ip === relayIp));
  for (const event of ['beforeChannelBind', 'beforeRelay', 'beforeData']) relay.on(event, (info, allow) => allow(sameRoom(info)));
  relay.on('clientError', error => { if (!['ECONNRESET', 'EPIPE'].includes(error.code)) console.error('Media relay client:', error.message); });
  const listener = net.createServer(socket => {
    if (allowPublic) {
      const pending = [...sockets].filter(connection => !connection.allocated);
      if (pending.length >= maxPending || pending.filter(connection => connection.remoteAddress === socket.remoteAddress).length >= maxPendingPerIp) { socket.destroy(); return; }
      socket.registrationTimer = setTimeout(() => socket.destroy(), registrationTimeout); socket.registrationTimer.unref();
    }
    sockets.add(socket); socket.once('close', () => { sockets.delete(socket); clearTimeout(socket.registrationTimer); }); relay.handleTcpConnection(socket);
  });
  try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '0.0.0.0', resolve); }); }
  catch (error) { relay.stop(); throw error; }
  listener.on('error', error => console.error('Media relay:', error.message));
  const relayPort = listener.address().port;
  return {
    port: relayPort,
    configuration(owner, iceServers) {
      let grant = grants.get(owner);
      if (!grant) {
        grant = { username: randomBytes(20).toString('hex'), credential: randomBytes(32).toString('hex'), room: owner.room.deviceId };
        grants.set(owner, grant); users.set(grant.username, grant); relay.addUser(grant.username, grant.credential);
      }
      return { iceServers: [...iceServers, { urls: [...new Set(addresses)].map(address => `turn:${address}:${advertisedPort ?? relayPort}?transport=tcp`), username: grant.username, credential: grant.credential }], ...(allowPublic ? { iceTransportPolicy: 'relay' } : {}) };
    },
    release(owner) {
      const grant = grants.get(owner); if (!grant) return;
      grants.delete(owner); users.delete(grant.username); relay.removeUser(grant.username);
      for (const allocation of [...allocations.values()]) if (allocation.username === grant.username) closeAllocation(allocation.socket);
    },
    stats() { return relay.getStats(); },
    close() {
      return closing ??= (async () => {
        grants.clear(); users.clear();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => relay.stop(resolve));
        await new Promise(resolve => listener.close(resolve));
      })();
    },
  };
}
