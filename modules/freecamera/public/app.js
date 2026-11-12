import { cameraDesktop } from './desktop-bridge.js';
import { CameraPeers } from './camera-peer.js';
import { createViewerTools } from './viewer-tools.js';
import { createAccountPanel } from './account.js';
import { connectSignal } from './signal.js';
import { createCameraTalkback } from './talkback.js';
import { createCameraSettings } from './camera-settings.js';
import { createComputeProvider } from './compute-provider.js';
const $ = id => document.getElementById(id);
const cameraMode = new URLSearchParams(location.search).get('mode') === 'camera';
document.documentElement.classList.toggle('camera-mode', cameraMode);
const video = $('video'), canvas = document.createElement('canvas');
canvas.id = 'video-canvas'; canvas.hidden = true; canvas.setAttribute('aria-label', '实时摄像头画面'); video.after(canvas);
const context = canvas.getContext('2d', { alpha: false });
let stream = null, socket = null, peer = null, candidates = [], wakeLock = null, frameCallback = null;
let renderWatch = null, statsWatch = null, reconnectTimer = null, registrationTimer = null, mediaRetry = null, lastFrame = 0, lastTime = -1;
let active = false, subscribed = false, generation = 0, currentPeerId = null, rendered = 0, shuttingDown = false;
let reconnectDelay = 1000, microphoneVersion = 0, selectionVersion = 0;
let account = null;
const computeProvider = cameraMode ? null : createComputeProvider();
let computeDiscovery = null, computeDiscoveryEpoch = 0;
async function startComputeProvider() {
  const epoch = ++computeDiscoveryEpoch; clearTimeout(computeDiscovery);
  await networkConfiguration;
  if (epoch !== computeDiscoveryEpoch || shuttingDown || !account?.loggedIn || !cameraDesktop?.openCompute) return;
  if (serverConfiguration?.acceptsComputeProvider) computeProvider?.start();
  else if (!serverConfiguration) computeDiscovery = setTimeout(async () => {
    await refreshNetworkConfiguration();
    if (epoch === computeDiscoveryEpoch) await startComputeProvider();
  }, 2000);
}
async function stopComputeProvider() { computeDiscoveryEpoch++; clearTimeout(computeDiscovery); await computeProvider?.stop(); }
function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function save(key, value) { try { if (value !== null && value !== undefined) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch {} }
let remembered = load('freecamera.viewer'), identity = load('freecamera.camera');
$('auto-connect').checked = load('freecamera.auto') !== false;
$('microphone-toggle').checked = load('freecamera.microphone') !== false;
if (identity?.name) $('camera-name').value = identity.name;
function status(text, state = '') { $('status').textContent = text; $('status').dataset.state = state; }
function error(text) { $('error').hidden = !text; $('error').textContent = text || ''; }
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (message.type === 'detection-frame' && socket.bufferedAmount > 64 * 1024) return;
  socket.send(JSON.stringify(message));
}
function diagnostic(stage, detail) { $('connection-detail').textContent = `${stage} · ${detail}`; send({ type: 'diagnostic', stage, detail: String(detail) }); }
function alertStream(text) {
  $('stream-alert').hidden = !text; $('stream-alert').textContent = text || '';
  if (text && video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
}
const tools = cameraMode ? null : createViewerTools({ canvas, video, send, report: error });
const cameraTalkback = cameraMode ? createCameraTalkback() : null;
const cameraPeers = new CameraPeers({ send, diagnostic, configuration: () => networkConfiguration, state(value, count) {
  if (value === 'connected') status(`正在传输 · ${count} 位观看者`, 'live');
  else if (value === 'failed') status('观看端连接中断', 'error');
}, receiveAudio(id, track) { cameraTalkback?.receive(id, track); }, closed(id) { cameraTalkback?.remove(id); } });
const cameraSettings = cameraMode ? createCameraSettings({
  facing: $('facing'), quality: $('quality'), message: $('camera-settings-status'), getStream: () => active ? stream : null,
  replaceTrack: (track, target) => cameraPeers.replaceVideoTrack(track, target), previewChanged: () => { void video.play().catch(() => {}); }, report: error,
  interrupted(message) { stopCamera(); status('摄像头已停止', 'error'); error(message); },
}) : null;
for (const id of ['viewer-controls', 'detection-controls', 'media-tools', 'events-panel', 'setup-guide', 'camera-directory']) $(id).hidden = cameraMode;
$('view-workspace').hidden = !cameraMode;
$('camera-controls').hidden = !cameraMode; $(cameraMode ? 'camera-tab' : 'viewer-tab').classList.add('active');
if (cameraDesktop) {
  document.documentElement.classList.add('desktop'); $('app-kind').textContent = '桌面观看中心'; $('camera-tab').hidden = true;
  $('desktop-connection').hidden = false; $('service-address').textContent = `服务：${location.host}`;
  $('connection-settings').addEventListener('click', () => { void cameraDesktop.openConnectionSettings().catch(e => error(e.message)); });
}
if (cameraMode) {
  $('page-title').textContent = '换个角度，守望家里。'; $('subtitle').textContent = '架好手机，点击开始。已配对的观看端会自动连接。';
  $('empty-title').textContent = '摄像头准备就绪'; $('empty-description').textContent = '点击「开始监控」并允许摄像头权限。'; $('video-label').textContent = '本机预览';
}
let networkConfiguration;
let serverConfiguration;
function refreshNetworkConfiguration() { return networkConfiguration = (async () => {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/api/config', { signal: controller.signal });
    if (!response.ok) throw Error('Network settings unavailable');
    const config = await response.json(); serverConfiguration = config; $('setup-address').textContent = config.setupUrl;
    return { iceServers: config.iceServers || [], ...(config.iceTransportPolicy ? { iceTransportPolicy: config.iceTransportPolicy } : {}) };
  } catch { return { iceServers: [] }; }
  finally { clearTimeout(timer); }
})(); }
refreshNetworkConfiguration();

