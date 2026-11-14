// A single authenticated reader drains bounded PCM batches over HTTP or native IPC.
export class TtsAudioQueue {
  #chunks = []; #size = 0; #done = false; #error; #wake; #space; #reading = false; #writing = false;
  constructor({ limit = 1024 * 1024, batch = 65536 } = {}) { this.limit = limit; this.batch = batch; }
  push(bytes) {
    if (this.#done || this.#error || !bytes.length) return;
    if (this.#size + bytes.length > this.limit) throw Error('语音播放缓冲已满，请检查播放设备后重试');
    this.#chunks.push(Buffer.from(bytes)); this.#size += bytes.length; this.#wake?.();
  }
  // A fast network producer waits for the reader instead of discarding a long
  // utterance. Keep one writer and at most limit bytes, including large frames.
  async write(bytes) {
    if (this.#writing) throw Error('上一项语音写入仍在等待');
    this.#writing = true;
    try {
      for (let offset = 0; offset < bytes.length;) {
        if (this.#error) throw this.#error;
        if (this.#done) throw Error('语音输入已结束');
        if (this.#size === this.limit) { await new Promise(resolve => { this.#space = resolve; }); continue; }
        const count = Math.min(this.batch, this.limit - this.#size, bytes.length - offset);
        this.push(bytes.subarray(offset, offset + count)); offset += count;
      }
    } finally { this.#writing = false; }
  }
  end() { this.#done = true; this.#wake?.(); this.#space?.(); this.#space = null; }
  fail(error) { this.#error = error; this.#chunks = []; this.#size = 0; this.#wake?.(); this.#space?.(); this.#space = null; }
  async read() {
    if (this.#reading) throw Error('上一项语音读取仍在等待');
    this.#reading = true;
    try {
      while (!this.#size && !this.#done && !this.#error) await new Promise(resolve => { this.#wake = resolve; });
      if (this.#error) throw this.#error;
      const count = Math.min(this.batch, this.#size), bytes = Buffer.alloc(count); let offset = 0;
      while (offset < count) {
        const first = this.#chunks[0], take = Math.min(first.length, count - offset); first.copy(bytes, offset, 0, take); offset += take;
        if (take === first.length) this.#chunks.shift(); else this.#chunks[0] = first.subarray(take);
      }
      this.#size -= count; this.#space?.(); this.#space = null;
      return { audio: bytes.toString('base64'), done: this.#done && !this.#size };
    } finally { this.#wake = null; this.#reading = false; }
  }
}
