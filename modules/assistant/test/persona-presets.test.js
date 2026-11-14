import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAssistantRoutes} from '../server/assistant-routes.js';

async function fixture(t, legacy, request = async()=>{throw Error('no external calls');}) {
 const dir=await mkdtemp(path.join(tmpdir(),'persona-presets-'));
 if(legacy){await mkdir(path.join(dir,'assistant'),{recursive:true});await writeFile(path.join(dir,'assistant','settings.json'),JSON.stringify(legacy));}
 let routes=await createAssistantRoutes({dataDir:dir,accounts:{session:token=>token==='ok'?{user:{username:'fixture',role:'admin'}}:null},request});
 const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost').pathname));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await routes.close();await rm(dir,{recursive:true,force:true});});
 const host='127.0.0.1:'+server.address().port,url='http://'+host+'/api/assistant/settings';
 const get=async()=> (await fetch(url,{headers:{cookie:'__Host-freecamera=ok'}})).json();
 const post=body=>fetch(url,{method:'POST',headers:{cookie:'__Host-freecamera=ok',origin:'https://'+host,'content-type':'application/json'},body:JSON.stringify(body)});
 const restart=async()=>{await routes.close();routes=await createAssistantRoutes({dataDir:dir,accounts:{session:token=>token==='ok'?{user:{username:'fixture',role:'admin'}}:null}});};
 const chat=body=>fetch('http://'+host+'/api/assistant/chat',{method:'POST',headers:{cookie:'__Host-freecamera=ok',origin:'https://'+host,'content-type':'application/json'},body:JSON.stringify(body)});
 return {dir,get,post,chat,restart,url};
}

test('saved personas become durable named presets; updates, switches and removals only change role fields',async t=>{
 const {dir,get,post,restart,url}=await fixture(t,{personaPresets:[],personaPresetVersion:1});
 assert.equal((await fetch(url)).status,401);
 assert.deepEqual((await get()).personaPresets,[]);
 let state=await(await post({scope:'persona',name:'小鲸鱼',prompt:'自然短句',responseStyle:'concise',proactiveChat:true})).json();
 assert.equal(state.personaPresets.length,1);const whale=state.personaPresets[0].id;assert.equal(state.activePersonaPresetId,whale);
 await post({scope:'memory',memory:'独立固定参考',memoryMode:'off'});
 await post({scope:'model',apiSource:'custom',provider:'custom',baseUrl:'https://example.com/v1',model:'fixture',apiKey:'fixture-secret'});
 state=await(await post({scope:'persona',name:'小猫',prompt:'认真回答',responseStyle:'talkative',followUpQuestions:false,proactiveChat:false})).json();
 const cat=state.activePersonaPresetId;
 state=await(await post({scope:'persona',name:'小猫',prompt:'新的说明'})).json();assert.equal(state.personaPresets.length,2);assert.equal(state.activePersonaPresetId,cat);
 state=await(await post({scope:'personaPreset',action:'select',id:whale,name:'不应应用',memory:'不应覆盖',proactiveChat:true})).json();
 assert.equal(state.name,'小鲸鱼');assert.equal(state.prompt,'自然短句');assert.equal(state.memory,'独立固定参考');assert.equal(state.responseStyle,'talkative');assert.equal(state.proactiveChat,false);assert.equal(state.followUpQuestions,false);assert.equal(state.hasApiKey,true);
 assert.equal(JSON.stringify(state.personaPresets).includes('fixture-secret'),false);
 await restart();state=await get();assert.equal(state.activePersonaPresetId,whale);assert.equal(state.personaPresets.length,2);
 state=await(await post({scope:'personaPreset',action:'remove',id:cat})).json();assert.equal(state.name,'小鲸鱼');assert.equal(state.activePersonaPresetId,whale);assert.equal(state.personaPresets.length,1);
 state=await(await post({scope:'personaPreset',action:'remove',id:whale})).json();assert.equal(state.activePersonaPresetId,null);assert.equal(state.name,'小鲸鱼');assert.equal(state.prompt,'自然短句');assert.deepEqual(state.personaPresets,[]);
 assert.equal((await post({scope:'personaPreset',action:'select',id:cat})).status,400);
 assert.equal((await post({scope:'personaPreset',action:'overwrite',id:whale})).status,400);
 await restart();assert.deepEqual((await get()).personaPresets,[],'deleted presets must not reappear after restart');
 const disk=JSON.parse(await readFile(path.join(dir,'assistant','settings.json'),'utf8'));assert.equal(disk.ai.apiKey,'fixture-secret');
});

