import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { VoiceRuntime } from '../server/voice-runtime.js';
import { synthesizeVolcengine } from '../server/volcengine-tts.js';

const key = 'test-private-tts-key';
const config = { authMode: 'apiKey', apiKey: key, resourceId: 'seed-tts-1.0' };
const audio = () => new Response('{"code":0,"data":"SUQz"}\n{"code":20000000}\n');
async function runtime(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'atb-volc-catalog-'));
  const voice = new VoiceRuntime({ dataDir: path.join(root, 'assistant'), ...options });
  t.after(async () => { await voice.dispose(); await rm(root, { recursive: true, force: true }); });
  return voice;
}

test('official catalogue separates Xiaohe 2.0, Wanwan 1.0 and S2S-only voices', async t => {
  const voice = await runtime(t);
  const catalog = await voice.catalog({ provider: 'volcengine' });
  assert.ok(catalog.voices.length > 10);
  assert.equal(catalog.voices.find(v => v.id === 'zh_female_xiaohe_uranus_bigtts')?.resourceId, 'seed-tts-2.0');
  assert.equal(catalog.voices.find(v => v.id === 'zh_female_wanwanxiaohe_moon_bigtts')?.resourceId, 'seed-tts-1.0');
  assert.ok(!catalog.voices.some(v => v.id === 'zh_female_xiaohe_jupiter_bigtts'));
  assert.ok(catalog.voices.every(v => v.availability === 'unverified'));
});

test('selecting a catalogue voice matches its model resource while retaining credentials', async t => {
  let requestBody, resource;
  const voice = await runtime(t, { ttsRequest: async (_url, options) => {
    requestBody = JSON.parse(options.body); resource = options.headers['X-Api-Resource-Id'];
    return audio();
  } });
  await voice.configure({ provider: 'volcengine', volcengine: config });
  const settings = await voice.configure({ voice: 'zh_female_xiaohe_uranus_bigtts', volcengine: { apiKey: '', resourceId: 'seed-tts-1.0', sampleRate: 48000 } });
  assert.equal(settings.volcengine.resourceId, 'seed-tts-2.0');
  assert.equal(settings.volcengine.hasApiKey, true);
  const lease = await voice.open('test', { mode: 'synthesis' });
  await voice.speak('test', { leaseId: lease.leaseId, text: '你好' });
  assert.equal(resource, 'seed-tts-2.0');
  assert.equal(requestBody.req_params.audio_params.sample_rate, 48000);
  assert.equal(requestBody.req_params.speaker, 'zh_female_xiaohe_uranus_bigtts');
  assert.equal((await voice.settings()).synthesisValidation?.status, 'passed');
});

test('permission failures retain diagnostic code and log id without leaking provider content', async () => {
  await assert.rejects(synthesizeVolcengine({ text: '你好', voice: 'zh_female_wanwanxiaohe_moon_bigtts', rate: 0, volume: 0, pitch: 0, config,
    request: async () => new Response(JSON.stringify({ header: { code: 45000030, message: `requested resource not granted ${key} private` } }), { status: 403, headers: { 'x-tt-logid': '20261112ABC123' } }),
  }), error => {
    assert.match(error.message, /45000030/); assert.match(error.message, /资源.*授权/);
    assert.match(error.message, /seed-tts-1.0/); assert.match(error.message, /20261112ABC123/);
    assert.ok(!error.message.includes(key)); assert.ok(!error.message.includes('private')); return true;
  });
});

test('failed synthesis records current validation and changing configuration invalidates it', async t => {
  const voice = await runtime(t, { ttsRequest: async () => new Response('{"header":{"code":45000030,"message":"requested resource not granted"}}', { status: 403 }) });
  await voice.configure({ provider: 'volcengine', volcengine: config });
  const lease = await voice.open('test', { mode: 'synthesis' });
  await assert.rejects(voice.speak('test', { leaseId: lease.leaseId, text: '你好' }), /45000030/);
  assert.equal((await voice.settings()).synthesisValidation?.status, 'failed');
  await voice.configure({ volcengine: { apiKey: 'replacement-test-key' } });
  assert.equal((await voice.settings()).synthesisValidation, null);
});

test('catalogue refresh reads public official metadata without sending the speech key and caches it', async t => {
  const voice = await runtime(t, { catalogRequest: async (url, options) => {
    assert.equal(new URL(url).hostname, 'docs.volcengine.com');
    assert.ok(!JSON.stringify(options).includes(key));
    return new Response('## "豆包语音合成模型2.0" 音色列表\n|场景|音色名称|voice_type|语种/方言|\n|通用|测试音色|zh_female_catalogtest_uranus_bigtts|中文|\n## "端到端实时语音大模型 S2S"音色列表\n||仅实时|zh_female_only_jupiter_bigtts|中文|\n');
  } });
  await voice.configure({ provider: 'volcengine', volcengine: config });
  const catalog = await voice.catalog({ provider: 'volcengine', refresh: true });
  assert.equal(catalog.source, 'official-online');
  assert.ok(catalog.voices.some(v => v.id === 'zh_female_catalogtest_uranus_bigtts'));
  assert.ok(!catalog.voices.some(v => v.id === 'zh_female_only_jupiter_bigtts'));
  assert.ok(!(await readFile(path.join(voice.dataDir, 'volcengine-catalog.json'), 'utf8')).includes(key));
});
