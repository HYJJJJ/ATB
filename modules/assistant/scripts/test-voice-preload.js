import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, unlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VoiceRuntime } from '../server/voice-runtime.js';

// Use installed weights read-only, isolated settings and no microphone or paid API.
const root = path.resolve(import.meta.dirname, '../../..');
const evidence = path.join(root, 'test-results/companion-preload');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, 'runtime-')), dataDir = path.join(directory, 'assistant');
await mkdir(dataDir);
const links = [], reports = [];
const runtime = new VoiceRuntime({ dataDir });
try {
  for (const name of ['voice-runtime', 'tts-runtime', 'qwen-tts-runtime', 'models']) {
    const link = path.join(dataDir, name);
    await symlink(path.join(root, 'data/assistant', name), link, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(link);
  }
  for (const provider of ['chattts', 'qwen3tts']) {
    await runtime.configure({ enabled: true, provider });
    const start = performance.now(), prepared = await runtime.prepare('widget');
    const preloadMs = Math.round(performance.now() - start);
    assert.equal(prepared.prepared, true); assert.equal(prepared.status, 'idle'); assert.equal(prepared.recognitionLoaded, true);
    const next = performance.now(), opened = await runtime.open('widget');
    const clickOpenMs = Math.round(performance.now() - next);
    assert.equal(opened.reused, true); assert.equal(opened.pid, prepared.pid);
    const heartbeat = setInterval(() => runtime.heartbeat('widget', opened), 3000);
    try {
      assert.equal((await runtime.transcribe('widget', { leaseId: opened.leaseId, pcm: Buffer.alloc(16000).toString('base64') })).text, '');
      const result = await runtime.speak('widget', { leaseId: opened.leaseId, text: '语音模型准备好了。' });
      const audio = Buffer.from(result.audio, 'base64');
      assert.equal(result.mime, 'audio/wav'); assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
      assert.ok(audio.length > 1000);
      await runtime.close('widget', opened.leaseId, { keepWarm: true });
      assert.equal(runtime.state.pid, prepared.pid); assert.equal(runtime.state.recognitionLoaded, true);
    } finally { clearInterval(heartbeat); }
    await runtime.close('widget'); assert.equal(runtime.state.pid, null);
    reports.push({ provider, preloadMs, clickOpenMs, reused:true, recognition:true, synthesis:true, released:true });
    console.log(JSON.stringify(reports.at(-1)));
  }
  await writeFile(path.join(evidence, 'real-models.json'), JSON.stringify(reports, null, 2));
  console.log('VOICE_PRELOAD_REAL_PASS');
} finally {
  await runtime.dispose();
  for (const link of links) await unlink(link);
  await rm(directory, { recursive:true, force:true, maxRetries:8, retryDelay:200 });
}
