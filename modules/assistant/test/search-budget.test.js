import test from 'node:test';
import assert from 'node:assert/strict';
import {createDshAgent} from '../server/dsh-agent.js';

const tools=[{name:'web_search',description:'查找公开新闻',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}];
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
function response(protocol,stream,call,answer=''){
  if(!stream)return Response.json(protocol==='chat'?{choices:[{finish_reason:call?'tool_calls':'stop',message:call?{tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}]}:{content:answer}}]}:{status:'completed',output:call?[{type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments}]:[{type:'message',content:[{type:'output_text',text:answer}]}]});
  const frames=protocol==='chat'?(call?[{choices:[{delta:{tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}]}}]},{choices:[{delta:{},finish_reason:'tool_calls'}]}]:[{choices:[{delta:{content:answer}}]},{choices:[{delta:{},finish_reason:'stop'}]}]):(call?[{type:'response.output_item.added',output_index:0,item:{type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments}},{type:'response.completed',response:{status:'completed'}}]:[{type:'response.output_text.delta',delta:answer},{type:'response.completed',response:{status:'completed'}}]);
  return new Response(frames.map(event).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}

test('an oversized remaining batch is declined and still reaches the reserved final answer',async t=>{
  let requests=0,executed=0;
  const agent=createDshAgent({request:async(_url,options)=>{
    const body=JSON.parse(options.body);requests++;
    if(requests===7){assert.equal(body.tools,undefined);assert.match(JSON.stringify(body.messages),/tool-budget-exhausted/);return response('chat',false,null,'已核实五个来源，额外查询未执行。');}
    const calls=Array.from({length:requests===6?3:1},(_,i)=>({id:`batch_${requests}_${i}`,type:'function',function:{name:'web_search',arguments:JSON.stringify({query:`新闻 ${requests} ${i}`})}}));
    return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:calls}}]});
  }});t.after(()=>agent.close());
  const result=await agent.run({url:'https://fixture.example',protocol:'chat',signal:AbortSignal.timeout(20000),options:{body:'{"messages":[{"role":"user","content":"核实新闻"}]}'},registry:{definitions:tools,execute:async()=>{executed++;return{ok:true,data:{title:'真实来源'}};}}});
  assert.equal(executed,5);assert.equal(requests,7);assert.equal(result.toolsUsed.filter(t=>t.ok===false).length,3);assert.match(result.answer,/额外查询未执行/);
});
for(const protocol of ['chat','responses'])for(const stream of [false,true]){
  test(`${protocol} ${stream?'SSE':'JSON'} news search finishes with existing evidence when the tool budget ends`,async t=>{
    let requests=0,executed=0;const visible=[];
    const agent=createDshAgent({request:async(_url,options)=>{
      const body=JSON.parse(options.body);requests++;
      // Some compatible gateways honor the offered catalogue, but ignore tool_choice.
      if(body.tools?.length)return response(protocol,stream,{id:'news_'+requests,name:'web_search',arguments:JSON.stringify({query:'英雄联盟 新闻 '+requests})});
      assert.equal(body.tool_choice,undefined,'the final request is a plain answer request');
      assert.equal(body.parallel_tool_calls,undefined);
      assert.match(protocol==='chat'?body.messages[0].content:body.instructions,/根据已有.*结果/);
      const messages=protocol==='chat'?body.messages:body.input;
      assert.match(JSON.stringify(messages),/已查证的赛事公告/);
      return response(protocol,stream,null,'查到赛事公告；其他近期动态尚未核实。');
    }});t.after(()=>agent.close());
    const result=await agent.run({url:'https://fixture.example',protocol,signal:AbortSignal.timeout(20000),options:{body:JSON.stringify(protocol==='chat'?{messages:[{role:'system',content:'仅根据核实的来源回答'},{role:'user',content:'查查英雄联盟相关新闻'}],stream}:{instructions:'仅根据核实的来源回答',input:[{role:'user',content:'查查英雄联盟相关新闻'}],stream})},registry:{definitions:tools,execute:async()=>{executed++;return {ok:true,data:{items:[{title:'已查证的赛事公告',url:'https://fixture.example/news',description:'隔离测试来源'}]}};}},onDelta:text=>visible.push(text)});
    assert.equal(executed,6);assert.equal(requests,7);assert.equal(result.toolsUsed.length,6);
    assert.equal(result.answer,'查到赛事公告；其他近期动态尚未核实。');assert.equal(visible.join(''),result.answer);
  });
}
