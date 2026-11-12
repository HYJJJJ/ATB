const https = require('node:https');
const tls = require('node:tls');
const path = require('node:path');
const { readFile, mkdir, writeFile, rename } = require('node:fs/promises');
const { X509Certificate } = require('node:crypto');
const { certificateMatches } = require('./trust.cjs');

function probeLocalServer(origin, ca, timeout = 1500) {
  if (!ca) return Promise.resolve(null);
  return new Promise(resolve => {
    const request = https.get(`${origin}/api/config`, {
      ca, rejectUnauthorized: true, timeout, signal: AbortSignal.timeout(timeout),
      checkServerIdentity(hostname, cert) {
        return tls.checkServerIdentity(hostname, cert)
          || (certificateMatches(cert.raw, ca, hostname) ? undefined : new Error('Unexpected local CA signature'));
      },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) { request.destroy(); resolve(null); }
      });
      response.on('error', () => resolve(null));
      response.on('end', () => {
        try {
          const config = JSON.parse(body);
          resolve(response.statusCode === 200 && ['atb', 'freecamera'].includes(config.app) ? config : null);
        } catch { resolve(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function normalizeServiceOrigin(address) {
  if (typeof address !== 'string' || !address.trim() || address.length > 2048) throw Error('请输入远程 ATB 地址');
  const value = address.trim();
  if (/\s/.test(value)) throw Error('服务器地址不能包含空格');
  const explicit = value.includes('://');
  let url;
  try { url = new URL(explicit ? value : `https://${value}`); } catch { throw Error('服务器地址格式不正确'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) throw Error('请输入 HTTPS 服务器地址，不要包含账号、路径或参数');
  if (!explicit && !url.port) url.port = '8443';
  return url.origin;
}
function validateRoot(ca) {
  try {
    if (typeof ca !== 'string' || ca.length > 65536 || ca.includes('PRIVATE KEY')) throw Error();
    const root = new X509Certificate(ca);
    if (!root.ca || !root.verify(root.publicKey) || Date.parse(root.validFrom) > Date.now() || Date.parse(root.validTo) < Date.now()) throw Error();
    return { fingerprint: root.fingerprint256, subject: root.subject };
  } catch { throw Error('请选择 ATB 根证书 ca.crt，不要选择私钥或服务器证书'); }
}
async function connectRemoteService({ address, ca }) {
  const origin = normalizeServiceOrigin(address); validateRoot(ca);
  const config = await probeLocalServer(origin, ca, 5000);
  if (!config) throw Error('无法验证远程 ATB：请检查网络、服务地址和根证书是否匹配');
  return { origin, ca, platform: !!config.platformVersion, remote: true, reused: true, async close() {} };
}
function profileData(profile) {
  if (!profile || !['local', 'remote'].includes(profile.mode)) throw Error('连接配置无效');
  const result = { mode: profile.mode };
  if (profile.mode === 'remote' || profile.origin) {
    result.origin = normalizeServiceOrigin(profile.origin); validateRoot(profile.ca); result.ca = profile.ca;
  }
  if (profile.remotes !== undefined) {
    if (!Array.isArray(profile.remotes) || profile.remotes.length > 20) throw Error('已保存的服务列表无效');
    result.remotes = profile.remotes.map(item => {
      const origin = normalizeServiceOrigin(item.origin); validateRoot(item.ca);
      return { origin, ca: item.ca };
    });
  }
  if (profile.draft !== undefined) {
    const { address, ca } = profile.draft;
    if (typeof address !== 'string' || address.length > 2048 || /[@?#]/.test(address)) throw Error('服务地址不能包含账号、密码或参数');
    result.draft = { address };
    if (ca) { validateRoot(ca); result.draft.ca = ca; }
  }
  return result;
}
async function loadConnectionProfile(filename) {
  try { return profileData(JSON.parse(await readFile(filename, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { mode: 'local' }; throw error; }
}
async function saveConnectionProfile(filename, profile) {
  const data = profileData(profile);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(`${filename}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(`${filename}.tmp`, filename);
}

async function connectService({ dataRoot, lanIp, httpsPort, httpPort, startServers }) {
  const origin = `https://${lanIp}:${httpsPort}`;
  const certDir = path.join(dataRoot, 'certs');
  const caFile = path.join(certDir, 'ca.crt');
  let ca;
  try { ca = await readFile(caFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const existing = await probeLocalServer(origin, ca);
  if (existing) return { origin, ca, platform: !!existing.platformVersion, reused: true, async close() {} };
  const server = await startServers({ lanIp, httpsPort, httpPort, certDir, dataDir: path.join(dataRoot, 'data') });
  try { ca = await readFile(caFile, 'utf8'); }
  catch (error) { await server.close(); throw error; }
  return { origin, ca, platform: true, reused: false, close: () => server.close() };
}

module.exports = { probeLocalServer, connectService, normalizeServiceOrigin, connectRemoteService, validateRoot, loadConnectionProfile, saveConnectionProfile };
