import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import * as streaming from '../server/model-stream.js';

const event = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = events => new Response(events.map(event).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const chatCall = (name = 'current_time', args = '{}', id = 'call_1') => ({ id, type: 'function', function: { name, arguments: args } });

test('native Chat tool arguments are assembled without entering speech deltas', async () => {
  assert.equal(typeof streaming.readModelRound, 'function');
  const visible = [];
  const result = await streaming.readModelRound(sse([
    { choices: [{ delta: { reasoning_content: 'private', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'current_time', arguments: '{"time' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: 'Zone":"Asia/Shanghai"}' } }] }, finish_reason: 'tool_calls' }] },
  ]), 'chat', { allowTools: true, onDelta: text => visible.push(text) });
  assert.equal(result.calls[0].arguments, '{"timeZone":"Asia/Shanghai"}');
  assert.equal(result.assistant.reasoning_content, 'private');
  assert.deepEqual(visible, []);
});

test('native Responses arguments and reasoning items continue only after completed', async () => {
  assert.equal(typeof streaming.readModelRound, 'function');
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'current_time', arguments: '{}' };
  const result = await streaming.readModelRound(sse([
    { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '}' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }, item] } },
  ]), 'responses', { allowTools: true });
  assert.equal(result.calls[0].name, 'current_time');
  assert.equal(result.output[0].type, 'reasoning');
});

test('truncated native calls and DSML never execute', async () => {
  assert.equal(typeof streaming.readModelRound, 'function');
  await assert.rejects(streaming.readModelRound(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...chatCall() }] } }] }]), 'chat', { allowTools: true }), /不完整/);
  await assert.rejects(streaming.readModelRound(Response.json({ choices: [{ message: { content: '<｜｜DSML｜｜invoke name="current_time">{}' } }] }), 'chat', { allowTools: true }), /工具.*未接入/);
});

test('readonly registry resolves saved city, returns ambiguity and redacts account data', async t => {
  const registryModule = await import('../server/conversation-tools.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'atb-tools-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'platform')); await writeFile(path.join(dir, 'platform', 'desktop-companion.json'), JSON.stringify({ city: { name: '上海', latitude: 31, longitude: 121 } }));
  let weatherReads = 0;
  const feed = { cities: async () => [{ name: '朝阳', region: '辽宁', latitude: 1, longitude: 2 }, { name: '朝阳', region: '北京', latitude: 3, longitude: 4 }], weather: async city => { weatherReads++; return { temperature: 21, source: 'fixture', sourceUrl: 'https://example.org/', ...city }; }, news: async () => [{ title: '真实标题', source: 'fixture', publishedAt: '2026-11-14T00:00:00Z', url: 'https://example.org/news' }] };
  const registry = registryModule.createConversationTools({ dataDir: dir, feed, readBalance: async () => ({ kind: 'balance', amounts: [{ currency: 'CNY', amount: '9.00' }], apiKey: 'never-send', baseUrl: 'private-host' }), getSettings: () => ({}) });
  assert.equal((await registry.execute({ name: 'weather', arguments: '{}' })).data.city.name, '上海');
  assert.equal((await registry.execute({ name: 'weather', arguments: '{"city":"朝阳"}' })).error, 'ambiguous-city');
  assert.equal(weatherReads, 1);
  assert.equal((await registry.execute({ name: 'weather', arguments: '{"city":"朝阳","region":"辽宁"}' })).data.city.region, '辽宁');
  assert.equal((await registry.execute({ name: 'weather', arguments: '{"url":"file:///secret"}' })).error, 'invalid-arguments');
  assert.equal((await registry.execute({ name: 'web_search', arguments: '{}' })).error, 'unsupported-tool');
  assert.equal((await registry.execute({ name: 'current_time', arguments: '{"timeZone":"bad/zone"}' })).error, 'invalid-time-zone');
  const balance = await registry.execute({ name: 'api_balance', arguments: '{}' });
  assert.doesNotMatch(JSON.stringify(balance), /never-send|private-host|apiKey|baseUrl/);
  assert.equal(balance.data.amounts[0].currency, 'CNY');
  assert.equal((await registry.execute({ name: 'news', arguments: '{}' })).data.items[0].title, '真实标题');
});
test('unsupported or unconfigured balance is not reported as a successful lookup',async()=>{
  const {createConversationTools}=await import('../server/conversation-tools.js');
  for(const kind of ['unsupported','unconfigured','unavailable']){
    const registry=createConversationTools({dataDir:'unused',feed:{},getSettings:()=>({}),readBalance:async()=>({kind})});
    const result=await registry.execute({name:'api_balance',arguments:'{}'});assert.equal(result.ok,false,kind);
  }
});

