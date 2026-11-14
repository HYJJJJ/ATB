import { createOpportunityClient, backgroundOpportunityState } from './opportunity-client.js';
import { PersonArrivals, matchPerson, presenceIdentityChanged, personPresenceSettings, quietReason } from './presence-state.js';
import { describeFaces } from './presence-face.js';
import { createAssistantVoice } from './assistant-voice.js';
import { createPresenceConversation, createPresenceOpenings, handlePresenceUtterance } from './presence-conversation.js';
import { createChatHistory } from './chat-history.js';
const bridge = window.atbPresence;
let assistantSettings, settings, activePerson, username, version = 0, frameVersion = 0, busy = false, revision, arrivals = new PersonArrivals(), currentPresence, pollBusy = false;
let lastMatched = 0, matchedFrame = false, presentSince = null, foregroundBusy = false, lastAttempt = 0;
const status = (state, text, event) => bridge.call('status', { state, text, event });
let companionLevelAt = 0;
const companionEvent = (type, value = {}) => bridge.call('companion', {type,account:username || '',...value}).catch(()=>{});
async function api(url, body, signal) {
  const timeout = url === '/api/assistant/opportunity' ? 28000 : url === '/api/assistant/chat' ? 65000 : 10000;
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || '后台请求失败'); return result;
}
const chatHistory = createChatHistory({onChange(_messages,{cleared}){if(cleared)void cancelInteraction();}});
const conversation = createPresenceConversation({ request: api, history: chatHistory });
const voice = createAssistantVoice({ api, native: { voice: (action, options) => bridge.call('voice', { action, ...options }) },
  canChat: () => Boolean(settings?.followUp && activePerson?.isSelf),
  async sendMessage(text, options) {
    settings.lastInteraction = Date.now();
    const handled = await handlePresenceUtterance({ text, request: api, signal: options.signal, stop: cancelInteraction });
    if (handled) {
      settings.snoozeUntil = Date.now() + 120 * 60000;
      await status('running', '语音指令：已暂停主动互动2小时', '收到免打扰指令，主动互动暂停2小时'); return '';
    }
    const reply = await conversation.send(text, options); if(reply)void companionEvent('reply',{text:reply});return reply;
  },
  onState({ phase, text, active }) { void companionEvent('state',{phase,text,active}); if (openings.active || voice.active) void status(phase === 'listening' ? 'listening' : 'greeting', text); },
  onLevel(level){if(performance.now()-companionLevelAt>90){companionLevelAt=performance.now();void companionEvent('level',{level});}},
  onError(text) { void status('error', text, '语音未完成：' + text); },
});
const openings = createPresenceOpenings({ request: api, voice,
  valid: () => settings?.enabled && activePerson?.active && currentPresence?.tracker.present && matchedFrame && Date.now() - lastMatched <= 2500 && !foregroundBusy && !quietReason(settings),
  onClaim(claim) { for (const key of ['lastGreeting', 'lastProactive', 'proactiveDay', 'proactiveCount']) if (claim[key] !== undefined) settings[key] = claim[key]; if (activePerson && claim.lastGreeting) activePerson.lastGreeting = claim.lastGreeting; },
  onEvent(state, text) { void status(state, text, text); },
  remember(text) { conversation.reset(); conversation.remember(text); if(activePerson?.isSelf)void chatHistory.save([{role:'assistant',content:text}]); },
});
const opportunityClient = createOpportunityClient({ request: api,
 state: () => backgroundOpportunityState({assistant:assistantSettings,presence:settings,person:activePerson,account:username,foregroundBusy,voiceActive:voice.active,openingActive:openings.active,matched:matchedFrame,present:currentPresence?.tracker.present,fresh:Date.now()-lastMatched<=2500}),
 async onReply(text,result) {
  void companionEvent('proactive',{text});
  await status('greeting', text, '随机机会：选择聊天'); conversation.remember(text);
  await chatHistory.save([{id:'opportunity:'+result.id,createdAt:result.ts || Date.now(),role:'assistant',content:text}]);
  const audio=await voice.status();if(audio.settings?.enabled)await voice.read(text);
 },
});
async function cancelInteraction() { opportunityClient.cancel(); await openings.cancel(); conversation.reset(); }
async function poll() {
  if (pollBusy) return; pollBusy = true;
  try {
    const session = await api('/api/auth/session');
    if (!session.user || username && username !== session.user.username) { version++; chatHistory.close(); await cancelInteraction(); await bridge.call('stop'); return; }
    username = session.user.username;
    await chatHistory.open(username);
    assistantSettings = await api('/api/assistant/settings');
    const next = await api('/api/assistant/presence');
    if (!next.enabled && !assistantSettings.proactiveChat) { version++; await cancelInteraction(); await bridge.call('stop'); return; }
    if (next.revision !== revision) {
      version++; await cancelInteraction(); arrivals = new PersonArrivals(); activePerson = null; currentPresence = null; presentSince = null; lastMatched = 0; matchedFrame = false;
      settings = next; revision = next.revision; voice.setOutputDevice(next.outputId);
      await status('running', next.enabled ? '后台已启动，等待摄像头画面' : '随机机会已驻留，摄像头未启用');
    } else settings = next;
    const availability = await bridge.call('availability'); foregroundBusy = availability.busy;
    settings.lastInteraction = Math.max(settings.lastInteraction || 0, availability.lastInteraction || 0);
    const quiet = quietReason(settings);
    if (foregroundBusy || quiet) {
      if (voice.active || openings.active) await cancelInteraction();
      await status('running', foregroundBusy ? '前台正在使用语音，后台暂不打扰' : quiet);
    }
    await bridge.call('camera', next.enabled ? { cameraId: next.cameraId } : {});
    if (!next.enabled || activePerson?.isSelf) void opportunityClient.poll();
  } catch (error) { version++; frameVersion++; arrivals.unavailable(); matchedFrame = false; lastMatched = 0; await cancelInteraction(); await bridge.call('camera', {}); await status('error', error.message); }
  finally { pollBusy = false; }
}
bridge?.onFrame(async data => {
  if (data.kind === 'foreground' || data.kind === 'pause') {
    if (data.kind === 'foreground') foregroundBusy = true;
    else if (settings) settings.snoozeUntil = Date.now() + 300000;
    await cancelInteraction(); return;
  }
  if (!settings?.enabled) return;
  if (data.kind !== 'frame') { frameVersion++; arrivals.unavailable(); matchedFrame = false; lastMatched = 0; await cancelInteraction(); await status(data.kind === 'error' ? 'error' : 'running', data.error || '画面不可用，暂停判断离场'); return; }
  if (busy || pollBusy) return;
  const epoch = version, frameEpoch = frameVersion; busy = true; let image;
  try {
    image = await createImageBitmap(new Blob([data.bytes], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image, 0, 0);
    const faces = await describeFaces(canvas);
    if (epoch !== version || frameEpoch !== frameVersion) return;
    const at = Date.now(), person = faces.length === 1 ? matchPerson(faces[0], settings.people) : null;
    const observed = arrivals.observe(person?.id || '', at), matched = Boolean(person), arrival = Boolean(observed.current?.pendingArrival);
    if (presenceIdentityChanged(activePerson?.id, person?.id, faces.length)) await cancelInteraction();
    if (person) { activePerson = person; currentPresence = observed.current; lastMatched = at; presentSince = observed.current?.since ?? null; }
    matchedFrame = matched;
    if (!matched && at - lastMatched > 15000 && (voice.active || openings.active)) await cancelInteraction();
    if (foregroundBusy || voice.active || openings.active || quietReason(settings, at)) return;
    const selected = personPresenceSettings(settings, person);
    const opportunityReason = assistantSettings?.proactiveChat && settings.proactiveEnabled ? '等待随机机会' : '到场已确认';
    await status('running', matched ? `${person.name} · ${currentPresence.tracker.present ? opportunityReason : '已匹配，正在确认到场'}` : faces.length > 1 ? '多人同框，暂停身份问候' : faces.length ? '未确认人物身份或匹配不唯一' : '画面中未检测到清晰人脸');
    if (epoch !== version || frameEpoch !== frameVersion) return;
    if (arrival && at - lastAttempt >= 10000) { lastAttempt = at; if (currentPresence) currentPresence.pendingArrival = false; void openings.start('arrival', selected); }
    else if (matched && person.isSelf) void opportunityClient.poll();
  } catch (error) { arrivals.unavailable(); matchedFrame = false; await status('error', error.message); }
  finally { image?.close(); busy = false; }
});
if (bridge) { void poll(); setInterval(poll, 3000); setInterval(() => { if ((voice.active || openings.active) && Date.now() - lastMatched > 15000) void cancelInteraction(); }, 1000); }
window.addEventListener('pagehide', () => { opportunityClient.close(); version++; void cancelInteraction(); });
