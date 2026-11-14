import { spawn, execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localVoices, localModelFiles, localProviders, localNames, localDirectories, localCatalog, validChatVoice } from './local-tts.js';
import { SharedSettings } from '../../../server/shared-settings.js';
import { volcengineVoices, volcenginePatch, visibleVolcengine, volcengineSetupError, synthesizeVolcengine } from './volcengine-tts.js';
import { loadVolcengineCatalog, refreshVolcengineCatalog } from './volcengine-catalog.js';
import { openVolcengineTts } from './volcengine-stream.js';
import { TtsAudioQueue } from './tts-session.js';
import { normalizeSpeechNumbers } from './speech-numbers.js';

const defaults = { enabled: false, wakeEnabled: true, wakePhrases: [], provider: 'chattts', voice: 'chattts:42', rate: 0, volume: 0, pitch: 0, silenceMs: 600, autoListen: true, autoInterrupt: true, bargeInThreshold: 10, bargeInDurationMs: 500, lowLatency: true };
const runtimes = new Map();
function migrateLocalSettings(saved) {
  if (!['edge', 'kokoro', 'zipvoice', 'f5tts', undefined].includes(saved.provider)) return saved;
  const preferred = saved.profiles?.chattts || {};
  return { ...saved, provider: 'chattts', rate: Math.max(-50, Math.min(100, Number(saved.rate) || 0)),
    ...preferred, voice: validChatVoice(preferred.voice) ? preferred.voice : 'chattts:42', pitch: 0, profiles: { ...saved.profiles } };
}
function workerEnvironment() {
  const allowed = /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|lang|lc_all)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', OMP_NUM_THREADS: '2', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' };
}
export function getVoiceRuntime(dataDir, shared) {
  const root = path.resolve(dataDir);
  if (!runtimes.has(root)) runtimes.set(root, new VoiceRuntime({ dataDir: root, shared }));
  if (shared) runtimes.get(root).shared = shared;
  return runtimes.get(root);
}

