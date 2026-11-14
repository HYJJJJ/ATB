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
  const billingCalls = [];
  const routes = createPlatformRoutes({ accounts, shared, modules: { list: () => [], errors: [] }, request,
    billingRequest: async options => { billingCalls.push(options); return { Result: { AvailableBalance: '77.01', CashBalance: '83.01' } }; } });
  const moduleRoutes = assistant ? await createAssistantRoutes({ accounts, shared, dataDir: dir, request }) : null;
  if (moduleRoutes) t.after(() => moduleRoutes.close());
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://localhost'); if (await routes(req, res, url.pathname) || moduleRoutes && await moduleRoutes(req, res, url.pathname)) return; res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  const get = (url, cookie = '__Host-freecamera=ok') => fetch(`http://${host}${url}`, { headers: { cookie } });
  const post = (url, body, origin = `https://${host}`) => fetch(`http://${host}${url}`, { method: 'POST', headers: { cookie: '__Host-freecamera=ok', origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { shared, calls, billingCalls, get, post };
}
const config = { provider: 'custom', baseUrl: 'https://api.example/v1', model: 'default', selectedModels: ['other'], apiKey: 'fixture-secret' };

test('platform billing is authenticated, shares only redacted configuration and never reuses speech keys', async t => {
  const { get, post, shared, billingCalls } = await fixture(t);
  const endpoint = '/api/platform/billing/volcengine';
  assert.equal((await get(endpoint, '')).status, 401);
  assert.equal((await get(endpoint + '/balance', '')).status, 401);
  assert.equal((await post(endpoint, {}, 'https://evil.example')).status, 403);
  await shared.update('speech', () => ({ volcengine: { apiKey: 'speech-only-key' } }));
  assert.deepEqual(await (await get(endpoint + '/balance')).json(), { kind: 'unconfigured' });
  assert.equal(billingCalls.length, 0);
  assert.equal((await post(endpoint, { accessKeyId: 'fixture-ak' })).status, 400);
  let response = await post(endpoint, { accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-sk' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { configured: true });
  const exposed = JSON.stringify(await (await get('/api/platform/settings')).json());
  assert.ok(!/fixture-ak|fixture-sk|speech-only-key/.test(exposed));
  assert.equal(JSON.parse(exposed).billing.volcengine.configured, true);
  const result = await (await get(endpoint + '/balance')).json();
  assert.equal(result.available, '77.01'); assert.equal(result.cash, '83.01');
  assert.equal(billingCalls.length, 1); assert.match(billingCalls[0].headers.Authorization, /Credential=fixture-ak\//);
  await get(endpoint + '/balance'); assert.equal(billingCalls.length, 1);
  await get(endpoint + '/balance?refresh=1'); assert.equal(billingCalls.length, 2);
  await post(endpoint, { accessKeyId: '', secretAccessKey: '' });
  assert.equal(shared.get('billing').volcengine.secretAccessKey, 'fixture-sk');
  await post(endpoint, { clearCredentials: true });
  assert.deepEqual(await (await get(endpoint + '/balance')).json(), { kind: 'unconfigured' });
  assert.equal(shared.get('speech').volcengine.apiKey, 'speech-only-key');
});

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
  assert.equal(response.status, 200); const publicCall=calls.findLast(call=>{const payload=JSON.parse(call.options.body||'{}');return payload.tools?.some(tool=>(tool.name||tool.function?.name)==='news');}); assert.ok(publicCall);assert.equal(JSON.parse(publicCall.options.body).model, 'other');
  response = await post('/api/assistant/chat', { model: 'unselected', messages: [{ role: 'user', content: '你好' }] });
  assert.equal(response.status, 400);
  response = await post('/api/assistant/settings', { scope: 'model', apiSource: 'custom', provider: 'custom', baseUrl: 'https://module.example/v1', model: 'private-model', apiKey: 'module-key' });
  assert.equal(response.status, 200); value = await response.json();
  assert.equal(value.apiSource, 'custom'); assert.equal(value.model, 'private-model'); assert.equal(value.name, '管家'); assert.equal(value.memory, '偏好中文');
  assert.equal(shared.get('ai').apiKey, 'fixture-secret');
  value = await (await post('/api/assistant/settings', { scope: 'model', apiSource: 'platform' })).json();
  assert.equal(value.model, 'default'); assert.equal(value.hasApiKey, true); assert.equal(value.memory, '偏好中文');
});

test('provider profiles restore persisted models and keys without exposing any profile secret', async t => {
  const { post, get, shared } = await fixture(t);
  await post('/api/platform/ai', { ...config, protocol: 'responses' });
  let value = await (await post('/api/platform/ai', { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'deepseek-secret' })).json();
  assert.equal(value.baseUrl, 'https://api.deepseek.com'); assert.equal(value.protocol, 'chat');
  assert.deepEqual(value.selectedModels, ['deepseek-chat']);
  value = await (await post('/api/platform/ai', { provider: 'custom' })).json();
  assert.equal(value.model, 'default'); assert.equal(value.protocol, 'responses'); assert.equal(value.hasApiKey, true);
  assert.deepEqual(value.selectedModels, ['default', 'other']);
  const reloaded = await SharedSettings.load(path.dirname(path.dirname(shared.file)));
  assert.equal(reloaded.get('ai').profiles.deepseek.apiKey, 'deepseek-secret');
  const exposed = await (await get('/api/platform/ai')).text();
  assert.ok(!/fixture-secret|deepseek-secret|"apiKey"/.test(exposed));
  assert.equal(JSON.parse(exposed).profiles.deepseek.hasApiKey, true);
});

test('provider switches cannot reuse another provider key even with identical base URLs', async t => {
  const { post, calls } = await fixture(t);
  await post('/api/platform/ai', { ...config, baseUrl: 'https://api.openai.com/v1' });
  assert.equal((await post('/api/platform/ai/models', { provider: 'openai' })).status, 400);
  assert.equal(calls.length, 0);
  const value = await (await post('/api/platform/ai', { provider: 'openai' })).json();
  assert.equal(value.hasApiKey, false); assert.equal(value.model, '');
});

test('compatibility presets force official bases, default chat and reject Responses without making a request', async t => {
  const { post, calls } = await fixture(t);
  for (const [provider, baseUrl] of [['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'], ['deepseek', 'https://api.deepseek.com'], ['siliconflow', 'https://api.siliconflow.cn/v1'], ['volcengine', 'https://ark.cn-beijing.volces.com/api/v3']]) {
    const response = await post('/api/platform/ai', { provider, baseUrl: 'https://evil.example/v1', apiKey: 'preset-key', model: 'example' });
    assert.equal(response.status, 200, provider);
    const value = await response.json(); assert.equal(value.baseUrl, baseUrl); assert.equal(value.protocol, 'chat');
    assert.equal((await post('/api/platform/ai/test', { provider, protocol: 'responses' })).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('browser profile drafts preserve unsaved provider edits, accept one save and clear secrets on logout', async () => {
  const { createAiProfileDrafts } = await import('../public/ai-presets.js');
  const drafts = createAiProfileDrafts();
  drafts.reset({ provider: 'custom', baseUrl: 'https://custom.example/v1', model: 'saved', hasApiKey: true, profiles: { openai: { model: 'gpt-example', hasApiKey: true } } });
  drafts.remember({ ...drafts.get('custom'), model: 'draft', apiKey: 'unsaved-secret' });
  assert.equal(drafts.get('openai').baseUrl, 'https://api.openai.com/v1');
  assert.equal(drafts.get('openai').apiKey, '');
  assert.equal(drafts.get('custom').apiKey, 'unsaved-secret');
  assert.equal(drafts.get('custom').model, 'draft');
  drafts.accept({ provider: 'openai', model: 'gpt-example', hasApiKey: true, profiles: {} });
  assert.equal(drafts.get('custom').model, 'draft'); assert.equal(drafts.hasDrafts(), true);
  drafts.clear(); assert.equal(drafts.get('custom').apiKey, ''); assert.equal(drafts.hasDrafts(), false);
});

test('platform provider switching preserves drafts, restores saved profiles after reload and never crosses keys', async t => {
  const { chromium } = await import('playwright');
  const { startServers } = await import('../server/index.js');
  const { SESSION_COOKIE } = await import('../server/accounts.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-profile-ui-'));
  const server = await startServers({ lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, relayPort: 0, publicOrigin: null, dataDir: path.join(directory, 'data'), certDir: path.join(directory, 'certs'), modulesDir: path.join(directory, 'missing-modules') });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await server.accounts.setup('profile-user', 'fixture-password');
  const session = await server.accounts.login('profile-user', 'fixture-password');
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`https://127.0.0.1:${server.secure.address().port}/platform#settings/ai`);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#ai-base-url').fill('https://draft.example/v1');
  await page.locator('#ai-api-key').fill('browser-draft-key');
  await page.locator('#ai-model').fill('custom-draft');
  await page.locator('#ai-protocol').selectOption('responses');
  await page.locator('#ai-provider').selectOption('deepseek');
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  assert.equal(await page.locator('#ai-model').inputValue(), '');
  assert.equal(await page.locator('#ai-protocol').inputValue(), 'chat');
  assert.equal(await page.locator('#ai-base-url').getAttribute('readonly'), '');
  await page.locator('#ai-model').fill('deepseek-chat');
  await page.locator('#ai-api-key').fill('browser-deepseek-key');
  await page.locator('#ai-provider').selectOption('custom');
  assert.equal(await page.locator('#ai-model').inputValue(), 'custom-draft');
  assert.equal(await page.locator('#ai-api-key').inputValue(), 'browser-draft-key');
  assert.equal(await page.locator('#ai-protocol').inputValue(), 'responses');
  await page.locator('#ai-form [type=submit]').click();
  await page.waitForFunction(() => document.getElementById('ai-result').textContent.includes('已保存'));
  assert.equal(await page.evaluate(() => window.atbHasUnsavedChanges()), true, 'other provider draft still needs saving');
  await page.locator('#ai-provider').selectOption('deepseek');
  assert.equal(await page.locator('#ai-api-key').inputValue(), 'browser-deepseek-key');
  await page.locator('#ai-form [type=submit]').click();
  await page.waitForFunction(() => !window.atbHasUnsavedChanges());
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#ai-provider').selectOption('custom');
  assert.equal(await page.locator('#ai-model').inputValue(), 'custom-draft');
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  assert.match(await page.locator('#ai-key-state').textContent(), /已配置/);
  assert.deepEqual(errors, []);
});
