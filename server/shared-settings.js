import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

const sectionName = /^[a-z][a-z0-9-]{0,63}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function validSection(section) {
  if (!sectionName.test(section) || forbidden.has(section)) throw Error('共享设置分组无效');
}
export class SharedSettings {
  #values; #writes = Promise.resolve();
  constructor(file, values) { this.file = file; this.#values = values; }
  static async load(dataDir) {
    const directory = path.join(dataDir, 'platform'), file = path.join(directory, 'settings.json');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let values = {};
    try { values = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('平台共享设置无法读取，请先修复或恢复备份'); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('平台共享设置格式无效');
    if (process.platform !== 'win32') { await chmod(directory, 0o700); try { await chmod(file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return new SharedSettings(file, values);
  }
  get(section) { validSection(section); return Object.hasOwn(this.#values, section) ? structuredClone(this.#values[section]) : undefined; }
  update(section, mutator) {
    const task = this.#writes.catch(() => {}).then(async () => {
      validSection(section);
      if (typeof mutator !== 'function') throw Error('共享设置更新必须使用同步函数');
      const value = mutator(this.get(section));
      if (value?.then) throw Error('共享设置更新必须使用同步函数');
      if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('共享设置内容必须为对象');
      const clean = JSON.parse(JSON.stringify(value)), next = { ...this.#values, [section]: clean };
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.#values = next;
      return structuredClone(clean);
    });
    this.#writes = task;
    return task;
  }
  async close() { await this.#writes.catch(() => {}); }
}
