export function resamplePcm16(samples, sampleRate) {
  const ratio = sampleRate / 16000, result = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < result.length; i++) {
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let value = 0; for (let j = start; j < end && j < samples.length; j++) value += samples[j];
    const normalized = Math.max(-1, Math.min(1, value / (end - start)));
    result[i] = Math.round(normalized * (normalized < 0 ? 32768 : 32767));
  }
  return result;
}
export function pcmBase64(pcm) {
  const bytes = new Uint8Array(pcm.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

export function speechChunks(text, limit = 500) {
  const chunks = [];
  while (text.length) {
    let end = Math.min(limit, text.length);
    if (end < text.length) {
      const head = text.slice(0, end);
      const punctuation = Math.max(...['。', '！', '？', '.', '!', '?', '\n'].map(char => head.lastIndexOf(char)));
      if (punctuation >= limit / 2) end = punctuation + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  return chunks;
}

// This is a silence gate, not a neural VAD or a wake-word model.
export class SpeechCollector {
  constructor({ silenceMs = 1000, maxMs = 20000 } = {}) { this.silenceMs = silenceMs; this.maxSamples = Math.min(maxMs, 30000) * 16; this.reset(); }
  reset() { this.chunks = []; this.samples = 0; this.quiet = 0; this.voiced = 0; this.active = false; }
  push(pcm) {
    let energy = 0; for (const sample of pcm) energy += (sample / 32768) ** 2;
    const speech = Math.sqrt(energy / Math.max(1, pcm.length)) > 0.018;
    if (speech) { this.active = true; this.quiet = 0; this.voiced += pcm.length; }
    else if (this.active) this.quiet += pcm.length;
    this.chunks.push(pcm); this.samples += pcm.length;
    if (!this.active) { while (this.samples > 4800 && this.chunks.length > 1) this.samples -= this.chunks.shift().length; return null; }
    if (this.samples < this.maxSamples && this.quiet < this.silenceMs * 16) return null;
    if (this.voiced < 3200) { this.reset(); return null; }
    const combined = new Int16Array(Math.min(this.samples, this.maxSamples)); let offset = 0;
    for (const chunk of this.chunks) { if (offset >= combined.length) break; const part = chunk.subarray(0, combined.length - offset); combined.set(part, offset); offset += part.length; }
    this.reset(); return combined;
  }
}
