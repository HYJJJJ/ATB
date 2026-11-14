import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createModule } from '../server/index.js';
import { SharedSettings } from '../../../server/shared-settings.js';
const require = createRequire(import.meta.url);
const { createDesktopModule } = require('../desktop/index.cjs');

test('desktop returns an explicit cancellation for a stopped PCM read and preserves real synthesis failures', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'assistant-voice-cancel-'));
  const { getVoiceRuntime } = await import('../server/voice-runtime.js');
  const runtime = getVoiceRuntime(path.join(dataRoot, 'data', 'assistant'));
  const module = createDesktopModule({ dataRoot });
  t.after(async () => { await module.close(); await rm(dataRoot, { recursive:true, force:true }); });
  let networkSignal;
  runtime.ttsRequest = async (_url, options) => {
    networkSignal = options.signal;
    return new Response(new ReadableStream({ start() {} }));
  };
  await module.handlers.voice(1, { action:'settings', provider:'volcengine', volcengine:{apiKey:'test-only-key',method:'http-chunked'} });
  const lease = await module.handlers.voice(1, { action:'open',mode:'synthesis' });
  const stream = await module.handlers.voice(1, { action:'ttsStart',...lease });
  const args = {leaseId:lease.leaseId,streamId:stream.streamId};
  await module.handlers.voice(1,{action:'ttsText',...args,text:'我查一下近期新闻。'});
  await module.handlers.voice(1,{action:'ttsFinish',...args});
  // Attach immediately: IPC must resolve this normal stop instead of rejecting
  // and producing Electron's "Error occurred in handler" diagnostic.
  const reading = module.handlers.voice(1,{action:'ttsRead',...args});
  const result = reading.then(value=>({value}),error=>({error}));
  await module.handlers.voice(1,{action:'close',leaseId:lease.leaseId,keepWarm:true});
  assert.deepEqual(await result,{value:{cancelled:true}});
  assert.equal(networkSignal.aborted,true);
  assert.equal((await runtime.settings()).synthesisValidation,null);

  runtime.ttsRequest = async () => new Response('{"code":45000030,"message":"requested resource not granted"}',{status:403});
  const next = await module.handlers.voice(1,{action:'open',mode:'synthesis'});
  const nextStream = await module.handlers.voice(1,{action:'ttsStart',...next});
  const nextArgs={leaseId:next.leaseId,streamId:nextStream.streamId};
  await module.handlers.voice(1,{action:'ttsText',...nextArgs,text:'测试'});
  await module.handlers.voice(1,{action:'ttsFinish',...nextArgs});
  await assert.rejects(module.handlers.voice(1,{action:'ttsRead',...nextArgs}),/授权|403/);
  assert.equal((await runtime.settings()).synthesisValidation.status,'failed');

  await module.handlers.voice(1,{action:'close',leaseId:next.leaseId});
  await module.handlers.voice(1,{action:'settings',volcengine:{method:'ws-bidirectional'}});
  let connected;
  const connecting=new Promise(resolve=>{connected=resolve;});
  runtime.ttsConnect=()=>{
    const socket=new EventEmitter();socket.readyState=0;
    socket.terminate=()=>{socket.readyState=3;socket.emit('close');};
    connected();return socket;
  };
  const handshakeLease=await module.handlers.voice(1,{action:'open',mode:'synthesis'});
  const starting=module.handlers.voice(1,{action:'ttsStart',leaseId:handshakeLease.leaseId});
  const startedResult=starting.then(value=>({value}),error=>({error}));
  await connecting;
  await module.handlers.voice(1,{action:'close',leaseId:handshakeLease.leaseId});
  assert.deepEqual(await startedResult,{value:{cancelled:true}},'stopping a pending WebSocket handshake is also normal cancellation');
});

