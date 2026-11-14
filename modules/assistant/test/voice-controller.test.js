import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantVoice } from '../public/assistant-voice.js';
import { handlePresenceUtterance } from '../public/presence-conversation.js';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('native cancellation is not reported as a synthesis failure or successful playback', async () => {
  const { instance, states } = controller(async action => {
    if (action === 'status') return {available:true,synthesisAvailable:true,settings:{provider:'volcengine',volcengine:{method:'ws-bidirectional'}}};
    if (action === 'open') return {leaseId:'cancelled-stream'};
    if (action === 'ttsStart') return {cancelled:true};
    if (action === 'close') return {ok:true};
  });
  assert.equal(await instance.read('查询新闻中'),false);
  assert.equal(instance.active,false);
  assert.equal(states.at(-1).phase,'off');
});

async function conversationHarness(t, { autoInterrupt = true, bargeInThreshold = 10, bargeInDurationMs = 500, conversationSettings = () => ({}), canInitiateConversation = () => true, autoListen = true, initialText = '', recognizedTexts = ['第一轮', '第二轮'], presenceControls = false, wakeReply = '', startIdle = false, sendReply } = {}) {
  const descriptors = Object.fromEntries(['navigator', 'AudioContext', 'AudioWorkletNode', 'Audio'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const players = [], opens = [], closes = [], transcriptions = [], turns = [], errors = [], states = [], presenceRequests = [], spoken = [], errorStates = [];
  const reopening = deferred(), closeRelease = deferred(); let capture, stopped = 0, micCalls = 0, interruptions = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() { micCalls++; return { getTracks: () => [{ stop() { stopped++; } }] }; } } } });
  globalThis.AudioContext = class {
    sampleRate = 16000; destination = {}; audioWorklet = { async addModule() {} };
    async resume() {} async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  };
  globalThis.AudioWorkletNode = class { constructor() { capture = this; this.port = { close() {} }; } connect() {} disconnect() {} };
  globalThis.Audio = class {
    constructor() { players.push(this); }
    async setSinkId(id) { this.sinkId = id; }
    play() { this.onplaying?.(); return Promise.resolve(); }
    pause() { this.paused = true; } removeAttribute() {} load() {}
  };
  const instance = createAssistantVoice({ canChat: () => true, getConversationSettings: conversationSettings, canInitiateConversation, onState: state => states.push(state), onError: error => { errors.push(error); errorStates.push({active:instance.active,phase:states.at(-1)?.phase}); }, onInterrupt: () => { interruptions++; },
    sendMessage: async (text, options) => {
      if (presenceControls && await handlePresenceUtterance({ text, signal: options.signal, request: async (_url, body) => { presenceRequests.push(body); }, stop: () => instance.stop() })) return '';
      const done = deferred(); turns.push({ text, options, done }); if(sendReply)return sendReply(text,options); options.onDelta('这是仍在播放的回复。'); return done.promise;
    },
    native: { voice: async (action, options) => {
      if (action === 'status') return { available: true, synthesisAvailable: true, settings: { enabled: true, provider: 'qwen3tts', autoListen, autoInterrupt, bargeInThreshold, bargeInDurationMs, silenceMs: 400 } };
      if (action === 'open') { opens.push(options.leaseId); if (opens.length > 1) await reopening.promise; return { leaseId: options.leaseId }; }
      if (action === 'close') { closes.push(options.leaseId); if (options.leaseId === opens[0]) await closeRelease.promise; return {}; }
      if (action === 'transcribe') { transcriptions.push(Buffer.from(options.pcm, 'base64')); return { text: recognizedTexts[transcriptions.length - 1] || '第二轮' }; }
      if (action === 'speak') { spoken.push(options); return { audio: 'UklGRg==', mime: 'audio/wav' }; }
      if (action === 'heartbeat') return {};
      throw Error('Unexpected action: ' + action);
    } },
  });
  t.after(async () => { closeRelease.resolve(); reopening.resolve(); await instance.stop(); turns.forEach(turn => turn.done.resolve('旧回复')); await flush(); for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const emit = (value, frames) => { for (let i = 0; i < frames; i++) capture.port.onmessage({ data: new Float32Array(1600).fill(value).buffer }); };
  instance.setOutputDevice(startIdle ? 'fixture-output' : '');
  const starting = instance.start({ initialText, wakeReply });
  if (!startIdle) { await starting; if (!initialText) { emit(.2, 4); emit(0, 4); } }
  await flush();
  if (!startIdle) assert.equal(players.length, 1, 'first turn must be actively playing before interruption');
  return { instance, emit, opens, closes, transcriptions, turns, players, errors, states, reopening, closeRelease, presenceRequests, spoken, starting, errorStates,
    get stopped() { return stopped; }, get micCalls() { return micCalls; }, get interruptions() { return interruptions; } };
}

test('failed news reply stops speech before reporting the cause and a new turn recovers', async t => {
  const searching=deferred();
  const h=await conversationHarness(t,{initialText:'查近期新闻',startIdle:true,sendReply:async(text,{onDelta})=>{
    if(text==='查近期新闻'){onDelta('我查一下。');return searching.promise;}
    onDelta('可以，接着聊。');return '可以，接着聊。';
  }});
  await h.starting; await flush();
  h.closeRelease.resolve();searching.reject(Error('新闻搜索后模型 HTTP 503'));
  await flush();
  assert.deepEqual(h.errors,['新闻搜索后模型 HTTP 503']);
  assert.deepEqual(h.errorStates,[{active:false,phase:'off'}],'widget suppresses notices while voice is active');
  assert.equal(h.turns[0].options.signal.aborted,true);
  h.reopening.resolve();await h.instance.start({initialText:'接着聊'});await flush();
  h.players.at(-1).onended();await flush();
  assert.equal(h.instance.active,true);assert.equal(h.states.at(-1).phase,'listening');
  assert.equal(h.errors.length,1);
});

test('waiting for a slow news tool does not count as listening inactivity or start empty synthesis', async t => {
  const searched=deferred(),now=Date.now;
  const h=await conversationHarness(t,{initialText:'查近期新闻',startIdle:true,sendReply:async(_text,{onDelta})=>{
    await searched.promise;onDelta('查到了，这是新闻摘要。');return '查到了，这是新闻摘要。';
  }});
  await h.starting;await flush();
  assert.equal(h.states.at(-1).phase,'thinking');assert.deepEqual(h.spoken,[]);
  try { Date.now=()=>now()+70000;h.emit(0,20);await flush(); }
  finally { Date.now=now; }
  assert.equal(h.instance.active,true);assert.deepEqual(h.closes,[]);assert.deepEqual(h.errors,[]);
  searched.resolve();await flush();assert.equal(h.players.length,1);
  h.players[0].onended();await flush();assert.equal(h.states.at(-1).phase,'listening');
});

test('speech interrupts playback, cancels the old request and retains onset while the lease reopens', async t => {
  const h = await conversationHarness(t);
  h.emit(.16, 5); await flush();
  assert.equal(h.interruptions, 1); assert.equal(h.players[0].paused, true);
  assert.equal(h.turns[0].options.signal.aborted, true); assert.equal(h.stopped, 0); assert.equal(h.micCalls, 1);
  h.emit(.16, 3); h.emit(0, 4); await flush();
  assert.equal(h.transcriptions.length, 1, 'new utterance waits for the replacement lease');
  h.closeRelease.resolve(); await flush(); assert.equal(h.opens.length, 2);
  h.reopening.resolve(); await flush();
  assert.equal(h.transcriptions.length, 2); assert.equal(h.turns[1].text, '第二轮');
  assert.ok(h.transcriptions[1].length >= 16000, 'retain both detected onset and subsequent speech');
  assert.ok(h.transcriptions[1].readInt16LE(0) > 4000, 'the new utterance must include its first voiced samples');
  const playerCount = h.players.length;
  h.turns[0].options.onDelta('不应再播放的旧内容。'); h.turns[0].done.resolve('旧轮最终回复'); await flush();
  assert.equal(h.players.length, playerCount, 'late old chunks must not play');
  h.turns[1].done.resolve('新回复'); h.players.at(-1).onended(); await flush();
  assert.equal(h.states.at(-1).phase, 'listening'); assert.deepEqual(h.errors, []);
});

test('wake acknowledgement uses the selected output and current lease before listening, without a model turn', async t => {
  const h = await conversationHarness(t, { wakeReply: '在呢，叫我干嘛呀？', startIdle: true });
  assert.deepEqual(h.spoken.map(item => item.text), ['在呢，叫我干嘛呀？']);
  assert.equal(h.spoken[0].leaseId, h.opens[0]); assert.equal(h.players[0].sinkId, 'fixture-output');
  assert.equal(h.micCalls, 0, 'do not capture the acknowledgement as user speech');
  assert.equal(h.turns.length, 0); assert.equal(h.states.at(-1).phase, 'speaking');
  h.players[0].onended(); await h.starting;
  assert.equal(h.micCalls, 1); assert.equal(h.opens.length, 1); assert.equal(h.states.at(-1).phase, 'listening');
  h.emit(.2, 4); h.emit(0, 4); await flush();
  assert.equal(h.turns.length, 1); assert.equal(h.turns[0].text, '第一轮');
});

test('wake acknowledgement finishes before a same-utterance question is sent exactly once', async t => {
  const h = await conversationHarness(t, { wakeReply: '嗯，我在听', initialText: '今天几度？', startIdle: true });
  assert.equal(h.turns.length, 0); assert.equal(h.players.length, 1);
  h.players[0].onended(); await h.starting; await flush();
  assert.deepEqual(h.turns.map(turn => turn.text), ['今天几度？']); assert.equal(h.transcriptions.length, 0);
  h.turns[0].done.resolve('24度。'); h.players[1].onended(); await flush();
  assert.equal(h.states.at(-1).phase, 'listening'); assert.equal(h.opens.length, 1);
});

test('stopping during a wake acknowledgement cancels audio and never opens the microphone or sends the trailing request', async t => {
  const h = await conversationHarness(t, { wakeReply: '在呢', initialText: '帮我查天气', startIdle: true });
  assert.equal(h.players.length, 1); h.closeRelease.resolve(); await h.instance.stop(); await h.starting;
  assert.equal(h.players[0].paused, true); assert.equal(h.micCalls, 0); assert.equal(h.turns.length, 0);
  assert.equal(h.states.at(-1).phase, 'off'); assert.equal(h.instance.active, false);
});

test('manual voice start does not add a wake acknowledgement', async t => {
  const h = await conversationHarness(t, { startIdle: true }); await h.starting;
  assert.equal(h.players.length, 0); assert.deepEqual(h.spoken, []); assert.equal(h.turns.length, 0);
  assert.equal(h.micCalls, 1); assert.equal(h.states.at(-1).phase, 'listening');
});

test('a failed wake acknowledgement reports synthesis failure and releases its lease', async () => {
  let closed = false;
  const { instance, states } = controller(async action => {
    if (action === 'status') return { available: true, synthesisAvailable: true, settings: { enabled: true, provider: 'qwen3tts' } };
    if (action === 'open') return { leaseId: 'wake-failed' };
    if (action === 'speak') throw Error('合成服务暂不可用');
    if (action === 'close') closed = true;
  });
  await assert.rejects(instance.start({ wakeReply: '我在' }), /合成服务暂不可用/);
  assert.equal(closed, true); assert.equal(instance.active, false); assert.equal(states.at(-1).phase, 'off');
});

test('stopping during wake synthesis discards late audio before opening capture', async t => {
  const synthesis = deferred(), entered = deferred(); let closed = false;
  const { instance, states } = controller(async action => {
    if (action === 'status') return { available: true, synthesisAvailable: true, settings: { enabled: true, provider: 'qwen3tts' } };
    if (action === 'open') return { leaseId: 'wake-cancelled' };
    if (action === 'speak') { entered.resolve(); return synthesis.promise; }
    if (action === 'close') closed = true;
  });
  t.after(async () => { await instance.stop(); synthesis.resolve({ audio: 'UklGRg==', mime: 'audio/wav' }); });
  const starting = instance.start({ wakeReply: '在呢' }); await entered.promise;
  await instance.stop(); synthesis.resolve({ audio: 'UklGRg==', mime: 'audio/wav' }); await starting;
  assert.equal(closed, true); assert.equal(instance.active, false); assert.equal(states.at(-1).phase, 'off');
  assert.ok(states.every(state => !['speaking', 'listening'].includes(state.phase)));
});

for (const provider of ['chattts', 'qwen3tts', 'volcengine']) test(`${provider} wake acknowledgement uses PCM streaming and waits for playback completion`, async t => {
  const descriptors = Object.fromEntries(['navigator', 'AudioContext', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let mics = 0, finished = false, receive, output; const sources = [], texts = [], closes = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() { mics++; return { getTracks: () => [{ stop() {} }] }; } } } });
  globalThis.AudioContext = class {
    state = 'running'; sampleRate = 16000; currentTime = 0; destination = {}; audioWorklet = { async addModule() {} };
    async resume() {} async close() { this.state = 'closed'; } async setSinkId(id) { output = id; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, stop() {}, start() { sources.push(this); } }; return source; }
  };
  globalThis.AudioWorkletNode = class { port = { close() {} }; connect() {} disconnect() {} };
  const { instance, states } = controller(async (action, options) => {
    if (action === 'status') return { available: true, synthesisAvailable: true, settings: { provider, enabled: true, synthesisCapabilities: { audioStreaming: true }, volcengine: { method: 'http-sse' } } };
    if (action === 'open') return { leaseId: 'wake-pcm' };
    if (action === 'ttsStart') { assert.equal(options.leaseId, 'wake-pcm'); return { streamId: 'wake-stream', sampleRate: 24000, mime: 'audio/pcm' }; }
    if (action === 'ttsText') { texts.push(options.text); return {}; }
    if (action === 'ttsRead') { if (finished) return { done: true }; return new Promise(resolve => { receive = resolve; }); }
    if (action === 'ttsFinish') { finished = true; receive({ audio: Buffer.alloc(1200).toString('base64'), done: false }); return {}; }
    if (action === 'close') { closes.push(options.leaseId); return {}; }
    if (action === 'heartbeat') return {};
    throw Error('unexpected ' + action);
  });
  t.after(async () => { await instance.stop(); for (const [key, value] of Object.entries(descriptors)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  instance.setOutputDevice('wake-output'); const starting = instance.start({ wakeReply: '嗯，我在听' }); await flush();
  assert.deepEqual(texts, ['嗯，我在听']); assert.equal(output, 'wake-output');
  assert.equal(states.at(-1).phase, 'speaking'); assert.equal(mics, 0); assert.ok(sources.length > 0);
  for (const source of sources) source.onended?.(); await starting;
  assert.equal(mics, 1); assert.equal(states.at(-1).phase, 'listening'); assert.deepEqual(closes, []);
});

test('disabling automatic interruption ignores speech during a reply but the manual button still works', async t => {
  const h = await conversationHarness(t, { autoInterrupt: false });
  h.emit(.2, 7); h.emit(0, 4); await flush();
  assert.equal(h.interruptions, 0); assert.equal(h.transcriptions.length, 1);
  const interrupting = h.instance.interrupt(); await flush();
  assert.equal(h.interruptions, 1); assert.equal(h.players[0].paused, true);
  h.closeRelease.resolve(); h.reopening.resolve(); await interrupting;
  assert.equal(h.micCalls, 1); assert.equal(h.states.at(-1).phase, 'listening');
});

test('stop during interruption reopen closes the late lease and never revives the microphone', async t => {
  const h = await conversationHarness(t); h.emit(.2, 5); h.closeRelease.resolve(); await flush();
  assert.equal(h.opens.length, 2); await h.instance.stop(); h.reopening.resolve(); await flush();
  assert.equal(h.instance.active, false); assert.equal(h.stopped, 1); assert.equal(h.micCalls, 1);
  assert.equal(h.states.at(-1).phase, 'off'); assert.ok(h.closes.includes(h.opens[1]));
});

test('a saved higher threshold and duration are applied to the running microphone detector', async t => {
  const h = await conversationHarness(t, { bargeInThreshold: 25, bargeInDurationMs: 800 });
  h.emit(.16, 12); await flush(); assert.equal(h.interruptions, 0);
  h.emit(.3, 7); await flush(); assert.equal(h.interruptions, 0);
  h.emit(.3, 1); await flush(); assert.equal(h.interruptions, 1);
});
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

test('an unconfigured paid voice reports its missing key instead of substituting system speech', async t => {
  const originalSpeech = globalThis.speechSynthesis;
  t.after(() => { globalThis.speechSynthesis = originalSpeech; });
  let systemCalls = 0;
  globalThis.speechSynthesis = { cancel() {}, speak() { systemCalls++; } };
  const { instance } = controller(async action => {
    assert.equal(action, 'status');
    return { synthesisAvailable: false, synthesisError: '请先填写火山引擎语音 API Key', settings: { provider: 'volcengine' } };
  });
  await assert.rejects(instance.preview(), /火山引擎.*API Key/);
  assert.equal(systemCalls, 0); assert.equal(instance.active, false);
});

test('changing synthesis providers stops microphone conversation and the prior lease before saving', async () => {
  let requestLease, closed = false;
  const entered = deferred(), speaking = deferred();
  const { instance } = controller(async (action, options) => {
    if (action === 'status') return { synthesisAvailable: true, settings: { provider: 'qwen3tts', enabled: true } };
    if (action === 'open') { requestLease = options.leaseId; return { leaseId: requestLease }; }
    if (action === 'speak') { entered.resolve(); return speaking.promise; }
    if (action === 'close') { assert.equal(options.leaseId, requestLease); closed = true; }
    if (action === 'settings') { assert.equal(closed, true); return { provider: 'volcengine', enabled: true }; }
  });
  const preview = instance.preview(); await entered.promise;
  try { await instance.configure({ provider: 'volcengine' }); assert.equal(instance.active, false); }
  finally { await instance.stop(); speaking.resolve({ audio: 'SUQz', mime: 'audio/mpeg' }); await preview; }
});

test('local WAV read prefetches the next sentence while the current audio plays', async t => {
  const originalAudio = globalThis.Audio;
  t.after(() => { globalThis.Audio = originalAudio; });
  const players = [], spoken = [];
  globalThis.Audio = class {
    constructor() { players.push(this); }
    play() { return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  };
  const { instance } = controller(async (action, options) => {
    if (action === 'status') return { synthesisAvailable: true, synthesis: 'Qwen3-TTS', settings: { provider: 'qwen3tts' } };
    if (action === 'open') return { leaseId: 'local-wav' };
    if (action === 'speak') { spoken.push(options.text); return { audio: 'UklGRg==', mime: 'audio/wav' }; }
  });
  const reading = instance.read('第一句。第二句。第三句。');
  t.after(() => instance.stop());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(players.length, 1); assert.deepEqual(spoken, ['第一句。', '第二句。']);
  players[0].onended(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(players.length, 2); assert.deepEqual(spoken, ['第一句。', '第二句。', '第三句。']);
  await instance.stop(); assert.equal(await reading, false);
});

test('a missing local TTS model is reported without system or cloud fallback', async () => {
  const { instance } = controller(async action => {
    assert.equal(action, 'status');
    return { synthesisAvailable: false, synthesisError: '本地语音模型未安装', settings: { provider: 'qwen3tts' } };
  });
  await assert.rejects(instance.preview(), /本地语音模型未安装/);
  assert.equal(instance.active, false);
});

for (const provider of ['volcengine','qwen3tts']) test(`${provider} preview uses the selected PCM interface and releases its lease`, async t => {
  const previous = globalThis.AudioContext;
  t.after(() => { globalThis.AudioContext = previous; });
  let played = 0, closed = false, finished = false, read;
  globalThis.AudioContext = class {
    state = 'running'; currentTime = 0; destination = {};
    async resume() {} async close() { this.state = 'closed'; }
    createBuffer(_, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start() { played++; queueMicrotask(() => this.onended?.()); } }; }
  };
  const { instance } = controller(async (action, options) => {
    if (action === 'status') return { synthesisAvailable: true, settings: { provider, synthesisCapabilities:{audioStreaming:true}, volcengine: { method: 'http-sse' } } };
    if (action === 'open') return { leaseId: 'live-preview' };
    if (action === 'ttsStart') return { streamId: 'stream', sampleRate: 24000, mime: 'audio/pcm', method: 'http-sse' };
    if (action === 'ttsText') { assert.equal(options.text, '你好'); return {}; }
    if (action === 'ttsRead') { if (finished) return { done: true }; return new Promise(resolve => { read = resolve; }); }
    if (action === 'ttsFinish') { finished = true; read({ audio: 'AAA=', done: false }); return {}; }
    if (action === 'close') { closed = true; return {}; }
    throw Error(`unexpected ${action}`);
  });
  assert.equal(await instance.preview('你好'), true); assert.equal(played, provider === 'qwen3tts' ? 2 : 1); assert.equal(closed, true);
});


test('read-aloud distinguishes loading the local model from waiting for chat text', async t => {
 const opened=deferred(),entered=deferred();
 const {instance,states}=controller(async action=>{
  if(action==='status')return {synthesisAvailable:true,synthesis:'本地 ChatTTS',settings:{provider:'chattts'}};
  if(action==='open'){entered.resolve();return opened.promise;}
 });
 const reading=instance.read('现成的试听文本');t.after(async()=>{await instance.stop();opened.resolve({leaseId:'late-preview'});await reading;});await entered.promise;
 assert.match(states.at(-1).text,/加载.*模型/);
 assert.doesNotMatch(states.at(-1).text,/等待文字|准备朗读/);
 await instance.stop();opened.resolve({leaseId:'late-preview'});assert.equal(await reading,false);
});


test('Qwen preview loads explicitly, synthesizes a shorter first clause and plays every word', async t => {
  const original = globalThis.Audio, spoken = [];
  globalThis.Audio = class {
    play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  };
  t.after(() => { globalThis.Audio = original; });
  const { instance, states } = controller(async (action, options) => {
    if (action === 'status') return { synthesisAvailable: true, synthesis: '本地 Qwen3-TTS', settings: { provider: 'qwen3tts' } };
    if (action === 'open') return { leaseId: 'qwen-preview' };
    if (action === 'speak') { spoken.push(options.text); return { audio: 'UklGRg==', mime: 'audio/wav' }; }
  });
  assert.equal(await instance.preview('你好，我是你的助手，有什么可以帮你？'), true);
  assert.deepEqual(spoken, ['你好，我是你的助手，', '有什么可以帮你？']);
  assert.ok(states.some(state => /加载合成模型/.test(state.text)));
  assert.ok(states.some(state => /合成短句/.test(state.text)));
  assert.ok(states.every(state => !/等待文字|准备朗读/.test(state.text)));
  assert.equal(instance.active, false);
});

test('warm preview reports model reuse and releases only its playback lease', async t => {
  const original = globalThis.Audio;
  globalThis.Audio = class { play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); } pause() {} removeAttribute() {} load() {} };
  t.after(() => { globalThis.Audio = original; });
  let released = false;
  const { instance, states } = controller(async (action, options) => {
    if (action === 'status') return { modelLoaded: true, synthesisAvailable: true, synthesis: '本地 Qwen3-TTS', settings: { provider: 'qwen3tts' } };
    if (action === 'open') return { leaseId: 'resident-preview', reused: true };
    if (action === 'speak') return { audio: 'UklGRg==', mime: 'audio/wav' };
    if (action === 'close') { assert.equal(options.keepWarm, true); released = true; }
  });
  assert.equal(await instance.preview('测试'), true); assert.equal(released, true);
  assert.ok(states.some(state => /复用已加载模型/.test(state.text)));
  assert.ok(states.every(state => !/正在加载合成模型/.test(state.text)));
});


