import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantVoice } from '../public/assistant-voice.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function controller(voice) {
  const states = [];
  const instance = createAssistantVoice({ native: { voice }, canChat: () => true, onState: state => states.push(state) });
  return { instance, states };
}

test('stopping while a model opens closes the late lease without opening the microphone', async () => {
  const opening = deferred(), entered = deferred(), closed = []; let requested;
  const { instance, states } = controller(async (action, options) => {
    if (action === 'status') return { available: true, settings: { enabled: true } };
    if (action === 'open') { requested = options.leaseId; entered.resolve(); return opening.promise; }
    if (action === 'close') closed.push(options.leaseId);
  });
  const starting = instance.start(); await entered.promise;
  await instance.stop(); assert.deepEqual(closed, [requested]);
  opening.resolve({ leaseId: requested }); await starting;
  assert.deepEqual(closed, [requested, requested]); assert.equal(instance.active, false);
  assert.equal(states.at(-1).phase, 'off');
});

test('stopping a pending preview prevents its late audio from playing', async () => {
  const synthesis = deferred(), entered = deferred(), closed = [];
  const { instance, states } = controller(async (action, options) => {
    if (action === 'status') return { settings: { enabled: true } };
    if (action === 'open') return { leaseId: 'preview' };
    if (action === 'speak') { entered.resolve(); return synthesis.promise; }
    if (action === 'close') closed.push(options.leaseId);
  });
  const preview = instance.preview(); await entered.promise;
  await instance.stop(); synthesis.resolve({ audio: 'SUQz', mime: 'audio/mpeg' }); await preview;
  assert.deepEqual(closed, ['preview']); assert.equal(instance.active, false);
  assert.equal(states.at(-1).phase, 'off');
});