for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) {
  test(`${protocol} ${stream ? 'SSE' : 'JSON'} native loop executes once and preserves protocol continuation`, async () => {
    const { runConversation } = await import('../server/conversation-tools.js');
    let calls = 0, executions = 0; const deltas = [];
    const request = async (_url, options) => {
      const payload = JSON.parse(options.body); calls++;
      if (calls === 1) {
        assert.equal(payload.tools.length, 1);
        if (protocol === 'chat') return stream ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...chatCall() }] }, finish_reason: 'tool_calls' }] }]) : Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [chatCall()] } }] });
        const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'current_time', arguments: '{}' };
        return stream ? sse([{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { status: 'completed', output: [item] } }]) : Response.json({ status: 'completed', output: [item] });
      }
      assert.match(JSON.stringify(protocol === 'chat' ? payload.messages : payload.input), /fixture-time/);
      if (protocol === 'chat') assert.equal(payload.messages.at(-1).tool_call_id, 'call_1');
      else assert.equal(payload.input.at(-1).call_id, 'call_1');
      if (!stream) return Response.json(protocol === 'chat' ? { choices: [{ message: { content: '现在是八点。' } }] } : { output_text: '现在是八点。' });
      return protocol === 'chat' ? sse([{ choices: [{ delta: { content: '现在是八点。' }, finish_reason: 'stop' }] }]) : sse([{ type: 'response.output_text.delta', delta: '现在是八点。' }, { type: 'response.completed', response: { status: 'completed' } }]);
    };
    const registry = { definitions: [{ name: 'current_time', description: 'time', parameters: { type: 'object', properties: {} } }], execute: async () => { executions++; return { ok: true, data: 'fixture-time' }; } };
    const result = await runConversation({ request, url: 'https://example.org/v1', options: { body: JSON.stringify(protocol === 'chat' ? { messages: [{ role: 'user', content: '几点' }], stream } : { input: [{ role: 'user', content: '几点' }], stream }) }, protocol, registry, onDelta: text => deltas.push(text) });
    assert.equal(result.answer, '现在是八点。'); assert.equal(calls, 2); assert.equal(executions, 1); assert.equal(deltas.join(''), '现在是八点。');
    assert.equal(result.toolsUsed[0].name, 'current_time');
  });
}

test('aborting a stalled tool returns immediately and cannot continue generation', async () => {
  const { runConversation } = await import('../server/conversation-tools.js');
  const controller = new AbortController(); let started, release, requests = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const job = runConversation({ request: async () => { requests++; return Response.json({ choices: [{ message: { tool_calls: [chatCall()] }, finish_reason: 'tool_calls' }] }); }, url: 'https://example.org', options: { body: '{"messages":[{"role":"user","content":"测试"}]}' }, protocol: 'chat', signal: controller.signal,
    registry: { definitions: [{name:'current_time',description:'time',parameters:{type:'object',properties:{}}}], execute: async () => { started(); await held; return { ok: true }; } } });
  await entered; controller.abort();
  const outcome = await Promise.race([job.then(() => 'success', () => 'aborted'), new Promise(resolve => setTimeout(() => resolve('stalled'), 6000))]);
  release(); await job.catch(() => {});
  assert.equal(outcome, 'aborted'); assert.equal(requests, 1);
});

