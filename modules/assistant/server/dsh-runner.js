// Private Node 24 entry; stdout carries only our bounded result, never diagnostics.
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client';
let harness, stopping=false;
async function stop() { if(stopping)return;stopping=true;try{await harness?.close();}finally{process.disconnect?.();} }
process.on('disconnect',()=>void stop());
process.on('message',async message=>{
  if(message.type==='stop'){await stop();return;}
  if(message.type!=='run'||harness)return;
  try {
    harness=new DeepSeekHarness({profile:'sdk-minimal',dshHome:message.home,patches:[message.patch],processCwd:message.home,cwd:message.home,provider:'atb',model:'configured-model',maxTokens:message.maxTokens,
      env:{...process.env,ATB_DSH_BRIDGE:message.bridge,ATB_DSH_TOKEN:message.token},initializeTimeoutMs:20000,shutdownTimeoutMs:500,disposeEofGraceMs:1000,disposeGraceMs:1500});
    await harness.start();
    const session=harness.session(),subscription=harness.client.subscribeSessionTree(session.id);
    let finishReason;
    try {
      await harness.client.prompt(session.id,[{type:'text',text:message.input}]);
      await harness.client.request('session/wait',{sessionId:session.id});
      let notification;while((notification=subscription.tryNext())!==undefined){
        if(notification.method==='session.event'&&notification.params.sessionId===session.id){
          const event=validatedSessionEvent(notification.params.event);if(event.type==='turn/end')finishReason=event.data.reason.kind;
        }
      }
      if(!finishReason||['error','aborted'].includes(finishReason))throw Error('incomplete-turn');
      if(!stopping)process.send?.({type:'done',finishReason});
    } finally {subscription.close();}
  }catch{if(!stopping)process.send?.({type:'error',error:'DSH 执行失败，请检查模型工具支持与工具连接。'});}
  finally{await stop();}
});
