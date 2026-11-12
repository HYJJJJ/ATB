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
  const filename = manifest.assets[new URL(req.url, 'http://localhost').pathname];
  if (!filename) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(path.join(moduleRoot, filename)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => unexpected.push(socket.url()));
  let settings = { name: '测试助手', prompt: '', memory: '', provider: 'custom', protocol: 'chat', baseUrl: '', model: '', hasApiKey: false };
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let value;
    if (pathname === '/api/auth/session') value = { user: { username: 'test-admin', role: 'admin' }, needsSetup: false };
    else if (pathname === '/api/assistant/voice/status') value = { available: false, pid: null, settings: { enabled: false, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, silenceMs: 1000, autoListen: true } };
    else if (pathname === '/api/assistant/settings') {
      if (request.method() === 'POST') { const body = request.postDataJSON(); delete body.scope; settings = { ...settings, ...body, hasApiKey: Boolean(body.apiKey) || settings.hasApiKey }; delete settings.apiKey; delete settings.clearKey; }
      value = settings;
    } else if (pathname === '/api/assistant/chat') value = { reply: '已收到测试消息' };
    else { unexpected.push(pathname); value = {}; }
    await route.fulfill({ json: value });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/modules/assistant/');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('[data-page=model]').click();
  await page.locator('#base-url').fill('https://example.com/v1');
  await page.locator('#api-key').fill('test-key');
  await page.locator('#model').fill('test-model');
  await page.locator('#model-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#model-result').textContent === '已保存');
  await page.locator('[data-page=assistant]').click();
  await page.locator('#chat-input').fill('测试消息');
  await page.locator('#chat-form [type=submit]').click();
  await page.locator('.bubble.assistant').waitFor();
  assert.match(await page.locator('.bubble.assistant').textContent(), /已收到测试消息/);
  assert.equal(await page.locator('[data-page=camera], #page-overview').count(), 0);
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
  await page.screenshot({ path: path.join(evidence, 'assistant-ui.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, 'assistant-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('Assistant UI passed: model save, chat, isolated navigation, desktop/mobile rendering, no page errors or camera network calls.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
