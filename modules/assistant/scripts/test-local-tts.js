import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VoiceRuntime } from '../server/voice-runtime.js';

const root = path.resolve('.'), evidence = path.join(root, 'test-results/tts-residency');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, 'local-runtime-'));
const dataDir = path.join(directory, 'assistant'); await mkdir(dataDir);
for (const name of ['voice-runtime', 'tts-runtime', 'qwen-tts-runtime', 'models']) await symlink(path.join(root, 'data/assistant', name), path.join(dataDir, name), process.platform === 'win32' ? 'junction' : 'dir');
const runtime = new VoiceRuntime({ dataDir }); let heartbeat;
try {
  const reports = [];
  for (const provider of ['qwen3tts', 'chattts']) {
  assert.equal(await runtime.localTtsInstalled(provider), true);
  await runtime.configure({ provider, voice: provider === 'qwen3tts' ? 'qwen3tts:serena' : 'chattts:42' });
  const began = performance.now(); let { leaseId, pid, mode, model } = await runtime.open('local-test', { mode: 'synthesis' });
  const loadMs = Math.round(performance.now() - began);
  assert.equal(mode, 'synthesis'); assert.equal(model, null, 'preview must not load ASR');
  heartbeat = setInterval(() => runtime.heartbeat('local-test', { leaseId }), 3000);
  const report = { model: provider, provider: runtime.state.backend, configuredThreads: 2, loadMs, samples: [] };
  for (let i = 0; i < 2; i++) {
    const started = performance.now();
    const result = await runtime.speak('local-test', { leaseId, text: '你好，我是你的家庭助手，欢迎回家。' });
    const synthesisMs = Math.round(performance.now() - started), wave = Buffer.from(result.audio, 'base64');
    assert.equal(result.mime, 'audio/wav'); assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wave.readUInt16LE(22), 1); assert.equal(wave.readUInt16LE(34), 16);
    const sampleRate = wave.readUInt32LE(24); assert.ok(sampleRate >= 16000);
    let peak = 0; for (let at = 44; at < wave.length - 1; at += 2) peak = Math.max(peak, Math.abs(wave.readInt16LE(at)));
    assert.ok(peak > 500, 'actual synthesized samples must not be silent');
    report.samples.push({ synthesisMs, sampleRate, audioMs: Math.round((wave.length - 44) / 2 / sampleRate * 1000), bytes: wave.length, peak });
    if (i === 0) await writeFile(path.join(evidence, provider + '-reference.wav'), wave);
    await runtime.close('local-test', leaseId, { keepWarm: true });
    assert.equal(runtime.state.pid, pid); assert.equal(runtime.state.status, 'idle');
    const opening = performance.now(), next = await runtime.open('local-test', { mode: 'synthesis' });
    assert.equal(next.pid, pid); assert.equal(next.reused, true); leaseId = next.leaseId;
    report.samples.at(-1).nextOpenMs = Math.round(performance.now() - opening);
  }
  await runtime.close('local-test', leaseId, { keepWarm: true });
  await runtime.configure({ enabled: true });
  const upgrading = performance.now(), conversation = await runtime.open('local-test');
  assert.equal(conversation.pid, pid); assert.equal(conversation.reused, true);
  leaseId = conversation.leaseId;
  assert.equal((await runtime.transcribe('local-test', { leaseId, pcm: Buffer.alloc(16000).toString('base64') })).text, '');
  report.recognitionUpgradeMs = Math.round(performance.now() - upgrading);
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { windowsHide: true });
    report.workingSetMB = Math.round(Number(stdout.trim()) / 1024 / 1024);
  }
  clearInterval(heartbeat); await runtime.close('local-test', leaseId);
  assert.equal(runtime.state.pid, null); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  report.released = true; reports.push(report);
  console.log(JSON.stringify(report));
  }
  await writeFile(path.join(evidence, 'local-tts-report.json'), JSON.stringify(reports, null, 2));
  console.log('LOCAL_TTS_REAL_PASS');
} finally {
  clearInterval(heartbeat); await runtime.dispose();
  for (const name of ['voice-runtime', 'tts-runtime', 'qwen-tts-runtime', 'models']) await unlink(path.join(dataDir, name));
  await rm(directory, { recursive: true, force: true });
}
