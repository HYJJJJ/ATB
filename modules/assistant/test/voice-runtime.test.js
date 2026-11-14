import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceRuntime } from '../server/voice-runtime.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-runtime-')), dataDir = path.join(root, 'assistant');
  await mkdir(dataDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = path.join(dataDir, 'worker.cjs');
  await writeFile(worker, `
    if(process.argv.includes('--list-voices')) { console.log(JSON.stringify([{ShortName:'en-US-JennyNeural',Locale:'en-US',Gender:'Female',FriendlyName:'Jenny'}])); process.exit(0); }
    const rl = require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => { const m = JSON.parse(line);
      if(m.action==='hang') return;
      if(m.action==='speak-stream') process.stdout.write(JSON.stringify({id:m.id,type:'audio',audio:Buffer.from(m.text).toString('base64')})+'\\n');
      const result = m.action==='transcribe' ? {text:process.env.FREECAMERA_VOICE_SECRET_PROBE ? 'unexpected-env' : '你好小助手'} : m.action==='speak' ? {audio:Buffer.from(JSON.stringify(m)).toString('base64'),mime:['chattts','qwen3tts'].includes(m.provider)?'audio/wav':'audio/mpeg'} : {};
      setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,ok:true,...result})+'\\n'),m.action==='transcribe'?120:0);
    });
    setTimeout(()=>process.stdout.write(JSON.stringify({type:'ready'})+'\\n'), ${options.readyDelay || 0});
  `);
  const voice = new VoiceRuntime({ dataDir, command: process.execPath, worker, verifyInstallation: false, leaseMs: 600, requestTimeoutMs: 1000, ...options });
  t.after(() => voice.dispose());
  return voice;
}

test('wake settings persist independently of synthesis profiles and reject invalid custom phrases', async t => {
  const voice = await fixture(t);
  assert.deepEqual(await voice.wakeSettings(), { enabled: false, wakeEnabled: true, wakePhrases: [] });
  await voice.configure({ enabled: true, wakeEnabled: false, wakePhrases: [' 小金鱼 ', '你好助手', '小金鱼'] });
  await voice.configure({ provider: 'qwen3tts' });
  assert.deepEqual(await voice.wakeSettings(), { enabled: true, wakeEnabled: false, wakePhrases: ['小金鱼', '你好助手'] });
  for (const wakePhrases of ['bad', [''], ['a'.repeat(41)], Array(13).fill('你好')]) await assert.rejects(voice.configure({ wakePhrases }), /唤醒/);
});

test('wake lease supports recognition, refuses speech and releases to a warm conversation', async t => {
  const voice = await fixture(t); await voice.configure({ enabled: true });
  const opened = await voice.open('widget', { mode: 'wake' });
  assert.equal(voice.state.recognitionLoaded, true);
  assert.equal((await voice.transcribe('widget', { leaseId: opened.leaseId, pcm: Buffer.alloc(16000).toString('base64') })).text, '你好小助手');
  await assert.rejects(voice.speak('widget', { leaseId: opened.leaseId, text: '不朗读' }), /唤醒/);
  await assert.rejects(voice.ttsStart('widget', { leaseId: opened.leaseId }), /唤醒/);
  await voice.close('widget', opened.leaseId, { keepWarm: true });
  const conversation = await voice.open('main'); assert.equal(conversation.pid, opened.pid); assert.equal(conversation.reused, true);
  await voice.close(); await voice.configure({ wakeEnabled: false });
  await assert.rejects(voice.open('widget', { mode: 'wake' }), /唤醒/);
});

for (const provider of ['chattts', 'qwen3tts']) test(`${provider} prepares recognition and synthesis without holding a conversation lease`, async t => {
  const voice = await fixture(t); await voice.configure({ enabled: true, provider });
  const prepared = await voice.prepare('widget');
  assert.equal(prepared.prepared, true); assert.equal(voice.state.status, 'idle');
  const pid = voice.state.pid; assert.ok(pid); assert.equal(voice.state.recognitionLoaded, true);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(voice.state.pid, pid, 'idle preloaded models are not expired as an abandoned conversation');
  await voice.prepare('widget'); assert.equal(voice.state.pid, pid);
  const opened = await voice.open('conversation'); assert.equal(opened.reused, true); assert.equal(opened.pid, pid);
  assert.equal((await voice.transcribe('conversation', { leaseId: opened.leaseId, pcm: Buffer.alloc(16000).toString('base64') })).text, '你好小助手');
  await voice.close('widget'); assert.equal(voice.state.pid, pid, 'hiding the widget does not kill another entry’s conversation');
});

