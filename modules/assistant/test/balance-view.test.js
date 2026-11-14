import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceView, usageView } from '../public/balance-view.js';

test('cash balance lights use inclusive 5–15 CNY boundaries and accept zero', () => {
  for (const [amount, level] of [['0','low'],['4.99','low'],['5','medium'],['15','medium'],['15.01','high']]) {
    const view = balanceView({kind:'balance', amounts:[{currency:'CNY', amount}]});
    assert.equal(view.level, level); assert.equal(view.text, '¥' + amount);
  }
});

test('usage hints distinguish complete windows, limited results and refunds; unavailable is not zero',()=>{
 const result={kind:'usage',scope:'key',amount:'0.70',currency:'CNY',records:3,coverage:'recent-records'};
 assert.deepEqual(usageView(result),{title:'近24小时已查消费',text:'当前密钥 ¥0.70'});
 assert.equal(usageView({...result,coverage:'window'}).title,'近24小时消费');
 assert.equal(usageView({...result,refunds:1,amount:'-0.10'}).title,'近24小时已查净消费');
 assert.equal(usageView({...result,currency:'USD'}).text,'当前密钥 USD 0.70');
 for(const value of [{kind:'unsupported'},{kind:'no-records'},{...result,amount:'NaN'},{...result,currency:null},{...result,scope:'account'},{...result,records:0}])assert.equal(usageView(value),null);
 const estimate={kind:'estimate',method:'balance-decrease',scope:'account',currency:'CNY',amount:'0.80',observedSeconds:7200};
 assert.deepEqual(usageView(estimate),{title:'近24h余额减少估算',text:'¥0.80 · 已记录2.0小时'});
 assert.equal(usageView({...estimate,kind:'collecting'}).title,'消费统计积累中');
 assert.equal(usageView({...estimate,observedSeconds:4}).text,'¥0.80 · 已记录不足1分钟');
});
test('unknown currency, unsupported balances and raw quotas never acquire a cash light', () => {
  for (const value of [{kind:'balance',available:'77.0100'}, {kind:'quota',available:70000}, {kind:'balance',amounts:[{currency:'USD',amount:'30'}]}, {kind:'balance',amounts:[{currency:'CNY',amount:''}]}, {kind:'balance',amounts:[{currency:'CNY',amount:'NaN'}]}, {kind:'unconfigured'}, {kind:'unavailable'}]) assert.equal(balanceView(value).level, 'unknown');
  assert.equal(balanceView({kind:'quota',unlimited:true}).text, '余额未开放');
  assert.equal(balanceView({kind:'local'}).text,'本地免费');
  assert.equal(balanceView({kind:'local'}).level,'free');
});

test('token spending limits never appear as the account balance; missing permission has an actionable explanation', () => {
  for (const unlimited of [true, false]) {
    const view = balanceView({kind:'quota', unlimited, available:0, reason:'account-quota-not-exposed'});
    assert.equal(view.text, '余额未开放');
    assert.match(view.title, /允许查询用户额度/);
    assert.match(view.title, /高级设置/);
    assert.match(view.title, /刷新/);
    assert.equal(view.level, 'unknown');
  }
  const view = balanceView({kind:'quota', unlimited:true, reason:'currency-unavailable'});
  assert.equal(view.text, '币种未提供');
  assert.doesNotMatch(view.title, /开启/);
});
