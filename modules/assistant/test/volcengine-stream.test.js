import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { volcenginePatch, visibleVolcengine } from '../server/volcengine-tts.js';

const key = 'fixture-never-real-key';
const config = { authMode: 'apiKey', apiKey: key, modelName: 'seed-tts-2.0', sampleRate: 24000 };
const options = { voice: 'zh_female_xiaohe_uranus_bigtts', rate: -10, volume: 15, pitch: 2 };
function response(event, payload = {}, { session = 'session-fixture', audio = false, compressed = false } = {}) {
  const id = Buffer.from([50, 51, 52].includes(event) ? 'connect-fixture' : session);
  const data = audio ? payload : Buffer.from(JSON.stringify(payload));
  const bytes = compressed ? gzipSync(data) : data;
  const header = Buffer.from([0x11, audio ? 0xb4 : 0x94, (audio ? 0 : 0x10) | Number(compressed), 0]);
  const fields = Buffer.alloc(12); fields.writeInt32BE(event); fields.writeUInt32BE(id.length, 4); fields.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([header, fields.subarray(0, 8), id, fields.subarray(8), bytes]);
}
async function fixture(t, onMessage, handshake = () => {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  server.on('connection', (socket, req) => { handshake(req); socket.on('message', data => onMessage(socket, data)); });
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return (url, settings) => {
    assert.match(url, /^wss:\/\/openspeech\.bytedance\.com\/api\/v3\/tts\//);
    assert.equal(settings.followRedirects, false);
    return new WebSocket(`ws://127.0.0.1:${server.address().port}`, settings);
  };
}

test('official model names and methods preserve old credentials and Resource-Id migrations', () => {
  const migrated = volcenginePatch({}, { resourceId: 'seed-tts-1.0-concurr', apiKey: key });
  assert.equal(migrated.modelName, 'seed-tts-1.0-concurr'); assert.equal(migrated.method, 'http-chunked');
  for (const method of ['ws-bidirectional', 'ws-unidirectional', 'http-chunked', 'http-sse']) {
    const saved = volcenginePatch({ method, modelName: 'seed-tts-2.0', contextTexts: '请温柔地说话' }, migrated);
    assert.equal(saved.method, method); assert.equal(saved.modelName, 'seed-tts-2.0'); assert.equal(saved.resourceId, 'seed-tts-2.0');
    assert.equal(saved.apiKey, key); assert.ok(!JSON.stringify(visibleVolcengine(saved)).includes(key));
  }
  assert.throws(() => volcenginePatch({ method: 'https://evil.example' }), /方式/);
  assert.throws(() => volcenginePatch({ modelName: 'unknown' }), /模型/);
});

test('binary protocol matches official event envelope and rejects invalid lengths and compression', async () => {
  const { encodeTtsFrame, decodeTtsFrame } = await import('../server/volcengine-protocol.js');
  assert.equal(encodeTtsFrame(1).toString('hex'), '1114100000000001000000027b7d');
  const decoded = decodeTtsFrame(response(352, Buffer.from([1, 2, 3, 4]), { audio: true, compressed: true }));
  assert.equal(decoded.event, 352); assert.equal(decoded.sessionId, 'session-fixture'); assert.deepEqual(decoded.payload, Buffer.from([1, 2, 3, 4]));
  assert.equal(decodeTtsFrame(response(50)).connectId, 'connect-fixture');
  assert.throws(() => decodeTtsFrame(response(352, Buffer.from([1, 2]), { audio: true }).subarray(0, -1)), /格式|长度/);
  assert.throws(() => decodeTtsFrame(Buffer.from([0x11, 0x94, 0x12, 0])), /格式|压缩/);
});

test('bidirectional WebSocket accepts text incrementally and returns audio before FinishSession', async t => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  const { decodeTtsFrame } = await import('../server/volcengine-protocol.js');
  const input = []; let started, finishSession = false;
  const audioArrived = new Promise(resolve => { started = resolve; });
  const connect = await fixture(t, (socket, data) => {
    const message = decodeTtsFrame(data); const payload = JSON.parse(message.payload);
    if (message.event === 1) socket.send(response(50));
    if (message.event === 100) {
      assert.equal(payload.req_params.audio_params.format, 'pcm'); assert.equal(payload.req_params.audio_params.speech_rate, -10);
      assert.equal(JSON.parse(payload.req_params.additions).post_process.pitch, 2);
      socket.send(response(150, {}, { session: message.sessionId }));
    }
    if (message.event === 200) { input.push(payload.req_params.text); socket.send(response(352, Buffer.from([0, 1, 2, 3]), { audio: true, session: message.sessionId })); }
    if (message.event === 102) { finishSession = true; socket.send(response(152, {}, { session: message.sessionId })); }
    if (message.event === 2) { socket.send(response(52)); socket.close(); }
  }, req => { assert.equal(req.headers['x-api-key'], key); assert.equal(req.headers['x-api-resource-id'], 'seed-tts-2.0'); });
  const chunks = [];
  const session = await openVolcengineTts({ ...options, config: { ...config, method: 'ws-bidirectional' }, connect, onAudio: chunk => { chunks.push(chunk); started(); } });
  t.after(() => session.cancel());
  await session.write('你'); await audioArrived; assert.equal(finishSession, false);
  await session.write('好。'); await session.finish(); await session.done;
  assert.deepEqual(input, ['你', '好。']); assert.equal(chunks.length, 2);
});

test('single-direction WebSocket sends one full request and requires SessionFinished', async t => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  const { decodeTtsFrame } = await import('../server/volcengine-protocol.js');
  let requests = 0;
  const connect = await fixture(t, (socket, data) => {
    const message = decodeTtsFrame(data);
    if (message.event === 2) { socket.send(response(52)); socket.close(); return; }
    assert.equal(message.event, 0); const payload = JSON.parse(message.payload); assert.equal(payload.req_params.text, '完整文本。'); requests++;
    socket.send(response(352, Buffer.from([1, 2]), { audio: true })); socket.send(response(152));
  });
  const session = await openVolcengineTts({ ...options, config: { ...config, method: 'ws-unidirectional' }, connect, onAudio() {} });
  await session.write('完整'); assert.equal(requests, 0); await session.write('文本。'); await session.finish(); await session.done;
  assert.equal(requests, 1);
});

