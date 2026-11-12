import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantVoice } from '../public/assistant-voice.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function controller(voice) {
  const states = [];
  const instance = createAssistantVoice({ native: { voice }, canChat: () => true, onState: state => states.push(state) });
  return { instance, states };
}

for (const action of ['read', 'start', 'interrupt']) test(`stop cancels ${action} while it waits for the previous worker to close`, async t => {
  const speaking = deferred(), closing = deferred(), closeEntered = deferred(), speechEntered = deferred(), lateOpen = deferred();
  const opened = [], spoken = []; let instance, pending, first;
  ({ instance } = controller(async (command, options) => {
    if (command === 'status') return { available: true, synthesisAvailable: true, settings: { enabled: true } };
    if (command === 'open') { opened.push(options.leaseId); return opened.length === 1 ? { leaseId: options.leaseId } : lateOpen.promise; }
    if (command === 'speak') { spoken.push(options.text); speechEntered.resolve(); return speaking.promise; }
    if (command === 'close' && options.leaseId === opened[0]) { closeEntered.resolve(); await closing.promise; }
  }));
  t.after(async () => {
    closing.resolve(); await instance.stop(); lateOpen.resolve({ leaseId: opened.at(-1) }); speaking.resolve({ audio: 'SUQz', mime: 'audio/mpeg' });
    await Promise.allSettled([first, pending]);
  });
  first = instance.read('朗读 A'); await speechEntered.promise;
  pending = (action === 'read' ? instance.read('朗读 B') : instance[action]()).catch(error => error);
  await closeEntered.promise; await instance.stop(); closing.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 1, 'a stopped pending request must not reopen the worker');
  assert.deepEqual(spoken, ['朗读 A']); assert.equal(instance.active, false);
});

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
    if (action === 'status') return { synthesisAvailable: true, settings: { enabled: true } };
    if (action === 'open') return { leaseId: 'preview' };
    if (action === 'speak') { entered.resolve(); return synthesis.promise; }
    if (action === 'close') closed.push(options.leaseId);
  });
  const preview = instance.preview(); await entered.promise;
  await instance.stop(); synthesis.resolve({ audio: 'SUQz', mime: 'audio/mpeg' }); await preview;
  assert.deepEqual(closed, ['preview']); assert.equal(instance.active, false);
  assert.equal(states.at(-1).phase, 'off');
});

test('preview opens synthesis only and reports cancelled playback rather than completion', async () => {
  const entered = deferred(), synthesis = deferred(); let mode;
  const { instance } = controller(async (action, options) => {
    if (action === 'status') return { available: false, synthesisAvailable: true, settings: { enabled: true } };
    if (action === 'open') { mode = options.mode; return { leaseId: 'speech-only' }; }
    if (action === 'speak') { entered.resolve(); return synthesis.promise; }
  });
  const reading = instance.preview(); await entered.promise;
  await instance.stop(); synthesis.resolve({ audio: 'SUQz', mime: 'audio/mpeg' });
  assert.equal(await reading, false);
  assert.equal(mode, 'synthesis');
});

test('read aloud rejects empty audio without claiming playback success', async () => {
  const { instance, states } = controller(async action => {
    if (action === 'status') return { synthesisAvailable: true, settings: { enabled: false } };
    if (action === 'open') return { leaseId: 'read-aloud' };
    if (action === 'speak') return { audio: '', mime: 'audio/mpeg' };
  });
  await assert.rejects(instance.read('测试朗读'), /有效音频/);
  assert.equal(instance.active, false); assert.equal(states.at(-1).phase, 'off');
});

test('playback failure releases the audio URL and its worker lease', async t => {
  const originalAudio = globalThis.Audio, originalRevoke = URL.revokeObjectURL;
  let paused = false, revoked = false, closed = false;
  t.after(() => { globalThis.Audio = originalAudio; URL.revokeObjectURL = originalRevoke; });
  globalThis.Audio = class {
    play() { return Promise.reject(Error('autoplay blocked')); }
    pause() { paused = true; }
    removeAttribute() {}
    load() {}
  };
  URL.revokeObjectURL = () => { revoked = true; };
  const { instance } = controller(async action => {
    if (action === 'status') return { synthesisAvailable: true, settings: { enabled: false } };
    if (action === 'open') return { leaseId: 'read-aloud' };
    if (action === 'speak') return { audio: 'SUQz', mime: 'audio/mpeg' };
    if (action === 'close') closed = true;
  });
  await assert.rejects(instance.read('测试朗读'), /允许声音播放/);
  assert.equal(paused, true); assert.equal(revoked, true); assert.equal(closed, true); assert.equal(instance.active, false);
});

test('system fallback reads without opening a microphone or synthesis worker and cancels cleanly', async t => {
  const originalSpeech = globalThis.speechSynthesis, originalUtterance = globalThis.SpeechSynthesisUtterance;
  t.after(() => { globalThis.speechSynthesis = originalSpeech; globalThis.SpeechSynthesisUtterance = originalUtterance; });
  let utterance;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = { getVoices: () => [{ lang: 'zh-CN' }], cancel() {}, speak(value) { utterance = value; } };
  const { instance, states } = controller(async action => {
    assert.equal(action, 'status', 'system fallback must not open a runtime or microphone');
    return { available: false, synthesisAvailable: false, settings: { enabled: false, rate: 0 } };
  });
  const reading = instance.read('系统朗读');
  while (!utterance) await new Promise(resolve => setImmediate(resolve));
  assert.equal(utterance.text, '系统朗读'); assert.match(states.at(-1).text, /系统语音/);
  await instance.stop(); assert.equal(await reading, false); assert.equal(instance.active, false);
});
