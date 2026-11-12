import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';

const require = createRequire(import.meta.url), root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const directory = await mkdtemp(path.join(tmpdir(), 'freecamera-connections-'));
const output = path.join(root, 'test-results', 'connections');
await mkdir(output, { recursive: true });
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
const httpsPort = await port(), httpPort = await port(), origin = `https://127.0.0.1:${httpsPort}`;
let desktop, page;
const remotes = [];
async function launch() {
  const env = { ...process.env, FREECAMERA_DATA_DIR: directory, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort), TURN_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: process.env.FREECAMERA_DESKTOP_EXECUTABLE || require('electron'), args: process.env.FREECAMERA_DESKTOP_EXECUTABLE ? [] : [root], env });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000);
}
async function settings() {
  await page.locator('#connection-settings').click();
  await page.waitForURL('**/desktop/connect.html');
  await page.waitForFunction(() => !document.querySelector('#local-url').textContent.includes('undefined') && !!document.querySelector('#local-url').textContent);
}
async function mouse(button = 'back') {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 250, button, buttons: button === 'back' ? 8 : 16, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 250, button, buttons: 0, clickCount: 1 });
  await cdp.detach();
}
async function viewer(expected = origin) {
  await page.waitForURL(url => url.origin === expected && ["/platform", "/"].includes(url.pathname));
  if (new URL(page.url()).pathname === "/platform") await page.goto(`${expected}/?mode=viewer`);
  await page.locator('#connection-settings').waitFor({ state: 'visible' });
  await page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.detectionState());
}
async function importCa(filename) {
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, filename);
  await page.locator('#choose-certificate').click();
  await page.locator('#choose-certificate').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#choose-certificate').disabled);
}
function saved(origin) { return page.locator('.saved-remote').filter({ hasText: origin }); }
async function persisted() { return JSON.parse(await readFile(path.join(directory, 'data', 'desktop-connection.json'), 'utf8')); }
try {
  await launch(); await viewer();
  await settings(); await mouse(); await viewer();
  await page.screenshot({ path: path.join(output, 'back-result.png') });
  await mouse(); await mouse('forward'); await viewer();
  await settings(); await page.goBack();
  assert.match(page.url(), /\/desktop\/connect.html$/, 'raw history cannot cross between settings and hosted pages');
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('app-command', { preventDefault() {} }, 'browser-backward'); });
  await viewer();
  await settings();
  await page.locator('#remote-address').fill('saved-host.test:9443');
  await page.keyboard.press('Alt+ArrowLeft'); await page.waitForURL(`${origin}/?mode=viewer`);
  await settings();
  assert.equal(await page.locator('#remote-address').inputValue(), 'saved-host.test:9443', 'unsubmitted input must survive returning to the viewer');
  assert.equal((await persisted()).draft.address, 'saved-host.test:9443');
  await page.locator('#return-viewer').click(); await viewer();
  await desktop.close(); desktop = null;
  await launch(); await viewer(); await settings();
  assert.equal(await page.locator('#remote-address').inputValue(), 'saved-host.test:9443', 'draft survives a full app restart');

  for (let index = 0; index < 2; index++) {
    const certDir = path.join(directory, `remote-${index}`, 'certs'), remotePort = await port();
    const server = await startServers({ relayPort: 0, lanIp: '127.0.0.1', httpsPort: remotePort, httpPort: await port(), certDir, dataDir: path.join(directory, `remote-${index}`, 'data') });
    const remote = { server, origin: `https://127.0.0.1:${remotePort}`, caFile: path.join(certDir, 'ca.crt') }; remotes.push(remote);
    await page.locator('#remote-address').fill(remote.origin); await importCa(remote.caFile);
    const fingerprint = await page.locator('#certificate-info').textContent();
    await mouse(); await viewer(index ? remotes[0].origin : origin); await settings();
    assert.equal(await page.locator('#remote-address').inputValue(), remote.origin);
    assert.equal(await page.locator('#certificate-info').textContent(), fingerprint, 'draft keeps its selected CA');
    await page.locator('#connect-remote').click(); await viewer(remote.origin);
    await assert.rejects(page.evaluate(async () => (await import("/desktop-bridge.js")).cameraDesktop.saveConnectionDraft({ address: 'evil.test' })), /Untrusted/);
    await settings();
    assert.equal(await saved(remote.origin).count(), 1);
  }
  assert.equal(await page.locator('.saved-remote').count(), 2);
  await page.screenshot({ path: path.join(output, 'saved-services.png'), fullPage: true });
  await saved(remotes[0].origin).click(); await viewer(remotes[0].origin);
  await settings(); await page.locator('#connect-local').click(); await viewer();
  await settings(); assert.equal(await page.locator('.saved-remote').count(), 2);
  await saved(remotes[1].origin).click(); await viewer(remotes[1].origin);
  await settings(); await saved(remotes[0].origin).click(); await viewer(remotes[0].origin);

  // A failed draft with a different CA must neither replace the active connection
  // nor silently change its trust root on the next application start.
  await settings(); const offline = `https://127.0.0.1:${await port()}`;
  await page.locator('#remote-address').fill(offline); await importCa(remotes[1].caFile);
  await page.locator('#connect-remote').click(); await page.locator('#connection-error').waitFor({ state: 'visible' });
  assert.equal((await persisted()).origin, remotes[0].origin);
  await mouse(); await viewer(remotes[0].origin);
  await desktop.close(); desktop = null;
  await launch(); await viewer(remotes[0].origin); await settings();
  assert.equal(await page.locator('#remote-address').inputValue(), offline, 'failed draft survives remote startup');
  assert.equal(await page.locator('.saved-remote').count(), 2);
  await saved(remotes[0].origin).click(); await viewer(remotes[0].origin);
  await settings(); await page.locator('#connect-local').click(); await viewer();
  await desktop.close(); desktop = null;
  await launch(); await viewer(); await settings();
  assert.equal(await page.locator('.saved-remote').count(), 2, 'local startup retains saved remote connections');
  assert.equal((await persisted()).mode, 'local');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks: ['real mouse back and forward', 'native app-command', 'Alt+Left', 'explicit return button', 'history isolation', 'draft and CA persistence', 'two remote services with different CAs', 'one-click local/remote switching', 'failed connection preserves active service', 'restart with unrelated draft CA', 'hosted page cannot modify settings'] }, null, 2));
  console.log('PASS: mouse Back, keyboard Back, return button, persisted drafts/CAs, one-click service history, failed connection recovery and full restart');
} finally {
  await desktop?.close();
  for (const remote of remotes) await remote.server.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
