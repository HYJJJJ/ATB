import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./detector-worker.js', import.meta.url));
const modelPath = fileURLToPath(new URL('../models/yolox_tiny.onnx', import.meta.url));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Detector extends EventEmitter {
  #state = { status: 'off', pid: null, backend: 'CPU' };
  #worker = null;
  #wanted = false;
  #nextFrame = 0;
  #options;

  constructor(options) { super(); this.#options = options; }

  get state() { return { ...this.#state }; }

  #setState(status, pid = null, error) {
    this.#state = { status, pid, backend: 'CPU', ...(error ? { error } : {}) };
    this.emit('state', this.state);
  }

  async enable() {
    this.#wanted = true;
    if (this.#worker?.closing) await this.#worker.done.promise;
    if (!this.#wanted) return this.state;
    if (this.#worker) return this.#state.status === 'on' ? this.state : this.#worker.ready.promise;

    const record = { ready: deferred(), done: deferred(), closing: false, finished: false, frame: null, failure: null };
    this.#worker = record;
    try {
      record.child = fork(this.#options.workerPath ?? workerPath, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        windowsHide: true,
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      });
      this.#setState('starting', record.child.pid ?? null);
      record.child.on('message', message => this.#message(record, message));
      record.child.once('exit', (code, signal) => this.#exited(record, code, signal));
      record.child.once('error', error => {
        record.failure = error;
        if (!record.child.pid) this.#exited(record, null, null);
        else this.#stop(record);
      });
      record.startTimer = setTimeout(() => this.#fail(record, new Error('Person detector startup timed out')), this.#options.startupTimeoutMs ?? 30000);
      this.#send(record, { type: 'init', modelPath: this.#options.modelPath ?? modelPath, scoreThreshold: this.#options.scoreThreshold ?? 0.4 });
    } catch (error) {
      record.failure = error;
      if (record.child?.pid) this.#stop(record);
      else this.#exited(record, null, null);
    }
    return record.ready.promise;
  }

  async disable() {
    this.#wanted = false;
    const record = this.#worker;
    if (record) {
      record.failure = null;
      this.#stop(record);
      await record.done.promise;
    } else if (this.#state.status !== 'off') this.#setState('off');
    return this.state;
  }

  async detect(jpegBase64) {
    const record = this.#worker;
    if (this.#state.status !== 'on' || !record || record.frame) return null;
    if (typeof jpegBase64 !== 'string' || !jpegBase64.length || jpegBase64.length > 3 * 1024 * 1024) throw new Error('Invalid or oversized detector image');
    const frame = { ...deferred(), id: ++this.#nextFrame };
    record.frame = frame;
    frame.timer = setTimeout(() => this.#fail(record, new Error('Person detector inference timed out')), this.#options.inferenceTimeoutMs ?? 15000);
    this.#send(record, { type: 'detect', id: frame.id, jpegBase64 });
    return frame.promise;
  }

  #send(record, message) {
    if (!record.child?.connected) {
      if (!record.closing) this.#fail(record, new Error('Person detector IPC disconnected'));
      return;
    }
    record.child.send(message, error => { if (error && !record.closing && !record.finished) this.#fail(record, error); });
  }

  #message(record, message) {
    if (record !== this.#worker || record.closing || !message || typeof message !== 'object') return;
    if (message.type === 'ready' && this.#state.status === 'starting') {
      clearTimeout(record.startTimer);
      this.#setState('on', record.child.pid);
      record.ready.resolve(this.state);
    } else if (message.type === 'result' && message.id === record.frame?.id) {
      const frame = record.frame;
      record.frame = null;
      clearTimeout(frame.timer);
      frame.resolve(Array.isArray(message.boxes) ? message.boxes : []);
    } else if (message.type === 'error') {
      this.#fail(record, new Error(typeof message.error === 'string' ? message.error.slice(0, 300) : 'Person detector failed'));
    }
  }

  #fail(record, error) {
    if (record.finished || record.closing) return;
    record.failure = error;
    this.#stop(record);
  }

  #stop(record) {
    if (record.finished || record.closing) return;
    record.closing = true;
    clearTimeout(record.startTimer);
    if (record.frame) clearTimeout(record.frame.timer);
    this.#setState('stopping', record.child?.pid ?? null);
    this.#send(record, { type: 'shutdown' });
    // The timeout bounds even a native model load/run that blocks the worker's event loop.
    record.killTimer = setTimeout(() => { if (!record.finished) record.child.kill('SIGKILL'); }, this.#options.stopTimeoutMs ?? 1000);
  }

  #exited(record, code, signal) {
    if (record.finished) return;
    record.finished = true;
    clearTimeout(record.startTimer);
    clearTimeout(record.killTimer);
    if (!record.closing && !record.failure) record.failure = new Error(`Person detector exited (${signal || code || 'stopped'})`);
    if (record.frame) {
      clearTimeout(record.frame.timer);
      if (record.failure) record.frame.reject(record.failure);
      else record.frame.resolve(null);
      record.frame = null;
    }
    if (this.#worker === record) {
      this.#worker = null;
      this.#setState(record.failure ? 'error' : 'off', null, record.failure?.message);
    }
    if (record.failure) record.ready.reject(record.failure);
    else record.ready.resolve(this.state);
    record.done.resolve();
  }
}

export function createDetector(options = {}) {
  return new Detector(options);
}
