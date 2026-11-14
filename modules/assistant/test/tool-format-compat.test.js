import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readModelRound} from '../server/model-stream.js';
import {readChatReply} from '../public/chat-stream.js';

// Same format as the reported provider output; only the external model/network
// boundaries are replaced. Parsing, DSH, tools, HTTP and renderer decoding are real.
const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n<｜｜DSML｜｜ parameter name="query" string="true">电竞 最新新闻</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const definition = {name:'web_search',description:'查询公开网页',parameters:{type:'object',properties:{query:{type:'string',maxLength:200}},required:['query']}};
const event = value => `data: ${JSON.stringify(value)}\n\n`;
function responseFor(content,protocol,stream) {
  if (!stream) return Response.json(protocol==='chat'?{choices:[{finish_reason:'stop',message:{content}}]}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:content}]}]});
  const chunks=[...content].map(text=>protocol==='chat'?{choices:[{delta:{content:text}}]}:{type:'response.output_text.delta',delta:text});
  chunks.push(protocol==='chat'?{choices:[{delta:{},finish_reason:'stop'}]}:{type:'response.completed',response:{status:'completed'}});
  return new Response(chunks.map(event).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}

for (const protocol of ['chat','responses']) for (const stream of [false,true]) {
  test(`${protocol} ${stream?'SSE':'JSON'} DSML search executes and continues through the actual chat route`,async t=>{
    const {createAssistantRoutes}=await import('../server/assistant-routes.js');
    const dir=await mkdtemp(path.join(tmpdir(),'atb-search-format-'));
    let rounds=0,searches=0,pages=0;
    const routes=await createAssistantRoutes({dataDir:dir,accounts:{session:token=>token==='ok'?{user:{username:'fixture'}}:null},
      companionRequest:async url=>{
        if(url.startsWith('https://www.bing.com/search?')){searches++;assert.equal(new URL(url).searchParams.get('q'),'电竞 最新新闻');return new Response('<rss><channel><item><title>测试电竞赛程公告</title><link>https://fixture.example/esports</link><description>待查证的搜索摘要</description></item></channel></rss>');}
        assert.equal(url,'https://fixture.example/esports');pages++;return new Response('<html><title>赛事官方公告</title><main>隔离测试：决赛将在周日举行。</main></html>');
      },
      request:async(_url,options)=>{
        const payload=JSON.parse(options.body);rounds++;
        const messages=protocol==='chat'?payload.messages:payload.input;
        if(rounds===1)return responseFor(dsml,protocol,stream);
        assert.doesNotMatch(JSON.stringify(messages.filter(message=>message.role!=='system')),/DSML/);
        if(rounds===2){
          assert.match(JSON.stringify(messages),/测试电竞赛程公告/);
          const call={id:'page_check',name:'read_webpage',arguments:'{"url":"https://fixture.example/esports"}'};
          return Response.json(protocol==='chat'?{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}]}}]}:{status:'completed',output:[{type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments}]});
        }
        assert.equal(rounds,3);assert.match(JSON.stringify(messages),/决赛将在周日举行/);
        return responseFor('查到赛事公告，决赛将在周日举行。',protocol,stream);
      }});
    const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost').pathname));
    t.after(async()=>{await routes.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const host=`127.0.0.1:${server.address().port}`,headers={cookie:'__Host-freecamera=ok',origin:`https://${host}`,'content-type':'application/json'};
    const post=(route,body)=>fetch(`http://${host}/api/assistant/${route}`,{method:'POST',headers,body:JSON.stringify(body)});
    const saved=await post('settings',{name:'小鲸鱼',prompt:'自然聊天',memory:'',memoryMode:'off',provider:'custom',baseUrl:'https://fixture.example/v1',protocol,model:'fixture',apiKey:'fake-secret'});assert.equal(saved.status,200);
    const response=await post('chat',{messages:[{role:'user',content:'查询一下电竞圈现在的新闻'}],stream});
    const raw=await response.text();assert.equal(response.status,200,raw);
    let reply,used=[];const visible=[];
    if(stream){reply=await readChatReply(new Response(raw),{onDelta:text=>visible.push(text),onTool:tool=>used.push(tool)});assert.equal(visible.join(''),reply);}
    else{const result=JSON.parse(raw);reply=result.reply;used=result.toolsUsed;}
    assert.equal(reply,'查到赛事公告，决赛将在周日举行。');
    assert.deepEqual(used.map(tool=>[tool.name,tool.ok]),[['web_search',true],['read_webpage',true]]);
    assert.equal(used[0].sources[0].url,'https://fixture.example/esports');
    assert.equal(searches,1);assert.equal(pages,1);assert.equal(rounds,3);
    assert.doesNotMatch(raw,/DSML|电竞 最新新闻|fake-secret|arguments/);
  });
}

