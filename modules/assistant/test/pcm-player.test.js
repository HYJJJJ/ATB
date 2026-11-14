import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcmPlayer } from '../public/pcm-player.js';

function context() {
  const sources = [], buffers = [];
  return { sources, buffers, currentTime: 0, state: 'running', destination: {},
    async resume() {}, async close() { this.state = 'closed'; },
    createBuffer(channels, length, rate) { const data = new Float32Array(length); const buffer = { duration: length / rate, getChannelData: () => data }; buffers.push(buffer); return buffer; },
    createBufferSource() { const item = { connect() {}, disconnect() {}, start(at) { this.at = at; }, stop() { this.stopped = true; } }; sources.push(item); return item; },
  };
}
test('PCM playback preserves signed little-endian samples across odd network chunks and schedules continuously', async () => {
  const audio = context(); let playing = 0;
  const player = createPcmPlayer({ sampleRate: 24000, context: audio, onPlaying: () => playing++ });
  await player.write(Buffer.from([0, 128, 255]).toString('base64'));
  await player.write(Buffer.from([127, 0, 0]).toString('base64'));
  assert.deepEqual([...audio.buffers[0].getChannelData(0)], [-1]);
  assert.deepEqual([...audio.buffers[1].getChannelData(0)], [32767 / 32768, 0]);
  assert.equal(audio.sources[1].at, audio.sources[0].at + 1 / 24000);
  assert.equal(playing, 1);
  const finished = player.finish(); audio.sources.forEach(source => source.onended());
  assert.equal(await finished, true); player.stop(); assert.equal(audio.state, 'closed');
});
test('stopping PCM releases scheduled playback and discards late chunks', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio });
  await player.write('AAA='); const done = player.finish(); player.stop();
  assert.equal(await done, false); await player.write('AAA=');
  assert.equal(audio.sources.length, 1); assert.equal(audio.sources[0].stopped, true);
});
test('PCM rejects truncated samples and blocked audio output', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio });
  await player.write('AA=='); await assert.rejects(player.finish(), /不完整/); player.stop();
  audio.state = 'suspended'; audio.resume = async () => {};
  const blocked = createPcmPlayer({ sampleRate: 24000, context: audio });
  await assert.rejects(blocked.write('AAA='), /声音播放/); blocked.stop();
});

test('suspended output rejects completion instead of keeping the voice session alive forever', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio });
  await player.write('AAA='); audio.state = 'suspended';
  const result = await Promise.race([player.finish().catch(error => error), new Promise(resolve => setImmediate(() => resolve('still waiting')))]);
  player.stop(); assert.ok(result instanceof Error); assert.match(result.message, /播放/);
});


test('completion drains the actual output timeline before closing the device and cutting its tail', async () => {
 const audio=context();let outputTime=0;
 audio.getOutputTimestamp=()=>({contextTime:outputTime,performanceTime:100});
 const player=createPcmPlayer({sampleRate:24000,context:audio});
 await player.write(Buffer.alloc(12000).toString('base64'));
 const end=audio.sources.at(-1).at+audio.buffers.at(-1).duration;
 audio.currentTime=end+.01;audio.sources.forEach(source=>source.onended());outputTime=end-.1;
 let finished=false;const completion=player.finish().then(value=>{finished=true;return value;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(finished,false,'rendering completion must not discard audio still queued for the output device');
 outputTime=end;assert.equal(await completion,true);player.stop();
});


test('stop cancels an output drain immediately even when the device timestamp stalls', async () => {
  const audio = context();
  audio.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 100 });
  const player = createPcmPlayer({ sampleRate: 24000, context: audio });
  await player.write('AAA=');
  audio.sources.forEach(source => source.onended());
  const completion = player.finish();
  player.stop();
  assert.equal(await completion, false);
  assert.equal(audio.state, 'closed');
});

test('natural completion keeps every speech sample and releases only the final 8ms into trailing silence', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio, releaseMs: 8, endPaddingMs: 220 });
  const pcm = Buffer.alloc(24000 * 2 / 10); // A sentence ending while the waveform is still nonzero.
  for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(8192, at);
  await player.write(pcm.subarray(0, 1537).toString('base64'));
  await player.write(pcm.subarray(1537).toString('base64'));
  const before = audio.buffers.flatMap(buffer => [...buffer.getChannelData(0)]);
  assert.equal(before.length, 2400-192, 'retain only the final 8ms until actual utterance completion');
  assert.ok(before.every(sample => sample === .25), 'network packet boundaries must not get fades or silence');
  let complete = false;
  const done = player.finish().then(value => { complete = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  const samples = audio.buffers.flatMap(buffer => [...buffer.getChannelData(0)]);
  assert.equal(samples.length, 2400+5280);
  assert.ok(samples.slice(0, 2400-192).every(sample => sample === .25));
  const release = samples.slice(2400-192, 2400);
  assert.equal(release[0], .25); assert.equal(release.at(-1), 0);
  assert.ok(release.every((sample, i) => !i || sample <= release[i-1]));
  assert.ok(samples.slice(2400).every(sample => sample === 0));
  assert.equal(complete, false, 'completion waits for the release and padding to actually play');
  audio.sources.slice(0,-1).forEach(source => source.onended());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  audio.sources.at(-1).onended(); assert.equal(await done, true); player.stop();
});

test('manual stop discards a retained ending and never adds a completion pause', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio, releaseMs: 8, endPaddingMs: 220 });
  await player.write(Buffer.alloc(100).toString('base64'));
  assert.equal(audio.buffers.length, 0);
  player.stop(); assert.equal(await player.finish(), false);
  assert.equal(audio.buffers.length, 0); assert.equal(audio.state, 'closed');
});

test('a small start buffer absorbs delayed Qwen chunks without gaps or changing speech samples', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio, startBufferMs: 300 });
  const pcm = Buffer.alloc(11520 * 2);
  for (let i = 0; i < 11520; i++) pcm.writeInt16LE(i % 1000 - 500, i * 2);
  for (let packet = 0; packet < 6; packet++) {
    // 480 ms of audio arrives every 520 ms: the measured producer jitter.
    audio.currentTime = packet * .52;
    await player.write(pcm.toString('base64'));
  }
  assert.equal(audio.sources[0].at, .3, 'only the beginning reserves a short jitter cushion');
  for (let i = 1; i < audio.sources.length; i++) {
    assert.ok(Math.abs(audio.sources[i].at - audio.sources[i - 1].at - audio.buffers[i - 1].duration) < 1e-9, 'no silence inserted between late packets');
  }
  const samples = audio.buffers.flatMap(buffer => [...buffer.getChannelData(0)]);
  assert.equal(samples.length, 6 * 11520);
  assert.ok(samples.every((value, i) => value === ((i % 11520) % 1000 - 500) / 32768), 'buffering never fades or drops speech');
  const completion = player.finish(); audio.sources.forEach(source => source.onended());
  assert.equal(await completion, true); player.stop();
});

test('stop during the start cushion cancels scheduled speech immediately', async () => {
  const audio = context(), player = createPcmPlayer({ sampleRate: 24000, context: audio, startBufferMs: 300 });
  await player.write(Buffer.alloc(2400).toString('base64'));
  player.stop();
  assert.ok(audio.sources.every(source => source.stopped));
  assert.equal(await player.finish(), false);
  assert.equal(audio.state, 'closed');
});
