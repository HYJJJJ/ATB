import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

const blocked = new BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, bits, 'ipv4');

export function normalizeBase(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('接口地址无效');
  let url; try { url = new URL(value.trim()); } catch { throw Error('接口地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isIP(url.hostname.replace(/^\[|\]$/g,'')) || !url.hostname.includes('.')) throw Error('请填写公网 HTTPS 域名地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/, '');
  return url.toString().replace(/\/$/, '');
}

export async function safeRequest(url, options = {}, { lookup = dns.lookup, transport = https.request } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || isIP(target.hostname.replace(/^\[|\]$/g,''))) throw Error('无效地址');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(60000)]);
  signal.throwIfAborted();
  let cancelLookup;
  const interrupted = new Promise((_, reject) => { cancelLookup = () => reject(signal.reason); signal.addEventListener('abort', cancelLookup, { once: true }); });
  let records;
  try { records = await Promise.race([lookup(target.hostname, { all: true, family: 4 }), interrupted]); }
  finally { signal.removeEventListener('abort', cancelLookup); }
  signal.throwIfAborted();
  if (!records.length || records.some(r => isIP(r.address) !== 4 || blocked.check(r.address, 'ipv4'))) throw Error('接口地址不允许指向内网');
  const chosen = { address: records[0].address, family: 4 };
  return new Promise((resolve, reject) => {
    const req = transport(target, {
      method: options.method || 'GET', headers: options.headers, timeout: 20000, signal, agent: false,
      lookup: (_host, opts, callback) => opts?.all ? callback(null, [chosen]) : callback(null, chosen.address, 4),
    }, res => {
      if (options.stream) {
        // No data listener: retain backpressure until the caller reads the body.
        res.on('error', () => {});
        const body = (async function* () {
          let bytes = 0;
          try {
            for await (const chunk of res) {
              signal.throwIfAborted(); bytes += chunk.length;
              if (bytes > 2 * 1024 * 1024) throw Error('响应过大');
              yield chunk;
            }
            signal.throwIfAborted();
          } finally { if (!res.readableEnded) req.destroy(); }
        })();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          headers: new Headers(res.headers), body, cancel: () => req.destroy(),
          json: async () => { const chunks = []; for await (const chunk of body) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8')); },
        });
        return;
      }
      let bytes = 0; const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) req.destroy(Error('响应过大'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      res.on('error', reject);
      res.on('aborted', () => reject(Error('模型响应已中断')));
    });
    req.on('timeout', () => req.destroy(Error('连接超时')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
