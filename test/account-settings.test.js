import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountStore } from '../server/accounts.js';
import { createAccountRoutes } from '../server/account-routes.js';

test('account settings require old password, rotate all sessions, persist and accept empty credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atb-account-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'account.json'), accounts = await AccountStore.load(filename);
  await accounts.setup('admin', 'old-password');
  const first = await accounts.login('admin', 'old-password'), other = await accounts.login('admin', 'old-password');
  const revoked = []; accounts.on('revoked', id => revoked.push(id));
  const routes = createAccountRoutes({ accounts, lanIp: '127.0.0.1' });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  const post = (body, token = first.token, origin = `https://${host}`) => fetch(`http://${host}/api/auth/account`, { method: 'POST', headers: { cookie: `__Host-freecamera=${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ currentPassword: 'old-password', username: 'new' }, '')).status, 401);
  assert.equal((await post({ currentPassword: 'old-password', username: 'new' }, first.token, 'https://evil.example')).status, 403);
  assert.equal((await post({ currentPassword: 'wrong-password', username: 'new' })).status, 401);
  assert.ok(accounts.session(first.token)); assert.ok(accounts.session(other.token));
  const response = await post({ currentPassword: 'old-password', username: '', password: '' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { user: { username: '', role: 'admin' } });
  const cookie = response.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const token = cookie.match(/^__Host-freecamera=([^;]+)/)[1];
  assert.equal(accounts.session(first.token), null); assert.equal(accounts.session(other.token), null); assert.equal(revoked.length, 2);
  assert.equal(accounts.session(token).user.username, '');
  const loaded = await AccountStore.load(filename); assert.ok(loaded.session(token)); assert.ok(await loaded.login('', ''));
  assert.equal(await loaded.login('admin', 'old-password'), null);
  assert.equal((await readFile(filename, 'utf8')).includes('old-password'), false);
  // UTF-8 bytes can be split by transport chunks; the saved username must remain exact.
  const body = Buffer.from(JSON.stringify({ currentPassword: '', username: ' 中文 ' })), split = body.indexOf(Buffer.from('中')) + 1;
  const changed = await new Promise((resolve, reject) => {
    const req = http.request(`http://${host}/api/auth/account`, { method: 'POST', headers: { cookie: `__Host-freecamera=${token}`, origin: `https://${host}`, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 20);
  });
  assert.equal(changed.status, 200); assert.equal(changed.data.user.username, ' 中文 ');
  assert.ok(await accounts.login(' 中文 ', ''));
});
