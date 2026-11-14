import {cleanModelText} from '../../../public/model-content.js';
const silent=()=>({action:'none'});
export async function executeOpportunityAction(choice,{adapters={},signal,check=()=>true,maxDurationMs=600000,approval}={}){
 const adapter=adapters[choice.action];if(!adapter)throw Error('action-unavailable');
 if(adapter.permission==='write'&&(!approval||await approval(choice)!==true))throw Error('owner-approval-required');
 if(!['read','long','write'].includes(adapter.permission))throw Error('permission-required');
 const deadline=AbortSignal.timeout(Math.min(600000,Math.max(1,maxDurationMs)));
 const combined=AbortSignal.any([deadline,...(signal?[signal]:[])]);
 combined.throwIfAborted();if(!check())throw Error('cancelled');
 let abort;const cancelled=new Promise((_,reject)=>{abort=()=>reject(Error('action-cancelled'));combined.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([adapter.run(choice,{signal:combined,check,maxDurationMs:Math.min(600000,maxDurationMs)}),cancelled]);}finally{combined.removeEventListener('abort',abort);}
}
export function createOpportunityAgent({request,adapters={}}){return {
 async decide(settings,{prompt,context='',chatAllowed=false,signal}={}){
  const actions=['none',...(chatAllowed?['chat']:[]),...Object.entries(adapters).filter(([key,value])=>['browse','game'].includes(key)&&['read','long'].includes(value.permission)).map(([key])=>key)];
  const tool={name:'opportunity_decide',description:'表达你自己的选择，none是正常选择，无需解释。chat的text才会发给主人。仅使用实际可用能力，不把计划说成已完成。',parameters:{type:'object',properties:{action:{type:'string',enum:actions},text:{type:'string',maxLength:1200},pendingThought:{type:'string',maxLength:200}},required:['action'],additionalProperties:false}};
  const responses=settings.protocol==='responses';
  const history=[{role:'system',content:[settings.prompt||'',settings.name?'助手名称：'+settings.name:'',context,'这是可选机会。只有结构化选择会执行；未提供的能力不可使用，不假称已经浏览、发帖或游戏。没有新用户发言，不从沉默推断情绪。'].filter(Boolean).join('\n\n')},{role:'user',content:prompt}];
  const payload={model:settings.model,...(responses?{input:history,store:false,max_output_tokens:600}:{messages:history,max_tokens:600}),stream:false,tools:[responses?{type:'function',...tool,strict:false}:{type:'function',function:tool}],parallel_tool_calls:false};
  const response=await request(settings.baseUrl.replace(/\/+$/,'')+'/'+(responses?'responses':'chat/completions'),{method:'POST',signal,headers:{Authorization:'Bearer '+settings.apiKey,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});
  if(!response.ok){response.cancel?.();throw Error('opportunity-provider-unavailable');}
  const data=await response.json();signal?.throwIfAborted();
  const calls=responses?(data.output||[]).filter(item=>item?.type==='function_call').map(item=>({name:item.name,arguments:item.arguments})):(data.choices?.[0]?.message?.tool_calls||[]).map(item=>item?.type==='function'?item.function:{});
  if(calls.length!==1||calls[0].name!=='opportunity_decide'||typeof calls[0].arguments!=='string'||calls[0].arguments.length>8000)return silent();
  let choice;try{choice=JSON.parse(calls[0].arguments);}catch{return silent();}
  if(!choice||Array.isArray(choice)||!actions.includes(choice.action)||Object.keys(choice).some(k=>!['action','text','pendingThought'].includes(k)))return silent();
  if(choice.action==='chat'){
   if(typeof choice.text!=='string'||!choice.text.trim()||Array.from(choice.text).length>1200)return silent();
   const cleaned=cleanModelText(choice.text);if(cleaned.removed||!cleaned.content.trim())return silent();choice.text=cleaned.content;
  }
  if(choice.pendingThought!==undefined&&(typeof choice.pendingThought!=='string'||Array.from(choice.pendingThought).length>200))return silent();
  return choice;
 },
 execute:(choice,options)=>executeOpportunityAction(choice,{...options,adapters}),
};}
