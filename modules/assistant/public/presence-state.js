export const FACE_MODEL = 'face-api-0.22.2';
export function validDescriptor(value) {
  return (Array.isArray(value) || value instanceof Float32Array) && value.length === 128 && [...value].every(n => Number.isFinite(n) && Math.abs(n) <= 5) && value.reduce((sum, n) => sum + n * n, 0) > .01;
}
const distance = (a, b) => Math.sqrt(a.reduce((sum, n, i) => sum + (n - b[i]) ** 2, 0));
export function validateEnrollment(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length < 3 || descriptors.length > 8 || !descriptors.every(validDescriptor)) throw Error('请提供 3–8 张清晰的单人人脸照片');
  for (const a of descriptors) for (const b of descriptors) if (distance(a, b) > .5) throw Error('照片需为同一人，请重新选择清晰照片');
  return descriptors.map(v => [...v]);
}
export function matchFace(descriptor, enrolled) {
  return validDescriptor(descriptor) && Array.isArray(enrolled) && enrolled.length >= 3 && enrolled.every(validDescriptor) && enrolled.filter(v => distance(descriptor, v) <= .45).length >= 2;
}
export function matchPerson(descriptor, people = []) {
  const matches = people.filter(person => person.active !== false && matchFace(descriptor, person.descriptors));
  return matches.length === 1 ? matches[0] : null;
}
export function presenceIdentityChanged(previousId, nextId, faceCount) {
  return Boolean(previousId && (nextId ? nextId !== previousId : faceCount > 0));
}
export function personPresenceSettings(settings, person) {
  if (!person) return settings;
  return { ...settings, personId: person.id, name: person.address || person.name, greeting: person.greeting || settings.greeting,
    followUp: Boolean(person.isSelf && settings.followUp), proactiveEnabled: Boolean(person.isSelf && settings.proactiveEnabled),
    lastGreeting: person.lastGreeting || 0, feedback: person.isSelf ? settings.feedback : { state: 'neutral', date: '' } };
}
export class ArrivalTracker {
  constructor({ confirmMs = 2000, absenceMs = 60000, cooldownMs = 300000 } = {}) {
    Object.assign(this, { confirmMs, absenceMs, cooldownMs });
    this.present = false; this.lastGreeting = -Infinity; this.last = -Infinity; this.unavailable();
  }
  unavailable() { this.since = null; this.absentSince = null; this.count = 0; this.last = -Infinity; }
  observe(matched, at = Date.now()) {
    if (!Number.isFinite(at) || at <= this.last) return false;
    if (at - this.last > 2500) this.unavailable();
    this.last = at;
    if (!matched) {
      this.since = null; this.count = 0; this.absentSince ??= at;
      if (at - this.absentSince >= this.absenceMs) this.present = false;
      return false;
    }
    this.absentSince = null;
    if (this.present) return false;
    this.since ??= at; this.count++;
    if (this.count < 3 || at - this.since < this.confirmMs || at - this.lastGreeting < this.cooldownMs) return false;
    this.present = true; this.lastGreeting = at; return true;
  }
}
export class PersonArrivals {
  constructor() { this.states = new Map(); this.personId = ''; }
  unavailable() { for (const state of this.states.values()) state.tracker.unavailable(); }
  observe(personId, at = Date.now()) {
    const changed = this.personId !== personId; this.personId = personId;
    if (personId && !this.states.has(personId)) this.states.set(personId, { tracker: new ArrivalTracker(), since: null, lastMatched: 0 });
    let arrival = false;
    for (const [id, state] of this.states) {
      const matched = id === personId;
      const entered = state.tracker.observe(matched, at);
      if (matched) { state.lastMatched = at; arrival = entered; if (entered) state.pendingArrival = true; }
      if (!state.tracker.present) { state.since = null; state.pendingArrival = false; } else if (matched) state.since ??= at;
    }
    return { changed, arrival, current: this.states.get(personId) || null };
  }
}

