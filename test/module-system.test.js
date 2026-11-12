import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadModules } from '../server/modules.js';
import { SharedSettings } from '../server/shared-settings.js';
import { startServers } from '../server/index.js';
import https from 'node:https';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'atb-modules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(root, id, extra = {}) {
  const directory = path.join(root, id);
  await mkdir(path.join(directory, 'public'), { recursive: true });
  await mkdir(path.join(directory, 'server'), { recursive: true });
  await writeFile(path.join(directory, 'public/index.html'), '<h1>Installed module</h1>');
  await writeFile(path.join(directory, 'server/index.mjs'), 'export default async () => ({config:{example:true},handle:async()=>false,close:async()=>{}})');
  await writeFile(path.join(directory, 'module.json'), JSON.stringify({ id, name: id, description: 'Example', version: '1.0.0', apiVersion: 1, entry: `/modules/${id}/`, server: 'server/index.mjs', assets: { [`/modules/${id}/`]: 'public/index.html' }, ...extra }));
}
test('removing a module folder removes its manifest, page and API after restart', async t => {
  const root = await temporary(t);
  await fixture(root, 'example');
  let registry = await loadModules({ modulesDir: root, context: {} });
  assert.equal(registry.list()[0].id, 'example');
  assert.ok(registry.asset('/modules/example/'));
  await registry.close();
  await rm(path.join(root, 'example'), { recursive: true });
  registry = await loadModules({ modulesDir: root, context: {} });
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.asset('/modules/example/'), undefined);
  assert.equal(await registry.handle({}, {}, '/api/example/state', {}), false);
  await registry.close();
});
test('a corrupt module or unsafe public asset cannot prevent other modules from loading', async t => {
  const root = await temporary(t);
  await fixture(root, 'good');
  await fixture(root, 'unsafe', { assets: { '/modules/unsafe/': '../private.json' } });
  await mkdir(path.join(root, 'broken')); await writeFile(path.join(root, 'broken/module.json'), '{');
  const registry = await loadModules({ modulesDir: root, context: {} });
  assert.deepEqual(registry.list().map(m => m.id), ['good']);
  assert.equal(registry.asset('/modules/unsafe/'), undefined);
  assert.equal(registry.errors.length, 2);
  await registry.close();
});
test('shared settings survive reload and concurrent updates without lost sections', async t => {
  const root = await temporary(t), settings = await SharedSettings.load(root);
  await Promise.all([
    settings.update('server', () => ({ publicHost: 'example.com' })),
    settings.update('ai', () => ({ apiKey: 'fixture-key', model: 'example' })),
    settings.update('server', old => ({ ...old, label: 'Home' })),
  ]);
  const copy = settings.get('ai'); copy.apiKey = 'overwritten';
  assert.equal(settings.get('ai').apiKey, 'fixture-key');
  const loaded = await SharedSettings.load(root);
  assert.deepEqual(loaded.get('server'), { publicHost: 'example.com', label: 'Home' });
  assert.equal(loaded.get('ai').model, 'example');
  await assert.rejects(settings.update('__proto__', () => ({})));
  await assert.rejects(settings.update('server', () => Promise.resolve({})), /同步|synchronous/);
});
test('core-only server boots without camera relay configuration and serves a useful platform', async t => {
  const root = await temporary(t);
  const server = await startServers({ modulesDir: path.join(root, 'no-modules'), lanIp: '127.0.0.1', httpsPort: 0, httpPort: 0, certDir: path.join(root, 'certs'), dataDir: path.join(root, 'data'), relayPort: 0 });
  t.after(() => server.close());
  const ca = await readFile(path.join(root, 'certs/ca.crt'));
  const get = pathname => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: server.secure.address().port, path: pathname, ca }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
  });
  const home = await get('/platform'); assert.equal(home.status, 200); assert.match(home.body, /All The Best/);
  const config = await get('/api/config'); assert.equal(JSON.parse(config.body).app, 'atb'); assert.deepEqual(JSON.parse(config.body).modules, []);
  assert.equal((await get('/api/platform/settings')).status, 401);
  assert.equal((await get('/api/platform/modules')).status, 401);
  assert.equal((await get('/app.js')).status, 404);
  assert.equal((await get('/api/rustdesk/config')).status, 404);
});
