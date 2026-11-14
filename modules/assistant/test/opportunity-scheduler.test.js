import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OpportunityScheduler, opportunityPrompt, wakePolicy} from '../server/opportunity-scheduler.js';
const M=60000;
async function fixture(t,rng=()=>0){const dir=await mkdtemp(path.join(tmpdir(),'atb-opportunity-'));t.after(()=>rm(dir,{recursive:true,force:true}));let at=Date.parse('2026-11-14T04:00:00Z');const options={dataDir:dir,now:()=>at,random:rng};const scheduler=new OpportunityScheduler(options);await scheduler.start();return {dir,options,s:scheduler,set:v=>{at=v;},get at(){return at;}};}
const policy={quietEnabled:false,timeZone:'Asia/Shanghai'};
const run=(s,extra={})=>s.run('alice',{enabled:true,policy,decide:async()=>({action:'none'}),...extra});
test('first schedule is random and three restarts preserve it without waking',async t=>{const f=await fixture(t,()=>.4);let n=0;await run(f.s,{decide:async()=>{n++;return {action:'none'};}});const first=await f.s.status('alice');assert.ok(first.nextAt-f.at>=45*M&&first.nextAt-f.at<=90*M);for(let i=0;i<3;i++){await f.s.close();f.s=new OpportunityScheduler(f.options);await f.s.start();await run(f.s);assert.equal((await f.s.status('alice')).nextAt,first.nextAt);}assert.equal(n,0);await f.s.close();});
test('miss records dice and reschedules without consuming daily wakes',async t=>{const f=await fixture(t,()=>.9);await run(f.s);f.set((await f.s.status('alice')).nextAt);await run(f.s,{probability:.55});const state=await f.s.status('alice');assert.equal(state.todayCount,0);assert.equal(state.outcomes.at(-1).roll,.9);assert.equal(state.outcomes.at(-1).hit,false);assert.equal(state.outcomes.at(-1).woke,false);assert.ok(state.nextAt>f.at);await f.s.close();});
test('hit none is a completed choice, not an error or immediate retry',async t=>{const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);let n=0;await run(f.s,{decide:async()=>{n++;return {action:'none'};}});await run(f.s);const state=await f.s.status('alice');assert.equal(n,1);assert.equal(state.todayCount,1);assert.equal(state.outcomes.at(-1).action,'none');assert.equal(state.outcomes.at(-1).postponed,false);assert.ok(state.nextAt-f.at>=45*M);await f.s.close();});
test('wake priorities defer activity and busy by25min, then quiet until end',()=>{const at=Date.parse('2026-11-13T18:00:00Z');const p={timeZone:'Asia/Shanghai',quietEnabled:true,quietStart:'01:00',quietEnd:'08:00'};assert.equal(wakePolicy({lastDialogueAt:at-4*M},p,at).nextAt,at+25*M);assert.equal(wakePolicy({},p,at,{busy:true}).nextAt,at+25*M);const quiet=wakePolicy({},p,at);assert.equal(quiet.nextAt,Date.parse('2026-11-14T00:00:00Z'));assert.equal(quiet.reason,'quiet');});
test('concurrent renderers reserve once and reboot does not replay an interrupted model',async t=>{const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);let resolve,started;const waiting=new Promise(r=>{started=r;});const job=run(f.s,{decide:()=>{started();return new Promise(r=>{resolve=r;});}});await waiting;const other=await run(f.s);assert.equal(other.reply,'');const disk=JSON.parse(await readFile(path.join(f.dir,'state','proactive.json'),'utf8'));assert.ok(Object.values(disk.conversations)[0].inFlight);const reboot=new OpportunityScheduler(f.options);await reboot.start();await run(reboot);assert.equal((await reboot.status('alice')).todayCount,1);resolve({action:'none'});await job;await f.s.close();await reboot.close();});
test('chat cap2 is independent of wake cap8; game range is110–180min',async t=>{const f=await fixture(t);await run(f.s);for(let i=0;i<9;i++){f.set((await f.s.status('alice')).nextAt);await run(f.s,{decide:async()=>({action:'chat',text:'吃饭了吗'})});}const state=await f.s.status('alice');assert.equal(state.chatCount,2);assert.equal(state.todayCount,8);assert.equal(state.outcomes.filter(o=>o.action==='chat').length,2);const game=await f.s.run('bob',{enabled:true,policy,kind:'game',decide:async()=>({action:'none'})});assert.ok(game.nextAt-f.at>=110*M&&game.nextAt-f.at<=180*M);await f.s.close();});
test('activity during decision cancels late chat; accounts remain isolated',async t=>{const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);let resolve,started;const ready=new Promise(r=>{started=r;});const job=run(f.s,{decide:()=>{started();return new Promise(r=>{resolve=r;});}});await ready;await f.s.touch('alice');resolve({action:'chat',text:'迟到消息'});assert.equal((await job).reply,'');assert.equal((await f.s.status('alice')).chatCount,0);assert.equal((await f.s.status('bob')).todayCount,0);await f.s.close();});
test('prompt is optional exact opportunity turn and no mandatory production instruction',()=>{const p=opportunityPrompt({time:'12:34',minutes:42,platform:'已接入的平台'});assert.equal(p,'【有一会儿空】\n现在是 12:34。主人上次说话是 42 分钟前。\n你可以：\n- 找他聊两句（他可能在忙）\n- 去 已接入的平台 逛逛\n- 干点别的\n- 什么都不做也行\n\n想做就做，不想做就继续待着。别为了"显得主动"硬找事。');});

