import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { sessionToken } from '../../../server/accounts.js';
import { FACE_MODEL, validateEnrollment, matchFace, personPresenceSettings, presencePolicyDefaults, validatePresencePolicy, presenceContext, quietReason } from '../public/presence-state.js';

const defaults = () => ({ ...presencePolicyDefaults(), enabled: false, cameraId: '', greeting: '你好，{name}，欢迎回来。', outputId: '', followUp: false, people: [], model: FACE_MODEL, revision: '' });
const primary = next => next.people.find(p => p.isSelf) || next.people[0];
const visible = next => ({ ...next, name: primary(next)?.address || primary(next)?.name || '', descriptors: primary(next)?.descriptors || [] });
function profile(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('人物资料格式无效');
  const person = { name: '', address: '', relationship: '', birthday: '', occupation: '', notes: '', greeting: '', active: true, isSelf: false, descriptors: [], ...previous };
  for (const [key, limit] of [['name', 40], ['address', 40], ['relationship', 60], ['birthday', 10], ['occupation', 80], ['notes', 1000], ['greeting', 200]]) {
    if (input[key] !== undefined) { if (typeof input[key] !== 'string' || input[key].length > limit) throw Error('人物信息过长或格式无效'); person[key] = input[key].trim(); }
  }
  if (!person.name) throw Error('请填写人物姓名，最多40字');
  if (person.birthday && (!/^\d{4}-\d{2}-\d{2}$/.test(person.birthday) || !Number.isFinite(Date.parse(person.birthday)) || new Date(person.birthday).toISOString().slice(0, 10) !== person.birthday)) throw Error('生日需为有效YYYY-MM-DD');
  for (const key of ['active', 'isSelf']) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw Error('人物开关格式无效'); person[key] = input[key]; }
  if (input.descriptors !== undefined) person.descriptors = Array.isArray(input.descriptors) && input.descriptors.length === 0 ? [] : validateEnrollment(input.descriptors);
  return person;
}
export function createPresenceRoutes({ accounts, dataDir, now = Date.now }) {
  const dir = path.join(dataDir, 'assistant', 'presence');
  let pending = Promise.resolve();
  const filename = owner => path.join(dir, createHash('sha256').update(owner).digest('hex') + '.json');
  async function load(owner) {
    try {
      const stored = JSON.parse(await readFile(filename(owner), 'utf8')), next = { ...defaults(), ...stored };
      if (!Array.isArray(stored.people) && stored.descriptors?.length) next.people = [profile({ name: stored.name || '本人', address: stored.name || '', relationship: '本人', isSelf: true, descriptors: stored.descriptors }, { id: 'legacy-' + createHash('sha256').update(owner).digest('hex').slice(0, 24), lastGreeting: stored.lastGreeting || 0 })];
      delete next.name; delete next.descriptors; return next;
    }
    catch (error) { if (error.code === 'ENOENT') return defaults(); throw error; }
  }
  async function save(owner, next) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(filename(owner) + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await rename(filename(owner) + '.tmp', filename(owner));
  }
  const routes = async (req, res, pathname) => {
    if (pathname !== '/api/assistant/presence') return false;
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    const token = sessionToken(req), session = accounts.session(token);
    if (!session) { reply(401, { error: '请先登录' }); return true; }
    const owner = session.user.username || 'admin';
    try {
      if (req.method === 'GET') { await pending.catch(() => {}); reply(200, visible(await load(owner))); return true; }
      if (req.method !== 'POST') { reply(405, { error: '请求方法无效' }); return true; }
      const origin = new URL(req.headers.origin || 'about:blank');
      if (origin.protocol !== 'https:' || origin.host !== req.headers.host || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(403, { error: '请求来源无效' }); return true; }
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 50000) throw Error('资料过大'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('资料格式无效');
      const task = pending.catch(() => {}).then(async () => {
        if (!accounts.session(token)) throw Error('登录已失效');
        let next = await load(owner);
        if (body.action === 'claim') {
          const at = now(), kind = body.kind || 'arrival';
          if (!['arrival', 'proactive'].includes(kind)) throw Error('开场类型无效');
          if (kind === 'proactive') return { claimed: false, reason: '主动交流已改用随机机会调度' };
          if (!next.enabled || body.revision !== next.revision) return { claimed: false };
          const person = body.personId ? next.people.find(p => p.id === body.personId) : primary(next);
          if (!person || !person.active || person.descriptors.length < 3) return { claimed: false };
          const quiet = quietReason(next, at); if (quiet) return { claimed: false, reason: quiet };
          if (at - (person.lastGreeting || 0) < 300000 || at - (next.lastProactive || 0) < 300000) return { claimed: false, reason: '问候冷却中' };
          person.lastGreeting = at; next.lastGreeting = at;
          next.lastOpening = { id: randomUUID(), kind, at, personId: person.id, used: false };
          await save(owner, next); return { claimed: true, claimId: next.lastOpening.id, lastGreeting: next.lastGreeting, lastProactive: next.lastProactive, proactiveDay: next.proactiveDay, proactiveCount: next.proactiveCount };
        }
        if (body.action === 'snooze') {
          if (![0, 30, 120].includes(body.minutes)) throw Error('暂停时长无效'); next.snoozeUntil = body.minutes ? now() + body.minutes * 60000 : 0;
        } else if (body.action === 'feedback') {
          if (!['neutral', 'tired', 'busy', 'good'].includes(body.state)) throw Error('请选择本人主动反馈的状态');
          next.feedback = { state: body.state, date: presenceContext(next, now()).date };
        } else if (body.action === 'interaction') next.lastInteraction = now();
        else if (body.action === 'clear') next = defaults();
        else if (body.action === 'person-save' || body.action === 'enroll') {
          const legacy = body.action === 'enroll';
          const input = legacy ? { name: body.name, address: body.name, relationship: '本人', isSelf: true, descriptors: body.descriptors } : body.person;
          if (input?.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 80)) throw Error('人物ID无效');
          const existing = legacy ? next.people.find(p => p.isSelf) : next.people.find(p => p.id === input?.id);
          if (!legacy && input?.id && !existing) throw Error('人物资料已删除，请刷新后重试');
          if (!existing && next.people.length >= 50) throw Error('最多保存50个人物');
          const person = profile(input, existing || { id: randomUUID() });
          if (person.isSelf && next.people.some(p => p.id !== person.id && p.isSelf)) throw Error('只能标记一份本人资料，请先取消原人物的本人标记');
          if (person.descriptors.length && next.people.some(p => p.id !== person.id && person.descriptors.some(d => matchFace(d, p.descriptors)))) throw Error('此人脸与已有资料重复或过于相似，请编辑原人物或使用更清晰的照片');
          if (existing) next.people[next.people.indexOf(existing)] = person; else next.people.push(person);
          if (legacy) next.enabled = false;
        } else if (body.action === 'person-delete') {
          const index = next.people.findIndex(p => p.id === body.id); if (index < 0) throw Error('人物资料不存在');
          next.people.splice(index, 1);
        }
        else if (body.action === 'settings') {
          Object.assign(next, validatePresencePolicy({ ...next, ...body }));
          for (const key of ['enabled', 'followUp']) if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') throw Error('开关格式无效'); next[key] = body[key]; }
          for (const [key, limit] of [['cameraId', 160], ['outputId', 300], ['greeting', 200]]) if (body[key] !== undefined) { if (typeof body[key] !== 'string' || body[key].length > limit) throw Error('设置过长或格式无效'); next[key] = body[key].trim(); }
          if (body.name !== undefined) { if (typeof body.name !== 'string' || body.name.length > 40) throw Error('称呼格式无效'); if (primary(next)) primary(next).address = body.name.trim(); }
          if (next.enabled && (!next.cameraId || !next.greeting || !next.people.some(p => p.active && p.descriptors.length >= 3))) throw Error('请先录入人物照片并选择摄像头、填写问候语');
        } else throw Error('未知操作');
        if (!next.people.some(p => p.active && p.descriptors.length >= 3)) next.enabled = false;
        if (['settings', 'enroll', 'clear', 'person-save', 'person-delete'].includes(body.action)) { next.revision = randomUUID(); delete next.lastOpening; }
        await save(owner, next); return visible(next);
      });
      pending = task; reply(200, await task);
    } catch (error) { reply(400, { error: error instanceof SyntaxError ? '资料格式无效' : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? '本人资料读写失败' : error.message }); }
    return true;
  };
  routes.consumeOpening = (owner, revision, claimId) => {
    const task = pending.catch(() => {}).then(async () => {
      const next = await load(owner), claim = next.lastOpening;
      if (claim?.kind !== 'arrival' || !next.enabled || !next.aiOpening || revision !== next.revision || !claim || claim.id !== claimId || claim.used || now() - claim.at > 30000 || now() < claim.at || quietReason(next, now())) throw Error('开场授权已失效或已使用');
      const person = next.people.find(p => p.id === claim.personId); if (!person?.active || person.descriptors.length < 3) throw Error('人物资料已失效');
      claim.used = true; await save(owner, next);
      const selected = personPresenceSettings(next, person);
      return { kind: claim.kind, name: selected.name, person: { name: person.name, relationship: person.relationship }, allowPersonalContext: person.isSelf, greeting: selected.greeting, context: presenceContext(selected, now()) };
    }); pending = task; return task;
  };
  routes.claimConversation = async () => ({ allowed: false, reason: '主动交流已改用随机机会调度' });
  routes.opportunityPolicy = async owner => { await pending.catch(() => {}); return load(owner); };
  return routes;
}