test('random opportunities replace second-based voice idle initiation', async t => {
 let at=Date.now();t.mock.method(Date,'now',()=>at);
 const h=await conversationHarness(t,{conversationSettings:()=>({proactiveChat:true,proactiveIdleSeconds:15})});
 h.turns[0].done.resolve('收到。');h.players[0].onended();await flush();
 at+=16000;h.emit(0,1);await flush();assert.equal(h.turns.length,1,'no second-based model request');
 h.closeRelease.resolve();at+=61000;h.emit(0,1);await flush();assert.equal(h.turns.length,1);assert.equal(h.instance.active,false,'do not keep microphone open waiting for opportunities');
});

test('idle initiation is disabled by default and inactivity pauses voice without a model request', async t => {
  let at = Date.now(); t.mock.method(Date,'now',()=>at);
  const h = await conversationHarness(t);
  h.turns[0].done.resolve('收到。');h.players[0].onended();await flush();
  h.closeRelease.resolve(); at += 61000;h.emit(0,1);await flush();
  assert.equal(h.turns.length,1);assert.equal(h.instance.active,false);assert.equal(h.stopped,1);
});


test('proactive setting alone does not force microphone continuation', async t => {
 const h=await conversationHarness(t,{autoListen:false,conversationSettings:()=>({proactiveChat:true})});h.closeRelease.resolve();
 h.turns[0].done.resolve('收到。');h.players[0].onended();await flush();assert.equal(h.instance.active,false);
});

