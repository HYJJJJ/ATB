import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const emotions = new Set(['开心', '感动', '争吵', '重要决定']);
const categories = new Set(['activeTopic', 'pendingThought', 'memberImpression']);
export const MEMORY_TOOL_NAMES = Object.freeze(['memory_core_append', 'memory_core_read', 'memory_core_remove', 'write_diary', 'diary_read', 'diary_search', 'qq_memory_append', 'qq_memory_query', 'qq_memory_clear']);
const reads = new Set(['memory_core_read', 'diary_read', 'diary_search', 'qq_memory_query']);
const cp = value => Array.from(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && cp(value).length <= max && !value.includes('\0');
const clip = (value, max) => cp(String(value || '')).slice(0, max).join('');
const array = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => new Date(value).toISOString();
const ownerKey = owner => createHash('sha256').update(String(owner)).digest('hex');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const day = value => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const failed = error => ({ ok: false, error });
const empty = time => ({ version: 2, createdAt: iso(time), core: [], light: [], rules: [], drafts: [], sourceFacts: [], privateFragments: [], diaryMeta: [], coreTurns: [], diaryTurns: [], recentTurns: [], removalLog: [], lastPruneAt: null, report: null });
const protectedText = value => /(?:忽略|取消|绕过|放弃|移除|重写|替换|更换|改变|改成|设为|变更).{0,24}(?:安全|规则|限制|主人|所有者|角色|身份|系统提示)|(?:ignore|bypass|disable|replace|change|override).{0,35}(?:safety|owner|identity|system|persona)|(?:主人|所有者|owner|身份|角色).{0,12}(?:改为|变为|是我|现在是|改成|is now)/iu.test(value);
function sessionAllowed(context = {}) {
  try { return !context.signal?.aborted && (typeof context.checkSession !== 'function' || context.checkSession() === true); }
  catch { return false; }
}
function writeAllowed(context) {
  try { return sessionAllowed(context) && (typeof context.allowWrite === 'function' ? context.allowWrite() === true : context.allowWrite === true); }
  catch { return false; }
}
function verifiedEvent(context) {
  const event = context.event, turn = context.turn;
  if (!object(event) || !object(turn) || !text(turn.id, 200) || !emotions.has(event.emotion) || event.related !== true || !Number.isInteger(event.intensity) || event.intensity < 4 || event.intensity > 5 || !['user', 'assistant'].includes(event.sourceRole) || !text(event.quote, 300)) return null;
  return typeof turn[event.sourceRole] === 'string' && turn[event.sourceRole].includes(event.quote) ? event : null;
}
function section(content, name) {
  const lines = content.split(/\r?\n/);
  let current = '', result = [];
  for (const line of lines) {
    const heading = line.replace(/^\s*#{1,6}\s*/, '').trim().match(/^([●◐]?)\s*(?:【(触点|我的想|变|我的回|回声)】\s*[：:]?\s*(.*)|(触点|我的想|变|我的回|回声)(?:[：:]\s*(.*))?)$/u);
    if (heading) { current = heading[2] || heading[4]; const inline = heading[3] || heading[5] || ''; if (current === name) result.push(`${heading[1]}${inline}`); continue; }
    if (current === name) result.push(line);
  }
  return result.join('\n');
}
function isPrivateCopy(data, content) {
  return typeof content === 'string' && data.privateFragments.some(fragment => cp(fragment).length >= 6 && (content.includes(fragment) || cp(content.trim()).length >= 6 && fragment.includes(content.trim())));
}
const stripMarkers = value => value.replace(/^[\s●◐]+/gmu, '').trim();
function workingExtra(category, extra) {
  if (!object(extra)) return {};
  if (category === 'memberImpression') return text(extra.member, 60) ? { member: extra.member.trim() } : {};
  if (category === 'pendingThought') return text(extra.motivation, 120) ? { motivation: extra.motivation.trim() } : {};
  return { ...(Array.isArray(extra.participants) ? { participants: [...new Set(extra.participants.filter(item => text(item, 40)).map(item => item.trim()))].slice(0, 8) } : {}), ...(text(extra.unaskedQuestion, 120) ? { unaskedQuestion: extra.unaskedQuestion.trim() } : {}) };
}
function draftReason(draft) {
  if (!['expressionPreference', 'interactionRule'].includes(draft.type) || !text(draft.content, 120) || protectedText(draft.content)) return 'protected-or-invalid-target';
  if (draft.target !== undefined && draft.target !== draft.type || draft.name !== undefined && draft.name !== draft.type) return 'protected-or-invalid-target';
  // Only conversational style preferences can evolve; authority changes cannot.
  if (/(?:主人|所有者|身份|角色|系统|安全|服从|听命|照做|无条件|任何要求|限制|权限|owner|identity|safety|obey|unconditional)/iu.test(draft.content)) return 'protected-or-invalid-target';
  return /(?:简洁|简短|自然|健谈|语速|语气|措辞|表达|追问|说完|听完|打断|回应|回复|回答)/u.test(draft.content) ? '' : 'noise';
}
function publicCore(data) { return data.core.map((item, index) => ({ index, id: item.id, ts: item.ts, createdAt: item.ts, emotion: item.emotion, content: item.content, intensity: item.intensity })); }
function activeLight(data, time) { return data.light.filter(item => !item.expiresAt || Date.parse(item.expiresAt) > time); }
function boundCore(data, time, removed = []) {
  while (data.core.length > 60) {
    const score = item => item.intensity * 30 - (time - Date.parse(item.ts)) / DAY;
    let weakest = 0;
    for (let index = 1; index < data.core.length; index++) if (score(data.core[index]) < score(data.core[weakest])) weakest = index;
    const [item] = data.core.splice(weakest, 1); removed.push({ type: 'core', content: item.content, reason: 'older-or-weaker' });
  }
}
function normalize(raw, time) {
  const data = empty(time);
  if (!object(raw) || raw.version !== 2) return data;
  if (Number.isFinite(Date.parse(raw.createdAt))) data.createdAt = iso(Date.parse(raw.createdAt));
  data.core = array(raw.core).filter(item => object(item) && text(item.content, 30) && emotions.has(item.emotion) && [4, 5].includes(item.intensity) && Number.isFinite(Date.parse(item.ts))).slice(-120).map(item => ({ id: text(item.id, 100) ? item.id : randomUUID(), ts: iso(Date.parse(item.ts)), emotion: item.emotion, intensity: item.intensity, content: item.content }));
  data.light = array(raw.light).filter(item => object(item) && categories.has(item.category) && text(item.content, 200) && Number.isFinite(Date.parse(item.createdAt)) && (!item.expiresAt || Number.isFinite(Date.parse(item.expiresAt)))).slice(-100).map(item => ({ id: text(item.id, 100) ? item.id : randomUUID(), category: item.category, content: item.content, createdAt: iso(Date.parse(item.createdAt)), ...(item.expiresAt ? { expiresAt: iso(Date.parse(item.expiresAt)) } : {}), extra: workingExtra(item.category, item.extra) }));
  data.rules = array(raw.rules).filter(item => object(item) && ['expressionPreference', 'interactionRule'].includes(item.type) && text(item.content, 120) && !protectedText(item.content)).slice(-12).map(item => ({ type: item.type, content: item.content }));
  // Draft contents remain private until their exact target and bounded text pass pruning.
  data.drafts = array(raw.drafts).slice(-24).filter(object);
  data.sourceFacts = array(raw.sourceFacts).filter(item => object(item) && validDate(item.date) && text(item.quote, 300) && ['user', 'assistant'].includes(item.sourceRole)).slice(-120).map(item => ({ date: item.date, quote: item.quote, sourceRole: item.sourceRole }));
  data.privateFragments = array(raw.privateFragments).filter(item => text(item, 600)).slice(-120);
  data.diaryMeta = array(raw.diaryMeta).filter(item => object(item) && validDate(item.date) && text(item.mood, 12) && text(item.turnId, 200)).slice(-120).map(item => ({ date: item.date, mood: item.mood, turnId: item.turnId }));
  data.coreTurns = array(raw.coreTurns).filter(item => text(item, 200)).slice(-64);
  data.diaryTurns = array(raw.diaryTurns).filter(item => text(item, 200)).slice(-64);
  data.removalLog = array(raw.removalLog).filter(item => object(item) && ['core', ...categories].includes(item.type) && text(item.content, 200) && text(item.reason, 80)).slice(-128).map(item => ({ type: item.type, content: item.content, reason: item.reason }));
  data.recentTurns = array(raw.recentTurns).filter(item => typeof item === 'string').slice(-64);
  data.lastPruneAt = Number.isFinite(Date.parse(raw.lastPruneAt)) ? iso(Date.parse(raw.lastPruneAt)) : null;
  // Public reports are reconstructed from allowlisted public fields, never arbitrary disk objects.
  if (object(raw.report) && validDate(raw.report.date)) {
    const entries = (items, rejected) => array(items).slice(-128).filter(object).map(item => ({ type: clip(item.type, 30), ...(rejected ? {} : text(item.content, 200) ? { content: item.content } : {}), ...(text(item.reason, 80) ? { reason: item.reason } : {}) }));
    data.report = { date: raw.report.date, kept: entries(raw.report.kept, false), removed: entries(raw.report.removed, false), rejected: entries(raw.report.rejected, true) };
  }
  boundCore(data, time); return data;
}

// Private account storage. Only status/context/factualRecall are safe to send to the public generator.
export class LayeredMemory {
  #accounts = new Map(); #epochs = new Map(); #generation = 0; #closing = false; #timer; #started; #privateContexts = new WeakSet();
  constructor({ dataDir, now = Date.now }) { this.directory = path.join(dataDir, 'memory-v2'); this.legacyDirectory = path.join(dataDir, 'memory'); this.now = now; }
  #token(key, context = {}, write = true) {
    const generation = this.#generation, epoch = this.#epochs.get(key) || 0;
    return () => !this.#closing && generation === this.#generation && epoch === (this.#epochs.get(key) || 0) && (write ? writeAllowed(context) : sessionAllowed(context));
  }
  #entry(key) {
    if (!this.#accounts.has(key)) this.#accounts.set(key, (async () => {
      const directory = path.join(this.directory, key), file = path.join(directory, 'state.json');
      let raw;
      try { const info = await stat(file); if (info.size > 512000) throw Error('memory-state-too-large'); raw = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw Error('memory-state-invalid'); }
      return { key, directory, file, data: normalize(raw, this.now()), tail: Promise.resolve() };
    })());
    return this.#accounts.get(key);
  }
  #queue(entry, action) {
    const task = entry.tail.catch(() => {}).then(action); entry.tail = task; return task;
  }
  async #save(entry, data, valid, diary) {
    if (!valid()) return false;
    await mkdir(entry.directory, { recursive: true, mode: 0o700 });
    if (!valid()) return false;
    const temp = `${entry.file}.${randomUUID()}.tmp`; let diaryTemp;
    try {
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      if (!valid()) return false;
      if (diary) {
        await mkdir(path.join(entry.directory, 'diary'), { recursive: true, mode: 0o700 });
        if (!valid()) return false;
        diaryTemp = `${diary.file}.${randomUUID()}.tmp`;
        await writeFile(diaryTemp, diary.content, { mode: 0o600 });
      }
      // No await between the last cancellation check and file/data commits.
      if (!valid()) return false;
      if (diaryTemp) renameSync(diaryTemp, diary.file);
      renameSync(temp, entry.file); entry.data = data; return true;
    } finally {
      await rm(temp, { force: true });
      if (diaryTemp) await rm(diaryTemp, { force: true });
    }
  }
  async start() {
    if (this.#closing) return;
    if (this.#started) return this.#started;
    this.#started = (async () => {
      let entries = [];
      try { entries = await readdir(this.directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const item of entries) {
        if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name)) continue;
        // One damaged account must not prevent the assistant or other accounts from starting.
        try { await this.#pruneKey(item.name, false); } catch { /* Preserve damaged bytes for recovery. */ }
      }
      if (!this.#closing) { this.#timer = setInterval(() => { void this.#checkDue().catch(() => {}); }, 3600000); this.#timer.unref?.(); }
    })();
    return this.#started;
  }
  async #checkDue() {
    for (const key of this.#accounts.keys()) {
      if (this.#closing) return;
      try { await this.#pruneKey(key, false); } catch { /* Skip only the unavailable account. */ }
    }
  }
  async status(owner) {
    const entry = await this.#entry(ownerKey(owner)); await entry.tail;
    let legacyDetected = false;
    try { legacyDetected = (await stat(path.join(this.legacyDirectory, `${entry.key}.json`))).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return structuredClone({ version: 2, core: publicCore(entry.data), light: activeLight(entry.data, this.now()), lastPruneAt: entry.data.lastPruneAt, report: entry.data.report, legacyDetected, summary: '', pendingTurns: 0, summarizedTurns: 0 });
  }
  async context(owner) {
    const entry = await this.#entry(ownerKey(owner)); await entry.tail;
    const lines = ['你现在记得的事（核心记忆）', ...entry.data.core.map(item => `[${item.emotion}] ${item.content}`), '正在进行（轻量记忆）', ...activeLight(entry.data, this.now()).map(item => `${item.category}: ${item.content}${Object.keys(item.extra || {}).length ? ` ${JSON.stringify(item.extra)}` : ''}`), '记忆使用规则', ...entry.data.rules.map(item => item.content), '核心记忆是有界线索；追问往事细节时先由内部 diary_search 查找原始记录；无匹配就明确说不记得，不编造过去。私密日记和反思不得转述或作为用户事实。不会因超过24小时就自行说“好久不见”；日记只由内部工具访问。'];
    return lines.join('\n');
  }
  async observeTopic(owner, turn, context = {}) {
    const key = ownerKey(owner), valid = this.#token(key, { ...context, allowWrite: true });
    if (!object(turn) || !text(turn.id, 200) || !text(turn.user, 16000)) return;
    const entry = await this.#entry(key);
    return this.#queue(entry, async () => {
      if (!valid() || entry.data.recentTurns.includes(turn.id)) return;
      const data = structuredClone(entry.data);
      data.recentTurns = [...data.recentTurns, turn.id].slice(-64);
      data.light = data.light.filter(item => item.category !== 'activeTopic');
      const lastQuestion = typeof turn.assistant === 'string' ? turn.assistant.match(/[^。！!？?\n]*[？?]/gu)?.at(-1)?.trim() : '';
      data.light.push({ id: randomUUID(), category: 'activeTopic', content: clip(turn.user.trim(), 200), createdAt: iso(this.now()), extra: { participants: ['主人', '助手'], ...(lastQuestion ? { unaskedQuestion: clip(lastQuestion, 120) } : {}) } });
      await this.#save(entry, data, valid);
    });
  }
  async tool(owner, name, args = {}, context = {}) {
    if (!MEMORY_TOOL_NAMES.includes(name) || !object(args)) return failed('unsupported-tool');
    const writing = !reads.has(name), key = ownerKey(owner), valid = this.#token(key, context, writing);
    if (!valid()) return failed('cancelled-or-not-allowed');
    try {
      const entry = await this.#entry(key);
      return await this.#queue(entry, async () => {
        if (!valid()) return failed('cancelled-or-not-allowed');
        if (reads.has(name)) { if (name === 'diary_read' || name === 'diary_search') this.#privateContexts.add(context); return this.#read(entry, name, args, valid); }
        const data = structuredClone(entry.data), time = this.now(); let result = { ok: true }, diary;
        if (name !== 'write_diary' && (this.#privateContexts.has(context) || isPrivateCopy(data, args.content))) return failed('private-content-cannot-be-public');
        if (name === 'memory_core_append' || name === 'write_diary') {
          const event = verifiedEvent(context); if (!event) return failed('event-evidence-required');
          if (name === 'memory_core_append') {
            if (!text(args.content, 30) || args.emotion !== event.emotion || protectedText(args.content)) return failed('invalid-core');
            if (data.coreTurns.includes(context.turn.id)) return { ok: true, duplicate: true };
            if (data.core.some(item => item.content === args.content.trim() && item.emotion === args.emotion)) return { ok: true, duplicate: true };
            data.core.push({ id: randomUUID(), ts: iso(time), content: args.content.trim(), emotion: args.emotion, intensity: event.intensity }); boundCore(data, time, data.removalLog); data.removalLog = data.removalLog.slice(-128);
            data.coreTurns = [...data.coreTurns, context.turn.id].slice(-64);
          } else {
            if (!text(args.content, 600) || !text(args.mood, 12)) return failed('invalid-diary');
            const touchpoint = section(args.content, '触点'), reply = stripMarkers(section(args.content, '我的回'));
            const hasUnmarkedSection = ['触点', '我的想', '变', '我的回', '回声'].some(name => { const content = section(args.content, name); return content.trim() && !/[●◐]/u.test(content); });
            if (!touchpoint.includes(event.quote) || hasUnmarkedSection || reply && (typeof context.turn.assistant !== 'string' || !context.turn.assistant.includes(reply))) return failed('invalid-diary-provenance');
            if (data.diaryTurns.includes(context.turn.id)) return { ok: true, duplicate: true };
            const date = day(time);
            diary = { file: path.join(entry.directory, 'diary', `${date}.md`), content: args.content };
            try {
              const info = await stat(diary.file); if (info.size > 1000000) return failed('diary-day-full');
              const previous = await readFile(diary.file, 'utf8'); if (!valid()) return failed('cancelled');
              if (previous) diary.content = `${previous}\n\n---\n\n${args.content}`;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const fact = { date, quote: event.quote, sourceRole: event.sourceRole };
            if (!data.sourceFacts.some(item => item.date === date && item.quote === fact.quote && item.sourceRole === fact.sourceRole)) data.sourceFacts.push(fact);
            data.sourceFacts = data.sourceFacts.slice(-120);
            data.diaryTurns = [...data.diaryTurns, context.turn.id].slice(-64);
            data.diaryMeta = [...data.diaryMeta, { date, mood: args.mood, turnId: context.turn.id }].slice(-120);
            data.privateFragments = [...data.privateFragments, ...['我的想', '变', '回声'].flatMap(name => stripMarkers(section(args.content, name)).split(/\r?\n/)).filter(fragment => text(fragment, 600))].slice(-120);
            this.#privateContexts.add(context); result.date = date;
          }
        } else if (name === 'memory_core_remove') {
          const index = Number.isInteger(args.index) ? args.index : typeof args.text === 'string' ? data.core.findIndex(item => item.content === args.text) : -1;
          if (index < 0 || index >= data.core.length) return failed('core-not-found');
          data.core.splice(index, 1);
        } else if (name === 'qq_memory_append') {
          if (!categories.has(args.category) || !text(args.content, 200) || protectedText(args.content)) return failed('invalid-working-memory');
          if (args.extra !== undefined && !object(args.extra)) return failed('invalid-working-extra');
          if (args.category === 'memberImpression' && !text(args.extra?.member, 60)) return failed('member-required');
          const extra = workingExtra(args.category, args.extra);
          if (Object.values(extra).flat().some(value => isPrivateCopy(data, value))) return failed('private-content-cannot-be-public');
          data.light = data.light.filter(item => item.category !== args.category || (args.category === 'pendingThought' ? item.content !== args.content.trim() : args.category === 'memberImpression' && item.extra?.member !== extra.member));
          const item = { id: randomUUID(), category: args.category, content: args.content.trim(), createdAt: iso(time) };
          if (args.category === 'pendingThought') item.expiresAt = iso(time + 2 * 3600000);
          if (Object.keys(extra).length) item.extra = extra;
          data.light.push(item);
          const cap = args.category === 'pendingThought' ? 12 : args.category === 'memberImpression' ? 50 : 1;
          while (data.light.filter(value => value.category === args.category).length > cap) data.light.splice(data.light.findIndex(value => value.category === args.category), 1);
        } else if (name === 'qq_memory_clear') {
          if (args.category !== undefined && !categories.has(args.category)) return failed('invalid-working-category');
          data.light = args.category ? data.light.filter(item => item.category !== args.category) : [];
        }
        return await this.#save(entry, data, valid, diary) ? result : failed('cancelled-or-not-allowed');
      });
    } catch { return failed('memory-unavailable'); }
  }
  async #read(entry, name, args, valid) {
    if (name === 'memory_core_read') return entry.data.core.map((item, index) => ({ index, emotion: item.emotion, content: item.content }));
    if (name === 'qq_memory_query') {
      if (args.category !== undefined && !categories.has(args.category)) return failed('invalid-working-category');
      return structuredClone(activeLight(entry.data, this.now()).filter(item => !args.category || item.category === args.category));
    }
    if (name === 'diary_read') {
      if (!validDate(args.date)) return failed('invalid-date');
      try { const file = path.join(entry.directory, 'diary', `${args.date}.md`); if ((await stat(file)).size > 1100000) return failed('diary-day-full'); const content = await readFile(file, 'utf8'); return valid() ? content : failed('cancelled'); }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    }
    if (typeof args.query !== 'string' || cp(args.query).length > 100 || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) return failed('invalid-search');
    let files;
    try { files = await readdir(path.join(entry.directory, 'diary')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!valid()) return failed('cancelled');
    const results = [], query = args.query.toLocaleLowerCase();
    for (const file of files.filter(file => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort().reverse()) {
      if (!valid()) return failed('cancelled');
      const diaryFile = path.join(entry.directory, 'diary', file);
      if ((await stat(diaryFile)).size > 1100000) continue;
      const content = await readFile(diaryFile, 'utf8');
      if (!valid()) return failed('cancelled');
      const position = content.toLocaleLowerCase().indexOf(query);
      if (position >= 0) results.push({ date: file.slice(0, 10), '片段': clip(content.slice(Math.max(0, position - 30)), 160) });
      if (results.length >= (args.limit ?? 5)) break;
    }
    return results;
  }
  async factualRecall(owner, dates, context = {}) {
    const valid = this.#token(ownerKey(owner), context, false); if (!valid()) return [];
    const allowedDates = new Set(array(dates).filter(validDate).slice(0, 20));
    const entry = await this.#entry(ownerKey(owner)); await entry.tail;
    return valid() ? structuredClone(entry.data.sourceFacts.filter(item => allowedDates.has(item.date)).slice(-20)) : [];
  }
  async #pruneKey(key, force) {
    const valid = this.#token(key, { allowWrite: true }), entry = await this.#entry(key);
    return this.#queue(entry, async () => {
      if (!valid()) return null;
      const time = this.now();
      if (!force && time - Date.parse(entry.data.lastPruneAt || entry.data.createdAt) < DAY) return structuredClone(entry.data.report);
      const data = structuredClone(entry.data), report = { date: day(time), kept: [], removed: data.removalLog, rejected: [] }; data.removalLog = [];
      data.light = data.light.filter(item => { if (!item.expiresAt || Date.parse(item.expiresAt) > time) return true; report.removed.push({ type: item.category, content: item.content, reason: 'expired' }); return false; });
      const unique = new Set();
      data.core = data.core.filter(item => { const key = `${item.emotion}:${item.content}`; if (!unique.has(key)) { unique.add(key); return true; } report.removed.push({ type: 'core', content: item.content, reason: 'duplicate' }); return false; });
      boundCore(data, time, report.removed);
      for (const draft of data.drafts) {
        const reason = isPrivateCopy(data, draft.content) ? 'private-content' : draftReason(draft);
        if (reason) { (reason === 'noise' ? report.removed : report.rejected).push({ type: 'draft', reason }); continue; }
        if (data.rules.some(item => item.content === draft.content)) { report.removed.push({ type: 'draft', content: draft.content, reason: 'duplicate' }); continue; }
        data.rules.push({ type: draft.type, content: draft.content });
      }
      data.rules = data.rules.slice(-12); data.drafts = [];
      report.kept = [...data.core.map(item => ({ type: 'core', content: item.content })), ...data.light.map(item => ({ type: item.category, content: item.content })), ...data.rules.map(item => ({ type: item.type, content: item.content }))].slice(-128);
      report.removed = report.removed.slice(-128); report.rejected = report.rejected.slice(-24);
      data.lastPruneAt = iso(time); data.report = report;
      return await this.#save(entry, data, valid) ? structuredClone(report) : null;
    });
  }
  async prune(owner, { force = false } = {}) { return this.#pruneKey(ownerKey(owner), force); }
  async clear(owner) {
    const key = ownerKey(owner); this.#epochs.set(key, (this.#epochs.get(key) || 0) + 1);
    const entry = await this.#entry(key);
    await this.#queue(entry, async () => { await rm(entry.directory, { recursive: true, force: true }); entry.data = empty(this.now()); });
    return this.status(owner);
  }
  async cancelAll() { this.#generation++; await Promise.allSettled([...this.#accounts.values()].map(async pending => { const entry = await pending; await entry.tail; })); }
  async close() { this.#closing = true; clearInterval(this.#timer); await this.cancelAll(); await this.#started; }
}
