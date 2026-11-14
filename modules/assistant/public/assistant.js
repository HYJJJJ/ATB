import { createOpportunityClient } from './opportunity-client.js';
import { cleanModelText, unsupportedToolMessage } from '/model-content.js';
import { renderMessageContent, renderToolSources, toolResultLabel } from './message-content.js';
import { conversationContext } from './assistant-context.js';
import { conversationDefaults } from './conversation-policy.js';
import { createAssistantVoice } from './assistant-voice.js';
import { readChatReply } from './chat-stream.js';
import { createPresencePanel } from './presence-panel.js';
import { createFaceManagement } from './face-management.js';
import { handlePresenceUtterance } from './presence-conversation.js';
import { catalogueLanguages, voiceMatchesLanguage, sortChatSpeakers, voiceOptionLabel } from './voice-catalog.js';
import { createVoicePicker } from './voice-picker.js';
import { balanceView } from './balance-view.js';
import { createAiProfileDrafts, fillAiProviderOptions, applyAiPresetControls } from '/ai-presets.js';
import { createToolsPanel } from './tools-panel.js';
import { createChatHistory } from './chat-history.js';
const $ = id => document.getElementById(id);
const voicePicker = createVoicePicker($('voice-name'), { openAtStart: () => $('voice-provider').value === 'chattts' });
const isLocalTts = provider => ['chattts', 'qwen3tts'].includes(provider);
const localTtsName = provider => provider === 'qwen3tts' ? 'Qwen3-TTS 0.6B' : 'ChatTTS';
const labels = { assistant: '智能助手', model: '模型服务', voice: '语音与集成', faces: '人脸管理',tools:'助手能力' };
const toolsNav=document.createElement('button');toolsNav.className='nav';toolsNav.type='button';toolsNav.dataset.page='tools';toolsNav.textContent='助手能力';document.querySelector('.module-bar nav').append(toolsNav);
const fieldGroups = { model: ['api-source', 'provider', 'protocol', 'base-url', 'api-key', 'clear-key', 'model'], persona: ['name', 'prompt', 'responseStyle', 'followUpQuestions', 'proactiveChat', 'opportunityProbability', 'opportunityDailyLimit'], memory: [] };
const dirty = new Set();
const aiProfiles = createAiProfileDrafts();
let personaPresetBusy = false, personaPresetRenderKey;
let activeAiProvider = 'custom';
fillAiProviderOptions($('provider'));
const edits = { model: 0, persona: 0, memory: 0 };
let config, user = null, messages = [], needsSetup = false, models = [], chatController = null, chatVersion = 0;
const chatHistory = createChatHistory({onChange(_messages, {cleared}) {
  if (!user || chatHistory.account !== user.username) return;
  if (cleared) { stopChat(); void assistantVoice.stop(); }
  if (!chatController) { loadHistory(); renderMessages(); }
}});
const toolsPanel=createToolsPanel({api,isLoggedIn:()=>Boolean(user),onDirty:value=>{if(value)dirty.add('tools');else dirty.delete('tools');}});
let sessionTask, sessionTimer, noticeTimer, modelController, testController, authVersion = 0, modelVersion = 0, settingsRevision = 0;
let selectedModels = [], dialogModels = new Set(), voiceStatus, voiceRefreshAt = 0, voiceEdit = 0;
let voiceCatalog = [], voiceLanguages = [], voiceCapabilities = {}, memoryRefreshAt = 0, selectedVoice = 'chattts:42', voiceCatalogVersion = 0, voiceFormProvider = 'chattts';
const voiceDrafts = new Map();
let chatSeedCustom = false, chatPresetVoice = null, chatSeedDraft = '42';
let balanceRefreshAt = 0, balanceVersion = 0, balanceSpeechProvider;
let attentionVersion = 0, foregroundWasActive = false;
let companionLevelAt = 0;
function companionEvent(type, value = {}) {
  if (window.atbDesktop?.hasModule('assistant')) void window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type,account:user?.username || '',...value}}).catch(()=>{});
}
function foregroundActivity(active) {
  if (!window.atbDesktop?.hasModule('assistant')) return;
  const epoch = ++attentionVersion, wasActive = foregroundWasActive; foregroundWasActive = active;
  const send = () => window.atbDesktop.invokeModule('assistant', 'presence', { action: 'attention', active }).catch(() => {});
  if (active) void send();
  else void (wasActive && user ? api('/api/assistant/presence', { action: 'interaction' }).catch(() => {}) : Promise.resolve()).then(() => { if (epoch === attentionVersion) return send(); });
}
function growInputs() {
  for (const input of document.querySelectorAll('#page-assistant textarea')) {
    if (!input.getClientRects().length) continue;
    // Measuring the live textarea at height:auto collapses the scroll container and
    // clamps its scrollTop during background settings refreshes. Measure outside flow.
    const measure = input.cloneNode(false), style = getComputedStyle(input);
    measure.removeAttribute('id'); measure.removeAttribute('name');
    measure.setAttribute('aria-hidden', 'true'); measure.tabIndex = -1;
    measure.value = input.value;
    Object.assign(measure.style, { position: 'absolute', top: '0', left: '0', visibility: 'hidden', pointerEvents: 'none', width: input.getBoundingClientRect().width + 'px', height: '0', minHeight: '0', maxHeight: 'none', margin: '0' });
    input.parentElement.append(measure);
    const height = measure.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    measure.remove();
    input.style.height = height + 'px';
  }
}
document.addEventListener('input', event => { if (event.target.matches('#page-assistant textarea')) growInputs(); });
document.addEventListener('toggle', growInputs, true);
window.addEventListener('resize', growInputs);
async function refreshBalance(force = false) {
  if (!user || !force && Date.now() - balanceRefreshAt < 60000) return;
  balanceRefreshAt = Date.now(); const version = authVersion, requestVersion = ++balanceVersion;
  const speechProvider = voiceStatus?.settings?.provider;
  const suffix = force ? '?refresh=1' : '';
  const read = url => api(url).catch(() => ({ kind: 'unavailable' }));
  const [chat, speech] = await Promise.all([read('/api/assistant/balance' + suffix), speechProvider === 'volcengine' ? read('/api/platform/billing/volcengine/balance' + suffix) : Promise.resolve({kind: speechProvider ? 'local' : 'loading'})]);
  if (version !== authVersion || requestVersion !== balanceVersion || !user) return;
  renderBalance('chat', chat); renderBalance('speech', speech);
}
function renderBalance(kind, result) {
  const value = balanceView(result), box = $(`${kind}-api-balance`);
  const showDetails = result.kind !== 'balance' && result.kind !== 'local';
  box.dataset.level = value.level; box.dataset.state = result.kind === 'unavailable' ? 'error' : 'ready'; box.dataset.details = String(showDetails);
  box.title = showDetails ? value.title : '';
  box.setAttribute('role', showDetails ? 'button' : 'group'); box.tabIndex = showDetails ? 0 : -1;
  box.setAttribute('aria-label', `${kind === 'chat' ? '对话' : '语音'} API 余额${showDetails ? '详情' : ''}`);
  $(`${kind}-balance-value`).textContent = value.text;
}
$('refresh-balance').addEventListener('click', () => void refreshBalance(true));
for (const kind of ['chat', 'speech']) {
  const box = $(`${kind}-api-balance`);
  box.setAttribute('role', 'button'); box.tabIndex = 0;
  box.setAttribute('aria-label', `${kind === 'chat' ? '对话' : '语音'} API 余额详情`);
  $(`${kind}-balance-value`).setAttribute('role', 'status');
  const show = () => box.dataset.details === 'true' && void window.atbAlert({title: `${kind === 'chat' ? '对话' : '语音'} API 余额`, message: box.title || '正在查询余额。'});
  box.addEventListener('click', show);
  box.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); show(); } });
}
$('refresh-memory').addEventListener('click', () => void refreshMemory(true));
$('prune-memory').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await api('/api/assistant/memory', {action:'prune'}); await refreshMemory(true); }
  catch { notice('修剪暂未完成，请稍后重试'); }
  finally { button.disabled = false; }
});
let transcriptTimer;
$('toggle-transcript').addEventListener('click', () => {
  const panel = $('transcript'), stage = $('conversation-stage');
  const open = $('toggle-transcript').getAttribute('aria-expanded') !== 'true';
  clearTimeout(transcriptTimer);
  if (open) {
    panel.hidden = false;
    // Establish the initial transform before the opening transition.
    void panel.offsetWidth;
  } else if (panel.contains(document.activeElement)) $('toggle-transcript').focus({ preventScroll: true });
  panel.inert = !open; panel.setAttribute('aria-hidden', String(!open));
  stage.classList.toggle('transcript-open', open);
  $('toggle-transcript').setAttribute('aria-expanded', String(open));
  $('toggle-transcript').firstChild.textContent = open ? '收起文字记录 ' : '显示文字记录 ';
  if (!open) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) panel.hidden = true;
    else transcriptTimer = setTimeout(() => { panel.hidden = true; }, 360);
  }
  growInputs();
  if (open) $('messages').scrollTop = $('messages').scrollHeight;
});
const volcModels = [
  ['seed-tts-2.0', '豆包语音合成大模型 2.0'],
  ['seed-tts-1.0', '豆包语音合成大模型 1.0 · 旧版兼容'],
  ['seed-tts-1.0-concurr', '豆包语音合成大模型 1.0 · 旧版并发包月'],
  ['seed-icl-2.0', '豆包声音复刻大模型 2.0'],
  ['seed-icl-1.0', '豆包声音复刻大模型 1.0 · 旧版兼容'],
  ['seed-icl-1.0-concurr', '豆包声音复刻大模型 1.0 · 旧版并发包月'],
];
function renderVolcModels(preferred = $('tts-model-name').value) {
  const clone = $('tts-voice-kind').value === 'clone', metadata = voiceCatalog.find(item => item.id === selectedVoice);
  const version = metadata?.resourceId === 'seed-tts-1.0' ? '1.0' : '2.0';
  const allowed = volcModels.filter(([id]) => id.startsWith(clone ? 'seed-icl-' : 'seed-tts-') && (clone ? !id.includes('1.0') || $('tts-concurrency').checked : id.includes(version)) && (!id.endsWith('-concurr') || $('tts-concurrency').checked));
  $('tts-model-name').replaceChildren(...allowed.map(([id, label]) => new Option(`${label} · ${id}`, id)));
  $('tts-model-name').value = allowed.some(([id]) => id === preferred) ? preferred : allowed[0][0];
  $('tts-concurrency-field').hidden = !clone && version === '2.0';
  $('tts-legacy-label').textContent = clone ? '显示旧版 1.0 复刻及并发包月方案（仅限已开通项目）' : '显示旧版 1.0 并发包月方案（仅限已开通项目）';
}
function volcBilling() {
  const model = $('tts-model-name').value, clone = model.startsWith('seed-icl-');
  const modern = model.endsWith('2.0'), concurrent = model.endsWith('-concurr');
  const fee = concurrent ? '旧版并发包月 · 以已开通套餐为准' : modern ? '按量 3 元/万字符 · 可用资源包' : '旧版字符计费 · 核对已开通套餐';
  const methods = { 'ws-bidirectional': '双向文字流', 'ws-unidirectional': '单次文字提交', 'http-chunked': 'HTTP 分块', 'http-sse': 'SSE 事件流' };
  document.querySelectorAll('.tts-method-option').forEach(row => {
    row.querySelector('.tts-method-fee').textContent = fee;
    row.querySelector('.tts-method-fee').title = methods[row.querySelector('input').value] + '是传输方式；所选模型及账户套餐决定费用，不因协议另定单价。';
  });
  document.querySelectorAll('[name=tts-method-choice]').forEach(el => { el.checked = el.value === $('tts-method').value; });
  $('tts-billing-note').textContent = modern
    ? model + '：官方按量后付费 3 元/万字符；预付费资源包例如 10 万字符 28 元（1年），并发增购按并发/月另计。四种协议使用同一模型资源，因此基础计价相同；流式传输不等于实时语音大模型的 Token 计费。' + (clone ? '复刻音色另有音色槽位费用。' : '') + '标点、空格计入字符；中途打断不保证上游已合成内容免收费。实际扣费取决于免费额度、资源包与合同价。核对：2026-11-13。'
    : model + '：旧版资源，仅适用于已开通项目；当前新版价目不据此推定旧版价格，请在控制台核对字符或并发套餐。传输协议不单独定价。核对：2026-11-13。';
}
function syncVoiceOrb(active = assistantVoice.active) {
  const button = $('voice-orb'), label = active ? '关闭语音对话' : '开始语音对话';
  button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-label', label); button.title = label;
  button.disabled = !active && $('voice-start').disabled;
}
const assistantVoice = createAssistantVoice({
  api, sendMessage, getConversationSettings: () => ({ ...config, proactiveChat: Boolean(config?.proactiveChat && user) }), canInitiateConversation: () => !document.hidden, onInterrupt: stopChat, canChat: () => Boolean(user && config?.hasApiKey && config.model),
  onState({ active, phase, text }) {
    companionEvent('state',{active,phase,text});
    if (phase !== 'off' && phase !== 'listening') opportunityClient.cancel();
    foregroundActivity(active); syncVoiceOrb(active);
    $('voice-live').textContent = text; $('voice-start').hidden = active; $('voice-stop').hidden = !active;
    $('voice-interrupt').hidden = !active || !['thinking', 'synthesizing', 'speaking', 'transcribing'].includes(phase);
    $('voice-live').dataset.phase = phase; $('voice-preview-stop').hidden = !active; if (active) $('voice-result').textContent = text;
    $('voice-stage').dataset.phase = phase;
    $('voice-headline').textContent = ({ off: '我在这里，随时倾听', loading: '正在准备倾听', listening: '我在听，请说', transcribing: '正在听懂你的话', thinking: '让我想一想', synthesizing: '正在准备回复', speaking: '正在与你对话' })[phase] || '我在这里';
    $('voice-stage').style.setProperty('--voice-level', '0');
  },
  onLevel(value) { if (!document.hidden) $('voice-stage').style.setProperty('--voice-level', String(Math.max(0, Math.min(1, value)))); if(performance.now()-companionLevelAt>90){companionLevelAt=performance.now();companionEvent('level',{level:value});} },
  onError(text) { $('chat-error').textContent = text; },
  onMetrics(value) {
    const names = { loadMs: '加载', asrMs: '识别', firstTextMs: '首段文字', firstAudioMs: '首段音频', firstPlaybackMs: '开始播放' };
    $('voice-timing').textContent = Object.entries(value).map(([key, ms]) => `${names[key]} ${(ms / 1000).toFixed(2)}s`).join(' · ');
    $('voice-timing').hidden = !Object.keys(value).length;
  },
});
const opportunityClient = createOpportunityClient({ request: api,
  state: () => ({ enabled: Boolean(user && config?.proactiveChat && config?.hasApiKey && config.model), visible: !document.hidden, account: user?.username, busy: Boolean(chatController || assistantVoice.busy) }),
  async onReply(text,result) {
    companionEvent('proactive',{text});
    if(result?.id)try{sessionStorage.setItem('homebase.opportunity.'+user.username,result.id);}catch{}
    messages.push({ id:'opportunity:'+result.id, createdAt:result.ts || Date.now(), role: 'assistant', content: text }); renderMessages(); await persistHistory();
    if (assistantVoice.active || voiceStatus?.settings?.enabled) try { await assistantVoice.sayOpportunity(text); } catch { /* Message delivery remains successful if audio is unavailable. */ }
  },
});
const opportunityTimer = setInterval(() => void opportunityClient.poll(), 30000);
let opportunityStatusAt = 0;
async function refreshOpportunities(force = false) {
  if (!user || !force && Date.now() - opportunityStatusAt < 60000) return;
  opportunityStatusAt = Date.now(); const epoch = authVersion;
  try {
    const state = await api('/api/assistant/opportunity'); if (epoch !== authVersion || !user) return;
    const delivery=state.lastChat;
    if(delivery?.id && delivery.ts > Date.now()-86400000){
      let seen;try{seen=sessionStorage.getItem('homebase.opportunity.'+user.username);}catch{}
      if(seen!==delivery.id){try{sessionStorage.setItem('homebase.opportunity.'+user.username,delivery.id);}catch{} messages.push({id:'opportunity:'+delivery.id,createdAt:delivery.ts,role:'assistant',content:delivery.text});renderMessages();await persistHistory();}
    }
    $('opportunity-status').textContent = (config?.proactiveChat ? '随机机会已开启' : '随机机会未开启') + ' · 今日唤醒 ' + state.todayCount + '/' + (config?.opportunityDailyLimit ?? 8) + ' · 主动消息 ' + state.chatCount + '/2' + (state.nextAt ? ' · 下次检查机会 ' + new Date(state.nextAt).toLocaleString() : '');
    const reasons = { 'dice-miss': '本次掷骰未命中', none: '选择待着', 'owner-chat': '选择聊天', 'chat-cap': '主动消息已达上限', 'recent-dialogue': '近期有对话，顺延25分钟', busy: '正在处理消息，顺延25分钟', quiet: '安静时段，顺延', 'daily-cap': '今日机会已满，顺延明天', snoozed: '已暂停，顺延', cancelled: '条件变化，取消', 'decision-unavailable': '本次未取得有效选择', 'interrupted-on-restart': '重启前机会已结束，未重发', 'unavailable-action': '选择的能力尚未接入' };
    $('opportunity-log').replaceChildren(...(state.outcomes || []).slice().reverse().map(item => {
      const li = document.createElement('li'); li.textContent = new Date(item.ts).toLocaleString() + ' · ' + (item.roll === undefined ? '' : '掷骰 ' + Number(item.roll).toFixed(3) + (item.hit ? ' 命中 · ' : ' 未命中 · ')) + (reasons[item.detail] || item.detail) + (item.woke ? ' · 选择：' + ({chat:'聊天',browse:'浏览',none:'不行动'}[item.action] || '不行动') : ''); return li;
    }));
  } catch { if (epoch === authVersion && user) $('opportunity-status').textContent = '机会状态暂时无法读取'; }
}
$('refresh-opportunity').addEventListener('click', () => void refreshOpportunities(true));
const presencePanel = createPresencePanel({ api, voice: assistantVoice, onDirty: updateVoiceSaveState, onResult: text => { $('voice-result').textContent = text; } });
function updateVoiceSaveState() {
  const changed = dirty.has('voice') || presencePanel.dirty;
  $('voice-state').textContent = changed ? '未保存' : '已保存'; $('voice-state').dataset.dirty = String(changed);
}
new ResizeObserver(() => { document.documentElement.style.setProperty('--voice-actions-height', $('voice-actions').getBoundingClientRect().height + 'px'); }).observe($('voice-actions'));
$('voice-actions').querySelector('[data-refresh]').addEventListener('click', () => void refreshVoice(true));
const faceManagement = createFaceManagement({ api, onChange: () => presencePanel.refresh() });
window.atbHasUnsavedChanges = () => Boolean(dirty.size || faceManagement.dirty || presencePanel.dirty);
function fillVoice(next) {
  const nextProvider = next.settings.provider;
  voiceStatus = next; const settings = next.settings;
  if (nextProvider !== balanceSpeechProvider) { balanceSpeechProvider = nextProvider; balanceRefreshAt = 0; void refreshBalance(); }
  const local = isLocalTts(settings.provider), available = next.synthesisAvailable ?? next.available;
  const system = false, provider = local ? '本地 ' + localTtsName(settings.provider) : settings.provider === 'volcengine' ? '火山引擎 · 豆包语音' : 'ChatTTS';
  $('voice-start').disabled = !next.available || !available; syncVoiceOrb();
  $('voice-availability').textContent = available ? `朗读：${provider} 合成 → 当前设备播放。试听不打开麦克风、不加载识别模型。` : system ? '朗读使用浏览器系统语音，音色由系统提供；本地音色设置暂不生效。' : next.synthesisError || '没有可用朗读服务，请先初始化语音运行时。';
  $('voice-runtime-state').textContent = available ? `${provider} · 当前设备播放` : system ? '浏览器系统语音' : `${provider} · 不可用`;
  $('voice-flow-provider').textContent = provider;
  if (!assistantVoice.active) $('voice-live').textContent = !available && !system ? '语音不可用 · 查看语音设置' : next.available ? '识别运行时就绪 · 点击开始后使用麦克风' : '朗读可用 · 识别运行时未安装';
  $('voice-preview').disabled = !available && !system;
  $('local-tts-state').textContent = ['chattts','qwen3tts'].map(id => `${localTtsName(id)} ${next.localTts?.installations?.[id] ? '已安装' : '未安装'}`).join(' · ');
  $('local-setup-command').textContent = `python modules/assistant/scripts/setup-local-tts.py --data-dir ${JSON.stringify(next.setupDataDir || 'data/assistant')}`;
  if (dirty.has('voice')) { $('voice-preview').disabled = true; return; }
  voiceDrafts.clear(); voiceFormProvider = settings.provider || 'chattts'; $('voice-provider').value = voiceFormProvider;
  voiceCatalogVersion++;
  voiceLanguages = settings.voiceLanguages || []; voiceCapabilities = settings.synthesisCapabilities || {};
  if (Array.isArray(settings.voiceCatalog)) voiceCatalog = settings.voiceCatalog;
  const volcengine = settings.volcengine || {};
  const model = volcengine.modelName || volcengine.resourceId || 'seed-tts-1.0';
  $('tts-voice-kind').value = model.startsWith('seed-icl-') ? 'clone' : 'preset'; $('tts-concurrency').checked = model.endsWith('-concurr') || model.startsWith('seed-icl-1.0');
  $('tts-auth-mode').value = volcengine.authMode || 'apiKey'; $('tts-app-id').value = volcengine.appId || '';
  $('tts-method').value = volcengine.method || 'http-chunked'; $('tts-context-texts').value = volcengine.contextTexts || ''; $('tts-model-version').value = volcengine.modelVersion || 'seed-tts-2.0-standard';
  $('tts-speaker').value = model.startsWith('seed-icl-') ? settings.voice || '' : '';
  $('tts-sample-rate').value = String(volcengine.sampleRate || 24000); $('tts-emotion-scale').value = String(volcengine.emotionScale || 4);
  $('tts-api-key').value = ''; $('tts-access-key').value = ''; $('tts-clear-credentials').checked = false;
  $('tts-api-key').placeholder = volcengine.hasApiKey ? '已配置 · 留空保留，输入可替换' : '填写火山引擎语音 API Key';
  $('tts-access-key').placeholder = volcengine.hasAccessKey ? '已配置 · 留空保留，输入可替换' : '填写 Access Token';
  const validation = settings.synthesisValidation;
  $('tts-credential-state').textContent = validation?.status === 'passed' ? '当前音色合成已验证' : validation?.status === 'failed' ? '当前配置调用失败 · 查看试听错误' : (volcengine.authMode === 'legacy' ? volcengine.hasAccessKey && volcengine.appId : volcengine.hasApiKey) ? '凭据已配置 · 尚需试听验证' : '待配置';
  voiceProviderControls();
  selectedVoice = settings.voice; renderVoices(); renderVolcModels(model); volcVoiceControls(volcengine.emotion || '');
  $('wake-enabled').checked = settings.wakeEnabled !== false; $('wake-phrases').value = (settings.wakePhrases || []).join('\n');
  $('voice-enabled').checked = settings.enabled; $('voice-rate').value = String(settings.rate || 0); $('voice-volume').value = String(settings.volume || 0); $('voice-pitch').value = String(settings.pitch || 0); $('voice-silence').value = String(settings.silenceMs); $('voice-auto').checked = settings.autoListen; $('voice-barge-in').checked = settings.autoInterrupt !== false; $('voice-barge-threshold').value = String(settings.bargeInThreshold ?? 10); $('voice-barge-duration').value = String(settings.bargeInDurationMs ?? 500); $('voice-low-latency').checked = settings.lowLatency !== false; speechValues();
}
function voiceProviderControls() {
  const paid = $('voice-provider').value === 'volcengine';
  const local = isLocalTts($('voice-provider').value);
  $('tts-volcengine').hidden = !paid;
  $('tts-local').hidden = !local;
  $('chattts-ranking-field').hidden = $('voice-provider').value !== 'chattts';
  $('chattts-seed-fields').hidden = $('voice-provider').value !== 'chattts';
  $('chattts-seed').disabled = $('voice-provider').value !== 'chattts';
  $('local-tts-capability').hidden = !local;
  $('local-tts-capability').textContent = voiceCapabilities.description || '';
  $('voice-picker').hidden = paid && $('tts-model-name').value.startsWith('seed-icl-');
  $('tts-api-key-field').hidden = $('tts-auth-mode').value !== 'apiKey'; $('tts-legacy-fields').hidden = $('tts-auth-mode').value !== 'legacy';
  $('voice-rate').min = paid || local ? '-50' : '-99'; $('voice-volume').min = paid ? '-50' : '-100';
  $('voice-pitch').min = paid ? '-12' : '-100'; $('voice-pitch').max = paid ? '12' : '100';
  $('voice-volume-hint').textContent = paid ? '-50 为半音量，0 为标准，100 为双倍' : '0 为原始音量，-100 为静音';
  $('voice-pitch').disabled = local;
  $('voice-pitch-hint').textContent = local ? '本地模型不支持音调调整，保持原调' : paid ? '音调偏移 -12 到 12，0 为原调' : '低沉 ← 原调 0 → 明亮';
  $('refresh-voices').hidden = local; $('refresh-voices').disabled = !paid && !(voiceStatus?.synthesisAvailable ?? voiceStatus?.available);
  $('refresh-voices').textContent = paid ? '刷新官方音色目录' : '获取在线音色';
}
function volcVoiceControls(emotion = $('tts-emotion').value) {
  if ($('voice-provider').value !== 'volcengine') return;
  renderVolcModels();
  const model = $('tts-model-name'), clone = model.value.startsWith('seed-icl-');
  const metadata = voiceCatalog.find(item => item.id === selectedVoice);
  const second = model.value.endsWith('2.0');
  $('tts-clone-fields').hidden = !clone; $('tts-version-field').hidden = !clone || !second;
  $('voice-picker').hidden = clone;
  $('tts-context-field').hidden = !second || clone && $('tts-model-version').value !== 'seed-tts-2.0-expressive';
  $('tts-method-hint').textContent = $('tts-method').value === 'ws-bidirectional' ? '文字流直接送入合成，同一回复使用一个会话，收到音频即播放。开启快速回复可边生成边说话。' : '开启快速回复后按短句依次提交，首句生成后即可播放；每句为独立请求，音频连续按序播放。';
  $('tts-model-hint').textContent = (clone ? '仅使用已完成复刻并获授权的 Speaker ID；此处不执行声音训练。' : metadata ? `${metadata.name}仅显示匹配的${metadata.resourceId === 'seed-tts-2.0' ? ' 2.0' : ' 1.0'} 模型。` : '请先选择目录中的音色。') + (second ? ' 当前项目授权以试听结果为准。' : ' 1.0 为旧版兼容入口，新版接口文档仅列 2.0；请确认原项目仍已开通，未开通建议选择 2.0 音色。');
  volcBilling();
  const emotions = !clone && !second ? metadata?.emotions || [] : [];
  $('tts-emotion-fields').hidden = !emotions.length;
  $('tts-emotion').replaceChildren(new Option('默认', ''), ...emotions.map(item => new Option(item.label, item.value)));
  $('tts-emotion').value = emotions.some(item => item.value === emotion) ? emotion : '';
}
function speechValues() {
  $('voice-barge-threshold-value').textContent = $('voice-barge-threshold').value + '%';
  $('voice-barge-threshold').disabled = $('voice-barge-duration').disabled = !$('voice-barge-in').checked;
  for (const key of ['rate', 'volume', 'pitch']) { const value = Number($(`voice-${key}`).value); $(`voice-${key}-value`).textContent = `${value > 0 ? '+' : ''}${value}${key === 'pitch' ? $('voice-provider').value === 'volcengine' ? '' : ' Hz' : '%'}`; }
}
function renderVoices() {
  const previousLanguage = $('voice-language').value;
  const languages = catalogueLanguages(voiceCatalog, voiceLanguages);
  $('voice-language').replaceChildren(new Option('全部语言', 'all'), ...languages.map(l => new Option(l.name, l.id)));
  $('voice-language').value = languages.some(l => l.id === previousLanguage) ? previousLanguage : 'all';
  const locale = $('voice-language').value;
  const catalog = [...voiceCatalog];
  if (!catalog.some(item => item.id === selectedVoice)) catalog.unshift({ id: selectedVoice, name: selectedVoice, locale: selectedVoice.split('-').slice(0, 2).join('-') });
  const ordered = $('voice-provider').value === 'chattts' ? sortChatSpeakers(catalog, $('chattts-ranking').value) : catalog;
  const matches = ordered.filter(item => voiceMatchesLanguage(item, locale));
  const selected = catalog.find(item => item.id === selectedVoice);
  if (selected && !matches.includes(selected)) matches.unshift(selected);
  $('voice-name').replaceChildren(...matches.map(item => new Option(voiceOptionLabel(item, $('chattts-ranking').value), item.id)));
  $('voice-name').value = selectedVoice; voicePicker.update();
  if ($('voice-provider').value === 'chattts') {
    if (chatPresetVoice === null) chatSeedDraft = /^chattts:[0-9]+$/.test(selectedVoice) ? selectedVoice.slice(8) : '42';
    if (!chatSeedCustom || chatPresetVoice === null) chatPresetVoice = selectedVoice;
  }
  chatSeedControls();
  $('voice-catalog-state').textContent = $('voice-provider').value === 'chattts' ? `${voiceCatalog.filter(voice => voice.source === 'ChatTTS_Speaker').length} 个已评分音色 · 按${{rankSingle:'单句',rankMulti:'多句',rankLong:'长句'}[$('chattts-ranking').value]}稳定性降序 · 当前 ${selected?.seedId || selectedVoice.slice(8)} · 另可输入随机种子` : `${voiceCatalog.length || 1} 个${$('voice-provider').value === 'volcengine' ? '官方目录音色 · 尚未逐项验证授权' : '音色'} · 筛选到 ${matches.length} 个`;
}
function renderLayeredMemory(state) {
  const core = Array.isArray(state.core) ? state.core : [], light = Array.isArray(state.light) ? state.light : [];
  const rows = (target, values, emptyText) => {
    const host = $(target); if (!host) return;
    host.replaceChildren();
    if (!values.length) { host.textContent = emptyText; return; }
    const list = document.createElement('ol');
    for (const value of values) { const item = document.createElement('li'); item.textContent = value; list.append(item); }
    host.append(list);
  };
  rows('auto-memory', core.map(item => '[' + item.emotion + '] ' + item.content), '还没有核心记忆。只有重要的事才会留下钩子。');
  const labels = {activeTopic:'话题',pendingThought:'想说没说',memberImpression:'印象'};
  rows('working-memory', light.map(item => (labels[item.category] || '工作记忆') + '：' + item.content + (item.extra?.member ? ' · ' + item.extra.member : '') + (item.extra?.participants?.length ? ' · ' + item.extra.participants.join('、') : '') + (item.extra?.unaskedQuestion ? ' · 待续：' + item.extra.unaskedQuestion : '') + (item.extra?.motivation ? ' · 动机：' + item.extra.motivation : '')), '暂无正在进行的话题。');
  const report = state.report, host = $('memory-prune-report');
  if (host) {
    host.replaceChildren();
    if (!report) host.textContent = '尚无修剪报告。启动时和运行期间会检查是否距上次超过24小时。';
    else {
      const date = document.createElement('p'); date.textContent = '修剪日期：' + report.date; host.append(date);
      const reasons = {expired:'已过期',duplicate:'内容重复','older-or-weaker':'较早或情绪较弱',noise:'缺少有效信息','private-content':'涉及私密日记内容','protected-or-invalid-target':'涉及身份、主人或安全边界，或不符合保留规则'};
      for (const [key,label] of [['kept','保留'],['removed','剔除'],['rejected','驳回']]) {
        const heading = document.createElement('h4'); heading.textContent = label; host.append(heading);
        const entries = Array.isArray(report[key]) ? report[key] : [];
        if (!entries.length) { const p = document.createElement('p'); p.textContent = '无'; host.append(p); continue; }
        const list = document.createElement('ul');
        for (const value of entries) { const li = document.createElement('li'); li.textContent = typeof value === 'string' ? value : [value.content, value.reason ? reasons[value.reason] || '未通过记忆保留规则' : ''].filter(Boolean).join(' · '); list.append(li); }
        host.append(list);
      }
    }
  }
  $('auto-memory-state').textContent = (config?.memoryMode === 'off' ? '自动记忆已关闭 · ' : '') + '核心 ' + core.length + '/60 · 工作记忆 ' + light.length + ' 条' + (state.legacyDetected ? ' · 已保留旧版记忆文件，未自动混入核心' : '');
}
async function refreshMemory(force = false) {
  if (!user || !force && Date.now() - memoryRefreshAt < 8000) return;
  memoryRefreshAt = Date.now(); const version = authVersion;
  try {
    const state = await api('/api/assistant/memory'); if (version !== authVersion || !user) return;
    if (state.version === 2) { renderLayeredMemory(state); return; }
    $('auto-memory').textContent = state.summary || (state.pendingTurns ? '新对话已自动保存，达到一批后将整理为精简记忆。' : '还没有精简记忆。开始对话后会自动保存并分批整理。');
    $('auto-memory-state').textContent = `${config?.memoryMode === 'off' ? '自动记忆已关闭 · ' : ''}${state.running ? '正在后台整理 · ' : ''}已整理 ${state.summarizedTurns || 0} 轮 · 待整理 ${state.pendingTurns || 0} 轮${state.updatedAt ? ' · ' + new Date(state.updatedAt).toLocaleString() : ''}${state.lastError ? ' · ' + state.lastError : ''}${state.trimmedTurns ? ' · 部分旧待整理内容已达上限，未保留' : ''}`;
  } catch (error) { if (version === authVersion && user) $('auto-memory-state').textContent = error.message; }
}
async function refreshVoice(force = false) {
  if (!user || !force && Date.now() - voiceRefreshAt < 15000) return;
  voiceRefreshAt = Date.now(); const version = authVersion;
  try { const next = await assistantVoice.status(); if (version === authVersion && user) fillVoice(next); }
  catch { if (version === authVersion) { $('voice-start').disabled = true; $('voice-live').textContent = '暂时无法检测语音服务'; syncVoiceOrb(); } }
}
const historyKey = () => `homebase.chat.${user?.username ?? ''}`;
function persistHistory(generation = chatHistory.read().generation) {
  if (!user) return Promise.resolve();
  for (const message of messages) { message.id ||= crypto.randomUUID(); message.createdAt ||= Date.now(); }
  try { sessionStorage.setItem(historyKey(), JSON.stringify(messages.slice(-40))); } catch {}
  const account=user.username, version=authVersion, turnVersion=chatVersion;
  return chatHistory.save(messages,generation,()=>user?.username===account&&authVersion===version&&chatVersion===turnVersion).catch(()=>{});
}
function loadHistory() { const value = chatHistory.read().messages; messages = value.filter(m => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string').slice(-40).map(m => { if (m.role !== 'assistant') return { ...m, ...(m.status === 'pending' ? {status:'failed'} : {}) }; const cleaned = cleanModelText(m.content); return { ...m, ...(cleaned.removed || m.status === 'pending' || m.content.includes(unsupportedToolMessage) ? {status:'failed'} : {}), content: cleaned.removed ? (cleaned.content.trim() ? cleaned.content.trim() + '\n\n' : '') + unsupportedToolMessage : cleaned.content }; }); }
let connectionFailures = 0;
function connected(value) {
  connectionFailures = value ? 0 : connectionFailures + 1;
  const state = value ? 'connected' : connectionFailures < 3 ? 'retrying' : 'offline';
  $('service-status').textContent = value ? '服务已连接' : state === 'retrying' ? '连接不稳定 · 正在重试' : '连接中断 · 正在重试';
  $('service-status').dataset.state = state;
  $('network-banner').hidden = value;
}
async function api(url, data, signal, onDelta, onTool) {
  const version = authVersion;
  const response = await fetch(url, { signal: signal || AbortSignal.timeout(65000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  if (response.status === 401 && version === authVersion && !url.startsWith('/api/auth/')) { signedOut('登录已过期，请重新登录'); }
  if (response.ok && onDelta && response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const toolsUsed=[];const reply=await readChatReply(response,{onDelta,signal,onTool:tool=>{toolsUsed.push(tool);onTool?.(tool);}});return{reply,toolsUsed};
  }
  let result; try { result = await response.json(); } catch { throw Error('服务返回异常，请稍后重试'); }
  if (!response.ok) { const error = Error(result.error || '请求失败'); error.status = response.status; throw error; }
  if (onDelta && typeof result.reply === 'string') await onDelta(result.reply);
  return result;
}
function show(page, replace = false) {
  if (!labels[page]) page = 'assistant';
  if (page === 'faces' && user) faceManagement.start();
  if (page === 'tools' && user) void toolsPanel.start();
  if (page !== 'assistant' && assistantVoice.active) { stopChat(); void assistantVoice.stop(); }
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${page}`);
  document.querySelectorAll('.nav').forEach(el => { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('breadcrumb').textContent = labels[page];
  requestAnimationFrame(growInputs);
  if (location.hash !== `#${page}`) history[replace ? 'replaceState' : 'pushState'](null, '', `#${page}`);
}
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => show(el.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => show(el.dataset.goto)));
window.addEventListener('popstate', () => show(location.hash.slice(1), true));
function notice(text) { $('notice').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 4500); }
function personaSaveState(status) { const badge=$('persona-state'); badge.dataset.status=status; badge.textContent=({saved:'已保存',dirty:'未保存',saving:'保存中',error:'保存失败'})[status]; }
function setDirty(scope, value) { if (value) edits[scope]++; value ? dirty.add(scope) : dirty.delete(scope); $(`${scope}-state`).textContent = value ? '未保存' : '已保存'; $(`${scope}-state`).dataset.dirty = String(value); if(scope==='persona')personaSaveState(value?'dirty':'saved'); }
for (const [scope, ids] of Object.entries(fieldGroups)) for (const id of ids) $(id).addEventListener('input', () => { setDirty(scope, true); $(`${scope}-result`).textContent = ''; });
function renderPersonaPresets() {
  const presets = config?.personaPresets || [], host = $('persona-presets');
  const key = JSON.stringify([presets, config?.activePersonaPresetId, personaPresetBusy]);
  if (key === personaPresetRenderKey) return;
  personaPresetRenderKey = key; host.hidden = !presets.length;
  host.replaceChildren(...presets.map(preset => {
    const chip = document.createElement('span'), select = document.createElement('button'), remove = document.createElement('button');
    chip.className = 'persona-preset'; select.type = remove.type = 'button';
    select.className = 'quiet persona-preset-select'; select.textContent = preset.name; select.title = preset.name;
    select.setAttribute('aria-label', '切换角色：' + preset.name); select.setAttribute('aria-pressed', String(config.activePersonaPresetId === preset.id));
    remove.className = 'persona-preset-remove'; remove.textContent = '×'; remove.title = '删除角色预设'; remove.setAttribute('aria-label', '删除角色预设：' + preset.name);
    select.disabled = remove.disabled = personaPresetBusy;
    select.addEventListener('click', () => void changePersonaPreset('select', preset.id));
    remove.addEventListener('click', () => void changePersonaPreset('remove', preset.id));
    chip.append(select, remove); return chip;
  }));
}
async function changePersonaPreset(action, id) {
  if (personaPresetBusy || !user) return;
  personaPresetBusy = true;
  const version = authVersion, saveButton = $('persona-form').querySelector('[type=submit]'), result = $('persona-result');
  saveButton.disabled = true; renderPersonaPresets();
  try {
    if (action === 'select' && dirty.has('persona')) {
      const approved = await window.atbConfirm({ title: '有未保存的角色设定', message: '是否放弃当前未保存的助手设定，切换到此角色？', cancelLabel: '继续编辑', confirmLabel: '放弃修改并切换' });
      if (!approved || version !== authVersion || !user) return;
    }
    const edit = edits.persona; settingsRevision++;
    personaSaveState('saving');
    result.dataset.error = 'false'; result.textContent = action === 'select' ? '正在切换角色…' : '正在删除预设…';
    const next = await api('/api/assistant/settings', { scope: 'personaPreset', action, id });
    if (version !== authVersion || !user) return;
    settingsRevision++;
    if (action === 'select') { stopChat(); await assistantVoice.stop(); if (version !== authVersion || !user) return; }
    const merged = { ...config, name: next.name, prompt: next.prompt, personaPresets: next.personaPresets, activePersonaPresetId: next.activePersonaPresetId };
    const unchanged = edit === edits.persona;
    fill(merged, action === 'select' && unchanged ? ['persona'] : []);
    result.textContent = action === 'remove' ? '角色预设已删除' : unchanged ? '已切换角色' : '已切换角色，当前新修改尚未保存';
  } catch (error) { if (version === authVersion && user) { result.dataset.error = 'true'; result.textContent = error.message; personaSaveState('error'); } }
  finally { personaPresetBusy = false; saveButton.disabled = false; if($('persona-state').dataset.status==='saving')personaSaveState(dirty.has('persona')?'dirty':'saved'); renderPersonaPresets(); }
}
function summary() {
  if (!config) return;
  const ready = Boolean(config.hasApiKey && config.model);
  $('wake-default').textContent = config.name || '小鲸鱼';
  $('assistant-name').textContent = config.name; $('assistant-setup').hidden = ready;
  if (!chatController) $('chat-state').textContent = ready ? ($('chat-model').value || config.model) : '等待配置模型';
  $('key-state').textContent = config.hasApiKey ? `${config.apiSource === 'custom' ? '本助手自定义' : '平台默认'} API 已配置 · 密钥已保存，留空保留。` : '尚未保存密钥。';
  $('api-key').placeholder = config.hasApiKey ? '密钥已配置 · 留空保留' : '填写服务商密钥';
  const current = $('chat-model').value; const options = config.selectedModels?.length ? config.selectedModels : [config.model].filter(Boolean);
  $('chat-model').replaceChildren(...options.map(name => new Option(name, name))); $('chat-model').value = options.includes(current) ? current : config.model || options[0] || '';
  $('chat-model').disabled = !ready || Boolean(chatController);
}
function fill(next, scopes = ['model', 'persona', 'memory']) {
  next = { ...conversationDefaults, ...next }; config = next;
  for (const scope of scopes) {
    if (scope === 'model') {
      aiProfiles.accept(next); activeAiProvider = next.provider || 'custom';
      $('api-source').value = next.apiSource || 'platform'; selectedModels = next.selectedModels || [next.model].filter(Boolean); renderSelectedModels(); sourceState();
      for (const key of ['provider','protocol','model']) $(key).value = next[key] || (key === 'protocol' ? 'chat' : '');
      $('base-url').value = next.baseUrl || ''; $('base-url').readOnly = next.provider !== 'custom'; $('api-key').value = ''; $('clear-key').checked = false;
      applyAiPresetControls(activeAiProvider, $('base-url'), $('protocol'));
    } else {
      for (const key of fieldGroups[scope]) { if ($(key).type === 'checkbox') $(key).checked = Boolean(next[key]); else $(key).value = next[key] ?? ''; }
      if (scope === 'memory') { $('memory-mode').value = next.memoryMode || 'summary'; $('context-turns').value = String(next.contextTurns || 3); $('legacy-memory-section').hidden = !next.memory; $('legacy-memory').textContent = next.memory || ''; }
    }
    setDirty(scope, false);
  }
  summary(); renderPersonaPresets();
  requestAnimationFrame(growInputs);
}
function fillCleanSettings(next) { fill(next, Object.keys(fieldGroups).filter(scope => !dirty.has(scope))); }
function stopChat() { opportunityClient.cancel(); chatVersion++; chatController?.abort(); chatController = null; summary(); }
function signedOut(message = '') {
  toolsPanel.stop();
  companionEvent('reset');
  faceManagement.stop();
  presencePanel.stop();
  opportunityClient.cancel();
  authVersion++; stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort(); voiceRefreshAt = 0;
  if (user) try { sessionStorage.removeItem(historyKey()); } catch {}
  chatHistory.close();
  user = null; messages = []; config = null; renderPersonaPresets(); $('messages').replaceChildren(); $('login').hidden = false; $('workspace').hidden = true; $('user-label').textContent = '访客'; $('login-error').textContent = message;
  $('api-key').value = ''; $('prompt').value = ''; dirty.clear(); aiProfiles.clear();
  $('tts-api-key').value = ''; $('tts-access-key').value = ''; voiceDrafts.clear(); chatSeedCustom = false; chatPresetVoice = null; chatSeedDraft = '42'; voicePicker.close(); voiceStatus = undefined; voiceCatalogVersion++;
  $('auto-memory').textContent = ''; $('working-memory').textContent = ''; $('memory-prune-report').textContent = ''; $('auto-memory-state').textContent = ''; memoryRefreshAt = 0;
  $('legacy-memory').textContent = ''; renderBalance('chat', {kind:'signedOut'}); renderBalance('speech', {kind:'signedOut'}); balanceRefreshAt = 0; balanceSpeechProvider = undefined; balanceVersion++;
}
async function refreshSession() {
  if (sessionTask) return sessionTask;
  sessionTask = (async () => {
    let version = authVersion; let retryDelay = document.hidden ? 20000 : 8000;
    try {
      const session = await api('/api/auth/session', undefined, AbortSignal.timeout(6000)); if (version !== authVersion) return; needsSetup = session.needsSetup;
      $('login-title').textContent = needsSetup ? '创建管理员账号' : '登录工作台'; $('confirm-row').hidden = !needsSetup;
      $('login-note').textContent = needsSetup ? session.canSetup ? '创建账号后使用 ATB 智能助手。' : '请先在运行服务的电脑上创建管理员账号。' : '使用 ATB 管理员账号继续。';
      $('login-form').querySelector('button').disabled = needsSetup && !session.canSetup;
      if (!session.user) { connected(true); if (user) signedOut('登录已过期，请重新登录'); else $('login').hidden = false; return; }
      const changed = !user || user.username !== session.user.username;
      if (user && user.username !== session.user.username) { signedOut(); version = authVersion; }
      user = session.user;
      if (changed) { faceManagement.stop(); presencePanel.stop(); presencePanel.start(); }
      $('login').hidden = true; $('workspace').hidden = false; $('user-label').textContent = user.username;
      if (changed || !config) {
        const next = await api('/api/assistant/settings'); if (version !== authVersion || !user) return;
        fill(next); await chatHistory.open(user.username); if (version !== authVersion || !user) return; loadHistory(); renderMessages(); show(location.hash.slice(1) || 'assistant', true);
      } else if (!chatController) {
        const revision = settingsRevision;
        const next = await api('/api/assistant/settings');
        if (version !== authVersion || !user) return;
        if (!chatController && revision === settingsRevision) fillCleanSettings(next);
      }
      void refreshVoice();
      void refreshMemory();
      if (config?.proactiveChat && window.atbDesktop?.hasModule('assistant')) void window.atbDesktop.invokeModule('assistant', 'presence', {action:'start'}).catch(() => {});
      void refreshOpportunities();
      void opportunityClient.poll();
      void refreshBalance();
      connected(true);
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
  event.preventDefault(); if (scope === 'persona' && personaPresetBusy) return;
  if (scope === 'persona') { personaPresetBusy = true; renderPersonaPresets(); }
  const button = event.currentTarget.querySelector('[type=submit]'), result = $(`${scope}-result`); button.disabled = true; result.dataset.error = 'false'; result.textContent = '正在保存…';
  if(scope==='persona')personaSaveState('saving');
  const edit = edits[scope], version = authVersion;
  try {
    const body = scope === 'model' ? modelDraft() : { ...Object.fromEntries(fieldGroups[scope].map(key => [key, $(key).type === 'checkbox' ? $(key).checked : $(key).type === 'number' ? Number($(key).value) : $(key).value])), ...(scope === 'memory' ? { memory: config.memory || '', memoryMode: $('memory-mode').value, contextTurns: Number($('context-turns').value) } : {}) };
    const next = await api('/api/assistant/settings', { scope, ...body });
    if (version !== authVersion || !user) return;
    settingsRevision++;
    const keys = scope === 'model' ? ['provider', 'baseUrl', 'protocol', 'model', 'hasApiKey', 'apiSource', 'selectedModels', 'profiles'] : scope === 'memory' ? ['memory', 'memoryMode', 'contextTurns'] : [...fieldGroups[scope], 'personaPresets', 'activePersonaPresetId'];
    const merged = { ...config, ...Object.fromEntries(keys.map(key => [key, next[key]])) };
    const unchanged = edit === edits[scope]; fill(merged, unchanged ? [scope] : []);
    if (scope === 'model') { if (aiProfiles.hasDrafts()) setDirty('model', true); balanceRefreshAt = 0; void refreshBalance(); }
    result.textContent = unchanged ? '已保存' : '上次提交已保存，当前新修改尚未保存';
    if (scope === 'memory') void refreshMemory(true);
  } catch (error) { if (version === authVersion) { result.dataset.error = 'true'; result.textContent = error.message; if(scope==='persona')personaSaveState('error'); } } finally { button.disabled = false; if (scope === 'persona') { personaPresetBusy = false; if($('persona-state').dataset.status==='saving')personaSaveState(dirty.has('persona')?'dirty':'saved'); renderPersonaPresets(); } }
});
function cancelModels() { modelVersion++; modelController?.abort(); modelController = null; $('load-models').disabled = false; }
function resetModels() { cancelModels(); models = []; if ($('model-dialog').open) $('model-dialog').close(); $('model-filter').value = ''; $('models-status').textContent = '接口已更改，请重新获取模型列表。'; }
$('provider').addEventListener('change', () => {
  aiProfiles.remember({ ...modelDraft(), provider: activeAiProvider });
  activeAiProvider = $('provider').value;
  const draft = aiProfiles.get(activeAiProvider), saved = aiProfiles.saved(activeAiProvider);
  for (const key of ['protocol','model']) $(key).value = draft[key];
  $('base-url').value = draft.baseUrl; $('api-key').value = draft.apiKey; $('clear-key').checked = draft.clearKey;
  selectedModels = draft.selectedModels; renderSelectedModels(); applyAiPresetControls(activeAiProvider, $('base-url'), $('protocol')); resetModels();
  $('key-state').textContent = saved.hasApiKey ? '此厂商密钥已保存，留空保留。' : '此厂商尚未保存密钥。';
  $('api-key').placeholder = saved.hasApiKey ? '此厂商密钥已配置 · 留空保留' : '填写此厂商密钥';
  $('models-status').textContent = '已恢复此厂商配置，可获取模型列表。'; setDirty('model', true);
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
  const log = $('messages'), follow = log.scrollHeight - log.scrollTop - log.clientHeight < 70;
  $('transcript-count').textContent = messages.length ? `· ${messages.length}` : '';
  $('messages').replaceChildren();
  if (!messages.length) {
    const div = document.createElement('div'); div.className = 'welcome'; const title = document.createElement('h2'), help = document.createElement('p'); title.textContent = '有什么可以帮你？'; help.textContent = config?.hasApiKey && config?.model ? '试着打个招呼，或告诉我你的一个偏好。' : '先配置模型，再开始对话。'; div.append(title, help); $('messages').append(div); return;
  }
  for (const message of messages) {
    const el = document.createElement('div'), label = document.createElement('span'), body = document.createElement('div'), content = document.createElement('div'), speak = document.createElement('button');
    el.className = `bubble ${message.role}`; label.className = 'bubble-label'; label.textContent = message.role === 'user' ? (message.status==='failed'?'你 · 未完成':'你') : config?.name || '助手';
    body.className = 'message-body'; content.className = 'message-content'; renderMessageContent(content, message.content, { rich: message.role === 'assistant' });
    speak.type = 'button'; speak.className = 'message-speak'; speak.title = '朗读此消息'; speak.setAttribute('aria-label', '朗读此消息');
    speak.hidden = message.status === 'failed';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    icon.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#i-speaker'); icon.append(use); speak.append(icon);
    speak.addEventListener('click', async () => { $('chat-error').textContent = ''; try { await assistantVoice.read(message.content); } catch (error) { $('chat-error').textContent = error.message; } });
    body.append(content, speak); el.append(label, body);
    if(message.role==='assistant'&&message.toolsUsed?.length){const sources=document.createElement('div');sources.className='tool-sources';renderToolSources(sources,message.toolsUsed);el.append(sources);}
    $('messages').append(el);
  }
  growInputs();
  if (follow) log.scrollTop = log.scrollHeight;
}
$('clear-chat').addEventListener('click', async () => { stopChat(); void assistantVoice.stop(); messages = []; renderMessages(); await chatHistory.clear(); $('chat-error').textContent = ''; });
async function sendMessage(content, { signal, fromVoice = false, onDelta, proactive = false } = {}) {
  if (chatController || !content && !proactive) return;
  opportunityClient.cancel();
  if (fromVoice && !proactive) {
    const handled = await handlePresenceUtterance({ text: content, request: api, signal, stop: () => assistantVoice.stop() });
    if (handled) { notice('已暂停主动互动2小时'); return ''; }
    signal?.throwIfAborted();
  }
  const version = ++chatVersion, controller = new AbortController(); chatController = controller;
  loadHistory();
  const historyGeneration = chatHistory.read().generation;
  const turn = proactive ? null : { role: 'user', content, status: 'pending' };
  $('chat-error').textContent = ''; if (turn) messages.push(turn); renderMessages(); persistHistory();
  $('chat-state').textContent = '正在思考…';
  let partial;
  try {
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const revision = settingsRevision, next = await api('/api/assistant/settings', undefined, requestSignal);
    if (version !== chatVersion || !user) return;
    if (revision === settingsRevision) fillCleanSettings(next);
    if (!config?.hasApiKey || !config.model) throw Error('请先在模型服务中配置密钥和模型。');
    const history = conversationContext(messages, 16000, config.contextTurns || 3);
    const delta = text => {
      if (!text || version !== chatVersion || !user) return;
      if (!partial) { partial = { role: 'assistant', content: '', status: 'pending' }; messages.push(partial); renderMessages(); }
      const log = $('messages'), follow = log.scrollHeight - log.scrollTop - log.clientHeight < 70;
      partial.content += text;
      companionEvent('delta',{text:partial.content});
      renderMessageContent($('messages').querySelector('.bubble.assistant:last-child .message-content'), partial.content);
      if (follow) log.scrollTop = log.scrollHeight;
      onDelta?.(text);
    };
    const streaming = !fromVoice || Boolean(onDelta);
    const result = await api('/api/assistant/chat', { messages: history, ...(proactive ? { proactive: true } : {}), ...(streaming ? { stream: true } : {}), model: $('chat-model').value || config.model, turnId: crypto.randomUUID() }, requestSignal, streaming ? delta : undefined, tool=>{if(version===chatVersion&&user)$('chat-state').textContent=toolResultLabel(tool);});
    if (version !== chatVersion || !user) return;
    if (result.skipped) return '';
    if (turn) turn.status = 'complete';
    if (partial) {partial.content = result.reply;partial.toolsUsed=result.toolsUsed;partial.status='complete';} else messages.push({ role: 'assistant', content: result.reply,toolsUsed:result.toolsUsed,status:'complete' });
    companionEvent('reply',{text:result.reply});
    partial = null; renderMessages(); await persistHistory(historyGeneration); void refreshMemory(true); void refreshBalance(); return result.reply;
  } catch (error) { if (version === chatVersion && user) { $('chat-error').textContent = error.name === 'AbortError' ? '请求已停止。' : error.message; if(turn&&error.name!=='AbortError'&&!signal?.aborted&&!controller.signal.aborted)messages.push({role:'assistant',content:'本次未完成：'+error.message,status:'failed'}); } if (fromVoice) throw error; }
  finally {
    if (partial && messages.includes(partial)) { messages = messages.filter(message => message !== partial); renderMessages(); }
    if (turn && messages.includes(turn) && turn.status === 'pending') { turn.status = 'failed'; await persistHistory(historyGeneration); }
    if (version === chatVersion) { chatController = null; loadHistory(); renderMessages(); summary(); }
  }
}
$('chat-model').addEventListener('change', () => { if (!chatController) $('chat-state').textContent = $('chat-model').value; });
$('voice-start').addEventListener('click', async () => { stopChat(); $('voice-start').disabled = true; syncVoiceOrb(); $('chat-error').textContent = ''; try { await assistantVoice.start(); } catch (error) { $('chat-error').textContent = error.message; } finally { await refreshVoice(true); } });
$('voice-stop').addEventListener('click', async () => { stopChat(); $('voice-orb').disabled = true; try { await assistantVoice.stop(); } finally { await refreshVoice(true); syncVoiceOrb(); } });
$('voice-orb').addEventListener('click', () => { $(assistantVoice.active ? 'voice-stop' : 'voice-start').click(); });
window.atbDesktop?.onCompanionCommand?.(command => {
  if(command.action==='toggleVoice')$('voice-orb').click();
  if(command.action==='persona'){const form=$('persona-form');for(let node=form?.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;form?.scrollIntoView({behavior:'smooth',block:'start'});}
});
$('voice-interrupt').addEventListener('click', async () => { stopChat(); try { await assistantVoice.interrupt(); } catch (error) { $('chat-error').textContent = error.message; } });
for (const id of ['memory-mode', 'context-turns']) $(id).addEventListener('change', () => { setDirty('memory', true); $('memory-result').textContent = ''; });
$('clear-auto-memory').addEventListener('click', async () => {
  const version = authVersion; $('clear-auto-memory').disabled = true;
  try { await api('/api/assistant/memory', { action: 'clear' }); if (version === authVersion && user) { await refreshMemory(true); notice('分层记忆已清空，旧版文件和手动固定记忆保留'); } }
  catch (error) { if (version === authVersion && user) $('memory-result').textContent = error.message; }
  finally { $('clear-auto-memory').disabled = false; }
});
for (const id of ['voice-provider', 'tts-auth-mode', 'tts-app-id', 'tts-api-key', 'tts-access-key', 'tts-model-name', 'tts-voice-kind', 'tts-concurrency', 'tts-method', 'tts-context-texts', 'tts-speaker', 'tts-model-version', 'tts-sample-rate', 'tts-emotion', 'tts-emotion-scale', 'tts-clear-credentials', 'voice-enabled', 'wake-enabled', 'wake-phrases', 'voice-name', 'voice-rate', 'voice-volume', 'voice-pitch', 'voice-silence', 'voice-auto', 'voice-barge-in', 'voice-barge-threshold', 'voice-barge-duration', 'voice-low-latency']) $(id).addEventListener('input', () => {
  if (id === 'voice-name') { selectedVoice = $('voice-name').value; if ($('voice-provider').value === 'chattts' && !chatSeedCustom) chatPresetVoice = selectedVoice; }
  if (id === 'tts-voice-kind' && $('tts-voice-kind').value === 'preset' && !voiceCatalog.some(item => item.id === selectedVoice)) { selectedVoice = voiceCatalog[0]?.id || 'zh_female_xiaohe_uranus_bigtts'; renderVoices(); }
  if (['voice-name', 'tts-voice-kind', 'tts-concurrency', 'tts-model-name', 'tts-method', 'tts-model-version'].includes(id)) volcVoiceControls();
  speechValues(); voiceEdit++; dirty.add('voice'); $('voice-state').textContent = '未保存'; $('voice-state').dataset.dirty = 'true'; $('voice-result').textContent = ''; $('voice-preview').disabled = true;
});
document.querySelectorAll('[name=tts-method-choice]').forEach(el => el.addEventListener('change', () => { if (el.checked) { $('tts-method').value = el.value; $('tts-method').dispatchEvent(new Event('input')); } }));
$('tts-auth-mode').addEventListener('change', voiceProviderControls);
$('voice-provider').addEventListener('change', async () => {
  voiceDrafts.set(voiceFormProvider, { voice: voiceFormProvider === 'volcengine' && $('tts-model-name').value.startsWith('seed-icl-') ? $('tts-speaker').value : selectedVoice, rate: Number($('voice-rate').value), volume: Number($('voice-volume').value), pitch: Number($('voice-pitch').value) });
  voiceFormProvider = $('voice-provider').value; const provider = voiceFormProvider, version = ++voiceCatalogVersion, auth = authVersion;
  const profile = voiceDrafts.get(provider) || voiceStatus?.settings?.profiles?.[provider] || { voice: isLocalTts(provider) ? provider === 'qwen3tts' ? 'qwen3tts:serena' : 'chattts:42' : provider === 'volcengine' ? 'zh_female_wanwanxiaohe_moon_bigtts' : 'chattts:42', rate: 0, volume: 0, pitch: 0 };
  voiceLanguages = []; voiceCapabilities = {}; voiceProviderControls(); voicePicker.close(); selectedVoice = profile.voice; voiceCatalog = []; $('voice-picker').hidden = false;
  if (provider === 'volcengine' && $('tts-voice-kind').value === 'clone') $('tts-speaker').value = profile.voice;
  for (const key of ['rate', 'volume', 'pitch']) $(`voice-${key}`).value = String(profile[key] || 0);
  $('voice-search').value = ''; speechValues(); renderVoices(); $('voice-preview').disabled = true;
  try { const result = await assistantVoice.catalog(provider, false); if (version === voiceCatalogVersion && auth === authVersion && user) { voiceCatalog = result.voices; voiceLanguages = result.languages || []; voiceCapabilities = result.capabilities || {}; voiceProviderControls(); renderVoices(); volcVoiceControls(); } }
  catch (error) { if (version === voiceCatalogVersion && auth === authVersion && user) $('voice-catalog-state').textContent = error.message; }
});
$('voice-language').addEventListener('change', renderVoices);
$('chattts-ranking').addEventListener('change', renderVoices);
function chatSeedControls() {
  const chat = $('voice-provider').value === 'chattts', custom = chat && chatSeedCustom;
  $('voice-preset-field').hidden = custom;
  $('chattts-seed').hidden = !custom; $('chattts-seed').disabled = !custom;
  $('chattts-seed').value = chatSeedDraft;
  $('chattts-seed').setCustomValidity(custom && !validChatSeed(chatSeedDraft) ? '请输入 0–4294967295 之间的整数种子' : '');
  $('chattts-seed-fields').hidden = !custom;
  $('chattts-seed-toggle').hidden = !chat;
  $('chattts-seed-toggle').textContent = custom ? '预设' : '自定义';
  $('chattts-seed-toggle').setAttribute('aria-pressed', String(custom));
  $('reply-voice-label').textContent = custom ? '回复音色（自定义随机种子）' : '回复音色';
  $('reply-voice-label').htmlFor = custom ? 'chattts-seed' : 'voice-picker-trigger';
}
const validChatSeed = seed => /^(0|[1-9][0-9]{0,9})$/.test(seed) && Number(seed) <= 4294967295;
function applyChatSeed() {
  const input = $('chattts-seed'), seed = input.value; chatSeedDraft = seed;
  voiceEdit++; dirty.add('voice'); $('voice-state').textContent = '未保存'; $('voice-state').dataset.dirty = 'true'; $('voice-preview').disabled = true;
  const valid = validChatSeed(seed);
  input.setCustomValidity(valid ? '' : '请输入 0–4294967295 之间的整数种子');
  if (!valid) { $('voice-result').textContent = '请输入有效的音色种子；不会试听旧音色。'; return; }
  selectedVoice = 'chattts:' + seed;
  if (!voiceCatalog.some(v => v.id === selectedVoice)) voiceCatalog.push({id:selectedVoice,name:'种子 '+seed,locale:'mul',languages:['zh','en']});
  renderVoices(); $('voice-name').dispatchEvent(new Event('input', {bubbles:true})); $('voice-name').dispatchEvent(new Event('change', {bubbles:true}));
  $('voice-result').textContent = `已选择种子 ${seed}，保存后试听。`;
}
$('chattts-seed').addEventListener('input', () => applyChatSeed());
$('chattts-seed-toggle').addEventListener('click', () => {
  voicePicker.close();
  if (!chatSeedCustom) chatPresetVoice = selectedVoice;
  chatSeedCustom = !chatSeedCustom; chatSeedControls();
  if (chatSeedCustom) { applyChatSeed(); $('chattts-seed').focus({ preventScroll: true }); }
  else {
    selectedVoice = chatPresetVoice; renderVoices();
    $('voice-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('voice-picker-trigger').focus({ preventScroll: true });
  }
});
$('voice-reset').addEventListener('click', () => { for (const key of ['rate', 'volume', 'pitch']) { $(`voice-${key}`).value = '0'; $(`voice-${key}`).dispatchEvent(new Event('input')); } });
$('refresh-voices').addEventListener('click', async () => {
  const version = authVersion, catalogVersion = ++voiceCatalogVersion, provider = $('voice-provider').value; $('refresh-voices').disabled = true; $('voice-catalog-state').textContent = provider === 'volcengine' ? '正在获取官方音色目录…' : '正在读取本地音色…';
  try { const result = await assistantVoice.catalog(provider); if (version === authVersion && catalogVersion === voiceCatalogVersion && user) { voiceCatalog = result.voices; voiceLanguages = result.languages || []; voiceCapabilities = result.capabilities || {}; voiceProviderControls(); renderVoices(); volcVoiceControls(); } }
  catch (error) { if (version === authVersion && user) $('voice-catalog-state').textContent = error.message; }
  finally { voiceProviderControls(); }
});
$('voice-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'), edit = voiceEdit, version = authVersion; button.disabled = true;
  const options = { provider: $('voice-provider').value, enabled: $('voice-enabled').checked, wakeEnabled: $('wake-enabled').checked, wakePhrases: $('wake-phrases').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean), voice: $('voice-name').value, rate: Number($('voice-rate').value), volume: Number($('voice-volume').value), pitch: Number($('voice-pitch').value), silenceMs: Number($('voice-silence').value), autoListen: $('voice-auto').checked, autoInterrupt: $('voice-barge-in').checked, bargeInThreshold: Number($('voice-barge-threshold').value), bargeInDurationMs: Number($('voice-barge-duration').value), lowLatency: $('voice-low-latency').checked };
  if (options.provider === 'volcengine') {
    if ($('tts-model-name').value.startsWith('seed-icl-')) options.voice = $('tts-speaker').value.trim();
    options.volcengine = { authMode: $('tts-auth-mode').value, appId: $('tts-app-id').value, apiKey: $('tts-api-key').value, accessKey: $('tts-access-key').value, modelName: $('tts-model-name').value, method: $('tts-method').value, contextTexts: $('tts-context-texts').value, modelVersion: $('tts-model-version').value, sampleRate: Number($('tts-sample-rate').value), emotion: $('tts-emotion').value, emotionScale: Number($('tts-emotion-scale').value), clearCredentials: $('tts-clear-credentials').checked };
  }
  let voiceSaved = false;
  try {
    const presenceDraft = presencePanel.prepare();
    stopChat(); const saved = await assistantVoice.configure(options); voiceSaved = true; if (version !== authVersion || !user) return;
    if (edit === voiceEdit) { dirty.delete('voice'); $('voice-state').textContent = '已保存'; $('voice-state').dataset.dirty = 'false'; fillVoice({ ...voiceStatus, settings: saved }); }
    await presencePanel.save(presenceDraft); if (version !== authVersion || !user) return;
    await refreshVoice(true); updateVoiceSaveState();
    $('voice-result').textContent = dirty.has('voice') || presencePanel.dirty ? '已保存，新的修改尚未保存' : '全部语音设置已保存';
  } catch (error) { if (version === authVersion) { updateVoiceSaveState(); $('voice-result').textContent = (voiceSaved ? '音色设置已保存；到场问候未保存或未应用：' : '') + error.message; } } finally { button.disabled = false; }
});
$('voice-preview').addEventListener('click', async () => {
  if (dirty.has('voice')) { $('voice-result').textContent = '请先保存音色设置，再试听。'; return; }
  const version = authVersion; $('voice-preview').disabled = true; $('voice-result').textContent = '正在生成试听语音…';
  try { const completed = await assistantVoice.preview($('voice-preview-text').value.trim() || undefined); if (version === authVersion && user) $('voice-result').textContent = completed ? '试听播放完成' : '试听已停止'; }
  catch (error) { if (version === authVersion) $('voice-result').textContent = error.message; } finally { await refreshVoice(true); }
});
$('voice-preview-stop').addEventListener('click', () => void assistantVoice.stop());
if (window.atbDesktop) document.documentElement.classList.add('desktop');
$('service-host').textContent = location.host;
window.addEventListener('online', () => void refreshSession()); document.addEventListener('visibilitychange', () => { if (document.hidden) opportunityClient.cancel(); else void refreshSession(); });
window.addEventListener('beforeunload', event => { if (dirty.size || faceManagement.dirty || presencePanel.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { opportunityClient.close(); clearInterval(opportunityTimer); faceManagement.stop(); presencePanel.stop(); stopChat(); void assistantVoice.stop(); cancelModels(); testController?.abort(); clearTimeout(sessionTimer); });
void refreshSession();
