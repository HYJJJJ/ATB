import { createAssistantVoice } from './assistant-voice.js';
import { conversationContext } from './assistant-context.js';
import { readChatReply } from './chat-stream.js';
import { balanceView, usageView } from './balance-view.js';
import { nextReminderAt, randomBubblePosition, replyBubblePosition, replyBubbleSize, replyMedia } from './companion-policy.js';
import { quietReason } from './presence-state.js';
import { handlePresenceUtterance } from './presence-conversation.js';
import { renderToolSources } from './message-content.js';
import { createWakeListener } from './wake-listener.js';
import { createChatHistory } from './chat-history.js';
const $ = id => document.getElementById(id), bridge = window.atbCompanion;
let settings = {}, config = {}, presence = {}, account = '', generation = 0, messages = [], requestController;
const chatHistory = createChatHistory({onChange(next,{cleared}) {
  messages=next;
  if(cleared){requestController?.abort();void voice.stop();showReply('');renderToolSources($('reply-sources'),[]);}
}});
let pollBusy = false, noticeAnimation, noticePosition, noticeLayoutKey, replyTimer, replyVisible = false, resetTask = Promise.resolve(), lastPosition, remoteActive = false, reminderBusy = false, reminderKind = -1, lastNews;
let layout, replyDismissed = false, replyFinished = true, lastReply = '', balanceReminderCount = 0, balanceSampleAt = 0;
let replyPhase='off',replyFade,replyHovered=false,requestedReplyHeight=0,replySide,remoteSource;
let preparationTask, preparationRetryAt = 0, preparationState = 'idle';
let wakeSettings = {}, wakeListening = false, wakeRetryAt = 0, wakeHoldUntil = 0;
let wakeReplies = [], wakeRepliesKey = '', lastWakeReply = '', wakeRepliesTask, wakeRepliesController, wakeRepliesRetryAt = 0;
const speakingPhases=new Set(['loading','transcribing','thinking','synthesizing','speaking']);
function cancelReplyExpiry(){clearTimeout(replyTimer);replyTimer=null;replyFade?.cancel();replyFade=null;}
function scheduleReplyExpiry(){
  if(!replyVisible||!replyFinished||replyTimer||replyFade||replyHovered||speakingPhases.has(replyPhase)||$('image-viewer').open)return;
  replyTimer=setTimeout(()=>{
    replyTimer=null;
    const animation=$('speech').animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-6px)'}],{duration:200,easing:'ease-out',fill:'both'});
    replyFade=animation;animation.onfinish=()=>{if(replyFade!==animation)return;replyVisible=false;replyDismissed=true;$('speech').hidden=true;replyFade=null;animation.cancel();reflow();};
  },5000);
}
const phaseLabels = { off:'点击开始对话',loading:'正在准备',listening:'我在听',transcribing:'正在识别',thinking:'想一想',synthesizing:'正在生成语音',speaking:'正在说话' };
const call = (action, options = {}) => bridge?.call(action, options);
async function api(url, body, signal) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(12000), ...(body ? { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) } : {}) });
  if (response.status === 401 && account) reset();
  if (!response.ok) throw Error('服务暂时不可用，请稍后重试');
  return response.json();
}
function paintState({ phase = 'off', active = false, text } = {}) {
  replyPhase=phase;if(speakingPhases.has(phase))cancelReplyExpiry();else scheduleReplyExpiry();
  if (phase === 'thinking' || phase === 'transcribing') { replyDismissed = false; replyFinished = true;renderToolSources($('reply-sources'),[]); }
  $('companion').dataset.phase = phase; $('companion').dataset.pose = ['transcribing','thinking','synthesizing'].includes(phase)?'thinking':phase; $('companion').style.setProperty('--level','0');
  if(active || phase !== 'off')hideNotice();
  $('avatar').setAttribute('aria-label', active ? '小鲸鱼，点击关闭语音对话' : '小鲸鱼，点击开始语音对话');
  $('avatar').setAttribute('aria-pressed', String(active));
  const readiness = { loading:'正在提前加载语音模型', ready:'语音模型已就绪', error:'语音准备失败，点击重试', disabled:'请先在语音设置开启语音功能' };
  $('avatar').title = (!account ? '请先登录 ATB' : phase === 'off' && wakeListening ? `等待唤醒：${config.name || '小鲸鱼'}（麦克风本地监听中）` : phase === 'off' && readiness[preparationState] || text || phaseLabels[phase] || '我在这里') + ' · 点击开关语音对话 · 拖动位置 · 右键菜单';
  reflow();
}
function showReply(text, final = false) {
  if(text)hideNotice();
  if(!text)renderToolSources($('reply-sources'),[]);
  if (!text || replyFinished && text !== lastReply && !text.startsWith(lastReply)) replyDismissed = false;
  if(text!==lastReply&&(replyFinished||!text.startsWith(lastReply)))$('speech-body').scrollTop=0;
  lastReply = text; replyFinished = final;
  cancelReplyExpiry(); const parsed = replyMedia(text);
  $('reply').textContent = parsed.text; $('companion').dataset.mood = parsed.mood;
  $('reply-images').replaceChildren();
  if (final) for (const media of parsed.images) {
    const button = document.createElement('button'); button.className = 'image-open'; button.textContent = '▧ ' + media.alt; button.addEventListener('click', () => void openImage(media)); $('reply-images').append(button);
  }
  replyVisible = Boolean(text) && !replyDismissed; $('speech').hidden = !settings.showText || !replyVisible;
  reflow();
  if (final) scheduleReplyExpiry();
}
function applySettings(value) { settings = value || {}; $('speech').hidden = !settings.enabled || !settings.showText || !replyVisible; if (!settings.reminders || !$('speech').hidden || !settings.enabled) hideNotice(); if (!settings.enabled) { clearWakeReplies(); void stop(); } reflow(); }
function place(element,point){element.style.left=point.x+'px';element.style.top=point.y+'px';}
function bounded(point,element){return{x:Math.max(8,Math.min(innerWidth-element.offsetWidth-8,point.x)),y:Math.max(8,Math.min(innerHeight-element.offsetHeight-8,point.y))};}
function positionNotice(keep=false){
  const avatar=$('avatar').getBoundingClientRect(),key=[innerWidth,innerHeight,avatar.x,avatar.y].join(',');
  if(keep&&noticePosition&&noticeLayoutKey===key)return true;
  // Reserve the entire upward path, so drifting hints cannot cross the avatar or screen edge.
  const point=randomBubblePosition({width:innerWidth,height:innerHeight,avatar,bubble:{width:$('notice').offsetWidth,height:$('notice').offsetHeight+18},previous:lastPosition});
  if(!point){hideNotice(true);return false;}
  lastPosition=point;noticeLayoutKey=key;noticePosition={x:point.x,y:point.y+18};place($('notice'),noticePosition);return true;
}
function reflow(){
  // Native bounds and IPC layout arrive separately. Wait for both to agree;
  // mixing new screen coordinates with the previous viewport can hide a reply.
  if(layout&&(layout.width!==innerWidth||layout.height!==innerHeight))return;
  if(layout){$('companion').style.setProperty('--anchor-x',layout.x+'px');$('companion').style.setProperty('--anchor-y',layout.y+'px');}
  const avatar=$('avatar').getBoundingClientRect();
  if(!$('speech').hidden){
    const speech=$('speech'),body=$('speech-body');
    speech.style.width=Math.min(350,innerWidth-16)+'px';
    const naturalHeight=()=>{
      // Measure the children, not scrollHeight: an assigned/animated frame can
      // leave empty space in the body after a long reply becomes a short one.
      const frame=speech.getBoundingClientRect(),area=body.getBoundingClientRect(),style=getComputedStyle(speech);
      const bottom=Math.max(0,...[...body.children].filter(child=>child.getClientRects().length).map(child=>child.getBoundingClientRect().bottom-area.top+body.scrollTop+parseFloat(getComputedStyle(child).marginBottom)));
      return Math.ceil(area.top-frame.top+bottom+parseFloat(style.paddingBottom)+parseFloat(style.borderBottomWidth));
    };
    const size=replyBubbleSize({width:innerWidth,height:innerHeight,avatar,contentHeight:naturalHeight(),side:replySide});
    if(size&&!replySide)replySide=size.side;
    if(size){speech.style.width=size.width+'px';speech.style.maxHeight=size.maxHeight+'px';}
    const contentHeight=naturalHeight(),height=Math.min(contentHeight,size?.maxHeight||innerHeight-16);
    speech.style.height=height+'px';
    const point=replyBubblePosition({width:innerWidth,height:innerHeight,avatar,bubble:{width:speech.offsetWidth,height},side:replySide});
    if(point)place($('speech'),point);else $('speech').hidden=true;
    requestReplyCanvas(contentHeight);
  }else{
    replyHovered=false;requestReplyCanvas(0);
  }
  if($('notice').classList.contains('visible'))positionNotice(true);
  if(!$('menu').hidden)place($('menu'),bounded({x:$('menu').offsetLeft,y:$('menu').offsetTop},$('menu')));
}
function requestReplyCanvas(height){
  height=Math.ceil(height);if(requestedReplyHeight===height)return;requestedReplyHeight=height;
  void call('replySize',{height})?.catch(()=>{if(requestedReplyHeight===height)requestedReplyHeight=0;});
}
$('speech').addEventListener('pointerenter',()=>{replyHovered=true;cancelReplyExpiry();});
$('speech').addEventListener('pointerleave',()=>{replyHovered=false;scheduleReplyExpiry();});
function applyLayout(value){if(value&&Number.isFinite(value.x)&&Number.isFinite(value.y)){if(!layout||(value.positionRevision!==undefined?value.positionRevision!==layout.positionRevision:Math.abs(value.x-layout.x)>1||Math.abs(value.y-layout.y)>1))replySide=null;layout=value;reflow();}}
window.addEventListener('resize',reflow);
async function closeImage() { if ($('image-viewer').open) $('image-viewer').close(); $('large-image').removeAttribute('src'); $('image-error').textContent = ''; await call('expand',{active:false}); scheduleReplyExpiry(); }
async function openImage(media) {
  if (!account) return; hideNotice(); cancelReplyExpiry(); const epoch = generation;
  await call('expand',{active:true}); if (epoch !== generation || !account) { await call('expand',{active:false}); return; }
  $('image-title').textContent = media.alt; $('large-image').alt = media.alt; $('image-error').textContent = '正在加载图片…';
  $('large-image').onload = () => { if (epoch === generation) $('image-error').textContent = ''; };
  $('large-image').onerror = () => { if (epoch === generation) $('image-error').textContent = '图片无法加载（仅支持公网 HTTPS 的 PNG / JPEG / WebP，最大2MB）'; };
  $('image-viewer').showModal(); $('large-image').src = '/api/assistant/companion/image?url=' + encodeURIComponent(media.url);
}
$('image-close').addEventListener('click',()=>void closeImage()); $('image-viewer').addEventListener('cancel',event=>{event.preventDefault();void closeImage();});
function hideNotice(immediate=false) {
  const element=$('notice');
  if(!element.classList.contains('visible'))return;
  if(immediate){noticeAnimation?.cancel();noticeAnimation=null;element.classList.remove('visible','leaving');return;}
  if(element.classList.contains('leaving'))return;
  const style=getComputedStyle(element),opacity=style.opacity,transform=style.transform;
  noticeAnimation?.cancel();element.classList.add('leaving');
  const animation=element.animate([{opacity,transform},{opacity:0,transform:`translateY(-18px)`}],{duration:180,easing:'ease-out',fill:'both'});
  noticeAnimation=animation;animation.onfinish=()=>{if(noticeAnimation===animation)hideNotice(true);};
}
const brief=(text,max)=>{const chars=[...String(text||'').replace(/\s+/g,' ').trim()];return chars.length>max?chars.slice(0,max-1).join('')+'…':chars.join('');};
function notice(title, text) {
  if (!account || !settings.enabled || voice.active || remoteActive || (replyVisible && settings.showText) || $('image-viewer').open) return;
  hideNotice(true);
  $('notice-title').textContent = brief(title,18); $('notice-text').textContent = brief(text,52);
  if(!positionNotice())return;
  const element=$('notice'),duration=3500+Math.random()*1500,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.classList.add('visible');
  const animation=element.animate([
    {opacity:0,transform:'translateY(0)',offset:0},
    {opacity:1,transform:reduced?'none':'translateY(-1px)',offset:.08},
    {opacity:1,transform:reduced?'none':'translateY(-15px)',offset:.82},
    {opacity:0,transform:reduced?'none':'translateY(-18px)',offset:1}
  ],{duration,fill:'both',easing:'linear'});
  noticeAnimation=animation;animation.onfinish=()=>{if(noticeAnimation===animation)hideNotice(true);};
}
$('reply-sources').addEventListener('click',event=>{const link=event.target.closest('a');if(link){event.preventDefault();void call('external',{url:link.href}).catch(()=>{});}});
async function reminder(kind, manual = false) {
  if (!account || reminderBusy) return; const epoch = generation; reminderBusy = true;
  try {
    let title, text;
    if (kind === 'weather') {
      if (!settings.city) { if(manual)notice('天气','在平台设置中选择天气城市'); return; }
      const city = settings.city, value = await api(`/api/assistant/companion/weather?lat=${city.latitude}&lon=${city.longitude}`);
      title = '天气'; text = `${city.name} · ${value.temperature}°C · ${value.description}`;
    } else if (kind === 'news') {
      const result = await api('/api/assistant/companion/news'); const items = result.items?.filter(item=>item.url!==lastNews) || [], item = items[Math.floor(Math.random()*items.length)];
      if(!item)return; title = item.source; text = item.title; lastNews = item.url;
    } else if (kind === 'balance') {
      const [chat, status, usage] = await Promise.all([api('/api/assistant/balance'),call('voice',{action:'status'}),api('/api/assistant/usage').catch(()=>null)]);
      const provider = status?.settings?.provider; const speech = provider === 'volcengine' ? await api('/api/platform/billing/volcengine/balance') : provider ? {kind:'local'} : {kind:'unconfigured'};
      title = 'API 余额'; text = `对话 ${balanceView(chat).text}\n语音 ${balanceView(speech).text}`;
      const consumption = usage && usageView(usage);
      if (consumption && balanceReminderCount++ % 2 === 0) ({title,text}=consumption);
    } else { title = '小鲸鱼'; const tips = ['点我开始语音，再点一次结束','拖动我就能换个位置','右键可以打开语音和助手设定','想安静一会儿？平台设置可以关闭提醒']; text = tips[Math.floor(Math.random()*tips.length)]; }
    if(epoch===generation && account && settings.enabled && !voice.active && !remoteActive && !quietReason(presence) && !$('image-viewer').open && (manual || settings.reminders && settings[kind]))notice(title,text);
  } catch { if(manual && epoch===generation && account)notice('暂时没取到','稍后再试一下吧'); }
  finally { reminderBusy = false; }
}
async function reminderTick() {
  if(!account || !settings.enabled || !settings.reminders || voice.active || remoteActive || (replyVisible && settings.showText) || $('image-viewer').open || reminderBusy || quietReason(presence))return;
  if(!settings.nextReminderAt){applySettings(await call('update',{nextReminderAt:nextReminderAt()}));return;}
  if(settings.nextReminderAt>Date.now())return;
  // Persist the next opportunity before reading a source, so restarts cannot replay it.
  applySettings(await call('update',{nextReminderAt:nextReminderAt()}));
  const kinds = ['balance','weather','news','tips'].filter(key=>settings[key]&&(key!=='weather'||settings.city));
  if(kinds.length)await reminder(kinds[(++reminderKind)%kinds.length]);
}
async function sendMessage(content, {signal,onDelta} = {}) {
  hideNotice();
  const epoch = generation; if(!account)throw Error('请先登录');
  const handled = await handlePresenceUtterance({text:content,request:api,signal,stop:()=>voice.stop()}); if(handled)return '';
  messages=chatHistory.read().messages;
  const turnId=crypto.randomUUID(),historyGeneration=chatHistory.read().generation;
  const history = conversationContext([...messages,{role:'user',content}],16000,config.contextTurns); requestController = new AbortController();
  const currentRequest=requestController,combined = signal ? AbortSignal.any([signal,currentRequest.signal]) : currentRequest.signal;
  try {
    const response = await fetch('/api/assistant/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:history,model:config.model,stream:Boolean(onDelta),turnId}),signal:combined});
    if(!response.ok){const result=await response.json().catch(()=>({}));if(response.status===401)reset();throw Error(result.error||`对话接口返回 HTTP ${response.status}`);}
    let text, partial = '';const toolsUsed=[];renderToolSources($('reply-sources'),[]);replyDismissed=false;replyFinished=true;
    const delta = value=>{if(epoch!==generation || !account||combined.aborted)return;partial+=value;showReply(partial);onDelta?.(value);};
    if(response.headers.get('content-type')?.includes('application/x-ndjson'))text = await readChatReply(response,{signal:combined,onDelta:delta,onTool:tool=>{if(epoch===generation&&account)toolsUsed.push(tool);}});
    else {const result=await response.json();text=result.reply;toolsUsed.push(...(result.toolsUsed||[]));delta(text);}
    combined.throwIfAborted();if(epoch!==generation || !account)throw Error('会话已切换');
    const saved=await chatHistory.save([{id:turnId+':user',role:'user',content},{id:turnId+':assistant',role:'assistant',content:text,toolsUsed}],historyGeneration,()=>epoch===generation&&!combined.aborted&&requestController===currentRequest);
    combined.throwIfAborted();if(!saved||epoch!==generation)throw new DOMException('会话已清空或切换','AbortError');
    messages=chatHistory.read().messages;renderToolSources($('reply-sources'),toolsUsed);showReply(text,true);return text;
  } catch(error) {
    if(error.name!=='AbortError'&&!combined.aborted&&epoch===generation&&account&&requestController===currentRequest){
      await chatHistory.save([{id:turnId+':user',role:'user',content,status:'failed'},{id:turnId+':assistant',role:'assistant',content:'本次未完成：'+error.message,status:'failed'}],historyGeneration,()=>epoch===generation&&Boolean(account)&&!combined.aborted&&requestController===currentRequest).catch(()=>{});
      messages=chatHistory.read().messages;
    }
    if(epoch===generation && requestController===currentRequest){showReply('');renderToolSources($('reply-sources'),[]);}
    throw error;
  } finally {if(requestController===currentRequest)requestController=null;}
}
const voice = createAssistantVoice({api,sendMessage,canChat:()=>Boolean(account&&config.hasApiKey&&config.model),getConversationSettings:()=>({...config,proactiveChat:false}),native:{voice:(action,options)=>call('voice',{action,...options})},onState:paintState,onLevel:value=>$('companion').style.setProperty('--level',String(Math.max(0,Math.min(1,value)))),onError:text=>{showReply('');notice('语音提示',text);}});
const wakeRepliesIdentity = () => JSON.stringify([account, config.name, config.prompt, config.provider, config.baseUrl, config.protocol, config.model]);
function clearWakeReplies() {
  wakeRepliesController?.abort(); wakeRepliesController = null; wakeRepliesTask = null;
  wakeReplies = []; wakeRepliesKey = ''; lastWakeReply = ''; wakeRepliesRetryAt = 0;
}
function prepareWakeReplies() {
  const key = wakeRepliesIdentity();
  if (wakeRepliesKey !== key) { clearWakeReplies(); wakeRepliesKey = key; }
  if (!account || !settings.enabled || !wakeSettings.enabled || !wakeSettings.wakeEnabled || !config.hasApiKey || !config.model) { clearWakeReplies(); return; }
  if (wakeReplies.length || wakeRepliesTask || Date.now() < wakeRepliesRetryAt) return;
  const current = new AbortController(); wakeRepliesController = current;
  const task = (async () => {
    try {
      const result = await api('/api/assistant/wake-replies', {}, current.signal);
      if (current.signal.aborted || wakeRepliesController !== current || key !== wakeRepliesIdentity()) return;
      wakeReplies = Array.isArray(result.replies) ? [...new Set(result.replies.filter(text => typeof text === 'string' && text.trim() && [...text].length <= 20))] : [];
      if (!wakeReplies.length) wakeRepliesRetryAt = Date.now() + 60000;
    } catch { if (wakeRepliesController === current) wakeRepliesRetryAt = Date.now() + 60000; }
    finally { if (wakeRepliesTask === task) wakeRepliesTask = null; }
  })();
  wakeRepliesTask = task;
}
function nextWakeReply() {
  const pool = wakeRepliesKey === wakeRepliesIdentity() ? wakeReplies : [];
  const choices = pool.filter(text => text !== lastWakeReply);
  const reply = choices.length ? choices[Math.floor(Math.random() * choices.length)] : pool[0] || '我在，你说。';
  lastWakeReply = reply; return reply;
}
const wake = createWakeListener({
  call:(action,options)=>call('voice',{action,...options}),
  getPhrases:()=>({name:config.name,phrases:wakeSettings.wakePhrases||[]}),
  onState:listening=>{wakeListening=listening;$('companion').dataset.wake=String(listening);if(!voice.active&&!remoteActive)paintState();},
  onError:error=>{wakeRetryAt=Date.now()+(/正在|占用|已停止/.test(error.message)?4000:60000);if(error.name==='NotAllowedError')notice('语音唤醒','请在系统中允许麦克风权限，或在语音设置关闭唤醒');},
  onWake:async({remainder})=>{
    if(!account||!settings.enabled||!wakeSettings.enabled||!wakeSettings.wakeEnabled||remoteActive||voice.active)return;
    hideNotice();
    const wakeReply = nextWakeReply(); showReply(wakeReply, true);
    try{await voice.start({initialText:remainder,wakeReply});}catch(error){showReply('');notice('语音提示',error.message);}
  },
});
async function stop(){wakeHoldUntil=Date.now()+1200;requestController?.abort();await wake.stop();await voice.stop();remoteActive=false;remoteSource=undefined;paintState();}
async function syncWake(){
  const permitted=account&&settings.enabled&&wakeSettings.enabled&&wakeSettings.wakeEnabled&&config.hasApiKey&&config.model&&!voice.active&&!remoteActive&&Date.now()>=wakeHoldUntil;
  if(!permitted){if(wake.active)await wake.stop();return;}
  if(!wake.active&&Date.now()>=wakeRetryAt)await wake.start();
}
async function prepareVoice() {
  if (!account || !settings.enabled || voice.active || remoteActive || wake.active || preparationTask || Date.now() < preparationRetryAt) return;
  const epoch = generation, task = call('voice', { action:'prepare' });
  preparationTask = task;
  if (preparationState !== 'ready') { preparationState = 'loading'; paintState(); }
  try {
    const result = await task;
    if (epoch !== generation || !settings.enabled) return;
    preparationState = result?.prepared ? 'ready' : result?.reason === 'disabled' ? 'disabled' : 'idle';
  } catch {
    if (epoch !== generation || !settings.enabled) return;
    preparationState = 'error'; preparationRetryAt = Date.now() + 60000;
  } finally {
    if (preparationTask === task) preparationTask = null;
    if (epoch === generation && !voice.active && !remoteActive) paintState();
  }
}
async function toggleVoice(){
  hideNotice();
  await resetTask;
  if(!account){await call('open',{page:'assistant'});return;}
  if(voice.active){await stop();return;}
  try{await wake.stop();const result=await call('toggleVoice');if(!result?.forwarded)await voice.start();}catch(error){notice('语音提示',error.message);}
}
function reset(){generation++;chatHistory.close();clearWakeReplies();wakeSettings={};wakeRetryAt=0;account='';document.documentElement.dataset.account='';messages=[];config={};presence={};balanceReminderCount=0;balanceSampleAt=0;preparationTask=null;preparationRetryAt=0;preparationState='idle';clearTimeout(replyTimer);requestController?.abort();resetTask=resetTask.catch(()=>{}).then(async()=>{try{await stop();}finally{await call('release');}});void resetTask.catch(()=>{});hideNotice(true);$('notice-title').textContent='';$('notice-text').textContent='';showReply('');void closeImage();$('menu').hidden=true;return resetTask;}
async function poll(){
  if(pollBusy)return;pollBusy=true;
  try{
    const session = await api('/api/auth/session');
    if(!session.user){if(account)reset();paintState();return;}
    if(account!==session.user.username){await reset();account=session.user.username;await chatHistory.open(account);messages=chatHistory.read().messages;document.documentElement.dataset.account=account;}
    const epoch=generation;
    const [preferences,assistant,presenceSettings,wakeOptions]=await Promise.all([call('settings'),api('/api/assistant/settings'),api('/api/assistant/presence'),call('voice',{action:'wakeSettings'})]);
    if(epoch!==generation)return;applySettings(preferences);config=assistant;presence=presenceSettings;voice.setOutputDevice(presence.outputId||'');$('name').textContent=config.name||'小鲸鱼';
    wakeSettings=wakeOptions||{};
    prepareWakeReplies();
    if(!voice.active&&!remoteActive)paintState();
    void prepareVoice().then(()=>{if(epoch===generation)return syncWake();}).catch(()=>{});
    if(settings.enabled&&settings.reminders&&settings.balance&&Date.now()-balanceSampleAt>=60000){balanceSampleAt=Date.now();void api('/api/assistant/balance').catch(()=>{});}
    void reminderTick().catch(()=>{});
  }catch{if(account)notice('连接提示','暂时无法连接 ATB');}
  finally{pollBusy=false;}
}
bridge?.onEvent(event=>{
  if(event.type==='suspend-wake'){wakeHoldUntil=Date.now()+1500;void wake.stop();return;}
  if(event.type==='dismiss-menu'){closeMenu();return;}
  if(event.type==='layout'){applyLayout(event.layout);return;}
  if(event.type==='settings'){applySettings(event.settings);return;}
  if(event.type==='stop'){void stop();return;}
  if(event.type==='reset'){if(!event.account||event.account===account)reset();return;}
  if(!account||event.account!==account)return;
  // Local capture owns the pose until it stops. A different renderer releasing
  // its idle controller must not overwrite this renderer or another live owner.
  if(voice.active&&['state','level','delta','reply','proactive'].includes(event.type))return;
  if(event.type==='state'){
    if(!event.active&&remoteActive&&event.source!==undefined&&remoteSource!==undefined&&event.source!==remoteSource)return;
    remoteActive=event.active;remoteSource=event.active?event.source:undefined;
    if(remoteActive){wakeHoldUntil=Date.now()+1500;void wake.stop();}else wakeHoldUntil=Date.now()+1200;paintState(event);
  }
  if(event.type==='level')$('companion').style.setProperty('--level',String(event.level));
  if(event.type==='delta')showReply(event.text);
  if(event.type==='proactive'){replyDismissed=false;replyFinished=true;renderToolSources($('reply-sources'),[]);showReply(event.text,true);}
  if(event.type==='reply')showReply(event.text,true);
});
let down,dragged=false,hit;
$('avatar').addEventListener('pointerdown',event=>{if(event.button!==0)return;down={x:event.screenX,y:event.screenY};dragged=false;$('avatar').setPointerCapture(event.pointerId);void call('dragStart');});
$('avatar').addEventListener('pointermove',event=>{if(!down)return;if(Math.hypot(event.screenX-down.x,event.screenY-down.y)>5)dragged=true;if(dragged)void call('drag');});
const endDrag=()=>{if(down){down=null;void call('dragEnd');}};
$('avatar').addEventListener('pointerup',endDrag);$('avatar').addEventListener('pointercancel',endDrag);
$('avatar').addEventListener('click',()=>{if(!dragged)void toggleVoice();dragged=false;});
function updateHit(target){const active=Boolean(down||$('image-viewer').open||!$('menu').hidden||target?.closest('#avatar,#speech'));if(active!==hit){hit=active;void call('hit',{active});}}
function closeMenu(target){if($('menu').hidden)return;$('menu').hidden=true;updateHit(target);}
function openMenu(x=$('avatar').offsetLeft+140,y=$('avatar').offsetTop+15){const menu=$('menu');menu.hidden=false;place(menu,bounded({x,y},menu));menu.querySelector('button').focus({preventScroll:true});updateHit(menu);}
$('avatar').addEventListener('contextmenu',event=>{event.preventDefault();openMenu(event.clientX,event.clientY);});
window.addEventListener('blur',()=>closeMenu());
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#menu'))closeMenu(event.target);});
$('menu').addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;closeMenu(event.target);try{if(button.dataset.page)await call('open',{page:button.dataset.page});else if(button.dataset.reminder)await reminder(button.dataset.reminder,true);else if(button.dataset.action==='voice')await toggleVoice();else if(button.dataset.action==='text')applySettings(await call('update',{showText:!settings.showText}));else if(button.dataset.action==='hide')applySettings(await call('update',{enabled:false}));else if(button.dataset.action==='quit')await call('quit');}catch{notice('操作未完成','稍后再试一下吧');}});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu(document.querySelector('#avatar:hover,#speech:hover'));if($('menu').hidden||!event.target.closest('#menu'))return;const buttons=[...$('menu').querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}});
document.addEventListener('pointermove',event=>updateHit(event.target));
document.addEventListener('mouseleave',()=>{if(!down&&!$('image-viewer').open&&$('menu').hidden){hit=false;void call('hit',{active:false});}});
window.addEventListener('pagehide',()=>{clearWakeReplies();requestController?.abort();void wake.stop();void voice.stop();clearInterval(pollTimer);hideNotice(true);cancelReplyExpiry();});
const pollTimer=setInterval(()=>void poll(),3000);void call('layout')?.then(applyLayout).catch(()=>{});reflow();void poll();
