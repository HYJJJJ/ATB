import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { ensureCertificates } from '../scripts/setup-cert.js';
import { selectedIp, lanAddresses } from '../scripts/network.js';
import { createHandler } from './app.js';
import { AccountStore } from './accounts.js';
import { createAccountRoutes } from './account-routes.js';
import { SharedSettings } from './shared-settings.js';
import { loadModules } from './modules.js';
import { createPlatformRoutes } from './platform-routes.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = { name: 'ATB', fullName: 'All The Best', version: '0.7.0' };
function port(value, fallback) { const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < 1 || n > 65535) throw Error('端口必须为 1–65535 的整数'); return n; }
export async function startServers(options = {}) {
  const { lanIp = selectedIp(), httpsPort = port(process.env.HTTPS_PORT, 8443), httpPort = port(process.env.HTTP_PORT, 8080), certDir = process.env.CERT_DIR || path.join(root, 'certs'), dataDir = process.env.DATA_DIR || path.join(root, 'data'), modulesDir = process.env.ATB_MODULES_DIR || path.join(root, 'modules'), publicOrigin: suppliedOrigin = process.env.PUBLIC_ORIGIN || null } = options;
  let publicOrigin = suppliedOrigin, publicIp;
  if (publicOrigin) {
    let url; try { url = new URL(publicOrigin); } catch { throw Error('PUBLIC_ORIGIN 必须是 HTTPS IPv4 服务地址'); }
    if (url.protocol !== 'https:' || isIP(url.hostname) !== 4 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('PUBLIC_ORIGIN 必须是 HTTPS IPv4 地址，不含账号、路径或参数');
    publicOrigin = url.origin; publicIp = url.hostname;
  }
  const accounts = await AccountStore.load(path.join(dataDir, 'account.json'));
  if (publicOrigin && !accounts.configured) throw Error('公网部署前须通过服务器本机初始化管理员账户');
  const shared = await SharedSettings.load(dataDir);
  const certRootName = publicOrigin ? 'FreeCamera Cloud Root' : 'FreeCamera Local Root';
  const certs = await ensureCertificates({ directory: certDir, ips: [lanIp, ...lanAddresses(), ...(publicIp ? [publicIp] : [])], rootName: certRootName });
  const tailscaleAddresses = lanAddresses().filter(ip => /^100\./.test(ip) && Number(ip.split('.')[1]) >= 64 && Number(ip.split('.')[1]) <= 127);
  const config = { lanIp, httpsPort, httpPort, certDir, tailscaleAddresses, publicOrigin, publicIp, certRootName,
    relayPort: options.relayPort ?? (process.env.TURN_PORT === '0' ? 0 : process.env.TURN_PORT ?? (httpsPort === 65535 ? 65534 : httpsPort + 1)),
    relayPublicPort: options.relayPublicPort ?? process.env.TURN_PUBLIC_PORT,
    ...(Object.hasOwn(options, 'detector') ? { detector: options.detector } : {}) };
  const modules = await loadModules({ modulesDir, context: { accounts, dataDir, shared, config, platform } });
  const accountRoutes = createAccountRoutes({ accounts, lanIp }), platformRoutes = createPlatformRoutes({ accounts, shared, modules, platform });
  const secure = https.createServer({ key: certs.key, cert: certs.cert, minVersion: 'TLSv1.2' }, createHandler({ ...config, secure: true, accountRoutes, platformRoutes, modules }));
  const plain = publicOrigin ? null : http.createServer(createHandler({ ...config, secure: false, modules }));
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await modules.close(); await accounts.pending; await shared.close();
    await Promise.all([secure, plain].filter(Boolean).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  };
  const listen = (server, number) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(number, '0.0.0.0', () => { server.off('error', reject); resolve(); }); });
  try { await modules.attach(secure); await listen(secure, httpsPort); if (plain) await listen(plain, httpPort); }
  catch (error) { await close(); throw error; }
  return { secure, plain, config: { ...config, ...modules.config, modules: modules.list() }, modules, shared, accounts, get relay() { return modules.modules.find(item => item.instance.relay)?.instance.relay; }, close };
}
let invokedPath; try { if (process.argv[1]) invokedPath = realpathSync(process.argv[1]); } catch {}
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const instance = await startServers(), { lanIp, httpsPort, publicOrigin, modules } = instance.config;
    console.log(`ATB · All The Best 已启动\n工作台: ${publicOrigin || `https://${lanIp}:${httpsPort}`}/platform\n模块: ${modules.map(module => module.name).join('、') || '暂无模块'}\n按 Ctrl+C 停止服务。`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await instance.close(); process.exit(0); });
  } catch (error) { console.error(`启动失败：${error.message}`); process.exitCode = 1; }
}