test('wake-up passes a same-utterance request to chat once without transcribing it again', async t => {
  const h = await conversationHarness(t, { initialText: '今天天气24度吗？' });
  assert.equal(h.turns.length, 1); assert.equal(h.turns[0].text, '今天天气24度吗？');
  assert.equal(h.transcriptions.length, 0); assert.equal(h.micCalls, 1);
});

for (const text of ['下去', '晚安', '别说话了']) test(`recognized farewell ${text} finishes its reply then ends auto-listening`, async t => {
  const h = await conversationHarness(t, { recognizedTexts: [text], presenceControls: true });
  assert.equal(h.turns[0].text, text);
  h.turns[0].done.resolve('好，休息吧。'); await flush();
  assert.equal(h.instance.active, true, 'finish the farewell audio before closing');
  assert.equal(h.stopped, 0);
  const listeningBefore = h.states.filter(state => state.phase === 'listening').length;
  h.players[0].onended(); h.closeRelease.resolve(); await flush();
  assert.equal(h.instance.active, false, 'farewell overrides autoListen for this conversation');
  assert.equal(h.stopped, 1); assert.equal(h.states.at(-1).phase, 'off');
  assert.equal(h.states.filter(state => state.phase === 'listening').length, listeningBefore);
  assert.deepEqual(h.presenceRequests, [{ action: 'interaction' }], 'ending a dialogue does not add a two-hour snooze');
  assert.deepEqual(h.errors, []);
});

