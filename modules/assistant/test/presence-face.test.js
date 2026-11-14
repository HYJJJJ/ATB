import test from 'node:test';
import assert from 'node:assert/strict';
import * as faces from '../public/presence-face.js';

test('canceled enrollment finishes and releases its model before another account can extract faces', async t => {
  assert.equal(typeof faces.withFaceModel, 'function');
  const original = globalThis.faceapi, events = []; t.after(() => { if (original) globalThis.faceapi = original; else delete globalThis.faceapi; });
  globalThis.faceapi = { nets: Object.fromEntries(['tinyFaceDetector', 'faceLandmark68Net', 'faceRecognitionNet'].map(name => [name, { dispose() { events.push('dispose'); } }])) };
  let finish; const held = new Promise(resolve => { finish = resolve; }); const old = new AbortController();
  const first = faces.withFaceModel(async () => { events.push('old-start'); await held; old.signal.throwIfAborted(); }, old.signal);
  await new Promise(r => setImmediate(r)); old.abort();
  const second = faces.withFaceModel(async () => { events.push('new-start'); assert.equal(events.filter(e => e === 'dispose').length, 3); return 'new-account-features'; });
  await new Promise(r => setImmediate(r)); assert.deepEqual(events, ['old-start'], 'new inference waits for unabortable old inference');
  const rejection = assert.rejects(first, { name: 'AbortError' }); finish(); await rejection;
  assert.equal(await second, 'new-account-features'); assert.equal(events.filter(e => e === 'dispose').length, 6);
});