// The same bounded worker is used by authenticated HTTP and trusted desktop IPC.
export class VoiceRuntime {
  #settings; #writes = Promise.resolve(); #child; #workerPid; #lease; #opening; #pending = new Map(); #cancelled = new Map(); #timer; #epoch = 0; #catalog; #catalogRefresh; #catalogChild; #synthesis; #provider = 'chattts'; #volcCatalog; #volcRefresh; #validation = null;
  #ttsStream; #resident; #preparing;
  constructor({ dataDir, command, worker, shared, ttsRequest = fetch, ttsConnect, catalogRequest = fetch, verifyInstallation = true, leaseMs = 15000, requestTimeoutMs = 120000 } = {}) {
    this.dataDir = dataDir;
    this.command = command || path.join(dataDir, 'voice-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.worker = worker || fileURLToPath(new URL('../assistant/voice_worker.py', import.meta.url));
    this.modelDir = path.join(dataDir, 'models', 'sensevoice-int8');
    this.ttsCommand = command || path.join(dataDir, 'tts-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.qwenCommand = command || path.join(dataDir, 'qwen-tts-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.ttsModelDir = path.join(dataDir, 'models');
    this.verifyInstallation = verifyInstallation; this.leaseMs = leaseMs; this.requestTimeoutMs = requestTimeoutMs;
    this.shared = shared; this.ttsRequest = ttsRequest; this.ttsConnect = ttsConnect; this.catalogRequest = catalogRequest;
    this.#ensureTimer();
  }
  #ensureTimer() {
    if (this.#timer) return;
    this.#timer = setInterval(() => { if (this.#lease?.ready && !this.#opening && Date.now() - this.#lease.beat > this.leaseMs) void this.close(); }, Math.min(1000, this.leaseMs));
    this.#timer.unref();
  }
  get state() { return { status: this.#child && !this.#lease ? this.#resident ? 'idle' : 'stopping' : this.#lease ? !this.#lease.ready ? 'loading' : this.#pending.size || this.#synthesis ? 'busy' : 'on' : 'off', modelLoaded: Boolean(this.#resident && this.#child), recognitionLoaded: Boolean(this.#resident?.recognition && this.#child), draining: !this.#lease && this.#pending.size > 0, pid: this.#workerPid || this.#child?.pid || null, backend: this.#lease?.backend || this.#resident?.backend || 'CPU', model: this.#lease?.mode === 'synthesis' ? null : 'SenseVoice INT8', mode: this.#lease?.mode || null, synthesis: localProviders.includes(this.#provider) ? '本地 ' + localNames[this.#provider] : '火山引擎 · 豆包语音' }; }
  async #savedSettings() {
    this.#settings ??= (async () => {
      try { return { ...defaults, ...migrateLocalSettings(JSON.parse(await readFile(path.join(this.dataDir, 'voice-settings.json'), 'utf8'))) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return { ...defaults }; }
    })();
    const settings = await this.#settings; this.#provider = settings.provider; return settings;
  }
  async #sharedSettings() { this.shared ??= SharedSettings.load(path.dirname(this.dataDir)); return this.shared; }
  async #volcengine() { return volcenginePatch({}, (await this.#sharedSettings()).get('speech')?.volcengine); }
  async settings() {
    const settings = await this.#savedSettings(), catalog = await this.catalog({ provider: settings.provider });
    return { ...settings, volcengine: visibleVolcengine(await this.#volcengine()), voices: catalog.voices.map(item => item.id), voiceCatalog: catalog.voices, voiceCatalogSource: catalog.source, voiceLanguages: catalog.languages, synthesisCapabilities: settings.provider === 'qwen3tts' ? { ...catalog.capabilities, audioStreaming: settings.rate === 0 } : catalog.capabilities, synthesisValidation: settings.provider === 'volcengine' ? this.#validation : null };
  }
  async wakeSettings() { const { enabled, wakeEnabled, wakePhrases } = await this.#savedSettings(); return { enabled, wakeEnabled, wakePhrases: [...wakePhrases] }; }
  async catalog({ refresh = false, provider } = {}) {
    provider ??= (await this.#savedSettings()).provider;
    if (!['volcengine', ...localProviders].includes(provider)) throw Error('语音合成服务无效');
    if (localProviders.includes(provider)) return localCatalog(provider, (await this.#savedSettings()).voice);
    if (provider === 'volcengine') {
      this.#volcCatalog ??= loadVolcengineCatalog(this.dataDir);
      if (!refresh) return this.#volcCatalog;
      this.#volcRefresh ??= refreshVolcengineCatalog(this.dataDir, this.catalogRequest).then(result => { this.#volcCatalog = Promise.resolve(result); return result; });
      try { return await this.#volcRefresh; } finally { this.#volcRefresh = null; }
    }
    throw Error('语音合成服务无效');
  }
  async installed(mode = 'conversation') {
    try { if (this.verifyInstallation) await Promise.all([access(this.command), ...(mode === 'synthesis' ? [] : [access(path.join(this.modelDir, 'model.int8.onnx')), access(path.join(this.modelDir, 'tokens.txt')), access(path.join(this.modelDir, 'silero_vad.onnx'))])]); return true; } catch { return false; }
  }
  async localTtsInstalled(provider) {
    provider ??= (await this.#savedSettings()).provider;
    if (!localProviders.includes(provider)) return false;
    try { if (this.verifyInstallation) await Promise.all([access(provider === 'qwen3tts' ? this.qwenCommand : this.ttsCommand), ...localModelFiles[provider].map(file => access(path.join(this.ttsModelDir, localDirectories[provider], file)))]); return true; } catch { return false; }
  }
  async status() {
    const settings = await this.settings(), installations = Object.fromEntries(await Promise.all(localProviders.map(async provider => [provider, await this.localTtsInstalled(provider)]))), localInstalled = installations[settings.provider] || false;
    const synthesisError = localProviders.includes(settings.provider) ? localInstalled ? '' : `本地 ${localNames[settings.provider]} 模型未安装，请先初始化本地合成模型` : settings.provider === 'volcengine' ? volcengineSetupError(await this.#volcengine()) : '';
    const synthesisAvailable = localProviders.includes(settings.provider) ? localInstalled : settings.provider === 'volcengine' ? !synthesisError : await this.installed('synthesis');
    return { ...this.state, available: await this.installed(), synthesisAvailable, synthesisError, settings, setupDataDir: this.dataDir, localTts: { installed: localInstalled, installations, model: localNames[settings.provider] || '', backend: this.#lease?.backend || '按设备自动选择', threads: 2 } };
  }
  configure(patch) {
    const task = this.#writes.catch(() => {}).then(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('语音设置无效');
      const current = await this.#savedSettings(), next = { ...current, profiles: { ...current.profiles } };
      const provider = patch.provider ?? current.provider;
      if (!['volcengine', ...localProviders].includes(provider)) throw Error('语音合成服务无效');
      if (provider !== current.provider) {
        next.profiles[current.provider] = Object.fromEntries(['voice', 'rate', 'volume', 'pitch'].map(key => [key, current[key]]));
        Object.assign(next, next.profiles[provider] || { voice: localProviders.includes(provider) ? localVoices[provider][0].id : provider === 'volcengine' ? volcengineVoices[0].id : defaults.voice, rate: 0, volume: 0, pitch: 0 });
        next.provider = provider;
      }
      for (const key of ['enabled', 'wakeEnabled', 'autoListen', 'autoInterrupt', 'lowLatency']) if (key in patch) { if (typeof patch[key] !== 'boolean') throw Error('语音开关无效'); next[key] = patch[key]; }
      if ('wakePhrases' in patch) {
        if (!Array.isArray(patch.wakePhrases) || patch.wakePhrases.length > 12 || patch.wakePhrases.some(value => typeof value !== 'string' || [...value.trim()].length < 2 || [...value.trim()].length > 40 || !/[\p{L}\p{N}]/u.test(value) || /[\r\n\x00-\x1f]/.test(value))) throw Error('自定义唤醒短语需为2–40字，最多12条');
        next.wakePhrases = [...new Set(patch.wakePhrases.map(value => value.trim()))];
      }
      if ('voice' in patch) {
        const clone = provider === 'volcengine' && volcenginePatch(patch.volcengine || {}, await this.#volcengine()).modelName.startsWith('seed-icl-');
        if (clone ? typeof patch.voice !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(patch.voice) : !(provider === 'chattts' ? validChatVoice(patch.voice) : (await this.catalog({ provider })).voices.some(item => item.id === patch.voice) || patch.voice === next.voice)) throw Error('请选择有效音色或填写复刻音色 ID');
        next.voice = patch.voice;
      }
      const limits = localProviders.includes(provider) ? { rate: [-50, 100, '语速'], volume: [-100, 100, '音量'], pitch: [0, 0, '本地模型音调'] } : provider === 'volcengine' ? { rate: [-50, 100, '语速'], volume: [-50, 100, '音量'], pitch: [-12, 12, '音调'] } : { rate: [-99, 100, '语速'], volume: [-100, 100, '音量'], pitch: [-100, 100, '音调'] };
      for (const [key, [min, max, label]] of Object.entries(limits)) if (key in patch) { if (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max) throw Error(`${label}需在 ${min} 到 ${max} 之间`); next[key] = patch[key]; }
      if ('silenceMs' in patch) { if (!Number.isInteger(patch.silenceMs) || patch.silenceMs < 500 || patch.silenceMs > 2500) throw Error('静音等待需在 500 到 2500 毫秒之间'); next.silenceMs = patch.silenceMs; }
      if ('bargeInThreshold' in patch) { if (!Number.isInteger(patch.bargeInThreshold) || patch.bargeInThreshold < 2 || patch.bargeInThreshold > 40) throw Error('打断音量阈值需在 2% 到 40% 之间'); next.bargeInThreshold = patch.bargeInThreshold; }
      if ('bargeInDurationMs' in patch) { if (!Number.isInteger(patch.bargeInDurationMs) || patch.bargeInDurationMs < 200 || patch.bargeInDurationMs > 1500) throw Error('持续说话时间需在 200 到 1500 毫秒之间'); next.bargeInDurationMs = patch.bargeInDurationMs; }
      if ('volcengine' in patch || provider === 'volcengine' && ('voice' in patch || provider !== current.provider)) {
        const previous = await this.#volcengine(), draft = volcenginePatch(patch.volcengine || {}, previous);
        if (provider === 'volcengine') {
          const metadata = (await this.catalog({ provider })).voices.find(item => item.id === next.voice);
          if (metadata) {
            if (!draft.modelName.startsWith('seed-icl-') && (metadata.resourceId === 'seed-tts-2.0' || draft.modelName === 'seed-tts-2.0')) draft.modelName = draft.resourceId = metadata.resourceId;
            if (draft.emotion && !metadata.emotions.some(item => item.value === draft.emotion)) {
              if (patch.volcengine?.emotion) throw Error('所选音色不支持该情感');
              draft.emotion = '';
            }
          }
        }
        const shared = await this.#sharedSettings();
        await shared.update('speech', old => ({ ...old, volcengine: draft }));
      }
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dataDir, 'voice-settings.json');
      await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(`${file}.tmp`, file);
      this.#settings = Promise.resolve(next);
      this.#provider = provider;
      this.#validation = null;
      if (current.enabled && !next.enabled || provider !== current.provider || 'volcengine' in patch) await this.close();
      return this.settings();
    });
    this.#writes = task; return task;
  }
  #authorize(owner, leaseId) {
    if (!this.#lease || this.#lease.owner !== owner || this.#lease.id !== leaseId) throw Error('语音连接已失效，请重新开始');
    this.#lease.beat = Date.now();
  }
  prepare(owner) {
    if (this.#preparing) return this.#preparing.task;
    const item = { owner, cancelled: false };
    this.#preparing = item;
    item.task = (async () => {
      const settings = await this.#savedSettings();
      if (item.cancelled) throw Error('语音准备已取消');
      if (!settings.enabled) return { prepared: false, reason: 'disabled' };
      if (this.#lease || this.#child && !this.#resident) return { prepared: false, reason: 'busy' };
      if (!this.#child || !this.#resident?.recognition) {
        const opened = await this.#open(owner, { mode: 'conversation' });
        if (item.cancelled) throw Error('语音准备已取消');
        await this.close(owner, opened.leaseId, { keepWarm: true });
      }
      if (item.cancelled) throw Error('语音准备已取消');
      return { prepared: true, ...this.state };
    })().finally(() => { if (this.#preparing === item) this.#preparing = null; });
    return item.task;
  }
  async open(owner, options) {
    // A click during startup joins initialization and then takes its own lease.
    const preparation = this.#preparing;
    if (preparation) {
      await preparation.task.catch(() => {});
      if (preparation.cancelled) throw Error('语音启动已取消');
    }
    return this.#open(owner, options);
  }
  async #open(owner, { leaseId = randomUUID(), mode = 'conversation' } = {}) {
    this.#ensureTimer();
    if (!['conversation', 'synthesis', 'wake'].includes(mode)) throw Error('语音模式无效');
    if (typeof leaseId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(leaseId)) throw Error('语音连接标识无效');
    if (this.#cancelled.get(`${owner}:${leaseId}`) > Date.now()) throw Error('语音启动已取消');
    if (this.#lease || this.#child && !this.#resident) throw Error('另一窗口正在使用或释放本机语音');
    const epoch = ++this.#epoch, lease = { id: leaseId, owner, beat: Date.now(), mode, ready: false };
    this.#lease = lease;
    try {
      const settings = await this.#savedSettings(); lease.provider = settings.provider;
      if (mode !== 'synthesis' && !settings.enabled) throw Error('请先开启语音功能');
      if (mode === 'wake' && !settings.wakeEnabled) throw Error('语音唤醒已关闭');
      if (settings.provider === 'volcengine') { const missing = volcengineSetupError(await this.#volcengine()); if (missing) throw Error(missing); }
      if (localProviders.includes(settings.provider) && !await this.localTtsInstalled()) throw Error(`本地 ${localNames[settings.provider]} 模型未安装，请先初始化本地合成模型`);
      if (!(mode === 'synthesis' && (settings.provider === 'volcengine' || localProviders.includes(settings.provider))) && !(await this.installed(mode))) throw Error('语音运行时尚未安装，请运行语音初始化脚本');
      if (epoch !== this.#epoch || this.#lease !== lease) throw Error('语音启动已停止');
      if (mode === 'synthesis' && settings.provider === 'volcengine') { if (this.#resident) this.#resident.owner = owner; lease.ready = true; return { ...this.state, leaseId: lease.id }; }
    } catch (error) { if (this.#lease === lease) this.#lease = null; throw error; }
    if (this.#child && this.#resident) {
      const child = this.#child;
      try {
        // A stopped inference may still be finishing. Its output is discarded;
        // serialize the next job behind it without rebuilding the model.
        await Promise.all([...this.#pending.values()].map(item => item.done));
        if (epoch !== this.#epoch || this.#lease !== lease || this.#child !== child) throw Error('语音启动已停止');
        if (mode !== 'synthesis' && !this.#resident.recognition) {
          await this.#request('recognition-open', {});
          this.#resident.recognition = true;
        }
        if (epoch !== this.#epoch || this.#lease !== lease) throw Error('语音启动已停止');
        lease.backend = this.#resident.backend; lease.ready = true; lease.beat = Date.now();
        this.#resident.owner = owner;
        return { ...this.state, leaseId: lease.id, reused: true };
      } catch (error) { if (this.#lease === lease) await this.close(); throw error; }
    }
    const child = spawn(lease.provider === 'qwen3tts' ? this.qwenCommand : localProviders.includes(lease.provider) ? this.ttsCommand : this.command, [this.worker, '--model-dir', this.modelDir, '--tts-provider', lease.provider, '--tts-model-dir', path.join(this.ttsModelDir, localDirectories[lease.provider] || ''), ...(mode === 'synthesis' ? ['--synthesis-only'] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment() });
    this.#child = child; child.stderr.resume(); child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    let readyResolve, readyReject, readyTimer;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; readyTimer = setTimeout(() => reject(Error('本地语音模型启动超时')), this.requestTimeoutMs); });
    const failed = () => {
      readyReject(Error('本地语音进程已停止，请检查语音运行时'));
      if (this.#child !== child) return;
      this.#child = null; this.#workerPid = null; this.#lease = null; this.#resident = null;
      this.#ttsStream?.queue.fail(Error('语音进程已停止')); this.#ttsStream?.session?.cancel(); this.#ttsStream = null;
      this.#synthesis?.abort(); this.#synthesis = null;
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('语音进程已停止')); pending.settled(); }
      this.#pending.clear();
    };
    lines.on('line', line => {
      if (this.#child !== child) return;
      if (line.length > 8 * 1024 * 1024) { child.kill(); return; }
      let result; try { result = JSON.parse(line); } catch { return; }
      if (result.type === 'ready') { lease.backend = result.backend === 'cuda' ? 'CUDA' : 'CPU'; if (Number.isInteger(result.pid) && result.pid > 0) this.#workerPid = result.pid; readyResolve(); return; }
      if (result.type === 'startup-error') { readyReject(Error(localProviders.includes(lease.provider) ? '本地语音合成模型加载失败，请重新初始化所选模型' : mode === 'synthesis' ? '在线合成组件加载失败，请重新初始化语音运行时' : '本地语音模型加载失败，请重新初始化运行时')); return; }
      const pending = this.#pending.get(result.id); if (!pending || this.#child !== child) return;
      if (result.type === 'audio' && pending.onAudio) {
        try {
          if (typeof result.audio !== 'string' || !result.audio.length || result.audio.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.audio)) throw Error('本地流式音频格式无效');
          const bytes = Buffer.from(result.audio, 'base64');
          if (bytes.length % 2 || (pending.bytes += bytes.length) > 6 * 1024 * 1024) throw Error('本地流式音频过长');
          pending.onAudio(bytes);
        } catch (error) { pending.reject(error); void this.close(); }
        return;
      }
      this.#pending.delete(result.id); clearTimeout(pending.timer); pending.settled();
      result.ok ? pending.resolve(result) : pending.reject(Error(['speak','speak-stream'].includes(result.action) ? localProviders.includes(lease.provider) ? '本地语音合成失败，请检查模型与音色设置' : '在线语音合成失败，请检查网络后重试' : '本地语音识别失败，请重试'));
    });
    child.once('error', failed); child.once('exit', () => { lines.close(); failed(); });
    this.#opening = ready;
    try { await ready; if (epoch !== this.#epoch || this.#child !== child) throw Error('语音启动已停止'); lease.ready = true; lease.beat = Date.now(); this.#resident = { provider: lease.provider, owner, backend: lease.backend, recognition: mode !== 'synthesis' }; return { ...this.state, leaseId: lease.id, reused: false }; }
    catch (error) { if (this.#child === child) await this.close(); throw error; }
    finally { clearTimeout(readyTimer); if (this.#opening === ready) this.#opening = null; }
  }
  heartbeat(owner, { leaseId }) { this.#authorize(owner, leaseId); return this.state; }
  #request(action, payload, onAudio) {
    if (this.#pending.size || this.#synthesis && !onAudio) throw Error('上一项语音任务仍在处理');
    const child = this.#child; if (!child) throw Error('语音连接已失效');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled; const done = new Promise(finish => { settled = finish; });
      const timer = setTimeout(() => { this.#pending.delete(id); settled(); reject(Error('语音请求超时，请重新开始')); void this.close(); }, this.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer, onAudio, bytes: 0, done, settled });
      child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, error => { if (error) { clearTimeout(timer); this.#pending.delete(id); settled(); reject(Error('语音进程已停止')); } });
    });
  }
  async transcribe(owner, { leaseId, pcm }) {
    this.#authorize(owner, leaseId);
    if (this.#lease.mode === 'synthesis') throw Error('当前会话仅支持朗读，请开始语音对话后使用识别');
    if (typeof pcm !== 'string' || pcm.length < 1600 || pcm.length > 1280000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pcm)) throw Error('音频格式或长度无效，最长30秒');
    const bytes = Buffer.from(pcm, 'base64'); if (bytes.length % 2 || bytes.length > 960000) throw Error('音频格式无效');
    const result = await this.#request('transcribe', { pcm });
    this.#authorize(owner, leaseId);
    return { text: typeof result.text === 'string' ? result.text.slice(0, 4000).trim() : '' };
  }
  async speak(owner, { leaseId, text }) {
    this.#authorize(owner, leaseId);
    if (this.#lease.mode === 'wake') throw Error('唤醒监听不支持朗读');
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('朗读文字无效或过长');
    const settings = await this.settings();
    this.#authorize(owner, leaseId);
    let result;
    if (settings.provider === 'volcengine') {
      const config = await this.#volcengine(); this.#authorize(owner, leaseId);
      if (this.#pending.size || this.#synthesis) throw Error('上一项语音任务仍在处理');
      const controller = new AbortController(); this.#synthesis = controller;
      try {
        result = await synthesizeVolcengine({ text, voice: settings.voice, rate: settings.rate, volume: settings.volume, pitch: settings.pitch, config, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.requestTimeoutMs)]), request: this.ttsRequest, connect: this.ttsConnect });
        if (this.#synthesis === controller) this.#validation = { status: 'passed', voice: settings.voice, resourceId: config.resourceId, checkedAt: new Date().toISOString() };
      } catch (error) {
        if (this.#synthesis === controller && !controller.signal.aborted) this.#validation = { status: 'failed', voice: settings.voice, resourceId: config.resourceId, checkedAt: new Date().toISOString(), error: error.message };
        throw error;
      }
      finally { if (this.#synthesis === controller) this.#synthesis = null; }
    } else result = await this.#request('speak', { text:normalizeSpeechNumbers(text), provider: settings.provider, voice: settings.voice, rate: settings.rate, volume: settings.volume, pitch: settings.pitch });
    this.#authorize(owner, leaseId);
    if (typeof result.audio !== 'string' || !result.audio.length || result.audio.length > 8 * 1024 * 1024 || result.mime !== (localProviders.includes(settings.provider) ? 'audio/wav' : 'audio/mpeg')) throw Error('语音服务未返回有效音频');
    return { audio: result.audio, mime: result.mime };
  }
  async ttsStart(owner, { leaseId }) {
    this.#authorize(owner, leaseId);
    if (this.#lease.mode === 'wake') throw Error('唤醒监听不支持朗读');
    if (this.#synthesis || this.#pending.size || this.#ttsStream) throw Error('上一项语音任务仍在处理');
    const controller = new AbortController(), item = { id: randomUUID(), controller, queue: new TtsAudioQueue() };
    this.#ttsStream = item; this.#synthesis = controller;
    let settings, config;
    try {
      settings = await this.settings(); this.#authorize(owner, leaseId);
      if (settings.provider === 'chattts' || settings.provider === 'qwen3tts' && settings.rate === 0) {
        let text = '', begun = false;
        item.session = {
          write: async chunk => { if (begun || text.length + chunk.length > 2000) throw Error('本地流式文字无效或过长'); text += chunk; },
          finish: async () => {
            if (begun || !text.trim()) throw Error('没有可朗读的文字'); begun = true;
            this.#request('speak-stream', {text:normalizeSpeechNumbers(text), voice:settings.voice, rate:settings.rate, volume:settings.volume, pitch:settings.pitch}, bytes => {
              this.#authorize(owner, leaseId); item.queue.push(bytes);
            }).then(() => item.queue.end(), error => item.queue.fail(error));
          },
          cancel() {},
        };
        return {streamId:item.id, sampleRate:24000, mime:'audio/pcm', method:'local-stream'};
      }
      config = await this.#volcengine();
      if (settings.provider !== 'volcengine') throw Error('当前服务不使用火山流式语音');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
      signal.addEventListener('abort', () => item.queue.fail(signal.reason?.name === 'TimeoutError' ? Error('语音合成超时') : new DOMException('语音已停止', 'AbortError')), { once: true });
      item.session = await openVolcengineTts({ voice: settings.voice, rate: settings.rate, volume: settings.volume, pitch: settings.pitch, config, signal,
        request: this.ttsRequest, connect: this.ttsConnect, onAudio: async bytes => {
          this.#authorize(owner, leaseId); await item.queue.write(bytes); this.#authorize(owner, leaseId);
        } });
      item.session.done.then(() => {
        if (this.#ttsStream !== item || controller.signal.aborted) return;
        this.#validation = { status: 'passed', voice: settings.voice, modelName: config.modelName, resourceId: config.resourceId, method: config.method, checkedAt: new Date().toISOString() };
        item.queue.end();
      }, error => {
        if (this.#ttsStream !== item) return;
        if (!controller.signal.aborted) this.#validation = { status: 'failed', voice: settings.voice, modelName: config.modelName, method: config.method, checkedAt: new Date().toISOString(), error: error.message };
        item.queue.fail(error);
      });
      this.#authorize(owner, leaseId);
      return { streamId: item.id, sampleRate: config.sampleRate, mime: 'audio/pcm', method: config.method };
    } catch (error) {
      if (this.#ttsStream === item && config && settings && !controller.signal.aborted) this.#validation = { status: 'failed', voice: settings.voice, modelName: config.modelName, method: config.method, checkedAt: new Date().toISOString(), error: error.message };
      item.queue.fail(error); controller.abort(); item.session?.cancel();
      if (this.#ttsStream === item) { this.#ttsStream = null; if (this.#synthesis === controller) this.#synthesis = null; }
      throw error;
    }
  }
  #streamFor(owner, { leaseId, streamId }) {
    this.#authorize(owner, leaseId);
    if (!this.#ttsStream || this.#ttsStream.id !== streamId || !this.#ttsStream.session) throw Error('语音流已失效');
    return this.#ttsStream;
  }
  async ttsText(owner, args) {
    const item = this.#streamFor(owner, args);
    if (typeof args.text !== 'string' || args.text.length > 2000) throw Error('语音输入文字无效或过长');
    await item.session.write(args.text); return { ok: true };
  }
  async ttsFinish(owner, args) { await this.#streamFor(owner, args).session.finish(); return { ok: true }; }
  async ttsRead(owner, args) {
    const item = this.#streamFor(owner, args);
    try {
      const result = await item.queue.read(); this.#authorize(owner, args.leaseId);
      if (result.done && this.#ttsStream === item) { item.session.cancel(); this.#ttsStream = null; if (this.#synthesis === item.controller) this.#synthesis = null; }
      return result;
    } catch (error) { if (this.#ttsStream === item) { item.controller.abort(); item.session.cancel(); this.#ttsStream = null; if (this.#synthesis === item.controller) this.#synthesis = null; } throw error; }
  }
  async close(owner, leaseId, { keepWarm = false } = {}) {
    if (!keepWarm && leaseId === undefined && this.#preparing && (owner === undefined || this.#preparing.owner === owner)) this.#preparing.cancelled = true;
    if (typeof owner === 'string' && typeof leaseId === 'string') {
      for (const [key, deadline] of this.#cancelled) if (deadline < Date.now()) this.#cancelled.delete(key);
      if (this.#cancelled.size >= 256) this.#cancelled.delete(this.#cancelled.keys().next().value);
      this.#cancelled.set(`${owner}:${leaseId}`, Date.now() + this.requestTimeoutMs + 5000);
    }
    if (owner !== undefined && (this.#lease ? this.#lease.owner !== owner || leaseId !== undefined && this.#lease.id !== leaseId : leaseId !== undefined || this.#resident?.owner !== owner)) return;
    const retain = keepWarm && this.#lease?.ready && this.#resident && this.#child;
    this.#epoch++; this.#lease = null;
    const cancelled = new DOMException('语音已停止', 'AbortError');
    this.#ttsStream?.queue.fail(cancelled); this.#ttsStream?.session?.cancel(); this.#ttsStream = null;
    this.#synthesis?.abort(); this.#synthesis = null;
    if (retain) {
      for (const pending of this.#pending.values()) {
        pending.onAudio = () => {}; pending.reject(cancelled);
      }
      return;
    }
    this.#resident = null;
    const child = this.#child;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(cancelled); pending.settled(); }
    this.#pending.clear();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') {
        // Windows venv python.exe can be a launcher; terminate its actual model child too.
        await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, resolve));
      } else child.kill();
      await exited;
    }
    if (this.#child === child) { this.#child = null; this.#workerPid = null; }
  }
  async dispose() { clearInterval(this.#timer); this.#timer = null; this.#catalogChild?.kill(); await this.#catalogRefresh?.catch(() => {}); await this.close(); await this.#writes.catch(() => {}); }
}