test('clicking while preparation is loading joins the same worker instead of failing busy', async t => {
  const voice = await fixture(t, { readyDelay: 180 }); await voice.configure({ enabled: true });
  const prepared = voice.prepare('widget'), duplicate = voice.prepare('widget');
  const opened = voice.open('widget');
  const [a, b, lease] = await Promise.all([prepared, duplicate, opened]);
  assert.equal(a.pid, b.pid); assert.equal(lease.pid, a.pid); assert.equal(lease.reused, true);
  assert.equal(voice.state.status, 'on');
});

test('disabled preparation does not launch models or interrupt a running conversation', async t => {
  const voice = await fixture(t); assert.equal((await voice.prepare('widget')).prepared, false); assert.equal(voice.state.pid, null);
  await voice.configure({ enabled: true }); const lease = await voice.open('other');
  assert.equal((await voice.prepare('widget')).prepared, false);
  assert.equal(voice.heartbeat('other', lease).pid, lease.pid);
});

test('hiding or disabling during preparation cancels loading and cannot resurrect a worker', async t => {
  const voice = await fixture(t, { readyDelay: 250 }); await voice.configure({ enabled: true });
  const pending = voice.prepare('widget'), cancelled = assert.rejects(pending, /停止|取消/);
  await voice.close('widget'); await cancelled; assert.equal(voice.state.pid, null);
  const loading = voice.prepare('widget'), disabled = assert.rejects(loading, /停止|取消/);
  await new Promise(resolve => setTimeout(resolve, 30)); await voice.configure({ enabled: false });
  await disabled; assert.equal(voice.state.pid, null);
});

test('shutdown cancels a click waiting for startup preparation instead of launching a replacement worker', async t => {
  const voice = await fixture(t, { readyDelay: 250 }); await voice.configure({ enabled: true });
  const preparing = voice.prepare('widget'), preparationRejected = assert.rejects(preparing, /停止|取消/);
  const clicked = voice.open('widget'), clickRejected = assert.rejects(clicked, /停止|取消/);
  await new Promise(resolve => setTimeout(resolve, 40));
  await voice.dispose(); await Promise.all([preparationRejected, clickRejected]);
  assert.equal(voice.state.pid, null);
});

test('switching the selected provider replaces preloaded models and upgrades a synthesis-only resident', async t => {
  const voice = await fixture(t); await voice.configure({ enabled: true });
  const preview = await voice.open('preview', { mode: 'synthesis' }); await voice.close('preview', preview.leaseId, { keepWarm: true });
  assert.equal(voice.state.recognitionLoaded, false);
  const prepared = await voice.prepare('widget'); assert.equal(prepared.pid, preview.pid); assert.equal(voice.state.recognitionLoaded, true);
  await voice.configure({ provider: 'qwen3tts' }); assert.equal(voice.state.pid, null);
  const replaced = await voice.prepare('widget'); assert.notEqual(replaced.pid, preview.pid);
  await voice.close('widget'); assert.equal(voice.state.pid, null);
});

for (const provider of ['chattts','qwen3tts']) test(`${provider} normalizes Chinese numbers for complete and streamed speech`, async t => {
 const voice=await fixture(t);await voice.configure({provider});const lease=await voice.open('reader',{mode:'synthesis'});
 const text='余额¥1.22，今天2026年11月14日，14:05，增长15%，气温-3.5℃。';
 const expected='余额一点二二元，今天二零二六年十一月十四日，十四点零五分，增长百分之十五，气温零下三点五摄氏度。';
 const speech=await voice.speak('reader',{leaseId:lease.leaseId,text});assert.equal(JSON.parse(Buffer.from(speech.audio,'base64').toString()).text,expected);
 const started=await voice.ttsStart('reader',lease),args={leaseId:lease.leaseId,streamId:started.streamId};
 await voice.ttsText('reader',{...args,text:text.slice(0,5)});await voice.ttsText('reader',{...args,text:text.slice(5)});await voice.ttsFinish('reader',args);
 let spoken='',done=false;while(!done){const part=await voice.ttsRead('reader',args);spoken+=Buffer.from(part.audio||'','base64').toString();done=part.done;}assert.equal(spoken,expected,'normalize after collecting fragments, including a split decimal');
});

