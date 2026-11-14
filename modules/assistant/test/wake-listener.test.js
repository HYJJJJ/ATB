import test from 'node:test';
import assert from 'node:assert/strict';

const wake = await import('../public/wake-listener.js').catch(() => ({}));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('wake matching follows the current name, accepts custom phrases and preserves the trailing request', () => {
  assert.equal(typeof wake.matchWakePhrase, 'function', 'local wake phrase matcher is available');
  const settings = { name: '小鲸鱼', phrases: ['你好助手', 'ATB', '小鲸鱼在吗'] };
  assert.deepEqual(wake.matchWakePhrase('小鲸鱼在吗，明天 8:30 叫我', settings), { phrase: '小鲸鱼在吗', remainder: '明天 8:30 叫我' });
  assert.equal(wake.matchWakePhrase('嗨，小 鲸 鱼，余额还有1.22元吗？', settings).remainder, '余额还有1.22元吗？');
  assert.equal(wake.matchWakePhrase('你好助手', settings).remainder, '');
  assert.equal(wake.matchWakePhrase('atb, what time is it?', settings).remainder, 'what time is it?');
  assert.equal(wake.matchWakePhrase('我刚才说小鲸鱼很好听', settings), null);
  assert.equal(wake.matchWakePhrase('ATBest', settings), null);
  assert.equal(wake.matchWakePhrase('小鲸鱼今天好吗', { name: '小海豚' }), null);
  assert.ok(wake.matchWakePhrase('小海豚', { name: '小海豚' }));
});

test('Chinese wake names tolerate ASR homophones and nasal endings without matching unrelated openings', () => {
  assert.equal(typeof wake.matchWakePhrase, 'function');
  assert.deepEqual(wake.matchWakePhrase('小金鱼今天24度吗？', { name:'小鲸鱼' }), { phrase:'小鲸鱼', remainder:'今天24度吗？' });
  assert.ok(wake.matchWakePhrase('良胜，早上好', { name:'梁圣' }));
  assert.ok(wake.matchWakePhrase('小程欣，早上好', { name:'小晨星' }));
  assert.ok(wake.matchWakePhrase('小囊瓜，早上好', { name:'小南瓜' }));
  assert.equal(wake.matchWakePhrase('我在说小金鱼', { name:'小鲸鱼' }), null);
  assert.equal(wake.matchWakePhrase('小海豚今天好吗', { name:'小鲸鱼' }), null);
});

test('Chinese names prefixed with 小 also wake by their full two-or-more-syllable nickname', () => {
  const settings = { name: '小鲸鱼', phrases: ['鲸鱼在吗'] };
  for (const text of ['鲸鱼，今天24度吗？', '金鱼，今天24度吗？', '你好，金鱼，今天24度吗？']) {
    assert.deepEqual(wake.matchWakePhrase(text, settings), { phrase: '小鲸鱼', remainder: '今天24度吗？' });
  }
  assert.deepEqual(wake.matchWakePhrase('金鱼在吗，现在几点？', settings), { phrase: '鲸鱼在吗', remainder: '现在几点？' });
  assert.deepEqual(wake.matchWakePhrase('金鱼', settings), { phrase: '小鲸鱼', remainder: '' });
  assert.deepEqual(wake.matchWakePhrase('海豚，早上好', { name: '小海豚' }), { phrase: '小海豚', remainder: '早上好' });
  assert.equal(wake.matchWakePhrase('金鱼', { name: '小海豚' }), null, 'old nickname stops matching after a rename');
});

test('nickname tolerance cannot shorten custom commands, single-syllable names or arbitrary names', () => {
  assert.equal(wake.matchWakePhrase('我家的金鱼很可爱', { name: '小鲸鱼' }), null);
  assert.equal(wake.matchWakePhrase('基于现在几点', { name: '小鲸鱼' }), null, 'losing a consonant must not turn a common expression into a wake word');
  assert.equal(wake.matchWakePhrase('小鲸今天好吗', { name: '小鲸鱼' }), null);
  assert.equal(wake.matchWakePhrase('明，早上好', { name: '小明' }), null);
  assert.equal(wake.matchWakePhrase('鲸鱼，早上好', { name: '大鲸鱼' }), null);
  assert.equal(wake.matchWakePhrase('助手，早上好', { name: '小鲸鱼', phrases: ['小助手'] }), null);
  assert.equal(wake.matchWakePhrase('海豚', { name: '小鲸鱼', phrases: ['小海豚在吗'] }), null);
});