export const presencePolicyDefaults = () => ({ contextEnabled: true, timeZone: 'Asia/Shanghai', workdays: [1, 2, 3, 4, 5], workDates: [], restDates: [], quietEnabled: true, quietStart: '22:00', quietEnd: '08:00', proactiveEnabled: false, proactiveText: '{name}，现在是{period}。{care}', intervalMinutes: 30, dailyLimit: 3, aiOpening: false, feedback: { state: 'neutral', date: '' }, snoozeUntil: 0 });
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function validatePresencePolicy(value) {
  const next = {};
  if (value.proactiveText !== undefined) { if (typeof value.proactiveText !== 'string' || !value.proactiveText.trim() || value.proactiveText.length > 200) throw Error('请填写主动开场语，最多200字'); next.proactiveText = value.proactiveText.trim(); }
  for (const key of ['contextEnabled', 'quietEnabled', 'proactiveEnabled', 'aiOpening']) if (value[key] !== undefined) { if (typeof value[key] !== 'boolean') throw Error('开关格式无效'); next[key] = value[key]; }
  if (value.timeZone !== undefined) {
    if (typeof value.timeZone !== 'string' || value.timeZone.length > 80) throw Error('时区无效');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { throw Error('时区无效'); } next.timeZone = value.timeZone;
  }
  if (value.workdays !== undefined) {
    if (!Array.isArray(value.workdays) || value.workdays.length > 7 || new Set(value.workdays).size !== value.workdays.length || value.workdays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw Error('工作周格式无效'); next.workdays = [...value.workdays];
  }
  for (const key of ['workDates', 'restDates']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || value[key].length > 100 || !value[key].every(dateValid)) throw Error('特殊日期需为有效YYYY-MM-DD，每项最多100个'); next[key] = [...new Set(value[key])].sort();
  }
  if (value.workDates?.some(d => value.restDates?.includes(d))) throw Error('同一天不能同时为工作日和休息日');
  for (const key of ['quietStart', 'quietEnd']) if (value[key] !== undefined) { if (typeof value[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key])) throw Error('免打扰时间无效'); next[key] = value[key]; }
  for (const [key, min, max] of [['intervalMinutes', 5, 240], ['dailyLimit', 1, 12]]) if (value[key] !== undefined) { if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw Error('主动开场间隔需5–240分钟，每日上限1–12次'); next[key] = value[key]; }
  return next;
}
export function presenceContext(settings, at = Date.now()) {
  const s = { ...presencePolicyDefaults(), ...settings };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: s.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`, day = new Date(date + 'T12:00:00Z').getUTCDay(), hour = Number(parts.hour);
  const working = s.workDates.includes(date) || !s.restDates.includes(date) && s.workdays.includes(day);
  const state = s.feedback?.date === date ? s.feedback.state : 'neutral';
  return { date, weekday: '星期' + '日一二三四五六'[day], time: `${parts.hour}:${parts.minute}`, minute: hour * 60 + Number(parts.minute), period: hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上', dayType: working ? '工作日' : '休息日', state, care: state === 'tired' ? '你说今天有些累，要不要先歇一会儿？' : state === 'busy' ? '你说正在忙，我会少打扰，需要时叫我。' : state === 'good' ? '你说今天精神不错，想聊聊今天的安排吗？' : working ? '今天有什么需要我帮忙的吗？' : '休息日可以按自己的节奏来。' };
}
export function presenceGreeting(settings, at = Date.now(), kind = 'arrival') {
  const c = presenceContext(settings, at), variables = { ...c, name: settings.name || '你' };
  const template = kind === 'proactive' ? settings.proactiveText || presencePolicyDefaults().proactiveText : settings.greeting || '你好，{name}，欢迎回来。';
  const text = template.replace(/\{(name|period|date|weekday|dayType|care)\}/g, (_, key) => variables[key]);
  return kind === 'arrival' && settings.contextEnabled !== false ? `${c.period}好，今天是${c.date}，${c.weekday}，${c.dayType}。${text}${c.care}` : text;
}
export function quietReason(settings, at = Date.now()) {
  if ((settings.snoozeUntil || 0) > at) return '已暂停主动互动';
  if (!settings.quietEnabled) return '';
  const c = presenceContext(settings, at), minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const start = minutes(settings.quietStart || '22:00'), end = minutes(settings.quietEnd || '08:00');
  if (start === end || (start < end ? c.minute >= start && c.minute < end : c.minute >= start || c.minute < end)) return '免打扰时段';
  return '';
}
export function openingDecision(settings, presence, at = Date.now()) {
  const s = { ...presencePolicyDefaults(), ...settings };
  const deny = reason => ({ allowed: false, reason });
  if (!s.enabled || !s.proactiveEnabled) return deny('主动开场未开启');
  const quiet = quietReason(s, at); if (quiet) return deny(quiet);
  if (presence.busy) return deny('正在进行语音或回复');
  if (!presence.present || !Number.isFinite(presence.lastMatched) || at < presence.lastMatched || at - presence.lastMatched > 2500) return deny('等待清晰确认本人');
  const latest = Math.max(presence.since ?? at, s.lastGreeting || 0, s.lastProactive || 0, s.lastInteraction || 0);
  if (at < latest || at - latest < s.intervalMinutes * 60000) return deny('尚未到主动开场间隔');
  if (s.proactiveDay === presenceContext(s, at).date && (s.proactiveCount || 0) >= s.dailyLimit) return deny('今日主动开场次数已满');
  if (presenceContext(s, at).state === 'busy') return deny('你反馈正在忙');
  return { allowed: true, reason: '本人仍在场，可以主动开场' };
}
const closingUtterance = new RegExp('^(?:(?:嗯|好(?:的|了)?|行(?:了)?|那(?:就)?))*' +
  '(?:(?:请|麻烦你)?(?:你)?(?:先)?(?:可以)?(?:' + [
    '晚安|拜拜|再见|(?:明天|下次|回头)再聊',
    '下去|退下|休息|去休息',
    '(?:别|不要|不用)(?:再)?(?:说话|聊天|对话|继续聊)',
    '(?:结束|停止|关闭|退出|暂停)(?:本次|这次|当前|这轮)?(?:语音)?(?:聊天|对话|聆听)',
    '(?:今天)?(?:先)?(?:不聊了|就聊到这(?:里|儿)?|到此为止)',
    '我(?:先|要|准备)?(?:去)?(?:睡觉|睡|休息)了',
  ].join('|') + ')(?:吧|了|啊|呀){0,2})+$', 'u');
export function endsVoiceConversation(text) {
  if (typeof text !== 'string' || text.length > 160) return false;
  // Match the whole user utterance; quotes, questions and added requests are not commands.
  return closingUtterance.test(text.normalize('NFKC').replace(/[\s，,。.!！?？；;、…]/gu, ''));
}
export function presenceVoiceIntent(text) {
  // An explicit do-not-disturb command also pauses proactive interaction. Ordinary
  // farewells only close the current dialogue, after its reply has finished playing.
  if (/^(?:请|麻烦你)?(?:你)?(?:先)?(?:别|不要|不用|停止|暂停)(?:再)?打扰(?:我)?(?:了|吧)?[。！!\s]*$/u.test(text.trim())) return { snoozeMinutes: 120 };
  if (/^我(?:今天|现在|最近)?(?:觉得|感觉)?(?:有点|有些|很|太|真的){0,2}(?:累|疲惫|疲倦)/.test(text)) return { feedback: 'tired' };
  if (/^我(今天|现在)?(正在|很|有点|比较)?忙/.test(text)) return { feedback: 'busy' };
  if (/^我(今天|现在)?(精神不错|很开心|心情很好)/.test(text)) return { feedback: 'good' };
  return null;
}
