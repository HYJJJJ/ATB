import { conversationContext } from './assistant-context.js';
import { createAssistantVoice } from './assistant-voice.js';
const $ = id => document.getElementById(id);
const labels = { assistant: '智能助手', model: '模型服务', voice: '语音与集成' };
const fieldGroups = { model: ['provider', 'protocol', 'base-url', 'api-key', 'clear-key', 'model'], persona: ['name', 'prompt'], memory: ['memory'] };
const dirty = new Set();
const edits = { model: 0, persona: 0, memory: 0 };
let config, user = null, messages = [], needsSetup = false, models = [], chatController = null, chatVersion = 0;
let sessionTask, sessionTimer, noticeTimer, modelController, testController, authVersion = 0, modelVersion = 0;
let voiceStatus, voiceRefreshAt = 0, voiceEdit = 0;
const assistantVoice = createAssistantVoice({
  api, sendMessage, canChat: () => Boolean(user && config?.hasApiKey && config.model),
  onState({ active, phase, text }) {
    $('voice-live').textContent = text; $('voice-start').hidden = active; $('voice-stop').hidden = !active;
    $('voice-interrupt').hidden = !active || !['thinking', 'synthesizing', 'speaking', 'transcribing'].includes(phase);
    $('voice-live').dataset.phase = phase;
  },
  onError(text) { $('chat-error').textContent = text; },
});
function fillVoice(next) {
  voiceStatus = next; const settings = next.settings;
  $('voice-start').disabled = !next.available;
  $('voice-runtime-state').textContent = next.available ? next.pid ? '本机模型运行中' : '本机已就绪 · 按需加载' : '本机语音不可用';
  $('voice-availability').textContent = next.available ? '本机识别 + 在线合成。语音设置保存在当前电脑。' : window.atbDesktop ? `请在项目目录使用 Python 3.10、3.11 或 3.12 运行：python modules/assistant/scripts/setup-assistant-voice.py --data-dir "${next.setupDataDir}"，完成后自动重新检测。` : '当前服务没有本机语音运行时。可使用已初始化的桌面端；云端网页尚未接入远程语音计算。';
  if (!assistantVoice.active) $('voice-live').textContent = next.available ? '本机语音就绪 · 点击开始后使用麦克风' : '本机语音不可用 · 查看语音设置';
  $('voice-preview').disabled = !next.available || !settings.enabled;
  if (dirty.has('voice')) return;
  $('voice-enabled').checked = settings.enabled; $('voice-name').value = settings.voice; $('voice-rate').value = String(settings.rate); $('voice-silence').value = String(settings.silenceMs); $('voice-auto').checked = settings.autoListen;
}
async function refreshVoice(force = false) {
  if (!user || !force && Date.now() - voiceRefreshAt < 15000) return;
  voiceRefreshAt = Date.now(); const version = authVersion;
  try { const next = await assistantVoice.status(); if (version === authVersion && user) fillVoice(next); }
  catch { if (version === authVersion) { $('voice-start').disabled = true; $('voice-live').textContent = '暂时无法检测语音服务'; } }
}
const historyKey = () => `homebase.chat.${user?.username ?? ''}`;
function persistHistory() { if (user) try { sessionStorage.setItem(historyKey(), JSON.stringify(messages.slice(-40))); } catch {} }
function loadHistory() { try { const value = JSON.parse(sessionStorage.getItem(historyKey()) || '[]'); messages = Array.isArray(value) ? value.filter(m => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string').slice(-40) : []; } catch { messages = []; } }
function connected(value) { $('service-status').textContent = value ? '服务已连接' : '连接中断 · 正在重试'; $('service-status').dataset.state = value ? 'connected' : 'offline'; $('network-banner').hidden = value; }
async function api(url, data, signal) {
  const version = authVersion;
  const response = await fetch(url, { signal: signal || AbortSignal.timeout(65000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  let result; try { result = await response.json(); } catch { throw Error('服务返回异常，请稍后重试'); }
  if (response.status === 401 && version === authVersion && !url.startsWith('/api/auth/')) { signedOut('登录已过期，请重新登录'); }
  if (!response.ok) { const error = Error(result.error || '请求失败'); error.status = response.status; throw error; }
  return result;
}
function show(page, replace = false) {
  if (!labels[page]) page = 'assistant';
  if (page !== 'assistant' && assistantVoice.active) { stopChat(); void assistantVoice.stop(); }
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${page}`);
  document.querySelectorAll('.nav').forEach(el => { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('breadcrumb').textContent = labels[page];
  if (location.hash !== `#${page}`) history[replace ? 'replaceState' : 'pushState'](null, '', `#${page}`);
}
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => show(el.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => show(el.dataset.goto)));
window.addEventListener('popstate', () => show(location.hash.slice(1), true));
function notice(text) { $('notice').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 4500); }
function setDirty(scope, value) { if (value) edits[scope]++; value ? dirty.add(scope) : dirty.delete(scope); $(`${scope}-state`).textContent = value ? '未保存' : '已保存'; $(`${scope}-state`).dataset.dirty = String(value); }
for (const [scope, ids] of Object.entries(fieldGroups)) for (const id of ids) $(id).addEventListener('input', () => { setDirty(scope, true); $(`${scope}-result`).textContent = ''; });
function summary() {
  if (!config) return;
  const ready = Boolean(config.hasApiKey && config.model);
  $('assistant-name').textContent = config.name; $('assistant-setup').hidden = ready;
  if (!chatController) $('chat-state').textContent = ready ? config.model : '等待配置模型';
  $('key-state').textContent = config.hasApiKey ? '已保存密钥。留空保留；更换地址需填写新密钥。' : '尚未保存密钥。';
}
function fill(next, scopes = ['model', 'persona', 'memory']) {
  config = next;
  for (const scope of scopes) {
    if (scope === 'model') {
      for (const key of ['provider','protocol','model']) $(key).value = next[key] || (key === 'protocol' ? 'chat' : '');
      $('base-url').value = next.baseUrl || ''; $('base-url').readOnly = next.provider !== 'custom'; $('api-key').value = ''; $('clear-key').checked = false;
    } else for (const key of fieldGroups[scope]) $(key).value = next[key];
    setDirty(scope, false);
  }
  summary();
}
function stopChat() { chatVersion++; chatController?.abort(); chatController = null; $('stop-chat').hidden = true; $('chat-form').querySelector('[type=submit]').disabled = false; summary(); }
function signedOut(message = '') {
  authVersion++; stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort(); voiceRefreshAt = 0;
  if (user) try { sessionStorage.removeItem(historyKey()); } catch {}
  user = null; messages = []; config = null; $('messages').replaceChildren(); $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; $('user-label').textContent = '访客'; $('login-error').textContent = message;
  $('api-key').value = ''; $('prompt').value = ''; $('memory').value = ''; dirty.clear();
}
async function refreshSession() {
  if (sessionTask) return sessionTask;
  sessionTask = (async () => {
    const version = authVersion; let retryDelay = document.hidden ? 20000 : 8000;
    try {
      const session = await api('/api/auth/session', undefined, AbortSignal.timeout(6000)); if (version !== authVersion) return; connected(true); needsSetup = session.needsSetup;
      $('login-title').textContent = needsSetup ? '创建管理员账号' : '登录工作台'; $('confirm-row').hidden = !needsSetup;
      $('login-note').textContent = needsSetup ? session.canSetup ? '创建账号后使用 ATB 智能助手。' : '请先在运行服务的电脑上创建管理员账号。' : '使用 ATB 管理员账号继续。';
      $('login-form').querySelector('button').disabled = needsSetup && !session.canSetup;
      if (!session.user) { if (user) signedOut('登录已过期，请重新登录'); else $('login').hidden = false; return; }
      const changed = !user || user.username !== session.user.username; user = session.user;
      $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; $('user-label').textContent = user.username;
      if (changed || !config) {
        const next = await api('/api/assistant/settings'); if (version !== authVersion || !user) return;
        fill(next); loadHistory(); renderMessages(); show(location.hash.slice(1) || 'assistant', true);
      }
      void refreshVoice();
    } catch { if (version === authVersion) { retryDelay = 1500; connected(false); if (!user) { $('login').hidden = false; $('login-error').textContent = '暂时无法连接服务，正在自动检测恢复。'; } } }
    finally { sessionTask = null; clearTimeout(sessionTimer); sessionTimer = setTimeout(() => void refreshSession(), retryDelay); }
  })(); return sessionTask;
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'), form = new FormData(event.currentTarget); button.disabled = true;
  try {
    if (needsSetup && form.get('password') !== form.get('confirm')) throw Error('两次密码不一致');
    await api(needsSetup ? '/api/auth/setup' : '/api/auth/login', { username: form.get('username'), password: form.get('password') });
    $('login-form').reset(); $('login-error').textContent = ''; await refreshSession();
  } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true; stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort();
  try { await api('/api/auth/logout', {}); signedOut(); await refreshSession(); }
  catch (error) { notice(`退出失败：${error.message}`); } finally { $('logout').disabled = false; }
});
function modelDraft() { return { provider: $('provider').value, baseUrl: $('base-url').value, protocol: $('protocol').value, model: $('model').value, apiKey: $('api-key').value, clearKey: $('clear-key').checked }; }
for (const scope of ['model','persona','memory']) $(scope === 'model' ? 'model-form' : `${scope}-form`).addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'), result = $(`${scope}-result`); button.disabled = true; result.dataset.error = 'false'; result.textContent = '正在保存…';
  const edit = edits[scope], version = authVersion;
  try {
    const body = scope === 'model' ? modelDraft() : Object.fromEntries(fieldGroups[scope].map(key => [key, $(key).value]));
    const next = await api('/api/assistant/settings', { scope, ...body });
    if (version !== authVersion || !user) return;
    const keys = scope === 'model' ? ['provider', 'baseUrl', 'protocol', 'model', 'hasApiKey'] : fieldGroups[scope];
    const merged = { ...config, ...Object.fromEntries(keys.map(key => [key, next[key]])) };
    const unchanged = edit === edits[scope]; fill(merged, unchanged ? [scope] : []);
    result.textContent = unchanged ? '已保存' : '上次提交已保存，当前新修改尚未保存';
  } catch (error) { if (version === authVersion) { result.dataset.error = 'true'; result.textContent = error.message; } } finally { button.disabled = false; }
});
function cancelModels() { modelVersion++; modelController?.abort(); modelController = null; $('load-models').disabled = false; }
function resetModels() { cancelModels(); models = []; $('model-picker').hidden = true; $('model-filter').value = ''; $('available-models').replaceChildren(new Option('请选择一个模型', '')); $('models-status').textContent = '接口已更改，请重新获取模型列表。'; }
$('provider').addEventListener('change', () => {
  const presets = { dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1', openai: 'https://api.openai.com/v1' };
  $('base-url').readOnly = $('provider').value !== 'custom'; $('base-url').value = presets[$('provider').value] || ''; $('protocol').value = 'chat'; $('model').value = ''; $('api-key').value = ''; resetModels();
  $('models-status').textContent = '填写地址和密钥后，获取模型列表。'; setDirty('model', true);
});
$('base-url').addEventListener('input', resetModels);
$('api-key').addEventListener('input', resetModels); $('clear-key').addEventListener('change', resetModels);
function renderModelOptions() {
  const filter = $('model-filter').value.toLowerCase(); const current = $('model').value;
  const filtered = models.filter(name => name.toLowerCase().includes(filter));
  $('available-models').replaceChildren(new Option('请选择一个模型', ''), ...filtered.map(name => new Option(name, name)));
  if (filtered.includes(current)) $('available-models').value = current;
}
$('model-filter').addEventListener('input', renderModelOptions);
$('available-models').addEventListener('change', () => { if ($('available-models').value) { $('model').value = $('available-models').value; setDirty('model', true); } });
$('load-models').addEventListener('click', async () => {
  const button = $('load-models'); cancelModels(); const version = modelVersion, controller = new AbortController(); modelController = controller; button.disabled = true; $('models-status').textContent = '正在从服务商获取模型…';
  try { const result = await api('/api/assistant/models', modelDraft(), controller.signal); if (version !== modelVersion || !user) return; models = result.models; renderModelOptions(); $('model-picker').hidden = !models.length; $('models-status').textContent = models.length ? `获取到 ${models.length} 个模型。选择后保存；当前选择不会自动改变。` : '没有返回模型，可手动填写。'; }
  catch (error) { if (version === modelVersion && error.name !== 'AbortError') $('models-status').textContent = `${error.message} 可手动填写模型名称。`; }
  finally { if (version === modelVersion) { button.disabled = false; modelController = null; } }
});
$('test-model').addEventListener('click', async () => {
  const result = $('model-result');
  if (dirty.has('model')) { result.dataset.error = 'true'; result.textContent = '当前有未保存的模型配置，请先保存。'; return; }
  const button = $('test-model'), start = performance.now(), version = authVersion; testController = new AbortController(); button.disabled = true; result.dataset.error = 'false'; result.textContent = '正在测试，发起一次短文本请求…';
  try { await api('/api/assistant/test', {}, testController.signal); if (version === authVersion && user) result.textContent = `连接测试通过 · ${((performance.now() - start) / 1000).toFixed(1)} 秒`; }
  catch (error) { if (version === authVersion && error.name !== 'AbortError') { result.dataset.error = 'true'; result.textContent = error.message; } } finally { button.disabled = false; testController = null; }
});
function renderMessages() {
  $('messages').replaceChildren();
  if (!messages.length) {
    const div = document.createElement('div'); div.className = 'welcome'; const title = document.createElement('h2'), help = document.createElement('p'); title.textContent = '有什么可以帮你？'; help.textContent = config?.hasApiKey && config?.model ? '试着打个招呼，或告诉我你的一个偏好。' : '先配置模型，再开始对话。'; div.append(title, help); $('messages').append(div); return;
  }
  for (const message of messages) { const el = document.createElement('div'), label = document.createElement('span'), content = document.createElement('span'); el.className = `bubble ${message.role}`; label.className = 'bubble-label'; label.textContent = message.role === 'user' ? '你' : config?.name || '助手'; content.textContent = message.content; el.append(label, content); $('messages').append(el); }
  $('messages').scrollTop = $('messages').scrollHeight;
}
$('clear-chat').addEventListener('click', () => { stopChat(); void assistantVoice.stop(); messages = []; persistHistory(); renderMessages(); $('chat-error').textContent = ''; });
$('stop-chat').addEventListener('click', () => { stopChat(); void assistantVoice.stop(); $('chat-error').textContent = '已停止本次等待。'; });
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && innerWidth > 760) { event.preventDefault(); if (!chatController) $('chat-form').requestSubmit(); } });
async function sendMessage(content, { signal, fromVoice = false } = {}) {
  if (chatController || !content) return;
  if (!config?.hasApiKey || !config.model) { $('chat-error').textContent = '请先在模型服务中配置密钥和模型。'; return; }
  const version = ++chatVersion, controller = new AbortController(); chatController = controller;
  if (!fromVoice) $('chat-input').value = ''; $('chat-error').textContent = ''; messages.push({ role: 'user', content }); renderMessages(); persistHistory();
  $('chat-form').querySelector('[type=submit]').disabled = true; $('stop-chat').hidden = false; $('chat-state').textContent = '正在思考…';
  try {
    const result = await api('/api/assistant/chat', { messages: conversationContext(messages) }, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
    if (version !== chatVersion || !user) return; messages.push({ role: 'assistant', content: result.reply }); renderMessages(); persistHistory(); return result.reply;
  } catch (error) { if (version === chatVersion && user) { $('chat-error').textContent = error.name === 'AbortError' ? '请求已停止。' : error.message; if (!fromVoice) $('chat-input').value = content; } if (fromVoice) throw error; }
  finally { if (version === chatVersion) { chatController = null; $('chat-form').querySelector('[type=submit]').disabled = false; $('stop-chat').hidden = true; summary(); } }
}
$('chat-form').addEventListener('submit', async event => { event.preventDefault(); if (assistantVoice.active) await assistantVoice.stop(); await sendMessage($('chat-input').value.trim()); });
$('voice-start').addEventListener('click', async () => { stopChat(); $('voice-start').disabled = true; $('chat-error').textContent = ''; try { await assistantVoice.start(); } catch (error) { $('chat-error').textContent = error.message; } finally { await refreshVoice(true); } });
$('voice-stop').addEventListener('click', () => { stopChat(); void assistantVoice.stop().then(() => refreshVoice(true)); });
$('voice-interrupt').addEventListener('click', async () => { stopChat(); try { await assistantVoice.interrupt(); } catch (error) { $('chat-error').textContent = error.message; } });
for (const id of ['voice-enabled', 'voice-name', 'voice-rate', 'voice-silence', 'voice-auto']) $(id).addEventListener('input', () => { voiceEdit++; dirty.add('voice'); $('voice-state').textContent = '未保存'; $('voice-state').dataset.dirty = 'true'; $('voice-result').textContent = ''; });
$('voice-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'), edit = voiceEdit, version = authVersion; button.disabled = true;
  const options = { enabled: $('voice-enabled').checked, voice: $('voice-name').value, rate: Number($('voice-rate').value), silenceMs: Number($('voice-silence').value), autoListen: $('voice-auto').checked };
  try {
    if (!options.enabled) stopChat(); const saved = await assistantVoice.configure(options); if (version !== authVersion || !user) return;
    if (edit === voiceEdit) { dirty.delete('voice'); $('voice-state').textContent = '已保存'; $('voice-state').dataset.dirty = 'false'; fillVoice({ ...voiceStatus, settings: saved }); }
    $('voice-result').textContent = edit === voiceEdit ? '语音设置已保存' : '已保存，新的修改尚未保存';
  } catch (error) { if (version === authVersion) $('voice-result').textContent = error.message; } finally { button.disabled = false; }
});
$('voice-preview').addEventListener('click', async () => {
  if (dirty.has('voice')) { $('voice-result').textContent = '请先保存音色设置，再试听。'; return; }
  const version = authVersion; $('voice-preview').disabled = true; $('voice-result').textContent = '正在生成试听语音…';
  try { await assistantVoice.preview(); if (version === authVersion && user) $('voice-result').textContent = '试听完成'; }
  catch (error) { if (version === authVersion) $('voice-result').textContent = error.message; } finally { await refreshVoice(true); }
});
if (window.atbDesktop) { document.documentElement.classList.add('desktop'); $('connection').hidden = false; $('connection').addEventListener('click', () => window.atbDesktop.openConnectionSettings().catch(error => notice(error.message))); }
$('service-host').textContent = location.host;
window.addEventListener('online', () => void refreshSession()); document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshSession(); });
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort(); clearTimeout(sessionTimer); });
void refreshSession();