for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) {
  test(`real HTTP handler ${protocol} ${stream ? 'SSE' : 'JSON'} uses tools and reports sources without private arguments`, async t => {
    const { createAssistantRoutes } = await import('../server/assistant-routes.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'atb-tool-http-')); t.after(() => rm(dir, { recursive: true, force: true }));
    let publicCalls = 0;
    const request = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const isPublic = payload.tools?.some(tool => (tool.name || tool.function?.name) === 'news');
      if (!isPublic) return Response.json({ choices: [{ message: { content: '{}' } }] });
      publicCalls++;
      if (publicCalls === 1) {
        if (protocol === 'chat') return stream ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...chatCall('news') }] }, finish_reason: 'tool_calls' }] }]) : Response.json({ choices: [{ message: { tool_calls: [chatCall('news')] }, finish_reason: 'tool_calls' }] });
        const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'news', arguments: '{}' };
        return stream ? sse([{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { status: 'completed', output: [item] } }]) : Response.json({ status: 'completed', output: [item] });
      }
      assert.match(JSON.stringify(payload), /真正新闻/);
      if (!stream) return Response.json(protocol === 'chat' ? { choices: [{ message: { content: '新闻已查到。' } }] } : { output_text: '新闻已查到。' });
      return protocol === 'chat' ? sse([{ choices: [{ delta: { content: '新闻已查到。' }, finish_reason: 'stop' }] }]) : sse([{ type: 'response.output_text.delta', delta: '新闻已查到。' }, { type: 'response.completed', response: { status: 'completed' } }]);
    };
    const routes = await createAssistantRoutes({ accounts: { session: token => token === 'ok' ? { user: { username: 'fixture' } } : null }, dataDir: dir, request, companionFeed: { news: async () => [{ title: '真正新闻', url: 'https://www.chinanews.com.cn/news', publishedAt: '2026-11-14T00:00:00Z', source: '中国新闻网' }] } });
    const server = http.createServer((req,res) => routes(req,res,new URL(req.url,'http://localhost').pathname));
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(async () => { await routes.close(); await new Promise(resolve => server.close(resolve)); });
    const host = `127.0.0.1:${server.address().port}`, base = `http://${host}`;
    const headers = { cookie: '__Host-freecamera=ok', origin: `https://${host}`, 'content-type': 'application/json' };
    const post = (route, body) => fetch(base + '/api/assistant/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    await post('settings', { name: '助手', prompt: '', memory: '', memoryMode: 'off', provider: 'custom', baseUrl: 'https://example.org/v1', protocol, model: 'fixture-model', apiKey: 'fake-secret' });
    const catalog = await fetch(base + '/api/assistant/tools', { headers });
    assert.equal(catalog.status,200); const listed=await catalog.json(); assert.ok(listed.tools.some(tool=>tool.name==='web_search')); assert.equal(listed.engine,'DeepSeek Harness');
    const response = await post('chat', { messages: [{ role: 'user', content: '新闻呢' }], stream });
    assert.equal(response.status,200,await response.clone().text());
    const raw = await response.text();
    assert.match(raw,/新闻已查到/); assert.match(raw,/toolsUsed/); assert.doesNotMatch(raw,/fake-secret|reasoning|arguments/);
    const result = stream ? JSON.parse(raw.trim().split('\n').at(-1)) : JSON.parse(raw);
    assert.equal(result.toolsUsed[0].name,'news'); assert.equal(result.toolsUsed[0].sources[0].source,'中国新闻网'); assert.equal(publicCalls,2);
  });
}

test('invalid and repeated IDs, oversized arguments and native truncation never execute a tool', async () => {
  const { runConversation } = await import('../server/conversation-tools.js');
  for (const value of [
    { choices: [{ message: { tool_calls: [chatCall('current_time', '{}', 'bad id')] }, finish_reason: 'tool_calls' }] },
    { choices: [{ message: { tool_calls: [chatCall(), chatCall()] }, finish_reason: 'tool_calls' }] },
    { choices: [{ message: { tool_calls: [chatCall('current_time', 'x'.repeat(4097))] }, finish_reason: 'tool_calls' }] },
    { choices: [{ message: { tool_calls: [chatCall()] }, finish_reason: 'length' }] },
  ]) {
    let executions = 0;
    await assert.rejects(runConversation({ request: async () => Response.json(value), url: 'https://example.org', options: { body: '{"messages":[{"role":"user","content":"测试"}]}' }, protocol: 'chat', registry: { definitions: [{name:'current_time',description:'time',parameters:{type:'object',properties:{}}}], execute: async () => { executions++; return { ok: true }; } } }));
    assert.equal(executions, 0);
  }
});

