const { access } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

// The native lease also expires if the renderer freezes or is destroyed.
class NativeCompute {
  #detector;
  #lease = null;
  #generation = 0;
  #timer;
  #leaseMs;
  constructor({ leaseMs = 10000 } = {}) { this.#leaseMs = leaseMs; }
  get state() { return this.#detector?.state || { status: 'off', pid: null, backend: 'CPU' }; }
  async open() {
    await this.close();
    const generation = ++this.#generation;
    try { await access(path.join(__dirname, '../models/yolox_tiny.onnx')); }
    catch { return { available: false, error: '本机人物模型未安装' }; }
    const { createDetector } = await import('../server/detector.js');
    if (generation !== this.#generation) return { available: false };
    this.#detector ??= createDetector();
    this.#lease = { id: randomUUID(), beat: Date.now() };
    this.#timer = setInterval(() => {
      if (this.#lease && Date.now() - this.#lease.beat > this.#leaseMs) void this.close();
    }, Math.min(1000, this.#leaseMs)); this.#timer.unref();
    return { available: true, leaseId: this.#lease.id, backend: 'CPU' };
  }
  #authorized(id) { if (!this.#lease || this.#lease.id !== id) throw Error('本机检测连接已失效'); }
  heartbeat({ leaseId }) { this.#authorized(leaseId); this.#lease.beat = Date.now(); return this.state; }
  async configure({ leaseId, enabled }) {
    this.#authorized(leaseId); if (typeof enabled !== 'boolean') throw Error('Invalid detection switch');
    return enabled ? this.#detector.enable() : this.#detector.disable();
  }
  async detect({ leaseId, jpeg }) {
    this.#authorized(leaseId);
    const boxes = await this.#detector.detect(jpeg);
    return { boxes: this.#lease?.id === leaseId ? boxes || [] : [], state: this.state };
  }
  async close(leaseId) {
    if (leaseId && this.#lease?.id !== leaseId) return;
    this.#generation++; this.#lease = null; clearInterval(this.#timer);
    await this.#detector?.disable();
  }
}
module.exports = { NativeCompute };
