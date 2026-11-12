import { sessionToken } from './accounts.js';
import { isIP } from 'node:net';

export function visibleServer(value = {}) {
  return { label: typeof value.label === 'string' ? value.label : '', publicHost: typeof value.publicHost === 'string' ? value.publicHost : '' };
}
export function createPlatformRoutes({ accounts, shared, modules, platform }) {
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/platform/')) return false;
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); };
    if (!accounts.session(sessionToken(req))) { reply(401, { error: '请先登录 ATB' }); return true; }
    if (pathname === '/api/platform/modules' && ['GET', 'HEAD'].includes(req.method)) { reply(200, { platform, modules: modules.list(), errors: modules.errors }); return true; }
    if (pathname !== '/api/platform/settings') { reply(404, { error: '接口不存在' }); return true; }
    if (['GET', 'HEAD'].includes(req.method)) { reply(200, { server: visibleServer(shared.get('server')) }); return true; }
    if (req.method !== 'POST') { reply(405, { error: '请求方法无效' }); return true; }
    try {
      let validOrigin = false;
      try { const origin = new URL(req.headers.origin); validOrigin = origin.protocol === 'https:' && origin.host === req.headers.host; } catch {}
      if (!validOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(403, { error: '请求来源无效' }); return true; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) { reply(413, { error: '配置内容过长' }); return true; } }
      const { server: input } = JSON.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置格式无效');
      const { label = '', publicHost = '' } = input;
      if (typeof label !== 'string' || label.length > 80 || typeof publicHost !== 'string' || publicHost.length > 253 || publicHost && !isIP(publicHost) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(publicHost) || /[\s/@:?#]/.test(publicHost) && !isIP(publicHost)) throw Error('填写服务器 IP 或域名，不包含协议、端口和路径');
      const server = await shared.update('server', old => ({ ...old, label: label.trim(), publicHost: publicHost.trim() }));
      reply(200, { server: visibleServer(server) });
    } catch (error) { reply(400, { error: error instanceof SyntaxError ? '请求格式无效' : error.message }); }
    return true;
  };
}