function viewerButtons(value) {
  subscribed = value; $('join').hidden = value; $('disconnect').hidden = !value; $('code').disabled = value;
  if (!value) $('detection-toggle').disabled = true;
  if (!value) $('retry').hidden = true;
}
function cameraButtons(value) {
  $('start').hidden = value; $('stop').hidden = !value;
  $('camera-name').disabled = value;
  $('pair-panel').hidden = !value;
}
function resetPeer() {
  clearTimeout(mediaRetry); mediaRetry = null;
  tools?.setLive(false);
  tools?.setTalkbackSender(null);
  if (peer) { peer.onconnectionstatechange = null; peer.onicecandidate = null; peer.ontrack = null; peer.close(); }
  peer = null; candidates = []; rendered = 0; lastTime = -1;
  clearInterval(renderWatch); clearInterval(statsWatch);
  if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback); frameCallback = null;
  if (!cameraMode) { video.srcObject = null; canvas.hidden = true; video.classList.remove('canvas-source'); $('placeholder').hidden = false; }
}
function disconnectSocket() { clearTimeout(registrationTimer); registrationTimer = null; const old = socket; socket = null; old?.close(); }
function stopCamera() {
  active = false; generation++; microphoneVersion++; clearTimeout(reconnectTimer); disconnectSocket(); cameraPeers.closeAll();
  cameraSettings?.stop();
    cameraTalkback?.stop(); stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); stream = null; video.srcObject = null;
  wakeLock?.release().catch(() => {}); wakeLock = null; cameraButtons(false); $('pair-code').textContent = ''; $('placeholder').hidden = false;
  $('microphone-toggle').disabled = false; $('microphone-status').textContent = '监控未启动，麦克风未采集。';
}
function hasMicrophone() { return !!stream?.getAudioTracks().some(track => track.readyState === 'live'); }
function cameraRequest() { return { type: 'create', ...identity, name: $('camera-name').value, microphone: hasMicrophone() }; }
async function changeMicrophone(enabled, reason) {
  const version = ++microphoneVersion, target = stream;
  if (!active || !target) return;
  const remove = () => { for (const track of target.getAudioTracks()) { track.onended = null; target.removeTrack(track); track.stop(); } };
  if (!enabled) {
    remove(); $('microphone-toggle').checked = false; $('microphone-toggle').disabled = false;
    $('microphone-status').textContent = reason || '麦克风已关闭，已停止采集。';
    send({ type: 'microphone-state', enabled: false });
    await cameraPeers.replaceAudioTrack(null); return;
  }
  $('microphone-toggle').disabled = true; $('microphone-status').textContent = '等待麦克风授权…';
  let captured;
  try {
    captured = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (version !== microphoneVersion || stream !== target || !active) { captured.getTracks().forEach(track => track.stop()); return; }
    const track = captured.getAudioTracks()[0];
    if (!track) throw Error('未检测到可用麦克风');
    target.addTrack(track);
    track.onended = () => { if (stream === target && active) void changeMicrophone(false, '麦克风被系统中断，请重新开启。').catch(error => diagnostic('麦克风', error.message)); };
    await cameraPeers.replaceAudioTrack(track);
    if (version !== microphoneVersion || stream !== target || !active) { target.removeTrack(track); track.onended = null; track.stop(); return; }
    $('microphone-toggle').checked = true; $('microphone-status').textContent = '正在收音 · 本机预览静音，避免回声。';
    send({ type: 'microphone-state', enabled: true });
  } catch (e) {
    captured?.getTracks().forEach(track => track.stop());
    if (version !== microphoneVersion || stream !== target || !active) return;
    remove(); await cameraPeers.replaceAudioTrack(null);
    $('microphone-toggle').checked = false; save('freecamera.microphone', false);
    $('microphone-status').textContent = e.name === 'NotAllowedError' ? '麦克风未获授权，视频继续。允许 Safari 麦克风权限后可重新开启。' : `收音不可用：${e.message}。视频继续。`;
    send({ type: 'microphone-state', enabled: false });
  } finally { if (version === microphoneVersion) $('microphone-toggle').disabled = false; }
}
$('microphone-toggle').addEventListener('change', () => {
  const enabled = $('microphone-toggle').checked; save('freecamera.microphone', enabled);
  if (active) void changeMicrophone(enabled).catch(e => error(`切换麦克风失败：${e.message}`));
});
function stopViewing() {
  selectionVersion++; account?.select(null);
  clearTimeout(reconnectTimer); disconnectSocket(); resetPeer(); viewerButtons(false); tools?.disconnected(); alertStream('');
  $('presence').textContent = '○ 已断开自动连接';
}
async function connectDevice(device) {
  if (!account?.loggedIn) return;
  stopViewing(); const version = selectionVersion; await tools.stopRecording();
  if (version !== selectionVersion || !account.loggedIn || shuttingDown) return;
  remembered = { deviceId: device.deviceId }; save('freecamera.viewer', remembered);
  account.select(device.deviceId); viewerButtons(true); error(''); $('device-name').textContent = device.name || '已选摄像头';
  status(device.online === false ? '等待摄像头上线' : '正在连接摄像头');
  openSocket({ type: 'watch', deviceId: device.deviceId });
}
async function restoreSelected() {
  if (remembered?.deviceId && $('auto-connect').checked) await connectDevice(remembered);
}
if (!cameraMode) account = createAccountPanel({
  async onLogin() { await startComputeProvider(); await restoreSelected(); },
  async onLogout() { await stopComputeProvider(); stopViewing(); await tools.stopRecording(); error(''); status('请登录观看账户'); },
  onSelect: connectDevice, report: error,
});
async function acquireWakeLock() {
  if (!active || document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
  try {
    if (!navigator.wakeLock) throw Error(); wakeLock = await navigator.wakeLock.request('screen');
    if (!active) { await wakeLock.release(); wakeLock = null; return; }
    $('wake-status').textContent = '已请求屏幕常亮。请保持页面前台运行。';
  } catch { $('wake-status').textContent = '请将系统自动锁定设为「永不」，并保持本页前台。'; }
}
function wakeConnection() {
  if (shuttingDown || document.visibilityState === 'hidden') return;
  if (cameraMode && active) void acquireWakeLock();
  if ((!socket || socket.readyState === WebSocket.CLOSED) && (cameraMode ? active : subscribed)) scheduleReconnect(0);
}
window.addEventListener('online', wakeConnection);
document.addEventListener('visibilitychange', wakeConnection);
function scheduleReconnect(delay = reconnectDelay) {
  if (shuttingDown || (cameraMode ? !active : !account?.loggedIn || !remembered || !$('auto-connect').checked || !subscribed)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (shuttingDown || (cameraMode ? !active : !subscribed || !account?.loggedIn || !$('auto-connect').checked)) return;
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    openSocket(cameraMode ? cameraRequest() : { type: 'watch', ...remembered });
  }, delay);
}
function connectionLost(ws, event = {}) {
  if (socket !== ws) return;
  disconnectSocket();
  if (!cameraMode && event.code === 4001) { stopViewing(); void account.expired(); return; }
  if (cameraMode) { cameraTalkback.clearGrant(); cameraPeers.closeAll(); } else { resetPeer(); tools?.disconnected(); }
  status('服务连接已断开，等待恢复', 'error'); scheduleReconnect();
}
function openSocket(initial) {
  disconnectSocket(); let queue = Promise.resolve();
  socket = connectSignal({
    onOpen(ws) {
      if (socket !== ws) return;
      refreshNetworkConfiguration();
      // Heartbeats only prove the transport is alive; the camera/watch registration must also finish.
      registrationTimer = setTimeout(() => connectionLost(ws), 25000);
      send(initial);
    },
    onMessage(ws, event) {
      queue = queue.then(async () => { if (socket === ws) await handle(JSON.parse(event.data), ws); }).catch(e => {
      if (socket !== ws) return; diagnostic('协商错误', e.message); error(`视频连接失败：${e.message}`); status('连接失败', 'error');
      if (!cameraMode) { $('retry').hidden = false; scheduleMediaRecovery(); }
      });
    },
    onError(ws) { if (socket === ws) error('无法连接电脑服务，正在等待网络恢复。'); },
    onClose: connectionLost,
  });
}
function scheduleMediaRecovery(delay = 3000) {
  if (mediaRetry !== null || shuttingDown || !subscribed || !$('auto-connect').checked || !account?.loggedIn) return;
  const expectedPeer = peer, expectedSocket = socket;
  mediaRetry = setTimeout(async () => {
    mediaRetry = null;
    if (shuttingDown || !subscribed || !$('auto-connect').checked || peer !== expectedPeer || socket !== expectedSocket || !account.loggedIn) return;
    await tools.stopRecording();
    if (peer !== expectedPeer || socket !== expectedSocket || !subscribed || shuttingDown || !$('auto-connect').checked) return;
    resetPeer(); status('正在自动恢复画面'); alertStream('连接已中断，正在自动重连…');
    if (socket?.readyState === WebSocket.OPEN) { send({ type: 'restart' }); scheduleMediaRecovery(8000); }
    else scheduleReconnect(0);
  }, delay);
}
function render() {
  if (!peer || video.readyState < 2 || !video.videoWidth) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
  context.drawImage(video, 0, 0, canvas.width, canvas.height); tools.drawBoxes(context, canvas.width, canvas.height);
  canvas.hidden = false; video.classList.add('canvas-source');
  if (++rendered === 1) diagnostic('画面绘制', `${canvas.width}×${canvas.height}`);
}
function watchFrames(current) {
  lastFrame = Date.now(); let received = false, route = '正在确认连接方式';
  const frame = () => { if (peer !== current) return; render(); received = true; lastFrame = Date.now(); frameCallback = video.requestVideoFrameCallback(frame); };
  if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(frame);
  renderWatch = setInterval(() => {
    if (peer !== current) return;
    render();
    if (!video.requestVideoFrameCallback && video.readyState >= 2 && lastTime !== video.currentTime) { lastTime = video.currentTime; received = true; lastFrame = Date.now(); }
    if (received && Date.now() - lastFrame > 5000) { status('画面已中断', 'error'); alertStream('未收到新画面，正在自动恢复连接。'); $('retry').hidden = false; tools.setLive(false); scheduleMediaRecovery(); }
    else if (received && current.connectionState === 'connected') {
      clearTimeout(mediaRetry); mediaRetry = null; status('实时画面', 'live'); alertStream(''); $('retry').hidden = true; tools.setLive(true);
      $('stream-info').textContent = `${video.videoWidth} × ${video.videoHeight} · ${tools.hasAudio() ? '收音已开启' : '手机麦克风关闭'} · ${route}`;
    }
  }, 100);
  let samples = 0;
  statsWatch = setInterval(async () => {
    if (peer !== current || samples++ >= 18) { clearInterval(statsWatch); return; }
    try {
      const reports = await current.getStats();
      const transport = [...reports.values()].find(r => r.type === 'transport' && r.selectedCandidatePairId);
      const pair = reports.get(transport?.selectedCandidatePairId);
      if (pair) {
        const candidates = [reports.get(pair.localCandidateId), reports.get(pair.remoteCandidateId)];
        const next = candidates.some(candidate => candidate?.candidateType === 'relay') ? '经电脑转发' : '实时直连';
        if (next !== route) { route = next; diagnostic('视频路径', route); }
      }
      reports.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') diagnostic('媒体统计', JSON.stringify({ bytes: r.bytesReceived, frames: r.framesDecoded, codec: reports.get(r.codecId)?.mimeType })); });
    } catch {}
  }, 5000);
}
async function receiveOffer(m, sourceSocket) {
  await tools.stopRecording();
  const configuration = await networkConfiguration;
  if (socket !== sourceSocket || !subscribed) return;
  resetPeer(); currentPeerId = m.peerId;
  const pc = new RTCPeerConnection(configuration); peer = pc;
  scheduleMediaRecovery(25000);
  pc.onicecandidate = e => { if (peer === pc && e.candidate) send({ type: 'candidate', peerId: currentPeerId, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return; diagnostic('视频连接', pc.connectionState);
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) { tools.setLive(false); status('画面连接中断', 'error'); alertStream('视频连接中断，正在自动恢复。'); $('retry').hidden = false; scheduleMediaRecovery(); }
  };
  pc.ontrack = event => {
    if (peer !== pc) return;
    if (!video.srcObject) video.srcObject = new MediaStream();
    for (const track of event.streams[0]?.getTracks() || [event.track]) if (!video.srcObject.getTracks().includes(track)) video.srcObject.addTrack(track);
    tools.mediaChanged();
    if (event.track.kind !== 'video') return;
    $('placeholder').hidden = true; alertStream('正在接收画面…');
    video.play().catch(() => { tools.playbackBlocked(); void video.play().catch(() => error('请点击视频画面开始播放。')); }); watchFrames(pc);
  };
  await pc.setRemoteDescription(m.sdp);
  if (peer !== pc || socket !== sourceSocket) return;
  const audio = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio');
  if (audio) { audio.direction = 'sendrecv'; tools.setTalkbackSender(audio.sender); }
  for (const c of candidates.splice(0)) await pc.addIceCandidate(c);
  const answer = await pc.createAnswer();
  if (peer !== pc || socket !== sourceSocket) return;
  await pc.setLocalDescription(answer);
  if (peer === pc && socket === sourceSocket) send({ type: 'answer', peerId: currentPeerId, sdp: pc.localDescription });
}
async function handle(m, sourceSocket) {
  if (['created', 'watching', 'joined'].includes(m.type)) { clearTimeout(registrationTimer); registrationTimer = null; }
  if (m.configuration?.iceServers && ['created', 'watching', 'joined'].includes(m.type)) networkConfiguration = Promise.resolve(m.configuration);
  if (m.type === 'talkback-state' && cameraMode) { cameraTalkback.handle(m); return; }
  if (m.type.startsWith('detection-') || ['person-event', 'microphone-state', 'talkback-state'].includes(m.type)) { await tools?.handle(m); return; }
  if (m.type === 'created') {
    reconnectDelay = 1000;
    identity = { deviceId: m.deviceId, cameraKey: m.cameraKey, name: m.name }; save('freecamera.camera', identity);
    // Enrollment is complete: future reconnects use the saved device key, independent of login expiry.
    if (cameraMode && account) { account.dispose(); account = null; $('account-bar').hidden = true; }
    $('pair-code').textContent = m.code; status('等待观看端连接'); error('');
  } else if (m.type === 'watching' || m.type === 'joined') {
    reconnectDelay = 1000;
    remembered = { deviceId: m.deviceId }; save('freecamera.viewer', remembered); viewerButtons(true); account.select(m.deviceId);
    $('device-name').textContent = m.name || '已配对摄像头'; $('presence').textContent = m.online ? '● 摄像头在线' : '○ 摄像头离线 · 自动等待';
    status(m.online ? '正在建立视频连接' : '等待摄像头上线'); error('');
  } else if (m.type === 'presence') {
    $('presence').textContent = m.online ? '● 摄像头在线' : '○ 摄像头离线 · 自动等待';
  } else if (m.type === 'peer-ready' && cameraMode && stream) {
    await cameraPeers.offer(m.peerId, stream);
  } else if (m.type === 'peer-left' && cameraMode) {
    cameraPeers.close(m.peerId); if (!cameraPeers.peers.size) status('等待观看端连接');
  } else if (m.type === 'offer' && !cameraMode) await receiveOffer(m, sourceSocket);
  else if (m.type === 'answer' && cameraMode) await cameraPeers.answer(m.peerId, m.sdp);
  else if (m.type === 'candidate') {
    if (cameraMode) await cameraPeers.candidate(m.peerId, m.candidate);
    else if (peer?.remoteDescription) await peer.addIceCandidate(m.candidate);
    else if (candidates.length < 100) candidates.push(m.candidate);
  } else if (m.type === 'camera-left') {
    resetPeer(); status('摄像头已停止', 'error'); alertStream('摄像头已离线，重新上线后会自动连接。');
  } else if (m.type === 'error') {
    if (!cameraMode && ['talkback-busy', 'camera-offline'].includes(m.code)) { await tools.handle(m); return; }
    if (m.code === 'login-required') {
      if (cameraMode) { stopCamera(); await cameraAccount(); }
      else { stopViewing(); await account.expired(); }
      return;
    }
    const messages = { 'invalid-code': '请输入 8 位数字配对码。', 'not-found': '配对码无效或摄像头已离线。', 'unauthorized': '设备凭据已失效，请重新配对。', 'room-full': '当前摄像头观看人数已满。', 'camera-in-use': '此摄像头已在另一个页面运行。', 'rate-limited': '配对尝试过多，请一分钟后重试。', 'detection-failed': '检测启动或推理失败，请查看检测状态。' };
    error(messages[m.code] || `请求失败：${m.code}`);
    if (m.code === 'unauthorized') {
      if (cameraMode) { identity = null; save('freecamera.camera', null); stopCamera(); }
      else { remembered = null; save('freecamera.viewer', null); stopViewing(); }
    } else if (!cameraMode && m.code === 'room-full' && subscribed) {
      disconnectSocket(); resetPeer(); status('连接名额暂未释放，正在自动重试'); scheduleReconnect(3000);
    } else if (!cameraMode && !subscribed) { $('join').disabled = false; status('未连接', 'error'); }
    else if (cameraMode && m.code === 'camera-in-use') {
      disconnectSocket(); cameraPeers.closeAll(); status('等待旧连接释放，正在自动重连'); scheduleReconnect();
    }
  }
}
$('start').addEventListener('click', async () => {
  stopCamera(); error(''); const task = generation; $('start').disabled = true; status('等待摄像头授权');
  cameraTalkback.start();
  try {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('请使用已信任证书的 HTTPS 地址，在 Safari 中打开摄像头页。');
    const settings = cameraSettings.read();
    const captured = await navigator.mediaDevices.getUserMedia({ audio: false, video: cameraSettings.constraints(settings) });
    if (task !== generation) { captured.getTracks().forEach(t => t.stop()); return; }
    stream = captured; active = true; cameraSettings.start(stream, settings); cameraButtons(true); video.srcObject = stream; $('placeholder').hidden = true; await video.play();
    if ($('microphone-toggle').checked) await changeMicrophone(true);
    else $('microphone-status').textContent = '麦克风已关闭，未采集声音。';
    if (task !== generation || !active) return;
    void acquireWakeLock(); openSocket(cameraRequest());
  } catch (e) { stopCamera(); status('无法启动摄像头', 'error'); error(e.name === 'NotAllowedError' ? '请允许摄像头权限，并检查证书已完全信任。' : e.message); }
  finally { $('start').disabled = false; }
});
$('stop').addEventListener('click', () => { stopCamera(); status('监控已停止'); error(''); });
$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); const code = $('code').value.trim(); if (!/^\d{8}$/.test(code)) { error('请输入 8 位数字配对码。'); return; }
  if (!account?.loggedIn) return;
  stopViewing(); const version = selectionVersion; await tools.stopRecording();
  if (version !== selectionVersion || !account.loggedIn || shuttingDown) return;
  error(''); $('join').disabled = false; status('正在连接摄像头'); openSocket({ type: 'join', code });
});
$('disconnect').addEventListener('click', () => { stopViewing(); status('已断开连接'); error(''); });
$('auto-connect').addEventListener('change', () => {
  const enabled = $('auto-connect').checked; save('freecamera.auto', enabled);
  if (!enabled) { clearTimeout(reconnectTimer); clearTimeout(mediaRetry); mediaRetry = null; }
  else if (subscribed) {
    if (!socket || socket.readyState === WebSocket.CLOSED) scheduleReconnect(0);
    else if (!peer || peer.connectionState !== 'connected' || Date.now() - lastFrame > 5000) scheduleMediaRecovery(0);
  }
});
$('retry').addEventListener('click', () => { if (!subscribed) return; resetPeer(); status('正在重新连接'); alertStream('正在重新连接…'); send({ type: 'restart' }); });
$('fullscreen').addEventListener('click', () => { video.parentElement.requestFullscreen?.().catch(e => error(e.message)); });
video.addEventListener('click', () => { if (video.srcObject) void video.play(); });
window.addEventListener('pagehide', () => { shuttingDown = true; clearTimeout(reconnectTimer); account?.dispose(); void stopComputeProvider(); if (cameraMode) stopCamera(); else { void tools.dispose(); disconnectSocket(); resetPeer(); } });
window.atbPrepareClose = window.freecameraPrepareClose = async () => {
  shuttingDown = true; clearTimeout(reconnectTimer); account?.dispose();
  await stopComputeProvider();
  if (cameraMode) stopCamera(); else { await tools.dispose(); disconnectSocket(); resetPeer(); }
};
let internalNavigation = null;
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('a[href]');
  if (!link || link.hasAttribute('download') || link.target && !['_self', '_top', '_parent'].includes(link.target.toLowerCase())) return;
  const destination = new URL(link.href, location.href);
  if (destination.origin !== location.origin || !['http:', 'https:'].includes(destination.protocol)) return;
  if (destination.pathname === location.pathname && destination.search === location.search && link.getAttribute('href').includes('#')) return;
  event.preventDefault();
  if (internalNavigation) return;
  internalNavigation = (async () => {
    try { await window.atbPrepareClose(); location.assign(destination.href); }
    catch (cause) { internalNavigation = null; error(`无法离开页面：${cause.message}`); }
  })();
});
async function cameraAccount() {
  account ??= createAccountPanel({ camera: true, onLogin: async () => {}, onLogout: async () => { stopCamera(); }, report: error });
  await account.start();
}
if (cameraMode) {
  await networkConfiguration;
  if (serverConfiguration?.requireCameraLogin && !identity?.deviceId) await cameraAccount();
} else if (await account.start()) { await startComputeProvider(); await restoreSelected(); }
