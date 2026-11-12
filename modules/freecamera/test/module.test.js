import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import createModule from '../server/index.js';
import { createDesktopModule } from '../desktop/index.cjs';

async function fixture(t, config = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'atb-camera-module-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const detector = new EventEmitter();
  detector.state = { status: 'off', pid: null, backend: 'CPU' };
  detector.disable = async () => {};
  detector.detect = async () => [];
  detector.enable = async () => detector.state;
  const context = { dataDir, config: { lanIp: '127.0.0.1', httpsPort: 0, httpPort: 8080, relayPort: 0, detector, ...config } };
  return { context, dataDir };
}

test('camera factory does not attach network listeners until attach, and close removes all upgrade listeners', async t => {
  const { context } = await fixture(t);
  const camera = await createModule(context);
  const server = http.createServer();
  t.after(() => camera.close());
  assert.equal(camera.relay, undefined);
  assert.equal(server.listenerCount('upgrade'), 0);
  await camera.attach(server);
  assert.equal(server.listenerCount('upgrade'), 1);
  assert.ok(camera.relay.port > 0);
  await camera.close(); await camera.close();
  assert.equal(server.listenerCount('upgrade'), 0);
});

test('a failed STUN attachment releases the already opened relay and signaling', async t => {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
  t.after(() => socket.close());
  const { context } = await fixture(t, { httpsPort: socket.address().port });
  const camera = await createModule(context);
  const server = http.createServer();
  await assert.rejects(camera.attach(server), /EADDRINUSE/);
  assert.equal(server.listenerCount('upgrade'), 0);
  await camera.close();
});

test('camera aliases preserve role URLs and apply setup template with request-specific address', async t => {
  const { context } = await fixture(t);
  const camera = await createModule(context);
  t.after(() => camera.close());
  const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } });
  const res = response();
  assert.equal(await camera.handle({ method: 'GET', url: '/?mode=camera' }, res, '/', { secure: true }), true);
  assert.match(res.body, /id="camera-controls"/);
  assert.equal(await camera.handle({ method: 'GET', url: '/' }, response(), '/', { secure: true }), false);
  const setup = response();
  await camera.handle({ method: 'GET', url: '/' }, setup, '/', { secure: false, cameraUrl: 'https://100.64.0.1:8443/?mode=camera', setupUrl: 'http://100.64.0.1:8080' });
  assert.match(setup.body, /https:\/\/100\.64\.0\.1:8443\/\?mode=camera/);
  assert.doesNotMatch(setup.body, /\{\{/);
});

test('camera validates public-only relay requirements before attaching network resources', async t => {
  const { context } = await fixture(t);
  await assert.rejects(createModule({ ...context, config: { ...context.config, publicOrigin: 'https://example.com', relayPublicPort: 1234 } }), /PUBLIC_ORIGIN/);
  await assert.rejects(createModule({ ...context, config: { ...context.config, publicOrigin: 'https://203.0.113.1' } }), /TURN_PUBLIC_PORT/);
});

test('desktop module flushes recording on suspend, permits later recording, and rejects a stale save dialog', async t => {
  const { dataDir } = await fixture(t);
  const owner = 17, window = () => ({ isDestroyed: () => false, webContents: { id: owner } });
  let filePath = path.join(dataDir, 'first.webm'), pending;
  const camera = createDesktopModule({ app: { getPath: () => dataDir }, window, chooseFile: async () => pending ? pending : { canceled: false, filePath } });
  t.after(() => camera.close());
  const first = await camera.handlers['recording-begin'](owner, { mimeType: 'video/webm' });
  await camera.handlers['recording-write'](owner, { id: first.id, data: new Uint8Array([1, 2, 3]) });
  await camera.suspend(owner);
  assert.deepEqual([...await readFile(filePath)], [1, 2, 3]);
  filePath = path.join(dataDir, 'second.webm');
  const second = await camera.handlers['recording-begin'](owner, { mimeType: 'video/webm' });
  await camera.handlers['recording-end'](owner, { id: second.id });
  let resolve;
  pending = new Promise(r => { resolve = r; });
  const late = camera.handlers['recording-begin'](owner, { mimeType: 'video/webm' });
  await camera.suspend(owner);
  resolve({ canceled: false, filePath: path.join(dataDir, 'late.webm') });
  assert.deepEqual(await late, { canceled: true });
  await camera.close(); await camera.close();
});
