import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const dir = await mkdtemp(path.join(tmpdir(), 'freecamera-layout-'));
const service = await startServers({ lanIp: '127.0.0.1', httpsPort: await port(), httpPort: await port(), relayPort: 0, certDir: path.join(dir, 'certs'), dataDir: path.join(dir, 'data'), detector: null });
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const camera = await context.newPage(), viewer = await context.newPage();
  const base = `https://127.0.0.1:${service.secure.address().port}`;
  await camera.goto(`${base}/?mode=camera`); await camera.locator('#start').click();
  await camera.waitForFunction(() => /^\d{8}$/.test(document.querySelector('#pair-code').textContent));
  await viewer.goto(`${base}/?mode=viewer`); await loginViewer(viewer); await viewer.locator('.device-connect').click();
  await viewer.waitForFunction(() => document.querySelector('video').videoWidth > 0 && document.querySelector('#status').textContent === '实时画面');
  await mkdir('test-results/ux-audit', { recursive: true });
  for (const [name, page] of [['monitor', camera], ['viewer', viewer]]) {
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(await page.evaluate(async () => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width}`);
      if (width === 390 || width === 1440) await page.screenshot({ path: `test-results/ux-audit/${name}-${width}.png`, fullPage: true });
    }
  }
  console.log('PASS: live camera and viewer layouts at 5 screen widths, actual video decoded');
} finally { await browser.close(); await service.close(); await rm(dir, { recursive: true, force: true }); }
