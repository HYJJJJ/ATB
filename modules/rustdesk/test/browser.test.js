import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import createModule from '../server/index.js';
import { SESSION_COOKIE } from '../../../server/accounts.js';

test('module page renders authenticated shared settings, exports configuration and fits desktop/mobile', async t => {
  let browser, server, instance;
  const listener = net.createServer(socket => socket.end()); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(async () => {
    await browser?.close();
    instance?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => listener.close(resolve));
  });
  const port = listener.address().port;
  let settings = { publicHost: '127.0.0.1', rustdesk: { idPort: port, relayPort: port, natPort: port, publicKey: 'A'.repeat(43) + '=', deployedVersion: '1.1.16' } };
  instance = await createModule({ accounts: { session: token => token === 'browser-test' ? { user: { username: 'test', role: 'admin' } } : null }, shared: { get: () => structuredClone(settings), async update(_section, mutator) { settings = mutator(structuredClone(settings)); return settings; } } });
  const assets = { '/modules/rustdesk/': ['index.html', 'text/html'], '/modules/rustdesk/rustdesk.js': ['rustdesk.js', 'text/javascript'], '/modules/rustdesk/desktop.js': ['desktop.js', 'text/javascript'], '/modules/rustdesk/rustdesk.css': ['rustdesk.css', 'text/css'] };
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (await instance.handle(req, res, pathname)) return;
    if (pathname === '/ui.css' || pathname === '/ui.js') { res.writeHead(200, { 'Content-Type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(new URL(`../../../public${pathname}`, import.meta.url))); return; }
    const asset = assets[pathname]; if (!asset) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': asset[1] }); res.end(await readFile(new URL(`../public/${asset[0]}`, import.meta.url)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch();
  const page = await browser.newPage({ extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=browser-test` }, viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/modules/rustdesk/`;
  await page.context().addCookies([{ name: SESSION_COOKIE, value: 'browser-test', domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('health-state').textContent === 'TCP 端口可达');
  assert.equal(await page.locator('#id-server').inputValue(), `127.0.0.1:${port}`);
  assert.equal(await page.locator('#nat-warning').isVisible(), true);
  assert.equal(await page.locator('#open-client').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, header: document.querySelector('header').getBoundingClientRect().height, brand: document.querySelector('.brand small').textContent })), { bg: 'rgb(13, 16, 23)', header: 56, brand: 'ALL THE BEST' });
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-config').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'rustdesk-public-config.json');
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.configuration.idServer, `127.0.0.1:${port}`);
  await mkdir('test-results/atb', { recursive: true });
  await page.screenshot({ path: 'test-results/atb/rustdesk-desktop.png', fullPage: true });
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `RustDesk overflows at ${width}`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: 'test-results/atb/rustdesk-mobile.png', fullPage: true });
  await page.locator('.edit-settings summary').click();
  await page.locator('#setting-nat-port').fill(String(port - 1));
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.getElementById('settings-result').textContent.includes('已保存'));
  assert.equal(await page.locator('#nat-warning').isVisible(), false);
  assert.equal(settings.rustdesk.deployedVersion, '1.1.16');
  const unauthenticated = await browser.newPage(); await unauthenticated.goto(url); await unauthenticated.locator('#login-state').waitFor({ state: 'visible' });
  assert.equal(await unauthenticated.locator('#id-server').inputValue(), '');
  const nativePage = await browser.newPage({ extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=browser-test` } });
  await nativePage.addInitScript(() => {
    window.atbDesktop = { isDesktop: true, invokeModule: async (_module, action) => {
      if (action === 'status') return { installed: true };
      return new Promise(resolve => { window.finishRustDeskLaunch = resolve; });
    } };
  });
  await nativePage.goto(url);
  await nativePage.waitForFunction(() => !document.getElementById('open-client').disabled);
  const openButton = nativePage.locator('#open-client'), originalLabel = await openButton.textContent();
  await openButton.click();
  assert.equal(await openButton.isDisabled(), true);
  assert.equal(await openButton.textContent(), '正在启动…');
  assert.match(await nativePage.locator('#notice').textContent(), /正在准备 RustDesk 本机服务/);
  await nativePage.evaluate(() => window.finishRustDeskLaunch({ launched: false, error: 'RustDesk 本机服务未获授权' }));
  await nativePage.waitForFunction(() => !document.getElementById('open-client').disabled);
  assert.match(await nativePage.locator('#notice').textContent(), /未获授权/);
  assert.equal(await openButton.textContent(), originalLabel);
  await openButton.click();
  await nativePage.evaluate(() => window.finishRustDeskLaunch({ launched: true, installed: true }));
  await nativePage.waitForFunction(() => !document.getElementById('open-client').disabled);
  assert.match(await nativePage.locator('#notice').textContent(), /已启动 RustDesk/);
  assert.equal(await openButton.textContent(), originalLabel);
  assert.deepEqual(errors, []);
});
