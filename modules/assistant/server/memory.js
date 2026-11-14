import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const empty = () => ({ summary: '', pending: [], recentIds: [], summarizedTurns: 0, trimmedTurns: 0, updatedAt: null, lastError: '' });
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Persist only a compact summary and a bounded incremental batch, never the full archive.
export class ConversationMemory {
  #accounts = new Map(); #closing = false; #generation = 0; #owners = new Map();
  constructor({ dataDir }) { this.directory = path.join(dataDir, 'memory'); }
  async #entry(owner) {
    const key = createHash('sha256').update(String(owner)).digest('hex');
    if (!this.#accounts.has(key)) this.#accounts.set(key, (async () => {
      const file = path.join(this.directory, `${key}.json`);
      let data = empty();
      try { data = { ...data, ...JSON.parse(await readFile(file, 'utf8')) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (typeof data.summary !== 'string' || data.summary.length > 1200 || !Array.isArray(data.pending) || !Array.isArray(data.recentIds)) throw Error('记忆文件格式无效');
      return { file, data, tail: Promise.resolve(), epoch: 0, task: null, controller: null, retryAt: 0 };
    })());
    return this.#accounts.get(key);
  }
  #change(entry, change) {
    const task = entry.tail.catch(() => {}).then(async () => {
      const next = structuredClone(entry.data); change(next);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(`${entry.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${entry.file}.tmp`, entry.file); entry.data = next;
    });
    entry.tail = task; return task;
  }
  async status(owner) {
    const entry = await this.#entry(owner); await entry.tail;
    const { summary, pending, summarizedTurns, trimmedTurns, updatedAt, lastError } = entry.data;
    return { summary, pendingTurns: pending.length, summarizedTurns, trimmedTurns, updatedAt, lastError, running: Boolean(entry.task) };
  }
  async record(owner, turn) {
    if (this.#closing) return;
    const generation = this.#generation, ownerGeneration = this.#owners.get(owner) || 0;
    const entry = await this.#entry(owner);
    await this.#change(entry, data => {
      if (this.#closing || generation !== this.#generation || ownerGeneration !== (this.#owners.get(owner) || 0)) return;
      if (data.recentIds.includes(turn.id)) return;
      data.recentIds = [...data.recentIds, turn.id].slice(-64);
      data.pending.push({ id: turn.id, user: turn.user.slice(0, 4000), assistant: turn.assistant.slice(0, 4000) });
      while (data.pending.length > 12 || data.pending.length > 1 && bytes(data.pending) > 48000) { data.pending.shift(); data.trimmedTurns++; }
    });
  }
  async summarize(owner, generate, { force = false } = {}) {
    const generation = this.#generation, ownerGeneration = this.#owners.get(owner) || 0;
    const cancelled = () => this.#closing || generation !== this.#generation || ownerGeneration !== (this.#owners.get(owner) || 0);
    const entry = await this.#entry(owner); await entry.tail;
    if (cancelled() || entry.task || !entry.data.pending.length || !force && (Date.now() < entry.retryAt || entry.data.pending.length < 6 && bytes(entry.data.pending) < 24000)) return;
    const epoch = entry.epoch, controller = new AbortController(), batch = [];
    for (const turn of entry.data.pending) { if (batch.length && bytes([...batch, turn]) > 28000) break; batch.push(turn); }
    const previous = entry.data.summary;
    entry.controller = controller;
    entry.task = (async () => {
      try {
        const summary = await generate({ summary: previous, messages: batch.flatMap(turn => [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant }]), signal: controller.signal });
        if (typeof summary !== 'string' || summary.length > 1200) throw Error('invalid-summary');
        if (cancelled() || entry.epoch !== epoch || controller.signal.aborted) return;
        await this.#change(entry, data => {
          if (cancelled() || entry.epoch !== epoch) return;
          const consumed = new Set(batch.map(turn => turn.id));
          data.pending = data.pending.filter(turn => !consumed.has(turn.id));
          data.summary = summary.trim(); data.summarizedTurns += batch.length; data.updatedAt = new Date().toISOString(); data.lastError = '';
        });
        entry.retryAt = 0;
      } catch {
        if (cancelled() || entry.epoch !== epoch || controller.signal.aborted) return;
        entry.retryAt = Date.now() + 60000;
        await this.#change(entry, data => { if (!cancelled() && entry.epoch === epoch) data.lastError = '摘要暂未更新，已保留旧记忆；后续对话会重试。'; });
      } finally { entry.task = null; if (entry.controller === controller) entry.controller = null; }
    })();
    return entry.task;
  }
  async clear(owner) {
    this.#owners.set(owner, (this.#owners.get(owner) || 0) + 1);
    const entry = await this.#entry(owner); entry.epoch++; entry.controller?.abort(); entry.retryAt = 0;
    await this.#change(entry, data => Object.assign(data, empty()));
    return this.status(owner);
  }
  async cancelAll() {
    this.#generation++;
    for (const promise of this.#accounts.values()) { const entry = await promise; entry.epoch++; entry.controller?.abort(); }
  }
  async close() {
    this.#closing = true; await this.cancelAll();
    for (const promise of this.#accounts.values()) { const entry = await promise; await entry.task; await entry.tail; }
  }
}
