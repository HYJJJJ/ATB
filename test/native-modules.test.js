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
  let ready, win, context, beforeRequest, confirmTimer, dirty = false, leaveDialog = () => false, saveDialog = async () => ({ canceled: true });
  Object.assign(app, { isPackaged: true, setName(name) { this.name = name; }, getPath: name => paths[name] || `C:\\Profiles\\${app.name}`, setPath: (name, value) => { paths[name] = value; }, setAppUserModelId: id => { app.modelId = id; }, getVersion: () => '0.6.0', requestSingleInstanceLock: () => true, quit: () => events.push('quit'), whenReady: () => ({ then(callback) { ready = callback(); return ready; } }) });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); win = this; this.options = options;
      const contents = this.webContents = new EventEmitter();
      Object.assign(contents, { id: 12, isDestroyed: () => false, mainFrame: { url: '' }, send: (...args) => events.push(['send', ...args]), getURL: () => contents.mainFrame.url, navigationHistory: { clear() {} }, executeJavaScript: async source => { events.push(source); return source.includes('atbConfirmLeave') ? leaveDialog() : source.includes('atbHasUnsavedChanges') ? dirty : false; }, session: { setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle() {} }, webRequest: { onBeforeRequest(callback) { beforeRequest=callback; } } }, setWindowOpenHandler() {} });
    }
    isDestroyed() { return false; }
    isMaximized() { return Boolean(this.maximized); }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    minimize() { events.push('minimize'); }
    isMinimized() { return false; }
    show() { events.push('show'); }
    focus() { events.push('focus'); }
    close() { events.push('window-close'); }
    async loadURL(url) { if (this.webContents.mainFrame.url && this.testBlockedLoad) { let allowed = false; this.webContents.emit('will-prevent-unload', { preventDefault() { allowed = true; } }); if (!allowed) return; this.testAllowedLoad = true; } this.webContents.mainFrame.url = url; }
    async loadFile(filename) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(filename).href; }
  }
  const modules = { ids: ['example'], remoteUi: [], invoke: async (...args) => { events.push(['invoke', ...args]); return true; }, suspend: async owner => events.push(['suspend', owner]), close: async () => events.push('modules-close') };
  const electron = { app, BrowserWindow, ipcMain: { handle: (channel, callback) => ipc.set(channel, callback) }, dialog: { showMessageBoxSync: (...args) => leaveDialog(...args), showSaveDialog: (...args) => saveDialog(...args), showErrorBox: (...args) => events.push(['error', ...args]) }, Notification: { isSupported: () => false }, Menu: { setApplicationMenu() {} } };
  const service = { loadConnectionProfile: async () => ({ mode: 'remote', origin: 'https://127.0.0.1:8443', ca: 'preserved-ca', remotes: [] }), connectLocalService: async () => ({ origin: 'https://127.0.0.1:8443', ca: 'local-ca', platform: true, close: async () => {} }), connectRemoteService: async ({ address }) => ({ origin: address, ca: 'preserved-ca', platform: true, remote: true }), saveConnectionProfile: async () => {}, validateRoot: () => ({}) };
  vm.runInNewContext(await readFile(path.join(projectRoot, 'desktop/main.cjs'), 'utf8'), { require(name) { if (name === 'electron') return electron; if (name === './module-host.cjs') return { loadDesktopModules(options) { context = options.context; return modules; } }; if (name === './service.cjs') return service; if (name === 'node:fs') return { mkdirSync() {} }; return require(name.startsWith('./') ? path.join(projectRoot, 'desktop', name) : name); }, __dirname: path.join(projectRoot, 'desktop'), process: { platform: 'win32', env }, console, URL, setTimeout(callback,ms,...args) { if(ms===45000)confirmTimer=callback;return setTimeout(callback,ms,...args); }, clearTimeout });
  await ready;
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return { ipc, events, win, app, paths, context, event, expireConfirm() { confirmTimer(); }, request(details){let result;beforeRequest(details,value=>{result=value;});return result;}, setDirty(value) { dirty = value; }, setSaveDialog(callback) { saveDialog = callback; }, setLeaveDialog(callback) { leaveDialog = callback; } };
}

