// Polling checks a durable random due time. It never schedules a model wake itself.
export function createOpportunityClient({request,state,onReply=()=>{},now=Date.now}){
 let job,lastPoll=0,closed=false,generation=0;
 return {
  cancel(){generation++;job?.abort();},
  close(){closed=true;this.cancel();},
  async poll(force=false){
   const initial=state();if(closed||job||!initial.enabled||!initial.visible||!initial.account||!force&&lastPoll&&now()-lastPoll<30000)return;
   lastPoll=now();const epoch=generation,controller=new AbortController();job=controller;
   try{
    const result=await request('/api/assistant/opportunity',{busy:Boolean(initial.busy)},controller.signal);
    const current=state();
    if(closed||controller.signal.aborted||epoch!==generation||!current.enabled||!current.visible||current.busy||current.account!==initial.account)return;
    if(typeof result.reply==='string'&&result.reply.trim())await onReply(result.reply,result);
   }catch{/* none, cancellation and transient delivery failure never trigger a retry or alarm */}
   finally{if(job===controller)job=null;}
  },
 };
}

export function backgroundOpportunityState({assistant,presence,person,account,foregroundBusy,voiceActive,openingActive,matched,present,fresh}){
 const guarded=Boolean(presence?.enabled);
 return {account,enabled:Boolean(assistant?.proactiveChat&&(!guarded||presence.proactiveEnabled&&person?.isSelf&&person.active)),visible:!guarded||Boolean(matched&&present&&fresh),busy:Boolean(foregroundBusy||voiceActive||openingActive)};
}
