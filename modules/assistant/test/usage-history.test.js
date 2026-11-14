import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BalanceHistory } from '../server/usage-history.js';
const settings={baseUrl:'https://api.deepseek.com/v1',apiKey:'private-fixture-key'};
test('persisted observations estimate only balance decreases, exclude topups, and identify incomplete coverage',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'atb-usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'history.json');let at=Date.parse('2026-11-13T10:00:00Z');
 const history=await BalanceHistory.load(file,{now:()=>at});
 const observe=(amount,config=settings)=>history.observe(config,{kind:'balance',scope:'account',amounts:[{currency:'CNY',amount}],checkedAt:new Date(at).toISOString()});
 assert.equal((await observe('10.00')).kind,'collecting');at+=3600000;
 let value=await observe('9.20');assert.equal(value.kind,'estimate');assert.equal(value.amount,'0.80');assert.equal(value.observedSeconds,3600);assert.equal(value.scope,'account');
 at+=3600000;value=await observe('19.20');assert.equal(value.amount,'0.80','topups are not expenses');at+=3600000;value=await observe('18.70');assert.equal(value.amount,'1.30');
 const contents=await readFile(file,'utf8');assert.doesNotMatch(contents,/private-fixture-key|deepseek/);
 const restored=await BalanceHistory.load(file,{now:()=>at});assert.equal((await restored.observe(settings,{kind:'balance',scope:'account',amounts:[{currency:'CNY',amount:'18.70'}],checkedAt:new Date(at).toISOString()})).amount,'1.30');
 assert.equal((await observe('100.00',{...settings,apiKey:'other-key'})).kind,'collecting','new API key does not inherit old consumption');
 assert.equal(await history.observe(settings,{kind:'quota',available:123}),null);
 assert.equal(await history.observe(settings,{kind:'balance',available:'12.00'}),null,'unknown currency is never converted');
});
test('rolling window excludes old and boundary-straddling decreases, and scope/currency changes start fresh',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'atb-usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));let at=Date.parse('2026-11-13T00:00:00Z');const h=await BalanceHistory.load(path.join(dir,'history.json'),{now:()=>at});
 const save=(amount,scope='account',currency='CNY')=>h.observe(settings,{kind:'balance',scope,amounts:[{currency,amount}],checkedAt:new Date(at).toISOString()});
 await save('10');at+=3600000;await save('9');at+=24*3600000;
 let value=await save('8');assert.equal(value.amount,'1.00');assert.equal(value.observedSeconds,86400);
 at+=3600000;value=await save('7');assert.equal(value.amount,'1.00','cannot attribute a decrease crossing the 24h boundary to this window');
 assert.equal((await save('7','billing')).kind,'collecting');assert.equal((await save('7','billing','USD')).kind,'collecting');
});