test('DSML compatibility accepts complete readonly packets only when the capability is offered',async()=>{
  for(const packet of [dsml,dsml.replaceAll('｜｜','|'),'我查一下当前新闻。\n'+dsml]){
    const round=await readModelRound(responseFor(packet,'chat',false),'chat',{allowTools:true,toolDefinitions:[definition]});
    assert.equal(round.answer,'');assert.equal(round.calls.length,1);assert.equal(round.calls[0].name,'web_search');assert.deepEqual(JSON.parse(round.calls[0].arguments),{query:'电竞 最新新闻'});
  }
  const unsafe=[dsml.slice(0,-10),'```xml\n'+dsml+'\n```',dsml+' 普通正文',dsml.replace('web_search','open_application'),dsml.replace('name="query"','name="__proto__"'),dsml.replace('电竞 最新新闻','x'.repeat(4097)),dsml.replace('string="true"','string="false"')];
  for(const packet of unsafe)await assert.rejects(readModelRound(responseFor(packet,'chat',false),'chat',{allowTools:true,toolDefinitions:[definition]}));
  for(const options of [{allowTools:true},{allowTools:true,toolDefinitions:[]},{allowTools:false,toolDefinitions:[definition]}])await assert.rejects(readModelRound(responseFor(dsml,'chat',false),'chat',options));
});

