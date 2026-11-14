import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceRuntime } from '../server/voice-runtime.js';

for (const provider of ['edge', 'kokoro', 'zipvoice', 'f5tts']) test(`legacy ${provider} migrates to local ChatTTS without rewriting personal settings on read`, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'zipvoice-migration-'));
  const file = path.join(dataDir, 'voice-settings.json');
  const original = JSON.stringify({ provider, voice: provider === 'edge' ? 'zh-TW-HsiaoChenNeural' : 'kokoro:3', rate: 20, pitch: -30, volume: 15, enabled: true, lowLatency: false });
  await writeFile(file, original);
  const runtime = new VoiceRuntime({ dataDir });
  t.after(async () => { await runtime.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const settings = await runtime.settings();
  assert.equal(settings.provider, 'chattts'); assert.equal(settings.voice, 'chattts:42');
  assert.equal(settings.pitch, 0); assert.equal(settings.rate, 20); assert.equal(settings.volume, 15);
  assert.equal(settings.enabled, true); assert.equal(settings.lowLatency, false);
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(runtime.configure({ provider: 'edge' }), /服务无效/);
  await assert.rejects(runtime.catalog({ provider: 'edge', refresh: true }), /服务无效/);
  const status = await runtime.status(); assert.equal(status.synthesisAvailable, false);
  await assert.rejects(runtime.open('test', { mode: 'synthesis' }), /本地.*模型/);
});

test('removing F5 restores an existing ChatTTS profile and preserves Qwen/cloud profiles without rewriting on read', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'f5-removal-'));
  const file = path.join(dataDir, 'voice-settings.json');
  const original=JSON.stringify({provider:'f5tts',voice:'f5tts:en',enabled:true,profiles:{
   chattts:{voice:'chattts:speaker:seed_189',rate:15,volume:30,pitch:0},
   qwen3tts:{voice:'qwen3tts:sohee',rate:-10,volume:10,pitch:0},
   volcengine:{voice:'zh_female_wanwanxiaohe_moon_bigtts',rate:25,volume:0,pitch:3}
  }});
  await writeFile(file,original);
  const runtime=new VoiceRuntime({dataDir});t.after(async()=>{await runtime.dispose();await rm(dataDir,{recursive:true,force:true});});
  const settings=await runtime.settings();
  assert.equal(settings.provider,'chattts');assert.equal(settings.voice,'chattts:speaker:seed_189');assert.equal(settings.rate,15);assert.equal(settings.volume,30);
  assert.equal(await readFile(file,'utf8'),original);
  await assert.rejects(runtime.configure({provider:'f5tts'}),/服务无效/);
  await assert.rejects(runtime.catalog({provider:'f5tts'}),/服务无效/);
  await runtime.configure({provider:'qwen3tts'});assert.equal((await runtime.settings()).voice,'qwen3tts:sohee');
  await runtime.configure({provider:'volcengine'});assert.equal((await runtime.settings()).pitch,3);
  await runtime.configure({provider:'chattts'});
  const restarted=new VoiceRuntime({dataDir});t.after(()=>restarted.dispose());
  assert.equal((await restarted.settings()).voice,'chattts:speaker:seed_189');assert.equal((await restarted.settings()).rate,15);
});