test('voice settings survive restart and do not accept arbitrary synthesis settings', async t => {
  const voice = await fixture(t);
  assert.equal((await voice.settings()).enabled, false);
  assert.equal((await voice.settings()).autoInterrupt, true);
  assert.equal((await voice.settings()).bargeInThreshold, 10);
  assert.equal((await voice.settings()).bargeInDurationMs, 500);
  const saved = await voice.configure({ enabled: true, voice: 'chattts:1234', rate: 10, silenceMs: 1200, autoListen: false, autoInterrupt: false, bargeInThreshold: 18, bargeInDurationMs: 800 });
  assert.equal(saved.voice, 'chattts:1234');
  await assert.rejects(voice.configure({ voice: '../../secret' }), /音色/);
  await assert.rejects(voice.configure({ silenceMs: 0 }), /静音/);
  await assert.rejects(voice.configure({ autoInterrupt: 'false' }), /开关/);
  for (const bargeInThreshold of [0, 41, '12', NaN]) await assert.rejects(voice.configure({ bargeInThreshold }), /阈值/);
  for (const bargeInDurationMs of [100, 1501, '500']) await assert.rejects(voice.configure({ bargeInDurationMs }), /持续说话/);
  const restarted = new VoiceRuntime({ dataDir: voice.dataDir });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.settings()).rate, 10);
  assert.equal((await restarted.settings()).autoListen, false);
  assert.equal((await restarted.settings()).autoInterrupt, false);
  assert.equal((await restarted.settings()).bargeInThreshold, 18);
  assert.equal((await restarted.settings()).bargeInDurationMs, 800);
});

test('synthesis preserves pitch, volume and a continuous speaking rate across restarts', async t => {
  const voice = await fixture(t);
  await voice.configure({ voice: 'chattts:1234', rate: -35, volume: 25, pitch: 0 });
  const restarted = new VoiceRuntime({ dataDir: voice.dataDir }); t.after(() => restarted.dispose());
  const settings = await restarted.settings();
  assert.equal(settings.rate, -35); assert.equal(settings.volume, 25); assert.equal(settings.pitch, 0);
  assert.equal(settings.voice, 'chattts:1234');
  await assert.rejects(voice.configure({ rate: -100 }), /语速/);
  await assert.rejects(voice.configure({ pitch: 101 }), /音调/);
  await assert.rejects(voice.configure({ volume: -101 }), /音量/);
});

test('voice catalogue refresh enables provider voices and synthesis carries all saved controls', async t => {
  const voice = await fixture(t);
  const result = await voice.catalog({ refresh: true });
  assert.ok(result.voices.some(item => item.id === 'chattts:1234' && item.languages.includes('en')));
  await voice.configure({ voice: 'chattts:1234', rate: 30, volume: 20, pitch: 0 });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  const speech = await voice.speak('reader', { leaseId: lease.leaseId, text: '你好' });
  const request = JSON.parse(Buffer.from(speech.audio, 'base64').toString());
  assert.equal(request.voice, 'chattts:1234'); assert.equal(request.rate, 30);
  assert.equal(request.volume, 20); assert.equal(request.pitch, 0);
});

test('synthesis-only leases work without recognition models or enabling microphone conversation', async t => {
  const voice = await fixture(t, { verifyInstallation: false });
  voice.installed = async mode => mode === 'synthesis';
  const status = await voice.status();
  assert.equal(status.available, false); assert.equal(status.synthesisAvailable, true);
  const lease = await voice.open('reader', { mode: 'synthesis' });
  const audio = await voice.speak('reader', { leaseId: lease.leaseId, text: '你好' });
  assert.equal(audio.mime, 'audio/wav'); assert.ok(audio.audio);
  await assert.rejects(voice.transcribe('reader', { leaseId: lease.leaseId, pcm: Buffer.alloc(16000).toString('base64') }), /识别/);
});

test('voice owns a single lease, validates PCM, and kills the worker when disabled', async t => {
  const voice = await fixture(t);
  await voice.configure({ enabled: true });
  const lease = await voice.open('user-a');
  assert.ok(lease.leaseId); assert.ok(lease.pid);
  await assert.rejects(voice.open('user-b'), /正在使用/);
  await assert.rejects(voice.open('user-a'), /正在使用/);
  await assert.rejects(voice.transcribe('user-a', { leaseId: lease.leaseId, pcm: 'invalid' }), /音频/);
  const result = await voice.transcribe('user-a', { leaseId: lease.leaseId, pcm: Buffer.alloc(16000).toString('base64') });
  assert.equal(result.text, '你好小助手');
  await voice.configure({ enabled: false });
  assert.equal(voice.state.pid, null);
  assert.throws(() => process.kill(lease.pid, 0));
  await assert.rejects(voice.transcribe('user-a', { leaseId: lease.leaseId, pcm: '' }), /失效/);
});

