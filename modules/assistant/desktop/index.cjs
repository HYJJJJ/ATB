const path = require('node:path');

function createDesktopModule({ dataRoot, services, registerBackground, navigate, quit, commandAssistant, confirmDesktopAction }) {
  let runtime, closing = false;
  const actionsReady = !dataRoot || typeof navigate !== 'function' ? Promise.resolve(()=>{}) : import('../server/desktop-action-bridge.js').then(({registerDesktopActions}) => {
    if (closing || !dataRoot || typeof navigate !== 'function') return () => {};
    return registerDesktopActions(path.join(dataRoot,'data'),require('./agent-actions.cjs').createAgentActions({navigate,confirmDesktopAction}));
  });
  const generations = new Map();
  const foregroundVoice = new Map(), foregroundAttention = new Set(), wakeVoice = new Map();
  let lastForegroundInteraction = 0;
  const voiceRuntime = async () => {
    if (closing) throw Error('语音模块已关闭');
    runtime ??= import('../server/voice-runtime.js').then(({ getVoiceRuntime }) => getVoiceRuntime(path.join(dataRoot, 'data', 'assistant')));
    return runtime;
  };
  const ownerKey = owner => 'desktop:' + owner;
  let presence, companion, wakeRelease = Promise.resolve();
  function suspendWake() {
    const entries = [...wakeVoice]; wakeVoice.clear();
    if (!entries.length) return wakeRelease;
    companion?.event({ type:'suspend-wake' });
    wakeRelease = wakeRelease.catch(() => {}).then(async () => {
      if (runtime) { const voice = await runtime; for (const [owner, leaseId] of entries) await voice.close(ownerKey(owner), leaseId, { keepWarm:true }); }
    });
    return wakeRelease;
  }
  const companionHost = () => companion ??= require('./companion.cjs').createCompanionDesktop({ dataRoot, services, registerBackground, navigate, quit,
    voice: (id, value) => instance.handlers.voice(id, value), suspend: id => instance.suspend(id),
    isBusy: except => [...foregroundVoice.keys(), ...foregroundAttention].some(id => id !== except),
    toggleForeground: except => [...foregroundVoice.keys()].some(id => id !== except) ? commandAssistant?.({ action:'toggleVoice' }) === true : false,
  });
  const instance = {
    handlers: {
      async companion(owner, options) {
        if (!services) return { supported:false };
        return companionHost().invoke(owner, options);
      },
      async presence(owner, options) {
        if (!services) return { supported: false, state: 'off', text: '当前桌面宿主不支持后台识别' };
        if (options?.action === 'attention') {
          if (options.active === true) { const already = foregroundAttention.has(owner); foregroundAttention.add(owner); await suspendWake(); if (!already) await presence?.pause(); }
          else if (foregroundAttention.delete(owner)) lastForegroundInteraction = Date.now();
          return { ok: true };
        }
        presence ??= require('./presence.cjs').createPresenceDesktop({ services, registerBackground, interactionAt: () => lastForegroundInteraction, isBusy: () => foregroundVoice.size > 0 || foregroundAttention.size > 0, suspend: id => instance.suspend(id), voice: (id, value) => instance.handlers.voice(id, value), onCompanion:event => { if(companion)void companion.invoke(null,{action:'event',event}).catch(()=>{}); } });
        return presence.invoke(owner, options);
      },
      async voice(owner, { action, ...options } = {}) {
        const generation = generations.get(owner) || 0;
        const voice = await voiceRuntime(), key = ownerKey(owner);
        if (closing || generation !== (generations.get(owner) || 0)) throw Error('语音操作已停止或模块已关闭');
        if (action === 'status') return voice.status();
        if (action === 'wakeSettings') return voice.wakeSettings();
        if (action === 'settings') { const saved = await voice.configure(options); if (!saved.enabled || !saved.wakeEnabled) await suspendWake(); return saved; }
        if (action === 'catalog') return voice.catalog({ refresh: options.refresh === true, provider: options.provider });
        if (action === 'prepare') {
          if ([...foregroundVoice.keys(), ...foregroundAttention].some(id => id !== owner)) return { prepared:false, reason:'busy' };
          return voice.prepare(key);
        }
        if (action === 'open') {
          if (options.mode === 'wake') throw Error('请通过唤醒入口开启监听');
          if ([...foregroundVoice.keys()].some(id => id !== owner)) throw Error('另一个入口正在语音对话，请先结束当前对话');
          const foreground = !presence?.owns(owner);
          const attempt = Symbol();
          if (foreground) foregroundVoice.set(owner, attempt);
          try {
            await suspendWake();
            if (foreground) await presence?.pause();
            if (closing || generation !== (generations.get(owner) || 0)) throw Error('语音操作已停止或模块已关闭');
            const opened = await voice.open(key, options); if (foregroundVoice.get(owner) === attempt) foregroundVoice.set(owner, opened.leaseId); return opened;
          } catch (error) { if (foregroundVoice.get(owner) === attempt) foregroundVoice.delete(owner); throw error; }
        }
        if (action === 'wakeOpen') {
          await wakeRelease;
          if (closing || generation !== (generations.get(owner) || 0)) throw Error('唤醒监听已停止');
          if (foregroundVoice.size || foregroundAttention.size || wakeVoice.size) throw Error('其他入口正在使用语音或处理消息');
          if (typeof options.leaseId !== 'string') throw Error('唤醒连接标识无效');
          const token = options.leaseId; wakeVoice.set(owner, token);
          try {
            const opened = await voice.open(key, { leaseId:token, mode:'wake' });
            if (closing || generation !== (generations.get(owner) || 0) || wakeVoice.get(owner) !== token) { await voice.close(key, token, { keepWarm:true }); throw Error('唤醒监听已停止'); }
            return opened;
          } catch (error) { if (wakeVoice.get(owner) === token) wakeVoice.delete(owner); throw error; }
        }
        if (action === 'close') { try { await voice.close(key, options.leaseId, { keepWarm: options.keepWarm === true }); } finally { if (options.leaseId === undefined || wakeVoice.get(owner) === options.leaseId) wakeVoice.delete(owner); if (options.leaseId === undefined || foregroundVoice.get(owner) === options.leaseId) { if (foregroundVoice.delete(owner)) lastForegroundInteraction = Date.now(); } } return { ok: true }; }
        if (['heartbeat', 'transcribe', 'speak', 'ttsStart', 'ttsText', 'ttsFinish', 'ttsRead'].includes(action)) {
          try { return await voice[action](key, options); }
          catch (error) {
            // Expected cancellation crosses IPC as data. Throwing here makes
            // Electron log an exception even if the renderer already stopped.
            if (error.name === 'AbortError') return { cancelled:true };
            throw error;
          }
        }
        throw Error('语音操作无效');
      },
    },
    async suspend(owner) { wakeVoice.delete(owner); const usedVoice = foregroundVoice.delete(owner), usedAttention = foregroundAttention.delete(owner); if (usedVoice || usedAttention) lastForegroundInteraction = Date.now(); generations.set(owner, (generations.get(owner) || 0) + 1); if (runtime) await (await runtime).close(ownerKey(owner)); },
    async close() { closing = true; await (await actionsReady)(); try { await companion?.close(); } finally { try { await presence?.close(); } finally { if (runtime) await (await runtime).dispose(); } } },
  };
  return instance;
}
module.exports = { createDesktopModule };
