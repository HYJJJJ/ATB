import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { ensureCertificates } from '../scripts/setup-cert.js';

const require = createRequire(import.meta.url);
const { certificateMatches, isTrustedUrl } = require('../desktop/trust.cjs');
const { probeLocalServer } = require('../desktop/service.cjs');

test('desktop certificate exceptions require the exact CA signature and expected hostname', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-trust-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certs = await ensureCertificates({ directory: path.join(directory, 'one'), ips: ['127.0.0.1'] });
  const other = await ensureCertificates({ directory: path.join(directory, 'two'), ips: ['127.0.0.1'] });
  assert.equal(certificateMatches(certs.cert, certs.ca, '127.0.0.1'), true);
  assert.equal(certificateMatches(certs.cert, other.ca, '127.0.0.1'), false);
  assert.equal(certificateMatches(other.cert, certs.ca, '127.0.0.1'), false);
  assert.equal(certificateMatches(certs.cert, certs.ca, '192.0.2.222'), false);
  assert.equal(certificateMatches('invalid certificate', certs.ca, '127.0.0.1'), false);
  assert.equal(isTrustedUrl('https://127.0.0.1:8443/?mode=viewer', 'https://127.0.0.1:8443'), true);
  for (const url of ['http://127.0.0.1:8443/', 'https://127.0.0.1:8444/', 'https://127.0.0.1:8443.evil.test/', 'file:///etc/passwd', 'about:blank']) {
    assert.equal(isTrustedUrl(url, 'https://127.0.0.1:8443'), false, url);
  }
});

test('desktop only reuses a CA-validated HTTPS server identifying as FreeCamera', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certs = await ensureCertificates({ directory, ips: ['127.0.0.1'] });
  let marker = 'freecamera';
  const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ app: marker }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `https://127.0.0.1:${server.address().port}`;
  assert.equal((await probeLocalServer(origin, certs.ca))?.app, 'freecamera');
  marker = 'another-app';
  assert.equal(await probeLocalServer(origin, certs.ca), null);
  assert.equal(await probeLocalServer(origin, ''), null);
});
