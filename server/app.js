import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const files = new Map([
  ['/platform', ['platform.html', 'text/html; charset=utf-8']],
  ['/platform.js', ['platform.js', 'text/javascript; charset=utf-8']],
  ['/platform.css', ['platform.css', 'text/css; charset=utf-8']],
  ['/setup', ['setup.html', 'text/html; charset=utf-8']],
]);
const emptyModules = { list: () => [], config: {}, asset() {}, async handle() { return false; } };
export function createHandler({ secure, certDir, lanIp, httpsPort, httpPort, accountRoutes, platformRoutes, modules = emptyModules, tailscaleAddresses = [], publicOrigin = null, certRootName = 'FreeCamera Local Root' }) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const respond = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : body); };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { respond(400, 'text/plain', 'Bad request'); return; }
    const pathname = url.pathname;
    let address = lanIp;
    try { const hostname = new URL(`http://${req.headers.host}`).hostname; if ([lanIp, ...tailscaleAddresses].includes(hostname)) address = hostname; } catch {}
    const base = publicOrigin || `https://${address}:${httpsPort}`;
    const requestConfig = { ...modules.config, app: 'atb', version: '0.6.0', platformVersion: 2, modules: modules.list(), secure, base, lanIp, httpsPort, httpPort, ip: publicOrigin ? new URL(base).hostname : address, publicOrigin, certRootName, setupUrl: publicOrigin ? `${base}/setup` : `http://${address}:${httpPort}` };
    if (requestConfig.cameraUrl) requestConfig.cameraUrl = `${base}/?mode=camera`;
    if (requestConfig.viewerUrl) requestConfig.viewerUrl = `${base}/?mode=viewer`;
    try {
      if (secure && accountRoutes && await accountRoutes(req, res, pathname)) return;
      if (secure && platformRoutes && await platformRoutes(req, res, pathname)) return;
      if (await modules.handle(req, res, pathname, requestConfig)) return;
      if (!['GET', 'HEAD'].includes(req.method)) { respond(405, 'text/plain', 'Method not allowed'); return; }
      if (pathname === '/ca.crt') { res.setHeader('Content-Disposition', 'attachment; filename="ATB-Root.crt"'); respond(200, 'application/x-x509-ca-cert', await readFile(path.join(certDir, 'ca.crt'))); return; }
      if (secure && pathname === '/api/config') { const { secure: _, certRootName: __, ...visible } = requestConfig; respond(200, 'application/json; charset=utf-8', JSON.stringify(visible)); return; }
      if (secure && pathname === '/') { res.writeHead(302, { Location: '/platform' }); res.end(); return; }
      const entry = !secure && pathname === '/' ? files.get('/setup') : files.get(pathname);
      const asset = secure ? modules.asset(pathname) : null;
      if (!secure && !['/', '/setup', '/platform.css'].includes(pathname) || !entry && !asset) { respond(404, 'text/plain', 'Not found'); return; }
      if (asset) {
        let content = await readFile(asset.file);
        if (/^(text\/|image\/svg)/.test(asset.type)) content = await asset.module.instance.transformAsset?.(asset.relative, content.toString('utf8'), requestConfig) ?? content;
        respond(200, asset.type, content); return;
      }
      let content = await readFile(path.join(publicDir, entry[0]), 'utf8');
      if (entry[0] === 'setup.html') content = content.replaceAll('{{platformUrl}}', `${base}/platform`).replaceAll('{{rootName}}', certRootName);
      respond(200, entry[1], content);
    } catch { console.error('ATB: 请求处理失败，请检查相应模块和服务配置。'); respond(500, 'text/plain', '服务暂时不可用，请检查服务日志。'); }
  };
}
