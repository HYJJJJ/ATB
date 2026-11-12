import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServers } from '../../../server/index.js';
import { AccountStore } from '../../../server/accounts.js';

test('declared camera background activates through the platform generic bridge after login and releases its lease on logout', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-camera-background-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDir = path.join(directory, 'data');
  const accounts = await AccountStore.load(path.join(dataDir, 'account.json'));
  await accounts.setup('camera-test', 'camera-test');
  const service = await startServers({ lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, relayPort: 0, detector: null, dataDir, certDir: path.join(directory, 'certs') });
  t.after(() => service.close());
  const origin = `https://127.0.0.1:${service.secure.address().port}`;
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const login = await context.request.post(`${origin}/api/auth/login`, { data: { username: 'camera-test', password: 'camera-test' }, headers: { Origin: origin } });
  assert.equal(login.status(), 200);
  const page = await context.newPage(), commands = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('testNativeCommand', (id, action, options) => { commands.push({ id, action, options }); });
  await page.addInitScript(() => {
    window.atbDesktop = {
      isDesktop: true,
      hasModule: id => id === 'freecamera',
      async invokeModule(id, action, options) {
        await window.testNativeCommand(id, action, options);
        if (action === 'compute-open') { window.testComputeOpened = true; return { available: true, leaseId: 'background-test-lease' }; }
        if (action === 'compute-close') window.testComputeClosed = true;
        return { status: 'off', pid: null, backend: 'CPU' };
      },
    };
  });
  await page.goto(`${origin}/platform`);
  await page.waitForFunction(() => document.querySelector('#workspace')?.hidden === false);
  await page.waitForFunction(() => window.testComputeOpened === true);
  assert.ok(commands.some(command => command.id === 'freecamera' && command.action === 'compute-open'));
  await page.locator("#logout").click();
  await page.waitForFunction(() => document.querySelector("#login")?.hidden === false && window.testComputeClosed === true);
  assert.ok(commands.some(command => command.action === 'compute-close' && command.options.leaseId === 'background-test-lease'));
  assert.deepEqual(errors, []);
});
