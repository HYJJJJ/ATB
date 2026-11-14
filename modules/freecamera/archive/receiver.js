// Runs only inside the service-owned browser. The credential never enters a URL or log.
export async function installReceiver(options) {
  const { origin, credential, device, milliseconds = 3600000, localTurn } = options;
  let ws, pc, configuration = {}, candidates = [], reconnect, heartbeat, retry, stopped = false;
  let stream, recorder, segment, rotation, startTimer, composition, resizing = false, chain = Promise.resolve(), control = Promise.resolve();
  let lastPong = Date.now(), lastMedia = Date.now(), lastFrames = -1, watchdog;
  let microphone = null, audioState = 'waiting', audioBytes = 0, lastEnergy = 0;
  const send = message => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const event = data => { chain = chain.then(() => window.atbArchive(data)); return chain; };
  const status = value => window.atbArchiveStatus?.(value).catch(() => {});
  async function stopSegment(end) {
    clearTimeout(rotation); clearTimeout(startTimer);
    if (recorder && recorder.state !== 'inactive') {
      const active = recorder; active.archiveEnd = end;
      await new Promise(resolve => { active.addEventListener('stop', resolve, { once: true }); active.stop(); });
    }
    await chain;
  }
  function connectAudio() {
    if (!composition) return;
    for (const track of stream?.getAudioTracks() || []) {
      if (composition.sources.has(track.id) || track.readyState !== 'live') continue;
      const source = composition.audio.createMediaStreamSource(new MediaStream([track]));
      source.connect(composition.destination); composition.sources.set(track.id, source);
    }
  }
  async function compose() {
    if (composition) return composition.output;
    const video = document.querySelector('video'), canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { alpha: false }), audio = new AudioContext();
    const destination = audio.createMediaStreamDestination(); destination.channelCount = 1;
    await audio.resume();
    const captured = canvas.captureStream(15), output = new MediaStream([...captured.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const item = composition = { canvas, audio, destination, output, sources: new Map(), timer: null };
    connectAudio();
    const draw = () => {
      if (composition !== item) return;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          if (!resizing) {
            resizing = true;
            // Finish the old dimensions before changing the canvas/encoder size.
            control = control.then(async () => {
              await stopSegment(); if (composition !== item || stopped) return;
              canvas.width = video.videoWidth; canvas.height = video.videoHeight;
              clearTimeout(item.timer); resizing = false; draw(); await record();
            }).catch(failed).finally(() => { resizing = false; });
          }
        } else {
          // drawImage uses the browser's CVO-corrected presentation. Record these pixels,
          // so players that ignore WebM rotation metadata still show an upright picture.
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = new Date(Date.now() + 28800000).toISOString().slice(0, 19).replace('T', ' ');
          const size = Math.max(14, Math.min(32, Math.round(canvas.width / 36))), margin = Math.max(8, Math.round(size / 2));
          context.font = `600 ${size}px monospace`; context.textBaseline = 'top';
          context.fillStyle = 'rgba(0,0,0,0.6)'; context.fillRect(margin, margin, context.measureText(text).width + margin * 2, size + margin * 2);
          context.fillStyle = '#fff'; context.fillText(text, margin * 2, margin * 2);
        }
      }
      item.timer = setTimeout(draw, 1000 / 15);
    };
    draw(); return output;
  }
  async function record(scheduledStart) {
    if (stopped || !stream?.getVideoTracks().some(t => t.readyState === 'live') || recorder?.state === 'recording') return;
    const video = document.querySelector('video');
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      clearTimeout(startTimer); startTimer = setTimeout(() => { control = control.then(record).catch(failed); }, 100); return;
    }
    const output = await compose();
    let selected;
    for (const mime of ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(mime)) { selected = mime; break; }
    if (!selected) throw Error('unsupported-recorder');
    const capturedAt = Date.now();
    // Keep normal adjacent files on the exact hour while retaining real capture timing.
    // A delayed recovery must not claim footage from an extended gap.
    const start = Number.isFinite(scheduledStart) && capturedAt - scheduledStart < 5000 ? scheduledStart : capturedAt;
    segment = await event({ type: 'begin', start, capturedAt });
    if (stopped || !stream) { await event({ type: 'empty', id: segment }); return; }
    const id = segment, active = new MediaRecorder(output, { mimeType: selected, videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 });
    recorder = active;
    active.ondataavailable = e => {
      if (!e.data.size) return;
      const blob = e.data;
      chain = chain.then(async () => {
        const buffer = new Uint8Array(await blob.arrayBuffer()); let binary = '';
        for (let i = 0; i < buffer.length; i += 32768) binary += String.fromCharCode(...buffer.subarray(i, i + 32768));
        await window.atbArchive({ type: 'chunk', id, time: Date.now(), bytes: btoa(binary) });
      });
      void chain.catch(failed);
    };
    active.onstop = () => { void event({ type: 'finish', id, end: active.archiveEnd ?? Date.now() }).catch(() => status('segment-failed')); };
    active.onerror = () => { status('recorder-error'); };
    active.start(1000); status('recording');
    const now = Date.now(), nextHour = Math.floor((now + 28800000) / 3600000 + 1) * 3600000 - 28800000;
    const boundary = Math.min(now + milliseconds, nextHour);
    rotation = setTimeout(() => { control = control.then(async () => { await stopSegment(boundary); if (!stopped) await record(boundary); }).catch(failed); }, boundary - now);
  }
  function failed() {
    status('recording-paused');
    if (recorder?.state === 'recording') recorder.stop();
    clearTimeout(rotation); clearTimeout(retry);
    // Reset the bridge queue after a disk/upload-independent recording failure; retain every partial file.
    chain = chain.catch(() => {});
    retry = setTimeout(() => { control = control.catch(() => {}).then(reset).then(() => send({ type: 'restart' })).catch(() => {}); }, 10000);
  }
  async function reset() {
    clearTimeout(rotation); clearTimeout(startTimer);
    try { await stopSegment(); } catch { chain = chain.catch(() => {}); }
    const item = composition; composition = null;
    if (item) { clearTimeout(item.timer); for (const source of item.sources.values()) source.disconnect(); item.output.getTracks().forEach(t => t.stop()); await item.audio.close().catch(() => {}); }
    pc?.close(); pc = null; stream?.getTracks().forEach(t => t.stop()); stream = null; candidates = []; lastFrames = -1;
    document.querySelector('video').srcObject = null; audioBytes = 0; lastEnergy = 0; audioState = 'waiting'; resizing = false;
  }
  async function message(m) {
    if (m.type === 'watching' || m.type === 'joined') { if (m.configuration) configuration = m.configuration; return; }
    if (m.type === 'pong') { lastPong = Date.now(); return; }
    if (m.type === 'microphone-state') { microphone = m.enabled === true; if (!microphone) audioState = 'microphone-off'; return; }
    if (m.type === 'camera-left') { await reset(); status('camera-offline'); return; }
    if (m.type === 'error') { status(`signal-${m.code}`); return; }
    if (m.type === 'offer') {
      await reset();
      const iceServers = configuration.iceServers?.map(s => localTurn && String(s.urls).includes('turn:') ? { ...s, urls: localTurn } : s) || [];
      pc = new RTCPeerConnection({ ...configuration, iceServers }); stream = new MediaStream(); lastMedia = Date.now();
      const peer = pc;
      peer.onicecandidate = e => { if (e.candidate) send({ type: 'candidate', candidate: e.candidate }); };
      peer.ontrack = e => {
        if (pc !== peer) return;
        for (const track of e.streams[0]?.getTracks() || [e.track]) if (!stream.getTrackById(track.id)) stream.addTrack(track);
        connectAudio();
        if (e.track.kind === 'video') {
          const video = document.querySelector('video'); video.srcObject = stream; void video.play().catch(() => {});
          clearTimeout(startTimer); startTimer = setTimeout(() => { control = control.then(record).catch(failed); }, 300);
        }
      };
      peer.onconnectionstatechange = () => { status(`peer-${peer.connectionState}`); if (peer.connectionState === 'failed') send({ type: 'restart' }); };
      await peer.setRemoteDescription(m.sdp); for (const candidate of candidates) await peer.addIceCandidate(candidate); candidates = [];
      await peer.setLocalDescription(await peer.createAnswer()); send({ type: 'answer', sdp: peer.localDescription }); return;
    }
    if (m.type === 'candidate') { if (pc?.remoteDescription) await pc.addIceCandidate(m.candidate); else candidates.push(m.candidate); }
  }
  function connect() {
    if (stopped) return;
    ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/signal`, ['atb-archive', credential]);
    ws.onopen = () => { lastPong = Date.now(); send({ type: 'watch', deviceId: device.deviceId, detectionFrames: false }); };
    ws.onmessage = e => { control = control.then(() => message(JSON.parse(e.data))).catch(failed); };
    ws.onerror = () => {};
    ws.onclose = () => {
      control = control.catch(() => {}).then(reset); status('waiting-for-service');
      clearTimeout(reconnect); if (!stopped) reconnect = setTimeout(connect, 3000);
    };
  }
  heartbeat = setInterval(() => { if (Date.now() - lastPong > 12000) ws?.close(); else send({ type: 'ping' }); }, 3000);
  let checking = false;
  watchdog = setInterval(async () => {
    if (!pc || checking) return; checking = true;
    try {
      const stats = await pc.getStats(); let frames = 0;
      stats.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') frames += s.framesDecoded || 0;
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          audioBytes = s.bytesReceived || 0;
          audioState = microphone === false ? 'microphone-off' : s.totalAudioEnergy > lastEnergy ? 'receiving' : 'quiet';
          lastEnergy = s.totalAudioEnergy || 0;
        }
      });
      if (frames > lastFrames) { lastFrames = frames; lastMedia = Date.now(); }
      if (Date.now() - lastMedia > 15000) { lastMedia = Date.now(); control = control.then(reset).then(() => send({ type: 'restart' })).catch(failed); }
    } catch {} finally { checking = false; }
  }, 3000);
  // Service-only metadata: no images, raw samples, device labels or credentials.
  window.atbArchiveInspect = () => ({ width: composition?.canvas.width || 0, height: composition?.canvas.height || 0, timestamp: !!composition, microphone, audioState, audioBytes });
  window.atbArchiveStop = async () => { stopped = true; clearInterval(heartbeat); clearInterval(watchdog); clearTimeout(reconnect); clearTimeout(retry); await control.catch(() => {}); await reset(); ws?.close(); await chain; };
  connect(); return true;
}
