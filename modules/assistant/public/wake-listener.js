import { SpeechCollector, resamplePcm16, pcmBase64 } from './voice-audio.js';
import { pinyin } from './vendor/pinyin-pro/pinyin-pro.js';

// Match an opening address only; offsets preserve numbers and punctuation in
// the rest of a same-breath request.
export function matchWakePhrase(text, { name = '', phrases = [] } = {}) {
  const compact = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const sounds = value => pinyin(value, { toneType:'none', type:'array', nonZh:'consecutive' }).map(syllable => syllable.replace(/ng$/, 'n')).join('|');
  const candidates = [...new Set([name, ...phrases].filter(value => typeof value === 'string' && value.trim()))]
    .map(phrase => ({ phrase: phrase.trim(), key: compact(phrase) })).filter(item => item.key);
  // Only the current short Chinese name gets a nickname; custom commands
  // must retain all their words, and a single remaining syllable is too broad.
  const nameKey = compact(name);
  if (/^小[\p{Script=Han}]{2,4}$/u.test(nameKey)) candidates.push({ phrase: name.trim(), key: nameKey.slice(1) });
  candidates.sort((a, b) => b.key.length - a.key.length);
  const original = String(text || ''); let key = ''; const ends = [];
  for (let index = 0; index < original.length;) {
    const char = String.fromCodePoint(original.codePointAt(index)); index += char.length;
    const normalized = compact(char); key += normalized;
    for (let i = 0; i < normalized.length; i++) ends.push(index);
  }
  for (const prefix of ['', '嗨', '嘿', '你好', '喂', 'hey', 'hello']) {
    if (!key.startsWith(prefix)) continue;
    for (const candidate of candidates) {
      const addressed = prefix + candidate.key;
      if (!key.startsWith(addressed) && !(/[\p{Script=Han}]/u.test(candidate.key) && key.length >= addressed.length && sounds(key.slice(0, addressed.length)) === sounds(addressed))) continue;
      const end = ends[addressed.length - 1];
      if (/[a-z0-9]$/i.test(candidate.key) && /[a-z0-9]/i.test(original[end] || '')) continue;
      return { phrase: candidate.phrase, remainder: original.slice(end).replace(/^[\s\p{P}]+/u, '').trim() };
    }
  }
  return null;
}

// Local ASR gate. Unmatched speech is discarded; no recordings/transcripts
// are persisted or sent to the conversation API.
export function createWakeListener({ call, getPhrases, onWake, onError, onState }) {
  let generation = 0, active = false, starting, lease, stream, context, source, capture, heartbeat, recognizing = false;
  async function stop() {
    ++generation; active = false; recognizing = false; const oldLease = lease; lease = null;
    clearInterval(heartbeat); heartbeat = null;
    capture?.port.close(); capture?.disconnect(); source?.disconnect(); capture = source = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    const oldContext = context; context = null; if (oldContext) await oldContext.close().catch(() => {});
    if (oldLease) await call('close', { leaseId: oldLease, keepWarm: true }).catch(() => {});
    onState?.(false);
  }
  async function recognize(pcm, version, collector) {
    recognizing = true;
    try {
      const result = await call('transcribe', { leaseId: lease, pcm: pcmBase64(pcm) });
      if (version !== generation || !active) return;
      const match = matchWakePhrase(result.text, getPhrases());
      if (match) { await stop(); if (generation === version + 1) await onWake(match); }
    } catch (error) {
      if (version === generation) { await stop(); onError?.(error); }
    } finally { if (version === generation) { recognizing = false; collector.reset(); } }
  }
  async function open(version) {
    try {
      lease = crypto.randomUUID(); const requested = lease;
      const opened = await call('wakeOpen', { leaseId: requested });
      if (version !== generation) { await call('close', { leaseId: opened.leaseId, keepWarm: true }); return; }
      lease = opened.leaseId;
      heartbeat = setInterval(() => { if (version === generation) void call('heartbeat', { leaseId: requested }).catch(async error => { if (version === generation) { await stop(); onError?.(error); } }); }, 3000);
      const microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (version !== generation) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream = microphone; const audioContext = new AudioContext({ sampleRate: 16000 }); context = audioContext;
      await audioContext.resume(); if (version !== generation) return;
      await audioContext.audioWorklet.addModule('/modules/assistant/assistant-audio-worklet.js'); if (version !== generation) return;
      source = audioContext.createMediaStreamSource(stream); capture = new AudioWorkletNode(audioContext, 'assistant-capture');
      const collector = new SpeechCollector({ silenceMs: 600, maxMs: 15000 });
      capture.port.onmessage = event => {
        if (version !== generation || !active || recognizing) return;
        const utterance = collector.push(resamplePcm16(new Float32Array(event.data), audioContext.sampleRate));
        if (utterance) void recognize(utterance, version, collector);
      };
      source.connect(capture); capture.connect(audioContext.destination); onState?.(true);
    } catch (error) {
      if (version === generation) { await stop(); onError?.(error); }
    }
  }
  return {
    get active() { return active; },
    start() {
      if (active) return starting || Promise.resolve();
      const version = ++generation; active = true;
      const task = open(version); starting = task;
      void task.finally(() => { if (starting === task) starting = null; }); return task;
    },
    stop,
  };
}
