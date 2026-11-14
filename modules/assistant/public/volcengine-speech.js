import { createPcmPlayer } from './pcm-player.js';
import { createSpeechPipeline } from './speech-pipeline.js';

// Bidirectional input stays in one session; other protocols submit complete sentences.
// All sessions share one player, so synthesis can continue while earlier PCM plays.
export function createVolcengineSpeech({ call, leaseId, method = 'http-chunked', signal, onAudio, onPlaying, onLevel, onSynthesize, outputId = '', firstClauseMin = 0, startBufferMs = 0, createPlayer = createPcmPlayer }) {
  let queue = [], received = 0, ended = false, cancelled = false, wake, player, sentences;
  const controller = new AbortController(), wakeInput = () => { wake?.(); wake = null; };
  const cancel = () => { cancelled = true; sentences?.cancel(); controller.abort(); player?.stop(); wakeInput(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  async function request(action, options) {
    controller.signal.throwIfAborted();
    let aborted;
    const cancellation = new Promise((_, reject) => { aborted = () => reject(new DOMException('语音已停止', 'AbortError')); controller.signal.addEventListener('abort', aborted, { once: true }); });
    try { return await Promise.race([call(action, { leaseId, ...options }, controller.signal), cancellation]); }
    finally { controller.signal.removeEventListener('abort', aborted); }
  }
  const done = (async () => {
    try {
      if (cancelled) return false;
      if (method !== 'ws-bidirectional') {
        sentences = createSpeechPipeline({ firstClauseMin,
          async synthesize(text) {
            onSynthesize?.();
            const started = await request('ttsStart');
            if (started.mime !== 'audio/pcm') throw Error('语音服务未返回有效音频');
            player ||= createPlayer({ sampleRate: started.sampleRate, onPlaying, onLevel, outputId, ...(method === 'local-stream' ? { releaseMs: 8, endPaddingMs: 220, startBufferMs } : {}) });
            const options = { streamId: started.streamId };
            await request('ttsText', { ...options, text });
            const receiving = (async () => {
              for (;;) {
                const part = await request('ttsRead', options);
                if (cancelled) return null;
                if (part.audio) { onAudio?.(); await player.write(part.audio); }
                if (part.done) return true;
              }
            })();
            const [completed] = await Promise.all([receiving, request('ttsFinish', options)]);
            return completed;
          },
          play: async () => !cancelled,
        });
        const completed = await sentences.done;
        if (cancelled || !completed) return false;
        if (!player) throw Error('没有可朗读的文字');
        return await player.finish();
      }
      while (!cancelled && !queue.length && !ended) await new Promise(resolve => { wake = resolve; });
      if (cancelled) return false;
      if (!queue.length) throw Error('没有可朗读的文字');
      onSynthesize?.();
      const started = await request('ttsStart');
      if (cancelled) return false;
      if (started.mime !== 'audio/pcm') throw Error('语音服务未返回有效音频');
      const options = { streamId: started.streamId };
      player = createPlayer({ sampleRate: started.sampleRate, onPlaying, onLevel, outputId });
      const receiving = (async () => {
        for (;;) {
          const part = await request('ttsRead', options);
          if (cancelled) return false;
          if (part.audio) { onAudio?.(); await player.write(part.audio); }
          if (part.done) return player.finish();
        }
      })();
      const sending = (async () => {
        while (!cancelled) {
          while (!queue.length && !ended && !cancelled) await new Promise(resolve => { wake = resolve; });
          if (cancelled) return;
          const text = queue.join(''); queue = [];
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(offset + 2000, text.length); if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            if (end === offset) end++;
            await request('ttsText', { ...options, text: text.slice(offset, end) }); offset = end;
          }
          if (ended && !queue.length) { await request('ttsFinish', options); return; }
        }
      })();
      const [completed] = await Promise.all([receiving, sending]);
      return completed;
    } catch (error) { if (cancelled) return false; throw error; }
    finally { sentences?.cancel(); controller.abort(); player?.stop(); queue = []; wakeInput(); signal?.removeEventListener('abort', cancel); }
  })();
  done.catch(() => {});
  return { done,
    write(text) {
      if (cancelled || ended) return;
      if (typeof text !== 'string' || (received += text.length) > 16000) throw Error('语音回复过长');
      if (sentences) sentences.write(text); else if (text) queue.push(text); wakeInput();
    },
    finish() { ended = true; sentences?.finish(); wakeInput(); },
    cancel,
  };
}
