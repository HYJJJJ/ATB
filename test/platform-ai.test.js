import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SharedSettings } from '../server/shared-settings.js';
import { createPlatformRoutes } from '../server/platform-routes.js';
import { createAssistantRoutes } from '../modules/assistant/server/assistant-routes.js';

async function fixture(t, assistant = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atb-ai-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = await SharedSettings.load(dir), calls = [];
  const accounts = { session: token => token === 'ok' ? { user: { username: 'admin' } } : null };
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/models') ? { data: [{ id: 'other' }, { id: 'default' }, { id: 'other' }] } : { choices: [{ message: { content: '正常' } }] } };
  };
  const routes = createPlatformRoutes({ accounts, shared, modules: { list: () => [], errors: [] }, request });
  const moduleRoutes = assistant ? await createAssistantRoutes({ accounts, shared, dataDir: dir, request }) : null;
  if (moduleRoutes) t.after(() => moduleRoutes.close());
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://localhost'); if (await routes(req, res, url.pathname) || moduleRoutes && await moduleRoutes(req, res, url.pathname)) return; res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  const get = (url, cookie = '__Host-freecamera=ok') => fetch(`http://${host}${url}`, { headers: { cookie } });
  const post = (url, body, origin = `https://${host}`) => fetch(`http://${host}${url}`, { method: 'POST', headers: { cookie: '__Host-freecamera=ok', origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { shared, calls, get, post };
}
const config = { provider: 'custom', baseUrl: 'https://api.example/v1', model: 'default', selectedModels: ['other'], apiKey: 'fixture-secret' };

test('core AI settings work without assistant, merge selected models and retain redacted keys', async t => {
  const { post, get, shared } = await fixture(t);
  assert.equal((await get('/api/platform/ai', '')).status, 401);
  assert.equal((await post('/api/platform/ai', config, 'https://evil.example')).status, 403);
  let response = await post('/api/platform/ai', config);
  assert.equal(response.status, 200);
  let value = await response.json();
  assert.deepEqual(value.selectedModels, ['default', 'other']);
  assert.equal(value.hasApiKey, true); assert.equal('apiKey' in value, false);
  value = await (await post('/api/platform/ai', { model: 'other', apiKey: '' })).json();
  assert.equal(value.hasApiKey, true); assert.equal(shared.get('ai').apiKey, 'fixture-secret');
  value = await (await post('/api/platform/ai', { baseUrl: 'https://changed.example/v1', apiKey: '' })).json();
  assert.equal(value.hasApiKey, false); assert.equal(shared.get('ai').apiKey, '');
  assert.equal((await post('/api/platform/ai', { selectedModels: [123] })).status, 400);
});

test('core model discovery and testing use unsaved drafts without leaking retained keys to new hosts', async t => {
  const { post, calls, shared } = await fixture(t);
  await post('/api/platform/ai', config);
  assert.deepEqual(await (await post('/api/platform/ai/models', {})).json(), { models: ['default', 'other'] });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-secret');
  assert.equal((await post('/api/platform/ai/models', { baseUrl: 'https://changed.example/v1' })).status, 400);
  assert.equal(calls.length, 1);
  const response = await post('/api/platform/ai/test', { baseUrl: 'https://draft.example/v1', apiKey: 'draft-key', model: 'draft-model' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, model: 'draft-model' });
  assert.equal(calls[1].url, 'https://draft.example/v1/chat/completions');
  assert.equal(JSON.parse(calls[1].options.body).model, 'draft-model');
  assert.equal(shared.get('ai').apiKey, 'fixture-secret');
});

test('assistant inherits shared defaults, isolates custom overrides and accepts only selected chat models', async t => {
  const { post, get, shared, calls } = await fixture(t, true);
  await post('/api/platform/ai', config);
  let value = await (await get('/api/assistant/settings')).json();
  assert.equal(value.apiSource, 'platform'); assert.equal(value.model, 'default');
  await post('/api/assistant/settings', { scope: 'persona', name: '管家', prompt: '简洁' });
  await post('/api/assistant/settings', { scope: 'memory', memory: '偏好中文' });
  let response = await post('/api/assistant/chat', { model: 'other', messages: [{ role: 'user', content: '你好' }] });
  assert.equal(response.status, 200); assert.equal(JSON.parse(calls.at(-1).options.body).model, 'other');
  response = await post('/api/assistant/chat', { model: 'unselected', messages: [{ role: 'user', content: '你好' }] });
  assert.equal(response.status, 400);
  response = await post('/api/assistant/settings', { scope: 'model', apiSource: 'custom', provider: 'custom', baseUrl: 'https://module.example/v1', model: 'private-model', apiKey: 'module-key' });
  assert.equal(response.status, 200); value = await response.json();
  assert.equal(value.apiSource, 'custom'); assert.equal(value.model, 'private-model'); assert.equal(value.name, '管家'); assert.equal(value.memory, '偏好中文');
  assert.equal(shared.get('ai').apiKey, 'fixture-secret');
  value = await (await post('/api/assistant/settings', { scope: 'model', apiSource: 'platform' })).json();
  assert.equal(value.model, 'default'); assert.equal(value.hasApiKey, true); assert.equal(value.memory, '偏好中文');
});
