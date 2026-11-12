import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('signaling tolerates a slow Tailscale reply and grants a fresh heartbeat after foreground resume', async t => {
  const keys = ['WebSocket', 'window', 'document', 'location', 'setInterval', 'clearInterval'];
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])), now = Date.now;
  let time = 0, tick, closed = 0, latest;
  t.after(() => { Date.now = now; for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  Date.now = () => time;
  class Socket {
    static OPEN = 1; static CLOSED = 3;
    constructor() { latest = this; this.readyState = 1; this.sent = []; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  Object.assign(globalThis, { WebSocket: Socket, window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), location: { host: '100.64.0.10:8443', hostname: '100.64.0.10' }, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {} });
  const source = await readFile(new URL('../public/signal.js', import.meta.url), 'utf8');
  const { connectSignal } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const channel = connectSignal({ onClose: () => { closed++; } }); latest.onopen();
  for (time = 3000; time <= 12000; time += 3000) tick();
  assert.equal(closed, 0, 'a 12-second Tailscale delay must not close a live signaling socket');
  latest.onmessage({ data: '{"type":"pong"}' });
  time = 60000; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(closed, 0, 'returning from suspended Safari must probe before declaring the service lost');
  time = 81000; tick(); assert.equal(closed, 1, 'an unanswered fresh heartbeat must still detect a real loss');
  assert.equal(channel.readyState, Socket.CLOSED);
});

async function unavailableTransport(t, failAt) {
  const keys = ['WebSocket', 'window', 'document', 'location', 'setInterval', 'clearInterval'];
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])), now = Date.now;
  let time = 0, tick, latest, closed = 0;
  t.after(() => { Date.now = now; for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  Date.now = () => time;
  class Socket {
    static OPEN = 1; static CLOSED = 3;
    constructor() { if (failAt === 'constructor') throw new DOMException('Network unavailable', 'SecurityError'); latest = this; this.readyState = failAt === 'send' ? 1 : 0; }
    send() { if (failAt === 'send') throw new DOMException('Transport is no longer available', 'InvalidStateError'); }
    close() { throw new DOMException('Transport is no longer available', 'InvalidStateError'); }
  }
  Object.assign(globalThis, { WebSocket: Socket, window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), location: { host: '192.168.1.2:8443', hostname: '192.168.1.2' }, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {} });
  const source = await readFile(new URL('../public/signal.js', import.meta.url), 'utf8');
  const { connectSignal } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const channel = connectSignal({ onClose: () => { closed++; } });
  if (failAt === 'send') channel.send('{"type":"create"}');
  else if (failAt !== 'constructor') { time = 12000; tick(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1, 'transport failure must notify the caller so its retry loop can continue');
  assert.equal(channel.readyState, Socket.CLOSED);
  latest?.onclose?.({ code: 1006 });
  assert.equal(closed, 1, 'late transport events must not schedule duplicate retries');
}

test('a failed WebSocket close cannot prevent reconnection after a stalled handshake', t => unavailableTransport(t, 'close'));
test('a synchronous WebSocket construction failure is retried through the normal close callback', t => unavailableTransport(t, 'constructor'));
test('a failed send cannot strand camera registration on an unusable transport', t => unavailableTransport(t, 'send'));
