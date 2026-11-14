import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAgent, MEMORY_TOOLS } from '../server/memory-agent.js';

const settings = { baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', model: 'fixture', protocol: 'chat', memoryMode: 'summary' };
const dispute = { id: 'turn-1', user: '你刚才泄露了我的隐私，我真的非常生气。', assistant: '对不起，我会尊重你的隐私边界。' };
const event = { emotion: '争吵', related: true, intensity: 5, quote: dispute.user, sourceRole: 'user' };
const chat = (content = '', calls = []) => ({ choices: [{ message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map((call, i) => ({ id: `call-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } })) } : {}) } }] });
const response = data => ({ ok: true, json: async () => data });
function fixture(sequence = [], overrides = {}) {
  const calls = [], requests = []; let index = 0;
  const memory = {
    async tool(owner, name, args, context) { calls.push({ owner, name, args, context }); return name === 'diary_search' ? [] : { ok: true }; },
    async factualRecall() { return []; },
    ...overrides.memory,
  };
  const current = { ...settings, ...overrides.settings };
  const agent = createMemoryAgent({ memory, getSettings: () => current, request: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const next = sequence[index++]; return typeof next === 'function' ? next({ url, options }) : response(next ?? chat());
  }, ...overrides.agent });
  return { agent, memory, calls, requests, current };
}

test('native memory toolbox publishes only the nine exact signatures', () => {
  assert.deepEqual(MEMORY_TOOLS.map(t => t.name), ['memory_core_append', 'memory_core_read', 'memory_core_remove', 'write_diary', 'diary_read', 'diary_search', 'qq_memory_append', 'qq_memory_query', 'qq_memory_clear']);
  for (const tool of MEMORY_TOOLS) assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(MEMORY_TOOLS.find(t => t.name === 'memory_core_append').parameters.properties.content.maxLength, 30);
});

test('routine, malformed classifier and prose tool syntax never execute writes', async () => {
  for (const content of [JSON.stringify({ ...event, emotion: null, related: false, intensity: 0 }), '普通回答', '<tool_call>write_diary</tool_call>', '<｜DSML｜function_calls>write_diary']) {
    const f = fixture([chat(content)]);
    await f.agent.learn('alice', { turn: { ...dispute, user: '今天天气不错' } });
    assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 1);
    await f.agent.close();
  }
});

test('classification requires exact evidence, role, emotion, relationship and strong intensity', async () => {
  for (const change of [{ quote: '从未说过的事实' }, { sourceRole: 'system' }, { emotion: '愤怒' }, { related: false }, { intensity: 3 }, { intensity: '5' }, { quote: '' }]) {
    const f = fixture([chat(JSON.stringify({ ...event, ...change })), chat('', [{ name: 'write_diary', args: { content: '●触点', mood: '难过' } }])]);
    await f.agent.learn('alice', { turn: dispute }); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 1);
  }
});

test('strong genuine event permits native chat tools with verified event context', async () => {
  const f = fixture([chat(JSON.stringify(event)), chat('', [
    { name: 'memory_core_append', args: { content: '隐私边界引发争吵', emotion: '争吵' } },
    { name: 'write_diary', args: { content: `●【触点】${dispute.user}\n●【我的回】${dispute.assistant}`, mood: '认真反省' } },
  ]), chat('私密推理不应返回')]);
  assert.equal(await f.agent.learn('alice', { turn: dispute }), undefined);
  assert.deepEqual(f.calls.map(c => c.name), ['memory_core_append', 'write_diary']);
  assert.deepEqual(f.calls[0].context.event, event);
  assert.equal(typeof f.calls[0].context.checkSession, 'function');
  const request = f.requests[1].body;
  assert.equal(request.stream, false); assert.equal(request.tools[0].type, 'function');
  assert.equal(request.tools[0].function.name, 'memory_core_append');
  assert.equal(f.requests[2].body.messages.filter(m => m.role === 'tool').length, 2);
});

test('Responses native tools preserve call IDs and outputs', async () => {
  const f = fixture([
    { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(event) }] }] },
    { output: [{ type: 'function_call', id: 'fc-1', call_id: 'response-call', name: 'memory_core_append', arguments: JSON.stringify({ content: '认真维护隐私', emotion: '争吵' }) }] },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'DONE' }] }] },
  ], { settings: { protocol: 'responses' } });
  await f.agent.learn('alice', { turn: dispute });
  assert.equal(f.calls.length, 1); assert.match(f.requests[1].url, /\/responses$/);
  assert.equal(f.requests[1].body.tools[0].name, 'memory_core_append');
  assert.ok(f.requests[1].body.tools.every(tool => tool.strict === false));
  assert.ok(f.requests[2].body.input.some(m => m.type === 'function_call_output' && m.call_id === 'response-call'));
});

test('tool schemas reject unknown names, malformed arguments, extra fields and event mismatch', async () => {
  const f = fixture([chat(JSON.stringify(event)), chat('', [
    { name: 'web_search', args: { query: 'secret' } },
    { name: 'memory_core_append', args: { content: 'x', emotion: '开心' } },
    { name: 'memory_core_append', args: { content: 'x'.repeat(31), emotion: '争吵' } },
    { name: 'write_diary', args: { content: '●不包含原文触点', mood: '难过' } },
    { name: 'qq_memory_clear', args: { category: 'activeTopic', owner: 'bob' } },
  ]), chat()]);
  await f.agent.learn('alice', { turn: dispute }); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body.messages.filter(m => m.role === 'tool')), /secret/);
});

test('recall forces actual search then returns only separately stored factual source quotes', async () => {
  const privateText = 'PRIVATE_REFLECTION_CANARY';
  const f = fixture([chat('', [{ name: 'diary_search', args: { query: '上次争吵', limit: 5 } }]), chat('', [{ name: 'diary_read', args: { date: '2026-11-12' } }]), chat(privateText)], { memory: {
    async tool(owner, name, args, context) { f.calls.push({ owner, name, args, context }); return name === 'diary_search' ? [{ date: '2026-11-12', 片段: privateText }] : privateText; },
    async factualRecall(owner, dates) { assert.equal(owner, 'alice'); assert.deepEqual(dates, ['2026-11-12']); return [{ date: '2026-11-12', quote: '你刚才泄露了我的隐私', sourceRole: 'user' }]; },
  } });
  const result = await f.agent.recall('alice', { messages: [{ role: 'user', content: '你记得上次争吵吗？' }] });
  assert.match(result, /你刚才泄露了我的隐私/); assert.doesNotMatch(result, /PRIVATE_REFLECTION/);
  assert.equal(f.requests[0].body.tool_choice.function.name, 'diary_search');
  assert.ok(f.calls.every(c => c.context.allowWrite === false));
});

test('recall makes no model request for ordinary chat and no-match never invents remembered events', async () => {
  const f = fixture([chat('我记得你曾经难过')]);
  assert.equal(await f.agent.recall('alice', { messages: [{ role: 'user', content: '你好' }] }), '');
  const result = await f.agent.recall('alice', { messages: [{ role: 'user', content: '你还记得我们三天前说了什么吗？' }] });
  assert.deepEqual(f.calls.map(c => c.name), ['diary_search']);
  assert.match(result, /没有找到|未找到/); assert.doesNotMatch(result, /我记得你曾经/);
});

test('recall cannot execute writes or return facts for unsearched dates', async () => {
  const f = fixture([chat('', [{ name: 'diary_search', args: { query: '之前' } }]), chat('', [
    { name: 'write_diary', args: { content: `●\n触点：${dispute.user}`, mood: '认真' } },
    { name: 'diary_read', args: { date: '2025-01-01' } },
  ]), chat()], { memory: {
    async tool(owner, name, args, context) { f.calls.push({ owner, name, args, context }); return [{ date: '2026-11-12', 片段: '私密' }]; },
    async factualRecall() { return [{ date: '2025-01-01', quote: '未经搜索授权', sourceRole: 'user' }]; },
  } });
  const result = await f.agent.recall('alice', { messages: [{ role: 'user', content: '回忆之前的事' }] });
  assert.deepEqual(f.calls.map(c => c.name), ['diary_search']); assert.doesNotMatch(result, /未经搜索授权/);
});

test('budget caps model rounds and total tool calls', async () => {
  const many = Array.from({ length: 20 }, () => ({ name: 'memory_core_read', args: {} }));
  const f = fixture([chat(JSON.stringify(event)), chat('', many), chat('', many), chat('', many), chat('', many)]);
  await f.agent.learn('alice', { turn: dispute });
  assert.ok(f.requests.length <= 4); assert.ok(f.calls.length <= 12);
});

for (const mode of ['off', 'logout', 'abort', 'cancelAll', 'close', 'settings']) test(`${mode} cancels delayed provider writes`, async () => {
  let resolve, started; const entered = new Promise(r => { started = r; }); let valid = true;
  const controller = new AbortController();
  const f = fixture([chat(JSON.stringify(event)), () => { started(); return new Promise(r => { resolve = r; }); }]);
  const pending = f.agent.learn('alice', { turn: dispute, signal: controller.signal, checkSession: () => valid });
  await entered;
  if (mode === 'off') f.current.memoryMode = 'off';
  if (mode === 'logout') valid = false;
  if (mode === 'abort') controller.abort();
  if (mode === 'cancelAll') f.agent.cancelAll();
  if (mode === 'close') await f.agent.close();
  if (mode === 'settings') f.current.model = 'changed';
  resolve(response(chat('', [{ name: 'memory_core_append', args: { content: '迟到写入', emotion: '争吵' } }])));
  await pending; assert.equal(f.calls.length, 0);
});

test('provider and storage error text stays private and public recall fails safely', async () => {
  const f = fixture([() => { throw Error('PRIVATE_PROVIDER_SECRET'); }], { memory: { async tool() { throw Error('PRIVATE_DIARY_SECRET'); } } });
  const result = await f.agent.recall('alice', { messages: [{ role: 'user', content: '记得以前的事吗' }] });
  assert.match(result, /没有找到|未找到/); assert.doesNotMatch(result, /PRIVATE/);
});

test('recall reserves one real search within the twelve-call limit for broken providers', async () => {
  const invalid = Array.from({ length: 20 }, () => ({ name: 'web_search', args: {} }));
  const f = fixture([chat('', invalid), chat('', invalid), chat('', invalid), chat('', invalid)]);
  await f.agent.recall('alice', { messages: [{ role: 'user', content: '你记得上次聊什么吗？' }] });
  assert.equal(f.calls.filter(c => c.name === 'diary_search').length, 1);
  assert.ok(f.calls.length <= 12); assert.ok(f.requests.length <= 4);
});

test('failed searches are not retried beyond the total native call budget', async () => {
  let attempts = 0;
  const search = Array.from({ length: 20 }, () => ({ name: 'diary_search', args: { query: '以前' } }));
  const f = fixture([chat('', search), chat('', search), chat('', search)], { memory: { async tool() { attempts++; throw Error('private'); } } });
  const result = await f.agent.recall('alice', { messages: [{ role: 'user', content: '还记得以前吗' }] });
  assert.ok(attempts <= 12); assert.match(result, /没有找到/);
});

test('source quote caps use Unicode codepoints and actual assistant reply evidence', async () => {
  const turn = { ...dispute, assistant: '这件事让我很感动，谢谢你一直信任我。' };
  const ownEvent = { ...event, emotion: '感动', quote: turn.assistant, sourceRole: 'assistant' };
  const f = fixture([chat(JSON.stringify(ownEvent)), chat('', [{ name: 'memory_core_append', args: { content: '😀'.repeat(30), emotion: '感动' } }]), chat()]);
  await f.agent.learn('alice', { turn }); assert.equal(f.calls.length, 1);
});

test('logout while a store tool is awaiting prevents its delayed mutation', async () => {
  let valid = true, resume, entered; const started = new Promise(r => { entered = r; }); let writes = 0;
  const f = fixture([chat(JSON.stringify(event)), chat('', [{ name: 'memory_core_append', args: { content: '隐私界限', emotion: '争吵' } }])], { memory: {
    async tool(owner, name, args, context) { entered(); await new Promise(r => { resume = r; }); context.checkSession(); writes++; return { ok: true }; },
  } });
  const pending = f.agent.learn('alice', { turn: dispute, checkSession: () => valid });
  await started; valid = false; resume(); await pending; assert.equal(writes, 0);
});

test('same-owner replacement cancels old learning while another owner stays independent', async () => {
  let resolveOld, started; const entered = new Promise(r => { started = r; });
  const f = fixture([() => { started(); return new Promise(r => { resolveOld = r; }); }, chat(JSON.stringify(event)), chat(), chat(JSON.stringify(event)), chat()]);
  const first = f.agent.learn('alice', { turn: dispute }); await entered;
  await f.agent.learn('alice', { turn: { ...dispute, id: 'new' } });
  await f.agent.learn('bob', { turn: dispute });
  resolveOld(response(chat(JSON.stringify(event)))); await first;
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 5);
});

test('recall session invalidation returns no context after a late result', async () => {
  let valid = true, resolve, started; const entered = new Promise(r => { started = r; });
  const f = fixture([() => { started(); return new Promise(r => { resolve = r; }); }]);
  const pending = f.agent.recall('alice', { messages: [{ role: 'user', content: '记得我吗' }], checkSession: () => valid });
  await entered; valid = false; resolve(response(chat('raw private')));
  assert.equal(await pending, ''); assert.equal(f.calls.length, 0);
});

test('real private store learns a verified dispute and recall never exposes reflections', async t => {
  const { LayeredMemory } = await import('../server/layered-memory.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'atb-agent-real-store-'));
  const store = new LayeredMemory({ dataDir: dir, now: () => new Date('2026-11-12T12:00:00Z').getTime() });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const privateText = 'PRIVATE_REAL_STORE_REFLECTION';
  const f = fixture([chat(JSON.stringify(event)), chat('', [
    { name: 'memory_core_append', args: { content: '因隐私边界认真争吵', emotion: '争吵' } },
    { name: 'write_diary', args: { content: `●【触点】${dispute.user}\n●【我的想】${privateText}\n●【我的回】${dispute.assistant}`, mood: '认真' } },
  ]), chat(), chat('', [{ name: 'diary_search', args: { query: '隐私' } }]), chat('', [{ name: 'diary_read', args: { date: '2026-11-12' } }]), chat(privateText)], { memory: {
    tool: store.tool.bind(store), factualRecall: store.factualRecall.bind(store),
  } });
  await f.agent.learn('alice', { turn: dispute });
  const state = await store.status('alice');
  assert.equal(state.core.length, 1); assert.equal(state.core[0].emotion, '争吵');
  const result = await f.agent.recall('alice', { messages: [{ role: 'user', content: '记得前天因为隐私发生什么吗？' }] });
  assert.match(result, /你刚才泄露了我的隐私/);
  assert.doesNotMatch(result, /PRIVATE_REAL_STORE_REFLECTION/);
  assert.doesNotMatch(await store.context('alice'), /PRIVATE_REAL_STORE_REFLECTION/);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_REAL_STORE_REFLECTION/);
  await f.agent.close();
});

test('learning cannot read private diaries then project them into public memory', async () => {
  const secret = 'PRIVATE_READ_TO_WORKING_CANARY'; let storeCalls = 0;
  const f = fixture([chat(JSON.stringify(event)), chat('', [
    { name: 'diary_read', args: { date: '2026-11-12' } },
    { name: 'diary_search', args: { query: '隐私' } },
    { name: 'qq_memory_append', args: { category: 'pendingThought', content: secret } },
    { name: 'memory_core_append', args: { content: secret, emotion: '争吵' } },
  ]), chat()], { memory: { async tool() { storeCalls++; throw Error('private diary read must never happen'); } } });
  await f.agent.learn('alice', { turn: dispute });
  assert.ok(f.requests[1].body.tools.every(t => !['diary_read', 'diary_search'].includes(t.function.name)));
  assert.equal(storeCalls, 0);
});

test('a private diary draft cannot subsequently become public core or working content', async () => {
  const secret = 'PRIVATE_DRAFT_CANARY';
  const f = fixture([chat(JSON.stringify(event)), chat('', [
    { name: 'write_diary', args: { content: `●【触点】${dispute.user}\n●【我的想】${secret}`, mood: '认真' } },
    { name: 'memory_core_append', args: { content: secret, emotion: '争吵' } },
    { name: 'qq_memory_append', args: { category: 'pendingThought', content: secret } },
  ]), chat()]);
  await f.agent.learn('alice', { turn: dispute });
  assert.deepEqual(f.calls.map(c => c.name), ['write_diary']);
  assert.ok(f.requests.at(-1).body.tools.every(t => !['memory_core_append', 'memory_core_remove', 'qq_memory_append', 'qq_memory_clear'].includes(t.function.name)));
});

test('private Responses requests explicitly disable provider response storage', async () => {
  const f = fixture([{ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(event) }] }] }, { output: [] }], { settings: { protocol: 'responses' } });
  await f.agent.learn('alice', { turn: dispute });
  assert.ok(f.requests.length > 1); assert.ok(f.requests.every(r => r.body.store === false));
});

test('stateless Responses replays bounded original reasoning and call items in order', async () => {
  const reasoning = { id: 'rs-1', type: 'reasoning', summary: [], encrypted_content: 'PRIVATE_ENCRYPTED_REASONING' };
  const call = { id: 'fc-1', type: 'function_call', status: 'completed', call_id: 'response-call', name: 'memory_core_append', arguments: JSON.stringify({ content: '隐私边界', emotion: '争吵' }) };
  const f = fixture([
    { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(event) }] }] },
    { output: [reasoning, call] }, { output: [] },
  ], { settings: { protocol: 'responses' } });
  await f.agent.learn('alice', { turn: dispute });
  const input = f.requests[2].body.input;
  assert.deepEqual(input[2], reasoning); assert.deepEqual(input[3], call);
  assert.equal(input[4].type, 'function_call_output');
  assert.deepEqual(f.requests[1].body.include, ['reasoning.encrypted_content']);
});

test('in-flight private jobs are bounded and cancellation releases unresponsive requests', async () => {
  let calls = 0;
  const f = fixture([], { agent: { request: async () => { calls++; return new Promise(() => {}); } } });
  const pending = Array.from({ length: 40 }, (_, i) => f.agent.learn(`owner-${i}`, { turn: dispute }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 32);
  f.agent.cancelAll(); await Promise.all(pending);
  await f.agent.close();
});

test('ordinary time references and reminders do not trigger recall preflight', async () => {
  const f = fixture();
  for (const content of ['我以前喜欢咖啡，今天想试试茶。', '昨天终于把项目完成了。', '记得保存文件', 'Remember to save the file']) {
    assert.equal(await f.agent.recall('alice', { messages: [{ role: 'user', content }] }), '');
  }
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
});
