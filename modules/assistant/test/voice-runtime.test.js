import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceRuntime } from '../server/voice-runtime.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'voice-runtime-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const worker = path.join(dataDir, 'worker.cjs');
  await writeFile(worker, `
    const rl = require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => { const m = JSON.parse(line);
      if(m.action==='hang') return;
      const result = m.action==='transcribe' ? {text:process.env.FREECAMERA_VOICE_SECRET_PROBE ? 'unexpected-env' : '你好小助手'} : m.action==='speak' ? {audio:'SUQz',mime:'audio/mpeg'} : {};
      setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,ok:true,...result})+'\\n'),m.action==='transcribe'?120:0);
    });
    setTimeout(()=>process.stdout.write(JSON.stringify({type:'ready'})+'\\n'), ${options.readyDelay || 0});
  `);
  const voice = new VoiceRuntime({ dataDir, command: process.execPath, worker, verifyInstallation: false, leaseMs: 600, requestTimeoutMs: 1000, ...options });
  t.after(() => voice.dispose());
  return voice;
}

test('voice settings survive restart and do not accept arbitrary synthesis settings', async t => {
  const voice = await fixture(t);
  assert.equal((await voice.settings()).enabled, false);
  const saved = await voice.configure({ enabled: true, voice: 'zh-CN-YunxiNeural', rate: 10, silenceMs: 1200, autoListen: false });
  assert.equal(saved.voice, 'zh-CN-YunxiNeural');
  await assert.rejects(voice.configure({ voice: '../../secret' }), /音色/);
  await assert.rejects(voice.configure({ silenceMs: 0 }), /静音/);
  const restarted = new VoiceRuntime({ dataDir: voice.dataDir });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.settings()).rate, 10);
  assert.equal((await restarted.settings()).autoListen, false);
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
