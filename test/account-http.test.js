import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServers } from '../server/index.js';

test('production account endpoints enforce local initialization, same origin, secure sessions, logout and throttling', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'freecamera-auth-http-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const service = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, certDir: path.join(dir, 'certs'), dataDir: path.join(dir, 'data') });
  t.after(() => service.close());
  const port = service.secure.address().port, origin = `https://127.0.0.1:${port}`, ca = await readFile(path.join(dir, 'certs/ca.crt'));
  async function request(endpoint, data, options = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: '127.0.0.1', port, path: `/api/auth/${endpoint}`, method: data ? 'POST' : 'GET', ca,
        localAddress: options.remote ? '127.0.0.2' : '127.0.0.1', headers: { Origin: options.origin || origin, 'Content-Type': 'application/json', ...(options.cookie ? { Cookie: options.cookie } : {}) } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
      }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
    });
  }
  assert.equal((await request('session')).body.needsSetup, true);
  assert.equal((await request('session', null, { remote: true })).body.canSetup, false);
  const credentials = { username: 'admin', password: 'private-camera-password' };
  assert.equal((await request('setup', credentials, { remote: true })).status, 403);
  assert.equal((await request('setup', credentials, { origin: 'https://evil.example' })).status, 403);
  const created = await request('setup', credentials); assert.equal(created.status, 200);
  const cookie = created.headers['set-cookie'][0]; assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.deepEqual((await request('session', null, { cookie })).body.user, { username: 'admin', role: 'admin' });
  assert.equal((await request('setup', credentials)).status, 400);
  assert.equal((await request('login', { ...credentials, password: 'incorrect' })).status, 401);
  assert.equal((await request('login', credentials, { remote: true })).status, 200);
  assert.equal((await request('logout', {}, { cookie, origin: 'https://evil.example' })).status, 403);
  assert.ok((await request('session', null, { cookie })).body.user);
  assert.equal((await request('logout', {}, { cookie })).status, 200);
  assert.equal((await request('session', null, { cookie })).body.user, null);
  let last;
  for (let i = 0; i < 10; i++) last = await request('login', { ...credentials, password: 'incorrect' });
  assert.equal(last.status, 429);
  for (const secret of ['/data/account.json', '/account.json']) {
    const status = await new Promise((resolve, reject) => https.get(`${origin}${secret}`, { ca }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(status, 404);
  }
});
