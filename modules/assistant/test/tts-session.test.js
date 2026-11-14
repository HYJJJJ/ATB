import test from 'node:test';
import assert from 'node:assert/strict';

test('audio queue exposes the first PCM before completion and bounds each pull', async () => {
  const { TtsAudioQueue } = await import('../server/tts-session.js');
  const queue = new TtsAudioQueue({ limit: 16, batch: 4 });
  const waiting = queue.read(); queue.push(Buffer.from([1, 2, 3, 4, 5, 6]));
  const first = await waiting; assert.equal(first.done, false); assert.deepEqual(Buffer.from(first.audio, 'base64'), Buffer.from([1, 2, 3, 4]));
  queue.end(); const final = await queue.read(); assert.equal(final.done, true); assert.deepEqual(Buffer.from(final.audio, 'base64'), Buffer.from([5, 6]));
});
test('slow readers, parallel reads and failed/cancelled output cannot accumulate or play late data', async () => {
  const { TtsAudioQueue } = await import('../server/tts-session.js');
  const queue = new TtsAudioQueue({ limit: 4 });
  const pending = queue.read(); await assert.rejects(queue.read(), /读取/);
  queue.fail(Error('语音已停止')); await assert.rejects(pending, /停止/);
  queue.push(Buffer.from([1, 2])); await assert.rejects(queue.read(), /停止/);
  const slow = new TtsAudioQueue({ limit: 4 }); assert.throws(() => slow.push(Buffer.alloc(5)), /缓冲/);
});

test('network writes larger than the queue wait for bounded reads without losing samples', async () => {
  const { TtsAudioQueue } = await import('../server/tts-session.js');
  const queue = new TtsAudioQueue({ limit: 4, batch: 2 });
  let completed = false;
  const writing = queue.write(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).then(() => { completed = true; queue.end(); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.throws(() => queue.push(Buffer.from([11])), /缓冲/);
  await assert.rejects(queue.write(Buffer.from([11])), /写入/);
  const chunks = [];
  for (;;) { const part = await queue.read(); chunks.push(Buffer.from(part.audio, 'base64')); if (part.done) break; }
  await writing;
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
});

test('cancel wakes a producer blocked by a full queue and rejects without late audio', async () => {
  const { TtsAudioQueue } = await import('../server/tts-session.js');
  const queue = new TtsAudioQueue({ limit: 4, batch: 2 });
  const writing = queue.write(Buffer.alloc(10));
  const rejected = assert.rejects(writing, { name: 'AbortError' });
  queue.fail(new DOMException('语音已停止', 'AbortError'));
  await rejected; await assert.rejects(queue.read(), { name: 'AbortError' });
});