for(const protocol of ['chat','responses']) for(const stream of [false,true]) {
  test(`${protocol} ${stream?'SSE':'JSON'} failed search continuation releases the same session for ordinary chat`,async t=>{
    const {createAssistantRoutes}=await import('../server/assistant-routes.js');
    const dir=await mkdtemp(path.join(tmpdir(),'atb-search-next-turn-'));
    let requests=0,searches=0;
    const routes=await createAssistantRoutes({dataDir:dir,accounts:{session:token=>token==='ok'?{user:{username:'fixture'}}:null},
      companionRequest:async()=>{searches++;return new Response('<rss><channel/></rss>');},
      request:async(_url,options)=>{
        requests++;
        if(requests===1)return responseFor(dsml,protocol,stream);
        const payload=JSON.parse(options.body),history=protocol==='chat'?payload.messages.filter(m=>m.role!=='system'):payload.input;
        if(requests===2){assert.match(JSON.stringify(history),/search-unavailable/);return new Response('',{status:503});}
        assert.equal(requests,3);assert.deepEqual(history,[{role:'user',content:'午饭吃什么'}]);
        return responseFor('午饭吃面吧。',protocol,stream);
      }});
    const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost').pathname));
    t.after(async()=>{await routes.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const host=`127.0.0.1:${server.address().port}`,headers={cookie:'__Host-freecamera=ok',origin:`https://${host}`,'content-type':'application/json'};
    const post=(route,body)=>fetch(`http://${host}/api/assistant/${route}`,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await post('settings',{name:'测试助手',prompt:'自然聊天',memory:'',memoryMode:'off',provider:'custom',baseUrl:'https://fixture.example/v1',protocol,model:'fixture',apiKey:'fake-secret'})).status,200);
    const failed=await post('chat',{messages:[{role:'user',content:'失败的搜索请求'}],stream});
    if(stream)await assert.rejects(readChatReply(failed),/HTTP 503/);
    else{assert.equal(failed.status,502);assert.match((await failed.json()).error,/HTTP 503/);}
    const recovered=await post('chat',{messages:[{role:'user',content:'失败的搜索请求'},{role:'user',content:'午饭吃什么'}],stream});
    assert.equal(recovered.status,200);
    assert.equal(stream?await readChatReply(recovered):(await recovered.json()).reply,'午饭吃面吧。');
    assert.equal(searches,1);assert.equal(requests,3);
  });
}

test('DSML preserves multiple readonly calls and raw query values without treating quoted examples as tools',async()=>{
  const packet='<|DSML|calls><|DSML|invoke name="web_search"><|DSML|parameter name="query" string="true">G2 &amp; Falcons | 赛程</|DSML|parameter></|DSML|invoke><|DSML|invoke name="current_time"></|DSML|invoke></|DSML|calls>';
  const round=await readModelRound(responseFor(packet,'responses',false),'responses',{allowTools:true,toolDefinitions:[definition,{name:'current_time',parameters:{type:'object',properties:{}}}]});
  assert.equal(round.calls.length,2);assert.notEqual(round.calls[0].id,round.calls[1].id);
  assert.deepEqual(JSON.parse(round.calls[0].arguments),{query:'G2 &amp; Falcons | 赛程'});assert.equal(round.calls[1].arguments,'{}');
  assert.deepEqual(round.output.map(item=>item.type),['function_call','function_call']);
  for(const value of ['示例：\n```\n'+dsml+'\n```','“'+dsml+'”',packet.replace('</|DSML|invoke>', '<|DSML|parameter name="query" string="true">重复参数</|DSML|parameter></|DSML|invoke>')]){
    await assert.rejects(readModelRound(responseFor(value,'responses',false),'responses',{allowTools:true,toolDefinitions:[definition]}));
  }
});

test('truncated DSML streams and cancelled streams cannot become executable searches',async()=>{
  const seen=[];
  const body=event({choices:[{delta:{content:dsml}}]});
  await assert.rejects(readModelRound(new Response(body,{headers:{'content-type':'text/event-stream'}}),'chat',{allowTools:true,toolDefinitions:[definition],onDelta:text=>seen.push(text)}));
  assert.equal(seen.join(''),'');
  const controller=new AbortController();controller.abort();
  await assert.rejects(readModelRound(responseFor(dsml,'chat',false),'chat',{allowTools:true,toolDefinitions:[definition],signal:controller.signal}));
});

test('DSML search failure returns to the model and finishes instead of retrying or hanging',async t=>{
  const {createDshAgent}=await import('../server/dsh-agent.js'),{createAgentTools}=await import('../server/agent-tools.js');
  let requests=0,searches=0;
  const registry=createAgentTools({readOnly:{definitions:[]},dataDir:'unused',request:async()=>{searches++;return new Response('<rss><channel/></rss>');}});
  const agent=createDshAgent({request:async(_url,options)=>{
    requests++;if(requests===1)return responseFor(dsml,'chat',true);
    assert.equal(requests,2);assert.match(JSON.parse(options.body).messages.at(-1).content,/search-unavailable/);
    return responseFor('搜索没有返回可核实结果，暂时查不到。','chat',true);
  }});t.after(()=>agent.close());
  const result=await agent.run({url:'https://fixture.example',protocol:'chat',signal:AbortSignal.timeout(10000),options:{body:'{"messages":[{"role":"user","content":"查电竞新闻"}]}'},registry});
  assert.equal(result.answer,'搜索没有返回可核实结果，暂时查不到。');assert.equal(result.toolsUsed[0].ok,false);assert.equal(searches,1);assert.equal(requests,2);
});

test('repeated DSML searches obey the final no-tools round and disabled search cannot execute',async t=>{
  const {createDshAgent}=await import('../server/dsh-agent.js');
  for(const enabled of [true,false]){
    let requests=0,executions=0;
    const agent=createDshAgent({request:async(_url,options)=>{requests++;if(enabled&&requests===7)assert.equal(JSON.parse(options.body).tools,undefined);return responseFor(dsml,'chat',false);}});t.after(()=>agent.close());
    await assert.rejects(agent.run({url:'https://fixture.example',protocol:'chat',signal:AbortSignal.timeout(10000),options:{body:'{"messages":[{"role":"user","content":"查电竞新闻"}]}'},registry:{definitions:enabled?[definition]:[],execute:async()=>{executions++;return{ok:true,data:{items:[]}};}}}));
    assert.equal(executions,enabled?6:0);assert.equal(requests,enabled?7:1);
  }
});

test('cancelling a DSML search prevents late tool results from restarting the model',async t=>{
  const {createDshAgent}=await import('../server/dsh-agent.js');const abort=new AbortController();let entered,release,requests=0;
  const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const agent=createDshAgent({request:async()=>{requests++;return responseFor(dsml,'responses',true);}});t.after(()=>agent.close());
  const job=agent.run({url:'https://fixture.example',protocol:'responses',signal:abort.signal,options:{body:'{"input":[{"role":"user","content":"查电竞新闻"}]}'},registry:{definitions:[definition],execute:async()=>{entered();await held;return{ok:true,data:{title:'迟到结果'}};}}});
  const rejected=assert.rejects(job);
  await Promise.race([started,rejected.then(()=>{throw Error('execution ended before entering the search');})]);
  abort.abort();release();await rejected;assert.equal(requests,1);
});
