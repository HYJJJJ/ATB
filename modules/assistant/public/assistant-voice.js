import { assistantDesktop } from './assistant-desktop.js';
import { resamplePcm16, pcmBase64, SpeechCollector, speechChunks } from './voice-audio.js';

export function createAssistantVoice({ api, sendMessage, canChat, onState, onError, native = assistantDesktop() }) {
  let generation = 0, active = false, lease, stream, context, source, capture, heartbeat, settings, controller, audio, audioUrl, playbackDone;
  let phase = 'off', collector, lastActivity = 0;
  const setState = (next, text) => { phase = next; onState?.({ phase: next, active, text }); };
  const call = (action, options = {}, signal) => native?.voice ? native.voice(action, options) : api(`/api/assistant/voice/${action}`, action === 'status' ? undefined : options, signal);
  function stopPlayback() { if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; } if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; playbackDone?.(); playbackDone = null; }
  async function play(result, version) {
    if (version !== generation) return;
    const bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0));
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime })); const element = new Audio(audioUrl); audio = element;
    await new Promise((resolve, reject) => {
      playbackDone = resolve; element.onended = resolve; element.onerror = () => reject(Error('语音播放失败'));
      element.play().catch(() => reject(Error('无法播放语音，请检查声音输出并重新开始')));
    });
    if (version === generation) stopPlayback();
  }
  async function transcribe(pcm) {
    const version = generation; collector.reset(); lastActivity = Date.now(); controller = new AbortController();
    setState('transcribing', '正在本机识别…');
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
    if (version === generation) setState('off', '语音已暂停 · 模型已释放');
  }
  async function start() {
    await stop();
    if (!canChat()) throw Error('请先配置可用的对话模型');
    const version = ++generation; active = true; setState('loading', '正在加载本机语音模型…');
    try {
      const status = await call('status'); if (version !== generation) return;
      settings = status.settings;
      if (!status.available) throw Error('本机语音运行时尚未安装；云端网页需要本机语音服务，请使用已初始化的桌面端');
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
    start, stop,
    async interrupt() { await stop(); await start(); },
    async preview() {
      if (active) throw Error('请先暂停语音对话再试听音色');
      const version = ++generation; active = true; setState('loading', '正在生成试听语音…');
      try {
        const status = await call('status'); if (version !== generation) return;
        if (!status.settings.enabled) throw Error('请先开启并保存语音设置');
        lease = crypto.randomUUID();
        const opened = await call('open', { leaseId: lease });
        if (version !== generation) { await call('close', { leaseId: opened.leaseId }); return; }
        lease = opened.leaseId;
        heartbeat = setInterval(() => { if (version === generation) void call('heartbeat', { leaseId: opened.leaseId }).catch(() => {}); }, 3000);
        const result = await call('speak', { leaseId: opened.leaseId, text: '你好，我是你的家庭助手，有什么可以帮你？' }); await play(result, version);
      } finally { if (version === generation) await stop(); }
    },
  };
}
