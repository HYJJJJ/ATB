import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

test('desktop workflow remains bounded and rejects a thirteenth action',async t=>{
 const {createDshAgent,dshToolLimits}=await import('../server/dsh-agent.js');let requests=0,executed=0;
 assert.deepEqual(dshToolLimits({definitions:[]}),{rounds:6,calls:6});
 const registry={definitions:[{name:'desktop_interact',description:'模拟窗口动作',parameters:{type:'object',properties:{}}}],execute:async()=>{executed++;return{ok:true};}};
 const agent=createDshAgent({request:async(_url,options)=>{
  const body=JSON.parse(options.body);requests++;if(requests===13)assert.equal(body.tools,undefined);
  return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'bounded_'+requests,type:'function',function:{name:'desktop_interact',arguments:'{}'}}]}}]});
 }});t.after(()=>agent.close());
 await assert.rejects(agent.run({url:'https://fixture.example/v1',protocol:'chat',signal:AbortSignal.timeout(30000),options:{body:JSON.stringify({messages:[{role:'user',content:'隔离上限测试'}]})},registry}),/达到限制/);
 assert.equal(executed,12);assert.equal(requests,13);
});

test('desktop workflow can open, inspect, fill, click and reinspect within one DSH turn',async t=>{
 const {createDshAgent}=await import('../server/dsh-agent.js'),{createAgentTools}=await import('../server/agent-tools.js'),{registerDesktopActions}=await import('../server/desktop-action-bridge.js');
 const require=createRequire(import.meta.url),{createAgentActions}=require('../desktop/agent-actions.cjs'),{createDesktopAutomation}=require('../desktop/desktop-automation.cjs');
 const dir=await mkdtemp(path.join(tmpdir(),'atb-dsh-controls-'));t.after(()=>rm(dir,{recursive:true,force:true}));let value='',clicked=false,approvals=0,launched=0,requests=0;
 const automation=createDesktopAutomation({confirm:async()=>{approvals++;return true;},run:async request=>{
  if(request.action==='windows')return{ok:true,windows:[{handle:'100',pid:10,start:'100',title:'测试应用',process:'fixture'}]};
  if(request.action==='snapshot')return{ok:true,inputsComplete:true,inputs:[{runtimeId:'edit',name:'内容',value}],nodes:[{runtimeId:'edit',name:'内容',type:'Edit',value,actions:['set_value']},{runtimeId:'send',name:'模拟发送',type:'Button',actions:['invoke']},{runtimeId:'result',name:clicked?'模拟结果：'+value:'未发送',type:'Text',actions:[]}]};
  assert.equal(request.expectedInputs[0].value,value);if(request.operation==='set_value')value=request.text;if(request.operation==='invoke')clicked=true;return{ok:true,data:{message:'控件操作完成'}};
 }});
 const dispose=await registerDesktopActions(dir,createAgentActions({automation,menuDirs:[],launch:async()=>launched++}));t.after(dispose);
 const registry=createAgentTools({dataDir:dir,readOnly:{definitions:[]},settings:{capabilities:{desktop:true}}});
 const agent=createDshAgent({request:async(_url,options)=>{
  const body=JSON.parse(options.body),results=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));requests++;
  assert.ok(results.every(result=>result.ok),JSON.stringify(results));
  const win=results[1]?.data.windows[0].id,view=results[4]?.data||results[2]?.data;
  const steps=[['open_application',{id:'notepad'}],['desktop_windows',{query:'测试应用'}],['desktop_snapshot',{windowId:win}],['desktop_interact',{snapshotId:view?.snapshotId,targetId:view?.controls[0].id,action:'set_value',text:'测试123'}],['desktop_snapshot',{windowId:win}],['desktop_interact',{snapshotId:view?.snapshotId,targetId:view?.controls[1].id,action:'invoke'}],['desktop_snapshot',{windowId:win}]];
  if(results.length<steps.length){assert.notEqual(body.tool_choice,'none');const [name,args]=steps[results.length];return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'step_'+results.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});}
  assert.ok(results.at(-1).data.controls.some(c=>c.name==='模拟结果：测试123'));
  return Response.json({choices:[{message:{content:'已核实测试窗口中的模拟结果。'}}]});
 }});t.after(()=>agent.close());
 const result=await agent.run({url:'https://fixture.example/v1',protocol:'chat',signal:AbortSignal.timeout(30000),options:{body:JSON.stringify({messages:[{role:'user',content:'打开隔离测试应用并完成模拟操作'}]})},registry});
 assert.equal(result.toolsUsed.length,7);assert.equal(requests,8);assert.equal(approvals,2);assert.equal(launched,1);assert.equal(clicked,true);assert.match(result.answer,/已核实/);
});

test('a slow provider may finish beyond the passive wait default without losing its answer',async t=>{
  const {createDshAgent}=await import('../server/dsh-agent.js');
  let completed=false,requests=0;
  const agent=createDshAgent({request:async()=>{
    requests++;
    await new Promise(resolve=>setTimeout(resolve,31000));
    completed=true;
    return Response.json({choices:[{message:{content:'慢响应完整结束'}}]});
  }});t.after(()=>agent.close());
  const result=await agent.run({url:'https://fixture.example/v1',protocol:'chat',signal:AbortSignal.timeout(45000),
    options:{body:JSON.stringify({messages:[{role:'user',content:'固定慢响应测试'}]})},
    registry:{definitions:[],execute:async()=>{throw Error('unexpected-tool');}}});
  assert.equal(completed,true);assert.equal(result.answer,'慢响应完整结束');assert.equal(requests,1);
});

