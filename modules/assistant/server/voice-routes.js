import { sessionToken } from '../../../server/accounts.js';

export function createVoiceRoutes({ accounts, runtime }) {
  const prefix = '/api/assistant/voice/';
  const actions = new Set(['status', 'settings', 'open', 'heartbeat', 'transcribe', 'speak', 'close']);
  const revoked = owner => { void runtime.close(owner); };
  accounts.on?.('revoked', revoked);
  const routes = async (req, res, pathname) => {
    if (!pathname.startsWith(prefix)) return false;
    const reply = (status, value) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const token = sessionToken(req);
    if (accounts.session(token)?.user.role !== 'admin') { reply(401, { error: '请先登录管理员账号' }); return true; }
    const owner = accounts.sessionId?.(token) || token;
    const action = pathname.slice(prefix.length);
    if (!actions.has(action)) { reply(404, { error: '语音接口不存在' }); return true; }
    if (action === 'status' && req.method === 'GET') { reply(200, await runtime.status()); return true; }
    if (req.method !== 'POST' || action === 'status') { reply(405, { error: '请求方法无效' }); return true; }
    let validOrigin = false;
    try { const origin = new URL(req.headers.origin); validOrigin = origin.protocol === 'https:' && origin.host === req.headers.host; } catch {}
    if (!validOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(403, { error: '请求来源无效' }); return true; }
    let onClose;
    try {
      const chunks = []; let length = 0;
      const limit = action === 'transcribe' ? 1300000 : 24000;
      if (Number(req.headers['content-length']) > limit) { reply(413, { error: '语音请求过长' }); req.resume(); return true; }
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > limit) { reply(413, { error: '语音请求过长' }); req.resume(); return true; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: '请求格式无效' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(400, { error: '请求格式无效' }); return true; }
      if (['close', 'heartbeat', 'transcribe', 'speak'].includes(action) && (typeof body.leaseId !== 'string' || !body.leaseId)) { reply(400, { error: '语音连接无效' }); return true; }
      let requestLease = body.leaseId;
      if (['open', 'transcribe', 'speak'].includes(action)) {
        onClose = () => { if (!res.writableEnded && requestLease) void runtime.close(owner, requestLease); };
        res.once('close', onClose);
      }
      const result = action === 'settings' ? await runtime.configure(body) : action === 'open' ? await runtime.open(owner, body) : action === 'close' ? await runtime.close(owner, body.leaseId) : await runtime[action](owner, body);
      if (action === 'open') requestLease = result.leaseId;
      if (res.destroyed) { if (requestLease) await runtime.close(owner, requestLease); return true; }
      if (!accounts.session(token)) { await runtime.close(owner); reply(401, { error: '登录已过期' }); return true; }
      reply(200, result || { ok: true });
    } catch (error) { reply(400, { error: error.message || '语音操作失败，请重试' }); }
    finally { if (onClose) res.off('close', onClose); }
    return true;
  };
  routes.close = () => { accounts.off?.('revoked', revoked); return runtime.dispose(); };
  return routes;
}
