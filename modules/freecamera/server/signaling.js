import { randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DeviceStore } from './devices.js';
import { PersonEvents } from './person-events.js';
import { sessionToken } from '../../../server/accounts.js';
import { RemoteDetector } from './remote-detector.js';
import { DetectionPreference } from './detection-preference.js';
import { loadRecorderToken, recorderAuthorized } from './recorder-auth.js';

export function attachSignaling(server, { store = new DeviceStore(), detector = null, accounts = null, detectionInterval = 500,
  sourceTimeout = 2500, sourceCheckInterval = 500, relay = null, iceServers = [], requireCameraLogin = false,
  registrationTimeout = 10000, maxPending = 16, maxPendingPerIp = 4, detectionPreference = new DetectionPreference(),
  recorderToken = loadRecorderToken(), onDiagnostic = event => console.log('[connection]', JSON.stringify(event)) } = {}) {
  detector ??= new RemoteDetector();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const rooms = new Map(), codes = new Map(), attempts = new Map();
  let epoch = 0, closing = false, inferenceBusy = false;
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const fail = (ws, code, extra = {}) => send(ws, { type: 'error', code, ...extra });
  function authorized(ws) { return ws.recorder || !accounts || accounts.session(ws.sessionToken)?.user.role === 'admin'; }
  function requireLogin(ws) { if (authorized(ws)) return true; fail(ws, 'login-required'); return false; }
  function directory() { return store.list().map(device => ({ ...device, online: !!rooms.get(device.deviceId)?.camera, viewers: rooms.get(device.deviceId)?.viewers.size || 0 })).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen || a.deviceId.localeCompare(b.deviceId)); }
  function catalogChanged() { for (const ws of wss.clients) if (ws.role === 'catalog' && authorized(ws)) send(ws, { type: 'devices', devices: directory() }); }
  function revoked(id) {
    for (const ws of wss.clients) if (accounts.sessionId(ws.sessionToken) === id && ws.role !== 'camera') {
      detach(ws); ws.close(4001, 'Login required');
    }
  }
  accounts?.on('revoked', revoked);
  const state = () => ({ available: true, location: 'local', ...detector.state, enabled: detectionPreference.enabled });
  const detectionViewers = room => [...room.viewers.entries()].filter(([, ws]) => ws.detectionFrames !== false && authorized(ws));
  function reconcileDetection(retry = false) {
    if (closing) return;
    const current = state();
    const wanted = current.enabled && current.available && [...rooms.values()].some(room => room.camera && detectionViewers(room).length);
    let task;
    if (wanted && (current.status === 'off' || retry && current.status === 'error')) task = detector.enable();
    else if (!wanted && !['off', 'stopping'].includes(current.status)) task = detector.disable();
    if (task) void task.catch(error => console.error('恢复人物检测失败:', error.message));
  }
  function roomFor(id) {
    if (!rooms.has(id)) rooms.set(id, { deviceId: id, camera: null, viewers: new Map(), code: null, microphone: false, events: new PersonEvents(), lastFrame: 0 });
    return rooms.get(id);
  }
  function broadcast(room, message) { for (const ws of room.viewers.values()) send(ws, message); }
  function talkbackState(room, endedRequestId = null) {
    const active = !!room.talkerId;
    send(room.camera, { type: 'talkback-state', active, peerId: room.talkerId || null });
    for (const [id, viewer] of room.viewers) send(viewer, { type: 'talkback-state', active, source: active && id === room.talkerId, requestId: active ? room.talkRequestId : endedRequestId });
  }
  function releaseTalkback(room, id, requestId) {
    if (room.talkerId && (!id || room.talkerId === id) && (requestId === undefined || requestId === room.talkRequestId)) {
      const ended = room.talkRequestId; room.talkerId = null; room.talkRequestId = null; talkbackState(room, ended);
    }
  }
  function detach(ws) {
    clearTimeout(ws.expiry);
    if (ws.role === 'detection-provider') detector.detach?.(ws);
    relay?.release(ws);
    const room = ws.room; if (!room) return;
    ws.room = null;
    if (ws.role === 'camera' && room.camera === ws) {
      releaseTalkback(room);
      codes.delete(room.code); room.code = null; room.camera = null; room.microphone = false; room.events = new PersonEvents();
      broadcast(room, { type: 'microphone-state', enabled: false });
      broadcast(room, { type: 'camera-left', deviceId: room.deviceId }); broadcast(room, { type: 'presence', online: false, deviceId: room.deviceId });
    } else if (ws.role === 'viewer' && room.viewers.delete(ws.peerId)) {
      releaseTalkback(room, ws.peerId);
      send(room.camera, { type: 'peer-left', peerId: ws.peerId });
    }
    detectionState(); catalogChanged();
    reconcileDetection();
  }
  function detectionState() {
    for (const room of rooms.values()) {
      const eligible = detectionViewers(room);
      if (!eligible.some(([id]) => id === room.sourceId)) { room.sourceId = eligible[0]?.[0]; room.sourceSince = Date.now(); }
      for (const [id, ws] of room.viewers) send(ws, { type: 'detection-state', ...state(), cameraOnline: !!room.camera, source: id === room.sourceId && !!room.camera });
    }
  }
  function detectorChanged(s) {
    if (s.status !== 'on') { epoch++; for (const room of rooms.values()) room.events = new PersonEvents(); }
    detectionState();
    if (s.status === 'off') queueMicrotask(() => reconcileDetection());
  }
  detector?.on('state', detectorChanged);
  function attached(ws, room, token) {
    ws.room = room; ws.role = 'viewer'; ws.peerId = randomUUID(); room.viewers.set(ws.peerId, ws);
    send(ws, { type: 'watching', deviceId: room.deviceId, name: store.name(room.deviceId), ...(!accounts ? { viewerToken: token } : {}), ...(relay ? { configuration: relay.configuration(ws, iceServers) } : {}), online: !!room.camera });
    if (room.camera) activate(ws, room);
    else send(ws, { type: 'microphone-state', enabled: false });
    detectionState();
    reconcileDetection();
    talkbackState(room);
    catalogChanged();
  }
  function activate(ws, room) {
    send(ws, { type: 'joined', deviceId: room.deviceId, name: store.name(room.deviceId), ...(!accounts ? { viewerToken: ws.viewerToken } : {}), peerId: ws.peerId, online: true });
    send(ws, { type: 'microphone-state', enabled: room.microphone });
    send(room.camera, { type: 'peer-ready', peerId: ws.peerId });
  }
  function upgrade(req, socket, head) {
    let allowed = false;
    try { const origin = new URL(req.headers.origin); allowed = origin.host === req.headers.host && origin.protocol === (req.socket.encrypted ? 'https:' : 'http:'); } catch {}
    const pending = requireCameraLogin ? [...wss.clients].filter(ws => !ws.role && !accounts?.session(ws.sessionToken)) : [];
    const administrator = accounts?.session(sessionToken(req))?.user.role === 'admin' || recorderAuthorized(req, recorderToken);
    const limited = requireCameraLogin && !administrator && (pending.length >= maxPending || pending.filter(ws => ws.sourceAddress === req.socket.remoteAddress).length >= maxPendingPerIp);
    if (!allowed || limited || req.url !== '/signal' || wss.clients.size >= 128) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  }
  server.on('upgrade', upgrade);
  wss.on('connection', (ws, req) => {
    ws.sourceAddress = req.socket.remoteAddress;
    ws.recorder = recorderAuthorized(req, recorderToken);
    const registration = requireCameraLogin ? setTimeout(() => { if (!ws.role) ws.terminate(); }, registrationTimeout) : null;
    registration?.unref();
    ws.once('close', () => clearTimeout(registration));
    ws.sessionToken = sessionToken(req);
    const session = accounts?.session(ws.sessionToken);
    if (session) { ws.expiry = setTimeout(() => { if (ws.role !== 'camera') { accounts.logout(ws.sessionToken); ws.close(4001, 'Login required'); } }, Math.max(1, session.expires - accounts.now())); ws.expiry.unref(); }
    ws.alive = true; ws.on('error', () => {}); ws.on('pong', () => { ws.alive = true; });
    let traffic = { time: Date.now(), count: 0 }, queue = Promise.resolve();
    ws.on('message', (raw, binary) => {
      if (Date.now() - traffic.time > 10000) traffic = { time: Date.now(), count: 0 };
      if (++traffic.count > 250) { ws.close(1008, 'Too many messages'); return; }
      let m; try { m = JSON.parse(raw); } catch { fail(ws, 'invalid-message'); return; }
      if (binary || !m || typeof m !== 'object') { fail(ws, 'invalid-message'); return; }
      if (ws.recorder && !['catalog', 'watch', 'answer', 'candidate', 'restart', 'ping'].includes(m.type)) { fail(ws, 'recorder-read-only'); return; }
      // Frames are deliberately outside the serialized control queue: never build an inference backlog.
      if (m.type === 'detection-frame') { void detectFrame(ws, m).catch(e => fail(ws, 'detection-failed')); return; }
      if (m.type === 'detection-toggle') { void toggleDetection(ws, m); return; }
      queue = queue.then(async () => {
        if (ws.readyState !== WebSocket.OPEN || closing) return;
        if (['join', 'watch', 'catalog', 'device-remark', 'talkback-start', 'talkback-stop', 'detection-provider-register'].includes(m.type) && !requireLogin(ws)) return;
        if (ws.role && ws.role !== 'camera' && !requireLogin(ws)) return;
        if (m.type === 'ping') { detector.heartbeat?.(ws); send(ws, { type: 'pong' }); return; }
        if (m.type === 'detection-provider-register') {
          if (ws.role) { fail(ws, 'already-joined'); return; }
          if (!(detector instanceof RemoteDetector) || !accounts) { fail(ws, 'provider-unavailable'); return; }
          if (!detector.attach(ws, m.name)) { fail(ws, 'provider-busy'); return; }
          ws.role = 'detection-provider'; send(ws, { type: 'detection-provider-ready' }); return;
        }
        if (ws.role === 'detection-provider') {
          if (['detection-response', 'detection-provider-fault'].includes(m.type)) detector.receive(ws, m);
          else fail(ws, 'invalid-message');
          return;
        }
        if (m.type === 'catalog') {
          if (ws.role) { fail(ws, 'already-joined'); return; }
          ws.role = 'catalog'; send(ws, { type: 'devices', devices: directory() }); return;
        }
        if (m.type === 'device-remark') {
          if (ws.role !== 'catalog') { fail(ws, 'not-joined'); return; }
          try { await store.remark(m.deviceId, m.remark); } catch { fail(ws, 'invalid-remark'); return; }
          send(ws, { type: 'device-remark-saved', deviceId: m.deviceId }); catalogChanged(); return;
        }
        if (m.type === 'create') {
          if (ws.role) { fail(ws, 'already-joined'); return; }
          if (requireCameraLogin && !m.deviceId && !requireLogin(ws)) return;
          let device; try { device = await store.camera(m); } catch { fail(ws, 'unauthorized'); return; }
          if (ws.readyState !== WebSocket.OPEN) return;
          const room = roomFor(device.deviceId);
          if (room.camera) { fail(ws, 'camera-in-use'); return; }
          let code; do { code = randomInt(0, 100000000).toString().padStart(8, '0'); } while (codes.has(code));
          room.camera = ws; room.code = code; room.lastFrame = 0; room.microphone = m.microphone === true; room.events = new PersonEvents(); codes.set(code, room);
          ws.room = room; ws.role = 'camera'; send(ws, { type: 'created', code, ...device, ...(relay ? { configuration: relay.configuration(ws, iceServers) } : {}) });
          broadcast(room, { type: 'presence', online: true, deviceId: room.deviceId, name: device.name });
          for (const viewer of room.viewers.values()) activate(viewer, room);
          detectionState(); reconcileDetection(); catalogChanged(); return;
        }
        if (m.type === 'join' || m.type === 'watch') {
          if (ws.role) { fail(ws, 'already-joined'); return; }
          ws.detectionFrames = !ws.recorder && m.detectionFrames !== false;
          const ip = req.socket.remoteAddress; let entry = attempts.get(ip);
          if (!entry || Date.now() - entry.time > 60000) { entry = { time: Date.now(), count: 0 }; attempts.set(ip, entry); }
          if (entry.count >= 10) { fail(ws, 'rate-limited'); return; }
          let room, token;
          if (m.type === 'join') {
            room = typeof m.code === 'string' && /^\d{8}$/.test(m.code) ? codes.get(m.code) : null;
            if (!room) { entry.count++; fail(ws, /^\d{8}$/.test(m.code ?? '') ? 'not-found' : 'invalid-code'); return; }
            token = await store.viewerToken(room.deviceId);
          } else {
            if (accounts || ws.recorder ? !store.devices.has(m.deviceId) : !store.authorizeViewer(m.deviceId, m.viewerToken)) { entry.count++; fail(ws, 'unauthorized'); return; }
            room = roomFor(m.deviceId); token = m.viewerToken;
          }
          if (ws.readyState !== WebSocket.OPEN || closing || !requireLogin(ws)) return;
          if (ws.recorder ? [...room.viewers.values()].some(viewer => viewer.recorder) : [...room.viewers.values()].filter(viewer => !viewer.recorder).length >= 4) { fail(ws, 'room-full'); return; }
          ws.viewerToken = token; attached(ws, room, token); return;
        }
        const room = ws.room; if (!room) { fail(ws, 'not-joined'); return; }
        if (m.type === 'talkback-start' || m.type === 'talkback-stop') {
          if (ws.role !== 'viewer') { fail(ws, 'not-joined'); return; }
          if (m.requestId !== undefined && (typeof m.requestId !== 'string' || !m.requestId || m.requestId.length > 80)) { fail(ws, 'invalid-message'); return; }
          if (m.type === 'talkback-start') {
            if (!room.camera) { fail(ws, 'camera-offline', { requestId: m.requestId }); return; }
            if (room.talkerId && room.talkerId !== ws.peerId) { fail(ws, 'talkback-busy', { requestId: m.requestId }); return; }
            room.talkerId = ws.peerId; room.talkRequestId = m.requestId || null; talkbackState(room);
          } else { releaseTalkback(room, ws.peerId, m.requestId); send(ws, { type: 'talkback-state', active: !!room.talkerId, source: room.talkerId === ws.peerId, requestId: room.talkerId ? room.talkRequestId : m.requestId || null }); }
          return;
        }
        if (m.type === 'microphone-state' && ws.role === 'camera' && typeof m.enabled === 'boolean') {
          room.microphone = m.enabled; broadcast(room, { type: 'microphone-state', enabled: m.enabled }); return;
        }
        if (m.type === 'diagnostic' && typeof m.stage === 'string' && typeof m.detail === 'string') {
          onDiagnostic({ time: new Date().toISOString(), role: ws.role, device: ws.room?.deviceId?.slice(0, 8), peer: ws.peerId?.slice(0, 8), stage: m.stage.slice(0, 40), detail: m.detail.slice(0, 800) }); send(ws, { type: 'diagnostic-received' }); return;
        }
        if (m.type === 'restart' && ws.role === 'viewer') { releaseTalkback(room, ws.peerId); send(room.camera, { type: 'peer-ready', peerId: ws.peerId }); return; }
        let target;
        if (ws.role === 'camera') target = room.viewers.get(m.peerId);
        else target = room.camera;
        const peerId = ws.role === 'camera' ? m.peerId : ws.peerId;
        if (m.type === 'offer' || m.type === 'answer') {
          const expected = ws.role === 'camera' ? 'offer' : 'answer';
          if (m.type !== expected || m.sdp?.type !== expected || typeof m.sdp.sdp !== 'string' || m.sdp.sdp.length > 60000) { fail(ws, 'invalid-message'); return; }
          send(target, { type: expected, peerId, sdp: { type: expected, sdp: m.sdp.sdp } }); return;
        }
        if (m.type === 'candidate' && m.candidate && typeof m.candidate.candidate === 'string' && m.candidate.candidate.length < 4096) {
          const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = m.candidate;
          send(target, { type: 'candidate', peerId, candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }); return;
        }
        fail(ws, 'invalid-message');
      }).catch(e => { console.error('Signal error:', e.message); fail(ws, 'server-error'); });
    });
    ws.on('close', (code, reason) => {
      onDiagnostic({ time: new Date().toISOString(), role: ws.role || 'unjoined', device: ws.room?.deviceId?.slice(0, 8), peer: ws.peerId?.slice(0, 8), stage: '服务连接关闭', detail: `${code} ${reason.toString().slice(0, 100)}` });
      detach(ws);
    });
  });
  async function toggleDetection(ws, m) {
    if (!requireLogin(ws)) return;
    if (!ws.room || ws.role !== 'viewer') { fail(ws, 'not-joined'); return; }
    if (typeof m.enabled !== 'boolean') { fail(ws, 'invalid-message'); return; }
    if (m.enabled && !ws.room.camera) { detectionState(); return; }
    if (!detector) { send(ws, { type: 'detection-state', ...state() }); return; }
    epoch++;
    try { await detectionPreference.setEnabled(m.enabled); if (!closing) reconcileDetection(true); }
    catch { fail(ws, 'detection-failed'); }
    detectionState();
  }
  async function detectFrame(ws, m) {
    if (!requireLogin(ws)) return;
    const room = ws.room;
    if (!room || ws.role !== 'viewer') { fail(ws, 'not-joined'); return; }
    if (!room.camera || state().status !== 'on' || room.sourceId !== ws.peerId || inferenceBusy) return;
    if (typeof m.jpeg !== 'string' || m.jpeg.length > 400000 || !/^\/9j\/[A-Za-z0-9+/=]+$/.test(m.jpeg)) { fail(ws, 'invalid-frame'); return; }
    if (Date.now() - room.lastFrame < detectionInterval) return;
    room.lastFrame = Date.now(); inferenceBusy = true; const version = epoch, camera = room.camera;
    try {
      const boxes = await detector.detect(m.jpeg);
      if (!boxes || version !== epoch || room.camera !== camera || state().status !== 'on') return;
      broadcast(room, { type: 'detection-result', boxes, time: Date.now() });
      const event = room.events.update(boxes);
      if (event) broadcast(room, { type: 'person-event', ...event, name: store.name(room.deviceId), id: randomUUID() });
    } finally { inferenceBusy = false; }
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    for (const [ip, entry] of attempts) if (Date.now() - entry.time > 60000) attempts.delete(ip);
  }, 15000); heartbeat.unref();
  const sourceLease = setInterval(() => {
    if (state().status !== 'on') return;
    for (const room of rooms.values()) {
      const ids = detectionViewers(room).map(([id]) => id);
      if (!room.camera || ids.length < 2 || Date.now() - Math.max(room.lastFrame, room.sourceSince || 0) < sourceTimeout) continue;
      room.sourceId = ids[(ids.indexOf(room.sourceId) + 1) % ids.length]; room.sourceSince = Date.now();
      detectionState();
    }
  }, sourceCheckInterval); sourceLease.unref();
  return { async close() {
    closing = true; epoch++; clearInterval(heartbeat); clearInterval(sourceLease); server.off('upgrade', upgrade); detector?.off('state', detectorChanged); accounts?.off('revoked', revoked);
    for (const ws of wss.clients) ws.terminate();
    const results = await Promise.allSettled([detector.close?.(), detector.disable(), store.pending, detectionPreference.pending]);
    await new Promise(r => wss.close(r));
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  } };
}
