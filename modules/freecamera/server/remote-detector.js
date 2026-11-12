import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const validBox = b => b && ['x', 'y', 'width', 'height', 'score'].every(key => Number.isFinite(b[key]) && b[key] >= 0 && b[key] <= 1);

// Keeps optional compute separate from camera presence and media signaling.
export class RemoteDetector extends EventEmitter {
  #provider = null;
  #state = { status: 'off', pid: null, backend: 'CPU' };
  #pending = new Map();
  #epoch = 0;
  #controlId = null;
  #lease;
  #options;
  constructor({ leaseMs = 10000, requestTimeoutMs = 30000 } = {}) {
    super(); this.#options = { leaseMs, requestTimeoutMs };
    this.#lease = setInterval(() => {
      if (this.#provider && Date.now() - this.#provider.beat > leaseMs) this.#lost();
    }, Math.min(1000, leaseMs));
    this.#lease.unref();
  }
  get state() {
    return { ...this.#state, available: !!this.#provider, location: 'desktop', providerName: this.#provider?.name || '',
      ...(!this.#provider ? { error: '本机检测端离线' } : {}) };
  }
  #set(status, pid = null, error) {
    this.#state = { status, pid, backend: 'CPU', ...(error ? { error } : {}) };
    this.emit('state', this.state);
  }
  attach(ws, name) {
    if (this.#provider) return false;
    this.#provider = { ws, name: typeof name === 'string' ? name.slice(0, 60) : '本机检测端', beat: Date.now() };
    this.#epoch++; this.#set('off'); return true;
  }
  heartbeat(ws) { if (this.#provider?.ws === ws) this.#provider.beat = Date.now(); }
  detach(ws) {
    if (this.#provider?.ws !== ws) return;
    this.#provider = null; this.#epoch++; this.#cancel(); this.#set('off');
  }
  #lost() { const ws = this.#provider?.ws; if (!ws) return; this.detach(ws); ws.close(4000, 'Compute heartbeat timeout'); }
  #cancel() {
    for (const task of this.#pending.values()) { clearTimeout(task.timer); task.resolve(null); }
    this.#pending.clear();
  }
  receive(ws, m) {
    if (this.#provider?.ws !== ws) return;
    if (m.type === 'detection-provider-fault') {
      if (!this.#controlId || m.controlId !== this.#controlId) return;
      this.#epoch++; this.#cancel(); this.#set('error', null, '本机模型异常，请关闭后重试'); return;
    }
    const task = this.#pending.get(m.id); if (!task) return;
    clearTimeout(task.timer); this.#pending.delete(m.id);
    const validState = m.state && ['off', 'on', 'error'].includes(m.state.status) && (m.state.pid === null || Number.isInteger(m.state.pid) && m.state.pid > 0);
    if (m.error || !validState || (task.action === 'detect' && (!Array.isArray(m.boxes) || m.boxes.length > 100 || !m.boxes.every(validBox)))) {
      task.reject(Error('本机检测任务失败')); return;
    }
    task.resolve(m);
  }
  #request(action, jpeg) {
    const provider = this.#provider;
    if (!provider || provider.ws.readyState !== 1) return Promise.resolve(null);
    const id = randomUUID();
    if (action !== 'detect') this.#controlId = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.#pending.has(id)) this.#lost(); }, this.#options.requestTimeoutMs);
      timer.unref(); this.#pending.set(id, { action, resolve, reject, timer });
      try { provider.ws.send(JSON.stringify({ type: 'detection-command', id, action, ...(jpeg ? { jpeg } : {}) })); }
      catch { this.#lost(); }
    });
  }
  async enable() {
    if (!this.#provider || ['starting', 'on'].includes(this.#state.status)) return this.state;
    const epoch = ++this.#epoch; this.#cancel(); this.#set('starting');
    try {
      const response = await this.#request('enable');
      if (response && epoch === this.#epoch) {
        if (response.state.status !== 'on') throw Error('本机模型未启动');
        this.#set('on', response.state.pid);
      }
    } catch (e) { if (epoch === this.#epoch) this.#set('error', null, e.message); }
    return this.state;
  }
  async disable() {
    if (!this.#provider || this.#state.status === 'off') return this.state;
    const epoch = ++this.#epoch; this.#cancel(); this.#set('stopping', this.#state.pid);
    try {
      const response = await this.#request('disable');
      if (response && epoch === this.#epoch) {
        if (response.state.status !== 'off' || response.state.pid !== null) throw Error('等待本机模型退出');
        this.#set('off');
      }
    } catch (e) { if (epoch === this.#epoch) this.#set('error', null, e.message); }
    return this.state;
  }
  async detect(jpeg) {
    if (this.#state.status !== 'on' || [...this.#pending.values()].some(t => t.action === 'detect')) return null;
    const epoch = this.#epoch;
    try {
      const response = await this.#request('detect', jpeg);
      return response && epoch === this.#epoch && this.#state.status === 'on' ? response.boxes : null;
    } catch (e) { if (epoch === this.#epoch) this.#set('error', null, e.message); return null; }
  }
  async close() { clearInterval(this.#lease); if (this.#provider) this.#lost(); }
}
