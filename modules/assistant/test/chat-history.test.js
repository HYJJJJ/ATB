import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatHistory} from '../public/chat-history.js';

function fixture() {
  const values=new Map(),queues=new Map();
  const storage=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)});
  const host=()=>Object.assign(new EventTarget(),{localStorage:storage(values),sessionStorage:storage(new Map()),navigator:{locks:{request(name,run){const task=(queues.get(name)||Promise.resolve()).then(run);queues.set(name,task.catch(()=>{}));return task;}}}});
  return {host};
}

test('legacy main history migrates even when the companion opened first, once only, and clear never resurrects it',async()=>{
  const f=fixture(),widget=createChatHistory({host:f.host()}),mainHost=f.host(),main=createChatHistory({host:mainHost});
  await widget.open('alice');
  await widget.save([{id:'new-widget',role:'assistant',content:'刚刚的摆件回答'}]);
  mainHost.sessionStorage.setItem('homebase.chat.alice',JSON.stringify([{role:'user',content:'原来的问题'},{role:'assistant',content:'原来的回答'}]));
  await main.open('alice');assert.deepEqual(main.read().messages.map(m=>m.content),['原来的问题','原来的回答','刚刚的摆件回答']);
  main.close();await main.open('alice');assert.equal(main.read().messages.length,3);
  await main.clear();main.close();await main.open('alice');assert.equal(main.read().messages.length,0);
  const lateHost=f.host();lateHost.sessionStorage.setItem('homebase.chat.alice',JSON.stringify([{role:'assistant',content:'旧窗口残留'}]));
  const late=createChatHistory({host:lateHost});await late.open('alice');assert.equal(late.read().messages.length,0);
});

test('concurrent windows merge by ID, bound history, isolate accounts and reject writes from before clearing or account switches',async()=>{
  const f=fixture(),first=createChatHistory({host:f.host()}),second=createChatHistory({host:f.host()});
  await Promise.all([first.open('alice'),second.open('alice')]);
  await Promise.all(Array.from({length:30},(_,index)=>(index%2?first:second).save([{id:'message-'+index,role:'assistant',content:'消息'+index}])));
  assert.equal(first.read().messages.length,30);assert.equal(second.read().messages.length,30);
  await first.save([{id:'message-0',role:'assistant',content:'消息0'}]);assert.equal(first.read().messages.length,30);
  await Promise.all(Array.from({length:30},(_,index)=>second.save([{id:'more-'+index,role:'assistant',content:'额外'+index}])));
  assert.equal(first.read().messages.length,40);
  const old=second.read().generation;
  let valid=true;const cancelled=second.save([{role:'assistant',content:'排队时已取消'}],old,()=>valid);valid=false;
  assert.equal(await cancelled,false);assert.equal(second.read().messages.some(m=>m.content==='排队时已取消'),false);
  await first.clear();assert.equal(await second.save([{role:'assistant',content:'迟到回复'}],old),false);
  assert.equal(first.read().messages.length,0);
  await second.save([{id:'old-opportunity',createdAt:1,role:'assistant',content:'历史主动消息'}]);assert.equal(second.read().messages.length,0);
  const queued=first.save([{role:'user',content:'旧账户待保存'}]);first.close();await first.open('bob');await queued;
  assert.equal(first.read().messages.length,0);assert.equal(second.read().messages.length,0);
  await first.save([{role:'user',content:'bob的问题',status:'pending'},{role:'assistant',content:'未完成半句',status:'pending'},{role:'user',content:'失败请求',status:'failed'}]);
  assert.deepEqual(first.read().messages.map(m=>m.content),['失败请求']);assert.equal(second.read().messages.length,0);
});
