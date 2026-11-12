import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { loadDesktopModules } = require('../desktop/module-host.cjs');
const projectRoot = path.resolve(import.meta.dirname, '..');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'atb-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function moduleFile(root, id, source, manifest = {}) {
  const directory = path.join(root, id);
  await mkdir(path.join(directory, 'desktop'), { recursive: true });
  await writeFile(path.join(directory, 'module.json'), JSON.stringify({ id, apiVersion: 1, desktop: 'desktop/index.cjs', ...manifest }));
  await writeFile(path.join(directory, 'desktop/index.cjs'), source);
  return directory;
}

test('desktop discovery supports an absent modules directory and optional desktop entries', async t => {
  const root = await fixture(t);
  assert.deepEqual(loadDesktopModules({ modulesRoot: path.join(root, 'missing'), context: {} }).ids, []);
  await moduleFile(root, 'browser-only', 'throw Error("must not load")', { desktop: undefined });
  assert.deepEqual(loadDesktopModules({ modulesRoot: root, context: {} }).ids, []);
});

test('trusted native factories receive context and dispatch only declared own handlers', async t => {
  const root = await fixture(t), events = [];
  await moduleFile(root, 'example', `exports.createDesktopModule = context => ({ handlers: { echo: (owner, options) => ({ owner, options, root: context.dataRoot }) }, close: () => context.events.push('closed') });`);
  const host = loadDesktopModules({ modulesRoot: root, context: { dataRoot: 'preserved-data', events } });
  assert.deepEqual(host.ids, ['example']);
  assert.equal(host.hasModule('example'), true);
  assert.equal(host.hasModule('../example'), false);
  assert.deepEqual(await host.invoke('example', 'echo', 31, { a: 1 }), { owner: 31, options: { a: 1 }, root: 'preserved-data' });
  await assert.rejects(host.invoke('absent', 'echo', 31), /not installed/);
  for (const action of ['constructor', 'toString', 'unknown']) await assert.rejects(host.invoke('example', action, 31), /Unknown/);
  for (const id of ['../example', 'C:\\example', 'example/child', '__proto__', 'Example', 'example\n']) await assert.rejects(host.invoke(id, 'echo', 31), /Invalid/);
  await assert.rejects(host.invoke('example', 'echo\n', 31), /Invalid/);
  await host.close();
  await host.close();
  assert.deepEqual(events, ['closed']);
  assert.equal(host.hasModule('example'), false);
  await assert.rejects(host.invoke('example', 'echo', 31), /closed/);
});

test('malformed manifests, paths, factories and handlers are isolated from healthy modules', async t => {
  const root = await fixture(t), failures = [];
  await moduleFile(root, 'healthy', 'exports.createDesktopModule = () => ({handlers:{status:()=>true}});');
  await moduleFile(root, 'broken', 'throw Error("secret detail must not appear in diagnostics")');
  await moduleFile(root, 'invalid-handler', 'exports.createDesktopModule = () => ({handlers:{status:42}});');
  await moduleFile(root, 'id-mismatch', '', { id: 'another' });
  await moduleFile(root, 'unsupported', '', { apiVersion: 2 });
  await moduleFile(root, 'bad-json', '');
  await writeFile(path.join(root, 'bad-json/module.json'), '{');
  for (const [index, entry] of ['../healthy/desktop/index.cjs', '/outside.cjs', 'C:/outside.cjs', 'desktop\\index.cjs', 'desktop/../desktop/index.cjs', 'desktop/index.js'].entries()) await moduleFile(root, `path-${index}`, '', { desktop: entry });
  const host = loadDesktopModules({ modulesRoot: root, context: {}, onError: failure => failures.push(failure) });
  assert.deepEqual(host.ids, ['healthy']);
  assert.equal(await host.invoke('healthy', 'status', 1), true);
  assert.equal(failures.length, 11);
  assert.equal(JSON.stringify(failures).includes('secret'), false);
});

test('real paths cannot escape the installed module directory through links', async t => {
  const root = await fixture(t), outside = await fixture(t), failures = [];
  await mkdir(path.join(root, 'linked'), { recursive: true });
  await writeFile(path.join(root, 'linked/module.json'), JSON.stringify({ id: 'linked', apiVersion: 1, desktop: 'desktop/index.cjs' }));
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'index.cjs'), 'throw Error("outside loaded")');
  await symlink(outside, path.join(root, 'linked/desktop'), process.platform === 'win32' ? 'junction' : 'dir');
  const host = loadDesktopModules({ modulesRoot: root, context: {}, onError: value => failures.push(value) });
  assert.deepEqual(host.ids, []);
  assert.deepEqual(failures, [{ id: 'linked', phase: 'entry' }]);
});

