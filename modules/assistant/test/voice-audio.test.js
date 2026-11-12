import test from 'node:test';
import assert from 'node:assert/strict';
import { resamplePcm16, pcmBase64, SpeechCollector, speechChunks } from '../public/voice-audio.js';

test('voice audio is 16kHz signed PCM and bounded utterances include a short pre-roll', () => {
  const input = Float32Array.from({ length: 4800 }, (_, i) => i < 2400 ? 0.5 : -0.5);
  const pcm = resamplePcm16(input, 48000);
  assert.equal(pcm.length, 1600); assert.equal(pcm[0], 16384); assert.equal(pcm[1599], -16384);
  assert.equal(Buffer.from(pcmBase64(pcm), 'base64').length, 3200);
  const collector = new SpeechCollector({ silenceMs: 600, maxMs: 20000 });
  for (let i = 0; i < 4; i++) assert.equal(collector.push(new Int16Array(1600)), null);
  for (let i = 0; i < 5; i++) assert.equal(collector.push(new Int16Array(1600).fill(8000)), null);
  let result; for (let i = 0; i < 6; i++) result = collector.push(new Int16Array(1600));
  assert.ok(result instanceof Int16Array); assert.ok(result.length <= 15 * 1600);
  assert.ok(result.some(value => value === 8000));
});

test('quiet input does not trigger ASR and long speech is capped at thirty seconds', () => {
  const collector = new SpeechCollector({ silenceMs: 1000, maxMs: 30000 });
  for (let i = 0; i < 500; i++) assert.equal(collector.push(new Int16Array(1600)), null);
  let result; for (let i = 0; i < 300 && !result; i++) result = collector.push(new Int16Array(1600).fill(10000));
  assert.ok(result instanceof Int16Array); assert.ok(result.length <= 480000);
});

test('long replies are spoken in bounded sentences without dropping the remainder', () => {
  const reply = '你好，这是第一句。'.repeat(80) + '没有句号的长句'.repeat(100);
  const chunks = speechChunks(reply);
  assert.equal(chunks.join(''), reply);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 500));
  assert.deepEqual(speechChunks(''), []);
});