test('the local pronunciation dictionary and redistributed license match pinned provenance', async () => {
  const { readFile } = await import('node:fs/promises'); const { createHash } = await import('node:crypto');
  const provenance = JSON.parse(await readFile(new URL('../docs/licenses/pinyin-pro/provenance.json', import.meta.url), 'utf8'));
  for (const [name, relative] of [['pinyin-pro.js','../public/vendor/pinyin-pro/pinyin-pro.js'], ['LICENSE','../docs/licenses/pinyin-pro/LICENSE']]) {
    assert.equal(createHash('sha256').update(await readFile(new URL(relative, import.meta.url))).digest('hex'), provenance.files[name]);
  }
  assert.equal(provenance.license, 'MIT'); assert.equal(provenance.version, '3.28.1');
});

async function harness(t, { pendingMic = false } = {}) {
  assert.equal(typeof wake.createWakeListener, 'function', 'standby listener is available');
  const descriptors = Object.fromEntries(['navigator', 'AudioContext', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let capture, stopped = 0, micCalls = 0, resolveMic, nextText = '', phrase = '小鲸鱼';
  const calls = [], wakes = [], errors = [], stream = { getTracks: () => [{ stop() { stopped++; } }] };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { micCalls++; return pendingMic ? new Promise(resolve => { resolveMic = resolve; }) : stream; } } } });
  globalThis.AudioContext = class { sampleRate = 16000; destination = {}; audioWorklet = { async addModule() {} }; async resume() {} async close() {} createMediaStreamSource() { return { connect() {}, disconnect() {} }; } };
  globalThis.AudioWorkletNode = class { constructor() { capture = this; this.port = { close() {} }; } connect() {} disconnect() {} };
  const listener = wake.createWakeListener({
    call: async (action, options) => { calls.push({ action, options }); if (action === 'wakeOpen') return { leaseId: options.leaseId }; if (action === 'transcribe') return { text: nextText }; return {}; },
    getPhrases: () => ({ name: phrase }), onWake: value => { assert.equal(stopped, 1, 'standby capture is released before conversation starts'); wakes.push(value); }, onError: error => errors.push(error),
  });
  t.after(async () => { await listener.stop(); for (const [key, value] of Object.entries(descriptors)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  const emit = text => { nextText = text; for (let i = 0; i < 4; i++) capture.port.onmessage({ data: new Float32Array(1600).fill(.1).buffer }); for (let i = 0; i < 7; i++) capture.port.onmessage({ data: new Float32Array(1600).buffer }); };
  return { listener, calls, wakes, errors, emit, rename: name => { phrase = name; }, releaseMic: () => resolveMic(stream), get stopped() { return stopped; }, get micCalls() { return micCalls; } };
}

test('standby discards unrelated speech locally, updates its name live and promotes only once', async t => {
  const h = await harness(t); await Promise.all([h.listener.start(), h.listener.start()]);
  assert.equal(h.micCalls, 1);
  h.emit('今天吃什么'); await flush(); assert.equal(h.wakes.length, 0); assert.equal(h.listener.active, true);
  h.rename('小海豚'); h.emit('小鲸鱼'); await flush(); assert.equal(h.wakes.length, 0);
  h.emit('小海豚，今天24度吗'); await flush();
  assert.deepEqual(h.wakes, [{ phrase: '小海豚', remainder: '今天24度吗' }]); assert.equal(h.listener.active, false);
  assert.equal(h.calls.filter(c => c.action === 'wakeOpen').length, 1);
  assert.equal(h.calls.at(-1).action, 'close'); assert.deepEqual(h.errors, []);
});

test('standby wakes from an ASR homophone nickname and forwards the unchanged request once', async t => {
  const h = await harness(t); await h.listener.start();
  h.emit('我家的金鱼很好看'); await flush(); assert.deepEqual(h.wakes, []);
  h.emit('金鱼，余额还有1.22元吗？'); await flush();
  assert.deepEqual(h.wakes, [{ phrase: '小鲸鱼', remainder: '余额还有1.22元吗？' }]);
  assert.equal(h.listener.active, false);
  h.emit('金鱼，余额还有1.22元吗？'); await flush(); assert.equal(h.wakes.length, 1);
  assert.deepEqual(h.errors, []);
});

test('stopping during microphone permission prevents late capture and wake-up', async t => {
  const h = await harness(t, { pendingMic: true }); const start = h.listener.start(); await flush();
  assert.equal(h.micCalls, 1); await h.listener.stop(); h.releaseMic(); await start;
  assert.equal(h.stopped, 1); assert.equal(h.listener.active, false); assert.deepEqual(h.wakes, []);
});