test('foreground attention and voice take priority over wake standby without stale closes killing a new lease', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'assistant-wake-priority-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const dataDir = path.join(dataRoot, 'data', 'assistant'); await mkdir(dataDir, { recursive: true });
  const worker = path.join(dataDir, 'fixture.cjs');
  await writeFile(worker, "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',s=>{const m=JSON.parse(s);console.log(JSON.stringify({id:m.id,ok:true,text:'小鲸鱼'}));});console.log(JSON.stringify({type:'ready'}));");
  const { getVoiceRuntime } = await import('../server/voice-runtime.js'); const runtime = getVoiceRuntime(dataDir);
  runtime.command = runtime.ttsCommand = process.execPath; runtime.worker = worker; runtime.verifyInstallation = false;
  const module = createDesktopModule({ dataRoot, services: () => ({}) }); t.after(() => module.close());
  await module.handlers.voice(1, { action: 'settings', enabled: true });
  const pending = module.handlers.voice(1, { action:'wakeOpen', leaseId:'wake-pending-0000001' });
  const cancelled = assert.rejects(pending, /停止|取消/);
  while (runtime.state.mode !== 'wake') await new Promise(resolve => setImmediate(resolve));
  const claimed = await module.handlers.voice(2, { action:'open', leaseId:'voice-priority-0001' });
  await cancelled; assert.equal(runtime.state.mode, 'conversation');
  await module.handlers.voice(2, { action:'close', leaseId:claimed.leaseId, keepWarm:true });
  const wake = await module.handlers.voice(1, { action: 'wakeOpen', leaseId: 'wake-fixture-0000001' });
  assert.equal(runtime.state.mode, 'wake');
  const originalClose = runtime.close.bind(runtime); let releaseClose, enteredClose;
  const closing = new Promise(resolve => { enteredClose = resolve; }), release = new Promise(resolve => { releaseClose = resolve; });
  runtime.close = async (...args) => { if (args[1] === wake.leaseId) { enteredClose(); await release; } return originalClose(...args); };
  t.after(() => { releaseClose(); runtime.close = originalClose; });
  const attention = module.handlers.presence(2, { action:'attention', active:true }); await closing;
  let settled = false;
  const concurrent = module.handlers.voice(2, { action:'open', leaseId:'voice-concurrent-001' }).then(value => { settled=true; return value; }, error => { settled=true; return error; });
  for (let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve));
  const settledEarly = settled; releaseClose(); await attention; const claimedAfterRelease = await concurrent; runtime.close = originalClose;
  assert.equal(settledEarly, false, 'foreground open waits for the ongoing wake suspension');
  assert.ok(claimedAfterRelease.leaseId, claimedAfterRelease.message);
  await module.handlers.voice(2, { action:'close', leaseId:claimedAfterRelease.leaseId, keepWarm:true });
  assert.equal(runtime.state.status, 'idle');
  await assert.rejects(module.handlers.voice(1, { action: 'wakeOpen', leaseId: 'wake-fixture-0000002' }), /正在|占用/);
  await module.handlers.presence(2, { action: 'attention', active: false });
  const next = await module.handlers.voice(2, { action: 'open', leaseId: 'voice-fixture-000001' });
  assert.equal(next.pid, wake.pid, 'foreground reuses the local model');
  await module.handlers.voice(1, { action: 'close', leaseId: wake.leaseId, keepWarm: true });
  assert.equal(runtime.state.mode, 'conversation');
  await module.handlers.voice(2, { action: 'close', leaseId: next.leaseId, keepWarm: true });
  await module.handlers.voice(1, { action: 'wakeOpen', leaseId: 'wake-fixture-0000003' });
  await module.handlers.voice(2, { action: 'settings', wakeEnabled: false });
  assert.equal(runtime.state.status, 'idle');
  await assert.rejects(module.handlers.voice(1, { action: 'wakeOpen', leaseId: 'wake-fixture-0000004' }), /唤醒/);
});