for (const method of ['http-chunked', 'http-sse']) test(`${method} streams PCM before provider completion and handles split JSON/UTF8`, async () => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  let controller, received; const first = new Promise(resolve => { received = resolve; }); let requested = false;
  const wrap = data => method === 'http-sse' ? `event: 352\r\ndata: ${JSON.stringify(data)}\r\n\r\n` : `${JSON.stringify(data)}\n`;
  const request = async (url, init) => {
    requested = true; assert.equal(url, `https://openspeech.bytedance.com/api/v3/tts/unidirectional${method === 'http-sse' ? '/sse' : ''}`);
    assert.equal(init.headers['X-Api-Resource-Id'], 'seed-tts-2.0'); assert.equal(JSON.parse(init.body).req_params.text, '测试。');
    return new Response(new ReadableStream({ start(value) { controller = value; } }));
  };
  const chunks = [];
  const session = await openVolcengineTts({ ...options, config: { ...config, method }, request, onAudio: chunk => { chunks.push(chunk); received(); } });
  await session.write('测试。'); assert.equal(requested, false); await session.finish();
  const bytes = new TextEncoder().encode(wrap({ code: 0, message: '正常', data: 'AQIDBA==' }));
  controller.enqueue(bytes.subarray(0, 11)); controller.enqueue(bytes.subarray(11)); await first;
  assert.deepEqual(chunks, [Buffer.from([1, 2, 3, 4])]);
  controller.enqueue(new TextEncoder().encode(wrap({ code: 20000000 }))); controller.close(); await session.done;
});

test('stopping a live WebSocket cancels its own session and discards late audio', async t => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  const { decodeTtsFrame } = await import('../server/volcengine-protocol.js');
  let cancelled; const cancelSeen = new Promise(resolve => { cancelled = resolve; });
  const connect = await fixture(t, (socket, data) => {
    const message = decodeTtsFrame(data);
    if (message.event === 1) socket.send(response(50));
    if (message.event === 100) socket.send(response(150, {}, { session: message.sessionId }));
    if (message.event === 101) { cancelled(); socket.send(response(352, Buffer.from([1, 2]), { audio: true, session: message.sessionId })); }
  });
  const controller = new AbortController(); let played = 0;
  const session = await openVolcengineTts({ ...options, config: { ...config, method: 'ws-bidirectional' }, signal: controller.signal, connect, onAudio() { played++; } });
  const rejected = assert.rejects(session.done, /停止|取消/); controller.abort(); await rejected; await cancelSeen; assert.equal(played, 0);
});

test('WebSocket connection failure reads native status_code and hides raw service messages', async t => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  const connect = await fixture(t, socket => socket.send(response(51, { status_code: 45000030, message: `requested resource not granted ${key}` })));
  await assert.rejects(openVolcengineTts({ ...options, config: { ...config, method: 'ws-bidirectional' }, connect }), error => {
    assert.match(error.message, /45000030/); assert.ok(!error.message.includes(key)); return true;
  });
});

test('WebSocket failure status in SessionFinished is not accepted as successful audio', async t => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  const connect = await fixture(t, socket => {
    socket.send(response(352, Buffer.from([0, 0]), { audio: true }));
    socket.send(response(152, { status_code: 45000001, message: `private ${key}` }));
  });
  const session = await openVolcengineTts({ ...options, config: { ...config, method: 'ws-unidirectional' }, connect });
  await session.write('你好'); await session.finish();
  await assert.rejects(session.done, error => { assert.match(error.message, /45000001/); assert.ok(!error.message.includes(key)); return true; });
});

test('WebSocket premature close rejects partial audio and a silent handshake can be cancelled', async t => {
  const { openVolcengineTts } = await import('../server/volcengine-stream.js');
  const connect = await fixture(t, socket => { socket.send(response(352, Buffer.from([0, 0]), { audio: true })); socket.close(); });
  const session = await openVolcengineTts({ ...options, config: { ...config, method: 'ws-unidirectional' }, connect });
  await session.write('你好'); await session.finish(); await assert.rejects(session.done, /完整/);
  const controller = new AbortController(), silent = await fixture(t, () => controller.abort());
  await assert.rejects(openVolcengineTts({ ...options, config: { ...config, method: 'ws-bidirectional' }, signal: controller.signal, connect: silent }), /停止/);
});
