import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LayeredMemory} from '../server/layered-memory.js';
import {createAssistantRoutes} from '../server/assistant-routes.js';
import {createHandler} from '../../../server/app.js';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const isPrivateCall = payload => payload.tools?.some(tool => /^(?:memory_|diary_|write_diary|qq_memory_)/.test(tool.name || tool.function?.name));
const isPublicCall = payload => !isPrivateCall(payload) && !payload.response_format && !payload.text?.format;
const moduleRoot=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(moduleRoot,'module.json'),'utf8'));

const quote='你刚才那句话真的伤到我了，但我愿意继续认真沟通';
const hook='一次争吵后他说愿意继续认真沟通';
const secret='PRIVATE_DIARY_REFLECTION_CANARY_7319';
async function fixture(t,{seed=false,request,corruptOwner}={}) {
 const dataDir=await mkdtemp(path.join(tmpdir(),'atb-layered-routes-'));
 if(seed) {
  const memory=new LayeredMemory({dataDir:path.join(dataDir,'assistant'),now:()=>Date.now()-3*86400000});
  const context={allowWrite:true,event:{emotion:'争吵',related:true,intensity:5,quote,sourceRole:'user'},turn:{id:'seed-event-7319',user:quote,assistant:'我刚才说重了，对不起。'}};
  assert.equal((await memory.tool('alice','memory_core_append',{emotion:'争吵',content:hook},context)).ok,true);
  assert.equal((await memory.tool('alice','write_diary',{content:'●【触点】'+quote+'\n●【我的想】'+secret,mood:'认真'},context)).ok,true);
  await memory.close();
 }
 if(corruptOwner){const damaged=path.join(dataDir,'assistant','memory-v2',createHash('sha256').update(corruptOwner).digest('hex'));await mkdir(damaged,{recursive:true});await writeFile(path.join(damaged,'state.json'),'{'+secret);}
 const calls=[];let authorized=true;
 const accounts={session:token=>authorized&&['alice','bob'].includes(token)?{user:{username:token,role:'admin'}}:null};
 const routes=await createAssistantRoutes({accounts,dataDir,request:request|| (async (_url,options)=>{
  const payload=JSON.parse(options.body);calls.push(payload);
  return {ok:true,json:async()=>({choices:[{message:{content:isPrivateCall(payload)?'{}':'我记得你愿意继续好好聊。'}}]})};
 })});
 const modules={config:{},list:()=>[],handle:routes,asset:url=>{const relative=manifest.assets[url];return relative?{file:path.join(moduleRoot,relative),relative,type:relative.endsWith('.html')?'text/html':relative.endsWith('.js')?'text/javascript':'text/css',module:{instance:{}}}:undefined;}};
 const server=http.createServer(createHandler({secure:true,certDir:dataDir,lanIp:'127.0.0.1',httpsPort:1,httpPort:1,modules}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await routes.close();await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 const host='127.0.0.1:'+server.address().port;
 const get=(suffix,owner='alice')=>fetch('http://'+host+suffix,{headers:{cookie:'__Host-freecamera='+owner}});
 const post=(suffix,body,owner='alice')=>fetch('http://'+host+'/api/assistant/'+suffix,{method:'POST',headers:{cookie:'__Host-freecamera='+owner,origin:'https://'+host,'content-type':'application/json'},body:JSON.stringify(body)});
 await post('settings',{name:'小鲸鱼',prompt:'自然交流，不编造记忆',provider:'custom',baseUrl:'https://example.com/v1',model:'memory-test',apiKey:'fixture-only',memory:''});
 return {get,post,calls,dataDir,revoke:()=>{authorized=false;}};
}

test('three-layer public status and every diary-shaped endpoint exclude private reflection',async t=>{
 const {get,post}=await fixture(t,{seed:true});
 assert.equal((await get('/modules/assistant/')).status,200,'real app handler serves only manifest assets');
 const status=await(await get('/api/assistant/memory')).json();
 assert.equal(status.version,2);assert.equal(status.core.length,1);assert.equal(status.core[0].emotion,'争吵');assert.equal(status.core[0].content,hook);
 assert.doesNotMatch(JSON.stringify(status),new RegExp(secret));
 for(const route of ['/api/assistant/diary','/api/assistant/diary/read','/api/assistant/memory/diary','/api/assistant/memory/export','/modules/assistant/diary/2026-11-14.md','/data/assistant/memory-v2/diary/2026-11-14.md'])assert.equal((await get(route)).status,404,route);
 assert.equal((await post('memory',{action:'diary_read',date:'2026-11-14'})).status,400);
 const query=await(await get('/api/assistant/memory?date=2026-11-14&tool=diary_read')).json();assert.doesNotMatch(JSON.stringify(query),new RegExp(secret));
 const bob=await(await get('/api/assistant/memory','bob')).json();assert.equal(bob.core.length,0);
 const report=await(await post('memory',{action:'prune'})).json();
 assert.ok(JSON.stringify(report.report.kept).includes(hook),'retained report lists actual hook content');
 assert.doesNotMatch(JSON.stringify(report),new RegExp(secret));
});

test('restarted layered core enters the public model context while diary bodies never do',async t=>{
 const {post,calls}=await fixture(t,{seed:true});
 const reply=await(await post('chat',{messages:[{role:'user',content:'接着聊吧'}]})).json();
 assert.ok(reply.reply);
 const ordinary=calls.find(call=>isPublicCall(call));
 const prompt=ordinary.messages[0].content;
 assert.match(prompt,/你现在记得的事/);assert.ok(prompt.includes(hook));assert.doesNotMatch(prompt,new RegExp(secret));
 assert.doesNotMatch(prompt,/PRIVATE_DIARY/);
});

test('ordinary talk keeps core and diary empty and the memory-off switch excludes injection',async t=>{
 const {post,get,calls}=await fixture(t);
 await post('chat',{messages:[{role:'user',content:'今天午饭吃了面'}]});
 let state=await(await get('/api/assistant/memory')).json();assert.equal(state.core.length,0);
 assert.ok(state.light.some(entry=>entry.category==='activeTopic'));
 await post('settings',{scope:'memory',memory:'',memoryMode:'off'});
 await post('chat',{messages:[{role:'user',content:'晚上吃什么'}]});
 const ordinary=calls.filter(call=>isPublicCall(call)).at(-1);
 assert.doesNotMatch(ordinary.messages[0].content,/你现在记得的事/);
 const cleared=await(await post('memory',{action:'clear'})).json();assert.equal(cleared.core.length,0);assert.equal(cleared.light.length,0);
});

const apiResult = (payload,content='',calls=[]) => ({ok:true,json:async()=>payload.input ? {output:[...(content?[{type:'message',content:[{type:'output_text',text:content}]}]:[]),...calls.map((call,index)=>({type:'function_call',call_id:'fixture-'+index,name:call.name,arguments:JSON.stringify(call.args)}))]} : {choices:[{message:{content,...(calls.length?{tool_calls:calls.map((call,index)=>({id:'fixture-'+index,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}:{})}}]}});

test('verified dispute is learned through native tools and not an archived transcript',async t=>{
 let privateRounds=0;
 const f=await fixture(t,{request:async(_url,options)=>{
  const payload=JSON.parse(options.body);
  if(payload.response_format)return apiResult(payload,JSON.stringify({emotion:'争吵',related:true,intensity:5,quote,sourceRole:'user'}));
  if(isPrivateCall(payload)){
   privateRounds++;
   return apiResult(payload,'',privateRounds===1?[{name:'memory_core_append',args:{content:hook,emotion:'争吵'}},{name:'write_diary',args:{content:'●【触点】'+quote+'\n●【我的想】'+secret,mood:'认真'}}]:[]);
  }
  return apiResult(payload,'我会认真听完。');
 }});
 assert.equal((await f.post('chat',{messages:[{role:'user',content:quote}],turnId:'actual-event-7319'})).status,200);
 let state;
 for(let n=0;n<100;n++){state=await(await f.get('/api/assistant/memory')).json();if(state.core.length)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.core.length,1);assert.equal(state.core[0].emotion,'争吵');assert.ok(Array.from(state.core[0].content).length<=30);
 assert.doesNotMatch(JSON.stringify(state),new RegExp(secret));
});

for(const protocol of ['chat','responses'])for(const stream of [false,true])test(protocol+' recall '+(stream?'stream':'JSON')+' injects verified source facts and excludes private reflection',async t=>{
 const outbound=[];
 const f=await fixture(t,{seed:true,request:async(_url,options)=>{
  const payload=JSON.parse(options.body);outbound.push(payload);
  if(isPrivateCall(payload)){
   const history=payload.messages||payload.input;
   const already=history.some(item=>item.role==='tool'||item.type==='function_call_output');
   return apiResult(payload,'',already?[]:[{name:'diary_search',args:{query:'认真沟通',limit:5}}]);
  }
  if(payload.response_format||payload.text?.format)return apiResult(payload,'{}');
  if(!payload.stream)return apiResult(payload,'我记得你说愿意继续认真沟通。');
  const event=protocol==='chat'?{choices:[{delta:{content:'我记得你说愿意继续认真沟通。'}}]}:{type:'response.output_text.delta',delta:'我记得你说愿意继续认真沟通。'};
  const end=protocol==='chat'?'data: [DONE]\n\n':'data: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n';
  return new Response('data: '+JSON.stringify(event)+'\n\n'+end,{headers:{'content-type':'text/event-stream'}});
 }});
 await f.post('settings',{scope:'model',protocol});
 const response=await f.post('chat',{stream,messages:[{role:'user',content:'你还记得之前那次争吵吗？'}]});
 assert.equal(response.status,200);assert.doesNotMatch(await response.text(),new RegExp(secret));
 const publicCall=outbound.find(item=>isPublicCall(item));
 const prompt=publicCall.instructions||publicCall.messages[0].content;
 assert.ok(prompt.includes(quote));assert.ok(prompt.includes(hook));assert.doesNotMatch(prompt,new RegExp(secret));
 assert.ok(outbound.some(item=>isPrivateCall(item)),'recall used native private tools');
});

test('no diary match gives explicit uncertain guidance to the public reply generator',async t=>{
 const outbound=[];
 const f=await fixture(t,{request:async(_url,options)=>{
  const payload=JSON.parse(options.body);outbound.push(payload);
  return apiResult(payload,isPrivateCall(payload)?'':'记不清了，你能提醒我一下吗？',isPrivateCall(payload)?[{name:'diary_search',args:{query:'上周那件事'}}]:[]);
 }});
 const result=await(await f.post('chat',{messages:[{role:'user',content:'你还记得上周那件事吗？'}]})).json();
 assert.match(result.reply,/记不清/);
 const publicCall=outbound.find(item=>isPublicCall(item));
 assert.match(publicCall.messages[0].content,/没有找到可核实|记不清/);
});

for(const action of ['clear','off','logout'])test(action+' during private recall cannot send stale memory to public generation',async t=>{
 let entered,release;const started=new Promise(r=>{entered=r;});const held=new Promise(r=>{release=r;});const outbound=[];
 const f=await fixture(t,{seed:true,request:async(_url,options)=>{
  const payload=JSON.parse(options.body);outbound.push(payload);
  if(isPrivateCall(payload)){entered();await held;return apiResult(payload);}
  return apiResult(payload,payload.response_format?'{}':'继续聊吧');
 }});
 const pending=f.post('chat',{messages:[{role:'user',content:'你还记得之前那件事吗？'}]});
 await started;
 if(action==='clear')await f.post('memory',{action:'clear'});
 if(action==='off')await f.post('settings',{scope:'memory',memory:'',memoryMode:'off'});
 if(action==='logout')f.revoke();
 release();
 const response=await pending;
 if(action==='logout'){assert.equal(response.status,401);assert.equal(outbound.filter(item=>isPublicCall(item)).length,0);}
 else{assert.equal(response.status,200);const ordinary=outbound.find(item=>isPublicCall(item));assert.doesNotMatch(ordinary.messages[0].content,new RegExp(hook));assert.doesNotMatch(ordinary.messages[0].content,new RegExp(quote));}
});

for(const corruptOwner of ['alice','bob'])test('corrupted '+corruptOwner+' memory does not disable ordinary chat or change its file',async t=>{
 const f=await fixture(t,{corruptOwner});
 const result=await f.post('chat',{messages:[{role:'user',content:'正常聊一句'}]});
 assert.equal(result.status,200);assert.doesNotMatch(await result.text(),new RegExp(secret));
 const status=await f.get('/api/assistant/memory',corruptOwner);assert.equal(status.status,500);assert.doesNotMatch(await status.text(),new RegExp(secret));
 const damaged=path.join(f.dataDir,'assistant','memory-v2',createHash('sha256').update(corruptOwner).digest('hex'),'state.json');
 assert.equal(await readFile(damaged,'utf8'),'{'+secret);
});
