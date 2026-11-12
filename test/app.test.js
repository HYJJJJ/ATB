import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import forge from 'node-forge';
import { ensureCertificates } from '../scripts/setup-cert.js';

test('generated certificate is trusted by its CA, includes LAN IP, and is reused', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await ensureCertificates({ directory, ips: ['192.168.1.3'] });
  const ca = forge.pki.certificateFromPem(first.ca);
  const leaf = forge.pki.certificateFromPem(first.cert);
  assert.equal(ca.verify(leaf), true);
  assert.ok(leaf.getExtension('subjectAltName').altNames.some(n => n.ip === '192.168.1.3'));
  assert.equal(leaf.getExtension('extKeyUsage').serverAuth, true);
  assert.ok(leaf.validity.notAfter - leaf.validity.notBefore <= 398 * 86400000);
  assert.equal((await ensureCertificates({ directory, ips: ['192.168.1.3'] })).cert, first.cert);
  const updated = await ensureCertificates({ directory, ips: ['192.168.1.4'] });
  assert.equal(updated.ca, first.ca, 'changing IP must not require trusting a new root');
  assert.notEqual(updated.cert, first.cert);
});
