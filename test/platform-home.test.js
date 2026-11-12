import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startServers } from '../server/index.js';
import { SESSION_COOKIE } from '../server/accounts.js';

test('orbit home selects without navigation, opens the intended module and supports core-only installs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atb-orbit-home-'));
  const servers = [], contexts = [];
  let browser;
  t.after(async () => {
    await browser?.close();
    for (const server of servers) await server.close();
    await rm(root, { recursive: true, force: true });
  });
  browser = await chromium.launch();
  async function fixture(name, entries) {
    const directory = path.join(root, name), modulesDir = path.join(directory, 'modules');
    await mkdir(modulesDir, { recursive: true });
    for (const [id, title] of entries) {
      const moduleDir = path.join(modulesDir, id);
      await mkdir(path.join(moduleDir, 'public'), { recursive: true });
      await writeFile(path.join(moduleDir, 'public/index.html'), '<h1>Module fixture</h1>');
      await writeFile(path.join(moduleDir, 'index.mjs'), 'export default async () => ({})');
      await writeFile(path.join(moduleDir, 'module.json'), JSON.stringify({
        id, name: title, description: title + '的模块说明', version: '1.0.0', apiVersion: 1,
        entry: '/modules/' + id + '/', server: 'index.mjs', assets: { ['/modules/' + id + '/']: 'public/index.html' },
      }));
    }
    const server = await startServers({ lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, relayPort: 0, publicOrigin: null, modulesDir, dataDir: path.join(directory, 'data'), certDir: path.join(directory, 'certs') });
    servers.push(server);
    await server.accounts.setup('orbit-test', 'test-fixture-only');
    const session = await server.accounts.login('orbit-test', 'test-fixture-only');
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
    contexts.push(context);
    await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), origin = 'https://127.0.0.1:' + server.secure.address().port;
    await page.goto(origin + '/platform');
    await page.locator('#workspace').waitFor({ state: 'visible' });
    return { page, origin };
  }
  const { page, origin } = await fixture('full', [['assistant', '智能助手'], ['freecamera', 'FreeCamera'], ['rustdesk', 'RustDesk']]);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  assert.equal(await page.locator('.brand-word').textContent(), 'ATB');
  assert.equal(await page.locator('.brand small').textContent(), 'ALL THE BEST');
  assert.deepEqual(await page.locator('.platform-nav a').allTextContents(), ['工作台', '平台设置']);
  assert.equal(await page.locator('#connection, #logout').count(), 0);
  for (const [width, height] of [[1240, 860], [1366, 768], [1440, 900], [1024, 720]]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'home has no vertical overflow ' + width + 'x' + height);
    assert.ok(await page.locator('.platform-header').evaluate(node => node.getBoundingClientRect().height <= 60), 'compact header');
  }
  // A single click must leave time for the second click instead of opening immediately.
  assert.equal(await page.getByRole('button', { name: '选择FreeCamera', exact: true }).count(), 1);
  await page.getByRole('button', { name: '选择FreeCamera', exact: true }).click();
  assert.equal(page.url(), origin + '/platform');
  assert.equal(await page.locator('#module-name').textContent(), 'FreeCamera');
  assert.equal(await page.locator('#module-open').getAttribute('href'), '/modules/freecamera/');
  await page.getByRole('button', { name: '选择RustDesk', exact: true }).dblclick();
  await page.waitForURL(origin + '/modules/rustdesk/');
  await page.goto(origin + '/platform');
  await page.getByRole('button', { name: '选择FreeCamera', exact: true }).click();
  await page.keyboard.press('Enter');
  await page.waitForURL(origin + '/modules/freecamera/');

  await page.goto(origin + '/platform');
  await page.getByRole('button', { name: '选择FreeCamera', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#module-name').textContent(), 'FreeCamera');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#module-name').textContent(), 'RustDesk');
  await page.locator('[data-page="settings"]').click();
  await page.locator('#server-label').fill('Orbit test');
  await page.locator('#server-host').fill('example.com');
  await page.locator('#server-form button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  await page.getByRole('tab', { name: 'AI 接口', exact: true }).click();
  await page.locator('#ai-base-url').fill('https://models.example.com/v1');
  await page.locator('#ai-api-key').fill('fixture-key-not-a-real-secret');
  await page.locator('#ai-model').fill('alpha');
  await page.locator('#ai-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('ai-state').textContent === '已配置');
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  assert.match(await page.locator('#ai-key-state').textContent(), /已配置/);
  await page.route('**/api/platform/ai/models', route => route.fulfill({ json: { models: ['alpha','beta','gamma'] } }));
  await page.locator('#ai-discover').click();
  await page.locator('#ai-model-dialog').waitFor({ state: 'visible' });
  await page.locator('#ai-model-search').fill('beta');
  await page.locator('#ai-model-options').getByRole('checkbox').check();
  await page.locator('#ai-model-apply').click();
  await page.locator('#ai-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('ai-state').textContent === '已配置');
  await page.reload();
  await page.getByRole('tab', { name: 'AI 接口', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('ai-key-state').dataset.configured === 'true');
  assert.equal(await page.locator('#ai-selected-models .model-chip').count(), 2);
  assert.equal(await page.locator('#ai-base-url').inputValue(), 'https://models.example.com/v1');
  await page.getByRole('tab', { name: '账户', exact: true }).click();
  let submitted, release;
  const submittedRequest = new Promise(resolve => { submitted = resolve; });
  const releaseResponse = new Promise(resolve => { release = resolve; });
  const delayAccount = async route => { const response = await route.fetch(); submitted(); await releaseResponse; await route.fulfill({ response }); };
  await page.route('**/api/auth/account', delayAccount);
  await page.locator('#account-username').fill('orbit-updated');
  await page.locator('#account-current').fill('test-fixture-only');
  await page.locator('#account-form button[type=submit]').click();
  await submittedRequest;
  await page.locator('#account-username').fill('new-unsaved-draft');
  release();
  await page.waitForFunction(() => document.getElementById('account-result').textContent.includes('当前新修改尚未保存'));
  assert.equal(await page.locator('#account-username').inputValue(), 'new-unsaved-draft');
  assert.equal(await page.locator('#account-state').textContent(), '未保存');
  await page.unroute('**/api/auth/account', delayAccount);
  await page.locator('#account-username').fill('orbit-updated');
  await page.locator('#account-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('account-state').textContent === '已保存');
  assert.equal(await page.locator('#user-label').textContent(), 'orbit-updated');
  await page.locator('[data-page="overview"]').click();
  await page.getByRole('button', { name: '选择RustDesk', exact: true }).click();
  assert.equal(await page.locator('#module-name').textContent(), 'RustDesk');
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page fits viewport ' + width);
    for (const label of ['智能助手', 'FreeCamera', 'RustDesk']) {
      const node = page.getByRole('button', { name: '选择' + label, exact: true });
      await node.click();
      assert.equal(await page.locator('#module-name').textContent(), label);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#module-open').click();
  await page.waitForURL(origin + '/modules/rustdesk/');
  await page.goto(origin + '/platform');
  await page.context().clearCookies();
  await page.reload();
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.deepEqual(errors, []);

  const empty = await fixture('core', []);
  assert.equal(await empty.page.locator('#module-count').textContent(), '0');
  assert.equal(await empty.page.locator('#empty-modules').isVisible(), true);
  assert.equal(await empty.page.locator('#module-open').isVisible(), false);
  assert.equal(await empty.page.locator('.orbit-node').count(), 0);
  const extension = await fixture('extensions', [['notes', '我的笔记']]);
  await extension.page.getByRole('button', { name: '选择我的笔记', exact: true }).dblclick();
  await extension.page.waitForURL(extension.origin + '/modules/notes/');

  const dense = await fixture('many-modules', Array.from({ length: 20 }, (_, index) => [
    'tool' + String(index + 1).padStart(2, '0'), index === 0 ? '一个名称比较长的工具模块' : '工具 ' + (index + 1),
  ]));
  for (const width of [390, 860, 1024]) {
    await dense.page.setViewportSize({ width, height: 960 });
    await dense.page.reload();
    await dense.page.locator('.orbit-node').first().waitFor();
    for (let group = 0; group < 5; group++) {
      const problems = await dense.page.locator('.orbit-node').evaluateAll(nodes => {
        const issues = [], rectangles = nodes.map(node => node.getBoundingClientRect());
        nodes.forEach((node, index) => {
          const rect = rectangles[index];
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          if (hit?.closest('.orbit-node') !== node) issues.push('covered: ' + node.dataset.moduleId);
          for (let other = index + 1; other < nodes.length; other++) {
            const next = rectangles[other];
            if (rect.left < next.right && rect.right > next.left && rect.top < next.bottom && rect.bottom > next.top) issues.push('overlap: ' + node.dataset.moduleId + '/' + nodes[other].dataset.moduleId);
          }
        });
        return issues;
      });
      assert.deepEqual(problems, [], 'every module can be hit at width ' + width + ', group ' + group);
      assert.equal(await dense.page.locator('.orbit-node').count(), 4);
      assert.equal(await dense.page.locator('#orbit-page-status').textContent(), (group + 1) + ' / 5');
      for (const node of await dense.page.locator('.orbit-node').all()) {
        await node.click();
        assert.equal(await node.getAttribute('aria-pressed'), 'true');
      }
      if (group < 4) await dense.page.getByRole('button', { name: '下一组模块', exact: true }).click();
    }
    assert.ok(await dense.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await dense.page.getByRole('button', { name: '上一组模块', exact: true }).click();
    assert.equal(await dense.page.locator('#orbit-page-status').textContent(), '4 / 5');
    await dense.page.locator('.orbit-node[aria-pressed="true"]').press('End');
    assert.equal(await dense.page.locator('#module-name').textContent(), '工具 20');
    await dense.page.locator('.orbit-node[aria-pressed="true"]').press('ArrowRight');
    assert.equal(await dense.page.locator('#module-name').textContent(), '一个名称比较长的工具模块');
    assert.equal(await dense.page.locator('#orbit-page-status').textContent(), '1 / 5');
  }
  await dense.page.locator('.orbit-node[aria-pressed="true"]').press('End');
  await dense.page.getByRole('button', { name: '选择工具 20', exact: true }).dblclick();
  await dense.page.waitForURL(dense.origin + '/modules/tool20/');
});
