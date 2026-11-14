import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import vm from 'node:vm';

test('capability switches persist and block execution as well as discovery',async t=>{
  const {ToolSettings}=await import('../server/tool-settings.js'),{createAgentTools}=await import('../server/agent-tools.js');
  const dir=await mkdtemp(path.join(tmpdir(),'atb-capabilities-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new ToolSettings(dir);await store.load();await store.save('alice',{servers:[],capabilities:{search:false,weather:false,applications:false}});
  await store.save('alice',{servers:[]});const restored=new ToolSettings(dir);await restored.ensure('alice');assert.equal(restored.get('alice').capabilities.search,false);
  assert.equal(restored.get('bob').capabilities?.search,undefined);
  let calls=0;const registry=createAgentTools({readOnly:{definitions:[{name:'weather'}],execute:()=>{calls++;}},dataDir:dir,settings:restored.get('alice'),request:()=>{calls++;}});
  for(const name of ['weather','web_search','read_webpage','open_application']){assert.equal(registry.definitions.some(tool=>tool.name===name),false);assert.equal((await registry.execute({name,arguments:'{}'})).error,'capability-disabled');}
  assert.equal(calls,0);assert.ok(registry.definitions.some(tool=>tool.name==='open_atb'));
  assert.equal(registry.definitions.some(tool=>tool.name==='desktop_snapshot'),false,'application control is opt-in');
  assert.equal((await registry.execute({name:'desktop_interact',arguments:'{}'})).error,'capability-disabled');
  const enabled=createAgentTools({readOnly:{definitions:[]},dataDir:dir,settings:{capabilities:{desktop:true}}});
  assert.ok(enabled.definitions.some(tool=>tool.name==='desktop_snapshot'));
  await assert.rejects(store.save('alice',{servers:[],capabilities:{shell:true}}));
});

test('cancelled desktop navigation cannot pass a pending leave confirmation',async()=>{
  const source=await readFile(new URL('../../../desktop/main.cjs',import.meta.url),'utf8');
  const start=source.indexOf('async function navigateDesktop('),end=source.indexOf('\nasync function openWindow()',start);
  let begin,release,loads=0;const entered=new Promise(resolve=>begin=resolve),held=new Promise(resolve=>release=resolve),abort=new AbortController();
  const sandbox={localService:{origin:'https://fixture.example'},window:{isDestroyed:()=>false,loadURL:async()=>loads++},quitting:false,connectionTask:null,showMain:()=>{},confirmViewerLeave:async()=>{begin();await held;return true;},finishViewer:async()=>{},pageMode:'viewer'};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end)+'\nthis.navigate=navigateDesktop;',sandbox);
  const task=sandbox.navigate('main',{signal:abort.signal});await entered;abort.abort();release();await assert.rejects(task);assert.equal(loads,0);
});

