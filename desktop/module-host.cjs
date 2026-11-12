const fs = require('node:fs');
const path = require('node:path');

const validId = value => typeof value === 'string' && value.trim() === value && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const validAction = value => typeof value === 'string' && value.trim() === value && /^[a-z][a-zA-Z0-9-]{0,63}$/.test(value);
function contained(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function desktopEntry(directory, entry) {
  if (typeof entry !== 'string' || !entry.endsWith('.cjs') || entry.includes('\\') || entry.includes(':')
      || entry.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(entry)) throw Error('Invalid desktop entry');
  const filename = fs.realpathSync(path.resolve(directory, entry));
  if (!contained(directory, filename) || !fs.statSync(filename).isFile()) throw Error('Desktop entry escapes module');
  return filename;
}

// Installed modules are trusted local code. Validation confines discovery to their
// own directories; it is not a sandbox for arbitrary third-party JavaScript.
function loadDesktopModules({ modulesRoot, context, onError = () => {} }) {
  const instances = new Map(), suspensions = new Set();
  let closed = false, closing;
  const report = (id, phase) => { try { onError({ id: validId(id) ? id : '(invalid)', phase }); } catch {} };
  let entries = [], root;
  try { root = fs.realpathSync(modulesRoot); entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') report('(root)', 'discovery'); }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let phase = 'manifest', instance;
    try {
      if (!validId(entry.name)) throw Error('Invalid module ID');
      const directory = fs.realpathSync(path.join(root, entry.name));
      if (!contained(root, directory)) throw Error('Module directory escapes root');
      const manifestFile = fs.realpathSync(path.join(directory, 'module.json'));
      if (!contained(directory, manifestFile)) throw Error('Manifest escapes module');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (!manifest || manifest.id !== entry.name || !validId(manifest.id) || manifest.apiVersion !== 1) throw Error('Invalid manifest');
      if (manifest.desktop === undefined) continue;
      phase = 'entry';
      const filename = desktopEntry(directory, manifest.desktop);
      phase = 'factory';
      const { createDesktopModule } = require(filename);
      if (typeof createDesktopModule !== 'function') throw Error('Missing desktop factory');
      instance = createDesktopModule(context);
      if (!instance || typeof instance.then === 'function' || !instance.handlers || typeof instance.handlers !== 'object'
          || (instance.suspend !== undefined && typeof instance.suspend !== 'function')
          || (instance.close !== undefined && typeof instance.close !== 'function')
          || Object.entries(instance.handlers).some(([action, handler]) => !validAction(action) || typeof handler !== 'function')) throw Error('Invalid desktop module');
      instances.set(manifest.id, instance);
    } catch {
      report(entry.name, phase);
      if (instance && typeof instance.then === 'function') Promise.resolve(instance).then(value => value?.close?.()).catch(() => report(entry.name, 'factory'));
      if (instance && typeof instance.close === 'function') Promise.resolve().then(() => instance.close()).catch(() => report(entry.name, 'close'));
    }
  }
  return {
    ids: Object.freeze([...instances.keys()]),
    hasModule(id) { return !closed && validId(id) && instances.has(id); },
    async invoke(id, action, owner, options = {}) {
      if (closed) throw Error('Desktop modules are closed');
      if (!validId(id) || !validAction(action)) throw Error('Invalid module request');
      const instance = instances.get(id);
      if (!instance) throw Error('Desktop module is not installed');
      if (!Object.hasOwn(instance.handlers, action) || typeof instance.handlers[action] !== 'function') throw Error('Unknown desktop module action');
      return instance.handlers[action](owner, options);
    },
    async suspend(owner) {
      if (closed) return;
      const task = Promise.all([...instances].map(async ([id, instance]) => {
        try { await instance.suspend?.(owner); } catch { report(id, 'suspend'); }
      }));
      suspensions.add(task);
      try { await task; } finally { suspensions.delete(task); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...suspensions]);
        await Promise.all([...instances].map(async ([id, instance]) => {
          try { await instance.close?.(); } catch { report(id, 'close'); }
        }));
      })();
      return closing;
    },
  };
}

module.exports = { loadDesktopModules, validId };
