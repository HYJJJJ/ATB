import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import forge from 'node-forge';
import QRCode from 'qrcode';
import { ensureCertificates } from '../../../scripts/setup-cert.js';
import { createHandler } from '../../../server/app.js';

import { loadModules } from '../../../server/modules.js';
import { fileURLToPath } from 'node:url';

async function cameraHandler(config, directory) {
  const modules = await loadModules({ modulesDir:fileURLToPath(new URL('../../../modules/',import.meta.url)),context:{config:{...config,detector:null,relayPort:0},dataDir:path.join(directory,'data')} });
  return createHandler({...config,modules});
}
test('HTTPS serves app and trusted API; HTTP only serves certificate setup; neither exposes secrets', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certs = await ensureCertificates({ directory, ips: ['127.0.0.1'] });
  const config = { certDir: directory, lanIp: '127.0.0.1', httpsPort: 8443, httpPort: 8080 };
  const secure = https.createServer({ key: certs.key, cert: certs.cert }, await cameraHandler({ ...config, secure: true }, directory));
  const plain = http.createServer(await cameraHandler({ ...config, secure: false }, directory));
  secure.listen(0, '127.0.0.1'); plain.listen(0, '127.0.0.1');
  await Promise.all([once(secure, 'listening'), once(plain, 'listening')]);
  t.after(() => Promise.all([new Promise(r => secure.close(r)), new Promise(r => plain.close(r))]));
  async function get(server, pathname, tls = false) {
    return new Promise((resolve, reject) => {
      (tls ? https : http).get({ host: '127.0.0.1', port: server.address().port, path: pathname, ca: certs.ca }, res => {
        let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }).on('error', reject);
    });
  }
  const home = await get(secure, '/?mode=viewer', true);
  assert.equal(home.status, 200); assert.match(home.body, /FreeCamera/);
  assert.match(home.headers['permissions-policy'], /microphone=\(self\)/);
  const api = await get(secure, '/api/config', true);
  assert.equal(JSON.parse(api.body).cameraUrl, 'https://127.0.0.1:8443/?mode=camera');
  assert.equal((await get(secure, '/app.js', true)).status, 200);
  assert.match((await get(plain, '/')).body, /完全信任/);
  assert.equal((await get(plain, '/app.js')).status, 404);
  assert.equal((await get(plain, '/api/config')).status, 404);
  assert.equal((await get(plain, '/ca.crt')).body, certs.ca);
  for (const url of ['/certs/ca-key.pem', '/server/index.js', '/../package.json', '/%2e%2e/package.json']) {
    assert.equal((await get(secure, url, true)).status, 404);
  }
  assert.match((await get(secure, '/qr.svg', true)).headers['content-type'], /image\/svg/);
});

test('Tailscale setup links, QR codes and configuration retain the requested configured address', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-camera-http-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const config = { lanIp: '192.168.1.2', httpsPort: 8443, httpPort: 8080, tailscaleAddresses: ['100.64.0.10'] };
  const server = http.createServer(await cameraHandler({ ...config, secure: true }, directory));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function get(pathname, host) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port, path: pathname, headers: { Host: host } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  }
  const cameraUrl = 'https://100.64.0.10:8443/?mode=camera', setupUrl = 'http://100.64.0.10:8080';
  const setup = await get('/setup', '100.64.0.10:8443');
  assert.equal(setup.status, 200); assert.ok(setup.body.includes(`href="${cameraUrl}"`)); assert.ok(setup.body.includes(setupUrl));
  const remote = JSON.parse((await get('/api/config', '100.64.0.10:8443')).body);
  assert.equal(remote.cameraUrl, cameraUrl); assert.equal(remote.setupUrl, setupUrl);
  assert.equal(remote.viewerUrl, 'https://100.64.0.10:8443/?mode=viewer');
  assert.equal((await get('/qr.svg', '100.64.0.10:8443')).body, await QRCode.toString(cameraUrl, { type: 'svg', margin: 2, width: 196 }));
  assert.equal((await get('/setup-qr.svg', '100.64.0.10:8443')).body, await QRCode.toString(setupUrl, { type: 'svg', margin: 2, width: 196 }));
  assert.equal(JSON.parse((await get('/api/config', '192.168.1.2:8443')).body).cameraUrl, 'https://192.168.1.2:8443/?mode=camera');
  assert.equal(JSON.parse((await get('/api/config', 'untrusted.example:8443')).body).cameraUrl, 'https://192.168.1.2:8443/?mode=camera');
  assert.equal(JSON.parse((await get('/api/config', '100.64.0.10.attacker.example:8443')).body).cameraUrl, 'https://192.168.1.2:8443/?mode=camera');
});
