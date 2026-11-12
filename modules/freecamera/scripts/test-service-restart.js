import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loginViewer } from './account-test-helper.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-service-restart-'));
const output = path.join(root, 'test-results', 'service-restart');
await mkdir(output, { recursive: true });
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const httpsPort = await port(), httpPort = await port(), origin = `https://127.0.0.1:${httpsPort}`;
const options = { relayPort: 0, lanIp: '127.0.0.1', httpsPort, httpPort, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') };
let child, browser, step = 'startup', serverOutput = '';
const pages = [];
async function start() {
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { startServers } = await import(process.env.RESTART_SERVER_MODULE);
    await startServers(JSON.parse(process.env.RESTART_SERVER_OPTIONS));
    process.send('ready');
  `], { cwd: root, env: { ...process.env, RESTART_SERVER_MODULE: pathToFileURL(path.join(process.env.FREECAMERA_SERVICE_ROOT || root, 'server', 'index.js')).href, RESTART_SERVER_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', chunk => { serverOutput += chunk; }); child.stderr.on('data', chunk => { serverOutput += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(Error('Service startup timeout')); }, 15000);
    const ready = message => { if (message === 'ready') { clean(); resolve(); } };
    const exited = code => { clean(); reject(Error(`Service exited: ${code}\n${serverOutput.slice(-2000)}`)); };
    function clean() { clearTimeout(timer); child.off('message', ready); child.off('exit', exited); child.off('error', exited); }
    child.on('message', ready); child.once('exit', exited); child.once('error', exited);
  });
}
async function powerOff() { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = null; }
try {
  await start();
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    window.testBoot = crypto.randomUUID(); window.testSockets = []; window.testPeers = []; window.testDropRegistration = false; window.testRegistrations = 0;
    const Socket = WebSocket, Peer = RTCPeerConnection;
    window.WebSocket = class extends Socket {
      constructor(...args) { super(...args); window.testSockets.push(this); }
      send(data) {
        if (JSON.parse(data).type === 'create') {
          window.testRegistrations++;
          // A transport can answer heartbeats while camera registration has not completed.
          if (window.testDropRegistration) return;
        }
        return super.send(data);
      }
    };
    window.RTCPeerConnection = class extends Peer { constructor(configuration) { super({ ...configuration, iceTransportPolicy: 'relay' }); window.testPeers.push(this); } };
  });
  const camera = await context.newPage(), viewer = await context.newPage(), errors = [];
  pages.push(camera, viewer); for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  await camera.goto(`${origin}/?mode=camera`); await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  await viewer.goto(`${origin}/?mode=viewer`); await loginViewer(viewer); await viewer.locator('.device-connect').click();
  const live = () => viewer.waitForFunction(() => document.querySelector('#status').textContent === '实时画面', null, { timeout: 45000 }); await live();
  const cameraState = () => camera.evaluate(() => ({ boot: window.testBoot, identity: localStorage.getItem('freecamera.camera'), tracks: document.querySelector('video').srcObject.getTracks().map(t => ({ id: t.id, state: t.readyState })) }));
  const before = await cameraState(), viewerBoot = await viewer.evaluate(() => window.testBoot);
  const attempts = await camera.evaluate(() => window.testSockets.length);

  step = 'power off and repeated connection failures'; await powerOff();
  await camera.waitForFunction(count => window.testSockets.length >= count + 5, attempts, { timeout: 45000 });
  assert.deepEqual(await cameraState(), before, 'long service downtime must preserve capture and camera identity');

  step = 'service available but registration temporarily unanswered';
  await camera.evaluate(() => { window.testDropRegistration = true; });
  await start();
  await camera.waitForFunction(() => window.testSockets.at(-1)?.readyState === WebSocket.OPEN, null, { timeout: 18000 });
  const registrations = await camera.evaluate(() => window.testRegistrations);
  await camera.waitForTimeout(1500); await camera.evaluate(() => { window.testDropRegistration = false; });
  await live();
  assert.ok(await camera.evaluate(count => window.testRegistrations > count, registrations), 'an open socket answering heartbeats must not leave camera registration stuck');
  assert.deepEqual(await cameraState(), before, 'recovery must use the original page, camera identity and live audio/video tracks');
  assert.equal(await viewer.evaluate(() => window.testBoot), viewerBoot, 'watching must resume without reload or login');
  const time = await viewer.locator('video').evaluate(v => v.currentTime);
  await viewer.waitForFunction(previous => document.querySelector('video').currentTime > previous + 2, time);

  step = 'explicit stop remains stopped'; await camera.locator('#stop').click(); await viewer.locator('#disconnect').click();
  const stopped = await camera.evaluate(() => window.testSockets.length), peerCount = await viewer.evaluate(() => window.testPeers.length);
  await powerOff(); await start();
  for (const page of pages) await page.evaluate(async () => window.dispatchEvent(new Event('online')));
  await camera.waitForTimeout(3500);
  assert.equal(await camera.evaluate(() => window.testSockets.length), stopped);
  assert.equal(await viewer.evaluate(() => window.testPeers.length), peerCount);
  assert.equal(await camera.locator('video').evaluate(v => v.srcObject), null);
  assert.deepEqual(errors, []);
  await rm(path.join(output, 'failure.json'), { force: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks: ['abrupt process termination and at least five failed reconnect attempts', 'registration retry despite a healthy heartbeat', 'same camera page, device identity and live video/audio tracks', 'relay video recovers with fresh credentials without viewer reload or login', 'explicit camera stop and viewer disconnect remain stopped'] }, null, 2));
  console.log('PASS: prolonged service outage, camera registration recovery, same capture, relay video, explicit stop respected.');
} catch (error) {
  const snapshots = await Promise.all(pages.map(page => page.evaluate(async () => ({ status: document.querySelector('#status').textContent, error: document.querySelector('#error').textContent, registrations: window.testRegistrations, sockets: window.testSockets.map(s => s.readyState), tracks: document.querySelector('video').srcObject?.getTracks().map(t => ({ kind: t.kind, state: t.readyState })) })).catch(() => null)));
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ step, error: error.message, snapshots }, null, 2)); throw error;
} finally { await browser?.close(); await powerOff(); await writeFile(path.join(output, 'server.log'), serverOutput); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
