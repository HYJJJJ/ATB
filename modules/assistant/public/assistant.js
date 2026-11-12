import { conversationContext } from './assistant-context.js';
import { createAssistantVoice } from './assistant-voice.js';
const $ = id => document.getElementById(id);
const labels = { assistant: '智能助手', model: '模型服务', voice: '语音与集成' };
const fieldGroups = { model: ['api-source', 'provider', 'protocol', 'base-url', 'api-key', 'clear-key', 'model'], persona: ['name', 'prompt'], memory: ['memory'] };
const dirty = new Set();
const edits = { model: 0, persona: 0, memory: 0 };
let config, user = null, messages = [], needsSetup = false, models = [], chatController = null, chatVersion = 0;
let sessionTask, sessionTimer, noticeTimer, modelController, testController, authVersion = 0, modelVersion = 0, settingsRevision = 0;
let selectedModels = [], dialogModels = new Set(), voiceStatus, voiceRefreshAt = 0, voiceEdit = 0;
const assistantVoice = createAssistantVoice({
  api, sendMessage, canChat: () => Boolean(user && config?.hasApiKey && config.model),
  onState({ active, phase, text }) {
    $('voice-live').textContent = text; $('voice-start').hidden = active; $('voice-stop').hidden = !active;
    $('voice-interrupt').hidden = !active || !['thinking', 'synthesizing', 'speaking', 'transcribing'].includes(phase);
    $('voice-live').dataset.phase = phase; $('voice-preview-stop').hidden = !active; if (active) $('voice-result').textContent = text;
  },
  onError(text) { $('chat-error').textContent = text; },
});
function fillVoice(next) {
  voiceStatus = next; const settings = next.settings;
  $('voice-start').disabled = !next.available;
  const online = next.synthesisAvailable ?? next.available;
  const system = Boolean(window.speechSynthesis);
  $('voice-availability').textContent = online ? '朗读：在线 EdgeTTS 合成 → 本机播放。麦克风语音对话另需识别运行时。试听和朗读不需要开启麦克风。' : system ? '朗读：当前使用浏览器系统语音，音色由系统提供，下方 EdgeTTS 音色设置暂不生效。麦克风对话需要安装本机运行时。' : '没有可用朗读服务。请使用已初始化语音运行时的桌面端，或支持系统语音的浏览器。';
  $('voice-runtime-state').textContent = online ? '在线 EdgeTTS · 本机播放' : system ? '浏览器系统语音' : '朗读不可用';
  if (!assistantVoice.active) $('voice-live').textContent = next.available ? '识别运行时就绪 · 点击开始后使用麦克风' : online ? '在线朗读可用 · 识别运行时未安装' : system ? '系统朗读可用 · 识别运行时未安装' : '语音不可用 · 查看语音设置';
  $('voice-preview').disabled = !online && !system;
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
  if (!chatController) $('chat-state').textContent = ready ? ($('chat-model').value || config.model) : '等待配置模型';
  $('key-state').textContent = config.hasApiKey ? `${config.apiSource === 'custom' ? '本助手自定义' : '平台默认'} API 已配置 · 密钥已保存，留空保留。` : '尚未保存密钥。';
  $('api-key').placeholder = config.hasApiKey ? '密钥已配置 · 留空保留' : '填写服务商密钥';
  const current = $('chat-model').value; const options = config.selectedModels?.length ? config.selectedModels : [config.model].filter(Boolean);
  $('chat-model').replaceChildren(...options.map(name => new Option(name, name))); $('chat-model').value = options.includes(current) ? current : config.model || options[0] || '';
  $('chat-model').disabled = !ready || Boolean(chatController);
}
function fill(next, scopes = ['model', 'persona', 'memory']) {
  config = next;
  for (const scope of scopes) {
    if (scope === 'model') {
      $('api-source').value = next.apiSource || 'platform'; selectedModels = next.selectedModels || [next.model].filter(Boolean); renderSelectedModels(); sourceState();
      for (const key of ['provider','protocol','model']) $(key).value = next[key] || (key === 'protocol' ? 'chat' : '');
      $('base-url').value = next.baseUrl || ''; $('base-url').readOnly = next.provider !== 'custom'; $('api-key').value = ''; $('clear-key').checked = false;
    } else for (const key of fieldGroups[scope]) $(key).value = next[key];
    setDirty(scope, false);
  }
  summary();
}
function fillCleanSettings(next) { fill(next, Object.keys(fieldGroups).filter(scope => !dirty.has(scope))); }
function stopChat() { chatVersion++; chatController?.abort(); chatController = null; $('stop-chat').hidden = true; $('chat-form').querySelector('[type=submit]').disabled = false; summary(); }
function signedOut(message = '') {
  authVersion++; stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort(); voiceRefreshAt = 0;
  if (user) try { sessionStorage.removeItem(historyKey()); } catch {}
  user = null; messages = []; config = null; $('messages').replaceChildren(); $('login').hidden = false; $('workspace').hidden = true; $('user-label').textContent = '访客'; $('login-error').textContent = message;
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
      $('login').hidden = true; $('workspace').hidden = false; $('user-label').textContent = user.username;
      if (changed || !config) {
        const next = await api('/api/assistant/settings'); if (version !== authVersion || !user) return;
        fill(next); loadHistory(); renderMessages(); show(location.hash.slice(1) || 'assistant', true);
      } else if (!chatController) {
        const revision = settingsRevision;
        const next = await api('/api/assistant/settings');
        if (version !== authVersion || !user) return;
        if (!chatController && revision === settingsRevision) fillCleanSettings(next);
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
function modelDraft() { return { apiSource: $('api-source').value, provider: $('provider').value, baseUrl: $('base-url').value, protocol: $('protocol').value, model: $('model').value, selectedModels: [...new Set([...selectedModels, $('model').value].filter(Boolean))], apiKey: $('api-key').value, clearKey: $('clear-key').checked }; }
function renderSelectedModels() {
  $('selected-models').replaceChildren(...selectedModels.map(name => { const el = document.createElement('span'); el.className = 'model-chip'; el.textContent = name; return el; }));
}
function sourceState() {
  const inherited = $('api-source').value === 'platform';
  $('custom-model-fields').disabled = inherited;
  $('source-state').textContent = inherited ? '使用平台默认地址、密钥与模型列表。编辑请前往平台设置；切换为自定义后仅影响本助手。' : '自定义配置仅保存在本助手，不修改平台默认 API。';
}
$('api-source').addEventListener('change', () => { resetModels(); sourceState(); setDirty('model', true); });
for (const scope of ['model','persona','memory']) $(scope === 'model' ? 'model-form' : `${scope}-form`).addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'), result = $(`${scope}-result`); button.disabled = true; result.dataset.error = 'false'; result.textContent = '正在保存…';
  const edit = edits[scope], version = authVersion;
  try {
    const body = scope === 'model' ? modelDraft() : Object.fromEntries(fieldGroups[scope].map(key => [key, $(key).value]));
    const next = await api('/api/assistant/settings', { scope, ...body });
    if (version !== authVersion || !user) return;
    settingsRevision++;
    const keys = scope === 'model' ? ['provider', 'baseUrl', 'protocol', 'model', 'hasApiKey', 'apiSource', 'selectedModels'] : fieldGroups[scope];
    const merged = { ...config, ...Object.fromEntries(keys.map(key => [key, next[key]])) };
    const unchanged = edit === edits[scope]; fill(merged, unchanged ? [scope] : []);
    result.textContent = unchanged ? '已保存' : '上次提交已保存，当前新修改尚未保存';
  } catch (error) { if (version === authVersion) { result.dataset.error = 'true'; result.textContent = error.message; } } finally { button.disabled = false; }
});
function cancelModels() { modelVersion++; modelController?.abort(); modelController = null; $('load-models').disabled = false; }
function resetModels() { cancelModels(); models = []; if ($('model-dialog').open) $('model-dialog').close(); $('model-filter').value = ''; $('models-status').textContent = '接口已更改，请重新获取模型列表。'; }
$('provider').addEventListener('change', () => {
  const presets = { dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1', openai: 'https://api.openai.com/v1' };
  $('base-url').readOnly = $('provider').value !== 'custom'; $('base-url').value = presets[$('provider').value] || ''; $('protocol').value = 'chat'; $('model').value = ''; selectedModels = []; renderSelectedModels(); $('api-key').value = ''; resetModels();
  $('models-status').textContent = '填写地址和密钥后，获取模型列表。'; setDirty('model', true);
});
$('base-url').addEventListener('input', resetModels);
$('api-key').addEventListener('input', resetModels); $('clear-key').addEventListener('change', resetModels);
function renderModelOptions() {
  const filter = $('model-filter').value.toLowerCase();
  const filtered = models.filter(name => name.toLowerCase().includes(filter));
  $('model-options').replaceChildren(...filtered.map(name => {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'); label.className = 'model-option'; input.type = 'checkbox'; input.checked = dialogModels.has(name); text.textContent = name;
    input.addEventListener('change', () => { input.checked ? dialogModels.add(name) : dialogModels.delete(name); $('model-selection-count').textContent = `已选 ${dialogModels.size} 个模型`; }); label.append(input, text); return label;
  }));
  if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '没有匹配的模型'; $('model-options').append(empty); }
  $('model-selection-count').textContent = `已选 ${dialogModels.size} 个模型`;
}
$('model-filter').addEventListener('input', renderModelOptions);
$('close-models').addEventListener('click', () => $('model-dialog').close());
$('apply-models').addEventListener('click', () => { selectedModels = [...dialogModels]; if (!selectedModels.includes($('model').value)) $('model').value = selectedModels[0] || ''; renderSelectedModels(); setDirty('model', true); $('model-dialog').close(); });
$('load-models').addEventListener('click', async () => {
  const button = $('load-models'); cancelModels(); const version = modelVersion, controller = new AbortController(); modelController = controller; button.disabled = true; $('models-status').textContent = '正在从服务商获取模型…';
  try { const result = await api('/api/assistant/models', modelDraft(), controller.signal); if (version !== modelVersion || !user) return; models = [...new Set(result.models || [])]; dialogModels = new Set(selectedModels); renderModelOptions(); if (models.length) $('model-dialog').showModal(); $('models-status').textContent = models.length ? `获取到 ${models.length} 个模型。勾选可用模型后保存。` : '没有返回模型，可手动填写。'; }
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
  for (const message of messages) {
    const el = document.createElement('div'), label = document.createElement('span'), content = document.createElement('span'), actions = document.createElement('div'), speak = document.createElement('button'), memory = document.createElement('button');
    el.className = `bubble ${message.role}`; label.className = 'bubble-label'; label.textContent = message.role === 'user' ? '你' : config?.name || '助手'; content.className = 'message-content'; content.textContent = message.content; content.tabIndex = 0; content.setAttribute('role', 'button'); content.setAttribute('aria-label', '朗读此消息');
    const read = async () => { $('chat-error').textContent = ''; try { await assistantVoice.read(message.content); } catch (error) { $('chat-error').textContent = error.message; } };
    content.addEventListener('click', () => { if (!window.getSelection()?.toString()) void read(); }); content.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); void read(); } });
    actions.className = 'message-actions'; speak.type = memory.type = 'button'; speak.className = 'quiet message-speak'; memory.className = 'quiet message-memory'; speak.textContent = '朗读'; memory.textContent = '加入记忆'; speak.addEventListener('click', read);
    memory.addEventListener('click', () => { const selection = window.getSelection(); const text = selection?.toString().trim() && content.contains(selection.anchorNode) && content.contains(selection.focusNode) ? selection.toString().trim() : message.content; const next = [$('memory').value.trim(), text].filter(Boolean).join('\n'); if (next.length > 8000) { notice('记忆草稿已达 8000 字上限，请先整理'); return; } $('memory').value = next; setDirty('memory', true); $('memory-result').textContent = '已加入草稿，请点击保存记忆'; notice('已加入下方记忆草稿，保存后生效'); });
    actions.append(speak, memory); el.append(label, content, actions); $('messages').append(el);
  }
  $('messages').scrollTop = $('messages').scrollHeight;
}
$('clear-chat').addEventListener('click', () => { stopChat(); void assistantVoice.stop(); messages = []; persistHistory(); renderMessages(); $('chat-error').textContent = ''; });
$('stop-chat').addEventListener('click', () => { stopChat(); void assistantVoice.stop(); $('chat-error').textContent = '已停止本次等待。'; });
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && innerWidth > 760) { event.preventDefault(); if (!chatController) $('chat-form').requestSubmit(); } });
async function sendMessage(content, { signal, fromVoice = false } = {}) {
  if (chatController || !content) return;
  const version = ++chatVersion, controller = new AbortController(); chatController = controller;
  if (!fromVoice) $('chat-input').value = ''; $('chat-error').textContent = ''; messages.push({ role: 'user', content }); renderMessages(); persistHistory();
  $('chat-form').querySelector('[type=submit]').disabled = true; $('stop-chat').hidden = false; $('chat-state').textContent = '正在思考…';
  try {
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const revision = settingsRevision, next = await api('/api/assistant/settings', undefined, requestSignal);
    if (version !== chatVersion || !user) return;
    if (revision === settingsRevision) fillCleanSettings(next);
    if (!config?.hasApiKey || !config.model) throw Error('请先在模型服务中配置密钥和模型。');
    const result = await api('/api/assistant/chat', { messages: conversationContext(messages), model: $('chat-model').value || config.model }, requestSignal);
    if (version !== chatVersion || !user) return; messages.push({ role: 'assistant', content: result.reply }); renderMessages(); persistHistory(); return result.reply;
  } catch (error) { if (version === chatVersion && user) { $('chat-error').textContent = error.name === 'AbortError' ? '请求已停止。' : error.message; if (!fromVoice) $('chat-input').value = content; } if (fromVoice) throw error; }
  finally { if (version === chatVersion) { chatController = null; $('chat-form').querySelector('[type=submit]').disabled = false; $('stop-chat').hidden = true; summary(); } }
}
$('chat-model').addEventListener('change', () => { if (!chatController) $('chat-state').textContent = $('chat-model').value; });
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
  try { const completed = await assistantVoice.preview(); if (version === authVersion && user) $('voice-result').textContent = completed ? '试听播放完成' : '试听已停止'; }
  catch (error) { if (version === authVersion) $('voice-result').textContent = error.message; } finally { await refreshVoice(true); }
});
$('voice-preview-stop').addEventListener('click', () => void assistantVoice.stop());
if (window.atbDesktop) document.documentElement.classList.add('desktop');
$('service-host').textContent = location.host;
window.addEventListener('online', () => void refreshSession()); document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshSession(); });
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort(); clearTimeout(sessionTimer); });
void refreshSession();
