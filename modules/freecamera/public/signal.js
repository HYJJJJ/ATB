// Application heartbeats also detect half-open browser sockets after Wi-Fi/VPN changes.
export function connectSignal({ onOpen, onMessage, onClose, onError }) {
  let ws;
  const octets = location.hostname.split('.').map(Number);
  const timeout = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ? 20000 : 9000;
  let ended = false, lastReply = Date.now(), timer;
  const closeSocket = (...args) => { try { ws?.close(...args); } catch {} };
  const cleanup = () => { clearInterval(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  const channel = {
    get readyState() { return ended ? WebSocket.CLOSED : ws?.readyState ?? WebSocket.CONNECTING; },
    get bufferedAmount() { return ws?.bufferedAmount ?? 0; },
    send(data) {
      if (!ended && ws?.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch { lost({ code: 4000, reason: 'Send failed' }); }
      }
    },
    close() { if (ended) return; ended = true; cleanup(); closeSocket(); },
  };
  function lost(event = { code: 4000, reason: 'Heartbeat timeout' }) {
    if (ended) return; ended = true; cleanup();
    if (ws?.readyState === WebSocket.OPEN) closeSocket(event.code === 4000 ? 4000 : 1000, event.code === 4000 ? event.reason : ''); else closeSocket();
    onClose?.(channel, event);
  }
  function check() {
    if (ended) return;
    if (Date.now() - lastReply > timeout) { lost(); return; }
    if (ws.readyState === WebSocket.OPEN) channel.send(JSON.stringify({ type: 'ping' }));
  }
  function wake() { if (!ended && document.visibilityState === 'visible') { lastReply = Date.now(); check(); } }
  try { ws = new WebSocket(`wss://${location.host}/signal`); }
  catch {
    // Let the caller store this channel before delivering the failure to its retry loop.
    queueMicrotask(() => { if (!ended) { onError?.(channel); lost({ code: 4000, reason: 'Connection failed' }); } });
    return channel;
  }
  ws.onopen = () => { if (!ended) { lastReply = Date.now(); onOpen?.(channel); } };
  ws.onmessage = event => { if (!ended) { lastReply = Date.now(); onMessage?.(channel, event); } };
  ws.onclose = event => lost(event);
  ws.onerror = event => { if (!ended) onError?.(channel, event); };
  timer = setInterval(check, 3000);
  window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
  return channel;
}