test('existing saved role migrates to a preset without rewriting settings on a read',async t=>{
 const legacy={name:'旧角色',prompt:'原来的说明',memory:'固定参考'};
 const {dir,get,post,restart}=await fixture(t,legacy);
 const state=await get();assert.equal(state.personaPresets.length,6);const id=state.activePersonaPresetId;assert.equal(state.personaPresets[0].name,'旧角色');
 assert.deepEqual(JSON.parse(await readFile(path.join(dir,'assistant','settings.json'),'utf8')),legacy);
 await post({scope:'personaPreset',action:'remove',id});await restart();assert.equal((await get()).personaPresets.some(p=>p.id===id),false);
});


test('only the selected role enters Chat and Responses model instructions',async t=>{
 const payloads=[];
 const {post,chat}=await fixture(t,undefined,async(_url,options)=>{const payload=JSON.parse(options.body);payloads.push(payload);return {ok:true,json:async()=>payload.instructions?{output_text:'测试回复'}:{choices:[{message:{content:'测试回复'}}]}};});
 await post({scope:'memory',memory:'',memoryMode:'off'});
 let state=await(await post({scope:'persona',name:'角色甲',prompt:'ROLE_A_ACTIVE_ONLY'})).json();const a=state.activePersonaPresetId;
 await post({scope:'persona',name:'角色乙',prompt:'ROLE_B_MUST_NOT_LEAK'});
 await post({scope:'personaPreset',action:'select',id:a});
 for(const protocol of ['chat','responses']){
  await post({scope:'model',apiSource:'custom',provider:'custom',baseUrl:'https://example.com/v1',model:'fixture',apiKey:'fixture-key',protocol});
  const response=await chat({messages:[{role:'user',content:'固定测试文字'}]});assert.equal(response.status,200);
  const instructions=protocol==='chat'?payloads.at(-1).messages[0].content:payloads.at(-1).instructions;assert.match(instructions,/ROLE_A_ACTIVE_ONLY/);assert.doesNotMatch(instructions,/ROLE_B_MUST_NOT_LEAK|personaPresets/);
 }
});


test('built-in distinct personas seed once without replacing a saved role or reviving deleted presets',async t=>{
 const {get,post,restart}=await fixture(t,{name:'小鲸鱼',prompt:'用户自定义的小鲸鱼'});
 let state=await get();
 assert.equal(state.name,'小鲸鱼');assert.equal(state.prompt,'用户自定义的小鲸鱼');
 const names=state.personaPresets.map(p=>p.name);
 for(const name of ['小鲸鱼','暖暖','阿策','皮皮','知衡'])assert.equal(names.filter(n=>n===name).length,1);
 const chosen=state.personaPresets.find(p=>p.name==='阿策');
 state=await(await post({scope:'personaPreset',action:'select',id:chosen.id})).json();
 assert.equal(state.prompt,chosen.prompt);assert.equal(state.name,'阿策');
 await post({scope:'personaPreset',action:'remove',id:chosen.id});
 await restart();state=await get();assert.equal(state.personaPresets.some(p=>p.name==='阿策'),false);
 assert.equal(state.personaPresets.find(p=>p.name==='小鲸鱼').prompt,'用户自定义的小鲸鱼');
});
