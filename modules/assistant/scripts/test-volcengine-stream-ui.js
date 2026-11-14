import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';
import { getVoiceRuntime } from '../server/voice-runtime.js';
import { decodeTtsFrame } from '../server/volcengine-protocol.js';

const root = process.cwd(), desktop = process.argv.includes('--desktop'), long = process.argv.includes('--long');
const evidence = path.join(root, long ? 'test-results/long-speech' : 'test-results/low-latency-voice');
const dir = await mkdtemp(path.join(tmpdir(), 'atb-volc-stream-')), runtimeDir = path.join(dir, 'data/assistant');
const key = 'isolated-synthetic-voice-key', rounds = [], errors = [], results = [];
const sampleRate = long ? 48000 : 24000, packetCount = long ? 24 : 2;
const pcm = Buffer.alloc(long ? 65536 : 4800); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 1500), i * 2);
const number = value => { const data = Buffer.alloc(4); data.writeUInt32BE(value); return data; };
function frame(event, payload, session = '') {
  const audio = event === 352, data = audio ? payload : Buffer.from(JSON.stringify(payload || {})), id = Buffer.from([50, 52].includes(event) ? 'connection' : session);
  return Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]), number(event), number(id.length), id, number(data.length), data]);
}
const upstream = http.createServer(async (req, res) => {
  let input = ''; for await (const part of req) input += part;
  const body = JSON.parse(input), sse = req.url.endsWith('/sse');
  assert.equal(req.headers['x-api-key'], key); assert.equal(body.req_params.audio_params.format, 'pcm'); assert.equal(body.req_params.text, '你好，欢迎回家。');
  res.writeHead(200, { 'Content-Type': sse ? 'text/event-stream' : 'application/json' });
  const send = data => res.write(sse ? `event: ${data.code === 0 ? 352 : 152}\ndata: ${JSON.stringify(data)}\n\n` : `${JSON.stringify(data)}\n`);
  const item = { completed: false, finish() { if (res.destroyed) return; this.completed = true; for (let i = 1; i < packetCount; i++) send({ code: 0, data: pcm.toString('base64') }); send({ code: 20000000 }); res.end(); } };
  rounds.push(item); send({ code: 0, data: pcm.toString('base64') });
});
const sockets = new WebSocketServer({ server: upstream });
sockets.on('connection', (socket, req) => {
  assert.equal(req.headers['x-api-key'], key); const single = req.url.includes('/unidirectional/'); let item;
  socket.on('message', data => {
    const message = decodeTtsFrame(data), payload = JSON.parse(message.payload);
    if (message.event === 1) socket.send(frame(50));
    if (message.event === 100) socket.send(frame(150, {}, message.sessionId));
    if (message.event === 200 || single && message.event === 0) {
      assert.equal(payload.req_params.audio_params.format, 'pcm'); assert.equal(payload.req_params.text, '你好，欢迎回家。');
      item = { completed: false, finish() { if (socket.readyState !== WebSocket.OPEN) return; this.completed = true; for (let i = 1; i < packetCount; i++) socket.send(frame(352, pcm, message.sessionId)); socket.send(frame(152, {}, message.sessionId)); } };
      rounds.push(item); socket.send(frame(352, pcm, message.sessionId));
    }
    if (message.event === 2) { socket.send(frame(52)); socket.close(); }
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const httpsPort = await freePort(), httpPort = await freePort();
let app, browser, service, page;
try {
  if (desktop) {
    const env = { ...process.env, ATB_DATA_DIR: dir, FREECAMERA_DATA_DIR: dir, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort), TURN_PORT: '0' }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root, '--mute-audio'], env });
    page = await app.firstWindow(); await page.waitForURL('**/platform', { timeout: 30000 });
    await app.evaluate(async (_, { url, dataDir, port }) => {
      const require = process.getBuiltinModule('module').createRequire(url);
      const runtime = require(url.startsWith('file:') ? process.getBuiltinModule('url').fileURLToPath(url) : url).getVoiceRuntime(dataDir), { WebSocket } = require('ws');
      runtime.ttsRequest = (url, options) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
      runtime.ttsConnect = (url, options) => new WebSocket(`ws://127.0.0.1:${port}${new URL(url).pathname}`, options);
    }, { url: pathToFileURL(path.join(root, 'modules/assistant/server/voice-runtime.js')).href, dataDir: runtimeDir, port: upstreamPort });
  } else {
    service = await startServers({ lanIp: '127.0.0.1', httpsPort, httpPort, relayPort: 0, certDir: path.join(dir, 'certs'), dataDir: path.join(dir, 'data'), detector: null });
    const runtime = getVoiceRuntime(runtimeDir);
    runtime.ttsRequest = (url, options) => fetch(`http://127.0.0.1:${upstreamPort}${new URL(url).pathname}`, options);
    runtime.ttsConnect = (url, options) => new WebSocket(`ws://127.0.0.1:${upstreamPort}${new URL(url).pathname}`, options);
    browser = await chromium.launch({ args: ['--mute-audio'] }); page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  }
  page.setDefaultTimeout(long ? 35000 : 10000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.pcmPlayed = []; const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this), start = source.start;
      source.start = function (...args) { const item = { at: performance.now(), samples: source.buffer.length, state: source.context.state, ended: false }; window.pcmPlayed.push(item); source.addEventListener('ended', () => { item.ended = true; }, { once: true }); return start.apply(this, args); };
      return source;
    };
  });
  await page.goto(`https://127.0.0.1:${httpsPort}/modules/assistant/`);
  await page.locator('#login').waitFor(); await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill('1'); await page.locator('[name=confirm]').fill('1'); await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor();
  await page.locator('[data-page=voice]').click(); await page.locator('#voice-provider').selectOption('volcengine');
  await page.locator('#tts-api-key').fill(key); await page.locator('#voice-preview-text').fill('你好，欢迎回家。');
  if (long) await page.locator('#tts-sample-rate').selectOption('48000');
  for (const method of ['ws-bidirectional', 'ws-unidirectional', 'http-chunked', 'http-sse']) {
    await page.locator(`[name=tts-method-choice][value="${method}"]`).check(); await page.locator('#voice-form [type=submit]').click(); await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
    const previous = await page.evaluate(() => window.pcmPlayed.length);
    await page.locator('#voice-preview').click(); await page.waitForFunction(count => window.pcmPlayed.length > count, previous);
    assert.equal(rounds.at(-1).completed, false, `${method} must play before provider completion`);
    assert.equal(await page.locator('#voice-result').textContent() === '试听播放完成', false);
    rounds.at(-1).finish(); await page.waitForFunction(() => document.querySelector('#voice-result').textContent === '试听播放完成');
    const played = await page.evaluate(start => window.pcmPlayed.slice(start), previous);
    assert.equal(played.reduce((sum, item) => sum + item.samples, 0), pcm.length / 2 * packetCount, 'every synthesized sample reaches playback');
    assert.ok(played.every(item => item.ended), 'all scheduled buffers end before success');
    const state = await page.evaluate(async () => window.atbDesktop?.hasModule('assistant') ? window.atbDesktop.invokeModule('assistant', 'voice', { action: 'status' }) : (await fetch('/api/assistant/voice/status')).json());
    assert.equal(state.pid, null); assert.equal(state.status, 'off'); assert.equal(state.settings.synthesisValidation?.method, method);
    results.push({ method, streamedBeforeCompletion: true, released: true, samples: pcm.length / 2 * packetCount, endedBuffers: played.length });
  }
  await page.locator('#voice-preview').click(); const count = rounds.length;
  await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'speaking');
  await page.locator('#voice-preview-stop').click(); await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
  const stopped = await page.evaluate(() => window.pcmPlayed.length); if (rounds.length >= count) rounds.at(-1).finish();
  await page.waitForTimeout(200); assert.equal(await page.evaluate(() => window.pcmPlayed.length), stopped);
  assert.deepEqual(errors, []); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, `volc-${desktop ? 'desktop' : 'browser'}-report.json`), JSON.stringify({ passed: true, results, cancellation: true, provider: 'local protocol fixture; real Web Audio scheduling, no paid API' }, null, 2));
  console.log(`PASS ${desktop ? 'desktop IPC' : 'browser HTTP'}: four real streaming adapters to PCM Web Audio, early playback, cancellation and no ASR process`);
} catch (error) {
  if (page && !page.isClosed()) console.error(await page.evaluate(() => ({ state: document.querySelector('#voice-live')?.textContent, error: document.querySelector('#voice-result')?.textContent })));
  throw error;
} finally {
  await browser?.close(); await app?.close(); await service?.close();
  for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
