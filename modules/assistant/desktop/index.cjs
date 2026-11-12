const path = require('node:path');

function createDesktopModule({ dataRoot }) {
  let runtime, closing = false;
  const generations = new Map();
  const voiceRuntime = async () => {
    if (closing) throw Error('语音模块已关闭');
    runtime ??= import('../server/voice-runtime.js').then(({ getVoiceRuntime }) => getVoiceRuntime(path.join(dataRoot, 'data', 'assistant')));
    return runtime;
  };
  const ownerKey = owner => 'desktop:' + owner;
  return {
    handlers: {
      async voice(owner, { action, ...options } = {}) {
        const generation = generations.get(owner) || 0;
        const voice = await voiceRuntime(), key = ownerKey(owner);
        if (closing || generation !== (generations.get(owner) || 0)) throw Error('语音操作已停止或模块已关闭');
        if (action === 'status') return voice.status();
        if (action === 'settings') return voice.configure(options);
        if (action === 'open') return voice.open(key, options);
        if (action === 'close') { await voice.close(key, options.leaseId); return { ok: true }; }
        if (['heartbeat', 'transcribe', 'speak'].includes(action)) return voice[action](key, options);
        throw Error('语音操作无效');
      },
    },
    async suspend(owner) { generations.set(owner, (generations.get(owner) || 0) + 1); if (runtime) await (await runtime).close(ownerKey(owner)); },
    async close() { closing = true; if (runtime) await (await runtime).dispose(); },
  };
}
module.exports = { createDesktopModule };
