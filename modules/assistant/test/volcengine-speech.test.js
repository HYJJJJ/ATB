import test from 'node:test';
import assert from 'node:assert/strict';
import { createVolcengineSpeech } from '../public/volcengine-speech.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(method, options = {}) {
  const events = [], audio = []; let read, complete = false;
  const call = async (action, args) => {
    assert.equal(args.leaseId, 'own-lease'); events.push([action, args.text]);
    if (action === 'ttsStart') { complete = false; return { streamId: 'stream', sampleRate: 24000, mime: 'audio/pcm', method }; }
    if (action === 'ttsRead') return new Promise(resolve => { read = resolve; if (complete) resolve({ done: true }); });
    if (action === 'ttsFinish') { complete = true; read?.({ done: true }); }
  };
  const pipeline = createVolcengineSpeech({ call, leaseId: 'own-lease', method, ...options,
    createPlayer: () => ({ async write(bytes) { audio.push(bytes); }, async finish() { return true; }, stop() {} }) });
  return { pipeline, events, audio, chunk: () => read({ audio: 'AAA=', done: false }) };
}
test('bidirectional speech sends unsplit model deltas and plays PCM before text finishes', async () => {
  const { pipeline, events, audio, chunk } = fixture('ws-bidirectional');
  pipeline.write('你好'); await tick(); chunk(); await tick();
  assert.deepEqual(events.filter(([action]) => action === 'ttsText'), [['ttsText', '你好']]);
  assert.deepEqual(audio, ['AAA=']); assert.equal(events.some(([action]) => action === 'ttsFinish'), false);
  pipeline.write('，世界。'); pipeline.finish(); assert.equal(await pipeline.done, true);
  assert.deepEqual(events.filter(([action]) => action === 'ttsText'), [['ttsText', '你好'], ['ttsText', '，世界。']]);
});
for (const method of ['ws-unidirectional', 'http-chunked', 'http-sse']) test(`${method} submits the first sentence before model completion and keeps sentence order`, async () => {
  const { pipeline, events } = fixture(method);
  pipeline.write('第一句。'); await tick();
  assert.deepEqual(events.filter(([action]) => action === 'ttsText'), [['ttsText', '第一句。']]);
  pipeline.write('第二句。尾段'); await tick();
  pipeline.finish(); assert.equal(await pipeline.done, true);
  assert.deepEqual(events.filter(([action]) => action === 'ttsText'), [['ttsText', '第一句。'], ['ttsText', '第二句。'], ['ttsText', '尾段']]);
  assert.equal(events.filter(([action]) => action === 'ttsStart').length, 3);
});
test('cancel stops an outstanding native read and never plays its late PCM', async () => {
  const { pipeline, audio, chunk } = fixture('ws-bidirectional');
  pipeline.write('取消测试'); await tick(); pipeline.cancel();
  assert.equal(await pipeline.done, false); chunk(); await tick(); assert.deepEqual(audio, []);
});
for (const method of ['ws-unidirectional', 'http-chunked', 'http-sse']) test(`${method} cancels an unfinished sentence without playing late audio or starting the next one`, async () => {
  let read, started = 0, stopped = 0; const played = [];
  const pipeline = createVolcengineSpeech({ method, leaseId: 'lease', call: async action => {
    if (action === 'ttsStart') { started++; return { streamId: 'sentence', sampleRate: 24000, mime: 'audio/pcm' }; }
    if (action === 'ttsRead') return new Promise(resolve => { read = resolve; });
  }, createPlayer: () => ({ async write(audio) { played.push(audio); }, async finish() { return true; }, stop() { stopped++; } }) });
  pipeline.write('第一句。第二句。'); await tick(); read({ audio: 'AAA=', done: false }); await tick();
  pipeline.cancel(); assert.equal(await pipeline.done, false);
  read({ audio: 'late', done: true }); await tick();
  assert.deepEqual(played, ['AAA=']); assert.equal(started, 1); assert.ok(stopped > 0);
});
test('stream failures reject the speech pipeline instead of reporting playback success', async () => {
  const pipeline = createVolcengineSpeech({ method: 'ws-bidirectional', leaseId: 'lease', call: async () => { throw Error('模型未授权'); } });
  pipeline.write('测试'); await assert.rejects(pipeline.done, /模型未授权/);
});
for (const method of ['ws-bidirectional', 'http-chunked']) test(`${method} settles immediately for an already cancelled turn`, async () => {
  let calls = 0;
  const pipeline = createVolcengineSpeech({ method, signal: AbortSignal.abort(), call: async () => { calls++; } });
  assert.equal(await Promise.race([pipeline.done, new Promise(resolve => setTimeout(() => resolve('hung'), 80))]), false);
  assert.equal(calls, 0);
});


test('local streaming shares one ending across all sentences', async () => {
  const options = [], audio = []; let starts = 0, finishes = 0;
  const pipeline = createVolcengineSpeech({ method: 'local-stream', call: async action => {
    if (action === 'ttsStart') return { streamId: String(++starts), sampleRate: 24000, mime: 'audio/pcm' };
    if (action === 'ttsRead') return { audio: 'AAA=', done: true };
  }, createPlayer: config => {
    options.push(config);
    return { async write(bytes) { audio.push(bytes); }, async finish() { finishes++; return true; }, stop() {} };
  } });
  pipeline.write('第一句话。第二句话。'); pipeline.finish();
  assert.equal(await pipeline.done, true);
  assert.equal(starts, 2); assert.equal(audio.length, 2);
  assert.equal(options.length, 1); assert.equal(finishes, 1);
  assert.equal(options[0].releaseMs, 8); assert.equal(options[0].endPaddingMs, 220);
});


test('Qwen PCM starts its first short clause before incoming text is complete', async () => {
 const { pipeline, events } = fixture('local-stream',{firstClauseMin:8});
 pipeline.write('你好，我是你的助手，'); await tick();
 assert.deepEqual(events.filter(([action])=>action==='ttsText'),[['ttsText','你好，我是你的助手，']]);
 pipeline.write('有什么可以帮你？');pipeline.finish();assert.equal(await pipeline.done,true);
 assert.equal(events.filter(([action])=>action==='ttsText').length,2);
});

test('local speech passes its start cushion once to the shared player', async () => {
 let config, created = 0;
 const pipeline = createVolcengineSpeech({ method:'local-stream', startBufferMs:300, call:async action => {
  if(action==='ttsStart') return {streamId:'fixture',sampleRate:24000,mime:'audio/pcm'};
  if(action==='ttsRead') return {audio:'AAA=',done:true};
 }, createPlayer:options => { config=options; created++; return {async write(){},async finish(){return true;},stop(){}}; } });
 pipeline.write('第一句。第二句。'); pipeline.finish();
 assert.equal(await pipeline.done,true); assert.equal(created,1); assert.equal(config.startBufferMs,300);
});
