import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { VoiceRuntime } from '../server/voice-runtime.js';
import { decodeTtsFrame } from '../server/volcengine-protocol.js';
import { createVolcengineSpeech } from '../public/volcengine-speech.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const packet = Buffer.alloc(65536, 17), packetCount = 24;
function frame(event, payload = {}, session = '') {
  const audio = event === 352, data = audio ? payload : Buffer.from(JSON.stringify(payload));
  const id = Buffer.from([50, 52].includes(event) ? 'connection' : session);
  const integer = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]), integer(event), integer(id.length), id, integer(data.length), data]);
}
for (const method of ['http-chunked', 'http-sse', 'ws-unidirectional', 'ws-bidirectional']) {
  test(`${method} preserves long reply audio when synthesis outruns playback`, { timeout: 15000 }, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atb-long-speech-'));
    let requests = 0;
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    server.on('connection', socket => socket.on('message', bytes => {
      const m = decodeTtsFrame(bytes);
      if (m.event === 1) socket.send(frame(50));
      if (m.event === 100) socket.send(frame(150, {}, m.sessionId));
      if (m.event === 0 || m.event === 200) {
        requests++;
        for (let i = 0; i < packetCount; i++) socket.send(frame(352, packet, m.sessionId));
        if (m.event === 0) socket.send(frame(152, {}, m.sessionId));
      }
      if (m.event === 102) socket.send(frame(152, {}, m.sessionId));
      if (m.event === 2) socket.close();
    }));
    const runtime = new VoiceRuntime({ dataDir: dir, ttsRequest: async () => {
      requests++;
      const wrap = value => method === 'http-sse' ? `data: ${JSON.stringify(value)}\n\n` : `${JSON.stringify(value)}\n`;
      return new Response(wrap({ code: 0, data: packet.toString('base64') }).repeat(packetCount) + wrap({ code: 20000000 }));
    }, ttsConnect: (_url, settings) => new WebSocket(`ws://127.0.0.1:${server.address().port}`, settings) });
    t.after(async () => {
      await runtime.dispose();
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    await runtime.configure({ provider: 'volcengine', volcengine: { apiKey: 'test-only', method, sampleRate: 48000 } });
    const { leaseId } = await runtime.open('reader', { mode: 'synthesis' });
    let total = 0, finishes = 0;
    const speech = createVolcengineSpeech({ method, leaseId,
      call: (action, args) => runtime[action]('reader', args),
      createPlayer: () => ({ async write(audio) {
        const bytes = Buffer.from(audio, 'base64');
        assert.ok(bytes.every(value => value === 17)); total += bytes.length;
        await pause(5); // Playback scheduling deliberately drains slower than the provider.
      }, async finish() { finishes++; return true; }, stop() {} }),
    });
    speech.write('第一句需要完整读完。第二句也要继续读完。最后一句不能丢失。'); speech.finish();
    assert.equal(await speech.done, true);
    assert.equal(total, packet.length * packetCount * (method === 'ws-bidirectional' ? 1 : 3));
    assert.equal(requests, method === 'ws-bidirectional' ? 1 : 3, 'no paid request retries');
    assert.equal(finishes, 1);

    // Stop with the player stalled and more than 1 MiB still arriving. Both
    // producer and consumer must settle, and a fresh lease must work afterwards.
    const controller = new AbortController();
    let began, releasePlayback; const playing = new Promise(resolve => { began = resolve; });
    const cancelled = createVolcengineSpeech({ method, leaseId, signal: controller.signal,
      call: (action, args) => runtime[action]('reader', args),
      createPlayer: () => ({ write() { began(); return new Promise(resolve => { releasePlayback = resolve; }); }, async finish() { return true; }, stop() { releasePlayback?.(); } }),
    });
    cancelled.write('这一段会在缓冲等待时被用户停止。'); cancelled.finish();
    await playing; await pause(30);
    controller.abort(); await runtime.close('reader', leaseId);
    assert.equal(await cancelled.done, false);
    const reopened = await runtime.open('reader', { mode: 'synthesis' });
    let recoveredBytes = 0;
    const recovered = createVolcengineSpeech({ method, leaseId: reopened.leaseId,
      call: (action, args) => runtime[action]('reader', args),
      createPlayer: () => ({ async write(audio) { recoveredBytes += Buffer.from(audio, 'base64').length; }, async finish() { return true; }, stop() {} }),
    });
    recovered.write('重新开始后仍然完整播放。'); recovered.finish();
    assert.equal(await recovered.done, true); assert.equal(recoveredBytes, packet.length * packetCount);
  });
}
