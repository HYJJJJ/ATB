import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationMemory } from '../server/memory.js';

const turn = i => ({ id: `turn-${i}`, user: `我喜欢咖啡${i}`, assistant: `已收到${i}` });
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atb-memory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, memory: new ConversationMemory({ dataDir: dir }) };
}

test('incremental summary persists per account without retaining summarized transcripts', async t => {
  const { dir, memory } = await fixture(t);
  for (let i = 0; i < 6; i++) await memory.record('alice', turn(i));
  await memory.summarize('alice', async ({ summary, messages }) => {
    assert.equal(summary, ''); assert.equal(messages.length, 12);
    return '用户喜欢咖啡。';
  });
  const restarted = new ConversationMemory({ dataDir: dir });
  const state = await restarted.status('alice');
  assert.equal(state.summary, '用户喜欢咖啡。'); assert.equal(state.pendingTurns, 0);
  assert.equal((await restarted.status('bob')).summary, '');
  await restarted.record('alice', turn(6));
  await restarted.summarize('alice', async input => {
    assert.equal(input.summary, '用户喜欢咖啡。');
    assert.deepEqual(input.messages.map(m => m.content), ['我喜欢咖啡6', '已收到6']);
    return '用户喜欢咖啡，也在探索新口味。';
  }, { force: true });
  assert.equal((await restarted.status('alice')).pendingTurns, 0);
});

test('failed summarization keeps prior memory and bounded unsummarized work', async t => {
  const { memory } = await fixture(t);
  for (let i = 0; i < 6; i++) await memory.record('alice', turn(i));
  await memory.summarize('alice', async () => '旧摘要');
  for (let i = 6; i < 60; i++) await memory.record('alice', turn(i));
  await memory.summarize('alice', async () => { throw Error('provider-secret'); });
  const state = await memory.status('alice');
  assert.equal(state.summary, '旧摘要'); assert.ok(state.pendingTurns <= 12);
  assert.match(state.lastError, /摘要/); assert.equal(JSON.stringify(state).includes('provider-secret'), false);
});

test('clearing memory cancels a late summary and duplicate turns do not grow pending work', async t => {
  const { memory } = await fixture(t);
  for (let i = 0; i < 6; i++) { await memory.record('alice', turn(i)); await memory.record('alice', turn(i)); }
  assert.equal((await memory.status('alice')).pendingTurns, 6);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const task = memory.summarize('alice', async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  await started; await memory.clear('alice'); finish('不应复活的摘要'); await task;
  assert.equal((await memory.status('alice')).summary, '');
  assert.equal((await memory.status('alice')).pendingTurns, 0);
});

test('a turn arriving during summarization remains pending for the next batch', async t => {
  const { memory } = await fixture(t);
  for (let i = 0; i < 6; i++) await memory.record('alice', turn(i));
  let finish, entered; const started = new Promise(resolve => { entered = resolve; });
  const task = memory.summarize('alice', async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  await started; await memory.record('alice', turn(9)); finish('记住前六轮'); await task;
  assert.equal((await memory.status('alice')).pendingTurns, 1);
  assert.equal((await memory.status('alice')).summary, '记住前六轮');
});

for (const action of ['clear', 'cancelAll']) test(`${action} invalidates a summary queued before its model call begins`, async t => {
  const { memory } = await fixture(t);
  for (let i = 0; i < 6; i++) await memory.record('alice', turn(i));
  let calls = 0;
  const pending = memory.summarize('alice', async () => { calls++; return '不应复活'; });
  await memory[action]('alice'); await pending;
  assert.equal(calls, 0);
  assert.equal((await memory.status('alice')).summary, '');
});
