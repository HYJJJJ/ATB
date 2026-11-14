import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAssistantRoutes } from '../server/assistant-routes.js';
const isPublicCall = payload => (!payload.tools || payload.tools.some(tool => (tool.name || tool.function?.name) === 'news')) && !payload.response_format && !payload.text?.format;

test('assistant requires a session and same origin, persists settings without revealing the key, and passes memory to the model', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'assistant-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let upstream;
  const request = async (url, options) => { if (isPublicCall(JSON.parse(options.body))) upstream = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content: '你好' } }] }) }; };
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
  let authorized = true;
  const accounts = { session: token => authorized && token === 'ok' ? { user: { role: 'admin' } } : null };
  const routes = await createAssistantRoutes({ accounts, dataDir: dir, request });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`http://${host}/api/assistant/${route}`, { method: 'POST', headers: { cookie: '__Host-freecamera=ok', origin: `https://${host}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('settings', { name: '助手', prompt: '简短回答', provider: 'custom', baseUrl: 'https://example.com/v1', model: 'chosen-model', memory: '', apiKey: 'first-secret' });
  t.after(() => routes.close());
  return { post, host, revoke: () => { authorized = false; } };
}

test('24h usage route requires auth, uses current API and redacts individual logs',async t=>{
 const second=Math.floor(Date.now()/1000),calls=[];
 const {host}=await assistantFixture(t,async(url,options)=>{
  calls.push(new URL(url).pathname);assert.equal(options.body,undefined,'statistics never call a paid model');
  const p=new URL(url).pathname;
  const body=p==='/api/status'?{success:true,data:{quota_display_type:'USD',quota_per_unit:500000}}:p==='/api/log/token'?{success:true,data:[{id:1,type:2,quota:50000,created_at:second,content:'private-log'}]}:{code:true,data:{object:'token_usage'}};
  return{ok:true,json:async()=>body};
 });
 const url=`http://${host}/api/assistant/usage`;
 assert.equal((await fetch(url)).status,401);assert.equal(calls.length,0);
 const response=await fetch(url,{headers:{cookie:'__Host-freecamera=ok'}});assert.equal(response.status,200);
 const value=await response.json();assert.equal(value.kind,'usage');assert.equal(value.amount,'0.10');assert.equal(value.scope,'key');assert.equal(value.coverage,'recent-records');assert.doesNotMatch(JSON.stringify(value),/private-log|first-secret/);
});

