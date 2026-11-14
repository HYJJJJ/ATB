import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationContext } from '../public/assistant-context.js';

test('long Chinese conversation fits the HTTP budget and preserves the newest question', () => {
  const history = Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '中'.repeat(i % 2 ? 16000 : 4000) }));
  history.push({ role: 'user', content: '最新的问题' });
  const context = conversationContext(history);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: context })) <= 30000);
  assert.equal(context.at(-1).content, '最新的问题');
  assert.equal(history[1].content.length, 16000);
});

test('recent context stays bounded even after thousands of short messages', () => {
  const history = Array.from({ length: 2000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }));
  history.push({ role: 'user', content: '最后的问题' });
  const context = conversationContext(history);
  assert.ok(context.length <= 7);
  assert.equal(context.at(-1).content, '最后的问题');
  assert.equal(context[0].role, 'user');
});

test('failed and interrupted turns cannot carry an old search into the next question', () => {
  const history = [
    {role:'user',content:'之前的正常问题'}, {role:'assistant',content:'之前的正常回答'},
    {role:'user',content:'失败的搜索',status:'failed'}, {role:'assistant',content:'未完成的开场白',status:'pending'},
    {role:'user',content:'旧版本留下的未答搜索'},
    {role:'user',content:'现在只聊午饭',status:'pending'},
  ];
  assert.deepEqual(conversationContext(history), [
    {role:'user',content:'之前的正常问题'}, {role:'assistant',content:'之前的正常回答'},
    {role:'user',content:'现在只聊午饭'},
  ]);
});

test('legacy tool packets and excluded errors are not replayed as assistant history', () => {
  for (const assistant of [
    {role:'assistant',content:'<｜DSML｜calls>内部参数</｜DSML｜calls>'},
    {role:'assistant',content:'模型回复失败',status:'failed'},
  ]) assert.deepEqual(conversationContext([
    {role:'user',content:'查旧新闻'},assistant,{role:'user',content:'你好'},
  ]),[{role:'user',content:'你好'}]);
});
