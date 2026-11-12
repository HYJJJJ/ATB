import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(moduleRoot, 'module.json'), 'utf8'));
const evidence = path.resolve('test-results/atb');
await mkdir(evidence, { recursive: true });
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = manifest.assets[pathname];
  if (['/ui.css', '/ui.js'].includes(pathname)) { res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(path.resolve('public' + pathname))); return; }
  if (!filename) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(path.join(moduleRoot, filename)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.addInitScript(() => {
    window.testSpeech = []; window.testSpeechFailure = false; let timer;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [],
      cancel: () => clearTimeout(timer),
      speak: utterance => { window.testSpeech.push(utterance.text); timer = setTimeout(() => window.testSpeechFailure ? utterance.onerror({ error: 'synthesis-failed' }) : utterance.onend(), 150); },
    } });
    navigator.mediaDevices.getUserMedia = async () => { throw Error('Read-aloud must not request a microphone'); };
  });
  const errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => unexpected.push(socket.url()));
  let settings = { name: '测试助手', prompt: '', memory: '', provider: 'custom', protocol: 'chat', baseUrl: '', model: '', hasApiKey: true, apiSource: 'platform', selectedModels: ['platform-one', 'platform-two'], model: 'platform-one', baseUrl: 'https://example.com/v1' };
  let settingsGets = 0, expectedChatModel = 'second-model', holdChat, releaseChat;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let value;
    if (pathname === '/api/auth/session') value = { user: { username: 'test-admin', role: 'admin' }, needsSetup: false };
    else if (pathname === '/api/assistant/voice/status') value = { available: false, pid: null, settings: { enabled: false, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, silenceMs: 1000, autoListen: true } };
    else if (pathname === '/api/assistant/settings') {
      if (request.method() === 'GET') settingsGets++;
      if (request.method() === 'POST') { const body = request.postDataJSON(); delete body.scope; settings = { ...settings, ...body, hasApiKey: Boolean(body.apiKey) || settings.hasApiKey }; delete settings.apiKey; delete settings.clearKey; }
      value = settings;
    } else if (pathname === '/api/assistant/models') value = { models: ['test-model', 'second-model', 'unselected-model'] };
    else if (pathname === '/api/assistant/chat') { assert.equal(request.postDataJSON().model, expectedChatModel); if (holdChat) await new Promise(resolve => { releaseChat = resolve; }); value = { reply: '已收到测试消息' }; }
    else { unexpected.push(pathname); value = {}; }
    await route.fulfill({ json: value });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/modules/assistant/');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('[data-page=model]').click();
  assert.equal(await page.locator('#api-source').inputValue(), 'platform');
  assert.match(await page.locator('#key-state').textContent(), /已配置|已保存/);
  await page.locator('#api-source').selectOption('custom');
  await page.locator('#base-url').fill('https://example.com/v1');
  await page.locator('#api-key').fill('test-key');
  await page.locator('#model').fill('test-model');
  await page.locator('#load-models').click();
  await page.locator('#model-dialog').waitFor({ state: 'visible' });
  await page.locator('#model-filter').fill('second');
  await page.getByRole('checkbox', { name: 'second-model', exact: true }).check();
  await page.locator('#apply-models').click();
  await page.locator('#model-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#model-result').textContent === '已保存');
  await page.locator('[data-page=assistant]').click();
  await page.locator('#chat-model').selectOption('second-model');
  await page.locator('#chat-input').fill('测试消息');
  await page.locator('#chat-form [type=submit]').click();
  await page.locator('.bubble.assistant').waitFor();
  assert.match(await page.locator('.bubble.assistant').textContent(), /已收到测试消息/);
  assert.equal(await page.locator('[data-page=camera], #page-overview').count(), 0);
  assert.equal(await page.locator('header a[href="/platform#settings"]').count(), 1);
  assert.equal(await page.locator('#connection, #logout').count(), 0);
  assert.equal(await page.locator('.bubble.assistant .message-speak').count(), 1);
  await page.locator('.bubble.assistant .message-content').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.testSpeech.length === 1);
  assert.equal(await page.evaluate(() => window.testSpeech[0]), '已收到测试消息');
  assert.match(await page.locator('#voice-live').textContent(), /系统语音/);
  await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
  await page.locator('[data-page=voice]').click();
  await page.evaluate(() => { window.testSpeechFailure = true; });
  await page.locator('#voice-preview').click();
  await page.waitForFunction(() => document.querySelector('#voice-result').textContent.includes('系统语音播放失败'));
  assert.equal(await page.locator('#voice-preview-stop').isVisible(), false);
  await page.locator('[data-page=assistant]').click();
  const layout = await page.evaluate(() => ({chat: document.querySelector('.chat').getBoundingClientRect().bottom, persona: document.querySelector('#persona-form').getBoundingClientRect().top}));
  assert.ok(layout.persona >= layout.chat);
  await page.locator('.bubble.assistant .message-memory').click();
  assert.match(await page.locator('#memory').inputValue(), /已收到测试消息/);
  assert.equal(await page.locator('#memory-state').textContent(), '未保存');
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
  await page.screenshot({ path: path.join(evidence, 'assistant-ui.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, 'assistant-mobile.png'), fullPage: true });
  await page.locator('#prompt').fill('尚未保存的角色草稿');
  await page.locator('[data-page=model]').click();
  await page.locator('#api-key').fill('unsaved-key-draft');
  await page.locator('[data-page=assistant]').click();
  settings = { ...settings, apiSource: 'platform', selectedModels: ['new-platform-model'], model: 'new-platform-model' };
  const previousGets = settingsGets;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#chat-model').value === 'new-platform-model');
  assert.ok(settingsGets > previousGets);
  assert.equal(await page.locator('#prompt').inputValue(), '尚未保存的角色草稿');
  assert.equal(await page.locator('#api-key').inputValue(), 'unsaved-key-draft');
  assert.equal(await page.locator('#memory-state').textContent(), '未保存');
  settings = { ...settings, selectedModels: ['newest-platform-model'], model: 'newest-platform-model' };
  expectedChatModel = 'newest-platform-model'; holdChat = true;
  await page.locator('#chat-input').fill('发送前校准平台模型');
  await page.locator('#chat-form [type=submit]').click();
  const chatDeadline = Date.now() + 5000;
  while (!releaseChat && Date.now() < chatDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseChat, 'the next message must reach chat with the refreshed model');
  assert.equal(await page.locator('#chat-model').inputValue(), 'newest-platform-model');
  settings = { ...settings, selectedModels: ['later-platform-model'], model: 'later-platform-model' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#chat-model').inputValue(), 'newest-platform-model', 'background refresh must not change a running chat model');
  holdChat = false; releaseChat();
  await page.waitForFunction(() => !document.querySelector('#chat-form [type=submit]').disabled);
  assert.equal(await page.locator('#prompt').inputValue(), '尚未保存的角色草稿');
  assert.equal(await page.locator('#api-key').inputValue(), 'unsaved-key-draft');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('Assistant UI passed: model save, chat, isolated navigation, desktop/mobile rendering, no page errors or camera network calls.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
