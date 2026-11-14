import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../public/presence-state.js';

test('context respects timezone, workweek and explicit calendar overrides without guessing holidays', () => {
  assert.equal(typeof policy.presenceContext, 'function');
  const options = { timeZone: 'Asia/Shanghai', workdays: [1, 2, 3, 4, 5], restDates: ['2026-11-13'], workDates: ['2026-11-14'] };
  const friday = policy.presenceContext(options, Date.parse('2026-11-12T23:30:00Z'));
  assert.equal(friday.date, '2026-11-13'); assert.equal(friday.period, '早上'); assert.equal(friday.dayType, '休息日');
  assert.equal(policy.presenceContext(options, Date.parse('2026-11-14T03:00:00Z')).dayType, '工作日');
  assert.equal(policy.presenceContext(options, Date.parse('2026-11-15T03:00:00Z')).dayType, '休息日');
});

test('schedule validation rejects impossible dates, conflicting overrides and unsafe limits', () => {
  assert.equal(typeof policy.validatePresencePolicy, 'function');
  for (const value of [{ timeZone: 'Mars/Invalid' }, { restDates: ['2026-02-30'] }, { restDates: ['2026-11-13'], workDates: ['2026-11-13'] }, { intervalMinutes: 0 }, { dailyLimit: 100 }, { quietStart: '25:00' }, { workdays: [1, 1] }, { aiOpening: 'true' }]) assert.throws(() => policy.validatePresencePolicy(value));
  assert.equal(policy.validatePresencePolicy({ intervalMinutes: 15 }).intervalMinutes, 15);
});

test('greetings preserve custom text and only use current explicit feedback', () => {
  assert.equal(typeof policy.presenceGreeting, 'function');
  const at = Date.parse('2026-11-13T02:00:00Z');
  const settings = { name: '小明', greeting: '欢迎回来，{name}。', contextEnabled: false };
  assert.equal(policy.presenceGreeting(settings, at), '欢迎回来，小明。');
  assert.equal(policy.presenceGreeting({ ...settings, proactiveText: '{name}，想聊聊你的新项目吗？' }, at, 'proactive'), '小明，想聊聊你的新项目吗？');
  const text = policy.presenceGreeting({ ...settings, contextEnabled: true, feedback: { state: 'tired', date: '2026-11-13' } }, at);
  assert.match(text, /上午|早上/); assert.match(text, /小明/); assert.match(text, /休息|歇/);
  assert.doesNotMatch(policy.presenceGreeting({ ...settings, contextEnabled: true, feedback: { state: 'tired', date: '2026-11-12' } }, at), /你说.*累/);
});

test('proactive policy requires fresh confirmed presence and honors overnight quiet hours, cooldown and daily cap', () => {
  assert.equal(typeof policy.openingDecision, 'function');
  const now = Date.parse('2026-11-13T02:00:00Z');
  const settings = { enabled: true, proactiveEnabled: true, timeZone: 'Asia/Shanghai', intervalMinutes: 30, dailyLimit: 3, quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' };
  const presence = { present: true, lastMatched: now, since: now - 31 * 60000, busy: false };
  assert.equal(policy.openingDecision(settings, presence, now).allowed, true);
  for (const p of [{ ...presence, present: false }, { ...presence, lastMatched: now - 10000 }, { ...presence, busy: true }, { ...presence, since: now - 1000 }]) assert.equal(policy.openingDecision(settings, p, now).allowed, false);
  for (const s of [{ ...settings, proactiveEnabled: false }, { ...settings, snoozeUntil: now + 1 }, { ...settings, lastInteraction: now - 60000 }, { ...settings, proactiveDay: '2026-11-13', proactiveCount: 3 }]) assert.equal(policy.openingDecision(s, presence, now).allowed, false);
  const night = Date.parse('2026-11-13T15:00:00Z');
  assert.equal(policy.openingDecision(settings, { ...presence, lastMatched: night }, night).allowed, false);
  assert.equal(policy.openingDecision({ ...settings, proactiveDay: '2026-11-12', proactiveCount: 3 }, presence, now).allowed, true);
});

test('explicit voice controls pause conversation and report only self-described state', () => {
  assert.equal(typeof policy.presenceVoiceIntent, 'function');
  assert.deepEqual(policy.presenceVoiceIntent('先别打扰我了'), { snoozeMinutes: 120 });
  assert.deepEqual(policy.presenceVoiceIntent('我今天有点累'), { feedback: 'tired' });
  assert.equal(policy.presenceVoiceIntent('你看起来有点累吗'), null);
  assert.equal(policy.presenceVoiceIntent('我今天不累'), null);
  assert.equal(policy.presenceVoiceIntent('我觉得你很累'), null);
});

test('only direct closing utterances end a voice conversation, not quotes, questions or negations', () => {
  assert.equal(typeof policy.endsVoiceConversation, 'function');
  for (const text of ['下去', '你先下去吧。', '退下吧', '好了，晚安！', '晚安，先不聊了', '我先去睡了，明天再聊', '别说话了', '你先不要再说话了', '不用说话了', '停止聊天', '结束本次语音对话', '关闭聆听', '今天就聊到这里吧', '再见', '拜拜']) {
    assert.equal(policy.endsVoiceConversation(text), true, text);
  }
  for (const text of ['', null, '好的', '晚安是什么意思', '别说话了是什么意思？', '“晚安”', '他说晚安', '我不想说晚安', '不要结束对话', '别停止聊天', '结束对话之前告诉我天气', '下去看看还有什么', '晚安，明天几点下雨？', '如果我说晚安就结束对话', '先别打扰我']) {
    assert.equal(policy.endsVoiceConversation(text), false, String(text));
  }
});
