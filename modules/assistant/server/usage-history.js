import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import path from 'node:path';

const day = 86400000;
const decimal = value => typeof value === 'string' && /^-?\d{1,16}(?:\.\d{1,10})?$/.test(value) && Math.abs(Number(value)) <= 1e12;
const units = value => { const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');return (BigInt(whole)*10000000000n+BigInt(fraction.padEnd(10,'0')))*(negative?-1n:1n); };
// Balance snapshots contain no keys or chat. This is an explicitly labelled
// estimate: recharge/refund between samples can hide spending, never a bill.
export class BalanceHistory {
  constructor(file,{now=Date.now}={}) { this.file=file;this.now=now;this.series=[];this.writes=Promise.resolve(); }
  static async load(file,options) {
    const history=new BalanceHistory(file,options);
    try {
      const text=await readFile(file,'utf8');if(text.length>3*1024*1024)throw Error('invalid history');
      const saved=JSON.parse(text);
      if(saved.version!==1||!Array.isArray(saved.series)||saved.series.length>12)throw Error('invalid history');
      for(const item of saved.series){
        if(!/^[a-f0-9]{64}$/.test(item.id)||!['account','billing'].includes(item.scope)||!['CNY','USD'].includes(item.currency)||!Array.isArray(item.points)||item.points.length>2000)throw Error('invalid history');
        if(item.points.some((p,i)=>!Number.isSafeInteger(p.at)||!decimal(p.amount)||i&&p.at<=item.points[i-1].at))throw Error('invalid history');
      }
      history.series=saved.series;
    } catch(error) { if(error.code!=='ENOENT')throw Error('消费统计记录无法读取'); }
    return history;
  }
  observe(settings,balance) {
    const task=this.writes.catch(()=>{}).then(async()=>{
      if(!settings.baseUrl||!settings.apiKey||balance.kind!=='balance'||!['account','billing'].includes(balance.scope))return null;
      const amounts=balance.amounts||[],amount=amounts.find(a=>a.currency==='CNY'&&decimal(a.amount))||amounts.find(a=>a.currency==='USD'&&decimal(a.amount));
      const at=Date.parse(balance.checkedAt);
      if(!amount||!Number.isSafeInteger(at)||at>this.now()+60000)return null;
      const id=createHash('sha256').update(settings.baseUrl+'\0'+settings.apiKey).digest('hex');
      let series=this.series.find(s=>s.id===id),changed=false;
      if(!series||series.currency!==amount.currency||series.scope!==balance.scope){
        this.series=this.series.filter(s=>s.id!==id);series={id,currency:amount.currency,scope:balance.scope,points:[]};this.series.push(series);changed=true;
      }
      const previous=series.points.at(-1);
      if(!previous||at>previous.at){
        series.points.push({at,amount:amount.amount});changed=true;
        const first=series.points.findIndex(p=>p.at>=at-day);
        if(first>1)series.points.splice(0,first-1);
        series.points=series.points.slice(-2000);
      }
      if(changed){
        this.series.sort((a,b)=>(b.points.at(-1)?.at||0)-(a.points.at(-1)?.at||0));this.series=this.series.slice(0,12);
        await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
        await writeFile(this.file+'.tmp',JSON.stringify({version:1,series:this.series}),{mode:0o600});await rename(this.file+'.tmp',this.file);
      }
      const last=series.points.at(-1),cutoff=last.at-day;let total=0n;
      for(let i=1;i<series.points.length;i++){
        const before=series.points[i-1],after=series.points[i];
        if(before.at<cutoff)continue;
        const decrease=units(before.amount)-units(after.amount);if(decrease>0n)total+=decrease;
      }
      const observedSeconds=Math.floor((last.at-Math.max(series.points[0].at,cutoff))/1000);
      return {kind:observedSeconds>0?'estimate':'collecting',scope:series.scope,currency:series.currency,...(observedSeconds>0?{amount:(Number(total)/1e10).toFixed(2)}:{}),observedSeconds,method:'balance-decrease',periodStart:new Date(Math.max(series.points[0].at,cutoff)).toISOString(),periodEnd:new Date(last.at).toISOString(),checkedAt:new Date(last.at).toISOString()};
    });this.writes=task;return task;
  }
}