test('an old lease close cannot stop a newer session from the same owner', async t => {
  const voice = await fixture(t);
  await voice.configure({ enabled: true });
  const old = await voice.open('user-a'); await voice.close('user-a', old.leaseId);
  const current = await voice.open('user-a');
  await voice.close('user-a', old.leaseId);
  assert.equal(voice.state.pid, current.pid);
  voice.heartbeat('user-a', { leaseId: current.leaseId });
});

test('disabling voice during installation probing prevents a late worker launch', async t => {
  const voice = await fixture(t);
  await voice.configure({ enabled: true });
  let finishProbe, entered;
  const probing = new Promise(resolve => { entered = resolve; });
  voice.installed = () => new Promise(resolve => { finishProbe = resolve; entered(); });
  const opening = voice.open('user-a');
  await probing; await voice.configure({ enabled: false }); finishProbe(true);
  await assert.rejects(opening, /停止|关闭|开启/);
  assert.equal(voice.state.pid, null);
});

test('voice lease expiry releases the process and closing rejects pending results', async t => {
  const voice = await fixture(t);
  await voice.configure({ enabled: true });
  const lease = await voice.open('user-a');
  const pending = voice.transcribe('user-a', { leaseId: lease.leaseId, pcm: Buffer.alloc(16000).toString('base64') });
  const rejected = assert.rejects(pending, /停止|失效|关闭/);
  await voice.close('user-a', lease.leaseId); await rejected;
  assert.throws(() => process.kill(lease.pid, 0));
  const next = await voice.open('user-a');
  const deadline = Date.now() + 2500;
  while (voice.state.pid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(voice.state.pid, null);
  assert.throws(() => process.kill(next.pid, 0));
});

test('a reused runtime still expires abandoned leases after service disposal', async t => {
  const voice = await fixture(t, { leaseMs: 160 });
  await voice.configure({ enabled: true });
  await voice.dispose();
  const lease = await voice.open('restarted-service');
  const deadline = Date.now() + 1200;
  while (voice.state.pid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(voice.state.pid, null);
  assert.throws(() => process.kill(lease.pid, 0));
});

test('the speech worker does not inherit unrelated credentials from the host environment', async t => {
  const previous = process.env.FREECAMERA_VOICE_SECRET_PROBE;
  process.env.FREECAMERA_VOICE_SECRET_PROBE = 'test-only-marker';
  t.after(() => { if (previous === undefined) delete process.env.FREECAMERA_VOICE_SECRET_PROBE; else process.env.FREECAMERA_VOICE_SECRET_PROBE = previous; });
  const voice = await fixture(t); await voice.configure({ enabled: true });
  const lease = await voice.open('user-a');
  const result = await voice.transcribe('user-a', { leaseId: lease.leaseId, pcm: Buffer.alloc(16000).toString('base64') });
  assert.equal(result.text, '你好小助手');
});

test('a slow model load uses the startup timeout and begins its heartbeat lease only when ready', async t => {
  const voice = await fixture(t, { leaseMs: 160, readyDelay: 400, requestTimeoutMs: 1200 });
  await voice.configure({ enabled: true });
  const lease = await voice.open('user-a');
  assert.ok(lease.pid);
  voice.heartbeat('user-a', { leaseId: lease.leaseId });
  await voice.close('user-a', lease.leaseId);
  assert.throws(() => process.kill(lease.pid, 0));
});

test('a close that arrives before its open prevents the cancelled attempt from starting', async t => {
  const voice = await fixture(t); await voice.configure({ enabled: true });
  const leaseId = 'cancelled-request-123456789';
  await voice.close('user-a', leaseId);
  await assert.rejects(voice.open('user-a', { leaseId }), /停止|取消|关闭/);
  assert.equal(voice.state.pid, null);
});

test('closing a loading model releases the process before readiness', async t => {
  const voice = await fixture(t, { readyDelay: 1200, requestTimeoutMs: 2000 });
  await voice.configure({ enabled: true });
  const leaseId = 'loading-request-123456789';
  const opening = voice.open('user-a', { leaseId });
  const rejected = assert.rejects(opening, /停止|关闭/);
  while (!voice.state.pid) await new Promise(resolve => setTimeout(resolve, 10));
  const pid = voice.state.pid; await voice.close('user-a', leaseId); await rejected;
  assert.equal(voice.state.pid, null); assert.throws(() => process.kill(pid, 0));
});

const taiwanVoice = 'zh_female_wanwanxiaohe_moon_bigtts';
const volcengine = { authMode: 'apiKey', apiKey: 'tts-test-only-secret', resourceId: 'seed-tts-1.0' };
const audioResponse = () => new Response('{"code":0,"data":"SUQz"}\n{"code":0,"data":"YWJj"}\n{"code":20000000,"data":null}\n');

test('live synthesis pulls PCM under its own lease before completion and stops on close', async t => {
  let output, networkSignal;
  const voice = await fixture(t, { ttsRequest: async (_url, options) => {
    networkSignal = options.signal;
    assert.equal(JSON.parse(options.body).req_params.audio_params.format, 'pcm');
    return new Response(new ReadableStream({ start(controller) { output = controller; } }));
  } });
  await voice.configure({ provider: 'volcengine', volcengine });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  const stream = await voice.ttsStart('reader', { leaseId: lease.leaseId });
  const args = { leaseId: lease.leaseId, streamId: stream.streamId };
  await voice.ttsText('reader', { ...args, text: '你好。' }); await voice.ttsFinish('reader', args);
  await assert.rejects(voice.ttsRead('other', args), /失效/);
  output.enqueue(new TextEncoder().encode('{"code":0,"data":"AQIDBA=="}\n'));
  const first = await voice.ttsRead('reader', args); assert.equal(first.done, false); assert.equal(first.audio, 'AQIDBA=='); assert.equal(stream.sampleRate, 24000);
  const pending = voice.ttsRead('reader', args); const rejected = assert.rejects(pending, /停止/);
  await voice.close('reader', lease.leaseId); await rejected; assert.equal(networkSignal.aborted, true); assert.equal(voice.state.status, 'off');
  const newer = await voice.open('reader', { mode: 'synthesis' });
  await assert.rejects(voice.ttsText('reader', { ...args, text: '晚到的旧内容' }), /失效/);
  voice.heartbeat('reader', { leaseId: newer.leaseId });
});

test('completed live synthesis keeps bounded chunks until drained and records model/method validation', async t => {
  const voice = await fixture(t, { ttsRequest: async () => new Response('{"code":0,"data":"AQIDBA=="}\n{"code":20000000}\n') });
  await voice.configure({ provider: 'volcengine', volcengine: { ...volcengine, method: 'http-chunked' } });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  const stream = await voice.ttsStart('reader', { leaseId: lease.leaseId }), args = { leaseId: lease.leaseId, streamId: stream.streamId };
  await voice.ttsText('reader', { ...args, text: '你好。' }); await voice.ttsFinish('reader', args);
  let audio = '', done = false; while (!done) { const result = await voice.ttsRead('reader', args); audio += result.audio; done = result.done; }
  assert.equal(audio, 'AQIDBA=='); assert.equal((await voice.settings()).synthesisValidation.modelName, 'seed-tts-1.0');
  await assert.rejects(voice.ttsRead('reader', args), /失效/);
  assert.equal(voice.state.status, 'on');
});

test('failed live handshake records safe validation and permits another synthesis attempt', async t => {
  const voice = await fixture(t, { ttsConnect() { throw Error('private connection detail'); } });
  await voice.configure({ provider: 'volcengine', volcengine: { ...volcengine, method: 'ws-bidirectional' } });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  await assert.rejects(voice.ttsStart('reader', { leaseId: lease.leaseId }), /连接/);
  const state = await voice.settings(); assert.equal(state.synthesisValidation?.status, 'failed');
  assert.ok(!state.synthesisValidation.error.includes('private'));
  await assert.rejects(voice.ttsStart('reader', { leaseId: lease.leaseId }), /连接/);
});

test('ASR worker death releases its live stream so a new lease can synthesize', async t => {
  const voice = await fixture(t);
  await voice.configure({ provider: 'volcengine', volcengine, enabled: true });
  const lease = await voice.open('reader');
  await voice.ttsStart('reader', { leaseId: lease.leaseId });
  process.kill(lease.pid); while (voice.state.pid) await new Promise(resolve => setTimeout(resolve, 10));
  const newer = await voice.open('reader', { mode: 'synthesis' });
  const next = await voice.ttsStart('reader', { leaseId: newer.leaseId });
  assert.ok(next.streamId); await voice.close('reader', newer.leaseId);
});

test('Taiwanese voice credentials are shared, redacted and preserved across restarts and provider switches', async t => {
  const voice = await fixture(t);
  await voice.configure({ voice: 'chattts:1234', rate: -25, pitch: 0 });
  const saved = await voice.configure({ provider: 'volcengine', volcengine });
  assert.equal(saved.provider, 'volcengine'); assert.equal(saved.voice, taiwanVoice);
  assert.equal(saved.volcengine.hasApiKey, true); assert.equal(saved.rate, 0);
  assert.ok(!JSON.stringify(saved).includes(volcengine.apiKey));
  const shared = JSON.parse(await readFile(path.join(path.dirname(voice.dataDir), 'platform', 'settings.json'), 'utf8'));
  assert.equal(shared.speech.volcengine.apiKey, volcengine.apiKey);
  assert.ok(!(await readFile(path.join(voice.dataDir, 'voice-settings.json'), 'utf8')).includes(volcengine.apiKey));
  const restarted = new VoiceRuntime({ dataDir: voice.dataDir }); t.after(() => restarted.dispose());
  assert.equal((await restarted.settings()).volcengine.hasApiKey, true);
  assert.ok(!JSON.stringify(await restarted.status()).includes(volcengine.apiKey));
  await voice.configure({ volcengine: { apiKey: '' }, rate: -20 });
  assert.equal((await voice.settings()).volcengine.hasApiKey, true);
  const local = await voice.configure({ provider: 'chattts' });
  assert.equal(local.voice, 'chattts:1234'); assert.equal(local.rate, -25); assert.equal(local.pitch, 0);
  const taiwan = await voice.configure({ provider: 'volcengine' }); assert.equal(taiwan.rate, -20);
  await assert.rejects(voice.configure({ rate: -51 }), /语速/);
  await assert.rejects(voice.configure({ pitch: 13 }), /音调/);
  await assert.rejects(voice.configure({ voice: 'zh-TW-HsiaoChenNeural' }), /音色/);
});

test('Taiwanese synthesis uses the V3 protocol without starting Python or ASR', async t => {
  let called = 0;
  const voice = await fixture(t, { verifyInstallation: true, command: path.join(tmpdir(), 'not-installed-python.exe'), ttsRequest: async (url, options) => {
    called++;
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    assert.equal(options.headers['X-Api-Key'], volcengine.apiKey);
    assert.equal(options.headers['X-Api-Resource-Id'], 'seed-tts-1.0');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.req_params.speaker, taiwanVoice); assert.equal(body.req_params.text, '欢迎回家');
    assert.deepEqual(body.req_params.audio_params, { format: 'mp3', sample_rate: 24000, speech_rate: -10, loudness_rate: 15 });
    assert.deepEqual(JSON.parse(body.req_params.additions), { post_process: { pitch: 2 } });
    return audioResponse();
  } });
  await voice.configure({ provider: 'volcengine', volcengine, rate: -10, volume: 15, pitch: 2 });
  const status = await voice.status(); assert.equal(status.available, false); assert.equal(status.synthesisAvailable, true);
  const lease = await voice.open('reader', { mode: 'synthesis' }); assert.equal(lease.pid, null);
  const result = await voice.speak('reader', { leaseId: lease.leaseId, text: '欢迎回家' });
  assert.equal(Buffer.from(result.audio, 'base64').toString(), 'ID3abc'); assert.equal(result.mime, 'audio/mpeg');
  assert.equal(called, 1); await voice.close('reader', lease.leaseId); assert.equal(voice.state.status, 'off');
});

test('an unconfigured paid voice stays unavailable and never falls back to Edge', async t => {
  const voice = await fixture(t);
  await voice.configure({ provider: 'volcengine' });
  const status = await voice.status(); assert.equal(status.synthesisAvailable, false); assert.match(status.synthesisError, /API Key/);
  await assert.rejects(voice.open('reader', { mode: 'synthesis' }), /API Key/);
  assert.equal(voice.state.pid, null);
  await voice.configure({ volcengine });
  await voice.configure({ volcengine: { clearCredentials: true } });
  assert.equal((await voice.settings()).volcengine.hasApiKey, false);
});

test('legacy Volcengine authentication uses the app and access token instead of an API Key', async t => {
  let called = false;
  const voice = await fixture(t, { ttsRequest: async (_url, options) => {
    called = true;
    assert.equal(options.headers['X-Api-App-Id'], '123456');
    assert.equal(options.headers['X-Api-Access-Key'], 'legacy-test-token');
    assert.equal(options.headers['X-Api-Key'], undefined);
    return audioResponse();
  } });
  await voice.configure({ provider: 'volcengine', volcengine: { authMode: 'legacy', appId: '123456', accessKey: 'legacy-test-token' } });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  assert.equal((await voice.speak('reader', { leaseId: lease.leaseId, text: '你好' })).mime, 'audio/mpeg');
  assert.equal(called, true);
});

test('stopping a paid synthesis aborts its network request and an old close cannot cancel a newer lease', async t => {
  let entered, networkSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const voice = await fixture(t, { ttsRequest: async (_url, { signal }) => {
    networkSignal = signal; entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await voice.configure({ provider: 'volcengine', volcengine });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  const speaking = voice.speak('reader', { leaseId: lease.leaseId, text: '你好' });
  const rejected = assert.rejects(speaking, /停止|失效|取消/); await started;
  await voice.close('other-reader', lease.leaseId); assert.equal(networkSignal.aborted, false);
  await voice.close('reader', lease.leaseId); await rejected; assert.equal(networkSignal.aborted, true);
  const next = await voice.open('reader', { mode: 'synthesis' });
  await voice.close('reader', lease.leaseId); voice.heartbeat('reader', { leaseId: next.leaseId });
  assert.equal(voice.state.status, 'on');
});

test('abandoned paid synthesis leases expire even when no worker is running', async t => {
  const voice = await fixture(t, { leaseMs: 100 });
  await voice.configure({ provider: 'volcengine', volcengine });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.throws(() => voice.heartbeat('reader', { leaseId: lease.leaseId }), /失效/);
  assert.equal(voice.state.status, 'off');
});

for (const [name, response, pattern] of [
  ['provider failure', () => new Response('{"code":45000001,"message":"tts-test-only-secret private provider body"}\n'), /火山引擎.*45000001/],
  ['authentication failure', () => new Response('private secret', { status: 401 }), /401/],
  ['truncated audio', () => new Response('{"code":0,"data":"SUQz"}\n'), /完整/],
  ['invalid audio', () => new Response('{"code":0,"data":"%%%"}\n{"code":20000000}\n'), /音频/],
]) test(`paid synthesis rejects ${name} without returning secrets or partial audio`, async t => {
  const voice = await fixture(t, { ttsRequest: async () => response() });
  await voice.configure({ provider: 'volcengine', volcengine });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  await assert.rejects(voice.speak('reader', { leaseId: lease.leaseId, text: '你好' }), error => {
    assert.match(error.message, pattern); assert.ok(!error.message.includes(volcengine.apiKey)); assert.ok(!error.message.includes('private')); return true;
  });
});

test('paid synthesis timeout cancels the request and never returns late audio', async t => {
  const keepAlive = setTimeout(() => {}, 500); t.after(() => clearTimeout(keepAlive));
  let aborted = false;
  const voice = await fixture(t, { requestTimeoutMs: 80, ttsRequest: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await voice.configure({ provider: 'volcengine', volcengine });
  const lease = await voice.open('reader', { mode: 'synthesis' });
  await assert.rejects(voice.speak('reader', { leaseId: lease.leaseId, text: '你好' }), /超时/);
  assert.equal(aborted, true); assert.equal(voice.state.status, 'on');
  await voice.close('reader', lease.leaseId); assert.equal(voice.state.status, 'off');
});

test('ASR worker failure also cancels a pending online reply during voice conversation', async t => {
  let entered, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const voice = await fixture(t, { ttsRequest: async (_url, options) => {
    signal = options.signal; entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await voice.configure({ provider: 'volcengine', volcengine, enabled: true });
  const lease = await voice.open('conversation');
  const speech = voice.speak('conversation', { leaseId: lease.leaseId, text: '你好' });
  const rejected = assert.rejects(speech, /停止|失效/); await started;
  process.kill(lease.pid);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(signal.aborted, true);
  await rejected; assert.equal(voice.state.pid, null);
});

test('local synthesis has independent saved voices, returns WAV, and releases its model on provider change', async t => {
  const voice = await fixture(t);
  await voice.configure({ provider: 'volcengine', volcengine, rate: 15 });
  await voice.configure({ provider: 'chattts', voice: 'chattts:1234', rate: -10, volume: 20 });
  const status = await voice.status();
  assert.equal(status.synthesisAvailable, true);
  assert.match(status.synthesis, /ChatTTS/);
  assert.equal(status.settings.voiceCatalog.length, 2650);
  const opened = await voice.open('local-reader', { mode: 'synthesis' });
  const audio = await voice.speak('local-reader', { leaseId: opened.leaseId, text: '欢迎回家。' });
  assert.equal(audio.mime, 'audio/wav');
  const request = JSON.parse(Buffer.from(audio.audio, 'base64').toString());
  assert.equal(request.provider, 'chattts'); assert.equal(request.voice, 'chattts:1234');
  assert.equal(request.rate, -10); assert.equal(request.volume, 20);
  await assert.rejects(voice.configure({ pitch: 1 }), /音调/);
  await assert.rejects(voice.configure({ voice: 'kokoro:103' }), /音色/);
  await voice.configure({ provider: 'volcengine' });
  assert.equal(voice.state.pid, null);
  assert.throws(() => process.kill(opened.pid, 0));
  assert.equal((await voice.settings()).voice, taiwanVoice);
  assert.equal((await voice.settings()).rate, 15);
  await voice.configure({ provider: 'chattts' });
  assert.equal((await voice.settings()).voice, 'chattts:1234');
  assert.equal((await voice.settings()).rate, -10);
});

test('a missing local model cannot silently use cloud speech and low latency preference survives restart', async t => {
  let requests = 0;
  const voice = await fixture(t, { verifyInstallation: true, ttsRequest: async () => { requests++; throw Error('unexpected cloud request'); } });
  await voice.configure({ provider: 'chattts', lowLatency: false });
  const status = await voice.status();
  assert.equal(status.synthesisAvailable, false); assert.match(status.synthesisError, /本地.*模型/);
  await assert.rejects(voice.open('reader', { mode: 'synthesis' }), /本地.*模型/);
  assert.equal(voice.state.pid, null); assert.equal(requests, 0);
  const restarted = new VoiceRuntime({ dataDir: voice.dataDir }); t.after(() => restarted.dispose());
  assert.equal((await restarted.settings()).lowLatency, false);
});

for (const provider of ['chattts', 'qwen3tts']) test(`${provider} keeps one loaded worker across independent previews and control changes`, async t => {
  const voice = await fixture(t);
  await voice.configure({ provider });
  const first = await voice.open('reader', { mode: 'synthesis' });
  await voice.speak('reader', { leaseId: first.leaseId, text: '第一段' });
  await voice.close('reader', first.leaseId, { keepWarm: true });
  assert.equal(voice.state.status, 'idle'); assert.equal(voice.state.modelLoaded, true);
  assert.equal(voice.state.pid, first.pid);
  assert.throws(() => voice.heartbeat('reader', { leaseId: first.leaseId }), /失效/);
  await voice.configure({ enabled: false, volume: 12 }); // A disabled microphone must not unload preview TTS.
  const second = await voice.open('reader', { mode: 'synthesis' });
  assert.equal(second.pid, first.pid); assert.equal(second.reused, true);
  await voice.close('reader', first.leaseId); // Late close cannot kill the new lease.
  const audio = await voice.speak('reader', { leaseId: second.leaseId, text: '第二段' });
  assert.equal(JSON.parse(Buffer.from(audio.audio, 'base64')).volume, 12);
  await voice.close('reader', second.leaseId, { keepWarm: true });
  await voice.close('other-reader'); assert.equal(voice.state.pid, first.pid);
  await voice.close('reader'); assert.equal(voice.state.pid, null);
});

test('a warm synthesis worker gains recognition without reloading synthesis, and disabling unloads it', async t => {
  const voice = await fixture(t);
  const first = await voice.open('reader', { mode: 'synthesis' });
  await voice.close('reader', first.leaseId, { keepWarm: true });
  await voice.configure({ enabled: true });
  const next = await voice.open('reader');
  assert.equal(next.pid, first.pid); assert.equal(next.reused, true);
  assert.equal((await voice.transcribe('reader', { leaseId: next.leaseId, pcm: Buffer.alloc(16000).toString('base64') })).text, '你好小助手');
  await voice.close('reader', next.leaseId, { keepWarm: true });
  await voice.configure({ enabled: false });
  assert.equal(voice.state.pid, null); assert.throws(() => process.kill(first.pid, 0));
});

test('stopping pending work discards its result and safely reuses the worker after it drains', async t => {
  const voice = await fixture(t); await voice.configure({ enabled: true });
  const first = await voice.open('reader');
  const pending = voice.transcribe('reader', { leaseId: first.leaseId, pcm: Buffer.alloc(16000).toString('base64') });
  const rejected = assert.rejects(pending, /停止|失效/);
  await voice.close('reader', first.leaseId, { keepWarm: true }); await rejected;
  const second = await voice.open('reader', { mode: 'synthesis' });
  assert.equal(second.pid, first.pid);
  const audio = await voice.speak('reader', { leaseId: second.leaseId, text: '新任务' });
  assert.equal(JSON.parse(Buffer.from(audio.audio, 'base64')).text, '新任务');
});

test('switching provider unloads an idle resident model and dispose releases its replacement', async t => {
  const voice = await fixture(t);
  const first = await voice.open('reader', { mode: 'synthesis' });
  await voice.close('reader', first.leaseId, { keepWarm: true });
  await voice.configure({ provider: 'qwen3tts' });
  assert.equal(voice.state.pid, null); assert.throws(() => process.kill(first.pid, 0));
  const next = await voice.open('reader', { mode: 'synthesis' });
  await voice.close('reader', next.leaseId, { keepWarm: true });
  await voice.dispose(); assert.equal(voice.state.pid, null); assert.throws(() => process.kill(next.pid, 0));
});
