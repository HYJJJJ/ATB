import forge from 'node-forge';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { selectedIp, lanAddresses } from './network.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function keyPair() { return forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }); }
function certificate(keys, days) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 5 * 60000);
  cert.validity.notAfter = new Date(Date.now() + days * 86400000);
  return cert;
}
async function optional(file) {
  try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function ensureCertificates({ directory = path.join(root, 'certs'), ips = [selectedIp(), ...lanAddresses()], rootName = 'FreeCamera Local Root' } = {}) {
  await mkdir(directory, { recursive: true });
  const caFile = path.join(directory, 'ca.crt');
  const caKeyFile = path.join(directory, 'ca-key.pem');
  let caPem = await optional(caFile);
  let caKeyPem = await optional(caKeyFile);
  if (Boolean(caPem) !== Boolean(caKeyPem)) throw new Error('根证书文件不完整。请恢复 certs 备份，或删除 certs 后重新生成并在手机上重新信任。');
  if (!caPem) {
    const keys = keyPair();
    const ca = certificate(keys, 3650);
    const name = [{ name: 'commonName', value: rootName }];
    ca.setSubject(name); ca.setIssuer(name);
    ca.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    ca.sign(keys.privateKey, forge.md.sha256.create());
    caPem = forge.pki.certificateToPem(ca); caKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    await writeFile(caKeyFile, caKeyPem, { mode: 0o600 });
    await writeFile(caFile, caPem);
  }
  const ca = forge.pki.certificateFromPem(caPem);
  if (ca.validity.notAfter < new Date()) throw new Error('根证书已过期，请重新生成并在手机上重新信任。');
  const certFile = path.join(directory, 'server.crt');
  const keyFile = path.join(directory, 'server-key.pem');
  const oldCert = await optional(certFile); const oldKey = await optional(keyFile);
  const addresses = [...new Set(['127.0.0.1', ...ips])];
  if (oldCert && oldKey) {
    const leaf = forge.pki.certificateFromPem(oldCert);
    const names = leaf.getExtension('subjectAltName')?.altNames ?? [];
    if (leaf.validity.notAfter > new Date(Date.now() + 7 * 86400000) && ca.verify(leaf)
        && addresses.every(ip => names.some(n => n.ip === ip))) return { ca: caPem, cert: oldCert, key: oldKey };
  }
  const keys = keyPair(); const leaf = certificate(keys, 397);
  leaf.setSubject([{ name: 'commonName', value: 'FreeCamera LAN' }]); leaf.setIssuer(ca.subject.attributes);
  leaf.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...addresses.map(ip => ({ type: 7, ip }))] },
  ]);
  leaf.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(leaf); const key = forge.pki.privateKeyToPem(keys.privateKey);
  await writeFile(keyFile, key, { mode: 0o600 }); await writeFile(certFile, cert);
  return { ca: caPem, cert, key };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureCertificates(); console.log('本机证书已准备好。启动 npm start 后，按安装页指引在 iPhone 上信任根证书。');
}
