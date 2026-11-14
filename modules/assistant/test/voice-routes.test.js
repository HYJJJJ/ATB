import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVoiceRoutes } from '../server/voice-routes.js';

test('voice HTTP requires admin and same origin and keeps leases scoped', async t => {
  const calls = [];
  const runtime = {
    status: async () => ({ available: true, pid: null }),
    configure: async body => body,
    open: async owner => { calls.push(['open', owner]); return { leaseId: 'lease' }; },
    close: async (...args) => { calls.push(['close', ...args]); },
    transcribe: async (owner, options) => ({ text: '你好', owner, leaseId: options.leaseId }),
  };
  const accounts = { session: token => token === 'admin' ? { user: { role: 'admin' } } : token === 'guest' ? { user: { role: 'guest' } } : null };
  const routes = createVoiceRoutes({ accounts, runtime });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`, base = `http://${host}/api/assistant/voice/`;
  assert.equal((await fetch(base + 'status')).status, 401);
  assert.equal((await fetch(base + 'status', { headers: { cookie: '__Host-freecamera=guest' } })).status, 401);
  const post = (action, body, origin = `https://${host}`) => fetch(base + action, { method: 'POST', headers: { cookie: '__Host-freecamera=admin', origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('open', {}, 'https://evil.example')).status, 403);
  assert.equal((await post('open', {})).status, 200); assert.deepEqual(calls[0], ['open', 'admin']);
  assert.equal((await post('transcribe', { leaseId: 'lease', pcm: 'data' })).status, 200);
  assert.equal((await post('close', { leaseId: 'lease' })).status, 200);
  assert.deepEqual(calls.at(-1), ['close', 'admin', 'lease', { keepWarm: false }]);
  await post('close', { leaseId: 'lease', keepWarm: true });
  assert.deepEqual(calls.at(-1), ['close', 'admin', 'lease', { keepWarm: true }]);
  await post('close', { leaseId: 'lease', keepWarm: 'true' });
  assert.deepEqual(calls.at(-1), ['close', 'admin', 'lease', { keepWarm: false }]);
  const beforeInvalidClose = calls.length;
  assert.equal((await post('close', {})).status, 400);
  assert.equal(calls.length, beforeInvalidClose);
  assert.equal((await post('bogus', {})).status, 404);
  assert.equal((await post('open', null)).status, 400);
  assert.equal((await post('transcribe', { leaseId: 'lease', pcm: 'x'.repeat(1500000) })).status, 413);
});

test('disconnecting a transcription HTTP request closes its own worker lease', async t => {
  let entered, cancelled;
  const waiting = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { cancelled = resolve; });
  const runtime = {
    transcribe: async () => { entered(); await closed; throw Error('语音已停止'); },
    close: async (...args) => { cancelled(args); },
  };
  const accounts = { session: () => ({ user: { role: 'admin' } }) };
  const routes = createVoiceRoutes({ accounts, runtime });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  const request = http.request(`http://${host}/api/assistant/voice/transcribe`, {
    method: 'POST', headers: { cookie: '__Host-freecamera=admin', origin: `https://${host}`, 'content-type': 'application/json' },
  });
  request.on('error', () => {}); request.end(JSON.stringify({ leaseId: 'owned-lease', pcm: 'data' }));
  await waiting; request.destroy();
  assert.deepEqual(await closed, ['admin', 'owned-lease', { keepWarm: true }]);
});
