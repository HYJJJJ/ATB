import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServers } from '../server/index.js';
import { SESSION_COOKIE } from '../server/accounts.js';

test('module content scrolls below a consistent header without moving the page or reserving scrollbar space', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-page-scroll-'));
  const evidence = path.resolve('test-results/page-scroll');
  await mkdir(evidence, { recursive: true });
  const server = await startServers({ lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, relayPort: 0, publicOrigin: null, dataDir: path.join(directory, 'data'), certDir: path.join(directory, 'certs') });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await server.accounts.setup('layout-test', 'local-test-only');
  const session = await server.accounts.login('layout-test', 'local-test-only');
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'https://127.0.0.1:' + server.secure.address().port;
  for (const [name, url] of [['assistant', '/modules/assistant/#voice'], ['rustdesk', '/modules/rustdesk/'], ['freecamera', '/?mode=viewer'], ['settings', '/platform#settings/ai']]) {
    await page.goto(origin + url);
    if (name === 'assistant' || name === 'settings') await page.locator('#workspace').waitFor({ state: 'visible' });
    if (name === 'freecamera') await page.locator('#view-workspace').waitFor({ state: 'visible' });
    const header = page.locator('header').first();
    if (name !== 'settings') {
      const back = page.getByRole('link', { name: '返回工作台', exact: true });
      assert.equal(await back.count(), 1, name + ': one shared return action');
      assert.equal(await back.getAttribute('href'), '/platform');
    }
    for (const [width, height] of [[1366, 768], [390, 667]]) {
      await page.setViewportSize({ width, height });
      const content = page.locator('main').first();
      const start = await header.boundingBox();
      const secondRow = name === 'assistant' ? await page.locator('.module-bar').boundingBox() : null;
      await page.mouse.move(width / 2, height - 100);
      await page.mouse.wheel(0, 1400);
      await page.waitForFunction(() => document.querySelector('main').scrollTop > 0 || window.scrollY > 0);
      const layout = await content.evaluate(main => {
        const style = getComputedStyle(main), rect = main.getBoundingClientRect();
        return { scroll: main.scrollTop, pageScroll: window.scrollY, pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, gutter: main.offsetWidth - main.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth), top: rect.top };
      });
      assert.equal(layout.pageScroll, 0, name + ': the document must not scroll');
      assert.ok(layout.pageHeight <= height + 1, name + ': no document overflow');
      assert.ok(layout.scroll > 0, name + ': wheel scrolls the content');
      assert.equal((await header.boundingBox()).y, start.y, name + ': header stays in place');
      assert.equal(layout.gutter, 0, name + ': scrollbar reserves no content width');
      if (secondRow) {
        const current = await page.locator('.module-bar').boundingBox();
        assert.equal(current.y, secondRow.y, 'assistant status and navigation stay fixed while content scrolls');
        assert.ok(layout.top >= current.y + current.height - 1, 'content starts below both header rows');
      }
      const track = page.locator('.atb-scrollbar:visible').first();
      await track.waitFor();
      const trackRect = await track.boundingBox();
      assert.ok(trackRect.y >= start.y + start.height, name + ': scrollbar starts below the menu');
      assert.ok(trackRect.y + trackRect.height <= height + 1, name + ': scrollbar remains in content viewport');
      const thumb = track.locator('.atb-scrollbar-thumb'), thumbRect = await thumb.boundingBox();
      await page.mouse.move(thumbRect.x + thumbRect.width / 2, thumbRect.y + thumbRect.height / 2);
      await page.mouse.down();
      await page.mouse.move(thumbRect.x + thumbRect.width / 2, trackRect.y + 5, { steps: 8 });
      await page.mouse.up();
      assert.ok(await content.evaluate(main => main.scrollTop) < layout.scroll, name + ': overlay thumb is draggable');
      await content.evaluate(main => { main.scrollTop = 0; });
      await header.hover(); await page.mouse.wheel(0, 150);
      await page.waitForFunction(() => document.querySelector('main').scrollTop > 0);
      await content.evaluate(main => { main.scrollTop = 0; });
      await track.hover(); await page.mouse.wheel(0, 150);
      await page.waitForFunction(() => document.querySelector('main').scrollTop > 0);
      await content.evaluate(main => { main.scrollTop = 0; });
      await page.screenshot({ path: path.join(evidence, name + '-' + width + '.png') });
    }
    if (name === 'settings') {
      for (const width of [390,1366,1920]) {
        await page.setViewportSize({width,height:900});
        await page.locator('main').evaluate(el=>{el.scrollTop=0;});
        const geometry = await page.locator('#billing-form').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};});
        assert.ok(Math.abs(geometry.left-(width-geometry.right))<3,'platform settings are centered');
        if(width>=1366)assert.ok(geometry.width>=1100,'platform form fills its group');
        assert.ok(await page.locator('.platform-footer').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=12));
        assert.ok(await page.locator('#service-host').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=12));
        await page.evaluate(()=>document.documentElement.classList.add('desktop'));
        assert.equal(await page.locator('.header-actions').isVisible(),true,'desktop account stays visible');
        assert.ok(await page.locator('.header-actions').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=13));
        await page.evaluate(()=>document.documentElement.classList.remove('desktop'));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:path.join(evidence,'settings-layout-'+width+'.png')});
      }
      const group = page.locator('#billing-form').locator('..');
      await group.locator(':scope>summary').click();
      assert.equal(await page.locator('#billing-ak').isVisible(),false);
      await group.locator(':scope>summary').click();
      assert.equal(await page.locator('#billing-ak').isVisible(),true);
      const gap=await page.locator('#ai-form').evaluate(el=>el.parentElement.getBoundingClientRect().top-document.querySelector('#billing-form').parentElement.getBoundingClientRect().bottom);
      assert.ok(gap>=20,'separate platform groups have clear spacing');
    }
    if (name === 'assistant') {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.locator('#voice-picker-trigger').click();
      const voices = page.locator('#voice-picker-options');
      await voices.scrollIntoViewIfNeeded(); await voices.hover();
      assert.ok(await voices.evaluate(node => node.scrollHeight > node.clientHeight), 'voice list must overflow for boundary regression');
      const outerBefore = await page.locator('main').evaluate(node => node.scrollTop);
      assert.ok(outerBefore > 0, 'outer page can move upwards during the regression');
      for (const [position, delta] of [['top', -500], ['bottom', 500], ['near-top', -500], ['near-bottom', 500]]) {
        await voices.evaluate((node, position) => {
          const max = node.scrollHeight - node.clientHeight;
          node.scrollTop = position === 'top' ? 0 : position === 'bottom' ? max : position === 'near-top' ? 5 : max - 5;
        }, position);
        await page.mouse.wheel(0, delta); await page.waitForTimeout(100);
        assert.equal(await page.locator('main').evaluate(node => node.scrollTop), outerBefore, position + ': voice scrolling never forwards unused wheel movement to the page');
        assert.ok(await voices.evaluate((node, delta) => delta < 0 ? node.scrollTop === 0 : Math.abs(node.scrollHeight-node.clientHeight-node.scrollTop) < 1, delta), 'voice list stops at its own boundary');
      }
      await voices.evaluate(node => { node.scrollTop = 0; });
      await page.mouse.wheel(0, 100); await page.waitForFunction(() => document.querySelector('#voice-picker-options').scrollTop > 0);
      assert.equal(await page.locator('main').evaluate(node => node.scrollTop), outerBefore, 'voice list scrolls normally without moving the page');
      await page.locator('#voice-search').fill('seed_1244');
      await voices.hover();
      assert.ok(await voices.locator('[role=option]').count() > 0, 'filtered fixture contains a voice');
      assert.ok(await voices.evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'filtered voice list fits without scrolling');
      const filteredOuter = await page.locator('main').evaluate(node => node.scrollTop);
      for (const delta of [-300, 300]) {
        await page.mouse.wheel(0, delta); await page.waitForTimeout(100);
        assert.equal(await page.locator('main').evaluate(node => node.scrollTop), filteredOuter, 'a short filtered list also owns its wheel input');
      }
      await page.locator('#voice-picker-trigger').click();
      await page.locator('#model-dialog').evaluate(dialog => {
        const options = dialog.querySelector('.model-options');
        for (let index = 0; index < 60; index++) {
          const option = document.createElement('label'); option.className = 'model-option'; option.textContent = '布局验证模型 ' + index; options.append(option);
        }
        dialog.showModal();
      });
      await page.locator('#model-options').hover();
      await page.mouse.wheel(0, 350);
      await page.waitForFunction(() => document.querySelector('#model-options').scrollTop > 0);
      await page.locator('#model-dialog .atb-scrollbar:visible').first().waitFor();
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'modal list scrolling never moves the document');
      const dialog = await page.locator('#model-dialog').boundingBox(), track = await page.locator('#model-dialog .atb-scrollbar:visible').first().boundingBox();
      assert.ok(track.y >= dialog.y && track.y + track.height <= dialog.y + dialog.height, 'modal scrollbar stays in its own top layer');
      await page.screenshot({ path: path.join(evidence, 'assistant-model-dialog.png') });
      const backgroundScroll = await page.locator('main').evaluate(main => main.scrollTop);
      await page.locator('#model-options').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.locator('#model-options').hover(); await page.mouse.wheel(0, 500); await page.waitForTimeout(70);
      assert.equal(await page.locator('main').evaluate(main => main.scrollTop), backgroundScroll, 'modal boundaries never scroll the background');
      await page.locator('#close-models').click();
      await page.locator('[data-page=assistant]').click();
      await page.locator('#toggle-transcript').click();
      await page.locator('#messages').evaluate(node => { for (let i = 0; i < 40; i++) { const p = document.createElement('p'); p.textContent = '用于验证对话区独立滚动的消息 ' + i; node.append(p); } });
      await page.locator('#messages').hover();
      await page.mouse.wheel(0, 350);
      await page.waitForFunction(() => document.querySelector('#messages').scrollTop > 0);
      assert.equal(await page.locator('#messages').evaluate(node => getComputedStyle(node).scrollbarWidth), 'none', 'compact transcript has no visible inner scrollbar');
      await page.locator('#messages').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.locator('#messages').hover();
      const transcriptOuter = await page.locator('main').evaluate(node => node.scrollTop);
      await page.mouse.wheel(0, 350); await page.waitForTimeout(100);
      assert.equal(await page.locator('main').evaluate(node => node.scrollTop), transcriptOuter, 'transcript boundary does not move the outer page');
      assert.equal(await page.locator('#transcript textarea, #transcript input, #transcript form').count(), 0, 'transcript has no manual input controls');
      for (const selector of ['#prompt']) {
        await page.locator(selector).evaluate(node => { const details = node.closest('details'); if (details) details.open = true; });
        await page.locator(selector).evaluate(node => { node.value = ('多行内容\n').repeat(60); node.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.locator(selector).scrollIntoViewIfNeeded();
        await page.locator('main').evaluate(node => { node.scrollTop = Math.max(0, node.scrollTop - 100); });
        const before = await page.locator('main').evaluate(node => node.scrollTop);
        await page.locator(selector).hover(); await page.mouse.wheel(0, 220);
        await page.waitForFunction(previous => document.querySelector('main').scrollTop > previous, before);
        assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).overflowY), 'hidden', 'textarea grows instead of scrolling');
        const stationary = await page.locator('main').evaluate(node => node.scrollTop);
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
        assert.equal(await page.locator('main').evaluate(node => node.scrollTop), stationary, 'resizing unchanged assistant settings must not shrink and clamp the page scroll');
        await page.waitForResponse(response => new URL(response.url()).pathname === '/api/assistant/settings' && response.request().method() === 'GET', { timeout: 12000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('main').evaluate(node => node.scrollTop), stationary, 'periodic settings refresh preserves the scroll position with a long unsaved persona');
        assert.equal(await page.locator(selector).inputValue(), ('多行内容\n').repeat(60), 'refresh retains the unsaved persona');
        await page.locator('#persona-form [type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#persona-result').textContent === '已保存');
        await page.locator('main').evaluate(node => { node.scrollTop = node.scrollHeight; });
        const savedScroll = await page.locator('main').evaluate(node => node.scrollTop);
        await page.waitForResponse(response => new URL(response.url()).pathname === '/api/assistant/settings' && response.request().method() === 'GET', { timeout: 12000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('main').evaluate(node => node.scrollTop), savedScroll, 'periodic settings refresh preserves bottom position with a long saved persona');
        await page.locator(selector).evaluate(node => { node.dispatchEvent(new Event('input', { bubbles: true })); });


      }
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'message scroll never moves the document');
      await page.getByRole('link', { name: '返回工作台', exact: true }).click();
      await page.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
      await page.waitForURL(origin + '/platform');
    }
  }
  assert.deepEqual(errors, []);
});
