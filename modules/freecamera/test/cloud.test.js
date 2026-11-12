import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import forge from 'node-forge';
import { startServers } from '../../../server/index.js';
import { AccountStore } from '../../../server/accounts.js';
import { startRelay } from '../server/relay.js';
import createModule from '../server/index.js';

test('public NAT configuration serves canonical URLs, IP certificate and relay policy without unmapped listeners', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-cloud-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data'), certDir = path.join(directory, 'certs');
  const accounts = await AccountStore.load(path.join(dataDir, 'account.json')); await accounts.setup('test', 'test');
  const service = await startServers({ lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, relayPort: 0, dataDir, certDir,
    publicOrigin: 'https://203.0.113.10:57728', relayPublicPort: 33365 });
  t.after(() => service.close());
  const ca = await readFile(path.join(certDir, 'ca.crt'));
  const get = pathname => new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', servername: 'localhost', port: service.secure.address().port, path: pathname, ca, headers: { Host: 'attacker.example' } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  const config = JSON.parse(await get('/api/config'));
  assert.equal(config.cameraUrl, 'https://203.0.113.10:57728/?mode=camera');
  assert.equal(config.viewerUrl, 'https://203.0.113.10:57728/?mode=viewer');
  assert.equal(config.setupUrl, 'https://203.0.113.10:57728/setup');
  assert.equal(config.requireCameraLogin, true);
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.deepEqual(config.iceServers, []);
  assert.equal(service.plain, null);
  const cert = forge.pki.certificateFromPem(await readFile(path.join(certDir, 'server.crt'), 'utf8'));
  assert.ok(cert.getExtension('subjectAltName').altNames.some(n => n.ip === '203.0.113.10'));
  assert.match(await get('/setup'), /FreeCamera Cloud Root/);
  const relay = service.modules.modules.find(item => item.manifest.id === 'freecamera').instance.relay.configuration({ room: { deviceId: 'test' } }, []);
  assert.deepEqual(relay.iceServers[0].urls, ['turn:203.0.113.10:33365?transport=tcp']);
  assert.equal(relay.iceTransportPolicy, 'relay');
});

test('public deployment refuses unsafe origins and missing mapped relay ports before binding', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-cloud-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { httpsPort: 0, httpPort: 0, relayPort: 0, dataDir: path.join(directory, 'data'), certDir: path.join(directory, 'certs') };
  const rejected = async settings => {
    let service;
    try { await assert.rejects(async () => { service = await createModule({ dataDir: options.dataDir, config: { ...options, ...settings, lanIp: "127.0.0.1", detector: null } }); }, /PUBLIC_ORIGIN|TURN_PUBLIC_PORT/); }
    finally { await service?.close(); }
  };
  for (const publicOrigin of ['http://203.0.113.10:57728', 'https://user:secret@203.0.113.10', 'https://203.0.113.10/path', 'https://203.0.113.10/?x=1']) {
    await rejected({ publicOrigin, relayPublicPort: 33365 });
  }
  await rejected({ publicOrigin: 'https://203.0.113.10:57728', relayPublicPort: 0 });
});

test('public relay advertises mapped TCP port while retaining authenticated room isolation', async t => {
  const relay = await startRelay({ addresses: ['203.0.113.10'], relayIp: '127.0.0.1', port: 0, advertisedPort: 33365, allowPublic: true });
  t.after(() => relay.close());
  const config = relay.configuration({ room: { deviceId: 'test' } }, []);
  assert.deepEqual(config.iceServers[0].urls, ['turn:203.0.113.10:33365?transport=tcp']);
  assert.ok(config.iceServers[0].username && config.iceServers[0].credential);
});