test('shared AI survives concurrent module initialization and keeps the legacy file available for rollback', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'assistant-module-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const shared = await SharedSettings.load(dataDir);
  const ai = { provider: 'custom', baseUrl: 'https://new.example/v1', protocol: 'chat', model: 'new-model', apiKey: 'new-test-secret' };
  await mkdir(path.join(dataDir, 'assistant'));
  const legacyFile = path.join(dataDir, 'assistant', 'settings.json');
  const legacy = JSON.stringify({ name: '历史助手', memory: '偏好', provider: 'custom', baseUrl: 'https://old.example/v1', model: 'old-model', apiKey: 'old-test-secret' });
  await writeFile(legacyFile, legacy);
  // Queue a platform update before both module migrations read their shared section.
  const platformUpdate = shared.update('ai', () => ai);
  const accounts = { session: () => null };
  const modules = await Promise.all([createModule({ accounts, dataDir, shared }), createModule({ accounts, dataDir, shared })]);
  t.after(() => Promise.all(modules.map(module => module.close())));
  await platformUpdate;
  assert.deepEqual(shared.get('ai'), ai);
  assert.equal(await readFile(legacyFile, 'utf8'), legacy);
  assert.equal(typeof modules[0].handle, 'function');
  for (const module of modules) { await module.close(); await module.close(); }
});

test('desktop voice handler persists settings at the existing data path and closes idempotently', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'assistant-desktop-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const module = createDesktopModule({ dataRoot });
  assert.deepEqual(Object.keys(module.handlers).sort(), ['companion', 'presence', 'voice']);
  assert.equal((await module.handlers.presence(11, { action: 'status' })).supported, false);
  const status = await module.handlers.voice(11, { action: 'status' });
  assert.equal(status.pid, null);
  assert.equal(status.setupDataDir, path.join(dataRoot, 'data', 'assistant'));
  assert.equal((await module.handlers.voice(11, { action: 'prepare' })).prepared, false, 'disabled voice is not preloaded by desktop startup');
  await module.handlers.voice(11, { action: 'settings', enabled: false, rate: 25 });
  const settings = JSON.parse(await readFile(path.join(dataRoot, 'data', 'assistant', 'voice-settings.json'), 'utf8'));
  assert.equal(settings.rate, 25);
  await module.suspend(11); await module.close(); await module.close();
  await assert.rejects(module.handlers.voice(11, { action: 'status' }), /已关闭/);
});

test('closed server module refuses voice operations and cannot restart its worker', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'assistant-closed-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const shared = await SharedSettings.load(dataDir);
  const module = await createModule({ accounts: { session: () => ({ user: { role: 'admin' } }) }, dataDir, shared });
  await module.close();
  let status, body;
  const response = { destroyed: false, writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } };
  assert.equal(await module.handle({ method: 'GET', headers: {} }, response, '/api/assistant/voice/status'), true);
  assert.equal(status, 503); assert.match(body.error, /重新启动/);
});

test('desktop suspension cancels an action already waiting for lazy runtime loading', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'assistant-suspend-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const module = createDesktopModule({ dataRoot });
  const pending = module.handlers.voice(21, { action: 'settings', rate: 25 });
  const result = assert.rejects(pending, /已停止|已关闭/);
  await module.suspend(21); await result; await module.close();
  await assert.rejects(readFile(path.join(dataRoot, 'data', 'assistant', 'voice-settings.json')), { code: 'ENOENT' });
});

test('local face assets require a session and serve only explicit model filenames', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'assistant-face-assets-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const module = await createModule({ accounts: { session: token => token === 'ok' ? { user: { username: 'fixture' } } : null }, dataDir }); t.after(() => module.close());
  let code, headers, content;
  const response = { writeHead(status, next) { code = status; headers = next; }, end(body) { content = body; } };
  const route = '/modules/assistant/vision/';
  await module.handle({ method: 'GET', headers: {} }, response, route + 'face-api.min.js'); assert.equal(code, 401);
  const request = { method: 'GET', headers: { cookie: '__Host-freecamera=ok' } };
  await module.handle(request, response, route + 'tiny_face_detector_model-shard1'); assert.equal(code, 200); assert.equal(headers['Content-Type'], 'application/octet-stream'); assert.equal(content.length, 193321);
  await module.handle(request, response, route + '../../settings.json'); assert.equal(code, 404);
});