test('providers without daily logs accumulate a labelled balance estimate instead of fake historical usage',async t=>{
 let amount='10.00';
 const {post,host}=await assistantFixture(t,async()=>({ok:true,json:async()=>({balance_infos:[{currency:'CNY',total_balance:amount}]})}));
 await post('settings',{scope:'model',apiSource:'custom',provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',apiKey:'fixture-deepseek',model:'deepseek-chat'});
 const query=()=>fetch(`http://${host}/api/assistant/usage?refresh=1`,{headers:{cookie:'__Host-freecamera=ok'}}).then(r=>r.json());
 assert.equal((await query()).kind,'collecting');await new Promise(r=>setTimeout(r,1100));amount='9.20';
 const value=await query();assert.equal(value.kind,'estimate');assert.equal(value.method,'balance-decrease');assert.equal(value.scope,'account');assert.equal(value.amount,'0.80');assert.ok(value.observedSeconds>=1);assert.ok(value.observedSeconds<60);
});

test('a late usage result is not returned after logout or provider change',async t=>{
 for(const logout of [true,false]){
  let begin,finish;const started=new Promise(r=>begin=r),gate=new Promise(r=>finish=r);
  const {post,host,revoke}=await assistantFixture(t,async(url)=>{
   const p=new URL(url).pathname;if(p==='/api/log/token'){begin();await gate;return{ok:true,json:async()=>({success:true,data:[]})};}
   return{ok:true,json:async()=>p==='/api/status'?{success:true,data:{quota_display_type:'USD',quota_per_unit:500000}}:{code:true,data:{object:'token_usage'}}};
  });
  const work=fetch(`http://${host}/api/assistant/usage`,{headers:{cookie:'__Host-freecamera=ok'}});await started;
  if(logout)revoke();else await post('settings',{scope:'model',apiSource:'custom',provider:'custom',baseUrl:'https://changed.example/v1',apiKey:'changed-secret',model:'new-model'});
  finish();const response=await work;
  if(logout)assert.equal(response.status,401);else{const value=await response.json();assert.equal(value.kind,'unavailable');assert.equal(value.reason,'configuration-changed');}
 }
});

test('AI openings require a fresh one-use claim and never store a synthetic user turn in memory', async t => {
  const calls = [];
  const { post, host } = await assistantFixture(t, async (_url, options) => { const payload = JSON.parse(options.body); if (isPublicCall(payload)) calls.push(payload); return { ok: true, json: async () => ({ choices: [{ message: { content: '欢迎回来，今天想聊什么？' } }] }) }; });
  const descriptors = [0, .001, -.001].map(offset => Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10 + offset));
  await post('presence', { action: 'enroll', name: '测试本人', descriptors });
  const settings = await (await post('presence', { action: 'settings', enabled: true, cameraId: 'test', aiOpening: true, quietEnabled: false })).json();
  const claim = await (await post('presence', { action: 'claim', revision: settings.revision })).json();
  const body = { opening: { revision: settings.revision, claimId: claim.claimId } };
  const reply = await post('chat', body); assert.equal(reply.status, 200); assert.match((await reply.json()).reply, /欢迎回来/);
  assert.equal(calls.length, 1); const payload = JSON.stringify(calls[0]); assert.match(payload, /测试本人/); assert.doesNotMatch(payload, /descriptors/);
  const memory = await (await fetch(`http://${host}/api/assistant/memory`, { headers: { cookie: '__Host-freecamera=ok' } })).json(); assert.equal(memory.pendingTurns, 0); assert.deepEqual(memory.core, []); assert.deepEqual(memory.light, []);
  assert.equal((await post('chat', body)).status, 400); assert.equal(calls.length, 1);
});

test('visitor AI greeting excludes account persona, private memory, personal status and profile notes', async t => {
  const calls = [];
  const { post } = await assistantFixture(t, async (_url, options) => { const payload = JSON.parse(options.body); if (isPublicCall(payload)) calls.push(payload); return { ok: true, json: async () => ({ choices: [{ message: { content: '小明，欢迎来玩。' } }] }) }; });
  await post('settings', { scope: 'persona', name: '私人助手名', prompt: '账户私人角色资料' });
  await post('settings', { scope: 'memory', memory: '账户私人记忆' });
  const descriptors = [0, .001, -.001].map(offset => Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10 + offset));
  const created = await (await post('presence', { action: 'person-save', person: { name: '小明', relationship: '朋友', notes: '人物私人备注', descriptors } })).json();
  const settings = await (await post('presence', { action: 'settings', enabled: true, cameraId: 'test', aiOpening: true, quietEnabled: false })).json();
  const claim = await (await post('presence', { action: 'claim', revision: settings.revision, personId: created.people[0].id })).json();
  assert.equal(claim.claimed, true);
  assert.equal((await post('chat', { opening: { revision: settings.revision, claimId: claim.claimId } })).status, 200);
  const payload = JSON.stringify(calls[0]); assert.match(payload, /小明/); assert.match(payload, /朋友/);
  assert.doesNotMatch(payload, /账户私人|人物私人|私人助手名|简短回答/);
});

test('balance queries require authentication, use the effective saved API and reveal no credential', async t => {
  const calls = [];
  const { host, revoke } = await assistantFixture(t, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ code: true, data: { object: 'token_usage', total_available: 2500, unlimited_quota: false } }) };
  });
  const url = `http://${host}/api/assistant/balance`;
  assert.equal((await fetch(url)).status, 401); assert.equal(calls.length, 0);
  const result = await (await fetch(url, { headers: { cookie: '__Host-freecamera=ok' } })).json();
  assert.equal(result.kind, 'quota'); assert.equal(result.available, 2500);
  assert.equal(calls[0].url, 'https://example.com/api/usage/token');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer first-secret');
  assert.equal(JSON.stringify(result).includes('first-secret'), false);
  revoke(); assert.equal((await fetch(url, { headers: { cookie: '__Host-freecamera=ok' } })).status, 401);
});

