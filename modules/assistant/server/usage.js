import { createHash } from 'node:crypto';

const officialWithoutKeyUsage = new Set(['api.deepseek.com','api.openai.com','dashscope.aliyuncs.com','api.siliconflow.cn','ark.cn-beijing.volces.com']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
// New API's read-only token log is a capped recent list, not an account bill.
// Never request account/admin logs or put the model credential in a URL.
export function createUsageReader(request, { now = Date.now } = {}) {
  let cachedKey, cached, expires = 0, pending;
  return async function read(settings = {}, { force = false } = {}) {
    if (!settings.baseUrl || !settings.apiKey) return { kind:'unconfigured' };
    const base = new URL(settings.baseUrl);
    if (officialWithoutKeyUsage.has(base.hostname)) return { kind:'unsupported' };
    const key = createHash('sha256').update(settings.baseUrl+'\0'+settings.apiKey).digest('hex');
    if (!force && cachedKey === key && now() < expires) return cached;
    if (pending?.key === key) return pending.task;
    const task = (async () => {
      const at = now(), end = Math.floor(at/1000), start = end-86400, signal = AbortSignal.timeout(6500);
      const get = async (pathname, authenticated = true) => {
        const response = await request(new URL(pathname,base.origin).href, { signal, headers:{ Accept:'application/json', ...(authenticated?{Authorization:'Bearer '+settings.apiKey}:{}) } });
        if (!response.ok) { response.cancel?.(); return { status:response.status }; }
        return { body:await response.json() };
      };
      let result;
      try {
        let [usage,metadata] = await Promise.all([get('/api/usage/token'),get('/api/status',false)]);
        if ([301,302,307,308,404].includes(usage.status)) usage = await get('/api/usage/token/');
        const token = usage.body?.code === true && usage.body.data?.object === 'token_usage';
        const status = metadata.body?.success === true ? metadata.body.data : null;
        const currency = status?.quota_display_type || (status?.display_in_currency === true ? 'USD' : '');
        const unit = status?.quota_per_unit, multiplier = currency === 'CNY' ? status?.usd_exchange_rate : 1;
        if (!token || !['CNY','USD'].includes(currency) || !finite(unit) || unit <= 0 || !finite(multiplier) || multiplier <= 0) {
          result = { kind:[401,403,429].includes(usage.status)?'unavailable':'unsupported' };
        } else {
          const logs = await get('/api/log/token'), items = logs.body?.success === true ? logs.body.data : null;
          if (!Array.isArray(items) || items.length > 10000) result = { kind:logs.status && ![404,405].includes(logs.status)?'unavailable':'unsupported' };
          else {
            let quota = 0n, records = 0, refunds = 0, oldest = end;
            const seen = new Map();
            for (const item of items) {
              if (!item || !Number.isSafeInteger(item.created_at) || item.created_at < 0 || !Number.isSafeInteger(item.type)) throw Error('invalid log');
              oldest = Math.min(oldest,item.created_at);
              if (item.created_at < start || item.created_at > end || ![2,6].includes(item.type)) continue;
              if (!Number.isSafeInteger(item.quota) || item.quota < 0) throw Error('invalid quota');
              if (item.id !== undefined) {
                if (!Number.isSafeInteger(item.id)) throw Error('invalid log ID');
                const signature = [item.type,item.created_at,item.quota].join(':');
                if (seen.has(item.id)) { if (seen.get(item.id) !== signature) throw Error('conflicting log'); continue; }
                seen.set(item.id,signature);
              }
              quota += BigInt(item.quota) * (item.type === 6 ? -1n : 1n); records++; if (item.type === 6) refunds++;
            }
            const amount = Number(quota)/unit*multiplier;
            if (!finite(amount)) throw Error('invalid total');
            result = records ? {
              kind:'usage',scope:'key',currency,amount:amount.toFixed(2),records,refunds,
              coverage:oldest <= start ? 'window' : 'recent-records',
            } : { kind:'no-records',scope:'key' };
          }
        }
      } catch { result = { kind:'unavailable' }; }
      const value = { ...result,periodStart:new Date(start*1000).toISOString(),periodEnd:new Date(end*1000).toISOString(),checkedAt:new Date(at).toISOString() };
      if (pending?.key === key) { cachedKey = key; cached = value; expires = now()+60000; }
      return value;
    })();
    pending = { key,task };
    try { return await task; } finally { if (pending?.task === task) pending = null; }
  };
}
