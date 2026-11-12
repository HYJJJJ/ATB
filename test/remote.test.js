import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { ensureCertificates } from '../scripts/setup-cert.js';
const require = createRequire(import.meta.url), remote = require('../desktop/service.cjs');

test('remote addresses normalize safely and refuse credentials, navigation paths and non-HTTPS schemes', () => {
  assert.equal(remote.normalizeServiceOrigin('100.64.0.10'), 'https://100.64.0.10:8443');
  assert.equal(remote.normalizeServiceOrigin(' home.example.ts.net:9443 '), 'https://home.example.ts.net:9443');
  assert.equal(remote.normalizeServiceOrigin('https://home.example.ts.net/'), 'https://home.example.ts.net');
  for (const value of ['', 'http://home.test', 'file:///tmp/a', 'https://user:pass@home.test', 'https://home.test/path', 'https://home.test/?token=x', 'https://home.test/#x']) assert.throws(() => remote.normalizeServiceOrigin(value));
});

test('remote connections verify the actual CA, hostname and service identity and persist no credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-remote-')); t.after(() => rm(directory, { recursive:true, force:true }));
  const certs = await ensureCertificates({ directory:path.join(directory, 'certs'), ips:['127.0.0.1'] });
  const other = await ensureCertificates({ directory:path.join(directory, 'other'), ips:['127.0.0.1'] });
  let marker = 'freecamera';
  const server = https.createServer({ key:certs.key, cert:certs.cert }, (req,res) => res.end(JSON.stringify({ app:marker })));
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const connection = await remote.connectRemoteService({ address:origin, ca:certs.ca });
  assert.equal(connection.origin, origin); assert.equal(connection.remote, true);
  await connection.close(); assert.equal(server.listening, true, 'closing a remote viewer must preserve the home server');
  await assert.rejects(remote.connectRemoteService({ address:origin, ca:other.ca }));
  await assert.rejects(remote.connectRemoteService({ address:origin, ca:certs.key }));
  await assert.rejects(remote.connectRemoteService({ address:origin.replace('127.0.0.1','127.0.0.2'), ca:certs.ca }));
  marker = 'other-app'; await assert.rejects(remote.connectRemoteService({ address:origin, ca:certs.ca }));
  const filename=path.join(directory,'data','desktop-connection.json');
  assert.equal((await remote.loadConnectionProfile(filename)).mode, 'local');
  await remote.saveConnectionProfile(filename,{mode:'remote',origin,ca:certs.ca,password:'must-not-persist'});
  assert.deepEqual(await remote.loadConnectionProfile(filename),{mode:'remote',origin,ca:certs.ca});
  assert.equal((await readFile(filename,'utf8')).includes('must-not-persist'),false);
});

test('connection history and unsubmitted drafts survive local switching without saving credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-history-')); t.after(() => rm(directory, { recursive:true, force:true }));
  const first = await ensureCertificates({ directory:path.join(directory, 'first'), ips:['127.0.0.1'] });
  const second = await ensureCertificates({ directory:path.join(directory, 'second'), ips:['127.0.0.1'] });
  const filename = path.join(directory, 'profile.json');
  const profile = {
    mode: 'local', origin: 'https://first.test:8443', ca: first.ca,
    remotes: [
      { origin: 'https://first.test:8443', ca: first.ca, password: 'must-not-persist' },
      { origin: 'https://second.test:9443', ca: second.ca, token: 'must-not-persist' },
    ],
    draft: { address: 'third.test:8', ca: second.ca, password: 'must-not-persist' },
  };
  await remote.saveConnectionProfile(filename, profile);
  const loaded = await remote.loadConnectionProfile(filename);
  assert.deepEqual(loaded.remotes, [
    { origin: 'https://first.test:8443', ca: first.ca },
    { origin: 'https://second.test:9443', ca: second.ca },
  ]);
  assert.deepEqual(loaded.draft, { address: 'third.test:8', ca: second.ca });
  assert.equal(loaded.mode, 'local');
  assert.equal((await readFile(filename, 'utf8')).includes('must-not-persist'), false);
  for (const address of ['https://user:secret@home.test', 'home.test/?token=secret', 'home.test/#secret']) {
    await assert.rejects(remote.saveConnectionProfile(filename, { ...profile, draft: { address } }));
  }
});