test('voice chat streams its first visible sentence before completion and records only completed turns', async t => {
  let finish,begin;const started=new Promise(resolve=>begin=resolve);
  const { post, host } = await assistantFixture(t, async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"欢迎回家。"}}]}\n\n'));
      finish = () => { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); };
      begin();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const response = await post('chat', { stream: true, messages: [{ role: 'user', content: '你好' }] });
    assert.match(response.headers.get('content-type'), /ndjson/);
    const reader = response.body.getReader();
    // Cold runtime startup is separate from forwarding a provider's first sentence.
    await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('runtime startup timeout')),15000))]);
    const first = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(Error('first sentence blocked by model completion')), 1000))]);
    assert.match(new TextDecoder().decode(first.value), /欢迎回家/);
    const getMemory = async () => (await fetch(`http://${host}/api/assistant/memory`, { headers: { cookie: '__Host-freecamera=ok' } })).json();
    assert.equal((await getMemory()).pendingTurns, 0);
    finish(); finish = null;
    let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    assert.match(rest, /"type":"done"/); assert.equal((await getMemory()).pendingTurns, 0); assert.equal((await getMemory()).light[0].category, 'activeTopic');
  } finally { finish?.(); }
});

test('an interrupted model stream sends a safe error and cannot enter successful memory', async t => {
  const { post, host } = await assistantFixture(t, async () => new Response('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const response = await post('chat', { stream: true, messages: [{ role: 'user', content: '你好' }] });
  const text = await response.text();
  assert.match(text, /"type":"error"/); assert.doesNotMatch(text, /"type":"done"/);
  const memory = await (await fetch(`http://${host}/api/assistant/memory`, { headers: { cookie: '__Host-freecamera=ok' } })).json();
  assert.equal(memory.pendingTurns, 0); assert.deepEqual(memory.core, []); assert.deepEqual(memory.light, []);
});

test('a token-limited Chat completion cannot send done or enter successful memory', async t => {
  const events = [
    { choices: [{ delta: { content: '只生成了一部分' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const { post, host } = await assistantFixture(t, async () => new Response(events, { headers: { 'content-type': 'text/event-stream' } }));
  const text = await (await post('chat', { stream: true, messages: [{ role: 'user', content: '你好' }] })).text();
  assert.match(text, /"type":"error"/); assert.doesNotMatch(text, /"type":"done"/);
  const memory = await (await fetch(`http://${host}/api/assistant/memory`, { headers: { cookie: '__Host-freecamera=ok' } })).json();
  assert.equal(memory.pendingTurns, 0); assert.deepEqual(memory.core, []); assert.deepEqual(memory.light, []);
});

test('disconnecting a streamed viewer cancels the upstream and leaves no successful turn', async t => {
  let signal;
  const { post, host } = await assistantFixture(t, async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第一句。"}}]}\n\n'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await post('chat', { stream: true, messages: [{ role: 'user', content: '你好' }] });
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  for (let i = 0; i < 100 && !signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true);
  const memory = await (await fetch(`http://${host}/api/assistant/memory`, { headers: { cookie: '__Host-freecamera=ok' } })).json();
  assert.equal(memory.pendingTurns, 0); assert.deepEqual(memory.core, []); assert.deepEqual(memory.light, []);
});

test('expired login during streaming blocks late output and successful memory', async t => {
  let emit;
  const { post, host, revoke } = await assistantFixture(t, async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开头。"}}]}\n\n'));
    emit = () => { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"不可发送的新内容"}}]}\n\ndata: [DONE]\n\n')); controller.close(); };
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  const response = await post('chat', { stream: true, messages: [{ role: 'user', content: '你好' }] });
  const reader = response.body.getReader(); await reader.read(); revoke(); emit();
  let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
  assert.match(rest, /登录已过期/); assert.doesNotMatch(rest, /不可发送|"type":"done"/);
  assert.equal((await fetch(`http://${host}/api/assistant/memory`, { headers: { cookie: '__Host-freecamera=ok' } })).status, 401);
});

test('chat bounds supplied history and ordinary preferences remain working memory only', async t => {
  const calls = [];
  const { post, host } = await assistantFixture(t, async (_url, options) => {
    const body = JSON.parse(options.body); if (isPublicCall(body)) calls.push(body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: isPublicCall(body) ? '收到' : '{"emotion":null,"related":false,"intensity":0,"quote":"","sourceRole":"user"}' } }] }) };
  });
  const history = Array.from({ length: 19 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '无关旧消息'+i }));
  for (let i = 0; i < 6; i++) {
    const response = await post('chat', { messages: [...history.slice(0, 18), { role: 'user', content: '我喜欢咖啡'+i }], turnId: 'fixture-turn-'+i });
    assert.equal(response.status, 200, await response.clone().text());
  }
  assert.ok(calls.every(c => c.messages.length <= 8),JSON.stringify(calls.map(c=>c.messages.map(m=>({role:m.role,content:m.role==='system'?'system':m.content.slice(0,80)})))));
  const readMemory = async () => (await fetch('http://'+host+'/api/assistant/memory', { headers: { cookie: '__Host-freecamera=ok' } })).json();
  let memory = await readMemory();
  assert.equal(memory.version, 2); assert.deepEqual(memory.core, []); assert.equal(memory.pendingTurns, 0);
  assert.equal(memory.light.length, 1); assert.equal(memory.light[0].content, '我喜欢咖啡5');
  await post('chat', { messages: [{ role: 'user', content: '继续吧' }] });
  assert.match(calls.at(-1).messages[0].content, /我喜欢咖啡5/); assert.doesNotMatch(JSON.stringify(calls.at(-1)), /我喜欢咖啡0/);
  const cleared = await post('memory', { action: 'clear' }); assert.equal(cleared.status, 200); assert.deepEqual((await cleared.json()).light, []);
  await post('settings', { scope: 'memory', memory: '', memoryMode: 'off' });
  await post('chat', { messages: [{ role: 'user', content: '本条不应保存' }] });
  memory = await readMemory(); assert.deepEqual(memory.light, []); assert.deepEqual(memory.core, []);
  assert.doesNotMatch(calls.at(-1).messages[0].content, /你现在记得的事/);
});

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
  const { post } = await assistantFixture(t, async (url, options) => { if (!options.body || isPublicCall(JSON.parse(options.body))) call = { url, options }; return { ok: true, json: async () => ({ data: [{ id: 'new-model' }, { id: 'new-model' }, null] }) }; });
  let response = await post('models', { provider: 'custom', baseUrl: 'https://draft.example/v1', apiKey: 'draft-secret' });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).models, ['new-model']);
  assert.equal(call.url, 'https://draft.example/v1/models'); assert.equal(call.options.headers.Authorization, 'Bearer draft-secret');
  response = await post('settings', { scope: 'memory', memory: '' });
  assert.equal((await response.json()).baseUrl, 'https://example.com/v1');
});

