import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceRuntime } from '../server/voice-runtime.js';
import { createVoiceRoutes } from '../server/voice-routes.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-voice-stream-route-'));
  const runtime = new VoiceRuntime({ dataDir: path.join(directory, 'assistant'), ttsRequest: async () => new Response('{"code":0,"data":"AAAAAA=="}\n{"code":20000000}\n') });
  await runtime.configure({ provider: 'volcengine', volcengine: { apiKey: 'test-only-voice-secret' } });
  const accounts = new EventEmitter(), valid = new Set(['owner-a', 'owner-b']);
  accounts.session = token => valid.has(token) ? { user: { role: 'admin' } } : null;
  accounts.sessionId = token => token;
  const routes = createVoiceRoutes({ accounts, runtime });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const host = `127.0.0.1:${server.address().port}`;
  const post = (action, body, { token = 'owner-a', origin = `https://${host}`, signal } = {}) => fetch(`http://${host}/api/assistant/voice/${action}`, { method: 'POST', headers: { cookie: `__Host-freecamera=${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { runtime, accounts, valid, post };
}
test('live voice routes enforce session, origin, lease and stream ownership while returning PCM', async t => {
  const { post } = await fixture(t);
  for (const action of ['ttsStart', 'ttsText', 'ttsFinish', 'ttsRead']) {
    assert.equal((await post(action, {}, { token: 'invalid' })).status, 401);
    assert.equal((await post(action, {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(action, {})).status, 400);
  }
  const { leaseId } = await (await post('open', { mode: 'synthesis' })).json();
  const stream = await (await post('ttsStart', { leaseId })).json(), args = { leaseId, streamId: stream.streamId };
  assert.equal(stream.mime, 'audio/pcm');
  assert.equal((await post('ttsText', { ...args, text: '你好' }, { token: 'owner-b' })).status, 400);
  assert.equal((await post('ttsText', { ...args, text: '你好' })).status, 200);
  assert.equal((await post('ttsFinish', args)).status, 200);
  let output = '', done = false;
  while (!done) { const response = await post('ttsRead', args); assert.equal(response.status, 200); const value = await response.json(); output += value.audio; done = value.done; }
  assert.equal(output, 'AAAAAA==');
});
test('logout during a pending audio read closes the lease and returns no late PCM', async t => {
  const { post, runtime, accounts, valid } = await fixture(t);
  const { leaseId } = await (await post('open', { mode: 'synthesis' })).json();
  const { streamId } = await (await post('ttsStart', { leaseId })).json();
  const reading = post('ttsRead', { leaseId, streamId }); await new Promise(resolve => setTimeout(resolve, 20));
  valid.delete('owner-a'); accounts.emit('revoked', 'owner-a');
  const response = await reading; assert.ok([400, 401].includes(response.status)); assert.ok(!(await response.text()).includes('audio'));
  assert.equal(runtime.state.status, 'off');
});
test('disconnecting a long audio read releases its exact lease', async t => {
  const { post, runtime } = await fixture(t);
  const { leaseId } = await (await post('open', { mode: 'synthesis' })).json();
  const { streamId } = await (await post('ttsStart', { leaseId })).json();
  const controller = new AbortController(), reading = post('ttsRead', { leaseId, streamId }, { signal: controller.signal });
  const rejected = assert.rejects(reading, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); await rejected;
  for (let i = 0; i < 30 && runtime.state.status !== 'off'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.state.status, 'off');
});
