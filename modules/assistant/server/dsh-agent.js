import http from 'node:http';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { AiError } from '../../../server/ai-settings.js';
import { readModelRound } from './model-stream.js';
const require=createRequire(import.meta.url);
const runtime=()=>path.join(path.dirname(require.resolve('node/package.json')),'bin',process.platform==='win32'?'node.exe':'node');
const textOf=message=>message.content?.filter(block=>block.type==='text').map(block=>block.text).join('')||'';
const disabled=['llm-deepseek','persistent-bash','persistent-pwsh','tool-fs','tool-working-directory','terminal-bash','terminal-pwsh','compaction-basic','image-offload','llm-retry'];
export function dshToolLimits(registry) {
  return registry.definitions.some(tool=>tool.name==='desktop_interact')?{rounds:12,calls:12}:{rounds:6,calls:6};
}
const sourcesOf=result=>{
  const data=result?.data;
  return (data?.items || (data?[data]:[])).slice(0,6).map(item=>Object.fromEntries(Object.entries({title:item.title,source:item.source,url:item.url||item.sourceUrl,checkedAt:item.checkedAt,publishedAt:item.publishedAt}).filter(([,v])=>typeof v==='string')));
};
async function terminate(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.send?.({type:'stop'},()=>{});
  let timer;
  const exited=await Promise.race([once(child,'exit').then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),4000);})]);clearTimeout(timer);
  if(exited)return;
  // Only our exact owned process tree; never match application names or other users' instances.
  if(process.platform==='win32')await new Promise(resolve=>{const kill=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.on('error',resolve);kill.on('exit',resolve);});
  else child.kill('SIGKILL');
  if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');
}

