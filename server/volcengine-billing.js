import { createHash, createHmac } from 'node:crypto';
import https from 'node:https';

// QueryBalanceAcct (2022-01-01) and the official volc-sdk-nodejs V4 signer.
// Billing AK/SK are separate from Ark API keys and speech AppID/AccessToken.
const host = 'open.volcengineapi.com';
const query = 'Action=QueryBalanceAcct&Version=2022-01-01';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const decimal = value => typeof value === 'string' && /^-?\d{1,16}(?:\.\d{1,10})?$/.test(value);

export function billingPatch(patch = {}, saved = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('账务配置无效');
  if ('clearCredentials' in patch && typeof patch.clearCredentials !== 'boolean') throw Error('清除凭据选项无效');
  if (patch.clearCredentials) return {};
  const fields = ['accessKeyId', 'secretAccessKey'];
  for (const field of fields) if (field in patch && (typeof patch[field] !== 'string' || patch[field].length > 256 || patch[field] && !/^[!-~]+$/.test(patch[field]))) throw Error('账务 AK/SK 无效，请检查空格和长度');
  const changed = fields.some(field => Boolean(patch[field]));
  if (changed && !fields.every(field => Boolean(patch[field]))) throw Error('更换账务凭据时请同时填写 Access Key ID 和 Secret Access Key');
  return changed ? Object.fromEntries(fields.map(field => [field, patch[field]])) : Object.fromEntries(fields.filter(field => saved[field]).map(field => [field, saved[field]]));
}
export function visibleBilling(saved = {}) { return { configured: Boolean(saved.accessKeyId && saved.secretAccessKey) }; }

export function signBalanceRequest(credentials, now = new Date()) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const scope = `${date.slice(0, 8)}/cn-north-1/billing/request`;
  const signedHeaders = 'host;x-date';
  const canonical = ['GET', '/', query, `host:${host}\nx-date:${date}\n`, signedHeaders, sha256('')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(credentials.secretAccessKey, date.slice(0, 8)), 'cn-north-1'), 'billing'), 'request');
  const signature = hmac(signingKey, ['HMAC-SHA256', date, scope, sha256(canonical)].join('\n')).toString('hex');
  return { url: `https://${host}/?${query}`, headers: { Host: host, 'X-Date': date,
    Authorization: `HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}

function requestBalance({ url, headers }) {
  // Fixed official HTTPS origin; never follow redirects or accept a user URL.
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, signal: AbortSignal.timeout(6500) }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(Error('账务请求失败')); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 128 * 1024) req.destroy(Error('账务响应过大')); else chunks.push(chunk); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('账务响应无效')); } });
      res.on('error', reject); res.on('aborted', () => reject(Error('账务响应已中断')));
    });
    req.on('error', reject);
  });
}

export function createVolcengineBalanceReader(request = requestBalance) {
  let cachedKey, cached, expires = 0, pending;
  return async (settings = {}, { force = false } = {}) => {
    if (!visibleBilling(settings).configured) return { kind: 'unconfigured' };
    const key = sha256(settings.accessKeyId + '\0' + settings.secretAccessKey);
    if (!force && key === cachedKey && Date.now() < expires) return cached;
    if (pending?.key === key) return pending.task;
    const task = (async () => {
      let result;
      try {
        const body = await request(signBalanceRequest(settings));
        if (body?.ResponseMetadata?.Error) {
          const code = String(body.ResponseMetadata.Error.Code || '');
          result = { kind: 'unavailable', reason: /AccessDenied|Unauthorized|Auth|Signature|Credential|InvalidAccessKey/i.test(code) ? 'permission' : 'upstream' };
        } else if (decimal(body?.Result?.AvailableBalance)) {
          // Preserve the official decimal; no quota conversion, arithmetic or
          // inferred currency. AvailableBalance and CashBalance are different.
          result = { kind: 'balance', scope: 'account', available: body.Result.AvailableBalance,
            ...(decimal(body.Result.CashBalance) ? { cash: body.Result.CashBalance } : {}) };
        } else result = { kind: 'unavailable', reason: 'response' };
      } catch { result = { kind: 'unavailable', reason: 'request' }; }
      const value = { ...result, checkedAt: new Date().toISOString() };
      if (pending?.key === key) { cachedKey = key; cached = value; expires = Date.now() + 60000; }
      return value;
    })();
    pending = { key, task };
    try { return await task; } finally { if (pending?.task === task) pending = null; }
  };
}
