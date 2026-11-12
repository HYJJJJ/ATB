import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAssistantRoutes } from '../server/assistant-routes.js';

test('assistant requires a session and same origin, persists settings without revealing the key, and passes memory to the model', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'assistant-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let upstream;
  const request = async (url, options) => { upstream = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content: '你好' } }] }) }; };
  const accounts = { session: token => token === 'ok' ? { user: { role: 'admin' } } : null };
  let routes = await createAssistantRoutes({ accounts, dataDir: dir, request });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`, base = `http://${host}`, cookie = '__Host-freecamera=ok';
  const post = (url, body, origin = `https://${host}`) => fetch(base + url, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/assistant/settings')).status, 401);
  const data = { name: '管家', prompt: '简洁回答', provider: 'dashscope', model: 'qwen-plus', memory: '喜欢咖啡', apiKey: 'test-secret' };
  assert.equal((await post('/api/assistant/settings', data, 'https://evil.example')).status, 403);
  let response = await post('/api/assistant/settings', data); let result = await response.json(); assert.equal(result.hasApiKey, true); assert.equal(JSON.stringify(result).includes('test-secret'), false);
  routes = await createAssistantRoutes({ accounts, dataDir: dir, request });
  response = await fetch(base + '/api/assistant/settings', { headers: { cookie } }); result = await response.json(); assert.equal(result.memory, '喜欢咖啡'); assert.equal(result.hasApiKey, true);
  response = await post('/api/assistant/chat', { messages: [{ role: 'user', content: '你好' }] }); assert.deepEqual(await response.json(), { reply: '你好' });
  assert.match(upstream.url, /^https:\/\/dashscope\.aliyuncs\.com\//); assert.match(JSON.parse(upstream.options.body).messages[0].content, /喜欢咖啡/);
  response = await post('/api/assistant/settings', { ...data, apiKey: '', clearKey: true }); assert.equal((await response.json()).hasApiKey, false);
});

test('custom OpenAI compatible endpoints list models and never send an old key to a changed host', async t => {
 const dir = await mkdtemp(path.join(tmpdir(), 'assistant-custom-')); t.after(() => rm(dir, { recursive: true, force: true }));
 const calls = []; const request = async (url, options) => { calls.push({url, options}); return {ok:true, json:async()=>({data:[{id:'model-a'},{id:'model-b'}]})}; };
 const accounts = { session: token => token === 'ok' ? {user:{role:'admin'}} : null };
 const routes = await createAssistantRoutes({accounts,dataDir:dir,request});
 const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost').pathname)); await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
 const host=`127.0.0.1:${server.address().port}`, base=`http://${host}`, headers={cookie:'__Host-freecamera=ok',origin:`https://${host}`,'content-type':'application/json'};
 const post=(url,data)=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(data)});
 const settings={name:'助手',prompt:'',provider:'custom',baseUrl:'https://example.com/v1',model:'model-a',memory:'',apiKey:'secret'};
 assert.equal((await post('/api/assistant/settings',settings)).status,200);
 let result=await (await post('/api/assistant/models',{})).json(); assert.deepEqual(result.models,['model-a','model-b']); assert.equal(calls[0].url,'https://example.com/v1/models');
 result=await (await post('/api/assistant/settings',{...settings,baseUrl:'https://other.example/v1',apiKey:''})).json(); assert.equal(result.hasApiKey,false);
 assert.equal((await post('/api/assistant/models',{})).status,400);
 assert.equal((await post('/api/assistant/settings',{...settings,baseUrl:'http://127.0.0.1/v1'})).status,400);
});