test('Responses protocol uses instructions and parses output messages', async t => {
  let call;
  const { post } = await assistantFixture(t, async (url, options) => { if (isPublicCall(JSON.parse(options.body))) call = { url, options }; return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '连接正常' }] }] }) }; });
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
    const payload = JSON.parse(options.body); if (isPublicCall(payload)) calls.push(payload);
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


test('conversation preferences persist and reach both model protocols without forcing every answer to one sentence', async t => {
  const calls = [];
  const { post, host } = await assistantFixture(t, async (_url, options) => { const payload = JSON.parse(options.body); if (isPublicCall(payload)) calls.push(payload); return { ok: true, json: async () => ({ choices: [{ message: { content: '第一句。第二句。顺着话题聊聊。' } }], output_text: '第一句。第二句。顺着话题聊聊。' }) }; });
  const saved = await (await post('settings', { scope: 'persona', name: '助手', prompt: '自然交流', responseStyle: 'talkative', followUpQuestions: true, proactiveChat: true, proactiveIdleSeconds: 30 })).json();
  assert.equal(saved.responseStyle, 'talkative'); assert.equal(saved.proactiveIdleSeconds, 30);
  const headers = { cookie: '__Host-freecamera=ok' };
  assert.equal((await (await fetch(`http://${host}/api/assistant/settings`, { headers })).json()).followUpQuestions, true);
  for (const protocol of ['chat', 'responses']) {
    assert.equal((await post('settings', { scope: 'model', protocol })).status, 200);
    assert.equal((await post('chat', { messages: [{ role: 'user', content: '聊聊今天' }] })).status, 200);
    const payload = calls.at(-1), instructions = payload.instructions || payload.messages[0].content;
    assert.match(instructions, /健谈/); assert.match(instructions, /最多一个/); assert.equal(payload.max_tokens || payload.max_output_tokens, 2048);
  }
  await post('settings', {scope:'persona',name:'助手',prompt:'自然交流',responseStyle:'concise',followUpQuestions:false});
  await post('chat',{messages:[{role:'user',content:'只说结论'}]});
  assert.match(calls.at(-1).instructions,/不主动追问/); assert.equal(calls.at(-1).max_output_tokens,1024);
  for (const patch of [{responseStyle:'unlimited'}, {followUpQuestions:'true'}, {proactiveChat:1}, {proactiveIdleSeconds:1}, {proactiveIdleSeconds:30.5}]) {
    assert.equal((await post('settings', { scope:'persona', name:'助手', prompt:'自然交流', ...patch })).status, 400);
  }
});