export function createDshAgent({request}) {
  const runs=new Map();let closing=false;
  return {
    async run({url,options,protocol,registry,onDelta,onTool,signal=options.signal,check=()=>{}}) {
      if(closing)throw new AiError('助手执行器已关闭',503);
      const controller=new AbortController();let disposed;const done=new Promise(resolve=>disposed=resolve);runs.set(controller,done);
      const merged=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
      const guard=()=>{merged.throwIfAborted();check();};
      let child,server,home,stopTask,hostError,answer='',modelRounds=0,toolCalls=0,budgetClosed=false;
      const toolsUsed=[],wireReplies=new Map(),seen=new Set();
      const limits=dshToolLimits(registry),modelLimit=limits.rounds+1;
      const stop=()=>stopTask??=(child?terminate(child):Promise.resolve());
      try {
        guard();home=await mkdtemp(path.join(tmpdir(),'atb-dsh-'));
        const payload=JSON.parse(options.body),responses=protocol==='responses';
        const prior=responses?payload.input:payload.messages.filter(m=>m.role!=='system');
        const seed=prior.slice(0,-1),input=prior.at(-1)?.content;
        const instructions=responses?payload.instructions:payload.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
        const patch=path.join(home,'atb.patch.yml');
        await writeFile(patch,JSON.stringify([...disabled.map(id=>({id,disabled:true})),{id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:instructions}},{insert:[{id:'atb-bridge',name:fileURLToPath(new URL('./dsh-bridge-plugin.js',import.meta.url))}]}]),{mode:0o600});
        const token=randomBytes(32).toString('hex');
        server=http.createServer(async(req,res)=>{
          const reply=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}};
          try {
            guard();if(req.method!=='POST'||req.headers.authorization!=='Bearer '+token){reply(403,{});return;}
            const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>512000)throw Error('bridge-size');chunks.push(part);}
            const body=JSON.parse(Buffer.concat(chunks).toString());guard();
            if(req.url==='/definitions'){reply(200,{tools:registry.definitions});return;}
            if(req.url==='/tool'){
              if(seen.has(body.id)||!registry.definitions.some(t=>t.name===body.name))throw new AiError('工具调用超出限制，未执行。',502);
              seen.add(body.id);let result;
              if(budgetClosed||toolCalls>=limits.calls)result={ok:false,error:'tool-budget-exhausted',message:'本轮查询预算已用完，此批额外工具未执行。请根据已有结果回答，不继续查询。'};
              else {toolCalls++;result=await registry.execute(body,{signal:merged,check:guard});}guard();
              const used={name:body.name,ok:result.ok!==false,...(result.error?{error:result.error}:{}),sources:sourcesOf(result)};
              toolsUsed.push(used);await onTool?.(used);guard();reply(200,result);return;
            }
            if(req.url!=='/model')throw Error('bridge-route');
            if(++modelRounds>modelLimit)throw new AiError('模型工具调用达到限制。',502);
            const messages=[];
            for(const m of body.messages||[]){
              if(m.role==='system'||m.role==='developer'||m.source?.kind==='runtime-context')continue;
              if(m.role==='assistant'){
                const calls=m.content.filter(b=>b.type==='tool-call'),wire=wireReplies.get(calls[0]?.id);
                if(responses){if(wire?.output?.length)messages.push(...wire.output);else if(textOf(m))messages.push({role:'assistant',content:textOf(m)});}
                else messages.push({role:'assistant',content:textOf(m)||null,...(wire?.assistant?.reasoning_content?{reasoning_content:wire.assistant.reasoning_content}:{}),...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}))}:{})});
              }else if(m.role==='tool')messages.push(responses?{type:'function_call_output',call_id:m.toolCallId,output:textOf(m)}:{role:'tool',tool_call_id:m.toolCallId,content:textOf(m)});
              else if(textOf(m))messages.push({role:m.role,content:textOf(m)});
            }
            const tools=(body.tools||[]).filter(t=>registry.definitions.some(def=>def.name===t.name));
            const finalRound=modelRounds===modelLimit||budgetClosed||toolCalls>=limits.calls;
            const budget=finalRound?'本轮工具查询已结束。请根据已有工具结果直接回答用户，不再请求工具。只说明已核实的内容；没有可靠结果就明确说暂时查不到，不编造，不把搜索抓取时间当新闻发布时间。':`本轮最多${limits.calls}次工具调用，当前还可调用${limits.calls-toolCalls}次。结果足够就直接回答；避免反复查询相同内容，失败如实说明。新闻需要核对来源和发布日期，不能把旧网页当近期新闻。`;
            const prompt=instructions+'\n\n'+budget;
            const next={...payload,...(responses?{instructions:prompt,input:[...seed,...messages]}:{messages:[{role:'system',content:prompt},...seed,...messages]}),tools:tools.map(t=>responses?{type:'function',...t,strict:false}:{type:'function',function:t}),parallel_tool_calls:false,...(responses?{include:['reasoning.encrypted_content']}:{})};
            // A few compatible gateways ignore tool_choice:none while a catalogue is
            // still present. The reserved final request offers no tools at all.
            if(finalRound){delete next.tools;delete next.tool_choice;delete next.parallel_tool_calls;}
            const response=await request(url,{...options,signal:merged,headers:{...options.headers,'User-Agent':'atb/0.7.0 (DeepSeek Harness)'},body:JSON.stringify(next)});guard();
            if(!response.ok){response.cancel?.();throw new AiError(`模型服务返回 HTTP ${response.status}，未自动重试。`,502);}
            const round=await readModelRound(response,protocol,{allowTools:true,toolDefinitions:finalRound?[]:tools,signal:merged,onDelta:async text=>{guard();answer+=text;if(answer.length>16000)throw new AiError('模型回复过长。',502);await onDelta?.(text);}});guard();
            if(finalRound&&round.calls.length)throw new AiError('模型工具调用达到限制，额外工具未执行。',502);
            // Decline the whole over-budget batch, report real tool failures to
            // DSH, and keep the reserved answer round instead of losing evidence.
            if(toolCalls+round.calls.length>limits.calls)budgetClosed=true;
            for(const call of round.calls){if(!registry.definitions.some(t=>t.name===call.name))throw new AiError('模型请求了未接入的工具，未执行。',502);if(wireReplies.has(call.id))throw new AiError('模型重复工具标识，未执行。',502);wireReplies.set(call.id,round);}
            // Some JSON providers include visible content beside tool calls.
            reply(200,{answer:round.answer,calls:round.calls,reasoning:round.assistant?.reasoning_content});
          }catch(error){hostError=error;reply(500,{error:'bridge-failed'});}
        });
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});guard();
        child=fork(fileURLToPath(new URL('./dsh-runner.js',import.meta.url)),[],{execPath:runtime(),execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:KEY|TOKEN|SECRET|PASSWORD|DSH_|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/i.test(key)))});
        // Never echo runtime stderr: a third-party diagnostic could contain a credential.
        child.stderr.resume();
        const result=await new Promise((resolve,reject)=>{
          const abort=()=>{reject(merged.reason||Error('cancelled'));void stop();};merged.addEventListener('abort',abort,{once:true});
          const settle=(fn,value)=>{merged.removeEventListener('abort',abort);fn(value);};
          child.once('error',error=>settle(reject,error));child.once('exit',()=>settle(reject,hostError||new AiError('助手执行器提前退出，请检查工具连接。',502)));
          child.on('message',message=>{if(message.type==='done')settle(resolve,message);else if(message.type==='error')settle(reject,hostError||new AiError(message.error,502));});
          child.send({type:'run',home,patch,input,bridge:`http://127.0.0.1:${server.address().port}`,token,maxTokens:payload.max_tokens||payload.max_output_tokens||1024});if(merged.aborted)abort();
        });
        guard();if(['error','aborted'].includes(result.finishReason))throw hostError||new AiError('模型执行失败，请检查服务连接。',502);
        return {answer:answer||result.answer,toolsUsed};
      }finally{
        controller.abort();await stop();server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));
        try {if(home)await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}finally{runs.delete(controller);disposed();}
      }
    },
    async close(){closing=true;for(const run of runs.keys())run.abort();await Promise.allSettled([...runs.values()]);},
  };
}
