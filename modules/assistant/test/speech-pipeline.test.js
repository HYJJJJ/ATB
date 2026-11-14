import test from 'node:test';
import assert from 'node:assert/strict';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('streaming speech keeps thousands and decimal digits together across token boundaries and pauses',async()=>{
 const {createSpeechPipeline}=await import('../public/speech-pipeline.js');const phrases=[];
 const pipeline=createSpeechPipeline({firstClauseMin:8,flushMs:15,synthesize:async text=>{phrases.push(text);return text;},play:async()=>true});
 pipeline.write('目前为你查询到账户余额为1,');await tick();assert.deepEqual(phrases,[],'a thousands separator is not a clause ending');
 pipeline.write('234.56元。');await tick();pipeline.finish();await pipeline.done;assert.deepEqual(phrases,['目前为你查询到账户余额为1,234.56元。']);
 const paused=[];const next=createSpeechPipeline({flushMs:15,synthesize:async text=>{paused.push(text);return text;},play:async()=>true});
 next.write('这是目前账户的可用余额1.2');await new Promise(r=>setTimeout(r,50));assert.ok(paused.every(text=>!text.includes('1.2')),'a temporary model pause must not flush half a decimal');
 next.write('2元。');next.finish();await next.done;assert.equal(paused.join(''),'这是目前账户的可用余额1.22元。');assert.ok(paused.some(text=>text.includes('1.22元')));
});

test('speech starts before the complete answer and prepares the next sentence during playback', async () => {
  const { createSpeechPipeline } = await import('../public/speech-pipeline.js');
  const firstPlaying = deferred(), releaseFirst = deferred();
  const synthesized = [], played = [];
  const pipeline = createSpeechPipeline({
    synthesize: async text => { synthesized.push(text); return text; },
    play: async audio => { played.push(audio); if (played.length === 1) { firstPlaying.resolve(); await releaseFirst.promise; } return true; },
  });
  pipeline.write('你好，这是第一句话。');
  await firstPlaying.promise;
  assert.deepEqual(played, ['你好，这是第一句话。']);
  pipeline.write('第二句话在播放期间生成。第三句话稍后再说。');
  await tick();
  assert.deepEqual(synthesized, ['你好，这是第一句话。', '第二句话在播放期间生成。']);
  assert.equal(played.length, 1, 'preparation must not overlap playback');
  pipeline.finish(); releaseFirst.resolve();
  assert.equal(await pipeline.done, true);
  assert.deepEqual(played, ['你好，这是第一句话。', '第二句话在播放期间生成。', '第三句话稍后再说。']);
});

test('speech cancellation drops queued text and audio which arrives late', async () => {
  const { createSpeechPipeline } = await import('../public/speech-pipeline.js');
  const audio = deferred(); let played = 0;
  const pipeline = createSpeechPipeline({ synthesize: () => audio.promise, play: async () => { played++; return true; } });
  pipeline.write('你好，第一句话。还有第二句话。'); await tick();
  pipeline.cancel(); audio.resolve('late audio');
  assert.equal(await pipeline.done, false); assert.equal(played, 0);
});

test('speech bounds unpunctuated text without splitting unicode characters and flushes the last fragment', async () => {
  const { createSpeechPipeline } = await import('../public/speech-pipeline.js'); const text = [];
  const pipeline = createSpeechPipeline({ synthesize: async value => value, play: async value => { text.push(value); return true; } });
  const reply = '家庭助手😀'.repeat(40) + '最后一句';
  pipeline.write(reply); pipeline.finish(); await pipeline.done;
  assert.equal(text.join(''), reply); assert.ok(text.every(value => value.length <= 80));
  assert.ok(text.every(value => !/[\uD800-\uDBFF]$/.test(value)));
});

test('speech generation failures reject the reply instead of claiming playback completion', async () => {
  const { createSpeechPipeline } = await import('../public/speech-pipeline.js');
  let played = 0;
  const pipeline = createSpeechPipeline({ synthesize: async () => { throw Error('provider unavailable'); }, play: async () => { played++; return true; } });
  const rejected = assert.rejects(pipeline.done, /provider unavailable/);
  pipeline.write('不能合成的句子。'); pipeline.finish(); await rejected; assert.equal(played, 0);
});

test('a short unpunctuated first phrase flushes during a slow model pause', async () => {
  const { createSpeechPipeline } = await import('../public/speech-pipeline.js');
  const played = [], pipeline = createSpeechPipeline({ flushMs: 20, synthesize: async text => text, play: async text => { played.push(text); return true; } });
  pipeline.write('这是一段没有句号但是已经可以开始朗读的文字');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(played.length, 1); pipeline.finish(); assert.equal(await pipeline.done, true);
});


test('a complete-audio provider can emit its first natural clause sooner without dropping the remainder', async () => {
  const { createSpeechPipeline } = await import('../public/speech-pipeline.js');
  const synthesized = [];
  const pipeline = createSpeechPipeline({ firstClauseMin: 8, synthesize: async text => { synthesized.push(text); return text; }, play: async () => true });
  const text = '你好，我是你的助手，有什么可以帮你？';
  pipeline.write(text);
  await tick();
  assert.equal(synthesized[0], '你好，我是你的助手，');
  pipeline.finish();
  assert.equal(await pipeline.done, true);
  assert.equal(synthesized.join(''), text);
});
