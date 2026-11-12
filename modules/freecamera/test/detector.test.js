import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDetector } from '../server/detector.js';
import { decodeYolox } from '../server/detector-worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, { readyDelay = 0, resultDelay = 0, shutdownDelay = 0, ...options } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'freecamera-detector-'));
  const workerPath = path.join(folder, 'worker.cjs');
  await writeFile(workerPath, `
    process.on('message', message => {
      if (message.type === 'init') setTimeout(() => process.send?.({type:'ready'}), ${readyDelay});
      if (message.type === 'detect') setTimeout(() => process.send?.({type:'result', id:message.id, boxes:[{x:0.1,y:0.2,width:0.3,height:0.4,score:0.9}]}), ${resultDelay});
      if (message.type === 'shutdown') setTimeout(() => process.exit(0), ${shutdownDelay});
    });
    process.on('disconnect', () => process.exit(0));
  `);
  const detector = createDetector({ workerPath, startupTimeoutMs: 2000, inferenceTimeoutMs: 1000, stopTimeoutMs: 100, ...options });
  t.after(async () => { await detector.disable(); await rm(folder, { recursive: true, force: true }); });
  return detector;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function until(predicate, timeoutMs = 3000) {
  const expires = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= expires) assert.fail('Timed out waiting for detector state'); await delay(10); }
}

test('default off never starts a process or accepts a frame', async () => {
  const detector = createDetector();
  assert.deepEqual(detector.state, { status: 'off', pid: null, backend: 'CPU' });
  assert.equal(await detector.detect('unused'), null);
  assert.deepEqual(await detector.disable(), { status: 'off', pid: null, backend: 'CPU' });
});

test('disable waits for the real child to exit before announcing off', async t => {
  const detector = await fixture(t, { shutdownDelay: 60, stopTimeoutMs: 1000 });
  const states = [];
  detector.on('state', state => states.push(state));
  await detector.enable();
  const pid = detector.state.pid;
  assert.ok(isAlive(pid));
  const stopping = detector.disable();
  assert.equal(detector.state.status, 'stopping');
  assert.equal(detector.state.pid, pid);
  assert.ok(isAlive(pid));
  await stopping;
  assert.equal(isAlive(pid), false);
  assert.deepEqual(detector.state, { status: 'off', pid: null, backend: 'CPU' });
  assert.deepEqual(states.map(state => state.status), ['starting', 'on', 'stopping', 'off']);
});

test('disable during model loading cancels enable and reaps the loading child', async t => {
  const detector = await fixture(t, { readyDelay: 400 });
  const states = [];
  detector.on('state', state => states.push(state.status));
  const enabling = detector.enable();
  const pid = detector.state.pid;
  assert.ok(isAlive(pid));
  await detector.disable();
  await enabling;
  assert.equal(isAlive(pid), false);
  assert.equal(detector.state.status, 'off');
  assert.equal(states.includes('on'), false);
});

test('a busy detector drops extra frames and disabling cancels its in-flight frame', async t => {
  const detector = await fixture(t, { resultDelay: 150 });
  await detector.enable();
  const result = detector.detect('jpeg');
  assert.equal(await detector.detect('extra-frame'), null);
  assert.deepEqual(await result, [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.9 }]);
  const canceled = detector.detect('jpeg');
  await detector.disable();
  assert.equal(await canceled, null);
  assert.equal(detector.state.pid, null);
});

test('unexpected child death reports error after exit and permits a clean restart', async t => {
  const detector = await fixture(t);
  await detector.enable();
  const pid = detector.state.pid;
  assert.ok(isAlive(pid));
  process.kill(pid, 'SIGKILL');
  await until(() => detector.state.status === 'error');
  assert.equal(isAlive(pid), false);
  assert.equal(detector.state.pid, null);
  assert.match(detector.state.error, /exit|signal|stopped/i);
  await detector.enable();
  assert.equal(detector.state.status, 'on');
  assert.notEqual(detector.state.pid, pid);
});

