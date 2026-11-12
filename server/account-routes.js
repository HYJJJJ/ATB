import { SESSION_COOKIE, sessionToken } from './accounts.js';

function localRequest(req, lanIp) {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1' || address === lanIp;
}
export function createAccountRoutes({ accounts, lanIp }) {
  const attempts = new Map();
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/auth/')) return false;
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); };
    const session = accounts.session(sessionToken(req));
    if (pathname === '/api/auth/session' && ['GET', 'HEAD'].includes(req.method)) {
      reply(200, { user: session?.user || null, needsSetup: !accounts.configured, canSetup: localRequest(req, lanIp) }); return true;
    }
    if (!['/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/account'].includes(pathname)) { reply(404, { error: '接口不存在' }); return true; }
    if (req.method !== 'POST') { reply(405, { error: '请求方法无效' }); return true; }
    if (pathname === '/api/auth/account' && !session) { reply(401, { error: '请先登录 ATB' }); return true; }
    let sameOrigin = false;
    try { const origin = new URL(req.headers.origin); sameOrigin = origin.protocol === 'https:' && origin.host === req.headers.host; } catch {}
    if (!sameOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(403, { error: '请从本机应用页面提交请求' }); return true; }
    if (pathname === '/api/auth/logout') {
      accounts.logout(sessionToken(req));
      await accounts.pending;
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      reply(200, { ok: true }); return true;
    }
    if (pathname === '/api/auth/setup' && !localRequest(req, lanIp)) { reply(403, { error: '请先在运行 FreeCamera 的电脑上创建管理员账户' }); return true; }
    for (const [key, value] of attempts) if (Date.now() - value.time > 60000) attempts.delete(key);
    const key = req.socket.remoteAddress;
    let entry = attempts.get(key);
    if (!entry) { if (attempts.size > 1024) { reply(429, { error: '请求过多，请稍后再试' }); return true; } entry = { count: 0, time: Date.now() }; attempts.set(key, entry); }
    if (++entry.count > 10) { reply(429, { error: '登录尝试过多，请一分钟后重试' }); return true; }
    const chunks = []; let bytes = 0, oversized = false;
    try {
      if (Number(req.headers['content-length']) > 4096) { req.resume(); reply(413, { error: '请求内容过大' }); return true; }
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) { oversized = true; break; } chunks.push(chunk); }
      if (oversized) { reply(413, { error: '请求内容过大' }); return true; }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('请求格式无效');
      const { username, password, currentPassword } = input;
      if (pathname === '/api/auth/setup') await accounts.setup(username, password);
      const loggedIn = pathname === '/api/auth/account' ? await accounts.change(sessionToken(req), currentPassword, username, password) : await accounts.login(username, password);
      if (!loggedIn) { reply(401, { error: '账号或密码不正确' }); return true; }
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${loggedIn.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(accounts.sessionMs / 1000)}`);
      reply(200, { user: loggedIn.user });
    } catch (error) { reply(400, { error: error instanceof SyntaxError ? '请求格式无效' : error.message }); }
    return true;
  };
}
