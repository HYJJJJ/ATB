import test from 'node:test';
import assert from 'node:assert/strict';
import { resamplePcm16, pcmBase64, SpeechCollector, speechChunks, BargeInDetector } from '../public/voice-audio.js';

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


test('barge-in rejects quiet residual audio and a short click but retains a sustained new utterance onset', () => {
  const gate = new BargeInDetector();
  for (let i = 0; i < 20; i++) assert.equal(gate.push(new Int16Array(1600).fill(300)), null);
  assert.equal(gate.push(new Int16Array(1600).fill(8000)), null);
  assert.equal(gate.push(new Int16Array(1600)), null);
  for (let i = 0; i < 4; i++) assert.equal(gate.push(new Int16Array(1600).fill(6000)), null);
  const onset = gate.push(new Int16Array(1600).fill(6000));
  assert.ok(onset instanceof Int16Array); assert.equal(onset.filter(x => x === 6000).length, 8000);
  assert.ok(onset.length <= 12800);
});

test('the default barge-in threshold ignores minor sustained sounds and separated impacts', () => {
  const gate = new BargeInDetector();
  for (let i = 0; i < 60; i++) assert.equal(gate.push(new Int16Array(1600).fill(1800)), null);
  for (let i = 0; i < 20; i++) {
    assert.equal(gate.push(new Int16Array(1600).fill(15000)), null);
    assert.equal(gate.push(new Int16Array(1600)), null);
  }
  for (let i = 0; i < 4; i++) assert.equal(gate.push(new Int16Array(1600).fill(6000)), null);
  assert.ok(gate.push(new Int16Array(1600).fill(6000)) instanceof Int16Array);
});

test('barge-in volume and sustained duration settings both change when interruption occurs', () => {
  const gate = new BargeInDetector({ threshold: 25, durationMs: 800 });
  for (let i = 0; i < 12; i++) assert.equal(gate.push(new Int16Array(1600).fill(6000)), null);
  gate.configure({ threshold: 12, durationMs: 800 });
  for (let i = 0; i < 7; i++) assert.equal(gate.push(new Int16Array(1600).fill(6000)), null);
  const onset = gate.push(new Int16Array(1600).fill(6000));
  assert.ok(onset instanceof Int16Array); assert.equal(onset.filter(x => x === 6000).length, 12800);
});
