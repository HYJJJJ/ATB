import { connectSignal } from '/signal.js';
const video = document.querySelector('video'), canvas = document.createElement('canvas');
let socket, peer, peerId, candidates = [], retry, generation = 0, cameraId, parentOrigin, timer, busy = false, lastTime = -1, lastFresh = Date.now(), stopped = false;
const send = value => socket?.send(JSON.stringify(value));
const report = value => { if (window.atbPresenceCamera) void window.atbPresenceCamera.publish(value); else if (parentOrigin) parent.postMessage({ source: 'atb-presence-camera', ...value }, parentOrigin); };
function reset() { peer?.close(); peer = null; candidates = []; video.srcObject?.getTracks().forEach(t => t.stop()); video.srcObject = null; lastTime = -1; }
function reconnect(error) { if (stopped) return; generation++; socket?.close(); reset(); clearTimeout(retry); report(error ? { kind: 'error', error } : { kind: 'unavailable' }); retry = setTimeout(connect, error ? 5000 : 2000); }
function connect() {
  if (stopped) return;
  const version = ++generation; let configuration = { iceServers: [] }, queue = Promise.resolve();
  socket = connectSignal({ onOpen() { send({ type: 'watch', deviceId: cameraId, detectionFrames: false }); }, onClose(_ws, event) {
    if (version !== generation) return;
    if (event.code === 4001) { reconnect('监控服务登录已过期，请在监控模块重新登录'); return; }
    reconnect();
  }, onMessage(_ws, event) {
    queue = queue.then(async () => {
      if (version !== generation) return;
      const m = JSON.parse(event.data);
      if (m.type === 'error') { reconnect(m.code === 'login-required' ? '请先登录所选监控服务' : `监控连接失败：${m.code}`); return; }
      if (m.configuration) configuration = m.configuration;
      if (m.type === 'camera-left') { reset(); report({ kind: 'unavailable' }); }
      if (m.type === 'offer') {
        reset(); peerId = m.peerId; const pc = new RTCPeerConnection(configuration); peer = pc;
        pc.onicecandidate = e => { if (peer === pc && e.candidate) send({ type: 'candidate', peerId, candidate: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => { if (peer === pc && ['failed', 'disconnected'].includes(pc.connectionState)) reconnect(); };
        pc.ontrack = event => { if (peer !== pc) return; if (event.track.kind === 'video') { video.srcObject = new MediaStream([event.track]); void video.play().catch(() => report({ kind: 'error', error: '后台画面无法播放' })); } };
        await pc.setRemoteDescription(m.sdp); for (const c of candidates.splice(0)) await pc.addIceCandidate(c);
        await pc.setLocalDescription(await pc.createAnswer()); if (peer === pc) send({ type: 'answer', peerId, sdp: pc.localDescription });
      } else if (m.type === 'candidate') { if (peer?.remoteDescription) await peer.addIceCandidate(m.candidate); else if (candidates.length < 100) candidates.push(m.candidate); }
    }).catch(() => { if (version === generation) reconnect(); });
  } });
}
function initialize(options) {
  if (options.catalog) {
    socket = connectSignal({ onOpen() { send({ type: 'catalog' }); }, onMessage(_ws, event) { const m = JSON.parse(event.data); if (m.type === 'devices') report({ kind: 'devices', devices: m.devices }); else if (m.type === 'error') report({ kind: 'error', error: m.code }); }, onClose() {} }); return;
  }
  if (!cameraId) {
    cameraId = options.cameraId;
    if (typeof cameraId !== 'string' || !cameraId || cameraId.length > 160) return;
    connect();
    timer = setInterval(() => {
      if (busy || video.readyState < 2 || !video.videoWidth) return;
      if (video.currentTime === lastTime) { report({ kind: 'unavailable' }); if (Date.now() - lastFresh > 5000) { lastFresh = Date.now(); reconnect(); } return; }
      lastTime = video.currentTime; lastFresh = Date.now(); busy = true;
      canvas.width = Math.min(640, video.videoWidth); canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async blob => { try { if (blob && !stopped) report({ kind: 'frame', bytes: await blob.arrayBuffer() }); } finally { busy = false; } }, 'image/jpeg', .85);
    }, 1000);
  }
}
if (window.atbPresenceCamera) void window.atbPresenceCamera.config().then(initialize);
else window.addEventListener('message', event => { if (event.source === parent && parent !== window && event.data?.kind === 'init') { parentOrigin = event.origin; initialize(event.data); } });
window.addEventListener('pagehide', () => { stopped = true; generation++; clearTimeout(retry); clearInterval(timer); socket?.close(); reset(); });
// The parent verifies this frame's exact origin and window before sending init.
parent.postMessage({ source: 'atb-presence-camera', kind: 'ready' }, '*');
