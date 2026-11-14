import { assistantDesktop } from './assistant-desktop.js';
import { resamplePcm16, pcmBase64, SpeechCollector, speechChunks, BargeInDetector } from './voice-audio.js';
import { createSpeechPipeline } from './speech-pipeline.js';
import { createVolcengineSpeech } from './volcengine-speech.js';
import { createLevelMeter } from './pcm-player.js';
import { endsVoiceConversation } from './presence-state.js';

export function createAssistantVoice({ api, sendMessage, canChat, onState, onError, onMetrics, onLevel, onInterrupt, getConversationSettings = () => ({}), canInitiateConversation = () => true, native = assistantDesktop() }) {
  let generation = 0, active = false, lease, stream, context, source, capture, heartbeat, settings, controller, audio, audioUrl, playbackDone;
  let phase = 'off', collector, lastActivity = 0, reconnecting = false, pendingUtterance;
  const bargeIn = new BargeInDetector();
  let pipeline, metrics, startedAt, outputContext, outputMeter;
  let outputId = '';
  const beginMetrics = () => { startedAt = performance.now(); metrics = {}; onMetrics?.({}); };
  const mark = key => { if (metrics && metrics[key] === undefined) { metrics[key] = Math.round(performance.now() - startedAt); onMetrics?.({ ...metrics }); } };
  const setState = (next, text) => { phase = next; onLevel?.(0); onState?.({ phase: next, active, text }); };
  const call = async (action, options = {}, signal) => {
    const result = await (native?.voice ? native.voice(action, options) : api(`/api/assistant/voice/${action}`, action === 'status' ? undefined : options, signal));
    if (result?.cancelled === true) throw new DOMException('语音已停止', 'AbortError');
    return result;
  };
  async function failTurn(error, version) {
    if (version !== generation || !active) return;
    await stop();
    // Notifications in the widget are suppressed during an active voice turn.
    // Report the original failure only once idle, and never over a newer turn.
    if (generation === version + 1 && error.name !== 'AbortError') onError?.(error.message);
  }
  function stopPlayback() { outputMeter?.stop(); outputMeter = null; if (outputContext) void outputContext.close().catch(() => {}); outputContext = null; if (audio) { audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; } if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; globalThis.speechSynthesis?.cancel(); playbackDone?.(false); playbackDone = null; }
  async function play(result, version) {
    if (version !== generation) return;
    if (!result?.audio || !['audio/mpeg', 'audio/wav'].includes(result.mime)) throw Error('语音服务未返回有效音频');
    let bytes; try { bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0)); } catch { throw Error('语音服务未返回有效音频'); }
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime })); const element = new Audio(audioUrl); audio = element;
    try {
      if (outputId) { if (!element.setSinkId) throw Error('当前运行环境不支持选择输出设备'); await element.setSinkId(outputId); }
      if (onLevel && globalThis.AudioContext) {
        outputContext = new AudioContext(); outputMeter = createLevelMeter(outputContext, value => { if (version === generation) onLevel(value); });
        if (outputId) { if (!outputContext.setSinkId) throw Error('当前运行环境不支持选择输出设备'); await outputContext.setSinkId(outputId); }
        outputContext.createMediaElementSource(element).connect(outputMeter.input); await outputContext.resume();
        if (version !== generation) return false;
      }
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('语音播放超时，请检查声音输出')), 120000);
        const finish = value => { clearTimeout(timeout); resolve(value); };
        const fail = message => { clearTimeout(timeout); reject(Error(message)); };
        playbackDone = finish; element.onplaying = () => { if (version === generation) mark('firstPlaybackMs'); }; element.onended = () => finish(true); element.onerror = () => fail('语音播放失败，请检查声音输出');
        element.play().catch(() => fail('无法播放语音，请允许声音播放并检查输出设备'));
      });
    } finally { if (version === generation) stopPlayback(); }
  }
  function speechPipeline(version, provider, leaseId, acknowledgingWake = false) {
    const currentController = controller;
    if (settings?.provider === 'volcengine' || settings?.provider === 'chattts' || settings?.provider === 'qwen3tts' && settings.synthesisCapabilities?.audioStreaming) {
      pipeline = createVolcengineSpeech({ call, leaseId, method: settings.provider === 'volcengine' ? settings.volcengine?.method : 'local-stream', firstClauseMin: settings.provider === 'qwen3tts' ? 8 : 0, signal: currentController.signal,
        outputId, startBufferMs: settings.provider === 'qwen3tts' ? 300 : 0,
        onSynthesize: () => { if (version === generation && phase !== 'speaking') setState('synthesizing', ['chattts', 'qwen3tts'].includes(settings.provider) ? `${provider} · 正在生成首段音频（首次推理包含初始化）…` : `${provider} · 正在连接并生成首段音频…`); },
        onAudio: () => { if (version === generation) mark('firstAudioMs'); },
        onPlaying: () => { if (version === generation) { mark('firstPlaybackMs'); setState('speaking', acknowledgingWake ? `${provider} · 唤醒应答中…` : `${provider} · 正在流式播放 · 可打断并说话`); } },
        onLevel: value => { if (version === generation) onLevel?.(value); },
      });
      return pipeline;
    }
    pipeline = createSpeechPipeline({
      firstClauseMin: settings?.provider === 'qwen3tts' ? 8 : 0,
      synthesize: async text => {
        if (version !== generation) return null;
        if (phase !== 'speaking') setState('synthesizing', settings.provider === 'qwen3tts' ? `${provider} · 正在合成短句（生成后播放）…` : `${provider} · 正在生成语音…`);
        const result = await call('speak', { leaseId, text }, currentController.signal);
        if (version === generation) mark('firstAudioMs');
        return result;
      },
      play: async result => {
        if (version !== generation) return false;
        setState('speaking', acknowledgingWake ? `${provider} · 唤醒应答中…` : `${provider} · 正在播放 · 可打断并说话`);
        return play(result, version);
      },
    });
    return pipeline;
  }
  async function systemRead(text, version) {
    if (outputId) throw Error('系统语音不支持指定输出设备，请启用所选合成服务');
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
    active = true; controller = new AbortController(); beginMetrics();
    setState('loading', '正在读取语音配置…');
    try {
      const status = await call('status'); if (version !== generation) return false; settings = status.settings;
      if (!(status.synthesisAvailable ?? status.available)) {
        if (settings?.provider) throw Error(status.synthesisError || '所选语音服务不可用，请查看语音设置');
        setState('speaking', '系统语音 · 正在本机播放'); return await systemRead(text, version);
      }
      setState('loading', ['chattts', 'qwen3tts'].includes(settings.provider) ? `${status.synthesis || '本地语音'} · ${status.draining ? '正在结束上一段合成…' : status.modelLoaded ? '正在复用已加载模型…' : '正在加载合成模型…'}` : '正在准备语音连接…');
      lease = crypto.randomUUID();
      const opened = await call('open', { leaseId: lease, mode: 'synthesis' }, controller.signal);
      if (version !== generation) { await call('close', { leaseId: opened.leaseId, keepWarm: true }); return false; }
      lease = opened.leaseId;
      mark('loadMs');
      heartbeat = setInterval(() => { if (version === generation) void call('heartbeat', { leaseId: opened.leaseId }).catch(error => failTurn(error, version)); }, 3000);
      const speech = speechPipeline(version, status.synthesis || '本地语音', opened.leaseId);
      speech.write(text); speech.finish(); return await speech.done;
    } catch (error) { if (version !== generation || error.name === 'AbortError') return false; throw error; }
    finally { if (version === generation) await stop(); }
  }
  async function transcribe(pcm) {
    const version = generation; collector.reset(); lastActivity = Date.now(); controller = new AbortController(); beginMetrics();
    setState('transcribing', '正在识别语音…');
    try {
      const result = await call('transcribe', { leaseId: lease, pcm: pcmBase64(pcm) }, controller.signal);
      if (version !== generation || !active) return;
      if (!result.text) { setState('listening', '没有识别到文字，请再说一次'); return; }
      mark('asrMs');
      await respond(result.text, version);
    } catch (error) {
      await failTurn(error, version);
    }
  }
  async function respond(text, version, proactive = false) {
    const endConversation = !proactive && endsVoiceConversation(text);
    controller = new AbortController();
    setState('thinking', proactive ? '正在顺着话题想一想…' : '正在思考…');
    const speech = speechPipeline(version, settings.provider === 'volcengine' ? '豆包语音' : '本地语音', lease);
    const answering = (async () => {
      const reply = await sendMessage(text, { signal: controller.signal, fromVoice: true, ...(proactive ? { proactive: true } : {}),
        ...(settings.lowLatency !== false ? { onDelta: text => { if (version === generation) { mark('firstTextMs'); speech.write(text); } } } : {}),
      });
      if (version !== generation || !active) return;
      if (!reply) {
        if (proactive) { speech.cancel(); return; }
        throw Error('助手未返回可朗读的回复，语音已暂停，请重试');
      }
      if (settings.lowLatency === false) { mark('firstTextMs'); speech.write(reply); }
      speech.finish();
    })();
    await Promise.all([answering, speech.done]);
    if (version !== generation || !active) return;
    if (endConversation || !settings.autoListen) { await stop(); return; }
    collector.reset(); lastActivity = Date.now(); setState('listening', '请继续说，停顿后自动发送');
  }
  async function interrupt(onset) {
    if (!active || !stream) return start();
    const version = ++generation, oldLease = lease; lease = null;
    pipeline?.cancel(); pipeline = null; controller?.abort(); controller = null;
    stopPlayback(); onInterrupt?.(); bargeIn.reset(); collector.reset();
    pendingUtterance = null; reconnecting = true; lastActivity = Date.now();
    if (onset instanceof Int16Array) collector.push(onset);
    setState('listening', '已打断，请继续说，停顿后自动发送');
    try {
      // Release the old lease and discard late audio while retaining local models.
      // Capture continues while any previous inference drains.
      if (oldLease) await call('close', { leaseId: oldLease, keepWarm: true });
      if (version !== generation || !active) return;
      const requested = crypto.randomUUID(); lease = requested;
      const opened = await call('open', { leaseId: requested });
      if (version !== generation || !active) { await call('close', { leaseId: opened.leaseId, keepWarm: true }); return; }
      lease = opened.leaseId; reconnecting = false;
      if (pendingUtterance) { const pcm = pendingUtterance; pendingUtterance = null; void transcribe(pcm); }
    } catch (error) { await failTurn(error, version); }
  }
  async function stop() {
    const version = ++generation, oldLease = lease; lease = null; active = false; reconnecting = false; pendingUtterance = null; bargeIn.reset();
    pipeline?.cancel(); pipeline = null;
    controller?.abort(); controller = null; clearInterval(heartbeat); stopPlayback();
    capture?.port.close(); capture?.disconnect(); source?.disconnect(); capture = source = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    const oldContext = context; context = null; if (oldContext) await oldContext.close().catch(() => {});
    if (oldLease) await call('close', { leaseId: oldLease, keepWarm: true }).catch(() => {});
    if (version === generation) setState('off', '语音已暂停');
  }
  async function start({ initialText = '', wakeReply = '' } = {}) {
    const version = generation + 1;
    await stop(); if (version !== generation) return;
    if (!canChat()) throw Error('请先配置可用的对话模型');
    active = true; setState('loading', '正在读取语音配置…');
    try {
      const status = await call('status'); if (version !== generation) return;
      settings = status.settings;
      bargeIn.configure({ threshold: settings.bargeInThreshold, durationMs: settings.bargeInDurationMs });
      if (!status.available) throw Error('语音识别运行时尚未安装，请使用已初始化的桌面端或服务端运行时');
      if (settings?.provider && !status.synthesisAvailable) throw Error(status.synthesisError || '所选语音服务不可用，请查看语音设置');
      if (!settings.enabled) settings = await call('settings', { enabled: true });
      if (version !== generation) return;
      setState('loading', status.draining ? '正在结束上一段合成…' : status.modelLoaded ? '正在复用已加载模型并准备语音对话…' : ['chattts', 'qwen3tts'].includes(settings.provider) ? '正在加载识别与所选合成模型…' : '正在加载本地识别模型…');
      lease = crypto.randomUUID();
      const opened = await call('open', { leaseId: lease });
      if (version !== generation) { await call('close', { leaseId: opened.leaseId, keepWarm: true }); return; }
      lease = opened.leaseId;
      heartbeat = setInterval(() => { const currentLease = lease, currentVersion = generation; if (active && currentLease && !reconnecting) void call('heartbeat', { leaseId: currentLease }).catch(error => { if (currentLease === lease) return failTurn(error, currentVersion); }); }, 3000);
      if (typeof wakeReply === 'string' && wakeReply.trim()) {
        controller = new AbortController(); beginMetrics();
        const speech = speechPipeline(version, status.synthesis || '本地语音', opened.leaseId, true);
        speech.write(wakeReply); speech.finish();
        const completed = await speech.done;
        if (version !== generation || !active) return;
        if (!completed) { await stop(); return; }
      }
      // Open capture after the acknowledgement drains so it cannot be
      // transcribed or mistaken for a barge-in from the user.
      const microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (version !== generation) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream = microphone; context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      await context.audioWorklet.addModule('/modules/assistant/assistant-audio-worklet.js'); if (version !== generation) return;
      source = context.createMediaStreamSource(stream); capture = new AudioWorkletNode(context, 'assistant-capture');
      collector = new SpeechCollector({ silenceMs: settings.silenceMs }); lastActivity = Date.now();
      capture.port.onmessage = event => {
        if (!active || !context) return;
        const samples = new Float32Array(event.data); let energy = 0;
        for (const sample of samples) energy += sample * sample;
        onLevel?.(Math.min(1, Math.sqrt(energy / Math.max(1, samples.length)) * 5));
        const pcm = resamplePcm16(samples, context.sampleRate);
        if (phase !== 'listening') {
          if (settings.autoInterrupt !== false && ['thinking', 'synthesizing', 'speaking'].includes(phase)) {
            const onset = bargeIn.push(pcm);
            if (onset) void interrupt(onset);
          } else bargeIn.reset();
          return;
        }
        bargeIn.reset();
        const utterance = collector.push(pcm);
        if (collector.active) lastActivity = Date.now();
        if (utterance) { if (reconnecting) pendingUtterance = utterance; else void transcribe(utterance); }
        else if (!collector.active && !reconnecting) {
          if (Date.now() - lastActivity > 60000) void failTurn(Error('长时间未检测到回应，语音已自动暂停'), generation);
        }
      };
      source.connect(capture); capture.connect(context.destination);
      setState('listening', '请说话，停顿后自动发送');
      if (String(initialText).trim()) {
        beginMetrics();
        void respond(String(initialText).trim(), version).catch(error => failTurn(error, version));
      }
    } catch (error) { if (version === generation) { await stop(); throw Error(error.name === 'NotAllowedError' ? '麦克风权限未开启，请允许后重新开始' : error.message); } }
  }
  return {
    setOutputDevice(id) { outputId = typeof id === 'string' ? id : ''; },
    get active() { return active; },
    get busy() { return active && (phase !== 'listening' || Boolean(collector?.active)); },
    async sayOpportunity(text) {
      if (!active) return read(text);
      if (phase !== 'listening' || collector?.active || reconnecting) return false;
      const version = generation; collector.reset(); controller = new AbortController(); beginMetrics();
      try { const speech = speechPipeline(version, settings.provider === 'volcengine' ? '豆包语音' : '本地语音', lease); speech.write(text); speech.finish(); return await speech.done; }
      finally { if (version === generation && active) { collector.reset(); lastActivity = Date.now(); setState('listening', '请继续说，停顿后自动发送'); } }
    },
    status: () => call('status'),
    async configure(options) { await stop(); const next = await call('settings', options); settings = next; return next; },
    start, stop, read,
    interrupt,
    catalog: (provider, refresh = true) => call('catalog', { refresh, ...(provider ? { provider } : {}) }),
    preview: (text = '你好，我是你的助手，有什么可以帮你？') => read(text),
  };
}
