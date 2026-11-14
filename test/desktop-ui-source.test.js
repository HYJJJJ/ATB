import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUiSource } = require('../desktop/ui-source.cjs');
const home = { origin: 'https://127.0.0.1:8443' };
const cloud = { origin: 'https://camera.example:9443', remote: true };
const camera = { id: 'camera', entry: '/modules/camera/', pages: ['/modules/camera/', '/modules/camera/index.html'], assets: ['/modules/camera/', '/modules/camera/index.html', '/camera.js', '/camera.css'], legacyViewer: true };

test('desktop UI routing replaces remote module assets while keeping APIs and WebSockets on their service', () => {
  const source = createUiSource({ local: () => home, selected: () => cloud, modules: [camera] });
  assert.deepEqual(source.route(home.origin + '/modules/camera/?mode=viewer&v=2'), { redirect: cloud.origin + '/modules/camera/?mode=viewer&v=2' });
  assert.deepEqual(source.route(cloud.origin + '/modules/camera/?mode=viewer&v=2'), { asset: home.origin + '/modules/camera/?mode=viewer&v=2' });
  assert.deepEqual(source.route(cloud.origin + '/?mode=viewer'), { asset: home.origin + '/modules/camera/?mode=viewer' });
  assert.deepEqual(source.route(cloud.origin + '/camera.js?v=2'), { asset: home.origin + '/camera.js?v=2' });
  assert.deepEqual(source.route(cloud.origin + '/ui.css'), { asset: home.origin + '/ui.css' });
  assert.deepEqual(source.route(cloud.origin + '/platform#settings/ai'), { redirect: home.origin + '/platform#settings/ai' });
  for (const path of ['/api/auth/login', '/api/config', '/signal', '/qr.svg']) assert.equal(source.route(cloud.origin + path), null);
  assert.equal(source.route(home.origin + '/modules/assistant/'), null);
  assert.equal(source.route(home.origin + '/?mode=camera'), null);
  assert.equal(source.trustedRequest('wss://camera.example:9443/signal'), true);
  assert.equal(source.trustedRequest('blob:' + cloud.origin + '/recording'), true);
});

test('a remote camera page cannot claim the platform or another native module origin', () => {
  const source = createUiSource({ local: () => home, selected: () => cloud, modules: [camera] });
  assert.equal(source.trustedPage(home.origin + '/platform'), true);
  assert.equal(source.trustedPage(cloud.origin + '/modules/camera/'), true);
  assert.equal(source.remoteModule(cloud.origin + '/modules/camera/').id, 'camera');
  assert.equal(source.trustedPage(cloud.origin + '/platform'), false);
  assert.equal(source.trustedNavigation(cloud.origin + '/platform'), true);
  for (const value of [cloud.origin + '/modules/assistant/', 'https://camera.example:9444/modules/camera/', 'https://camera.example.evil.test:9443/modules/camera/', 'https://user:pass@camera.example:9443/modules/camera/', 'http://camera.example:9443/modules/camera/', 'file:///tmp/module.html']) {
    assert.equal(source.trustedPage(value), false, value);
  }
  assert.equal(source.trustedRequest('wss://other.example/signal'), false);
  assert.equal(source.trustedRequest('blob:https://other.example/recording'), false);
});

test('switching to local service and removing modules removes remote UI routing', () => {
  let selected = cloud;
  const source = createUiSource({ local: () => home, selected: () => selected, modules: [camera] });
  assert.ok(source.route(home.origin + '/modules/camera/'));
  selected = home;
  assert.equal(source.route(home.origin + '/modules/camera/'), null);
  assert.equal(source.trustedPage(cloud.origin + '/modules/camera/'), false);
  const core = createUiSource({ local: () => home, selected: () => cloud, modules: [] });
  assert.equal(core.route(home.origin + '/modules/camera/'), null);
  assert.equal(core.remoteModule(cloud.origin + '/modules/camera/'), null);
});
