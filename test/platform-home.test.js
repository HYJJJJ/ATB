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
    const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce', viewport: { width: 1440, height: 960 } });
    contexts.push(context);
    await context.addInitScript(() => { const values = [.11, .99, .01, .99, .01]; let i = 0; Math.random = () => values[i++ % values.length]; });
    await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), origin = 'https://127.0.0.1:' + server.secure.address().port;
    await page.goto(origin + '/platform');
    await page.locator('#workspace').waitFor({ state: 'visible' });
    return { page, origin };
  }
  const { page, origin } = await fixture('full', [['assistant', '智能助手'], ['freecamera', 'FreeCamera'], ['rustdesk', 'RustDesk']]);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  async function homeFits(target, label) {
    await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await target.evaluate(() => {
      const viewport = { width: innerWidth, height: innerHeight };
      const controls = [...document.querySelectorAll('.orbit-node, #module-open, .orbit-pagination button, .platform-footer')].filter(node => node.getClientRects().length);
      const clipped = controls.filter(node => {
        const r = node.getBoundingClientRect();
        return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1;
      }).map(node => node.id || node.className);
      return { viewport, scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, clipped };
    });
    assert.ok(layout.scroll.height <= layout.viewport.height + 1 && layout.scroll.width <= layout.viewport.width + 1, label + ': homepage stays within viewport ' + JSON.stringify(layout));
    assert.deepEqual(layout.clipped, [], label + ': module controls and footer remain visible');
  }
  assert.equal(await page.locator('.brand-word').textContent(), 'ATB');
  assert.equal(await page.locator('.brand small').textContent(), 'ALL THE BEST');
  assert.deepEqual(await page.locator('.platform-nav a').allTextContents(), ['工作台', '平台设置']);
  assert.equal(await page.locator('#connection, #logout').count(), 0);
  for (const [width, height] of [[375, 667], [390, 844], [768, 700], [667, 375], [844, 390], [860, 620], [1240, 860], [1366, 768], [1440, 900], [1024, 720]]) {
    await page.setViewportSize({ width, height });
    await homeFits(page, width + 'x' + height);
    assert.ok(await page.locator('.platform-header').evaluate(node => node.getBoundingClientRect().height <= 60), 'compact header');
    const insets = await page.evaluate(() => {
      const brand = document.querySelector('.brand-word').getBoundingClientRect();
      const content = document.querySelector('#page-overview').getBoundingClientRect();
      return { left: brand.left, top: brand.top, contentLeft: content.left, contentRight: innerWidth - content.right };
    });
    assert.ok(Math.abs(insets.left - insets.top) <= 1, 'brand top and left insets match: ' + JSON.stringify(insets));
    assert.ok(Math.abs(insets.contentLeft - insets.left) <= 1 && Math.abs(insets.contentRight - insets.left) <= 1, 'content uses the same side insets');
  }
  const sizes = [];
  for (const [width, height] of [[1000, 720], [1440, 900], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width, height });
    sizes.push(await page.evaluate(() => ({
      stage: document.querySelector('.orbit-stage').getBoundingClientRect().width,
      planet: document.querySelector('.node-symbol').getBoundingClientRect().width,
      title: parseFloat(getComputedStyle(document.querySelector('#module-name')).fontSize),
    })));
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'fluid desktop home fits ' + width);
  }
  for (let index = 1; index < sizes.length; index++) {
    assert.ok(sizes[index].stage > sizes[index - 1].stage * 1.1, 'planetary scene grows with the window');
    assert.ok(sizes[index].planet > sizes[index - 1].planet, 'module planets grow with the window');
    assert.ok(sizes[index].title > sizes[index - 1].title, 'module heading scales with the window');
  }
  const satellite = page.locator('.orbit-node').first();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const beforeMotion = await satellite.evaluate(node => node.style.transform);
  await page.waitForTimeout(180);
  assert.notEqual(await satellite.evaluate(node => node.style.transform), beforeMotion, 'the actual module controls orbit continuously');
  const movingTarget = await satellite.boundingBox();
  await page.mouse.move(movingTarget.x + movingTarget.width / 2, movingTarget.y + movingTarget.height / 2);
  const hoverPosition = await satellite.evaluate(node => node.style.transform);
  await page.waitForTimeout(180);
  assert.equal(await satellite.evaluate(node => node.style.transform), hoverPosition, 'pointer pauses motion for reliable selection');
  await page.locator('#orbit-stage').hover({ position: { x: 2, y: 2 } });
  await page.waitForTimeout(180);
  assert.notEqual(await satellite.evaluate(node => node.style.transform), hoverPosition, 'hovering empty space keeps the scene alive');
  await page.mouse.move(0, 0);
  await page.locator('#orbit-motion').click();
  await page.mouse.move(0, 0);
  await page.locator('#orbit-motion').blur();
  assert.equal(await page.locator('#orbit-motion').getAttribute('aria-pressed'), 'true');
  const manualPosition = await satellite.evaluate(node => node.style.transform);
  await page.waitForTimeout(180);
  assert.equal(await satellite.evaluate(node => node.style.transform), manualPosition, 'explicit pause survives pointer exit');
  await page.locator('#orbit-motion').click();
  await page.mouse.move(0, 0);
  await page.locator('#orbit-motion').blur();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedPosition = await satellite.evaluate(node => node.style.transform);
  await page.waitForTimeout(180);
  assert.equal(await satellite.evaluate(node => node.style.transform), reducedPosition, 'reduced motion stops the orbit');
  await page.setViewportSize({ width: 1440, height: 900 });
  await mkdir('test-results/orbit-home', { recursive: true });
  await page.screenshot({ path: 'test-results/orbit-home/home-1440.png' });
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
  await page.waitForFunction(() => document.documentElement.dataset.page === 'settings');
  await page.setViewportSize({ width: 390, height: 667 });
  assert.ok(await page.locator('#content').evaluate(node => node.scrollHeight > node.clientHeight), 'settings scroll inside the content viewport');
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'settings never add a document scrollbar');
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
  assert.equal(await page.locator('#billing-state').textContent(), '未配置');
  assert.equal(await page.locator('#billing-query').isDisabled(), true);
  await page.locator('#billing-ak').fill('fixture-billing-ak');
  await page.locator('#billing-sk').fill('fixture-billing-sk');
  await page.locator('#billing-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#billing-state').textContent === '已配置');
  assert.equal(await page.locator('#billing-ak').inputValue(), '');
  assert.equal(await page.locator('#billing-sk').inputValue(), '');
  assert.equal(await page.locator('#billing-query').isDisabled(), false);
  await page.route('**/api/platform/billing/volcengine/balance?refresh=1', route => route.fulfill({ json: { kind: 'balance', available: '77.01', cash: '83.01' } }));
  await page.locator('#billing-query').click();
  await page.waitForFunction(() => document.querySelector('#billing-result').textContent.includes('可用余额 77.01'));
  await page.reload();
  await page.getByRole('tab', { name: 'AI 接口', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#billing-state').textContent === '已配置');
  assert.equal(await page.locator('#billing-sk').inputValue(), '');
  await page.locator('#billing-clear').check();
  assert.equal(await page.locator('#billing-query').isDisabled(), true);
  await page.locator('#billing-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#billing-state').textContent === '未配置');
  await page.unroute('**/api/platform/billing/volcengine/balance?refresh=1');
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
  for (const [width, height] of [[375, 667], [390, 844], [667, 375], [844, 390], [860, 620], [1240, 620], [1920, 720]]) {
    await dense.page.setViewportSize({ width, height });
    await homeFits(dense.page, 'paged ' + width + 'x' + height);
  }
  // Sample a full revolution with real layout/hit testing, including short windows.
  await dense.page.clock.install();
  await dense.page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const [width, height] of [[390, 844], [667, 375], [1440, 900]]) {
    await dense.page.setViewportSize({ width, height });
    await dense.page.mouse.move(0, 0);
    await dense.page.evaluate(() => document.activeElement?.blur());
    for (let sample = 0; sample < 32; sample++) {
      await dense.page.clock.runFor(5000);
      const overlaps = await dense.page.locator('.orbit-node').evaluateAll(nodes => {
        const rects = nodes.map(node => node.getBoundingClientRect()), issues = [];
        for (let i = 0; i < nodes.length; i++) {
          const r = rects[i];
          if (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.orbit-node') !== nodes[i]) issues.push('covered ' + i);
          for (let j = i + 1; j < nodes.length; j++) {
            const s = rects[j];
            if (r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top) issues.push('overlap ' + i + '/' + j + ': ' + JSON.stringify([r.toJSON(), s.toJSON()]));
          }
        }
        return issues;
      });
      assert.deepEqual(overlaps, [], 'moving controls stay separate and clickable ' + width + 'x' + height + ', sample ' + sample);
    }
  }
  await dense.page.emulateMedia({ reducedMotion: 'reduce' });
  await dense.page.locator('.orbit-node[aria-pressed="true"]').press('End');
  await dense.page.getByRole('button', { name: '选择工具 20', exact: true }).dblclick();
  await dense.page.waitForURL(dense.origin + '/modules/tool20/');
});