test('startup timeout kills and reaps a worker before reporting an error', async t => {
  const detector = await fixture(t, { readyDelay: 10000, startupTimeoutMs: 80, stopTimeoutMs: 30 });
  const enabling = detector.enable();
  const pid = detector.state.pid;
  await assert.rejects(enabling, /timed out/i);
  assert.equal(isAlive(pid), false);
  assert.equal(detector.state.status, 'error');
  assert.equal(detector.state.pid, null);
});

test('inference timeout clears the in-flight frame and destroys its worker', async t => {
  const detector = await fixture(t, { resultDelay: 10000, inferenceTimeoutMs: 60, stopTimeoutMs: 30 });
  await detector.enable();
  const pid = detector.state.pid;
  await assert.rejects(detector.detect('jpeg'), /timed out/i);
  assert.equal(isAlive(pid), false);
  assert.equal(detector.state.status, 'error');
  assert.equal(detector.state.pid, null);
});

test('YOLOX decoding rescales person boxes, clips borders and suppresses duplicate people', () => {
  const data = new Float32Array(3 * 85);
  // stride 8, grid (0,0): center (32,32), size 32x48 in a 64px input.
  data.set([4, 4, Math.log(4), Math.log(6), 0.9, 0.8]);
  // grid (1,0): same person, lower score, must be suppressed.
  data.set([3, 4, Math.log(4), Math.log(6), 0.8, 0.8], 85);
  // grid (2,0): high confidence in a non-person class, must be discarded.
  data.set([0, 0, 0, 0, 0.99, 0.01, 0.99], 170);
  const boxes = decodeYolox(data, { inputSize: 64, imageWidth: 128, imageHeight: 64, ratio: 0.5, scoreThreshold: 0.4 });
  assert.equal(boxes.length, 1);
  assert.ok(Math.abs(boxes[0].x - 0.25) < 1e-5);
  assert.ok(Math.abs(boxes[0].y - 0.25) < 1e-5);
  assert.ok(Math.abs(boxes[0].width - 0.5) < 1e-5);
  assert.ok(Math.abs(boxes[0].height - 0.75) < 1e-5);
  assert.ok(Math.abs(boxes[0].score - 0.72) < 1e-5);
});

test('YOLOX decoder rejects padded-region boxes and malformed outputs', () => {
  const data = new Float32Array(85);
  data.set([2, 6, 0, 0, 1, 1]);
  assert.deepEqual(decodeYolox(data, { inputSize: 64, imageWidth: 128, imageHeight: 32, ratio: 0.5 }), []);
  assert.throws(() => decodeYolox(new Float32Array(84), { imageWidth: 10, imageHeight: 10, ratio: 1 }), /output/i);
});

const realModel = path.join(root, 'models', 'yolox_tiny.onnx');
const realImage = path.join(root, 'models', 'validation-person.jpg');
let realAvailable = false;
try { await access(realModel); await access(realImage); await import('onnxruntime-node'); await import('sharp'); realAvailable = true; } catch {}

test('real CPU model finds people and releases its process when disabled', { skip: !realAvailable, timeout: 60000 }, async t => {
  const detector = createDetector();
  t.after(() => detector.disable());
  await detector.enable();
  assert.equal(detector.state.backend, 'CPU');
  const pid = detector.state.pid;
  assert.ok(isAlive(pid));
  const boxes = await detector.detect((await readFile(realImage)).toString('base64'));
  assert.ok(boxes.length >= 1, `Expected people, got ${JSON.stringify(boxes)}`);
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0);
    assert.ok(box.x + box.width <= 1.00001 && box.y + box.height <= 1.00001);
    assert.ok(box.score >= 0.4 && box.score <= 1);
  }
  await detector.disable();
  assert.equal(isAlive(pid), false);
  assert.equal(detector.state.status, 'off');
});
