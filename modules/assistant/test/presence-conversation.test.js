import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceConversation } from '../public/presence-conversation.js';
import * as presence from '../public/presence-conversation.js';
import {createChatHistory} from '../public/chat-history.js';

test('failed background questions and errors remain visible but are excluded from the next model context',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const history=createChatHistory({host:Object.assign(new EventTarget(),{localStorage:storage,sessionStorage:storage})});await history.open('fixture');
  let calls=0;const chat=createPresenceConversation({history,request:async(_url,body)=>{
    calls++;if(calls===1)throw Error('模型接口 HTTP 503');
    assert.deepEqual(body.messages,[{role:'user',content:'午饭吃什么'}]);return {reply:'吃面吧'};
  }});
  await assert.rejects(chat.send('查英雄联盟新闻'),/HTTP 503/);
  assert.deepEqual(history.read().messages.map(m=>[m.role,m.status]),[['user','failed'],['assistant','failed']]);
  assert.match(history.read().messages[1].content,/HTTP 503/);
  await chat.send('午饭吃什么');assert.equal(history.read().messages.length,4);history.dispose();
});
test('background voice follow-up retains bounded questions and answers and clears on reset', async () => {
  const calls = [];
  const chat = createPresenceConversation({ request: async (_url, body) => { calls.push(body.messages); return { reply: '回答' + calls.length }; } });
  await chat.send('第一个问题'); await chat.send('详细说说刚才那点');
  assert.deepEqual(calls[1], [{ role: 'user', content: '第一个问题' }, { role: 'assistant', content: '回答1' }, { role: 'user', content: '详细说说刚才那点' }]);
  for (let i = 0; i < 20; i++) await chat.send('问题' + i);
  assert.ok(calls.at(-1).length <= 7);
  chat.reset(); await chat.send('新的开始'); assert.deepEqual(calls.at(-1), [{ role: 'user', content: '新的开始' }]);
});

test('foreground and background utterance controls persist snooze without invoking a conversational model', async () => {
  assert.equal(typeof presence.handlePresenceUtterance, 'function');
  let stopped = false; const calls = [];
  const request = async (url, body) => { calls.push({ url, body }); return {}; };
  assert.equal(await presence.handlePresenceUtterance({ text: '先别打扰我', request, stop: async () => { stopped = true; } }), true);
  assert.equal(stopped, true); assert.deepEqual(calls.map(c => c.body), [{ action: 'snooze', minutes: 120 }]);
  calls.length = 0;
  assert.equal(await presence.handlePresenceUtterance({ text: '我今天有点累', request, stop: async () => {} }), false);
  assert.deepEqual(calls.map(c => c.body), [{ action: 'feedback', state: 'tired' }, { action: 'interaction' }]);
});
test('a stopped background conversation cannot retain a late reply', async () => {
  let finish;
  const chat = createPresenceConversation({ request: () => new Promise(r => { finish = r; }) });
  const pending = chat.send('旧账户问题'); chat.reset(); finish({ reply: '迟到回复' });
  await assert.rejects(pending, { name: 'AbortError' });
});
