const $ = id => document.getElementById(id);

export function createViewerTalkback({ send }) {
  let sender = null, stream = null, live = false, pending = false, requested = false, speaking = false, busy = false, version = 0, timeout, requestId = null;
  function sync(message) {
    $('talkback').disabled = !live || !sender;
    $('talkback').textContent = pending ? '取消授权' : stream ? '结束说话' : '开始说话';
    $('talkback').setAttribute('aria-pressed', String(speaking)); $('talkback').classList.toggle('recording', speaking);
    $('talkback-status').textContent = message || (!live ? '连接摄像头后可向手机传话' : speaking ? '正在传话 · 手机正在接收你的声音' : requested ? '正在连接手机扬声器…' : pending ? '等待麦克风权限，可点击取消' : busy ? '其他观看端正在传话，请稍后再试' : '对讲已关闭 · 麦克风未采集');
  }
  function stop(message, notify = true) {
    version++; clearTimeout(timeout); pending = false;
    const release = requested || speaking, stoppedId = requestId; requested = false; speaking = false; requestId = null;
    stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); stream = null;
    void sender?.replaceTrack(null).catch(() => {});
    if (notify && release) send({ type: 'talkback-stop', requestId: stoppedId }); sync(message);
  }
  $('talkback').addEventListener('click', async () => {
    if (pending || stream) { stop(); return; }
    if (!live || !sender) return;
    if (busy) { sync(); return; }
    const attempt = ++version, target = sender; pending = true; sync();
    let captured;
    try {
      captured = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (attempt !== version || !live || sender !== target) { captured.getTracks().forEach(t => t.stop()); return; }
      if (!captured.getAudioTracks().length) throw Error('未检测到麦克风');
      stream = captured; pending = false; requested = true; requestId = crypto.randomUUID();
      stream.getAudioTracks()[0].onended = () => stop('麦克风被系统中断，对讲已结束');
      send({ type: 'talkback-start', requestId }); sync();
      timeout = setTimeout(() => stop('手机尚未响应，对讲已结束，请重试'), 5000);
    } catch (error) {
      captured?.getTracks().forEach(t => t.stop());
      if (attempt === version) stop(error.name === 'NotAllowedError' ? '麦克风权限未允许，视频继续' : `无法对讲：${error.message}`);
    }
  });
  return {
    setLive(value) { if (live === value) return; live = value; if (!value) { busy = false; stop(); } else sync(); },
    setSender(value) { if (sender === value) return; stop(); sender = value; sync(); },
    async handle(message) {
      if (message.type === 'error') { if (message.requestId && message.requestId !== requestId) return; busy = message.code === 'talkback-busy'; stop(busy ? '其他观看端正在传话，请稍后再试' : '摄像头已离线，对讲已结束', false); return; }
      busy = message.active && !message.source;
      if (message.source) {
        if (message.requestId !== requestId || !stream || !requested || !live || !sender) { send({ type: 'talkback-stop', requestId: message.requestId }); return; }
        clearTimeout(timeout); const attempt = version, target = sender;
        try { await target.replaceTrack(stream.getAudioTracks()[0]); if (version === attempt && sender === target) { speaking = true; sync(); } }
        catch { if (version === attempt) stop('声音连接中断，请重新开始对讲'); }
      } else if ((speaking && message.requestId === requestId) || (busy && requested)) stop(busy ? '其他观看端正在传话，请稍后再试' : undefined, false);
      else sync();
    },
    stop,
  };
}

export function createCameraTalkback() {
  let context = null, source = null, activeId = null;
  const streams = new Map();
  function sync() {
    $('enable-talkback-audio').hidden = !context || context.state === 'running';
    $('camera-talkback-status').textContent = !context ? '开始监控后可接收观看端传话' : context.state !== 'running' ? '请点击「开启对讲声音」允许手机播放' : !activeId ? '等待观看端传话' : source ? '正在播放观看端的声音' : '正在连接对讲声音…';
  }
  function route() {
    source?.disconnect(); source = null;
    const stream = streams.get(activeId)?.stream;
    if (context && stream && context.state !== 'closed') { source = context.createMediaStreamSource(stream); source.connect(context.destination); }
    sync();
  }
  async function resume() { try { await context?.resume(); } catch {} sync(); }
  $('enable-talkback-audio').addEventListener('click', () => { void resume(); });
  return {
    start() {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) { $('camera-talkback-status').textContent = '当前浏览器不支持对讲播放'; return; }
      context = new Audio(); context.onstatechange = sync; void resume();
    },
    receive(id, track) {
      if (track.kind !== 'audio') return;
      const previous = streams.get(id); if (previous) { previous.sink.pause(); previous.sink.srcObject = null; }
      const stream = new MediaStream([track]), sink = new Audio(); sink.muted = true; sink.srcObject = stream;
      // A media element activates WebRTC decoding when a Web Audio-only receiver stays idle.
      void sink.play().catch(() => {}); streams.set(id, { stream, sink }); if (activeId === id) route();
    },
    remove(id) { const item = streams.get(id); if (item) { item.sink.pause(); item.sink.srcObject = null; } streams.delete(id); if (activeId === id) { activeId = null; route(); } },
    handle(message) { activeId = message.active ? message.peerId : null; route(); },
    clearGrant() { activeId = null; route(); },
    stop() { activeId = null; source?.disconnect(); source = null; for (const item of streams.values()) { item.sink.pause(); item.sink.srcObject = null; } streams.clear(); const old = context; context = null; if (old) { old.onstatechange = null; void old.close().catch(() => {}); } sync(); },
  };
}
