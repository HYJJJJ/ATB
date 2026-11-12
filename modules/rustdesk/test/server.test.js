import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import createModule from '../server/index.js';
import { AccountStore, SESSION_COOKIE } from '../../../server/accounts.js';

const key = 'A'.repeat(43) + '=';
const settings = { publicHost: 'remote.example.test', rustdesk: { idPort: 33016, relayPort: 45017, natPort: 53015, publicKey: key, deployedVersion: '1.1.16', privateKey: 'must-never-leak' }, sshPassword: 'must-never-leak' };
async function harness(t, serverSettings = settings, role = 'admin') {
  const accounts = new AccountStore();
  await accounts.setup('admin', 'a-test-password');
  const session = await accounts.login('admin', 'a-test-password');
  session.user.role = role;
  let current = structuredClone(serverSettings);
  const instance = await createModule({ accounts, shared: { get: () => structuredClone(current), async update(_section, mutator) { current = mutator(structuredClone(current)); return structuredClone(current); } }, config: {} });
  const server = http.createServer(async (req, res) => { if (!await instance.handle(req, res, new URL(req.url, 'http://local').pathname, {})) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await instance.close(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, headers: { cookie: `${SESSION_COOKIE}=${session.token}` } };
}
test('all configuration, export and health routes require the platform session', async t => {
  const { url } = await harness(t);
  for (const route of ['config', 'export', 'status']) assert.equal((await fetch(`${url}/api/rustdesk/${route}`)).status, 401);
});
test('public configuration follows shared settings and explains irregular NAT mappings without secrets', async t => {
  const { url, headers } = await harness(t);
  const response = await fetch(`${url}/api/rustdesk/config`, { headers });
  const body = await response.json();
  assert.equal(body.idServer, 'remote.example.test:33016');
  assert.equal(body.relayServer, 'remote.example.test:45017');
  assert.equal(body.publicKey, key);
  assert.equal(body.natTestPort, 53015);
  assert.equal(body.clientNatTestPort, 33015);
  assert.equal(body.natMappingCompatible, false);
  assert.equal(body.ready, true);
  assert.equal(JSON.stringify(body).includes('must-never-leak'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const exported = await fetch(`${url}/api/rustdesk/export`, { headers });
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal((await exported.json()).configuration.publicKey, key);
});
test('mutations reject foreign origins and never modify shared settings', async t => {
  const { url, headers } = await harness(t);
  const foreign = await fetch(`${url}/api/rustdesk/config`, { method: 'PUT', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${url}/api/rustdesk/config`, { method: 'PUT', headers: { ...headers, origin: url } })).status, 405);
});
test('admin configuration writes validate fields and preserve shared host and deployment metadata', async t => {
  const { url, headers } = await harness(t);
  const post = value => fetch(`${url}/api/rustdesk/config`, { method: 'POST', headers: { ...headers, origin: url, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const values = { idPort: 41016, relayPort: 41017, natPort: 41015, publicKey: key };
  assert.equal((await post({ ...values, idPort: 0 })).status, 400);
  assert.equal((await post({ ...values, publicHost: 'attacker.example' })).status, 400);
  assert.equal((await post(values)).status, 200);
  const result = await (await fetch(`${url}/api/rustdesk/config`, { headers })).json();
  assert.equal(result.idServer, 'remote.example.test:41016'); assert.equal(result.natMappingCompatible, true);
  assert.equal(result.deployedVersion, '1.1.16');
});
test('configuration changes reject non-admin sessions and a different origin scheme', async t => {
  const { url, headers } = await harness(t, settings, 'viewer');
  const body = JSON.stringify({ idPort: 41016, relayPort: 41017, natPort: 41015, publicKey: key });
  assert.equal((await fetch(`${url}/api/rustdesk/config`, { method: 'POST', headers: { ...headers, origin: url, 'content-type': 'application/json' }, body })).status, 403);
  const admin = await harness(t);
  assert.equal((await fetch(`${admin.url}/api/rustdesk/config`, { method: 'POST', headers: { ...admin.headers, origin: admin.url.replace('http:', 'https:'), 'content-type': 'application/json' }, body })).status, 403);
});
test('missing or malformed settings produce an unconfigured view rather than guessed endpoints', async t => {
  const { url, headers } = await harness(t, { publicHost: 'https://bad.example/path', rustdesk: { idPort: 0, publicKey: 'secret\nvalue' } });
  const config = await (await fetch(`${url}/api/rustdesk/config`, { headers })).json();
  assert.equal(config.ready, false); assert.equal(config.idServer, ''); assert.equal(config.publicKey, '');
  const status = await (await fetch(`${url}/api/rustdesk/status`, { headers })).json();
  assert.equal(status.state, 'unconfigured'); assert.deepEqual(status.checks, []);
});
test('health probes distinguish TCP reachability and never claim a verified remote session', async t => {
  const listener = net.createServer(socket => socket.end()); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = listener.address().port;
  const { url, headers } = await harness(t, { publicHost: '127.0.0.1', rustdesk: { idPort: port, relayPort: port, natPort: port, publicKey: key } });
  const status = await (await fetch(`${url}/api/rustdesk/status`, { headers })).json();
  assert.equal(status.state, 'reachable'); assert.equal(status.checks.length, 3);
  assert.equal(status.checks.every(check => check.reachable && check.protocol === 'tcp'), true);
  assert.equal(status.remoteSessionVerified, false); assert.equal(status.udpVerified, false);
});
