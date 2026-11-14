// Measure the audio graph at playback time, including silence between packets.
export function createLevelMeter(context, onLevel) {
  if (!onLevel || !context.createAnalyser || !globalThis.requestAnimationFrame) return { input: context.destination, stop() {} };
  const analyser = context.createAnalyser(); analyser.fftSize = 512; analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize); let frame, stopped = false, last = 0;
  const update = time => {
    if (stopped) return;
    if (time - last >= 32 && !globalThis.document?.hidden) {
      analyser.getFloatTimeDomainData(samples); let power = 0;
      for (const sample of samples) power += sample * sample;
      onLevel(Math.min(1, Math.sqrt(power / samples.length) * 5)); last = time;
    }
    frame = requestAnimationFrame(update);
  };
  frame = requestAnimationFrame(update);
  return { input: analyser, stop() { stopped = true; cancelAnimationFrame(frame); analyser.disconnect(); onLevel(0); } };
}

// Mono PCM16LE playback. Network packets may end in the middle of a sample.
export function createPcmPlayer({ sampleRate, context = new AudioContext(), onPlaying, onLevel, outputId = '', releaseMs = 0, endPaddingMs = 0, startBufferMs = 0 }) {
  if (![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw Error('语音采样率无效');
  if (!Number.isFinite(releaseMs) || releaseMs < 0 || releaseMs > 20 || !Number.isFinite(endPaddingMs) || endPaddingMs < 0 || endPaddingMs > 500) throw Error('语音收尾参数无效');
  if (!Number.isFinite(startBufferMs) || startBufferMs < 0 || startBufferMs > 1000) throw Error('语音缓冲参数无效');
  const releaseBytes = Math.round(sampleRate * releaseMs / 1000) * 2;
  let held = new Uint8Array(0), completion;
  let stopped = false, tail, nextAt = 0, playing = false, wake;
  const sinkReady = outputId ? (context.setSinkId ? context.setSinkId(outputId) : Promise.reject(Error('当前运行环境不支持选择输出设备'))) : Promise.resolve();
  sinkReady.catch(() => {});
  const sources = new Set();
  const meter = createLevelMeter(context, onLevel);
  const signal = () => { wake?.(); wake = null; };
  async function write(base64) {
    await sinkReady;
    if (stopped) return;
    let bytes; try { bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); } catch { throw Error('语音音频格式无效'); }
    if (tail !== undefined) { const joined = new Uint8Array(bytes.length + 1); joined[0] = tail; joined.set(bytes, 1); bytes = joined; tail = undefined; }
    if (bytes.length % 2) { tail = bytes.at(-1); bytes = bytes.subarray(0, -1); }
    if (releaseBytes) {
      const joined = new Uint8Array(held.length + bytes.length); joined.set(held); joined.set(bytes, held.length);
      const count = Math.min(releaseBytes, joined.length);
      held = joined.slice(joined.length - count); bytes = joined.subarray(0, joined.length - count);
    }
    await schedule(bytes);
  }
  async function schedule(bytes) {
    if (stopped || !bytes.length) return;
    try { await context.resume(); } catch { throw Error('无法播放语音，请允许声音播放并检查输出设备'); }
    if (stopped) return;
    if (context.state !== 'running') throw Error('无法播放语音，请允许声音播放并检查输出设备');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), samples = bytes.length / 2;
    // Keep at most two seconds scheduled; each source is at most a quarter second.
    for (let offset = 0; offset < samples && !stopped;) {
      while (!stopped && nextAt - context.currentTime > 2) await new Promise(resolve => {
        const timer = setTimeout(resolve, 30); wake = () => { clearTimeout(timer); resolve(); };
      });
      if (stopped) return;
      if (context.state !== 'running') throw Error('声音播放已暂停，请重新开始');
      const length = Math.min(Math.floor(sampleRate / 4), samples - offset), buffer = context.createBuffer(1, length, sampleRate), output = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) output[i] = data.getInt16((offset + i) * 2, true) / 32768;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(meter.input); sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); signal(); };
      // Reserve a small initial cushion for producers close to real time. Keep
      // the same timeline across packets and sentences; never fade packet edges.
      const lead = !playing ? Math.max(.01, startBufferMs / 1000) : sources.size === 1 ? .01 : 0;
      nextAt = Math.max(nextAt, context.currentTime + lead);
      source.start(nextAt); nextAt += buffer.duration; offset += length;
      if (!playing) { playing = true; onPlaying?.(); }
    }
  }
  return {
    write,
    finish() { return completion ??= finish(); },
    stop() {
      if (stopped) return; stopped = true; tail = undefined; held = new Uint8Array(0);
      for (const source of sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
      sources.clear(); meter.stop(); signal(); void context.close().catch(() => {});
    },
  };
  async function finish() {
    if (tail !== undefined && !stopped) throw Error('语音音频不完整');
    if (!stopped && held.length) {
      // Reserve only the final few milliseconds across packets. Fade once, at
      // utterance completion; all preceding speech samples remain untouched.
      const ending = held; held = new Uint8Array(0);
      const view = new DataView(ending.buffer, ending.byteOffset, ending.length), count = ending.length / 2;
      for (let i = 0; i < count; i++) {
        const gain = count === 1 ? 0 : .5 * (1 + Math.cos(Math.PI * i / (count - 1)));
        view.setInt16(i * 2, Math.round(view.getInt16(i * 2, true) * gain), true);
      }
      await schedule(ending);
    }
    if (!stopped && playing && endPaddingMs) await schedule(new Uint8Array(Math.round(sampleRate * endPaddingMs / 1000) * 2));
    const deadline = Date.now() + 120000;
    while (!stopped && sources.size) {
      if (context.state !== 'running' || Date.now() > deadline) throw Error('声音播放已暂停或超时，请重新开始');
      await new Promise(resolve => { const timer = setTimeout(resolve, 100); wake = () => { clearTimeout(timer); resolve(); }; });
    }
    // A source ends when rendered, before the hardware necessarily plays it.
    // Closing the context here can discard the last syllable in the device buffer.
    const latency = Math.min(1, Math.max(0, Number(context.baseLatency) || 0) + Math.max(0, Number(context.outputLatency) || 0));
    const drainStarted = Date.now(), drainDeadline = drainStarted + 1500;
    while (!stopped && playing) {
      const stamp = context.getOutputTimestamp?.();
      const timedOutput = stamp && stamp.performanceTime > 0 && Number.isFinite(stamp.contextTime);
      if (timedOutput ? stamp.contextTime >= nextAt : Date.now() - drainStarted >= latency * 1000) break;
      if (context.state !== 'running' || Date.now() > drainDeadline) throw Error('声音输出未完成，请检查播放设备');
      await new Promise(resolve => { const timer = setTimeout(resolve, 15); wake = () => { clearTimeout(timer); resolve(); }; });
    }
    return !stopped;
  }
}
