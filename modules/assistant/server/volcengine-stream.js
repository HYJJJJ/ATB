import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { readBoundedText } from './volcengine-catalog.js';
import { encodeTtsFrame, decodeTtsFrame } from './volcengine-protocol.js';
import { volcenginePatch, volcengineSetupError, synthesisHeaders, synthesisPayload, SynthesisError, providerError } from './volcengine-settings.js';

const endpoints = {
  'ws-bidirectional': 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
  'ws-unidirectional': 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream',
  'http-chunked': 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  'http-sse': 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; };
export async function openVolcengineTts(options) {
  const config = volcenginePatch({}, options.config), missing = volcengineSetupError(config); if (missing) throw Error(missing);
  const { signal, onAudio, request = fetch, connect = (url, settings) => new WebSocket(url, settings) } = options;
  signal?.throwIfAborted();
  const done = deferred(), ready = deferred(), sessionId = randomUUID();
  let socket, reader, text = '', ended = false, settled = false, complete = false, connected = false, started = false, size = 0, received = 0, logId, closeTimer;
  const bidirectional = config.method === 'ws-bidirectional', websocket = config.method.startsWith('ws-');
  const headers = synthesisHeaders(config), payload = value => synthesisPayload({ ...options, config }, value);
  payload();
  const send = (event, data = {}) => { if (socket?.readyState !== WebSocket.OPEN) throw new SynthesisError('语音连接已断开'); socket.send(encodeTtsFrame(event, data, sessionId)); };
  const cleanup = () => {
    clearTimeout(closeTimer); signal?.removeEventListener('abort', aborted);
    void reader?.cancel().catch(() => {});
    if (socket?.readyState === WebSocket.OPEN) { socket.resume(); socket.close(); closeTimer = setTimeout(() => socket.terminate(), 500); closeTimer.unref(); }
    else if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
  };
  const fail = error => {
    if (settled) return; settled = true;
    const safe = signal?.aborted ? signal.reason?.name === 'TimeoutError' ? new SynthesisError('语音合成超时，请重试') : new DOMException('语音已停止', 'AbortError') : error instanceof SynthesisError ? error : new SynthesisError('连接火山引擎语音失败或响应格式无效，请检查网络后重试');
    ready.reject(safe); done.reject(safe); cleanup();
  };
  const succeed = () => {
    if (settled) return;
    if (!size) { fail(new SynthesisError('火山引擎未返回有效音频')); return; }
    if (!ended) { fail(new SynthesisError('语音响应不完整，输入尚未结束')); return; }
    complete = settled = true; done.resolve();
    if (socket?.readyState === WebSocket.OPEN) { socket.resume(); send(2); closeTimer = setTimeout(cleanup, 800); closeTimer.unref(); }
    else cleanup();
  };
  const acceptAudio = async bytes => {
    if (settled) return;
    size += bytes.length; if (size > 6 * 1024 * 1024) throw new SynthesisError('合成音频过大，请缩短朗读文字');
    if (bytes.length) await onAudio?.(bytes);
  };
  const aborted = () => {
    if (socket?.readyState === WebSocket.OPEN && bidirectional && started && !complete) { try { send(101); } catch {} }
    fail(new SynthesisError('语音已停止'));
  };
  signal?.addEventListener('abort', aborted, { once: true });
  async function httpRun() {
    try {
      const response = await request(endpoints[config.method], { method: 'POST', redirect: 'error', signal, headers: { ...headers, 'Content-Type': 'application/json', Accept: config.method === 'http-sse' ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(payload(text)) });
      logId = response.headers.get('x-tt-logid');
      if (!response.ok) {
        let detail; try { const body = JSON.parse(await readBoundedText(response, 8192)); detail = body.header || body; } catch {}
        throw providerError({ status: response.status, code: detail?.code, message: detail?.message, config, logId });
      }
      if (!response.body) throw new SynthesisError('火山引擎未返回有效音频');
      reader = response.body.getReader(); let buffer = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
      const accept = async raw => {
        if (!raw.trim() || settled) return;
        let frame; try { frame = JSON.parse(raw); } catch { throw new SynthesisError('火山引擎返回的语音格式无效'); }
        if (frame.code === 20000000) { succeed(); return; }
        if (frame.code !== 0) throw providerError({ code: frame.code, message: frame.message, config, logId });
        if (frame.data === null || frame.data === undefined || frame.data === '') return;
        if (typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new SynthesisError('火山引擎返回的音频无效');
        await acceptAudio(Buffer.from(frame.data, 'base64'));
      };
      const consume = async final => {
        buffer = buffer.replace(/\r\n/g, '\n'); let end; const separator = config.method === 'http-sse' ? '\n\n' : '\n';
        const frame = line => config.method === 'http-sse' ? line.split('\n').filter(item => item.startsWith('data:')).map(item => item.slice(5).trimStart()).join('\n') : line;
        while (!settled && (end = buffer.indexOf(separator)) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + separator.length); await accept(frame(line)); }
        if (!settled && final && buffer.trim()) { await accept(frame(buffer)); buffer = ''; }
      };
      while (!settled) {
        const chunk = await reader.read(); signal?.throwIfAborted(); if (chunk.done) { buffer += decoder.decode(); await consume(true); break; }
        received += chunk.value.byteLength; if (received > 10 * 1024 * 1024) throw new SynthesisError('语音响应过大，请缩短朗读文字');
        buffer += decoder.decode(chunk.value, { stream: true }); await consume(false);
      }
      if (!complete && !settled) throw new SynthesisError('语音响应不完整，请重试');
    } catch (error) { fail(error); } finally { await reader?.cancel().catch(() => {}); }
  }
  if (websocket) {
    try {
      socket = connect(endpoints[config.method], { headers, followRedirects: false, handshakeTimeout: 15000, maxPayload: 1024 * 1024, perMessageDeflate: false });
      socket.on('upgrade', response => { logId = response.headers['x-tt-logid']; });
      socket.on('unexpected-response', (_request, response) => {
        const chunks = []; let length = 0; logId = response.headers['x-tt-logid'];
        response.on('data', chunk => { length += chunk.length; if (length <= 8192) chunks.push(chunk); else response.destroy(); });
        const finish = () => { let detail; try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); detail = value.header || value; } catch {} fail(providerError({ status: response.statusCode, code: detail?.code, message: detail?.message, config, logId })); };
        response.once('end', finish); response.once('error', finish); response.once('close', finish);
      });
      socket.on('error', () => fail(new SynthesisError('连接火山引擎语音失败，请检查网络后重试')));
      let messages = Promise.resolve();
      socket.on('close', () => { void messages.then(() => { if (!complete) fail(new SynthesisError('语音响应不完整，连接已断开')); else cleanup(); }); });
      socket.on('open', () => { if (settled) return; try { if (bidirectional) send(1); else ready.resolve(); } catch (error) { fail(error); } });
      const acceptMessage = async (data, isBinary) => {
        if (settled) return;
        try {
          if (!isBinary) throw new SynthesisError('火山引擎返回的语音格式无效');
          received += data.length; if (received > 10 * 1024 * 1024) throw new SynthesisError('语音响应过大，请缩短朗读文字');
          const frame = decodeTtsFrame(data);
          let body;
          if (frame.type !== 11 && frame.payload.length) { try { body = JSON.parse(frame.payload); } catch { throw new SynthesisError('火山引擎返回的语音格式无效'); } }
          const code = frame.code ?? body?.status_code ?? body?.code;
          if (frame.type === 15 || [51, 153].includes(frame.event) || code !== undefined && ![0, 20000000].includes(code)) throw providerError({ code, message: body?.message, config, logId });
          if (bidirectional && frame.sessionId && frame.sessionId !== sessionId) throw new SynthesisError('语音会话标识不匹配');
          if (frame.event === 50 && bidirectional && !connected) { connected = true; send(100, { ...payload(), event: 100, namespace: 'BidirectionalTTS' }); }
          else if (frame.event === 150 && bidirectional && connected && !started) { started = true; ready.resolve(); }
          else if (frame.type === 11 && frame.event === 352) { if (bidirectional && !started) throw new SynthesisError('语音会话尚未开始'); await acceptAudio(frame.payload); }
          else if (frame.event === 152) succeed();
        } catch (error) { fail(error); }
      };
      socket.on('message', (data, isBinary) => {
        if (settled) return;
        // Pause the socket while downstream playback drains; serialize frames
        // already delivered by ws so SessionFinished cannot overtake audio.
        socket.pause();
        messages = messages.then(() => acceptMessage(data, isBinary)).catch(fail);
        const current = messages;
        void current.then(() => { if (messages === current && !settled) socket.resume(); });
      });
    } catch (error) { fail(error); }
  } else ready.resolve();
  await ready.promise;
  return {
    done: done.promise,
    async write(value) {
      if (settled || ended) throw new SynthesisError('语音输入已结束');
      if (typeof value !== 'string' || (text.length + value.length) > 16000) throw new SynthesisError('朗读文字无效或过长');
      text += value; if (bidirectional && value) send(200, { ...payload(value), event: 200, namespace: 'BidirectionalTTS' });
    },
    async finish() {
      if (ended) return; if (settled) throw new SynthesisError('语音输入已结束');
      ended = true; if (!text.trim()) { fail(new SynthesisError('没有可朗读的文字')); return; }
      if (bidirectional) send(102);
      else if (websocket) socket.send(encodeTtsFrame(0, payload(text)));
      else void httpRun();
    },
    cancel: () => { if (!settled) aborted(); else cleanup(); },
  };
}