test('wake-up farewell closes this dialogue and the next explicit start keeps automatic listening', async t => {
  const h = await conversationHarness(t, { initialText: '晚安', presenceControls: true });
  h.turns[0].done.resolve('晚安。'); h.players[0].onended(); h.closeRelease.resolve(); await flush();
  assert.equal(h.instance.active, false); assert.equal(h.transcriptions.length, 0);
  h.reopening.resolve(); await h.instance.start({ initialText: '今天有什么新闻？' }); await flush();
  h.turns[1].done.resolve('这是新闻。'); h.players[1].onended(); await flush();
  assert.equal(h.instance.active, true); assert.equal(h.states.at(-1).phase, 'listening');
  assert.equal(h.micCalls, 2); assert.deepEqual(h.errors, []);
});

for (const text of ['晚安是什么意思？', '他说晚安，然后呢？', '不要结束对话', '别说话了是什么意思？', '下去之后打开设置', '给我讲个晚安故事']) test(`mentioning a farewell in ${text} keeps the dialogue open`, async t => {
  const h = await conversationHarness(t, { initialText: text, presenceControls: true });
  h.turns[0].done.resolve('晚安。'); h.players[0].onended(); await flush();
  assert.equal(h.instance.active, true); assert.equal(h.stopped, 0);
  assert.equal(h.states.at(-1).phase, 'listening');
  assert.deepEqual(h.errors, []);
});

test('interrupting a farewell prevents its late completion from closing the new turn', async t => {
  const h = await conversationHarness(t, { initialText: '晚安' });
  const interrupting = h.instance.interrupt(); await flush();
  h.closeRelease.resolve(); h.reopening.resolve(); await interrupting;
  h.emit(.2, 4); h.emit(0, 4); await flush();
  h.turns[0].done.resolve('迟到的晚安。'); await flush();
  assert.equal(h.instance.active, true); assert.equal(h.turns.length, 2);
  h.turns[1].done.resolve('收到新的问题。'); h.players.at(-1).onended(); await flush();
  assert.equal(h.states.at(-1).phase, 'listening'); assert.deepEqual(h.errors, []);
});
