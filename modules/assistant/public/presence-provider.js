import {createOpportunityClient} from './opportunity-client.js';
import {createChatHistory} from './chat-history.js';
export async function activate({api} = {}) {
  const desktop = window.atbDesktop;
  const request = api || (async (url,body,signal) => { const response=await fetch(url,{signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(!response.ok)throw Error('request-failed');return response.json(); });
  let account,settings,presence,closed=false,checking=false,noticeTimer;
  const chatHistory=createChatHistory();
  const client=createOpportunityClient({request,state:()=>({enabled:Boolean(settings?.proactiveChat&&!desktop?.hasModule('assistant')),visible:!document.hidden,account,busy:false}),async onReply(text,result){
    if(result?.id)try{sessionStorage.setItem('homebase.opportunity.'+account,result.id);}catch{}
    await chatHistory.save([{id:'opportunity:'+result.id,createdAt:result.ts || Date.now(),role:'assistant',content:text}]);
    const notice=document.getElementById('notice');if(notice){notice.textContent=(settings.name||'小助手')+'：'+text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{if(notice.textContent.endsWith(text))notice.textContent='';},20000);}
  }});
  async function poll(){if(closed||checking||document.hidden)return;checking=true;try{
    const session=await request('/api/auth/session');if(closed)return;
    const next=session.user?.username;if(account!==next){client.cancel();chatHistory.close();}account=next;if(!account)return;
    await chatHistory.open(account);if(closed)return;
    [settings,presence]=await Promise.all([request('/api/assistant/settings'),request('/api/assistant/presence')]);if(closed)return;
    if((presence.enabled||settings.proactiveChat)&&desktop?.hasModule('assistant'))await desktop.invokeModule('assistant','presence',{action:'start'});
    if(desktop?.hasModule('assistant')){
      const saved=await request('/api/assistant/opportunity');const message=saved.lastChat;
      let seen;try{seen=sessionStorage.getItem('homebase.opportunity.'+account);}catch{}
      if(!closed&&message?.id&&message.ts>Date.now()-86400000&&seen!==message.id){
        try{sessionStorage.setItem('homebase.opportunity.'+account,message.id);}catch{}
        await chatHistory.save([{id:'opportunity:'+message.id,createdAt:message.ts,role:'assistant',content:message.text}]);
        // Recover conversation history silently. Fresh desktop messages are
        // delivered by the background runtime to the companion and speech;
        // replaying lastChat here turns every new window into an old greeting.
      }
    }
    await client.poll();
  }catch{client.cancel();}finally{checking=false;}}
  const visible=()=>{if(document.hidden)client.cancel();else void poll();};document.addEventListener('visibilitychange',visible);
  void poll();const timer=setInterval(poll,30000);
  return {close(){closed=true;client.close();chatHistory.dispose();clearInterval(timer);clearTimeout(noticeTimer);document.removeEventListener('visibilitychange',visible);}};
}
