import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const factory=()=>require('../desktop/desktop-automation.cjs').createDesktopAutomation;
const setup=(confirm=async()=>true,initialValue='')=>{
  const calls=[];let time=1000,value=initialValue;
  const execute=factory()({now:()=>time,confirm,run:async request=>{
    calls.push(request);
    if(request.action==='windows')return{ok:true,windows:[{handle:'123',pid:10,start:'100',title:'隔离测试记事本',process:'fixture'}]};
    if(request.action==='snapshot')return{ok:true,inputsComplete:true,inputs:[{runtimeId:'1.2.3',name:'编辑器',value}],nodes:[{runtimeId:'1.2.3',name:'编辑器',type:'Edit',value,actions:['set_value','focus']},{runtimeId:'1.2.4',name:'发送',type:'Button',actions:['invoke']}]};
    if(request.action==='interact'&&request.operation==='invoke'&&request.expectedInputs?.[0]?.value!==value)return{ok:false,error:'desktop-control-unavailable'};
    return{ok:true,message:'已完成控件操作'};
  }});
  return{execute,calls,advance:()=>time+=61000,changeValue:next=>value=next};
};
async function snapshot(h,context={scope:'one'}){
  const list=await h.execute('desktop_windows',{query:'隔离'},context);assert.equal(list.ok,true);
  const value=await h.execute('desktop_snapshot',{windowId:list.data.windows[0].id},context);assert.equal(value.ok,true);return value.data;
}
test('desktop automation uses fresh scoped control references and confirms actual mutations',async()=>{
  const confirmations=[],h=setup(async details=>{confirmations.push(details);return true;}),snap=await snapshot(h);
  assert.doesNotMatch(JSON.stringify(snap),/runtimeId|"handle"/);
  assert.equal((await h.execute('desktop_interact',{snapshotId:snap.snapshotId,targetId:snap.controls[0].id,action:'set_value',text:'你好，123'},{scope:'other'})).ok,false);
  const result=await h.execute('desktop_interact',{snapshotId:snap.snapshotId,targetId:snap.controls[0].id,action:'set_value',text:'你好，123'},{scope:'one'});
  assert.equal(result.ok,true);assert.equal(confirmations.length,1);assert.match(confirmations[0].detail,/你好，123/);
  assert.equal(h.calls.at(-1).runtimeId,'1.2.3');assert.equal(h.calls.at(-1).text,'你好，123');
  assert.equal((await h.execute('desktop_interact',{snapshotId:snap.snapshotId,targetId:snap.controls[0].id,action:'set_value',text:'第二次'},{scope:'one'})).ok,false,'consumed snapshots cannot replay actions');
});
test('cancellation, rejection and expired snapshots cannot click a control',async()=>{
  let confirmDone;const h=setup(()=>new Promise(resolve=>confirmDone=resolve)),snap=await snapshot(h),abort=new AbortController();
  const pending=h.execute('desktop_interact',{snapshotId:snap.snapshotId,targetId:snap.controls[1].id,action:'invoke'},{scope:'one',signal:abort.signal});
  await new Promise(r=>setImmediate(r));abort.abort();confirmDone(true);await assert.rejects(pending);assert.equal(h.calls.filter(c=>c.action==='interact').length,0);
  const denied=setup(async()=>false),s=await snapshot(denied);assert.equal((await denied.execute('desktop_interact',{snapshotId:s.snapshotId,targetId:s.controls[1].id,action:'invoke'},{scope:'one'})).error,'user-cancelled');
  const stale=setup(),old=await snapshot(stale);stale.advance();assert.equal((await stale.execute('desktop_interact',{snapshotId:old.snapshotId,targetId:old.controls[1].id,action:'invoke'},{scope:'one'})).ok,false);
});
test('approval includes the complete input and refuses a changed pending message',async()=>{
  const text='完整内容'.repeat(70)+'结尾必须确认',approvals=[];
  const h=setup(async details=>{approvals.push(details);h.changeValue('确认期间被替换');return true;},text),snap=await snapshot(h);
  assert.ok(snap.controls[0].value.length<=160,'model snapshot remains bounded');
  const result=await h.execute('desktop_interact',{snapshotId:snap.snapshotId,targetId:snap.controls[1].id,action:'invoke'},{scope:'one'});
  assert.ok(approvals[0].detail.includes(text),'approval must show text beyond the model preview');
  assert.equal(h.calls.at(-1).expectedInputs[0].value,text,'native executor must recheck exact approved inputs');
  assert.equal(result.ok,false,'changed pending text must not be sent');
});
