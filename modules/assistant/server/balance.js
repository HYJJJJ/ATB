import { createHash } from 'node:crypto';

const finiteAmount = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
// Only documented schemas are interpreted. A relay's *_usd fields can actually
// be CNY or tokens: use its public display metadata, never guess from field names.
export function createBalanceReader(request) {
  let cachedKey, cached, expires = 0, pending, pendingKey;
  return async function read(settings, { force = false } = {}) {
    if (!settings.baseUrl || !settings.apiKey) return { kind: 'unconfigured' };
    const key = createHash('sha256').update(settings.baseUrl + '\0' + settings.apiKey).digest('hex');
    if (!force && key === cachedKey && Date.now() < expires) return cached;
    if (pending && key === pendingKey) return pending;
    pendingKey = key;
    const task = (async () => {
      const deadline = AbortSignal.timeout(6500), base = new URL(settings.baseUrl);
      const get = async (pathname, authenticated = true) => {
        try {
          const url = new URL(pathname, base.origin);
          const response = await request(url.href, { signal: deadline, headers: { Accept: 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + settings.apiKey } : {}) } });
          if (!response.ok) { response.cancel?.(); return { status: response.status, rejected: [401,403,429].includes(response.status) }; }
          return { body: await response.json() };
        } catch { return { unavailable: true }; }
      };
      let result;
      if (['api.openai.com','dashscope.aliyuncs.com','api.siliconflow.cn','ark.cn-beijing.volces.com'].includes(base.hostname)) return {kind:'unsupported',checkedAt:new Date().toISOString()};
      if (base.hostname === 'api.deepseek.com') {
        const response = await get('/user/balance'), body = response.body;
        result = body?.balance_infos?.length > 0 && body.balance_infos.length <= 10 && body.balance_infos.every(item => /^[A-Z]{3}$/.test(item.currency) && /^-?\d{1,16}(?:\.\d{1,10})?$/.test(String(item.total_balance)))
          ? { kind: 'balance', scope: 'account', amounts: body.balance_infos.map(item => ({ currency: item.currency, amount: String(item.total_balance) })) }
          : { kind: response.rejected || response.unavailable ? 'unavailable' : 'unsupported' };
      } else {
        let [usage, metadata] = await Promise.all([get('/api/usage/token'), get('/api/status', false)]);
        // New API registers a trailing slash on this route. Retry only this fixed
        // same-origin spelling, never follow an upstream Location with a key.
        if ([301,302,307,308,404].includes(usage.status)) usage = await get('/api/usage/token/');
        const body = usage.body, token = body?.code === true && body.data?.object === 'token_usage' ? body.data : null;
        const status = metadata.body?.success === true ? metadata.body.data : null;
        const type = status?.quota_display_type || (status?.display_in_currency === true ? 'USD' : '');
        const currency = ['USD','CNY'].includes(type) ? type : null;
        const quotaPerUnit = status?.quota_per_unit;
        const multiplier = currency === 'CNY' ? status?.usd_exchange_rate : 1;
        const money = (value, scope) => ({ kind: 'balance', scope, amounts: [{ currency, amount: value.toFixed(2) }] });
        if (currency && finiteAmount(token?.user_quota?.total_available) && finiteAmount(quotaPerUnit) && quotaPerUnit > 0 && finiteAmount(multiplier) && multiplier > 0) {
          result = money(token.user_quota.total_available / quotaPerUnit * multiplier, 'account');
        } else if (status && currency) {
          // New API's billing endpoint may use account or token statistics according
          // to site configuration. Label it billing scope, not account cash.
          const prefix = base.pathname.replace(/\/+$/, '').replace(/\/(?:v1|beta)$/, '');
          const [subscription, spent] = await Promise.all([get(prefix + '/v1/dashboard/billing/subscription'), get(prefix + '/v1/dashboard/billing/usage')]);
          const total = subscription.body, used = spent.body;
          // This documented unlimited-token placeholder is never money, even if
          // the token endpoint failed and its unlimited flag is unavailable.
          if (total?.object === 'billing_subscription' && finiteAmount(total.hard_limit_usd) && total.hard_limit_usd !== 100000000 && used?.object === 'list' && finiteAmount(used.total_usage) && used.total_usage >= 0) {
            result = money(total.hard_limit_usd - used.total_usage / 100, 'billing');
          }
        }
        if (!result && token && (token.unlimited_quota === true || finiteAmount(token.total_available))) {
          // Preserve truthful raw quota if the host exposes no safe monetary schema.
          // New API GetTokenUsage exposes user_quota only with AllowUserQuotaQuery.
          // A token spending limit (including unlimited) cannot fill the balance box.
          result = { kind: 'quota', scope: 'token', unlimited: token.unlimited_quota === true, accountBalanceUnavailable: true, reason: finiteAmount(token.user_quota?.total_available) ? 'currency-unavailable' : 'account-quota-not-exposed', ...(finiteAmount(token.total_available) ? { available: token.total_available } : {}) };
        }
        result ||= { kind: usage.rejected || usage.unavailable ? 'unavailable' : 'unsupported' };
      }
      const value = { ...result, checkedAt: new Date().toISOString() };
      if (pendingKey === key) { cachedKey = key; cached = value; expires = Date.now() + 60000; }
      return value;
    })();
    pending = task;
    try { return await task; } finally { if (pending === task) { pending = null; pendingKey = null; } }
  };
}
