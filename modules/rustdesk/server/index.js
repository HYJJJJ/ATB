import net from 'node:net';
import { sessionToken } from '../../../server/accounts.js';

function publicConfiguration(shared) {
  const server = shared?.get('server') || {};
  const rustdesk = server.rustdesk || {};
  const candidate = typeof server.publicHost === 'string' ? server.publicHost.trim() : '';
  const host = net.isIP(candidate) || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate) ? candidate : '';
  const port = value => Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
  const idPort = port(rustdesk.idPort), relayPort = port(rustdesk.relayPort), natTestPort = port(rustdesk.natPort);
  const publicKey = typeof rustdesk.publicKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(rustdesk.publicKey.trim()) ? rustdesk.publicKey.trim() : '';
  const authority = net.isIP(host) === 6 ? `[${host}]` : host;
  return {
    ready: Boolean(host && idPort && relayPort && publicKey), publicHost: host,
    idServer: host && idPort ? `${authority}:${idPort}` : '', relayServer: host && relayPort ? `${authority}:${relayPort}` : '', publicKey,
    idPort, relayPort, natTestPort, clientNatTestPort: idPort > 1 ? idPort - 1 : null,
    natMappingCompatible: Boolean(idPort > 1 && natTestPort === idPort - 1),
    deployedVersion: typeof rustdesk.deployedVersion === 'string' && /^[a-zA-Z0-9.+_-]{1,40}$/.test(rustdesk.deployedVersion) ? rustdesk.deployedVersion : '',
    clientDownloadUrl: 'https://github.com/rustdesk/rustdesk/releases/latest',
    configurationMethod: 'manual',
    limitations: ['标准客户端 NAT 检测端口固定为 ID 服务端口减 1；非连续公网映射可能使 NAT 检测失败。', '两台设备均须在官方 RustDesk 客户端填写相同服务器和公钥。', '永久访问密码只在被控设备的官方客户端内设置。']
  };
}

export default async function createModule({ accounts, shared }) {
  const sockets = new Set(); let closed = false, cached = null, pending = null;
  function probe(host, port, service) {
    return new Promise(resolve => {
      if (closed || !port) { resolve({ service, port, protocol: 'tcp', reachable: false }); return; }
      const socket = net.createConnection({ host, port }); sockets.add(socket);
      let finished = false;
      const finish = reachable => { if (finished) return; finished = true; sockets.delete(socket); socket.destroy(); resolve({ service, port, protocol: 'tcp', reachable }); };
      socket.setTimeout(1800); socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(false)); socket.once('error', () => finish(false)); socket.once('close', () => finish(false));
    });
  }
  async function status(configuration) {
    const fingerprint = JSON.stringify(configuration);
    if (cached?.fingerprint === fingerprint && Date.now() - cached.time < 10000) return cached.value;
    if (pending?.fingerprint === fingerprint) return pending.promise;
    const promise = (async () => {
      const checks = configuration.ready ? await Promise.all([
        probe(configuration.publicHost, configuration.idPort, 'id'), probe(configuration.publicHost, configuration.relayPort, 'relay'), probe(configuration.publicHost, configuration.natTestPort, 'nat-test')
      ]) : [];
      const value = { state: !configuration.ready ? 'unconfigured' : checks.every(check => check.reachable) ? 'reachable' : 'unreachable', checkedAt: new Date().toISOString(), vantage: 'atb-server', checks, remoteSessionVerified: false, udpVerified: false, natMappingCompatible: configuration.natMappingCompatible, note: '仅从 ATB 服务器探测公网端口的 TCP 连接；不验证 UDP、客户端注册、密钥握手或真实远控。服务器可能不支持公网回环，请同时在外部设备验证。' };
      cached = { fingerprint, time: Date.now(), value }; return value;
    })();
    pending = { fingerprint, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
  }
  return {
    async handle(req, res, pathname) {
      if (!pathname.startsWith('/api/rustdesk/')) return false;
      const reply = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
      const session = accounts.session(sessionToken(req));
      if (!session) { reply(401, { error: '请先登录 ATB 平台' }); return true; }
      if (!['GET', 'HEAD'].includes(req.method)) {
        let sameOrigin = false;
        try { const origin = new URL(req.headers.origin); sameOrigin = origin.protocol === (req.socket.encrypted ? 'https:' : 'http:') && origin.host === req.headers.host; } catch {}
        if (!sameOrigin || session.user?.role !== 'admin') { reply(403, { error: '需要管理员从本平台页面提交请求' }); return true; }
        if (req.method !== 'POST' || pathname !== '/api/rustdesk/config') { reply(405, { error: '请求方法无效' }, { Allow: pathname === '/api/rustdesk/config' ? 'GET, HEAD, POST' : 'GET, HEAD' }); return true; }
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(400, { error: '请提交 JSON 配置' }); return true; }
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) { reply(413, { error: '配置内容过大' }); return true; } }
          const input = JSON.parse(body);
          if (!input || Array.isArray(input) || Object.keys(input).some(name => !['idPort', 'relayPort', 'natPort', 'publicKey'].includes(name))) throw Error('仅允许修改 RustDesk 端口与公钥');
          for (const name of ['idPort', 'relayPort', 'natPort']) if (!Number.isInteger(input[name]) || input[name] < 1 || input[name] > 65535) throw Error('端口必须为 1 至 65535 的整数');
          if (typeof input.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey.trim())) throw Error('请填写有效的 RustDesk 服务器公钥');
          await shared.update('server', previous => ({ ...previous, rustdesk: { ...previous?.rustdesk, idPort: input.idPort, relayPort: input.relayPort, natPort: input.natPort, publicKey: input.publicKey.trim() } }));
          cached = null; reply(200, publicConfiguration(shared));
        } catch (error) { reply(400, { error: error instanceof SyntaxError ? '配置 JSON 格式无效' : error.message }); }
        return true;
      }
      if (!['/api/rustdesk/config', '/api/rustdesk/export', '/api/rustdesk/status'].includes(pathname)) { reply(404, { error: '接口不存在' }); return true; }
      const configuration = publicConfiguration(shared);
      if (pathname.endsWith('/status')) reply(200, await status(configuration));
      else if (pathname.endsWith('/export')) reply(200, { format: 'atb-rustdesk-public-config-v1', exportedAt: new Date().toISOString(), configuration, instructions: '此 JSON 用于保存和分享公开连接字段，不是 RustDesk 原生导入文件。请手动填写 ID 服务器、中继服务器、Key。' }, { 'Content-Disposition': 'attachment; filename="rustdesk-public-config.json"' });
      else reply(200, configuration);
      return true;
    },
    close() { closed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); cached = null; }
  };
}