test('a separate local service can use the trusted desktop host and loses access on disposal',async t=>{
  const {registerDesktopActions}=await import('../server/desktop-action-bridge.js');
  const dir=await mkdtemp(path.join(tmpdir(),'atb-desktop-tools-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let opened=0;const dispose=await registerDesktopActions(dir,async(action,args)=>{assert.equal(action,'open_atb');assert.equal(args.page,'tools');opened++;return{ok:true,data:{page:args.page}};});t.after(dispose);
  const execute=()=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/desktop-action-client.mjs',import.meta.url)),dir],{windowsHide:true,timeout:10000});
  assert.equal(JSON.parse((await execute()).stdout).ok,true);assert.equal(opened,1);
  await dispose();assert.equal(JSON.parse((await execute()).stdout).ok,false);assert.equal(opened,1);
});

test('MCP settings survive reload, redact secrets and discover and execute arbitrary server tools',async t=>{
  const {ToolSettings}=await import('../server/tool-settings.js');
  const {McpConnections}=await import('../server/mcp-connections.js');
  const dir=await mkdtemp(path.join(tmpdir(),'atb-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const settings=new ToolSettings(dir);await settings.load();
  await settings.save('owner',{servers:[{id:'fixture',label:'测试服务',enabled:true,transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url))],env:{TEST_SECRET:'never-visible'}}]});
  assert.doesNotMatch(JSON.stringify(settings.visible('owner')),/never-visible/);
  const restored=new ToolSettings(dir);await restored.load();await restored.ensure('owner');assert.equal(restored.get('owner').servers[0].env.TEST_SECRET,'never-visible');
  await assert.rejects(settings.save('owner',{servers:[{id:'remote',label:'remote',enabled:true,transport:'streamable-http',url:'not-a-url'}]}),error=>error.status===400);
  await assert.rejects(settings.save('owner',{servers:[{id:'bad name',transport:'stdio',command:'x'}]}));
  assert.equal(settings.get('owner').servers[0].id,'fixture');
  const {validateToolSettings}=await import('../server/tool-settings.js');
  const oldHttp={servers:[{id:'remote',label:'r',enabled:true,transport:'streamable-http',url:'https://old.example/mcp',headers:{Authorization:'old-host-secret'}}]};
  const moved=validateToolSettings({servers:[{...oldHttp.servers[0],url:'https://new.example/mcp',headers:{Authorization:''}}]},oldHttp);
  assert.notEqual(moved.servers[0].headers.Authorization,'old-host-secret');
  const connections=new McpConnections();t.after(()=>connections.close());
  const registry=await connections.registry('owner',restored.get('owner'));
  assert.ok(registry.definitions.some(tool=>tool.name==='mcp__fixture__multiply'));
  const result=await registry.execute({name:'mcp__fixture__multiply',arguments:'{"a":7,"b":6}'});
  assert.equal(result.ok,true);assert.match(JSON.stringify(result),/42/);
  const structured=await registry.execute({name:'mcp__fixture__structured',arguments:'{}'});assert.equal(structured.data.structured.answer,42);
  await connections.reset('owner');
  const disabled=await connections.registry('owner',{servers:[{...restored.get('owner').servers[0],enabled:false}]});assert.equal(disabled.definitions.length,0);
});

test('cancelling an MCP tool terminates its owned local process before a delayed effect',async t=>{
  const {McpConnections}=await import('../server/mcp-connections.js');
  const dir=await mkdtemp(path.join(tmpdir(),'atb-mcp-cancel-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'effect'),connections=new McpConnections();t.after(()=>connections.close());
  const registry=await connections.registry('owner',{servers:[{id:'fixture',label:'fixture',enabled:true,transport:'stdio',command:'node',args:[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url))],env:{TEST_MARKER:marker}}]});
  const abort=new AbortController();const job=registry.execute({name:'mcp__fixture__hold',arguments:'{}'},{signal:abort.signal});
  for(let i=0;i<100;i++){try{await readFile(marker+'.started');break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
  await readFile(marker+'.started');abort.abort();await assert.rejects(job);
  await new Promise(resolve=>setTimeout(resolve,1100));await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('web tools return extracted public facts and explicit failures, native actions need a real host',async()=>{
  const {createAgentTools}=await import('../server/agent-tools.js');
  const registry=createAgentTools({readOnly:{definitions:[],execute:async()=>({ok:false})},dataDir:'fixture',request:async url=>new Response(url.includes('format=rss')?'<rss><channel><item><title>真实结果</title><link>https://example.org/a</link><description>这是一条搜索结果</description></item></channel></rss>':'<html><title>正文标题</title><script>私密脚本</script><main>正文有用内容</main></html>')});
  const search=await registry.execute({name:'web_search',arguments:'{"query":"当前比赛"}'});assert.equal(search.ok,true);assert.equal(search.data.items[0].title,'真实结果');
  const page=await registry.execute({name:'read_webpage',arguments:'{"url":"https://example.org/a"}'});assert.equal(page.ok,true);assert.match(page.data.text,/有用内容/);assert.doesNotMatch(page.data.text,/私密脚本/);
  assert.equal((await registry.execute({name:'open_atb',arguments:'{}'})).ok,false);
  assert.equal((await registry.execute({name:'read_webpage',arguments:'{"url":"file:///secret"}'})).ok,false);
});

test('search can switch engines after irrelevant results and never treats a verification page as news',async()=>{
  const {createAgentTools}=await import('../server/agent-tools.js');const seen=[];
  const registry=createAgentTools({readOnly:{definitions:[]},dataDir:'fixture',request:async url=>{
    seen.push(url);const query=new URL(url).searchParams.get('query');
    if(query==='验证页')return new Response('<html><title>请完成验证</title><main>访问验证</main></html>');
    assert.equal(query,'英雄联盟 新闻');
    return new Response('<html><body><div class="vrwrap"><h3><a href="/link?url=fixture">赛事官方公告</a></h3><div class="str_info">赛事资讯摘要</div></div><div class="vrwrap"><h3><a href="javascript:alert(1)">危险链接</a></h3></div></body></html>');
  }});
  const result=await registry.execute({name:'web_search',arguments:JSON.stringify({query:'英雄联盟 新闻',engine:'sogou'})});
  assert.equal(result.ok,true);assert.equal(result.data.items.length,1);assert.equal(result.data.items[0].title,'赛事官方公告');
  assert.match(result.data.items[0].description,/赛事资讯摘要/);assert.equal(result.data.items[0].url,'https://www.sogou.com/link?url=fixture');assert.equal(result.data.items[0].source,'搜狗网页搜索');
  assert.match(result.data.note,/发布时间.*原文/);
  assert.equal((await registry.execute({name:'web_search',arguments:'{"query":"验证页","engine":"sogou"}'})).error,'search-unavailable');
  assert.equal((await registry.execute({name:'web_search',arguments:'{"query":"测试","engine":"arbitrary"}'})).error,'invalid-arguments');
  assert.equal(seen.length,2);
});

test('web reading decodes Chinese source charsets instead of feeding garbled news to the model',async()=>{
  const {createAgentTools}=await import('../server/agent-tools.js');
  const words=Buffer.from([0xd3,0xa2,0xd0,0xdb,0xc1,0xaa,0xc3,0xcb,0xd0,0xc2,0xce,0xc5]); // 英雄联盟新闻 in GBK
  for(const meta of [false,true]){
    const bytes=Buffer.concat([Buffer.from('<html><head>'+(meta?'<meta charset="gb2312">':'')+'<title>'),words,Buffer.from('</title></head><body><main>'),words,Buffer.from('</main><a href="/news">News</a><a href="javascript:alert(1)">Bad</a><a href="/news">Duplicate</a></body></html>')]);
    const registry=createAgentTools({readOnly:{definitions:[]},dataDir:'fixture',request:async()=>new Response(bytes,{headers:{'content-type':meta?'text/html':'text/html; charset=gbk'}})});
    const result=await registry.execute({name:'read_webpage',arguments:'{"url":"https://fixture.example/news"}'});
    assert.equal(result.ok,true);assert.equal(result.data.title,'英雄联盟新闻');assert.equal(result.data.text,'英雄联盟新闻');
    assert.deepEqual(result.data.links,[{title:'News',url:'https://fixture.example/news'}],'the model can follow a news list without inventing its URL');
  }
});

test('native application actions open only catalogued programs and ATB navigation targets',async()=>{
  const require=createRequire(import.meta.url);const {createAgentActions}=require('../desktop/agent-actions.cjs');
  const opened=[],navigated=[];
  const actions=createAgentActions({navigate:page=>navigated.push(page),launch:async program=>opened.push(program),menuDirs:[]});
  assert.equal((await actions('open_atb',{page:'voice'})).ok,true);assert.deepEqual(navigated,['voice']);
  assert.equal((await actions('open_application',{id:'calculator'})).ok,true);assert.equal(opened.length,1);
  assert.equal((await actions('open_application',{id:'powershell.exe -Command Remove-Item'})).ok,false);
  assert.equal((await actions('open_atb',{page:'../../secret'})).ok,false);
  const list=await actions('list_applications',{});assert.ok(list.data.items.some(item=>item.id==='calculator'));
});

test('public web search follows bounded HTTPS redirects and never follows file redirects',async()=>{
  const {createAgentTools}=await import('../server/agent-tools.js');const seen=[];
  const registry=createAgentTools({readOnly:{definitions:[]},dataDir:'fixture',request:async url=>{seen.push(url);return url.includes('www.bing.com')?new Response('',{status:302,headers:{location:'https://cn.bing.com/search?format=rss&q=test'}}):new Response('<rss><channel><item><title>公开搜索结果</title><link>https://example.org/result</link></item></channel></rss>');}});
  const result=await registry.execute({name:'web_search',arguments:'{"query":"test"}'});assert.equal(result.ok,true);assert.equal(seen.length,2);
  const blocked=createAgentTools({readOnly:{definitions:[]},dataDir:'fixture',request:async()=>new Response('',{status:302,headers:{location:'file:///private'}})});
  assert.equal((await blocked.execute({name:'read_webpage',arguments:'{"url":"https://example.org"}'})).ok,false);
});
