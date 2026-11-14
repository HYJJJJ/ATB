import { sessionToken } from './accounts.js';
import { isIP } from 'node:net';
import { AiError, aiPatch, visibleAi, probeAi } from './ai-settings.js';
import { billingPatch, visibleBilling, createVolcengineBalanceReader } from './volcengine-billing.js';

export function visibleServer(value = {}) {
  return { label: typeof value.label === 'string' ? value.label : '', publicHost: typeof value.publicHost === 'string' ? value.publicHost : '' };
}
export function createPlatformRoutes({ accounts, shared, modules, platform, request, billingRequest }) {
  const active = new Set();
  const readVolcBalance = createVolcengineBalanceReader(billingRequest);
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/platform/')) return false;
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); };
    if (!accounts.session(sessionToken(req))) { reply(401, { error: '请先登录 ATB' }); return true; }
    if (pathname === '/api/platform/modules' && ['GET', 'HEAD'].includes(req.method)) { reply(200, { platform, modules: modules.list(), errors: modules.errors }); return true; }
    const isBilling = pathname === '/api/platform/billing/volcengine';
    if (pathname === '/api/platform/billing/volcengine/balance' && ['GET', 'HEAD'].includes(req.method)) {
      if (req.method === 'HEAD') { reply(200, {}); return true; }
      const token = sessionToken(req), result = await readVolcBalance(shared.get('billing')?.volcengine, { force: new URL(req.url, 'https://localhost').searchParams.get('refresh') === '1' });
      if (!accounts.session(token)) reply(401, { error: '登录已过期，请重新登录' });
      else reply(200, result);
      return true;
    }
    if (isBilling && ['GET', 'HEAD'].includes(req.method)) { reply(200, visibleBilling(shared.get('billing')?.volcengine)); return true; }
    const isAi = ['/api/platform/ai', '/api/platform/ai/models', '/api/platform/ai/test'].includes(pathname);
    if (pathname !== '/api/platform/settings' && !isAi && !isBilling) { reply(404, { error: '接口不存在' }); return true; }
    if (['GET', 'HEAD'].includes(req.method) && ['/api/platform/settings', '/api/platform/ai'].includes(pathname)) { reply(200, isAi ? visibleAi(shared.get('ai')) : { server: visibleServer(shared.get('server')), billing: { volcengine: visibleBilling(shared.get('billing')?.volcengine) } }); return true; }
    if (req.method !== 'POST') { reply(405, { error: '请求方法无效' }); return true; }
    try {
      let validOrigin = false;
      try { const origin = new URL(req.headers.origin); validOrigin = origin.protocol === 'https:' && origin.host === req.headers.host; } catch {}
      if (!validOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(403, { error: '请求来源无效' }); return true; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 150000) { reply(413, { error: '配置内容过长' }); return true; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AiError('配置格式无效');
      if (isBilling) {
        const value = await shared.update('billing', old => ({ ...old, volcengine: billingPatch(body, old?.volcengine) }));
        reply(200, visibleBilling(value.volcengine)); return true;
      }
      if (isAi) {
        if (pathname === '/api/platform/ai') { const ai = await shared.update('ai', current => aiPatch(body, current)); reply(200, visibleAi(ai)); return true; }
        const token = sessionToken(req), key = `${token}:${pathname}`;
        if (active.has(key)) throw new AiError('上一条请求仍在处理中，请稍后再试', 429);
        const controller = new AbortController(), close = () => { if (!res.writableEnded) controller.abort(); };
        active.add(key); res.once('close', close);
        try {
          const result = await probeAi(aiPatch(body, shared.get('ai')), { models: pathname.endsWith('/models'), request, signal: controller.signal });
          if (!accounts.session(token)) throw new AiError('登录已过期，请重新登录', 401);
          reply(200, result);
        } finally { active.delete(key); res.off('close', close); }
        return true;
      }
      const { server: input } = body;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置格式无效');
      const { label = '', publicHost = '' } = input;
      if (typeof label !== 'string' || label.length > 80 || typeof publicHost !== 'string' || publicHost.length > 253 || publicHost && !isIP(publicHost) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(publicHost) || /[\s/@:?#]/.test(publicHost) && !isIP(publicHost)) throw Error('填写服务器 IP 或域名，不包含协议、端口和路径');
      const server = await shared.update('server', old => ({ ...old, label: label.trim(), publicHost: publicHost.trim() }));
      reply(200, { server: visibleServer(server) });
    } catch (error) { reply(error instanceof AiError ? error.status : error instanceof SyntaxError ? 400 : isAi ? 502 : 400, { error: error instanceof AiError ? error.message : error instanceof SyntaxError ? '请求格式无效' : isAi ? '连接模型服务失败或超时，请检查网络和接口设置。' : error.message }); }
    return true;
  };
}
