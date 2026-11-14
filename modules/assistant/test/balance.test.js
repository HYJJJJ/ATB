import test from 'node:test';
import assert from 'node:assert/strict';
import { createBalanceReader } from '../server/balance.js';

test('official presets without a supported balance API do not receive guessed relay requests', async () => {
  let calls = 0;
  const read = createBalanceReader(async () => { calls++; throw Error('unexpected'); });
  for (const host of ['api.openai.com/v1','dashscope.aliyuncs.com/compatible-mode/v1','api.siliconflow.cn/v1','ark.cn-beijing.volces.com/api/v3']) {
    assert.equal((await read({baseUrl:'https://' + host, apiKey:'test'})).kind,'unsupported');
  }
  assert.equal(calls,0);
});

test('official account balance uses the saved server credential and caches reads', async () => {
  const calls = [], read = createBalanceReader(async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }) }; });
  const settings = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-only' };
  const result = await read(settings);
  assert.equal(result.kind, 'balance'); assert.deepEqual(result.amounts, [{ currency: 'CNY', amount: '12.34' }]);
  assert.equal(calls[0][0], 'https://api.deepseek.com/user/balance'); assert.equal(calls[0][1].headers.Authorization, 'Bearer test-only');
  await read(settings); assert.equal(calls.length, 1); assert.equal(JSON.stringify(result).includes('test-only'), false);
  await read({ ...settings, apiKey: 'other-test' }); assert.equal(calls.length, 2);
});
test('third party token quota is labelled separately and never converted to cash', async () => {
  const read = createBalanceReader(async () => ({ ok: true, json: async () => ({ code: true, data: { object: 'token_usage', total_available: 10000, unlimited_quota: false } }) }));
  const result = await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.equal(result.kind, 'quota'); assert.equal(result.available, 10000); assert.equal(result.currency, undefined);
});
test('missing keys, unsupported schemas, upstream rejection and failures produce honest states', async () => {
  for (const response of [{ ok: false, status: 404 }, { ok: true, json: async () => ({ balance: '999', secret: 'must-not-display' }) }]) {
    const read = createBalanceReader(async () => response);
    assert.equal((await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' })).kind, 'unsupported');
  }
  const read = createBalanceReader(async () => { throw Error('private credential must not leak'); });
  assert.equal((await read({})).kind, 'unconfigured');
  assert.equal((await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' })).kind, 'unavailable');
});


test('New API billing reports remaining money in the published site currency, not raw token quota', async () => {
  const calls = [];
  const read = createBalanceReader(async (url, options) => {
    const pathname = new URL(url).pathname; calls.push([pathname, options.headers]);
    const bodies = {
      '/api/usage/token': { code: true, data: { object: 'token_usage', total_available: 500000, unlimited_quota: true } },
      '/api/status': { success: true, data: { quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7 } },
      '/v1/dashboard/billing/subscription': { object: 'billing_subscription', hard_limit_usd: 70 },
      '/v1/dashboard/billing/usage': { object: 'list', total_usage: 1250 },
    };
    return { ok: !!bodies[pathname], status: bodies[pathname] ? 200 : 404, json: async () => bodies[pathname] };
  });
  const result = await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.equal(result.kind, 'balance'); assert.equal(result.scope, 'billing');
  assert.deepEqual(result.amounts, [{ currency: 'CNY', amount: '57.50' }]);
  assert.equal(calls.find(([p]) => p === '/api/status')[1].Authorization, undefined);
});

test('New API explicit user quota has account scope and verified conversion; absent metadata stays raw', async () => {
  const fixture = async url => ({ ok: true, json: async () => new URL(url).pathname === '/api/status'
    ? { success: true, data: { quota_display_type: 'USD', quota_per_unit: 500000 } }
    : { code: true, data: { object: 'token_usage', unlimited_quota: false, total_available: 300000, user_quota: { total_available: 2250000 } } } });
  const result = await createBalanceReader(fixture)({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.equal(result.scope, 'account'); assert.deepEqual(result.amounts, [{ currency: 'USD', amount: '4.50' }]);
});

test('a manual refresh replaces a cached amount without leaking upstream fields', async () => {
  let amount = '1.00';
  const read = createBalanceReader(async () => ({ ok: true, json: async () => ({ balance_infos: [{ currency: 'USD', total_balance: amount }] }) }));
  const settings = { baseUrl: 'https://api.deepseek.com', apiKey: 'test' };
  assert.equal((await read(settings)).amounts[0].amount, '1.00'); amount = '2.00';
  assert.equal((await read(settings, { force: true })).amounts[0].amount, '2.00');
});

test('unlimited-token billing sentinel must not appear as a huge cash balance', async () => {
  const bodies = {
    '/api/usage/token': { code: true, data: { object: 'token_usage', unlimited_quota: true } },
    '/api/status': { success: true, data: { quota_display_type: 'USD', quota_per_unit: 500000 } },
    '/v1/dashboard/billing/subscription': { object: 'billing_subscription', hard_limit_usd: 100000000 },
    '/v1/dashboard/billing/usage': { object: 'list', total_usage: 40 },
  };
  const result = await createBalanceReader(async url => ({ ok: true, json: async () => bodies[new URL(url).pathname] }))({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.equal(result.kind, 'quota'); assert.equal(result.unlimited, true); assert.equal(result.amounts, undefined);
});

test('a TOKENS display must retain raw units and never query money endpoints', async () => {
  const read = createBalanceReader(async url => {
    const pathname = new URL(url).pathname;
    assert.ok(['/api/usage/token', '/api/status'].includes(pathname));
    return { ok: true, json: async () => pathname === '/api/status'
      ? { success: true, data: { quota_display_type: 'TOKENS', quota_per_unit: 500000 } }
      : { code: true, data: { object: 'token_usage', unlimited_quota: false, total_available: 35000 } } };
  });
  const result = await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.equal(result.kind, 'quota'); assert.equal(result.available, 35000); assert.equal(result.amounts, undefined);
});

test('canonical token path is retried on a slash redirect and unlimited limits are never cash', async () => {
  const calls = [];
  const read = createBalanceReader(async (url, options) => {
    const pathname = new URL(url).pathname; calls.push(pathname);
    if (pathname === '/api/usage/token') return { ok: false, status: 301 };
    const bodies = {
      '/api/usage/token/': { code: true, data: { object: 'token_usage', unlimited_quota: true, total_available: 0 } },
      '/api/status': { success: true, data: { quota_display_type: 'USD', quota_per_unit: 500000 } },
      '/v1/dashboard/billing/subscription': { object: 'billing_subscription', hard_limit_usd: 100000000 },
      '/v1/dashboard/billing/usage': { object: 'list', total_usage: 1234567 },
    };
    assert.ok(bodies[pathname], 'only fixed same-origin paths can receive the saved key');
    return { ok: true, json: async () => bodies[pathname] };
  });
  const result = await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.ok(calls.includes('/api/usage/token/')); assert.equal(result.kind, 'quota');
  assert.equal(result.unlimited, true); assert.equal(result.amounts, undefined);
  assert.equal(result.accountBalanceUnavailable, true);
  assert.equal(result.reason, 'account-quota-not-exposed');
});

test('the same unlimited API key returns account money after user-quota permission is enabled and refreshed', async () => {
  let allowed = false;
  const config = {baseUrl:'https://relay.example/v1',apiKey:'same-model-key'};
  const read = createBalanceReader(async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname !== '/api/status') assert.equal(options.headers.Authorization, 'Bearer same-model-key');
    if (pathname === '/api/status') return {ok:true,json:async()=>({success:true,data:{quota_display_type:'CNY',quota_per_unit:500000,usd_exchange_rate:7}})};
    if (pathname === '/api/usage/token') return {ok:true,json:async()=>({code:true,data:{object:'token_usage',unlimited_quota:true,total_available:0,...(allowed?{user_quota:{total_available:1000000}}:{})}})};
    return {ok:false,status:404};
  });
  assert.equal((await read(config)).reason, 'account-quota-not-exposed');
  allowed = true;
  assert.equal((await read(config)).kind, 'quota', 'ordinary reads retain the short cache');
  const result = await read(config,{force:true});
  assert.equal(result.kind,'balance'); assert.equal(result.scope,'account');
  assert.deepEqual(result.amounts,[{currency:'CNY',amount:'14.00'}]);
  assert.equal(JSON.stringify(result).includes(config.apiKey),false);
});

test('a billing sentinel is rejected even if the token endpoint is unavailable', async () => {
  const read = createBalanceReader(async url => {
    const pathname = new URL(url).pathname;
    if (pathname.startsWith('/api/usage/token')) return { ok: false, status: 503 };
    return { ok: true, json: async () => pathname === '/api/status'
      ? { success: true, data: { quota_display_type: 'USD' } }
      : pathname.endsWith('subscription') ? { object: 'billing_subscription', hard_limit_usd: 100000000 }
        : { object: 'list', total_usage: 1234567 } };
  });
  const result = await read({ baseUrl: 'https://relay.example/v1', apiKey: 'test' });
  assert.notEqual(result.kind, 'balance'); assert.equal(result.amounts, undefined);
});
