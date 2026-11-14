import { conversationContext } from './assistant-context.js';
import { presenceGreeting, presenceVoiceIntent } from './presence-state.js';
export async function handlePresenceUtterance({ text, request, stop, signal }) {
  const intent = presenceVoiceIntent(text);
  if (intent?.snoozeMinutes) {
    try { await request('/api/assistant/presence', { action: 'snooze', minutes: intent.snoozeMinutes }, signal); }
    finally { await stop(); }
    return true;
  }
  if (intent?.feedback) await request('/api/assistant/presence', { action: 'feedback', state: intent.feedback }, signal);
  await request('/api/assistant/presence', { action: 'interaction' }, signal); return false;
}
export function createPresenceOpenings({ request, voice, valid, onEvent = () => {}, onClaim = () => {}, remember = () => {}, now = Date.now }) {
  let job;
  return {
    get active() { return Boolean(job); },
    async cancel() { if (job) job.abort(); job = null; await voice.stop(); },
    async start(kind, settings) {
      if (job || !valid()) return false;
      const controller = new AbortController(); job = controller;
      const current = () => job === controller && !controller.signal.aborted && valid();
      try {
        const claim = await request('/api/assistant/presence', { action: 'claim', kind, revision: settings.revision, ...(settings.personId ? { personId: settings.personId } : {}) }, controller.signal);
        if (!claim.claimed || !current()) return false;
        onClaim(claim);
        onEvent('greeting', `${settings.name || '本人'}${kind === 'arrival' ? '到场，开始问候' : '仍在场，主动开场'}`);
        let text = presenceGreeting(settings, now(), kind);
        if (settings.aiOpening) {
          try {
            const result = await request('/api/assistant/chat', { opening: { revision: settings.revision, claimId: claim.claimId } }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
            if (typeof result.reply !== 'string' || !result.reply.trim()) throw Error('模型没有返回开场'); text = result.reply.trim().slice(0, 240);
          } catch (error) { if (!current()) return false; onEvent('greeting', 'AI开场未完成，使用本地问候'); }
        }
        if (!current()) { onEvent('running', '画面或互动条件已变化，取消开场'); return false; }
        const completed = await voice.read(text);
        if (!completed) { if (job === controller) onEvent('running', '开场播放已停止'); return false; }
        if (job !== controller || controller.signal.aborted) return false;
        onEvent('running', kind === 'arrival' ? '问候播放完成' : '主动开场播放完成');
        if (!current()) return false;
        remember(text);
        if (settings.followUp && current()) await voice.start();
        return true;
      } catch (error) { if (job === controller && !controller.signal.aborted) onEvent('error', '开场未完成：' + error.message); return false; }
      finally { if (job === controller) job = null; }
    },
  };
}
export function createPresenceConversation({ request, history: sharedHistory }) {
  let messages = [], generation = 0;
  return {
    reset() { generation++; messages = []; },
    remember(text) { messages.push({ role: 'assistant', content: text }); messages = messages.slice(-6); },
    async send(text, { signal, onDelta } = {}) {
      const epoch = generation;
      const historyGeneration = sharedHistory?.read().generation, turnId = crypto.randomUUID();
      if (sharedHistory) messages = sharedHistory.read().messages;
      const history = conversationContext([...messages, { role: 'user', content: text }], 16000, 3);
      let result;
      try { result = await request('/api/assistant/chat', { messages: history, turnId }, signal); }
      catch(error) {
        if(sharedHistory&&epoch===generation&&!signal?.aborted&&error.name!=='AbortError')await sharedHistory.save([{id:turnId+':user',role:'user',content:text,status:'failed'},{id:turnId+':assistant',role:'assistant',content:'本次未完成：'+error.message,status:'failed'}],historyGeneration,()=>epoch===generation&&!signal?.aborted).catch(()=>{});
        throw error;
      }
      signal?.throwIfAborted();
      if (epoch !== generation) throw new DOMException('语音对话已停止', 'AbortError');
      if (sharedHistory) {
        const saved = await sharedHistory.save([{id:turnId+':user',role:'user',content:text},{id:turnId+':assistant',role:'assistant',content:result.reply,toolsUsed:result.toolsUsed}],historyGeneration,()=>epoch===generation&&!signal?.aborted);
        signal?.throwIfAborted();
        if (!saved || epoch !== generation) throw new DOMException('语音对话已停止', 'AbortError');
      }
      messages = [...history, { role: 'assistant', content: result.reply }].slice(-6);
      onDelta?.(result.reply); return result.reply;
    },
  };
}
