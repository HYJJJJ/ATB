import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModule } from '../server/index.js';
import { SharedSettings } from '../../../server/shared-settings.js';
const require = createRequire(import.meta.url);
const { createDesktopModule } = require('../desktop/index.cjs');

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
  assert.deepEqual(Object.keys(module.handlers), ['voice']);
  const status = await module.handlers.voice(11, { action: 'status' });
  assert.equal(status.pid, null);
  assert.equal(status.setupDataDir, path.join(dataRoot, 'data', 'assistant'));
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
