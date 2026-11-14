// Loaded only inside the private DSH runtime. The host owns credentials and I/O.
import { LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';

export const name = 'atb-assistant-bridge';
export const inject = ['llm', 'tools'];
export async function apply(ctx) {
  const endpoint = process.env.ATB_DSH_BRIDGE;
  const token = process.env.ATB_DSH_TOKEN;
  const call = async (route, value, signal) => {
    const response = await fetch(endpoint + route, { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+token}, body:JSON.stringify(value), signal });
    if (!response.ok) throw Error('ATB bridge request failed');
    return response.json();
  };
  class Adapter extends LlmAdapter {
    providerRetryPolicy() { return resolveRetryPolicy({mode:'normal',maxRetries:0}, 'ATB'); }
    async *stream(options) {
      const result = await call('/model', { messages:options.messages, tools:options.tools }, options.signal);
      let index=0;
      const blocks = [ ...(result.reasoning ? [{type:'reasoning',text:result.reasoning}] : []), ...(result.answer ? [{type:'text',text:result.answer}] : []), ...result.calls.map(item=>({type:'tool-call',...item})) ];
      for (const block of blocks) {
        yield {type:'block-start',index,blockType:block.type};
        if (block.type==='text') yield {type:'text-delta',index,text:block.text};
        if (block.type==='reasoning') yield {type:'reasoning-delta',index,text:block.text};
        if (block.type==='tool-call') yield {type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};
        yield {type:'block-end',index,block}; index++;
      }
      yield {type:'finish',reason:{kind:result.calls.length?'tool-calls':'stop'}};
    }
  }
  ctx.llm.registerAdapter(['atb'],new Adapter());
  const {tools}=await call('/definitions',{});
  for (const tool of tools) ctx.tools.register({ ...tool,
    output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:async(args,exec)=>call('/tool',{name:tool.name,arguments:JSON.stringify(args),id:exec.callId},exec.signal),
  });
}