async function assistantFixture(t, request) {
  const dir = await mkdtemp(path.join(tmpdir(), 'assistant-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = { session: token => token === 'ok' ? { user: { role: 'admin' } } : null };
  const routes = await createAssistantRoutes({ accounts, dataDir: dir, request });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`http://${host}/api/assistant/${route}`, { method: 'POST', headers: { cookie: '__Host-freecamera=ok', origin: `https://${host}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('settings', { name: '助手', prompt: '简短回答', provider: 'custom', baseUrl: 'https://example.com/v1', model: 'chosen-model', memory: '', apiKey: 'first-secret' });
  return { post, host };
}

test('saving one settings section cannot change other sections and concurrent saves are merged', async t => {
  const { post } = await assistantFixture(t);
  const results = await Promise.all([
    post('settings', { scope: 'persona', name: '新助手', prompt: '认真回答' }),
    post('settings', { scope: 'memory', memory: '偏好蓝色' }),
  ]);
  for (const response of results) assert.equal(response.status, 200);
  const response = await post('settings', { scope: 'memory', memory: '偏好蓝色', baseUrl: 'https://other.example/v1', apiKey: 'accidental-key' });
  const result = await response.json();
  assert.equal(result.name, '新助手'); assert.equal(result.memory, '偏好蓝色');
  assert.equal(result.baseUrl, 'https://example.com/v1'); assert.equal(result.hasApiKey, true);
});

test('model discovery accepts unsaved draft settings without saving credentials', async t => {
  let call;
  const { post } = await assistantFixture(t, async (url, options) => { call = { url, options }; return { ok: true, json: async () => ({ data: [{ id: 'new-model' }, { id: 'new-model' }, null] }) }; });
  let response = await post('models', { provider: 'custom', baseUrl: 'https://draft.example/v1', apiKey: 'draft-secret' });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).models, ['new-model']);
  assert.equal(call.url, 'https://draft.example/v1/models'); assert.equal(call.options.headers.Authorization, 'Bearer draft-secret');
  response = await post('settings', { scope: 'memory', memory: '' });
  assert.equal((await response.json()).baseUrl, 'https://example.com/v1');
});

test('Responses protocol uses instructions and parses output messages', async t => {
  let call;
  const { post } = await assistantFixture(t, async (url, options) => { call = { url, options }; return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '连接正常' }] }] }) }; });
  const saved = await post('settings', { scope: 'model', provider: 'custom', baseUrl: 'https://example.com/v1', model: 'chosen-model', protocol: 'responses', apiKey: '' });
  assert.equal((await saved.json()).protocol, 'responses');
  const response = await post('chat', { messages: [{ role: 'user', content: '测试' }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).reply, '连接正常');
  assert.equal(call.url, 'https://example.com/v1/responses');
  const body = JSON.parse(call.options.body); assert.match(body.instructions, /简短回答/); assert.equal(body.store, false); assert.equal(body.input[0].content, '测试');
});

test('null bodies and malformed model JSON return safe errors without echoing provider content', async t => {
  const { post } = await assistantFixture(t, async () => ({ ok: true, json: async () => { throw new SyntaxError('provider-secret'); } }));
  assert.equal((await post('chat', null)).status, 400);
  const response = await post('chat', { messages: [{ role: 'user', content: '测试' }] });
  assert.equal(response.status, 502); assert.equal(JSON.stringify(await response.json()).includes('provider-secret'), false);
});

test('connection testing does not send persona or memory and long replies remain valid context', async t => {
  const calls = [];
  const answer = '详细回复'.repeat(1600);
  const { post } = await assistantFixture(t, async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  });
  await post('settings', { scope: 'memory', memory: '不应发送的私人记忆' });
  let response = await post('test', {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, model: 'chosen-model' });
  assert.equal(JSON.stringify(calls[0]).includes('不应发送的私人记忆'), false);
  assert.equal(JSON.stringify(calls[0]).includes('简短回答'), false);
  response = await post('chat', { messages: [{ role: 'user', content: '继续' }, { role: 'assistant', content: answer }, { role: 'user', content: '再继续' }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, answer);
});

test('UTF-8 characters split across HTTP chunks remain unchanged', async t => {
  const { host } = await assistantFixture(t);
  const body = Buffer.from(JSON.stringify({ scope: 'memory', memory: '长期记忆保持完整' }));
  const split = body.indexOf(Buffer.from('长')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`http://${host}/api/assistant/settings`, { method: 'POST', headers: { cookie: '__Host-freecamera=ok', origin: `https://${host}`, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 20);
  });
  assert.equal(result.status, 200); assert.equal(result.body.memory, '长期记忆保持完整');
});


// AI credentials become authoritative in shared settings; persona stays in assistant data.
test('legacy AI settings migrate once without overwriting shared AI or duplicating later credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'assistant-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assistant'));
  const legacy = { name: '旧助手', prompt: '原角色', memory: '原记忆', provider: 'custom', baseUrl: 'https://old.example/v1', protocol: 'chat', model: 'old-model', apiKey: 'old-secret' };
  const file = path.join(dir, 'assistant', 'settings.json');
  await writeFile(file, JSON.stringify(legacy));
  let ai; let pending = Promise.resolve();
  const shared = { get: () => ai === undefined ? undefined : structuredClone(ai), update: (_section, mutator) => { const task = pending.then(() => { ai = structuredClone(mutator(ai === undefined ? undefined : structuredClone(ai))); return structuredClone(ai); }); pending = task.catch(() => {}); return task; } };
  const accounts = { session: () => ({ user: { role: 'admin' } }) };
  const routes = await createAssistantRoutes({ accounts, dataDir: dir, shared });
  t.after(() => routes.close());
  assert.equal(ai?.apiKey, 'old-secret');
  ai = { ...ai, model: 'new-model', apiKey: 'new-secret' };
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = '127.0.0.1:' + server.address().port;
  const response = await fetch('http://' + host + '/api/assistant/settings', { headers: { cookie: '__Host-freecamera=ok' } });
  const value = await response.json();
  assert.equal(value.model, 'new-model'); assert.equal(value.name, '旧助手'); assert.equal(value.hasApiKey, true);
  assert.equal(JSON.stringify(value).includes('secret'), false);
  const post = await fetch('http://' + host + '/api/assistant/settings', { method: 'POST', headers: { cookie: '__Host-freecamera=ok', origin: 'https://' + host, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'persona', name: '新角色', prompt: '新说明' }) });
  assert.equal(post.status, 200);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.name, '新角色'); assert.equal(persisted.apiKey, 'old-secret');
  assert.equal(JSON.stringify(persisted).includes('new-secret'), false);
  const reopened = await createAssistantRoutes({ accounts, dataDir: dir, shared });
  t.after(() => reopened.close()); assert.equal(ai.apiKey, 'new-secret');
});
