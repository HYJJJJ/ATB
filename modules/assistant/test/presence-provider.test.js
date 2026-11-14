import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');

test('desktop startup restores prior proactive messages to history without replaying a home popup or speech', async t => {
  const manifest = JSON.parse(await readFile(path.join(root, 'module.json'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local').pathname;
    if (url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<div id="notice" role="status">平台提示保持原样</div><script type="module">import { activate } from "/modules/assistant/presence-provider.js"; window.provider = await activate();</script>');
      return;
    }
    const asset = manifest.assets[url];
    if (!asset) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', 'text/javascript');
    res.end(await readFile(path.join(root, asset)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const oldMessage = { id: 'previous-run-message', ts: Date.now() - 3600000, text: '昨天聊到的那件小事' };
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.desktopCalls = [];
      window.atbDesktop = { hasModule: id => id === 'assistant', invokeModule: async (...args) => { window.desktopCalls.push(args); return {}; } };
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()).pathname;
      const fixtures = {
        '/api/auth/session': { user: { username: 'fixture' } },
        '/api/assistant/settings': { name: '小鲸鱼', proactiveChat: true },
        '/api/assistant/presence': { enabled: false },
        '/api/assistant/opportunity': { lastChat: oldMessage },
      };
      assert.equal(route.request().method(), 'GET', 'startup must not request a new proactive reply');
      assert.ok(fixtures[url], 'only existing read-only startup endpoints are called');
      await route.fulfill({ json: fixtures[url] });
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => sessionStorage.getItem('homebase.opportunity.fixture') === 'previous-run-message');
    assert.equal(await page.locator('#notice').textContent(), '平台提示保持原样', 'historical assistant text cannot replace a platform notice');
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('homebase.chat.fixture'))), [{ role: 'assistant', content: oldMessage.text }]);
    assert.deepEqual(await page.evaluate(() => window.desktopCalls), [['assistant', 'presence', { action: 'start' }]], 'history recovery cannot emit a new widget event or start speech');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('homebase.chat.fixture')).length), 1, 'polling does not duplicate restored history');
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.provider.close());
    await context.close();
  }
});