test('unsupported asynchronous factories cannot create an unhandled startup rejection', async t => {
  const root = await fixture(t), failures = [];
  await moduleFile(root, 'async-factory', 'exports.createDesktopModule = async () => { throw Error("unhandled"); };');
  const host = loadDesktopModules({ modulesRoot: root, context: {}, onError: value => failures.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(host.ids, []);
  assert.ok(failures.length > 0);
});

test('suspension cleans all modules and close waits for cleanup while isolating failures', async t => {
  const root = await fixture(t), events = [], failures = [];
  let resume;
  const wait = new Promise(resolve => { resume = resolve; });
  await moduleFile(root, 'one', `exports.createDesktopModule = c => ({handlers:{}, async suspend(owner){c.events.push(['suspend',owner]); await c.wait; c.events.push('suspended');},close(){c.events.push('close-one');}});`);
  await moduleFile(root, 'two', `exports.createDesktopModule = c => ({handlers:{},suspend(){throw Error('failed');},close(){c.events.push('close-two');throw Error('failed');}});`);
  const host = loadDesktopModules({ modulesRoot: root, context: { events, wait }, onError: failure => failures.push(failure) });
  const suspension = host.suspend(19);
  const closing = host.close();
  assert.deepEqual(events, [['suspend', 19]]);
  resume();
  await Promise.all([suspension, closing]);
  assert.deepEqual(events, [['suspend', 19], 'suspended', 'close-one', 'close-two']);
  assert.deepEqual(failures, [{ id: 'two', phase: 'suspend' }, { id: 'two', phase: 'close' }]);
});

test('sandboxed preload exposes generic APIs and synchronously validates installed IDs', async () => {
  const source = await readFile(path.join(projectRoot, 'desktop/preload.cjs'), 'utf8');
  for (const argument of ['--atb-modules=' + encodeURIComponent(JSON.stringify(['example'])), '--atb-modules=%invalid', '--atb-modules=' + encodeURIComponent(JSON.stringify(['../escape']))]) {
    const calls = [], exposed = {};
    vm.runInNewContext(source, {
      require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer: { invoke: async (...args) => { calls.push(args); } } }),
      process: { argv: ['electron', argument] }, window: { addEventListener() {} },
    });
    const api = exposed.atbDesktop;
    assert.equal(api.isDesktop, true);
    assert.equal(api.hasModule('example'), argument.includes('%invalid') || argument.includes('escape') ? false : true);
    assert.equal(api.hasModule('../example'), false);
    assert.equal(api.beginRecording, undefined);
    assert.equal(api.voice, undefined);
    assert.equal(exposed.freecameraDesktop, undefined);
    await api.invokeModule('example', 'status', { value: 1 });
    assert.equal(calls[0][0], 'atb:module');
    assert.equal(calls[0][1].id, 'example');
    await assert.rejects(api.invokeModule('../escape', 'status'), /Invalid/);
    await assert.rejects(api.invokeModule('example', '../status'), /Invalid/);
    await assert.rejects(api.invokeModule('example\n', 'status'), /Invalid/);
    await assert.rejects(api.invokeModule('example', 'status\n'), /Invalid/);
  }
});

async function desktopHarness(env = {}) {
  const ipc = new Map(), events = [], paths = {}, app = new EventEmitter();
  let ready, win, context, saveDialog = async () => ({ canceled: true });
  Object.assign(app, { isPackaged: true, setName(name) { this.name = name; }, getPath: name => paths[name] || `C:\\Profiles\\${app.name}`, setPath: (name, value) => { paths[name] = value; }, setAppUserModelId: id => { app.modelId = id; }, getVersion: () => '0.6.0', requestSingleInstanceLock: () => true, quit: () => events.push('quit'), whenReady: () => ({ then(callback) { ready = callback(); return ready; } }) });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); win = this; this.options = options;
      const contents = this.webContents = new EventEmitter();
      Object.assign(contents, { id: 12, mainFrame: { url: '' }, getURL: () => contents.mainFrame.url, navigationHistory: { clear() {} }, executeJavaScript: async source => events.push(source), session: { setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }, setWindowOpenHandler() {} });
    }
    isDestroyed() { return false; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    async loadFile(filename) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(filename).href; }
  }
  const modules = { ids: ['example'], invoke: async (...args) => { events.push(['invoke', ...args]); return true; }, suspend: async owner => events.push(['suspend', owner]), close: async () => events.push('modules-close') };
  const electron = { app, BrowserWindow, ipcMain: { handle: (channel, callback) => ipc.set(channel, callback) }, dialog: { showSaveDialog: (...args) => saveDialog(...args), showErrorBox: (...args) => events.push(['error', ...args]) }, Notification: { isSupported: () => false }, Menu: { setApplicationMenu() {} } };
  const service = { loadConnectionProfile: async () => ({ mode: 'remote', origin: 'https://127.0.0.1:8443', ca: 'preserved-ca', remotes: [] }), connectRemoteService: async ({ address }) => ({ origin: address, ca: 'preserved-ca', platform: true }), saveConnectionProfile: async () => {}, validateRoot: () => ({}) };
  vm.runInNewContext(await readFile(path.join(projectRoot, 'desktop/main.cjs'), 'utf8'), { require(name) { if (name === 'electron') return electron; if (name === './module-host.cjs') return { loadDesktopModules(options) { context = options.context; return modules; } }; if (name === './service.cjs') return service; if (name === 'node:fs') return { mkdirSync() {} }; return require(name.startsWith('./') ? path.join(projectRoot, 'desktop', name) : name); }, __dirname: path.join(projectRoot, 'desktop'), process: { platform: 'win32', env }, console, URL, setTimeout, clearTimeout });
  await ready;
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return { ipc, events, win, app, paths, context, event, setSaveDialog(callback) { saveDialog = callback; } };
}