test('eight due rolls approximate8xP; misses do not count and a day has irregular opportunity times',async t=>{
 const f=await fixture(t);let seed=123456789;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};let hits=0;const intervals=new Set();
 for(let day=0;day<100;day++){
  const owner='sim-'+day;await f.s.run(owner,{enabled:true,policy,decide:async()=>({action:'none'})});
  for(let attempt=0;attempt<8;attempt++){
   const state=await f.s.status(owner);f.set(state.nextAt);f.s.random=rng;
   const result=await f.s.run(owner,{enabled:true,policy,decide:async()=>({action:'none'})});intervals.add(Math.round((result.nextAt-f.at)/1000));
  }
  const state=await f.s.status(owner);hits+=state.outcomes.filter(o=>o.hit).length;assert.ok(state.todayCount<=8);assert.equal(state.outcomes.length,8);
 }
 assert.ok(hits>390&&hits<490,'800 independent rolls should be near440 hits, got '+hits);assert.ok(intervals.size>100);await f.s.close();
});
test('daily wake cap postpones to following local day with jitter, not midnight',async t=>{
 const f=await fixture(t);await run(f.s);for(let i=0;i<8;i++){f.set((await f.s.status('alice')).nextAt);await run(f.s);}
 const previous=await f.s.status('alice');f.set(previous.nextAt);await run(f.s);let state=await f.s.status('alice');assert.equal(state.outcomes.at(-1).detail,'daily-cap');
 const parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(state.nextAt));assert.equal(parts,'00:45');
 f.set(state.nextAt);await run(f.s);state=await f.s.status('alice');assert.equal(state.todayCount,1);await f.s.close();
});
test('cancel of unresolved decision finishes silently without waiting for provider',async t=>{
 const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);let started;const ready=new Promise(r=>{started=r;});
 const job=run(f.s,{decide:()=>{started();return new Promise(()=>{});}});await ready;f.s.cancel('alice');assert.equal((await job).reply,'');assert.equal((await f.s.status('alice')).running,false);await f.s.close();
});
test('busy poll cancels an already-running decision, disabled state does not reroll schedule',async t=>{
 const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);let started;const ready=new Promise(r=>{started=r;});const job=run(f.s,{decide:()=>{started();return new Promise(()=>{});}});await ready;
 await run(f.s,{busy:true});assert.equal((await job).reply,'');const before=(await f.s.status('alice')).nextAt;await run(f.s,{enabled:false});assert.equal((await f.s.status('alice')).nextAt,before);await f.s.close();
});
test('quiet policy handles overnight, nonovernight, DST and snooze',()=>{
 const midnight=Date.parse('2026-11-13T18:10:00Z');const quiet={timeZone:'Asia/Shanghai',quietEnabled:true,quietStart:'01:00',quietEnd:'08:00'};
 assert.equal(wakePolicy({},quiet,midnight).nextAt,Date.parse('2026-11-14T00:00:00Z'));
 assert.equal(wakePolicy({}, {...quiet,snoozeUntil:midnight+120*M},midnight).nextAt,midnight+120*M);
 assert.equal(wakePolicy({}, {...quiet,quietStart:'12:00',quietEnd:'14:00'},Date.parse('2026-11-14T04:30:00Z')).nextAt,Date.parse('2026-11-14T06:00:00Z'));
 assert.equal(wakePolicy({}, {timeZone:'America/New_York',quietEnabled:true,quietStart:'01:00',quietEnd:'04:00'},Date.parse('2026-11-01T05:30:00Z')).nextAt,Date.parse('2026-11-01T09:00:00Z'));
});

test('unexpired pending thoughts are offered next time and expire after2hours',async t=>{
 const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);await run(f.s,{decide:async()=>({action:'none',pendingThought:'想问明天还上班吗'})});
 f.set((await f.s.status('alice')).nextAt);let seen;await run(f.s,{decide:async options=>{seen=options.pendingThought;return {action:'none'};}});assert.equal(seen?.content,'想问明天还上班吗');
 f.set(f.at+121*M);await run(f.s,{decide:async options=>{seen=options.pendingThought;return {action:'none'};}});assert.equal(seen,null);await f.s.close();
});

test('last owner message is durable for a hidden desktop consumer and has stable delivery identity',async t=>{
 const f=await fixture(t);await run(f.s);f.set((await f.s.status('alice')).nextAt);const result=await run(f.s,{decide:async()=>({action:'chat',text:'今天的晚饭吃了吗'})});assert.ok(result.id);
 const saved=(await f.s.status('alice')).lastChat;assert.equal(saved.text,result.reply);assert.equal(saved.id,result.id);await f.s.close();const restart=new OpportunityScheduler(f.options);await restart.start();assert.deepEqual((await restart.status('alice')).lastChat,saved);await restart.close();
});