test('idle conversation is opt-in, respects shared quiet policy and budget, and never invents a user memory turn', async t => {
  const calls = [];
  const { post, host } = await assistantFixture(t, async (_url, options) => { const payload = JSON.parse(options.body); if (isPublicCall(payload)) calls.push(payload); return { ok:true, json:async()=>({ choices:[{message:{content:'刚才聊到散步。我也想到一个有趣的角度，你平时喜欢走哪条路？'}}] }) }; });
  const messages = [{role:'user',content:'我喜欢散步'}, {role:'assistant',content:'可以沿河走走。'}];
  let result = await (await post('chat', { proactive:true, messages })).json();
  assert.equal(result.skipped, true); assert.equal(calls.length, 0);
  await post('settings', {scope:'persona',name:'助手',prompt:'自然交流',proactiveChat:true});
  await post('presence', {action:'settings',quietEnabled:false,dailyLimit:1});
  await post('presence', {action:'snooze',minutes:30});
  result = await (await post('chat', {proactive:true,messages})).json(); assert.equal(result.skipped,true); assert.equal(calls.length,0);
  await post('presence', {action:'snooze',minutes:0});
  result = await (await post('chat', {proactive:true,messages})).json(); assert.equal(result.skipped,true); assert.equal(calls.length,0,'legacy direct request cannot bypass random schedule');
  result = await (await post('chat', {proactive:true,messages})).json(); assert.equal(result.skipped,true); assert.equal(calls.length,0);
  const memory = await (await fetch(`http://${host}/api/assistant/memory`,{headers:{cookie:'__Host-freecamera=ok'}})).json(); assert.equal(memory.pendingTurns,0); assert.deepEqual(memory.core,[]); assert.deepEqual(memory.light,[]);
});

test('unsupported tool replies never become successful conversation memory in JSON or streaming chat', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'assistant-tools-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const leaked = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_search">private-tool-query</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const request = async (url, options) => JSON.parse(options.body).stream
    ? new Response([...leaked].map(content => `data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`).join('') + 'data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}})
    : Response.json({choices:[{message:{content:leaked}}]});
  const routes = await createAssistantRoutes({ accounts:{session:token=>token==='ok'?{user:{username:'tool-test',role:'admin'}}:null}, dataDir:dir, request });
  const server = http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const host='127.0.0.1:'+server.address().port;
  const post=(route,body)=>fetch(`http://${host}/api/assistant/${route}`,{method:'POST',headers:{cookie:'__Host-freecamera=ok',origin:`https://${host}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('settings',{scope:'model',provider:'dashscope',model:'test-model',apiKey:'fixture-key'})).status,200);
  for (const stream of [false,true]) {
    const result=await post('chat',{messages:[{role:'user',content:'测试工具异常'}],stream});
    const body=await result.text(); assert.match(body,/工具.*未接入/); assert.doesNotMatch(body,/DSML|private-tool-query/);
    if(stream) assert.doesNotMatch(body,/"type":"done"/); else assert.equal(result.status,502);
  }
  const memory=await (await fetch(`http://${host}/api/assistant/memory`,{headers:{cookie:'__Host-freecamera=ok'}})).json();
  assert.equal(memory.pendingTurns,0); assert.equal(memory.summary,'');
});