test('main preserves legacy profile, chooses ATB data override, and applies sender trust before generic dispatch', async () => {
  const shell = await desktopHarness({ ATB_DATA_DIR: 'E:\\ATB-test', FREECAMERA_DATA_DIR: 'E:\\legacy-test' });
  assert.equal(shell.app.name, 'ATB');
  assert.equal(shell.app.modelId, 'local.atb.desktop');
  assert.equal(shell.context.dataRoot, path.resolve('E:\\ATB-test'));
  assert.equal(shell.paths.userData, path.join(path.resolve('E:\\ATB-test'), 'desktop-profile'));
  assert.equal(shell.win.webContents.getURL(), 'https://127.0.0.1:8443/platform');
  assert.ok(shell.win.options.webPreferences.additionalArguments[0].startsWith('--atb-modules='));
  const dispatch = shell.ipc.get('atb:module'), options = { id: 'example', action: 'status', options: { test: true } };
  assert.equal(await dispatch(shell.event(), options), true);
  assert.equal(shell.events.filter(event => Array.isArray(event) && event[0] === 'invoke').length, 1);
  for (const event of [{ sender: {}, senderFrame: shell.win.webContents.mainFrame }, { sender: shell.win.webContents, senderFrame: { url: shell.win.webContents.getURL() } }]) assert.throws(() => dispatch(event, options), /Untrusted/);
  shell.win.webContents.mainFrame.url = 'https://other.test/';
  assert.throws(() => dispatch(shell.event(), options), /Untrusted/);
  const legacy = await desktopHarness();
  assert.equal(legacy.paths.userData, 'C:\\Profiles\\FreeCamera');
});

test('main suspends modules on navigation, renderer failure, settings and destruction, then closes on quit', async () => {
  const shell = await desktopHarness(), contents = shell.win.webContents;
  contents.emit('did-start-navigation', {}, '/new', false, false);
  assert.equal(shell.events.length, 0);
  contents.emit('did-start-navigation', {}, '/new', false, true);
  contents.emit('render-process-gone');
  await shell.ipc.get('atb:connection-settings')(shell.event());
  assert.ok(shell.events.includes('Promise.resolve(window.atbPrepareClose?.())'));
  assert.equal(shell.events.filter(event => Array.isArray(event) && event[0] === 'suspend').length, 3);
  assert.throws(() => shell.ipc.get('atb:module')(shell.event(), {}), /Untrusted/);
  contents.emit('destroyed');
  shell.app.emit('before-quit', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(shell.events.includes('modules-close'));
  assert.ok(shell.events.includes('quit'));
});

test('save dialogs retain the owner lock and reject results after navigation', async () => {
  const shell = await desktopHarness();
  let release;
  shell.setSaveDialog(() => new Promise(resolve => { release = resolve; }));
  const first = shell.context.chooseFile(12, {});
  await assert.rejects(shell.context.chooseFile(12, {}), /already open/);
  await assert.rejects(shell.context.chooseFile(99, {}), /Untrusted/);
  shell.win.webContents.mainFrame.url += '/another-page';
  release({ filePath: 'private-save', canceled: false });
  assert.equal((await first).canceled, true);
  shell.setSaveDialog(async () => ({ canceled: true }));
  assert.equal((await shell.context.chooseFile(12, {})).canceled, true);
});
