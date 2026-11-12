import { cameraDesktop } from './desktop-bridge.js';
import { connectSignal } from './signal.js';

export function createComputeProvider(native = cameraDesktop) {
  let wanted = false, generation = 0, socket = null, retry = null, lease = null;
  let controlId = null;
  async function release(id) { if (id) await native.closeCompute({ leaseId: id }).catch(() => {}); }
  async function connect() {
    if (!wanted || !native?.openCompute) return;
    const version = ++generation;
    const info = await native.openCompute().catch(() => null);
    if (version !== generation || !wanted) { await release(info?.leaseId); return; }
    if (!info?.available) { retry = setTimeout(() => void connect(), 5000); return; }
    lease = info.leaseId;
    const current = connectSignal({
      onOpen(ws) { ws.send(JSON.stringify({ type: 'detection-provider-register', name: '本机检测端' })); },
      onMessage(ws, event) {
        if (socket !== ws || version !== generation) return;
        const m = JSON.parse(event.data);
        if (m.type === 'pong' || m.type === 'detection-provider-ready') {
          const control = controlId;
          void native.computeHeartbeat({ leaseId: info.leaseId }).then(state => {
            if (socket === ws && version === generation && control && control === controlId && state.status === 'error') ws.send(JSON.stringify({ type: 'detection-provider-fault', controlId: control }));
          }).catch(() => void reconnect(ws, version));
          return;
        }
        if (m.type === 'error') { void reconnect(ws, version, m.code === 'login-required' ? 5000 : 2000); return; }
        if (m.type !== 'detection-command') return;
        if (m.action === 'enable' || m.action === 'disable') controlId = m.id;
        void (async () => {
          let response;
          try {
            if (m.action === 'detect') response = await native.detectFrame({ leaseId: info.leaseId, jpeg: m.jpeg });
            else if (['enable', 'disable'].includes(m.action)) response = { state: await native.configureDetection({ leaseId: info.leaseId, enabled: m.action === 'enable' }) };
            else return;
          } catch { response = { error: '本机检测执行失败', state: { status: 'error', pid: null } }; }
          if (socket === ws && version === generation) ws.send(JSON.stringify({ type: 'detection-response', id: m.id, ...response }));
        })();
      },
      onClose(ws) { void reconnect(ws, version); },
    });
    socket = current;
  }
  async function reconnect(ws, version, delay = 1500) {
    if (socket !== ws || version !== generation) return;
    generation++; socket = null; ws.close();
    const old = lease; lease = null; await release(old);
    if (wanted && version + 1 === generation) retry = setTimeout(() => void connect(), delay);
  }
  return {
    start() { if (wanted || !native?.openCompute) return; wanted = true; void connect(); },
    async stop() {
      wanted = false; generation++; clearTimeout(retry);
      const old = socket; socket = null; old?.close(); const id = lease; lease = null; await release(id);
    },
  };
}
