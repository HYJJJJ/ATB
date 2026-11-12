import { spawn, execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const defaults = { enabled: false, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, silenceMs: 1000, autoListen: true };
const voices = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural'];
const runtimes = new Map();
function workerEnvironment() {
  const allowed = /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|lang|lc_all)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', OMP_NUM_THREADS: '2' };
}
export function getVoiceRuntime(dataDir) {
  const root = path.resolve(dataDir);
  if (!runtimes.has(root)) runtimes.set(root, new VoiceRuntime({ dataDir: root }));
  return runtimes.get(root);
}

// The same bounded worker is used by authenticated HTTP and trusted desktop IPC.
export class VoiceRuntime {
  #settings; #writes = Promise.resolve(); #child; #workerPid; #lease; #opening; #pending = new Map(); #cancelled = new Map(); #timer; #epoch = 0;
  constructor({ dataDir, command, worker, verifyInstallation = true, leaseMs = 15000, requestTimeoutMs = 45000 } = {}) {
    this.dataDir = dataDir;
    this.command = command || path.join(dataDir, 'voice-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.worker = worker || fileURLToPath(new URL('../assistant/voice_worker.py', import.meta.url));
    this.modelDir = path.join(dataDir, 'models', 'sensevoice-int8');
    this.verifyInstallation = verifyInstallation; this.leaseMs = leaseMs; this.requestTimeoutMs = requestTimeoutMs;
    this.#ensureTimer();
  }
  #ensureTimer() {
    if (this.#timer) return;
    this.#timer = setInterval(() => { if (this.#lease && this.#child && !this.#opening && Date.now() - this.#lease.beat > this.leaseMs) void this.close(); }, Math.min(1000, this.leaseMs));
    this.#timer.unref();
  }
  get state() { return { status: this.#child ? !this.#lease ? 'stopping' : this.#opening ? 'loading' : this.#pending.size ? 'busy' : 'on' : this.#lease ? 'loading' : 'off', pid: this.#workerPid || this.#child?.pid || null, backend: 'CPU', model: 'SenseVoice INT8', synthesis: 'EdgeTTS' }; }
  async settings() {
    this.#settings ??= (async () => {
      try { return { ...defaults, ...JSON.parse(await readFile(path.join(this.dataDir, 'voice-settings.json'), 'utf8')) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return { ...defaults }; }
    })();
    return { ...await this.#settings, voices };
  }
  async installed() {
    try { if (this.verifyInstallation) await Promise.all([access(this.command), access(path.join(this.modelDir, 'model.int8.onnx')), access(path.join(this.modelDir, 'tokens.txt')), access(path.join(this.modelDir, 'silero_vad.onnx'))]); return true; } catch { return false; }
  }
  async status() { return { ...this.state, available: await this.installed(), settings: await this.settings(), setupDataDir: this.dataDir }; }
  configure(patch) {
    const task = this.#writes.catch(() => {}).then(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('语音设置无效');
      const next = { ...await this.settings() }; delete next.voices;
      for (const key of ['enabled', 'autoListen']) if (key in patch) { if (typeof patch[key] !== 'boolean') throw Error('语音开关无效'); next[key] = patch[key]; }
      if ('voice' in patch) { if (!voices.includes(patch.voice)) throw Error('请选择有效音色'); next.voice = patch.voice; }
      if ('rate' in patch) { if (!Number.isInteger(patch.rate) || patch.rate < -50 || patch.rate > 50) throw Error('语速需在 -50 到 50 之间'); next.rate = patch.rate; }
      if ('silenceMs' in patch) { if (!Number.isInteger(patch.silenceMs) || patch.silenceMs < 500 || patch.silenceMs > 2500) throw Error('静音等待需在 500 到 2500 毫秒之间'); next.silenceMs = patch.silenceMs; }
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dataDir, 'voice-settings.json');
      await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(`${file}.tmp`, file);
      this.#settings = Promise.resolve(next);
      if (!next.enabled) await this.close();
      return { ...next, voices };
    });
    this.#writes = task; return task;
  }
  #authorize(owner, leaseId) {
    if (!this.#lease || this.#lease.owner !== owner || this.#lease.id !== leaseId) throw Error('语音连接已失效，请重新开始');
    this.#lease.beat = Date.now();
  }
  async open(owner, { leaseId = randomUUID() } = {}) {
    this.#ensureTimer();
    if (typeof leaseId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(leaseId)) throw Error('语音连接标识无效');
    if (this.#cancelled.get(`${owner}:${leaseId}`) > Date.now()) throw Error('语音启动已取消');
    if (this.#lease || this.#child) throw Error('另一窗口正在使用或释放本机语音');
    const epoch = ++this.#epoch, lease = { id: leaseId, owner, beat: Date.now() };
    this.#lease = lease;
    try {
      if (!(await this.settings()).enabled) throw Error('请先开启语音功能');
      if (!(await this.installed())) throw Error('本机语音运行时尚未安装，请运行语音初始化脚本');
      if (epoch !== this.#epoch || this.#lease !== lease) throw Error('语音启动已停止');
    } catch (error) { if (this.#lease === lease) this.#lease = null; throw error; }
    const child = spawn(this.command, [this.worker, '--model-dir', this.modelDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment() });
    this.#child = child; child.stderr.resume(); child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    let readyResolve, readyReject, readyTimer;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; readyTimer = setTimeout(() => reject(Error('本地语音模型启动超时')), this.requestTimeoutMs); });
    const failed = () => {
      readyReject(Error('本地语音进程已停止，请检查语音运行时'));
      if (this.#child !== child) return;
      this.#child = null; this.#workerPid = null; this.#lease = null;
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('语音进程已停止')); }
      this.#pending.clear();
    };
    lines.on('line', line => {
      if (this.#child !== child) return;
      if (line.length > 8 * 1024 * 1024) { child.kill(); return; }
      let result; try { result = JSON.parse(line); } catch { return; }
      if (result.type === 'ready') { if (Number.isInteger(result.pid) && result.pid > 0) this.#workerPid = result.pid; readyResolve(); return; }
      if (result.type === 'startup-error') { readyReject(Error('本地语音模型加载失败，请重新初始化运行时')); return; }
      const pending = this.#pending.get(result.id); if (!pending || this.#child !== child) return;
      this.#pending.delete(result.id); clearTimeout(pending.timer);
      result.ok ? pending.resolve(result) : pending.reject(Error(result.action === 'speak' ? '在线语音合成失败，请检查网络后重试' : '本地语音识别失败，请重试'));
    });
    child.once('error', failed); child.once('exit', () => { lines.close(); failed(); });
    this.#opening = ready;
    try { await ready; if (epoch !== this.#epoch || this.#child !== child) throw Error('语音启动已停止'); lease.beat = Date.now(); return { ...this.state, leaseId: lease.id }; }
    catch (error) { if (this.#child === child) await this.close(); throw error; }
    finally { clearTimeout(readyTimer); if (this.#opening === ready) this.#opening = null; }
  }
  heartbeat(owner, { leaseId }) { this.#authorize(owner, leaseId); return this.state; }
  #request(action, payload) {
    if (this.#pending.size) throw Error('上一项语音任务仍在处理');
    const child = this.#child; if (!child) throw Error('语音连接已失效');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(Error('语音请求超时，请重新开始')); void this.close(); }, this.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, error => { if (error) { clearTimeout(timer); this.#pending.delete(id); reject(Error('语音进程已停止')); } });
    });
  }
  async transcribe(owner, { leaseId, pcm }) {
    this.#authorize(owner, leaseId);
    if (typeof pcm !== 'string' || pcm.length < 1600 || pcm.length > 1280000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pcm)) throw Error('音频格式或长度无效，最长30秒');
    const bytes = Buffer.from(pcm, 'base64'); if (bytes.length % 2 || bytes.length > 960000) throw Error('音频格式无效');
    const result = await this.#request('transcribe', { pcm });
    this.#authorize(owner, leaseId);
    return { text: typeof result.text === 'string' ? result.text.slice(0, 4000).trim() : '' };
  }
  async speak(owner, { leaseId, text }) {
    this.#authorize(owner, leaseId);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('朗读文字无效或过长');
    const settings = await this.settings();
    const result = await this.#request('speak', { text, voice: settings.voice, rate: settings.rate });
    this.#authorize(owner, leaseId);
    if (typeof result.audio !== 'string' || result.audio.length > 8 * 1024 * 1024 || result.mime !== 'audio/mpeg') throw Error('语音服务未返回有效音频');
    return { audio: result.audio, mime: result.mime };
  }
  async close(owner, leaseId) {
    if (typeof owner === 'string' && typeof leaseId === 'string') {
      for (const [key, deadline] of this.#cancelled) if (deadline < Date.now()) this.#cancelled.delete(key);
      if (this.#cancelled.size >= 256) this.#cancelled.delete(this.#cancelled.keys().next().value);
      this.#cancelled.set(`${owner}:${leaseId}`, Date.now() + this.requestTimeoutMs + 5000);
    }
    if (owner !== undefined && (!this.#lease || this.#lease.owner !== owner || leaseId !== undefined && this.#lease.id !== leaseId)) return;
    this.#epoch++; this.#lease = null;
    const child = this.#child;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('语音已停止')); }
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
  async dispose() { clearInterval(this.#timer); this.#timer = null; await this.close(); await this.#writes.catch(() => {}); }
}
