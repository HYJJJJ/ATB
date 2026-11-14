import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageReader } from '../server/usage.js';

const at=Date.parse('2026-11-14T06:00:00Z'),second=Math.floor(at/1000);
const settings={baseUrl:'https://relay.example/v1',apiKey:'fixture-secret'};
const log=(id,ago,quota,type=2)=>({id,created_at:second-ago,quota,type,content:'private-log-content',username:'private-name',ip:'private-ip'});
function fixture({logs=[],metadata,respond}={}){
 const calls=[];
 const request=async(url,options)=>{
  calls.push({url,options});const p=new URL(url).pathname;
  const bodies={
   '/api/usage/token':{code:true,data:{object:'token_usage',total_available:1000000}},
   '/api/status':{success:true,data:metadata||{quota_display_type:'CNY',quota_per_unit:500000,usd_exchange_rate:7}},
   '/api/log/token':{success:true,data:logs},
  };
  return respond?.(p)||{ok:true,json:async()=>bodies[p]};
 };
 return {calls,read:createUsageReader(request,{now:()=>at})};
}
test('rolling 24h usage sums current key consumption and refunds, excluding recharge/errors/outside window',async()=>{
 const {read,calls}=fixture({logs:[log(6,0,50000),log(5,60,25000,6),log(4,100,500000,1),log(3,150,0,5),log(2,86400,25000),log(1,86401,1000000)]});
 const value=await read(settings);
 assert.equal(value.kind,'usage');assert.equal(value.scope,'key');assert.equal(value.amount,'0.70');assert.equal(value.currency,'CNY');assert.equal(value.refunds,1);assert.equal(value.records,3);assert.equal(value.coverage,'window');assert.equal(value.periodStart,new Date(at-86400000).toISOString());
 assert.doesNotMatch(JSON.stringify(value),/fixture-secret|private-/);
 assert.ok(calls.every(c=>!c.url.includes('fixture-secret')&&!new URL(c.url).search));
 assert.equal(calls.find(c=>c.url.endsWith('/api/status')).options.headers.Authorization,undefined);
 assert.equal(calls.find(c=>c.url.endsWith('/api/log/token')).options.headers.Authorization,'Bearer fixture-secret');
 await read(settings);assert.equal(calls.length,3,'one minute cache');
 await read(settings,{force:true});assert.equal(calls.length,6);
 await read({...settings,apiKey:'second-fixture'});assert.equal(calls.length,9,'separate cache when credentials change');
});
test('limited and empty logs never claim to be the full day or invent zero usage',async()=>{
 let value=await fixture({logs:[log(1,60,500000)]}).read(settings);
 assert.equal(value.coverage,'recent-records');assert.equal(value.amount,'7.00');
 value=await fixture().read(settings);assert.equal(value.kind,'no-records');assert.equal(value.amount,undefined);
 value=await fixture({logs:[log(1,90000,500000)]}).read(settings);assert.equal(value.kind,'no-records');assert.equal(value.amount,undefined);
});
test('unknown currency, malformed logs, redirection and upstream errors do not become money',async()=>{
 for(const options of [
  {metadata:{quota_display_type:'TOKENS',quota_per_unit:500000}},
  {logs:[{created_at:second,type:2,quota:'50'}]},
  {logs:[{created_at:second,type:2,quota:NaN}]},
  {respond:p=>p==='/api/log/token'?{ok:false,status:302}:null},
  {respond:p=>p==='/api/log/token'?{ok:false,status:403}:null},
  {respond:p=>p==='/api/log/token'?{ok:true,json:async()=>({success:false,message:'private-error'})}:null},
 ]){const value=await fixture(options).read(settings);assert.equal(value.amount,undefined);assert.ok(['unsupported','unavailable'].includes(value.kind));assert.doesNotMatch(JSON.stringify(value),/private-/);}
});
test('supported log schema must be confirmed before requesting token logs, official providers get no guessed routes',async()=>{
 const {read,calls}=fixture({respond:()=>({ok:true,json:async()=>({balance:'1.22'})})});
 assert.equal((await read(settings)).kind,'unsupported');assert.equal(calls.some(c=>c.url.endsWith('/api/log/token')),false);
 for(const baseUrl of ['https://api.deepseek.com/v1','https://api.openai.com/v1','https://dashscope.aliyuncs.com/compatible-mode/v1','https://api.siliconflow.cn/v1','https://ark.cn-beijing.volces.com/api/v3'])assert.equal((await read({...settings,baseUrl})).kind,'unsupported');
 assert.equal(calls.length,2);assert.equal((await read({})).kind,'unconfigured');
});
test('duplicate log IDs are counted once and refunds may yield negative net usage',async()=>{
 const item=log(2,50,100000);
 const value=await fixture({logs:[item,item,log(1,70,200000,6),log(0,90000,0)]}).read(settings);
 assert.equal(value.amount,'-1.40');assert.equal(value.records,2);assert.equal(value.refunds,1);
});
