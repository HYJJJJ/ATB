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
