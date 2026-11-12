import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class DeviceStore {
  constructor(filename = null, devices = []) { this.filename = filename; this.devices = new Map(devices.map(d => [d.deviceId, d])); this.pending = Promise.resolve(); }
  static async load(filename) {
    try { return new DeviceStore(filename, JSON.parse(await readFile(filename, 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return new DeviceStore(filename); throw e; }
  }
  async persist() {
    if (!this.filename) return;
    const data = JSON.stringify([...this.devices.values()], null, 2);
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await writeFile(`${this.filename}.tmp`, data, { mode: 0o600 }); await rename(`${this.filename}.tmp`, this.filename);
    });
    await this.pending;
  }
  async camera({ deviceId, cameraKey, name } = {}) {
    let device;
    if (deviceId) {
      device = this.devices.get(deviceId);
      if (!device || !matches(device.cameraKey, cameraKey)) throw Error('摄像头凭据无效');
    } else {
      if (this.devices.size >= 64) throw Error('摄像头数量已满');
      device = { deviceId: randomUUID(), cameraKey: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'), name: 'iPhone 摄像头' };
      this.devices.set(device.deviceId, device);
    }
    if (typeof name === 'string' && name.trim()) device.name = name.trim().slice(0, 40);
    device.lastSeen = Date.now();
    await this.persist(); return { deviceId: device.deviceId, cameraKey: device.cameraKey, name: device.name };
  }
  async viewerToken(id) { return this.devices.get(id)?.viewerToken; }
  authorizeViewer(id, token) { return matches(this.devices.get(id)?.viewerToken, token); }
  async remark(id, value) {
    const device = this.devices.get(id);
    if (!device?.lastSeen || typeof value !== 'string' || value.length > 80) throw Error('备注无效');
    device.remark = value.trim(); await this.persist();
  }
  name(id) { const device = this.devices.get(id); return device?.remark || device?.name || '摄像头'; }
  list() { return [...this.devices.values()].filter(d => Number.isFinite(d.lastSeen) && d.lastSeen > 0).map(({ deviceId, name, lastSeen, remark = '' }) => ({ deviceId, name, remark, lastSeen })); }
}
