import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { _electron as electron, chromium } from 'playwright';
import { startServers } from '../../../server/index.js';
import { SESSION_COOKIE } from '../../../server/accounts.js';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '../../..');
const directory = await mkdtemp(path.join(tmpdir(), 'atb-presence-ui-')), evidence = path.join(root, 'test-results/presence');
await mkdir(evidence, { recursive: true });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const local = await startServers({ lanIp: '127.0.0.1', httpsPort: await freePort(), httpPort: await freePort(), relayPort: 0, publicOrigin: null, certDir: path.join(directory, 'certs'), dataDir: path.join(directory, 'data') });
const origin = `https://127.0.0.1:${local.secure.address().port}`;
const remote = process.env.PRESENCE_TEST_REMOTE === '1' ? await startServers({ lanIp: '127.0.0.2', httpsPort: await freePort(), httpPort: await freePort(), relayPort: 0, publicOrigin: null, certDir: path.join(directory, 'remote-certs'), dataDir: path.join(directory, 'remote-data') }) : null;
const cameraOrigin = remote ? `https://127.0.0.2:${remote.secure.address().port}` : origin;
let app, browser; const errors = [];
try {
  const sharp = require('sharp');
  let source;
  try { source = await readFile(path.join(evidence, 'public-fixture-0.jpg')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch('https://raw.githubusercontent.com/justadudewhohacks/face-api.js/0.22.2/examples/images/sheldon/sheldon1.png', { signal: AbortSignal.timeout(60000) });
    assert.equal(response.ok, true); const downloaded = Buffer.from(await response.arrayBuffer());
    source = await sharp(downloaded).resize(400, 400, { fit: 'contain' }).extend({ top: 120, bottom: 120, left: 120, right: 120, background: '#777777' }).jpeg().toBuffer();
  }
  const images = [source, await sharp(source).modulate({ brightness: 1.03 }).jpeg().toBuffer(), await sharp(source).modulate({ brightness: .97 }).jpeg().toBuffer()];
  const photos = [];
  for (let i = 0; i < images.length; i++) { const file = path.join(evidence, `public-fixture-${i}.jpg`); await writeFile(file, images[i]); photos.push(file); }
  let visitor;
  try { visitor = await readFile(path.join(evidence, 'public-visitor-0.jpg')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch('https://raw.githubusercontent.com/justadudewhohacks/face-api.js/0.22.2/examples/images/leonard/leonard1.png', { signal: AbortSignal.timeout(30000) });
    assert.equal(response.ok, true);
    visitor = await sharp(Buffer.from(await response.arrayBuffer())).resize(400, 400, { fit: 'contain' }).extend({ top: 120, bottom: 120, left: 120, right: 120, background: '#777777' }).jpeg().toBuffer();
  }
  const visitorImages = [visitor, await sharp(visitor).modulate({ brightness: 1.03 }).jpeg().toBuffer(), await sharp(visitor).modulate({ brightness: .97 }).jpeg().toBuffer()], visitorPhotos = [];
  for (let i = 0; i < visitorImages.length; i++) { const file = path.join(evidence, `public-visitor-${i}.jpg`); await writeFile(file, visitorImages[i]); visitorPhotos.push(file); }
  const assistant = path.join(directory, 'data/assistant'); await mkdir(assistant, { recursive: true });
  // Share only installed model/runtime binaries, never private settings or conversations.
  for (const name of ['models', 'voice-runtime', 'tts-runtime']) await symlink(path.join(root, 'data/assistant', name), path.join(assistant, name), 'junction');
  await writeFile(path.join(assistant, 'voice-settings.json'), JSON.stringify({ provider: 'chattts', voice: 'chattts:42', enabled: false }));
  await local.accounts.setup('presence-fixture', 'fixture-only-password');
  const session = await local.accounts.login('presence-fixture', 'fixture-only-password');
  let cameraSession = session;
  if (remote) {
    await remote.accounts.setup('camera-fixture', 'fixture-only-password'); cameraSession = await remote.accounts.login('camera-fixture', 'fixture-only-password');
    await writeFile(path.join(directory, 'data/desktop-connection.json'), JSON.stringify({ mode: 'remote', origin: cameraOrigin, ca: await readFile(path.join(directory, 'remote-certs/ca.crt'), 'utf8') }));
  }
  browser = await chromium.launch(); const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: SESSION_COOKIE, value: cameraSession.token, url: cameraOrigin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const camera = await context.newPage(); await camera.goto(cameraOrigin + '/modules/freecamera/');
  const deviceId = await camera.evaluate(async bytes => {
    const { CameraPeers } = await import('/camera-peer.js');
    let image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    window.setFixtureFace = async bytes => { const next = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })); image.close(); image = next; };
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 640;
    const draw = () => { const ctx = canvas.getContext('2d'); ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 640, 640); if (!window.hideTestFace) ctx.drawImage(image, 0, 0, 640, 640); };
    draw(); setInterval(draw, 100); const stream = canvas.captureStream(10);
    const ws = new WebSocket(`wss://${location.host}/signal`), send = value => ws.send(JSON.stringify(value));
    const peers = new CameraPeers({ send, diagnostic() {}, state() {} });
    return new Promise((resolve, reject) => {
      ws.onopen = () => send({ type: 'create', name: 'Public fixture camera' });
      ws.onmessage = async event => { const m = JSON.parse(event.data); if (m.type === 'created') resolve(m.deviceId); if (m.type === 'peer-ready') await peers.offer(m.peerId, stream); if (m.type === 'answer') await peers.answer(m.peerId, m.sdp); if (m.type === 'candidate') await peers.candidate(m.peerId, m.candidate); if (m.type === 'error') reject(Error(m.code)); };
      window.fixtureCameraSocket = ws;
    });
  }, [...source]);
  const env = { ...process.env, ATB_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(local.secure.address().port), HTTP_PORT: String(local.plain.address().port), TURN_PORT: '0' }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL('**/platform');
  await page.context().addCookies([{ name: SESSION_COOKIE, value: session.token, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  if (remote) await page.context().addCookies([{ name: SESSION_COOKIE, value: cameraSession.token, url: cameraOrigin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(origin + '/modules/assistant/#faces'); await page.locator('[data-name]').waitFor({ state: 'visible' });
  console.log('Presence fixture: assistant settings ready');
  await page.locator('[data-name]').fill('测试本人'); await page.locator('[data-self]').check(); await page.locator('[data-photos]').setInputFiles(photos); await page.locator('[data-enroll]').click();
  await page.waitForFunction(() => { const t = document.querySelector('[data-person-result]')?.textContent || ''; return t && !t.includes('正在本机'); }, null, { timeout: 90000 });
  if (!(await page.locator('[data-person-result]').textContent()).includes('人脸已保存')) console.log('Detection diagnostic', await page.evaluate(async bytes => {
    const { loadFaceModel } = await import('/modules/assistant/presence-face.js'); await loadFaceModel();
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)])); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image, 0, 0);
    const detections = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: .1 })); image.close(); return detections.map(d => ({ score: d.score, box: d.box }));
  }, [...source]));
  assert.match(await page.locator('[data-person-result]').textContent(), /人脸已保存/);
  console.log('Presence fixture: real enrollment complete');
  await page.locator('[data-person-new]').click(); await page.locator('[data-name]').fill('测试访客');
  await page.locator('[data-address]').fill('朋友'); await page.locator('[data-relationship]').fill('朋友');
  await page.locator('[data-person-greeting]').fill('朋友，欢迎来玩。'); await page.locator('[data-photos]').setInputFiles(visitorPhotos); await page.locator('[data-enroll]').click();
  await page.waitForFunction(() => document.querySelector('[data-person-result]')?.textContent.includes('人脸已保存'), null, { timeout: 90000 });
  assert.equal(await page.locator('[data-person-id]').count(), 2);
  await page.screenshot({ path: path.join(evidence, 'face-management.png') });
  await page.locator('[data-page=voice]').click(); await page.locator('[data-camera]').selectOption(deviceId); await page.locator('[data-enabled]').check(); await page.locator('[data-greeting]').fill('你好，欢迎回来。');
  await page.locator('[data-quiet]').uncheck(); await page.locator('[data-context]').uncheck(); await page.locator('[data-proactive]').check();
  await page.locator('#voice-save').click();
  await page.waitForFunction(() => document.querySelector('#voice-result')?.textContent.includes('已保存'));
  await page.screenshot({ path: path.join(evidence, 'settings.png') });
  // Foreground leaves the monitoring and assistant pages; actual background must keep receiving video.
  await page.goto(origin + '/platform');
  const state = () => page.evaluate(() => window.atbDesktop.invokeModule('assistant', 'presence', { action: 'status' }));
  const deadline = Date.now() + 120000; let result;
  while (Date.now() < deadline) { result = await state(); if (result.history.some(e => e.text === '问候播放完成')) break; if (result.state === 'error') throw Error(result.text); await new Promise(r => setTimeout(r, 1000)); }
  assert.ok(result.history.some(e => e.text === '问候播放完成'), JSON.stringify(result));
  assert.equal(result.history.filter(e => e.text.includes('本人到场')).length, 1);
  await camera.evaluate(() => { window.hideTestFace = true; }); await new Promise(r => setTimeout(r, 4000)); await camera.evaluate(() => { window.hideTestFace = false; }); await new Promise(r => setTimeout(r, 5000));
  assert.equal((await state()).history.filter(e => e.text.includes('本人到场')).length, 1);
  await camera.evaluate(bytes => window.setFixtureFace(bytes), [...visitor]);
  const visitorDeadline = Date.now() + 60000;
  while (Date.now() < visitorDeadline) { result = await state(); if (result.history.filter(e => e.text === '问候播放完成').length === 2) break; if (result.state === 'error') throw Error(result.text); await new Promise(r => setTimeout(r, 1000)); }
  assert.ok(result.history.some(e => e.text === '朋友到场，开始问候'), JSON.stringify(result));
  assert.equal(result.history.filter(e => e.text === '问候播放完成').length, 2);
  // Change the active visitor profile while present: disable must stop matching without stopping the owner.
  const visitorId = await page.evaluate(async () => {
    const next = await (await fetch('/api/assistant/presence')).json();
    const visitor = next.people.find(p => !p.isSelf);
    await fetch('/api/assistant/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'person-save', person: { id: visitor.id, active: false } }) }); return visitor.id;
  });
  await new Promise(r => setTimeout(r, 5000)); assert.match((await state()).text, /未确认人物|未检测/);
  await page.evaluate(async id => fetch('/api/assistant/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'person-delete', id }) }), visitorId);
  await camera.evaluate(bytes => window.setFixtureFace(bytes), [...source]);
  await new Promise(r => setTimeout(r, 5000));
  assert.equal((await state()).history.filter(e => e.text.includes('本人到场')).length, 1, 'owner persistent cooldown survives visitor editing/deletion');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getURL())); assert.equal(windows.length, 3);
  const background = app.windows().find(p => p.url().endsWith('/presence-background.html')); assert.ok(background);
  const foregroundLease = await page.evaluate(async () => {
    const leaseId = crypto.randomUUID(); await window.atbDesktop.invokeModule('assistant', 'voice', { action: 'open', leaseId, mode: 'synthesis' }); return leaseId;
  });
  assert.equal((await background.evaluate(() => window.atbPresence.call('availability'))).busy, true);
  await page.evaluate(leaseId => window.atbDesktop.invokeModule('assistant', 'voice', { action: 'close', leaseId }), foregroundLease);
  assert.equal((await background.evaluate(() => window.atbPresence.call('availability'))).busy, false);
  assert.ok((await background.evaluate(() => window.atbPresence.call('availability'))).lastInteraction > 0);
  // Independent attention covers frontend loading/system-speech paths without a native speech lease.
  await page.evaluate(() => window.atbDesktop.invokeModule('assistant', 'presence', { action: 'attention', active: true }));
  assert.equal((await background.evaluate(() => window.atbPresence.call('availability'))).busy, true);
  await page.evaluate(() => window.atbDesktop.invokeModule('assistant', 'presence', { action: 'attention', active: false }));
  assert.equal((await background.evaluate(() => window.atbPresence.call('availability'))).busy, false);
  // Fixed in-presence openings were retired. Scheduler clocks, rolls, restart safety,
  // none and actual background delivery are covered by opportunity-*.test.js.
  const retired = await page.evaluate(async () => { const settings=await (await fetch('/api/assistant/presence')).json();return (await fetch('/api/assistant/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'claim',kind:'proactive',revision:settings.revision})})).json(); });
  assert.equal(retired.claimed,false);
  await page.goto(origin + '/modules/assistant/#voice');
  await page.waitForFunction(() => document.querySelector('[data-policy-status]')?.textContent.includes('后台接收随机机会'));
  await page.locator('[data-context]').check(); await page.locator('[data-feedback]').selectOption('tired'); await page.locator('#voice-save').click();
  await page.waitForFunction(() => document.querySelector('#voice-result')?.textContent.includes('全部语音设置已保存'));
  assert.match(await page.locator('[data-preview]').textContent(), /你说今天有些累/);
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
  await page.locator('[data-restdates]').fill(today); assert.match(await page.locator('[data-preview]').textContent(), /休息日/);
  await page.locator('[data-snooze30]').click(); await page.waitForFunction(() => document.querySelector('[data-policy-status]')?.textContent.includes('已暂停'));
  await page.locator('[data-resume]').click(); await page.waitForFunction(() => document.querySelector('[data-policy-status]')?.textContent.includes('当前允许互动'));
  assert.equal((await state()).history.filter(e => e.text === '主动开场播放完成').length, 0);
  await page.locator('#voice-save').click(); await page.waitForFunction(() => document.querySelector('#voice-result')?.textContent.includes('已保存'));
  await page.reload(); await page.locator('[data-context]').waitFor(); assert.equal(await page.locator('[data-proactive]').isChecked(), true);
  assert.equal(await page.locator('[data-restdates]').inputValue(), today);
  await page.locator('[data-context]').scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(evidence, 'context-controls.png') });
  await page.locator('[data-proactive]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, 'proactive-controls.png') });
  await page.waitForFunction(() => document.querySelector('[data-enabled]')?.checked === true);
  await page.locator('[data-enabled]').uncheck(); await page.locator('#voice-save').click();
  await page.waitForFunction(() => document.querySelector('#voice-result')?.textContent.includes('全部语音设置已保存'));
  await page.waitForFunction(async () => (await window.atbDesktop.invokeModule('assistant', 'presence', { action: 'status' })).state === 'off');
  await page.waitForFunction(async () => !(await (await fetch('/api/assistant/presence')).json()).enabled);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, remote ? 'remote-result.json' : 'result.json'), JSON.stringify({ passed: true, remoteService: !!remote, realFaceModel: true, twoPublicIdentities: true, visitorRecognitionDisableDelete: true, syntheticCameraWebRTC: true, realChatTTS: true, contextualPreviewAndPersistence: true, explicitFeedback: true, legacyProactiveDenied: true, randomOpportunityTestsSeparate: true, snooze: true, physicalSpeakerConfirmed: false, privateUserFacesUsed: false, status: result }, null, 2));
  console.log('Presence integration passed: real photo embeddings, WebRTC background after navigation, one greeting, local ChatTTS playback, short occlusion and resource release.');
} catch (error) {
  if (app) for (const page of app.windows()) console.error('Test window:', page.url(), await page.evaluate(() => ({ result: document.querySelector('#voice-result')?.textContent, status: document.querySelector('[data-status]')?.textContent, text: document.body?.innerText.slice(-500) })).catch(() => ''), errors);
  throw error;
} finally { await app?.close(); await browser?.close(); await remote?.close(); await local.close(); await rm(directory, { recursive: true, force: true }); }
