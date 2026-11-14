import test from 'node:test';
import assert from 'node:assert/strict';
import { billingPatch, visibleBilling, signBalanceRequest, createVolcengineBalanceReader } from '../server/volcengine-billing.js';

test('billing credentials are paired, retained on empty input, explicitly cleared and never returned', () => {
  const saved = billingPatch({ accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-sk' });
  assert.deepEqual(visibleBilling(saved), { configured: true });
  assert.deepEqual(billingPatch({ accessKeyId: '', secretAccessKey: '' }, saved), saved);
  assert.throws(() => billingPatch({ accessKeyId: 'different-ak' }, saved), /同时填写/);
  assert.throws(() => billingPatch({ secretAccessKey: 'different-sk' }, saved), /同时填写/);
  assert.throws(() => billingPatch({ accessKeyId: 'bad\r\nkey', secretAccessKey: 'test' }), /无效/);
  assert.deepEqual(billingPatch({ clearCredentials: true }, saved), {});
});

test('QueryBalanceAcct signs a fixed official origin with the billing service and no TTS bearer key', () => {
  const result = signBalanceRequest({ accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-sk' }, new Date('2026-11-13T02:03:04Z'));
  assert.equal(result.url, 'https://open.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01');
  assert.equal(result.headers['X-Date'], '20261113T020304Z');
  assert.match(result.headers.Authorization, /^HMAC-SHA256 Credential=fixture-ak\/20261113\/cn-north-1\/billing\/request, SignedHeaders=host;x-date, Signature=[a-f0-9]{64}$/);
  // Cross-checked against volcengine/volc-sdk-nodejs src/base/sign.ts,
  // using this fixed date and synthetic AK/SK (2026-11-13).
  assert.ok(result.headers.Authorization.endsWith('Signature=df7b946c2347e17c3fbfef49f2f208030d89fabb7e34fa79eed5b6abf97369e0'));
  assert.ok(!JSON.stringify(result).includes('fixture-sk'));
});

test('billing reader uses AvailableBalance unchanged, keeps cash separate, caches and invalidates by credentials', async () => {
  const calls = [], reader = createVolcengineBalanceReader(async options => {
    calls.push(options);
    return { Result: { AvailableBalance: '77.0100', CashBalance: '83.01', FreezeAmount: '5.01' } };
  });
  assert.deepEqual(await reader({}), { kind: 'unconfigured' });
  assert.equal(calls.length, 0);
  const settings = { accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-sk' };
  const result = await reader(settings);
  assert.equal(result.kind, 'balance'); assert.equal(result.available, '77.0100'); assert.equal(result.cash, '83.01');
  assert.equal('amounts' in result, false, 'no guessed currency or exchange conversion');
  await reader(settings); assert.equal(calls.length, 1);
  await reader(settings, { force: true }); assert.equal(calls.length, 2);
  await reader({ ...settings, secretAccessKey: 'rotated-sk' }); assert.equal(calls.length, 3);
});

test('billing rejects malformed money and sanitizes authentication and transport errors', async () => {
  const settings = { accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-sk' };
  for (const value of [null, '', 'NaN', 'Infinity', '1e8', '123 CNY', {}, 123]) {
    const result = await createVolcengineBalanceReader(async () => ({ Result: { AvailableBalance: value } }))(settings);
    assert.equal(result.kind, 'unavailable'); assert.ok(!('available' in result));
  }
  const denied = await createVolcengineBalanceReader(async () => ({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'fixture-sk must never escape' } } }))(settings);
  assert.equal(denied.kind, 'unavailable'); assert.equal(denied.reason, 'permission');
  const failed = await createVolcengineBalanceReader(async () => { throw Error('fixture-sk'); })(settings);
  assert.equal(failed.kind, 'unavailable'); assert.ok(!JSON.stringify(failed).includes('fixture-sk'));
});
