class AssistantCapture extends AudioWorkletProcessor {
  constructor() { super(); this.chunk = new Float32Array(Math.round(sampleRate / 10)); this.offset = 0; }
  process(inputs) {
    const samples = inputs[0]?.[0]; if (!samples) return true;
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.chunk.length - this.offset);
      this.chunk.set(samples.subarray(offset, offset + count), this.offset); this.offset += count; offset += count;
      if (this.offset === this.chunk.length) { const copy = this.chunk.slice(); this.port.postMessage(copy.buffer, [copy.buffer]); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('assistant-capture', AssistantCapture);
