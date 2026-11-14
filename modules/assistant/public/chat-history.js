// Recent visible conversation, separate from the agent's long-term memory.
// All ATB renderers share the default Electron session and local origin.
export function createChatHistory({onChange = () => {}, host = globalThis.window} = {}) {
  let account = '', session = 0, cached, observedGeneration;
  const key = () => 'atb.assistant.chat.v1.' + encodeURIComponent(account);
  const legacyKey = () => 'homebase.chat.' + account;
  const empty = () => ({version:1,generation:crypto.randomUUID(),clearedAt:0,messages:[]});
  function read() {
    if (!account) return {messages:[],generation:null,clearedAt:0};
    try {
      const value = JSON.parse(host.localStorage.getItem(key()));
      if (value?.version === 1 && typeof value.generation === 'string' && Array.isArray(value.messages)) cached = value;
    } catch { /* Keep this window usable when browser storage is unavailable. */ }
    return cached || {messages:[],generation:null,clearedAt:0};
  }
  function mirror(value) {
    try { host.sessionStorage.setItem(legacyKey(), JSON.stringify(value.messages.map(({id,createdAt,...message}) => message))); } catch {}
  }
  function changed() {
    if (!account) return;
    const value = read(), cleared = observedGeneration !== undefined && value.generation !== observedGeneration;
    observedGeneration = value.generation; mirror(value); onChange(value.messages, {cleared});
  }
  const storage = event => { if (account && (event.key === key() || event.key === null)) changed(); };
  const local = event => { if (account && event.detail === key()) changed(); };
  host?.addEventListener('storage', storage); host?.addEventListener('atb-chat-history', local);
  function write(value) {
    cached = value;
    try { host.localStorage.setItem(key(),JSON.stringify(value)); } catch {}
    mirror(value); host?.dispatchEvent(new CustomEvent('atb-chat-history',{detail:key()}));
    return value;
  }
  async function locked(operation, expectedSession = session) {
    const name = key(), run = () => expectedSession === session && account ? operation() : undefined;
    // The lock serializes read/merge/write across main, companion and presence
    // processes; storage events alone cannot prevent concurrent lost updates.
    return host?.navigator?.locks ? host.navigator.locks.request(name,run) : run();
  }
  function normalize(message) {
    if (!message || !['user','assistant'].includes(message.role) || typeof message.content !== 'string' || message.status === 'pending') return null;
    return {id:message.id || crypto.randomUUID(),createdAt:message.createdAt || Date.now(),role:message.role,content:message.content.slice(0,16000),
      ...(message.status ? {status:message.status} : {}),...(Array.isArray(message.toolsUsed) ? {toolsUsed:message.toolsUsed.slice(0,12)} : {})};
  }
  return {
    get account() { return account; },
    read,
    async open(owner) {
      if (owner === account) return read();
      account = owner || ''; session++; cached = undefined; observedGeneration = undefined;
      if (!account) return read();
      return locked(() => {
        let value = read();
        const fresh = !value.generation;
        if (fresh) value = empty();
        let migrated = false;
        try {
          const marker = legacyKey()+'.migrated';
          if (!host.sessionStorage.getItem(marker) && !value.clearedAt) {
            const legacy = JSON.parse(host.sessionStorage.getItem(legacyKey()) || '[]');
            if (Array.isArray(legacy) && legacy.length) {
              const merged = new Map();
              for (const old of legacy.slice(-40)) {
                const message = normalize({...old,...(old?.status==='pending'?{status:'failed'}:{})});
                if (message) merged.set(message.id,message);
              }
              for (const message of value.messages) merged.set(message.id,message);
              value.messages=[...merged.values()].slice(-40);migrated=true;
            }
          }
          host.sessionStorage.setItem(marker,'1');
        } catch {}
        if (fresh || migrated) write(value);
        observedGeneration = value.generation; mirror(value); return value;
      });
    },
    async save(messages, generation = read().generation, valid = () => true) {
      const additions = messages.map(normalize).filter(Boolean);
      return locked(() => {
        const value = read();
        if (!value.generation || value.generation !== generation || !valid()) return false;
        const merged = new Map(value.messages.map(message=>[message.id,message]));
        for (const message of additions) {
          if (message.createdAt < value.clearedAt) continue;
          merged.set(message.id,message);
        }
        value.messages = [...merged.values()].slice(-40);
        write(value); return true;
      });
    },
    async clear() { return locked(() => write({...empty(),clearedAt:Date.now()})); },
    close() { account='';session++;cached=undefined;observedGeneration=undefined; },
    dispose() { this.close();host?.removeEventListener('storage',storage);host?.removeEventListener('atb-chat-history',local); },
  };
}