test('DSH invokes discovered MCP and native host tools in the same ordinary turn',async t=>{
  const {createDshAgent}=await import('../server/dsh-agent.js');
  const {McpConnections}=await import('../server/mcp-connections.js');
  const {createAgentTools}=await import('../server/agent-tools.js');
  const {registerDesktopActions}=await import('../server/desktop-action-bridge.js');
  const dir=await mkdtemp(path.join(tmpdir(),'atb-dsh-integration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const navigated=[];const dispose=await registerDesktopActions(dir,async(action,args)=>{navigated.push({action,...args});return{ok:true,data:{page:args.page}};});t.after(dispose);
  const connections=new McpConnections();t.after(()=>connections.close());
  const mcp=await connections.registry('owner',{servers:[{id:'fixture',label:'fixture',enabled:true,transport:'stdio',command:'node',args:[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url))],env:{}}]});
  const registry=createAgentTools({dataDir:dir,readOnly:{definitions:[]},mcp});let rounds=0;const used=[];
  const agent=createDshAgent({request:async(_url,options)=>{
    const body=JSON.parse(options.body);rounds++;
    if(rounds===1)return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'calc',type:'function',function:{name:'mcp__fixture__multiply',arguments:'{"a":6,"b":7}'}},{id:'open',type:'function',function:{name:'open_atb',arguments:'{"page":"tools"}'}}]}}]});
    const results=body.messages.filter(m=>m.role==='tool');assert.equal(results.length,2);assert.match(results[0].content,/42/);assert.match(results[1].content,/tools/);
    return Response.json({choices:[{message:{content:'结果42，工具页面已打开。'}}]});
  }});t.after(()=>agent.close());
  const result=await agent.run({url:'https://fixture.example/v1',protocol:'chat',options:{body:JSON.stringify({messages:[{role:'user',content:'计算6乘7并打开工具页面'}]})},registry,onTool:item=>used.push(item)});
  assert.equal(result.answer,'结果42，工具页面已打开。');assert.equal(rounds,2);assert.deepEqual(navigated,[{action:'open_atb',page:'tools'}]);assert.equal(used.length,2);assert.ok(used.every(item=>item.ok));
});

test('literal slash text reaches the configured model instead of DSH commands', async () => {
  const {createDshAgent}=await import('../server/dsh-agent.js');let calls=0;
  const agent=createDshAgent({request:async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).messages.at(-1).content,'/plan');return Response.json({choices:[{message:{content:'原样收到'}}]});}});
  try { const result=await agent.run({url:'https://fixture.example/v1',protocol:'chat',options:{body:JSON.stringify({messages:[{role:'user',content:'/plan'}]})},registry:{definitions:[],execute:async()=>{throw Error('unexpected');}}});assert.equal(result.answer,'原样收到');assert.equal(calls,1); }
  finally {await agent.close();}
});

test('official DSH discovers tools, executes a real host tool and streams the answer', async () => {
  const { createDshAgent } = await import('../server/dsh-agent.js');
  let rounds = 0, executed = 0; const visible = [], used = [];
  const agent = createDshAgent({ request: async (_url, options) => {
    const body = JSON.parse(options.body); rounds++;
    assert.equal(body.tools.length, 1);
    if (rounds === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id:'time_1', type:'function', function:{name:'current_time',arguments:'{}'} }] } }] });
    assert.equal(body.messages.at(-1).tool_call_id, 'time_1');
    assert.match(body.messages.at(-1).content, /09:35/);
    return Response.json({ choices:[{finish_reason:'stop',message:{content:'现在是09:35。'}}] });
  } });
  const result = await agent.run({url:'https://fixture.example/v1/chat/completions',protocol:'chat',options:{body:JSON.stringify({model:'fixture',messages:[{role:'system',content:'你是小鲸鱼'},{role:'user',content:'几点了'}],stream:true})},
    registry:{definitions:[{name:'current_time',description:'查询时间',parameters:{type:'object',properties:{}}}],execute:async()=>{executed++;return {ok:true,data:{local:'09:35'}};}},onDelta:text=>visible.push(text),onTool:item=>used.push(item)});
  await agent.close();
  assert.equal(result.answer,'现在是09:35。'); assert.equal(visible.join(''),result.answer);
  assert.equal(executed,1); assert.equal(rounds,2); assert.equal(used[0].name,'current_time'); assert.equal(used[0].ok,true);
});

test('cancelling DSH during a host tool prevents further model calls and cleans up', async () => {
  const {createDshAgent}=await import('../server/dsh-agent.js');
  const controller=new AbortController();let enter;const entered=new Promise(resolve=>{enter=resolve;});let calls=0;
  const agent=createDshAgent({request:async()=>{calls++;return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'hold',type:'function',function:{name:'wait',arguments:'{}'}}]}}]});}});
  const task=agent.run({url:'https://fixture.example/v1/chat/completions',protocol:'chat',options:{body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'等一下'}]})},signal:controller.signal,
    registry:{definitions:[{name:'wait',description:'wait',parameters:{type:'object',properties:{}}}],execute:async(_call,{signal})=>{enter();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
  await entered;controller.abort();await assert.rejects(task);await agent.close();assert.equal(calls,1);
});
