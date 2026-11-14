import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServers } from '../server/index.js';
import { SESSION_COOKIE } from '../server/accounts.js';

test('assistant safely formats messages and cleans legacy tool output without altering user text', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-message-render-'));
  const server = await startServers({ lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, relayPort: 0, publicOrigin: null, dataDir: path.join(directory, 'data'), certDir: path.join(directory, 'certs') });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await server.accounts.setup('message-test', 'local-test-only');
  const session = await server.accounts.login('message-test', 'local-test-only');
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (!req.url().startsWith('https://127.0.0.1:')) external.push(req.url()); });
  const marker = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_search">private query</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const rich = '# 标题\n**加粗** 与 *强调* 🙂\n- 项目\n[官网](https://example.com)\n![示例图](https://example.com/image.png)\n[javascript](javascript:alert(1))\n<img src=x onerror="window.bad=true">\n```js\nconst x = "<script>";\n```';
  await page.addInitScript(({ marker, rich }) => sessionStorage.setItem('homebase.chat.message-test', JSON.stringify([{role:'user',content:marker},{role:'assistant',content:marker},{role:'assistant',content:rich,toolsUsed:[{name:'weather',ok:true,sources:[{source:'Open-Meteo',url:'https://open-meteo.com/',checkedAt:'2026-11-14T00:00:00Z'},{source:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)'}]}]}])), {marker,rich});
  await page.goto('https://127.0.0.1:' + server.secure.address().port + '/modules/assistant/');
  await page.locator('#workspace').waitFor({state:'visible'}); await page.locator('#toggle-transcript').click();
  const messages = page.locator('.bubble.assistant .message-content'), formatted = messages.last();
  assert.doesNotMatch(await messages.first().textContent(), /DSML|private query/);
  assert.match(await messages.first().textContent(), /工具.*未接入/);
  assert.match(await page.locator('.bubble.user').textContent(), /DSML/);
  assert.equal(await formatted.locator('strong').count(), 2);
  assert.equal(await formatted.locator('li').textContent(), '项目');
  assert.equal(await formatted.locator('a').count(), 2);
  assert.equal(await formatted.locator('a').first().getAttribute('rel'), 'noopener noreferrer');
  assert.match(await formatted.locator('a').last().textContent(), /查看图片/);
  assert.equal(await formatted.locator('img,script,[onerror]').count(), 0);
  assert.match(await formatted.locator('pre code').textContent(), /<script>/);
  assert.equal(await page.evaluate(() => Boolean(window.bad)), false);
  const sources=page.locator('.tool-sources');assert.match(await sources.textContent(),/天气 · 已查询.*Open-Meteo/);assert.equal(await sources.locator('a').count(),1);assert.equal(await sources.locator('img,script,[onerror]').count(),0);assert.equal(await sources.locator('a').getAttribute('title'),'2026-11-14T00:00:00Z');
  for (const width of [390,1366]) {
    await page.setViewportSize({width,height:768});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
