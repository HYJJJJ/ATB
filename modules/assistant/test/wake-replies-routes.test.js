import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantRoutes } from '../server/assistant-routes.js';

async function fixture(t, request, protocol = 'chat') {
  const directory = await mkdtemp(path.join(tmpdir(), 'wake-replies-'));
  let authorized = true;
  const accounts = { session: token => authorized && ['alice', 'bob'].includes(token) ? { user: { username: token } } : null };
  const routes = await createAssistantRoutes({ accounts, dataDir: directory, request });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://local').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await routes.close(); await rm(directory, { recursive: true, force: true }); });
  const host = `127.0.0.1:${server.address().port}`, base = `http://${host}`;
  const post = (route, body = {}, token = 'alice', origin = `https://${host}`) => fetch(base + '/api/assistant/' + route, { method: 'POST', headers: { cookie: `__Host-freecamera=${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('settings', { name: '小鲸鱼', prompt: '嘴软，偶尔嘴硬。习惯说白饭和我咬你。', provider: 'custom', baseUrl: 'https://example.com/v1', protocol, model: 'fixture-model', apiKey: 'fixture-secret', memory: 'private-reference-canary' })).status, 200);
  return { post, base, revoke: () => { authorized = false; } };
}
const result = (replies, protocol = 'chat') => ({ ok: true, json: async () => protocol === 'responses' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(replies) }] }] } : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replies) } }] } });

for (const protocol of ['chat', 'responses']) test(`${protocol} wake replies use the current persona, cache per account and refresh after persona changes`, async t => {
  const calls = [], replies = ['在呢，白饭呢', '嗯？叫我干嘛呀', '来了来了'];
  const h = await fixture(t, async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return result(replies, protocol); }, protocol);
  let response = await h.post('wake-replies'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { replies });
  const { payload, url } = calls[0]; assert.match(url, protocol === 'responses' ? /\/responses$/ : /\/chat\/completions$/);
  assert.match(JSON.stringify(payload), /嘴软，偶尔嘴硬/); assert.match(JSON.stringify(payload), /小鲸鱼/);
  assert.doesNotMatch(JSON.stringify(payload), /private-reference-canary/); assert.equal(payload.tools, undefined);
  assert.equal(payload.stream, false); if (protocol === 'responses') assert.equal(payload.store, false);
  response = await h.post('wake-replies'); assert.deepEqual(await response.json(), { replies }); assert.equal(calls.length, 1);
  await h.post('wake-replies', {}, 'bob'); assert.equal(calls.length, 2, 'account caches do not mix');
  assert.equal((await h.post('settings', { scope: 'persona', name: '小海豚', prompt: '沉稳简洁，不卖萌' })).status, 200);
  assert.equal((await h.post('wake-replies')).status, 200); assert.equal(calls.length, 3);
  assert.match(JSON.stringify(calls[2].payload), /沉稳简洁，不卖萌/); assert.doesNotMatch(JSON.stringify(calls[2].payload), /白饭|我咬你/);
  const memory = await fetch(h.base + '/api/assistant/memory', { headers: { cookie: '__Host-freecamera=alice' } }).then(r => r.json());
  assert.deepEqual(memory.core, [], 'wake preparation must not create a fake chat or memory');
});

test('wake reply preparation rejects unauthenticated and cross-origin callers before calling the provider', async t => {
  let calls = 0; const h = await fixture(t, async () => { calls++; return result(['在呢', '来了']); });
  assert.equal((await h.post('wake-replies', {}, 'missing')).status, 401);
  assert.equal((await h.post('wake-replies', {}, 'alice', 'https://evil.example')).status, 403);
  assert.equal((await fetch(h.base + '/api/assistant/wake-replies', { headers: { cookie: '__Host-freecamera=alice' } })).status, 405);
  assert.equal(calls, 0);
});

test('wake reply preparation rejects malformed or unsafe text and does not cache a failed batch', async t => {
  let calls = 0; const h = await fixture(t, async () => result(++calls === 1 ? ['（歪头看你）', '<tool>执行操作</tool>', '长'.repeat(25)] : ['在呢', '你说']));
  assert.equal((await h.post('wake-replies')).status, 502);
  assert.deepEqual(await (await h.post('wake-replies')).json(), { replies: ['在呢', '你说'] }); assert.equal(calls, 2);
});

for (const change of ['logout', 'persona']) test(`late wake replies are discarded on ${change}`, async t => {
  let entered, finish; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const h = await fixture(t, async () => { entered(); await gate; return result(['在呢', '来了']); });
  t.after(() => finish());
  const pending = h.post('wake-replies');
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(Error('wake request did not reach provider')), 3000).unref())]);
  if (change === 'logout') h.revoke(); else await h.post('settings', { scope: 'persona', name: '新角色', prompt: '新语气' });
  finish(); assert.equal((await pending).status, change === 'logout' ? 401 : 409);
});
