import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../public/presence-conversation.js';

test('opening generation falls back locally exactly once without retrying paid requests', async () => {
  assert.equal(typeof module.createPresenceOpenings, 'function');
  const spoken = [], requests = [];
  const opening = module.createPresenceOpenings({ request: async (url, body) => { requests.push({ url, body }); if (url.endsWith('/chat')) throw Error('model unavailable'); return { claimed: true, claimId: 'one-use-id' }; }, voice: { read: async text => { spoken.push(text); return true; }, start: async () => {}, stop: async () => {} }, valid: () => true });
  assert.equal(await opening.start('arrival', { name: '小明', greeting: '欢迎，{name}。', contextEnabled: false, aiOpening: true }), true);
  assert.deepEqual(spoken, ['欢迎，小明。']); assert.equal(requests.filter(r => r.url.endsWith('/chat')).length, 1);
});

test('paused or stale generation cannot speak or open a microphone after a late model reply', async () => {
  assert.equal(typeof module.createPresenceOpenings, 'function');
  let finish, spoken = 0, microphone = 0;
  const opening = module.createPresenceOpenings({ request: async url => url.endsWith('/chat') ? new Promise(resolve => { finish = resolve; }) : { claimed: true, claimId: 'id' }, voice: { read: async () => { spoken++; return true; }, start: async () => { microphone++; }, stop: async () => {} }, valid: () => true });
  const pending = opening.start('proactive', { aiOpening: true, followUp: true });
  await new Promise(r => setImmediate(r)); await opening.cancel(); finish({ reply: '迟到问候' });
  assert.equal(await pending, false); assert.equal(spoken, 0); assert.equal(microphone, 0);
});

test('denied claims and lost presence never start synthesis or automatic follow-up', async () => {
  assert.equal(typeof module.createPresenceOpenings, 'function');
  let valid = true, speak = 0;
  const voice = { read: async () => { speak++; valid = false; return true; }, start: async () => { throw Error('must not open microphone'); }, stop: async () => {} };
  const denied = module.createPresenceOpenings({ request: async () => ({ claimed: false }), voice, valid: () => true });
  assert.equal(await denied.start('arrival', {}), false); assert.equal(speak, 0);
  const accepted = module.createPresenceOpenings({ request: async () => ({ claimed: true }), voice, valid: () => valid });
  assert.equal(await accepted.start('arrival', { followUp: true }), false); assert.equal(speak, 1);
});
