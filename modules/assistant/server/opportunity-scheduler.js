import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {presenceContext,quietReason} from '../public/presence-state.js';
const MINUTE=60000;
const fresh=()=>({lastOpportunityAt:0,nextAt:0,todayCount:0,chatCount:0,day:'',lastAction:null,pendingThought:null,lastDialogueAt:0,outcomes:[]});
const keyFor=owner=>'private:'+createHash('sha256').update(owner).digest('hex');
const local=(p,at)=>presenceContext(p,at);
function nextDay(p,at){const day=local(p,at).date;for(let t=at+MINUTE;t<=at+27*60*MINUTE;t+=MINUTE)if(local(p,t).date!==day)return t;return at+24*60*MINUTE;}
export function wakePolicy(state,policy,at,{busy=false,dailyLimit=8}={}) {
 const lastDialogueAt=Math.max(state.lastDialogueAt||0,policy.lastInteraction||0,policy.lastGreeting||0);
 if(lastDialogueAt&&at-lastDialogueAt<5*MINUTE)return {reason:'recent-dialogue',nextAt:at+25*MINUTE};
 if(busy)return {reason:'busy',nextAt:at+25*MINUTE};
 if((policy.snoozeUntil||0)>at)return {reason:'snoozed',nextAt:policy.snoozeUntil};
 if(quietReason(policy,at)){
  // Scan local minutes rather than adding wall-clock hours: overnight/DST safe.
  for(let t=Math.floor(at/MINUTE)*MINUTE+MINUTE;t<=at+49*60*MINUTE;t+=MINUTE)if(!quietReason(policy,t))return {reason:'quiet',nextAt:t};
  return {reason:'quiet',nextAt:at+24*60*MINUTE};
 }
 if(state.todayCount>=dailyLimit)return {reason:'daily-cap',nextAt:nextDay(policy,at)};
 if(local(policy,at).state==='busy')return {reason:'owner-busy',nextAt:at+25*MINUTE};
 return null;
}
export function opportunityPrompt({time,minutes,platform}){return '【有一会儿空】\n现在是 '+time+'。主人上次说话是 '+minutes+' 分钟前。\n你可以：\n- 找他聊两句（他可能在忙）\n- 去 '+platform+' 逛逛\n- 干点别的\n- 什么都不做也行\n\n想做就做，不想做就继续待着。别为了"显得主动"硬找事。';}
export class OpportunityScheduler {
 constructor({dataDir,now=Date.now,random=Math.random}){this.file=path.join(dataDir,'state','proactive.json');this.now=now;this.random=random;this.state={version:1,conversations:{}};this.queue=Promise.resolve();this.jobs=new Map();this.closed=false;this.busy=new Map();}
 serial(work){const task=this.queue.catch(()=>{}).then(work);this.queue=task;return task;}
 async save(){await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});await writeFile(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600});await rename(this.file+'.tmp',this.file);}
 async start(){try{this.state=JSON.parse(await readFile(this.file,'utf8'));if(this.state.version!==1||!this.state.conversations||Array.isArray(this.state.conversations))throw Error('invalid opportunity state');for(const state of Object.values(this.state.conversations)){if(!Number.isFinite(state.nextAt)||!Array.isArray(state.outcomes))throw Error('invalid opportunity conversation');if(state.inFlight){this.log(state,{woke:true,action:'none',detail:'interrupted-on-restart',postponed:false,id:state.inFlight.id,roll:state.inFlight.roll,hit:true});delete state.inFlight;}}await this.save();}catch(e){if(e.code!=='ENOENT')throw e;}}
 stateFor(owner){const key=keyFor(owner);return this.state.conversations[key]??=(fresh());}
 log(state,item){state.outcomes.push({ts:this.now(),woke:false,action:'none',detail:'',postponed:false,...item});state.outcomes=state.outcomes.slice(-256);}
 interval(kind){const r=Math.max(0,Math.min(.999999999,Number(this.random())));return (kind==='game'?110+r*70:45+r*45)*MINUTE;}
 async status(owner){await this.queue.catch(()=>{});const state=this.state.conversations[keyFor(owner)]||fresh();const {inFlight,...publicState}=state;return structuredClone({...publicState,running:Boolean(inFlight),outcomes:state.outcomes.slice(-40)});}
 cancel(owner){this.jobs.get(owner)?.abort();}
 cancelAll(){for(const controller of this.jobs.values())controller.abort();}
 async touch(owner){this.cancel(owner);return this.serial(async()=>{this.stateFor(owner).lastDialogueAt=this.now();await this.save();});}
 begin(owner){this.cancel(owner);this.busy.set(owner,(this.busy.get(owner)||0)+1);}
 end(owner){const count=(this.busy.get(owner)||1)-1;if(count)this.busy.set(owner,count);else this.busy.delete(owner);}
 async run(owner,{enabled,policy={},probability=.55,dailyLimit=8,busy=false,kind='browse',decide,check=()=>true,signal,execute}={}){
  const empty={reply:''};if(busy)this.cancel(owner);if(this.closed||!enabled||!check()||signal?.aborted)return empty;
  policy={timeZone:'Asia/Shanghai',quietEnabled:true,quietStart:'01:00',quietEnd:'08:00',...policy};
  const controller=new AbortController();const jobSignal=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
  const reservation=await this.serial(async()=>{
   if(this.closed||!enabled||!check()||jobSignal.aborted)return null;
   const s=this.stateFor(owner),at=this.now(),day=local(policy,at).date;
   if(s.day!==day){s.day=day;s.todayCount=0;s.chatCount=0;}
   if(s.pendingThought?.expiresAt<=at)s.pendingThought=null;
   if(!s.nextAt){s.nextAt=at+this.interval(kind);await this.save();return null;}
   if(at<s.nextAt||s.inFlight||this.jobs.has(owner))return null;
   const postponed=wakePolicy(s,policy,at,{busy:busy||this.busy.has(owner),dailyLimit});
   if(postponed){s.nextAt=postponed.nextAt;if(postponed.reason==='daily-cap')s.nextAt+=this.interval(kind);this.log(s,{postponed:true,detail:postponed.reason});await this.save();return null;}
   const roll=this.random(),hit=roll<probability;s.lastOpportunityAt=at;s.nextAt=at+this.interval(kind);
   if(!hit){this.log(s,{roll,hit:false,detail:'dice-miss'});await this.save();return null;}
   const r={id:randomUUID(),roll,at,lastDialogueAt:s.lastDialogueAt,chatAllowed:s.chatCount<2,pendingThought:s.pendingThought};s.todayCount++;s.inFlight=r;
   // Persist claim and nextAt before calling the provider. Never replay a claimed wake.
   this.jobs.set(owner,controller);try{await this.save();}catch(error){this.jobs.delete(owner);delete s.inFlight;throw error;}return r;
  });
  if(!reservation)return {...empty,nextAt:(await this.status(owner)).nextAt};
  let choice={action:'none'},detail='none',reply='';
  const valid=()=>!this.closed&&!jobSignal.aborted&&check()&&!this.busy.has(owner);
  try{
   if(valid())choice=await this.wait(jobSignal,()=>decide({signal:jobSignal,chatAllowed:reservation.chatAllowed,pendingThought:reservation.pendingThought,prompt:opportunityPrompt({time:local(policy,this.now()).time,minutes:reservation.lastDialogueAt?Math.max(0,Math.floor((this.now()-reservation.lastDialogueAt)/MINUTE)):0,platform:'已接入的平台（未接入时不可浏览）'})}));
   if(!valid()){choice={action:'none'};detail='cancelled';}
   else if(choice?.action==='chat'){
    const s=this.stateFor(owner);
    const gate=wakePolicy({...s,todayCount:s.todayCount-1},policy,this.now(),{busy,dailyLimit});
    if(gate||!reservation.chatAllowed||s.chatCount>=2){choice={action:'none'};detail=gate?.reason||'chat-cap';}
    else if(typeof choice.text!=='string'||!choice.text.trim()){choice={action:'none'};detail='empty-choice';}
    else {reply=choice.text.trim().slice(0,1200);detail='owner-chat';}
   }else if(['browse','game'].includes(choice?.action)&&execute){await execute(choice,{signal:jobSignal,check:valid,maxDurationMs:600000});detail=choice.action==='game'?'game-completed':'browse-completed';}
   else if(choice?.action!=='none'){choice={action:'none'};detail='unavailable-action';}
  }catch{choice={action:'none'};reply='';detail=jobSignal.aborted?'cancelled':'decision-unavailable';}
  await this.serial(async()=>{
   const s=this.stateFor(owner);if(s.inFlight?.id!==reservation.id){reply='';return;}
   if(!valid()){reply='';choice={action:'none'};detail='cancelled';}
   const action=choice?.action==='chat'&&reply?'chat':['browse','game'].includes(choice?.action)?'browse':'none';
   if(action==='chat'){s.chatCount++;s.lastChat={id:reservation.id,ts:this.now(),text:reply};}
   s.lastAction={ts:this.now(),action};
   if(typeof choice?.pendingThought==='string'&&choice.pendingThought.trim())s.pendingThought={content:choice.pendingThought.slice(0,200),expiresAt:this.now()+120*MINUTE};
   this.log(s,{id:reservation.id,woke:true,action,detail,postponed:false,roll:reservation.roll,hit:true});delete s.inFlight;await this.save();
  });
  if(this.jobs.get(owner)===controller)this.jobs.delete(owner);
  return {reply,id:reservation.id,action:reply?'chat':choice?.action||'none',nextAt:(await this.status(owner)).nextAt};
 }
 async wait(signal,work){
  signal.throwIfAborted();let onAbort;
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Error('cancelled'));signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(work),aborted]);}finally{signal.removeEventListener('abort',onAbort);}
 }
 async close(){this.closed=true;this.cancelAll();await this.queue.catch(()=>{});}
}
