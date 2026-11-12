export function createCameraSettings({ facing, quality, message, getStream, replaceTrack, previewChanged, report, interrupted }) {
  let session = null;
  const read = () => ({ facing: facing.value, height: Number(quality.value) });
  const constraints = (settings = read(), exact = false) => ({ facingMode: { [exact ? 'exact' : 'ideal']: settings.facing }, width: { ideal: Math.round(settings.height * 16 / 9) }, height: { ideal: settings.height }, frameRate: { ideal: 15, max: 15 } });
  const valid = s => session === s && getStream() === s.stream;
  function watch(s, track) { track.onended = () => { if (valid(s) && s.stream.getVideoTracks().includes(track)) interrupted('摄像头被系统中断，请重新开始监控'); }; }
  function describe(s) {
    const size = s.stream.getVideoTracks()[0]?.getSettings();
    message.textContent = `${s.applied.facing === 'user' ? '前置镜头' : '后置镜头'}${size?.width && size?.height ? ` · 当前 ${size.width} × ${size.height}` : ''} · 可随时调整`;
  }
  async function capture(s, settings) {
    let captured;
    try { captured = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints(settings, true) }); }
    catch (error) {
      if (!valid(s)) return null;
      // Some phones require releasing the old lens before opening the other one.
      if (!['NotReadableError', 'AbortError'].includes(error.name)) throw error;
      for (const track of s.stream.getVideoTracks()) { track.onended = null; track.stop(); }
      captured = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints(settings, true) });
    }
    if (!valid(s)) { captured.getTracks().forEach(t => t.stop()); return null; }
    if (!captured.getVideoTracks().length) { captured.getTracks().forEach(t => t.stop()); throw Error('未获取到视频画面'); }
    return captured;
  }
  async function install(s, captured) {
    if (!captured) return;
    const track = captured.getVideoTracks()[0], old = s.stream.getVideoTracks();
    for (const previous of old) { previous.onended = null; s.stream.removeTrack(previous); }
    s.stream.addTrack(track); watch(s, track);
    try { await replaceTrack(track, s.stream); if (valid(s)) previewChanged(); }
    finally { old.forEach(t => t.stop()); captured.getTracks().filter(t => t !== track).forEach(t => t.stop()); }
  }
  async function apply(s, settings) {
    const track = s.stream.getVideoTracks()[0];
    if (settings.facing === s.applied.facing && track?.readyState === 'live' && track.applyConstraints) {
      try {
        const { facingMode, ...size } = constraints(settings);
        await track.applyConstraints(size); if (valid(s)) s.applied = settings; return;
      } catch { if (!valid(s)) return; }
    }
    if (track) track.onended = null;
    const captured = await capture(s, settings);
    if (!valid(s)) return;
    await install(s, captured); if (valid(s)) s.applied = settings;
  }
  async function process(s) {
    while (valid(s) && s.desired) {
      const settings = s.desired; s.desired = null;
      message.textContent = settings.facing === s.applied.facing ? '正在调整清晰度…' : '正在切换镜头…'; report('');
      try { await apply(s, settings); if (valid(s) && !s.desired) describe(s); }
      catch (error) {
        if (!valid(s)) return;
        const current = s.stream.getVideoTracks()[0];
        if (current?.readyState === 'live' && !current.muted) watch(s, current);
        else {
          message.textContent = '正在恢复原镜头…';
          try { const recovered = await capture(s, s.applied); if (!valid(s)) return; await install(s, recovered); }
          catch { if (valid(s)) interrupted('摄像头暂不可用，请重新开始监控'); return; }
        }
        if (!valid(s)) return;
        if (!s.desired) { facing.value = s.applied.facing; quality.value = String(s.applied.height); message.textContent = '切换失败，已保留或恢复原画面'; }
        report(`调整摄像头失败：${error.name === 'NotAllowedError' ? '未允许使用所选镜头' : error.message}`);
      }
    }
  }
  function request() {
    const s = session; if (!s || !valid(s)) return;
    s.desired = read(); if (s.task) return;
    s.task = process(s).finally(() => { s.task = null; if (valid(s) && s.desired) request(); });
  }
  facing.addEventListener('change', request); quality.addEventListener('change', request);
  return {
    read, constraints,
    start(stream, applied) { const s = session = { stream, applied, desired: null, task: null }; watch(s, stream.getVideoTracks()[0]); describe(s); const wanted = read(); if (wanted.facing !== applied.facing || wanted.height !== applied.height) request(); },
    stop() { session = null; message.textContent = '监控中也可切换镜头和清晰度'; },
  };
}
