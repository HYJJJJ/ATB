import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';
import { safeRequest } from '../server/model-request.js';

const root = path.resolve('.'), evidence = path.join(root, 'test-results', 'voice-integration');
const desktopMode = process.argv.includes('--desktop'), liveModel = process.argv.includes('--live-model');
const remoteService = desktopMode && process.argv.includes('--remote-service');
const dir = await mkdtemp(path.join(tmpdir(), 'assistant-voice-ui-'));
const assistantDir = path.join(dir, 'data', 'assistant'); await mkdir(assistantDir, { recursive: true });
for (const name of ['voice-runtime', 'models']) await symlink(path.join(root, 'data', 'assistant', name), path.join(assistantDir, name), process.platform === 'win32' ? 'junction' : 'dir');
const reference = await readFile(path.join(evidence, 'reference-zh.wav'));
let offset = 12, pcm;
while (offset + 8 <= reference.length) { const size = reference.readUInt32LE(offset + 4); if (reference.toString('ascii', offset, offset + 4) === 'data') { pcm = reference.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + size % 2; }
const header = Buffer.from(reference.subarray(0, 44)), samples = Buffer.concat([Buffer.alloc(32000), pcm, Buffer.alloc(32000 * 35)]);
header.writeUInt32LE(samples.length + 36, 4); header.writeUInt32LE(samples.length, 40);
const microphoneFile = path.join(dir, 'microphone.wav'); await writeFile(microphoneFile, Buffer.concat([header, samples]));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number; }
const httpsPort = await freePort(), httpPort = await freePort();
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${microphoneFile}`, '--mute-audio'];
const service = desktopMode && !remoteService ? null : await startServers({ lanIp: '127.0.0.1', httpsPort, httpPort, relayPort: 0, certDir: path.join(dir, 'certs'), dataDir: path.join(dir, remoteService ? 'cloud-data' : 'data'), detector: null });
if (remoteService) await writeFile(path.join(dir, 'data', 'desktop-connection.json'), JSON.stringify({ mode: 'remote', origin: `https://127.0.0.1:${httpsPort}`, ca: await readFile(path.join(dir, 'certs', 'ca.crt'), 'utf8') }));
let app, browser;
try {
  let page;
  if (desktopMode) {
    const env = { ...process.env, ATB_DATA_DIR: dir, FREECAMERA_DATA_DIR: dir, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort), TURN_PORT: '0' }; delete env.ELECTRON_RUN_AS_NODE;
    const require = createRequire(import.meta.url), executable = process.env.FREECAMERA_DESKTOP_EXECUTABLE;
    app = await electron.launch({ executablePath: executable || require('electron'), args: executable ? args : [root, ...args], env });
    page = await app.firstWindow();
    await page.waitForURL('**/platform', { timeout: 30000 });
    await page.goto(new URL('/modules/assistant/', page.url()).href);
  } else {
    browser = await chromium.launch({ args }); const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] }); page = await context.newPage();
    await page.goto(`https://127.0.0.1:${httpsPort}/modules/assistant/`);
  }
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.testVoiceTracks = [];
    navigator.mediaDevices.getUserMedia = async options => { const stream = await capture(options); window.testVoiceTracks.push(...stream.getAudioTracks()); return stream; };
  });
  await page.reload(); await page.locator('#login').waitFor();
  await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill('1'); await page.locator('[name=confirm]').fill('1'); await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor();
  await page.locator('[data-page=model]').click(); await page.locator('#api-source').selectOption('custom'); await page.locator('#base-url').fill('https://example.com/v1'); await page.locator('#model').fill('test-model'); await page.locator('#api-key').fill('test-placeholder'); await page.locator('#model-form [type=submit]').click(); await page.waitForFunction(() => document.querySelector('#model-state').textContent === '已保存');
  let requests = 0;
  const modelConfig = liveModel ? (await (await import('../../../server/shared-settings.js')).SharedSettings.load(path.join(root, 'data'))).get('ai') : null;
  await page.route('**/api/assistant/chat', async route => {
    requests++;
    if (!liveModel) { await route.fulfill({ json: { reply: '语音对话连接正常。' } }); return; }
    const { messages } = route.request().postDataJSON();
    const instructions = '这是一项语音链路测试。请仅回复“语音对话连接正常。”';
    const payload = modelConfig.protocol === 'responses' ? { model: modelConfig.model, instructions, input: messages, stream: false, store: false, max_output_tokens: 64 } : { model: modelConfig.model, messages: [{ role: 'system', content: instructions }, ...messages], max_tokens: 64 };
    const response = await safeRequest(`${modelConfig.baseUrl}/${modelConfig.protocol === 'responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { Authorization: `Bearer ${modelConfig.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200); const result = await response.json();
    const answer = result.choices?.[0]?.message?.content || result.output_text || result.output?.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
    assert.ok(answer); await route.fulfill({ json: { reply: answer } });
  });
  await page.locator('[data-page=assistant]').click(); await page.waitForFunction(() => !document.querySelector('#voice-start').disabled);
  await page.locator('#toggle-transcript').click();
  assert.equal(await page.locator('#transcript textarea, #transcript form').count(), 0);
  await page.locator('#voice-start').click();
  await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'speaking', {}, { timeout: 60000 });
  assert.match(await page.locator('.bubble.user').last().textContent(), /[\u4e00-\u9fff]{3}/);
  assert.match(await page.locator('.bubble.assistant').last().textContent(), /语音/); assert.equal(requests, 1);
  await page.locator('#voice-stop').click(); await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
  const state = await page.evaluate(async () => window.atbDesktop?.hasModule('assistant') ? window.atbDesktop.invokeModule('assistant', 'voice', { action: 'status' }) : (await fetch('/api/assistant/voice/status')).json());
  assert.equal(state.pid, null); assert.equal(await page.evaluate(() => window.testVoiceTracks.every(track => track.readyState === 'ended')), true);
  await page.locator('[data-page=voice]').click(); await page.locator('#voice-name').selectOption('zh-CN-YunxiNeural');
  for (const [id, value] of [['voice-rate', 25], ['voice-volume', -10], ['voice-pitch', 15]]) await page.locator('#' + id).evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await page.locator('#voice-form [type=submit]').click(); await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  await page.reload(); await page.locator('#workspace').waitFor(); await page.waitForFunction(() => document.querySelector('#voice-name').value === 'zh-CN-YunxiNeural');
  assert.equal(await page.locator('#voice-rate').inputValue(), '25');
  assert.equal(await page.locator('#voice-volume').inputValue(), '-10'); assert.equal(await page.locator('#voice-pitch').inputValue(), '15');
  for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 960 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(evidence, `${desktopMode ? 'desktop' : 'browser'}-settings-${width}.png`), fullPage: true }); }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${desktopMode ? remoteService ? 'desktop IPC with separate remote service' : 'desktop IPC' : 'authenticated browser HTTP'} real microphone capture -> Silero/SenseVoice -> ${liveModel ? 'live third-party model' : 'test model'} -> real EdgeTTS playback, stop releases worker/mic, settings persist`);
} finally {
  await browser?.close(); await app?.close(); await service?.close();
  for (const name of ['voice-runtime', 'models']) await unlink(path.join(assistantDir, name));
  await rm(dir, { recursive: true, force: true });
}
