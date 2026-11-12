import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VoiceRuntime } from '../server/voice-runtime.js';

const root = path.resolve('.'), evidence = path.join(root, 'test-results', 'voice-integration');
await mkdir(evidence, { recursive: true });
const filename = path.join(evidence, 'reference-zh.wav');
try { await readFile(filename); } catch {
  const result = await fetch('https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/zh.wav');
  assert.ok(result.ok); await writeFile(filename, Buffer.from(await result.arrayBuffer()));
}
const wav = await readFile(filename);
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
let offset = 12, pcm;
while (offset + 8 <= wav.length) { const size = wav.readUInt32LE(offset + 4); if (wav.toString('ascii', offset, offset + 4) === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
assert.ok(pcm?.length);
const dir = await mkdtemp(path.join(tmpdir(), 'voice-real-'));
const runtime = new VoiceRuntime({ dataDir: dir, command: path.join(root, 'data', 'assistant', 'voice-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') });
runtime.modelDir = path.join(root, 'data', 'assistant', 'models', 'sensevoice-int8');
const metrics = {};
async function memoryMiB(pid) {
  if (process.platform !== 'win32') return null;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).WorkingSet64`], { windowsHide: true });
  return Math.round(Number(stdout.trim()) / 1024 / 1024);
}
try {
  await runtime.configure({ enabled: true });
  let start = performance.now(); const lease = await runtime.open('test'); metrics.loadMs = Math.round(performance.now() - start);
  const heartbeat = setInterval(() => runtime.heartbeat('test', { leaseId: lease.leaseId }), 3000);
  try {
    metrics.loadedMemoryMiB = await memoryMiB(lease.pid);
    start = performance.now(); const result = await runtime.transcribe('test', { leaseId: lease.leaseId, pcm: pcm.toString('base64') }); metrics.asrMs = Math.round(performance.now() - start);
    assert.match(result.text, /时间早上9点至下午5点/); console.log('PASS: real Chinese ASR:', result.text);
    const silence = await runtime.transcribe('test', { leaseId: lease.leaseId, pcm: Buffer.alloc(32000).toString('base64') });
    assert.equal(silence.text, ''); console.log('PASS: Silero rejects silence');
    metrics.afterRecognitionMemoryMiB = await memoryMiB(lease.pid);
    start = performance.now(); const speech = await runtime.speak('test', { leaseId: lease.leaseId, text: '你好，我是你的家庭助手。语音连接正常。' }); metrics.synthesisMs = Math.round(performance.now() - start);
    const audio = Buffer.from(speech.audio, 'base64'); assert.ok(audio.length > 4000); assert.equal(speech.mime, 'audio/mpeg');
    await writeFile(path.join(evidence, 'synthesis.mp3'), audio); metrics.audioBytes = audio.length; metrics.pid = lease.pid;
    console.log('PASS: real EdgeTTS audio generated');
  } finally { clearInterval(heartbeat); }
  await runtime.close(); assert.equal(runtime.state.pid, null); assert.throws(() => process.kill(lease.pid, 0));
  metrics.released = true; await writeFile(path.join(evidence, 'runtime-metrics.json'), JSON.stringify(metrics, null, 2)); console.log(JSON.stringify(metrics));
} finally { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); }