test('desktop action approval binds the themed dialog to its request and rejects abort, timeout or navigation',async()=>{
 const shell=await desktopHarness(),contents=shell.win.webContents,calls=[];let release;
 contents.executeJavaScript=async source=>{calls.push(source);return source.includes('atbCancelConfirm')?false:new Promise(resolve=>release=resolve);};
 const details={title:'确认操作应用',message:'点击模拟按钮',detail:'Test input：测试123'};
 const approved=shell.context.confirmDesktopAction(details);await new Promise(r=>setImmediate(r));
 assert.ok(calls[0].includes('window.atbConfirm'));assert.ok(calls[0].includes('requestId'));release(true);assert.equal(await approved,true);
 const controller=new AbortController(),cancelled=shell.context.confirmDesktopAction(details,{signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(cancelled);assert.ok(calls.at(-1).includes('atbCancelConfirm'));
 const timeout=shell.context.confirmDesktopAction(details);await new Promise(r=>setImmediate(r));shell.expireConfirm();assert.equal(await timeout,false);assert.ok(calls.at(-1).includes('atbCancelConfirm'));
 const moved=shell.context.confirmDesktopAction(details);await new Promise(r=>setImmediate(r));contents.mainFrame.url+='?another';release(true);assert.equal(await moved,false,'approval cannot cross navigation');
});

test('session requests without a webContents ID cannot throw native conversion errors',async()=>{
 const shell=await desktopHarness();assert.equal(shell.request({url:'https://127.0.0.1:8443/api/auth/session'}).cancel,false);
 assert.equal(shell.request({url:'https://outside.example/test'}).cancel,true);
 const unregister=shell.context.registerBackground({id:99,isDestroyed:()=>false});
 assert.equal(shell.request({url:'https://127.0.0.1:8443/modules/assistant/companion.js',webContentsId:99}).cancel,false);unregister();
 assert.equal(shell.request({url:'https://127.0.0.1:8443/api/auth/session',webContentsId:undefined}).cancel,false);
});

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


test('shared window controls work in modules and connection settings and reject foreign frames', async () => {
  const shell = await desktopHarness(), control = shell.ipc.get('atb:window');
  assert.equal(typeof control, 'function');
  assert.equal(shell.win.options.frame, false);
  assert.equal((await control(shell.event(), 'state')).maximized, false);
  assert.equal((await control(shell.event(), 'maximize')).maximized, true);
  assert.equal((await control(shell.event(), 'maximize')).maximized, false);
  await control(shell.event(), 'minimize');
  assert.ok(shell.events.includes('minimize'));
  assert.ok(shell.events.some(event => Array.isArray(event) && event[0] === 'send' && event[1] === 'atb:window-state'));
  assert.throws(() => control({ sender: shell.win.webContents, senderFrame: { url: shell.win.webContents.getURL() } }, 'minimize'), /Untrusted/);
  assert.throws(() => control(shell.event(), 'execute'), /Invalid/);
  await shell.ipc.get('atb:connection-settings')(shell.event());
  assert.equal((await control(shell.event(), 'state')).maximized, false);
  await control(shell.event(), 'close');
  assert.ok(shell.events.includes('window-close'));
  shell.win.webContents.mainFrame.url = 'https://other.test/';
  assert.throws(() => control(shell.event(), 'close'), /Untrusted/);
});


test('desktop unload guard defaults to keeping drafts and retries approved navigation only while the page is current', async () => {
  const shell = await desktopHarness(), contents = shell.win.webContents;
  const original = contents.getURL(), target = 'https://127.0.0.1:8443/platform?next';
  let bypassed = false;
  const event = { preventDefault() { bypassed = true; } };
  contents.emit('did-start-navigation', {}, target, false, true);
  contents.emit('will-prevent-unload', event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contents.getURL(), original);
  assert.equal(bypassed, false);
  let resolveChoice, prompts = 0;
  shell.setLeaveDialog(() => { prompts++; return new Promise(resolve => { resolveChoice = resolve; }); });
  contents.emit('will-prevent-unload', event);
  contents.emit('will-prevent-unload', event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts, 1);
  shell.win.testBlockedLoad = true;
  resolveChoice(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contents.getURL(), target);
  assert.equal(shell.win.testAllowedLoad, true);
  bypassed = false; contents.mainFrame.url = original;
  contents.emit('did-start-navigation', {}, target, false, true);
  contents.emit('will-prevent-unload', event);
  await new Promise(resolve => setImmediate(resolve));
  contents.mainFrame.url = 'https://untrusted.test/';
  resolveChoice(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contents.getURL(), 'https://untrusted.test/');
  contents.emit('will-prevent-unload', event);
  assert.equal(bypassed, false);
});

test('quitting dirty settings asks once and cancel preserves the app before any cleanup', async () => {
  const shell = await desktopHarness(); shell.setDirty(true);
  let resolveChoice, prompts = 0;
  shell.setLeaveDialog(() => { prompts++; return new Promise(resolve => { resolveChoice = resolve; }); });
  shell.app.emit('before-quit', { preventDefault() {} });
  shell.app.emit('before-quit', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(shell.events.includes('modules-close'), false);
  resolveChoice(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shell.events.includes('quit'), false);
  shell.setLeaveDialog(() => true);
  shell.app.emit('before-quit', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shell.events.includes('modules-close'), true);
  assert.equal(shell.events.includes('quit'), true);
});

test('opening connection settings retains dirty page and avoids cleanup when leave is canceled', async () => {
  const shell = await desktopHarness(), original = shell.win.webContents.getURL();
  shell.setDirty(true); shell.setLeaveDialog(() => false);
  await shell.ipc.get('atb:connection-settings')(shell.event());
  assert.equal(shell.win.webContents.getURL(), original);
  assert.equal(shell.events.some(event => Array.isArray(event) && event[0] === 'suspend'), false);
  shell.setLeaveDialog(() => true);
  await shell.ipc.get('atb:connection-settings')(shell.event());
  assert.match(shell.win.webContents.getURL(), /connect.html$/);
});
