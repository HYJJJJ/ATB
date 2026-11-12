import { cameraDesktop } from './desktop-bridge.js';
import { createViewerTalkback } from './talkback.js';
const $ = id => document.getElementById(id);
const native = cameraDesktop;
function filename(prefix, ext) { return `${prefix}-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, '')}.${ext}`; }
function blobOf(canvas) { return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('截图失败')), 'image/png')); }
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function createViewerTools({ canvas, video, send, report }) {
  let preferences;
  try { preferences = JSON.parse(localStorage.getItem('freecamera.viewer-tools')); } catch {}
  preferences = preferences && typeof preferences === 'object' ? preferences : {};
  $('volume').value = Number.isFinite(preferences.volume) ? Math.max(0, Math.min(100, preferences.volume)) : 80;
  $('notifications').checked = typeof preferences.notifications === 'boolean' ? preferences.notifications : !!native;
  function savePreferences() {
    try { localStorage.setItem('freecamera.viewer-tools', JSON.stringify({ listening, volume: Number($('volume').value), notifications: $('notifications').checked })); } catch {}
  }
  const talkback = createViewerTalkback({ send });
  let live = false, recorder = null, recordingStream = null, finishing = null, startingRecord = false, recordStarted = 0, clock = null;
  let state = { status: 'off', source: false }, boxes = [], boxTime = 0, sampleBusy = false, microphone = false, listening = preferences.listening === true, autoplayBlocked = false;
  const sample = document.createElement('canvas'), sampleContext = sample.getContext('2d');
  function info(text) { $('capture-info').textContent = text; }
  function hasAudio() { return microphone && !!video.srcObject?.getAudioTracks().some(track => track.readyState === 'live'); }
  function syncSound() {
    const available = live && hasAudio();
    $('listen').disabled = !available; $('volume').disabled = !available;
    video.volume = Number($('volume').value) / 100; video.muted = !available || !listening || video.volume === 0 || autoplayBlocked;
    $('listen').textContent = autoplayBlocked ? '点击恢复声音' : listening ? '静音' : '开启声音'; $('listen').setAttribute('aria-pressed', String(!video.muted));
    $('audio-status').textContent = !live ? '等待摄像头收音' : !microphone ? '手机麦克风已关闭' : !hasAudio() ? '正在连接声音…' : video.muted ? '正在收音 · 本机静音' : '正在收听手机声音';
  }
  $('listen').addEventListener('click', async () => {
    listening = autoplayBlocked ? true : !listening; autoplayBlocked = false; savePreferences(); syncSound();
    if (listening) try { await video.play(); }
    catch { autoplayBlocked = true; syncSound(); report('浏览器未允许播放声音，请再次点击声音按钮。'); }
  });
  $('volume').addEventListener('input', () => { savePreferences(); syncSound(); });
  function playbackBlocked() {
    if (!listening) return;
    autoplayBlocked = true; syncSound(); report('收听设置已恢复，请点击声音按钮允许播放。');
    void video.play().catch(() => {});
  }
  function setLive(value) {
    const resumed = value && !live;
    talkback.setLive(value);
    live = value; $('snapshot').disabled = !value; $('record').disabled = !value || !!finishing || startingRecord;
    syncSound();
    if (resumed && listening && hasAudio()) void video.play().catch(playbackBlocked);
    if (!value) { boxes = []; if (recorder?.state === 'recording') void stopRecording('画面中断，录像已结束'); }
  }
  function drawBoxes(ctx, width, height) {
    if (state.status !== 'on' || Date.now() - boxTime > 2000) return;
    ctx.lineWidth = Math.max(2, width / 400); ctx.font = `${Math.max(14, width / 45)}px sans-serif`;
    for (const b of boxes) {
      ctx.strokeStyle = '#c4e990'; ctx.fillStyle = '#c4e990';
      ctx.strokeRect(b.x * width, b.y * height, b.width * width, b.height * height);
      const text = `人物 ${Math.round(b.score * 100)}%`; const y = Math.max(24, b.y * height);
      ctx.fillText(text, b.x * width + 4, y - 5);
    }
  }
  $('snapshot').addEventListener('click', async () => {
    if (!live) return;
    try {
      const blob = await blobOf(canvas);
      if (native) { const result = await native.saveSnapshot({ data: new Uint8Array(await blob.arrayBuffer()) }); if (!result.canceled) info(`截图已保存：${result.path}`); }
      else { download(blob, filename('FreeCamera', 'png')); info('截图已保存为 PNG'); }
    } catch (e) { report(e.message); }
  });
  async function startRecording() {
    if (!live || recorder || finishing || startingRecord) return;
    let target = null, file = null;
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(t => window.MediaRecorder?.isTypeSupported(t));
    if (!mimeType || !canvas.captureStream) { report('当前浏览器不支持录像，请使用新版 Edge 或桌面端。'); return; }
    startingRecord = true; $('record').disabled = true;
    try {
      if (native) { target = await native.beginRecording({ mimeType }); if (target.canceled) return; }
      else if (window.showSaveFilePicker) {
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const handle = await window.showSaveFilePicker({ suggestedName: filename('FreeCamera', ext), types: [{ description: '监控录像', accept: { [mimeType.split(';')[0]]: [`.${ext}`] } }] });
        file = await handle.createWritable();
      }
      if (!live) { if (target?.id) await native.endRecording({ id: target.id }); await file?.close(); return; }
      recordingStream = canvas.captureStream(15);
      for (const track of video.srcObject?.getAudioTracks() || []) if (track.readyState === 'live') recordingStream.addTrack(track.clone());
      const current = new MediaRecorder(recordingStream, { mimeType, videoBitsPerSecond: 2500000, audioBitsPerSecond: 96000 }); recorder = current;
      let writes = Promise.resolve(), chunks = [], bytes = 0, pendingBytes = 0, writeError = null, finishResolve;
      const complete = new Promise(r => { finishResolve = r; }); current.completion = complete;
      current.ondataavailable = event => {
        if (!event.data.size) return;
        pendingBytes += event.data.size;
        if (pendingBytes > 32 * 1024 * 1024 && current.state === 'recording') { report('磁盘写入过慢，已停止录像以限制内存占用。'); current.stop(); }
        writes = writes.then(async () => {
          if (writeError) return;
          if (native) {
            const data = new Uint8Array(await event.data.arrayBuffer());
            for (let offset = 0; offset < data.length; offset += 4 * 1024 * 1024) await native.writeRecording({ id: target.id, data: data.slice(offset, offset + 4 * 1024 * 1024) });
          } else if (file) await file.write(event.data);
          else { chunks.push(event.data); bytes += event.data.size; if (bytes >= 256 * 1024 * 1024 && current.state === 'recording') { info('达到浏览器内存录像上限，已停止并保存。'); current.stop(); } }
        }).catch(e => { writeError = e; report(`录像写入失败：${e.message}`); if (current.state === 'recording') current.stop(); })
          .finally(() => { pendingBytes -= event.data.size; });
      };
      current.onerror = e => { report(`录像失败：${e.error?.message || '编码器错误'}`); if (current.state === 'recording') current.stop(); };
      current.onstop = async () => {
        clearInterval(clock); finishing = complete; $('record').disabled = true;
        try {
          await writes;
          if (native) { const result = await native.endRecording({ id: target.id }); if (!writeError) info(`录像已保存：${result.path}`); }
          else if (file) { await file.close(); if (!writeError) info('录像已保存到所选位置'); }
          else if (chunks.length) { download(new Blob(chunks, { type: mimeType }), filename('FreeCamera', mimeType.includes('mp4') ? 'mp4' : 'webm')); info('录像已下载'); }
        } catch (e) { report(`结束录像失败：${e.message}`); }
        finally {
          chunks = []; recordingStream?.getTracks().forEach(t => t.stop()); recordingStream = null; recorder = null; finishing = null;
          $('record').textContent = '开始录像'; $('record').classList.remove('recording'); $('record').disabled = !live; finishResolve();
        }
      };
      current.start(1000); recordStarted = Date.now(); $('record').textContent = '停止录像'; $('record').classList.add('recording');
      clock = setInterval(() => { const sec = Math.floor((Date.now() - recordStarted) / 1000); info(`正在录像 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`); }, 1000);
      info('正在录像 0:00');
    } catch (e) { recordingStream?.getTracks().forEach(track => track.stop()); recordingStream = null; recorder = null; if (e.name !== 'AbortError') report(`无法开始录像：${e.message}`); if (target?.id) await native.endRecording({ id: target.id }).catch(() => {}); await file?.close().catch(() => {}); }
    finally { startingRecord = false; $('record').disabled = !live || !!finishing; }
  }
  async function stopRecording(reason) {
    const current = recorder; if (!current) return finishing;
    if (reason) info(reason);
    if (current.state === 'recording') current.stop();
    return current.completion;
  }
  $('record').addEventListener('click', () => { if (recorder) void stopRecording(); else void startRecording(); });
  $('detection-toggle').addEventListener('change', () => {
    $('detection-toggle').disabled = true; send({ type: 'detection-toggle', enabled: $('detection-toggle').checked });
  });
  $('notifications').addEventListener('change', async () => {
    savePreferences();
    if ($('notifications').checked && !native && 'Notification' in window && Notification.permission === 'default') {
      const permission = await Notification.requestPermission(); if (permission !== 'granted') info('系统通知未授权，事件仍会显示在列表中。');
    }
  });
  const states = { off: '已关闭 · 模型进程已退出', starting: '正在加载模型…', on: '运行中 · CPU · 2 帧/秒', stopping: '正在退出模型进程…', error: '检测未启动' };
  function handle(message) {
    if (message.type === 'talkback-state' || message.type === 'error') return talkback.handle(message);
    if (message.type === 'microphone-state') { microphone = message.enabled; syncSound(); }
    else if (message.type === 'detection-state') {
      state = message; $('detection-toggle').checked = message.enabled ?? ['on', 'starting'].includes(message.status);
      const available = message.available !== false && message.cameraOnline !== false;
      $('detection-toggle').disabled = !available;
      $('notifications').disabled = !available;
      $('detection-controls').classList.toggle('unavailable', !available);
      $('detection-status').textContent = !available ? `${message.available === false ? '本机检测端离线' : '摄像头离线'}${message.enabled ? ' · 已记住开启，上线后自动恢复' : ' · 上线后自动连接'}` : `${message.location === 'desktop' ? '本机检测端在线 · ' : ''}${states[message.status] || message.status}${message.pid ? ` · PID ${message.pid}` : ''}${message.error ? `：${message.error}` : ''}`;
      $('detection-toggle').title = available ? '开启后在检测端运行模型' : '请打开本机桌面端并登录同一服务';
      if (message.status !== 'on' || !available) { boxes = []; $('person-count').textContent = available ? '检测已关闭' : '检测端离线'; }
    } else if (message.type === 'detection-result') {
      boxes = message.boxes; boxTime = Date.now(); $('person-count').textContent = `画面中 ${boxes.length} 人`;
    } else if (message.type === 'person-event') {
      const list = $('event-list'), item = document.createElement('li'), time = document.createElement('time'), text = document.createElement('span');
      time.textContent = new Date(message.time).toLocaleTimeString(); text.textContent = message.text;
      item.append(time, text); list.prepend(item); while (list.children.length > 50) list.lastElementChild.remove();
      $('event-empty').hidden = true; $('event-toast').textContent = message.text; $('event-toast').hidden = false;
      clearTimeout(handle.toast); handle.toast = setTimeout(() => { $('event-toast').hidden = true; }, 5000);
      if ($('notifications').checked) {
        const payload = { title: `${message.name} · 人物动态`, body: message.text };
        if (native) native.notify(payload).catch(() => {});
        else if ('Notification' in window && Notification.permission === 'granted') new Notification(payload.title, { body: payload.body });
      }
    }
  }
  const sampling = setInterval(async () => {
    if (!live || state.status !== 'on' || !state.source || sampleBusy || video.readyState < 2) return;
    sampleBusy = true;
    try {
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      sample.width = Math.max(1, Math.round(video.videoWidth * scale)); sample.height = Math.max(1, Math.round(video.videoHeight * scale));
      sampleContext.drawImage(video, 0, 0, sample.width, sample.height);
      send({ type: 'detection-frame', jpeg: sample.toDataURL('image/jpeg', .75).split(',')[1] });
    } finally { sampleBusy = false; }
  }, 500);
  $('notifications').disabled = true;
  return { setLive, drawBoxes, handle, stopRecording, hasAudio, playbackBlocked, setTalkbackSender: value => talkback.setSender(value), mediaChanged: syncSound, disconnected() { talkback.setLive(false); state = { status: 'off', source: false }; boxes = []; microphone = false; syncSound(); $('detection-toggle').disabled = true; $('notifications').disabled = true; $('detection-status').textContent = '未连接检测服务'; },
    async dispose() { talkback.stop(); clearInterval(sampling); await stopRecording(); } };
}
