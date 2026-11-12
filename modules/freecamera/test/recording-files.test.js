import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { RecordingFiles, MAX_CHUNK_BYTES } = require('../desktop/recording-files.cjs');

test('desktop recordings serialize real writes and reject another window or oversized chunks', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-recording-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new RecordingFiles();
  t.after(() => files.closeAll());
  const filename = path.join(directory, 'capture.webm');
  const { id } = await files.begin(41, filename);
  await assert.rejects(files.write(42, id, new Uint8Array([9])), /owner|window/i);
  await assert.rejects(files.write(41, id, new Uint8Array(MAX_CHUNK_BYTES + 1)), /size|large/i);
  const first = files.write(41, id, new Uint8Array([1, 2, 3]));
  const second = files.write(41, id, new Uint8Array([4, 5]));
  const ended = files.end(41, id);
  await Promise.all([first, second]);
  assert.deepEqual(await ended, { path: filename });
  assert.deepEqual([...await readFile(filename)], [1, 2, 3, 4, 5]);
  await assert.rejects(files.write(41, id, new Uint8Array([6])), /recording|closed/i);
});

test('desktop closes and flushes recordings when the owning window exits', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new RecordingFiles();
  const filename = path.join(directory, 'interrupted.webm');
  const { id } = await files.begin(11, filename);
  const writing = files.write(11, id, new Uint8Array([7, 8, 9]));
  await files.closeOwner(11);
  await writing;
  assert.deepEqual([...await readFile(filename)], [7, 8, 9]);
  await assert.rejects(files.end(11, id), /recording|closed/i);
  await assert.rejects(files.begin(11, filename), /window|closed/i);
});

test('desktop allows only one pending or active recording per window', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new RecordingFiles();
  t.after(() => files.closeAll());
  const first = files.begin(3, path.join(directory, 'first.webm'));
  await assert.rejects(files.begin(3, path.join(directory, 'second.webm')), /already|pending/i);
  await first;
});
