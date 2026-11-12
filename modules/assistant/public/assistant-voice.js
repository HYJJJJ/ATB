import { assistantDesktop } from './assistant-desktop.js';
import { resamplePcm16, pcmBase64, SpeechCollector, speechChunks } from './voice-audio.js';

export function createAssistantVoice({ api, sendMessage, canChat, onState, onError, native = assistantDesktop() }) {
  let generation = 0, active = false, lease, stream, context, source, capture, heartbeat, settings, controller, audio, audioUrl, playbackDone;
  let phase = 'off', collector, lastActivity = 0;
  const setState = (next, text) => { phase = next; onState?.({ phase: next, active, text }); };
  const call = (action, options = {}, signal) => native?.voice ? native.voice(action, options) : api(`/api/assistant/voice/${action}`, action === 'status' ? undefined : options, signal);
  function stopPlayback() { if (audio) { audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; } if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; globalThis.speechSynthesis?.cancel(); playbackDone?.(false); playbackDone = null; }
  async function play(result, version) {
    if (version !== generation) return;
    if (!result?.audio || result.mime !== 'audio/mpeg') throw Error('语音服务未返回有效音频');
    let bytes; try { bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0)); } catch { throw Error('语音服务未返回有效音频'); }
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime })); const element = new Audio(audioUrl); audio = element;
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('语音播放超时，请检查声音输出')), 120000);
        const finish = value => { clearTimeout(timeout); resolve(value); };
        const fail = message => { clearTimeout(timeout); reject(Error(message)); };
        playbackDone = finish; element.onended = () => finish(true); element.onerror = () => fail('语音播放失败，请检查声音输出');
        element.play().catch(() => fail('无法播放语音，请允许声音播放并检查输出设备'));
      });
    } finally { if (version === generation) stopPlayback(); }
  }
  async function systemRead(text, version) {
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) throw Error('当前浏览器没有可用朗读服务，请使用桌面端或启用系统语音');
    for (const chunk of speechChunks(text)) {
      if (version !== generation) return false;
      const completed = await new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(chunk); utterance.lang = 'zh-CN';
        const voice = speechSynthesis.getVoices().find(item => item.lang.toLowerCase().startsWith('zh'));
        if (voice) utterance.voice = voice;
        utterance.rate = Math.max(0.5, 1 + Number(settings?.rate || 0) / 100);
        const timer = setTimeout(() => reject(Error('系统语音未完成播放，请检查系统音色和声音输出')), 120000);
        playbackDone = value => { clearTimeout(timer); resolve(value); };
        utterance.onend = () => { clearTimeout(timer); resolve(true); };
        utterance.onerror = event => { clearTimeout(timer); if (version !== generation) resolve(false); else reject(Error(`系统语音播放失败（${event.error || 'unknown'}），请检查系统音色和声音输出`)); };
        speechSynthesis.speak(utterance);
      });
      if (!completed || version !== generation) return false;
    }
    return true;
  }
  async function read(text) {
    if (!String(text || '').trim()) throw Error('没有可朗读的文字');
    const version = generation + 1;
    await stop(); if (version !== generation) return false;
    active = true; controller = new AbortController();
    setState('synthesizing', '正在准备朗读…');
    try {
      const status = await call('status'); if (version !== generation) return false; settings = status.settings;
      if (!(status.synthesisAvailable ?? status.available)) {
        setState('speaking', '系统语音 · 正在本机播放'); return await systemRead(text, version);
      }
      lease = crypto.randomUUID();
      const opened = await call('open', { leaseId: lease, mode: 'synthesis' }, controller.signal);
      if (version !== generation) { await call('close', { leaseId: opened.leaseId }); return false; }
      lease = opened.leaseId;
      heartbeat = setInterval(() => { if (version === generation) void call('heartbeat', { leaseId: opened.leaseId }).catch(error => { if (version === generation) { onError?.(error.message); void stop(); } }); }, 3000);
      for (const chunk of speechChunks(text)) {
        setState('synthesizing', '在线 EdgeTTS · 正在生成语音…');
        const result = await call('speak', { leaseId: opened.leaseId, text: chunk }, controller.signal);
        if (version !== generation) return false;
        setState('speaking', '在线 EdgeTTS · 正在本机播放');
        if (!await play(result, version) || version !== generation) return false;
      }
      return true;
    } catch (error) { if (version !== generation || error.name === 'AbortError') return false; throw error; }
    finally { if (version === generation) await stop(); }
  }
  async function transcribe(pcm) {
    const version = generation; collector.reset(); lastActivity = Date.now(); controller = new AbortController();
    setState('transcribing', '正在识别语音…');
    try {
      const result = await call('transcribe', { leaseId: lease, pcm: pcmBase64(pcm) }, controller.signal);
      if (version !== generation || !active) return;
      if (!result.text) { setState('listening', '没有识别到文字，请再说一次'); return; }
      setState('thinking', '正在思考…');
      const reply = await sendMessage(result.text, { signal: controller.signal, fromVoice: true });
      if (version !== generation || !active) return;
      if (!reply) throw Error('助手未返回可朗读的回复，语音已暂停，请重试');
      for (const text of speechChunks(reply)) {
        if (!text.trim()) continue;
        setState('synthesizing', '正在生成语音…');
        const speech = await call('speak', { leaseId: lease, text }, controller.signal);
        if (version !== generation || !active) return;
        setState('speaking', '正在回复 · 可点击打断'); await play(speech, version);
        if (version !== generation || !active) return;
      }
      if (version !== generation || !active) return;
      if (!settings.autoListen) { await stop(); return; }
      collector.reset(); lastActivity = Date.now(); setState('listening', '请继续说，停顿后自动发送');
    } catch (error) {
      if (version === generation && active) {
        if (error.name !== 'AbortError') onError?.(error.message);
        await stop();
      }
    }
  }
  async function stop() {
    const version = ++generation, oldLease = lease; lease = null; active = false;
    controller?.abort(); controller = null; clearInterval(heartbeat); stopPlayback();
    capture?.port.close(); capture?.disconnect(); source?.disconnect(); capture = source = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    const oldContext = context; context = null; if (oldContext) await oldContext.close().catch(() => {});
    if (oldLease) await call('close', { leaseId: oldLease }).catch(() => {});
    if (version === generation) setState('off', '语音已暂停');
  }
  async function start() {
    const version = generation + 1;
    await stop(); if (version !== generation) return;
    if (!canChat()) throw Error('请先配置可用的对话模型');
    active = true; setState('loading', '正在加载语音识别模型…');
    try {
      const status = await call('status'); if (version !== generation) return;
      settings = status.settings;
      if (!status.available) throw Error('语音识别运行时尚未安装，请使用已初始化的桌面端或服务端运行时');
      if (!settings.enabled) settings = await call('settings', { enabled: true });
      if (version !== generation) return;
      lease = crypto.randomUUID();
      const opened = await call('open', { leaseId: lease });
      if (version !== generation) { await call('close', { leaseId: opened.leaseId }); return; }
      lease = opened.leaseId;
      heartbeat = setInterval(() => { if (lease && version === generation) void call('heartbeat', { leaseId: lease }).catch(error => { if (version === generation) { onError?.(error.message); void stop(); } }); }, 3000);
      const microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (version !== generation) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream = microphone; context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      await context.audioWorklet.addModule('/modules/assistant/assistant-audio-worklet.js'); if (version !== generation) return;
      source = context.createMediaStreamSource(stream); capture = new AudioWorkletNode(context, 'assistant-capture');
      collector = new SpeechCollector({ silenceMs: settings.silenceMs }); lastActivity = Date.now();
      capture.port.onmessage = event => {
        if (!active || phase !== 'listening') return;
        const pcm = resamplePcm16(new Float32Array(event.data), context.sampleRate), utterance = collector.push(pcm);
        if (collector.active) lastActivity = Date.now();
        if (utterance) void transcribe(utterance);
        else if (Date.now() - lastActivity > 60000) { onError?.('一分钟未检测到说话，语音已自动暂停'); void stop(); }
      };
      source.connect(capture); capture.connect(context.destination);
      setState('listening', '请说话，停顿后自动发送');
    } catch (error) { if (version === generation) { await stop(); throw Error(error.name === 'NotAllowedError' ? '麦克风权限未开启，请允许后重新开始' : error.message); } }
  }
  return {
    get active() { return active; },
    status: () => call('status'),
    async configure(options) { const next = await call('settings', options); settings = next; if (!next.enabled) await stop(); return next; },
    start, stop, read,
    interrupt: start,
    preview: () => read('你好，我是你的助手，有什么可以帮你？'),
  };
}