test('tool loops allow six calls then finish without tools and reject repeated IDs across rounds', async () => {
  const { runConversation } = await import('../server/conversation-tools.js');
  for (const mode of ['rounds', 'calls', 'repeated']) {
    let requests = 0, executions = 0;
    const request = async (_url, options) => {
      const payload = JSON.parse(options.body); requests++;
      if (mode === 'calls' && requests === 4 || mode === 'rounds' && requests === 7) {
        assert.equal(payload.tools, undefined);
        return Response.json({ choices: [{ message: { content: '完成' } }] });
      }
      const calls = Array.from({ length: mode === 'calls' ? 2 : 1 }, (_, i) => chatCall('current_time', '{}', mode === 'repeated' ? 'duplicate' : `call_${requests}_${i}`));
      return Response.json({ choices: [{ message: { tool_calls: calls }, finish_reason: 'tool_calls' }] });
    };
    const job = runConversation({ request, url: 'https://example.org', options: { body: '{"messages":[{"role":"user","content":"测试"}]}' }, protocol: 'chat', registry: { definitions: [{name:'current_time',description:'time',parameters:{type:'object',properties:{}}}], execute: async () => { executions++; return { ok: true }; } } });
    if (mode === 'repeated') { await assert.rejects(job,/重复/); assert.equal(executions,1); }
    else { assert.equal((await job).answer,'完成'); assert.equal(executions,6); }
  }
});

test('DSML in Responses native call output is rejected before execution', async () => {
  const { runConversation } = await import('../server/conversation-tools.js'); let executed = false;
  await assert.rejects(runConversation({ request: async () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '<|DSML|invoke name="weather">city' }] }, { type: 'function_call', call_id: 'call_1', name: 'current_time', arguments: '{}' }] }), protocol: 'responses', url: 'https://example.org', options: { body: '{"input":[{"role":"user","content":"测试"}]}' }, registry: { definitions: [{name:'current_time',description:'time',parameters:{type:'object',properties:{}}}], execute: async () => { executed = true; return { ok: true }; } } }), /工具.*未接入/);
  assert.equal(executed,false);
});

test('real HTTP logout during a feed read blocks late results and any model continuation', async t => {
  const { createAssistantRoutes } = await import('../server/assistant-routes.js');
  const dir = await mkdtemp(path.join(tmpdir(),'atb-tool-revoke-')); t.after(() => rm(dir,{recursive:true,force:true}));
  let authorized = true, entered, release, requests = 0;
  const started = new Promise(resolve => { entered=resolve; }), held = new Promise(resolve => { release=resolve; });
  const routes = await createAssistantRoutes({ dataDir:dir, accounts:{session:token => authorized && token==='ok' ? {user:{username:'fixture'}} : null}, companionFeed:{news:async()=>{entered();await held;return [{title:'late result'}];}}, request:async()=>{requests++;return Response.json({choices:[{message:{tool_calls:[chatCall('news')]},finish_reason:'tool_calls'}]});} });
  const server = http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(async()=>{await routes.close();await new Promise(resolve=>server.close(resolve));});
  const host=`127.0.0.1:${server.address().port}`, base=`http://${host}`, headers={cookie:'__Host-freecamera=ok',origin:`https://${host}`,'content-type':'application/json'};
  const post=(route,body)=>fetch(base+'/api/assistant/'+route,{method:'POST',headers,body:JSON.stringify(body)});
  await post('settings',{name:'助手',prompt:'',memory:'',memoryMode:'off',provider:'custom',baseUrl:'https://example.org/v1',model:'fixture',apiKey:'fixture-only'});
  const pending=post('chat',{messages:[{role:'user',content:'新闻'}]});await started;authorized=false;release();
  const response=await pending;assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/late result|toolsUsed/);assert.equal(requests,1);
  assert.equal((await fetch(base+'/api/assistant/tools',{headers})).status,401);
});
