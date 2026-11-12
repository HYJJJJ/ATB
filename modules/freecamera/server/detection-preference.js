import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// User intent outlives the model process, which may stop while compute is offline.
export class DetectionPreference {
  constructor(filename = null, enabled = false) {
    this.filename = filename; this.enabled = enabled; this.pending = Promise.resolve();
  }
  static async load(filename) {
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof value.enabled !== 'boolean') throw Error('人物检测设置无效');
      return new DetectionPreference(filename, value.enabled);
    } catch (error) { if (error.code === 'ENOENT') return new DetectionPreference(filename); throw error; }
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('人物检测设置无效');
    this.enabled = enabled;
    if (!this.filename) return;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await writeFile(`${this.filename}.tmp`, JSON.stringify({ enabled }), { mode: 0o600 });
      await rename(`${this.filename}.tmp`, this.filename);
    });
    await this.pending;
  }
}
