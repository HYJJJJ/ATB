import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const reserved = new Set(['/', '/platform', '/platform.js', '/platform.css', '/api/config', '/ca.crt', '/api/platform/modules', '/api/platform/settings']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const inside = (base, target) => { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
async function localFile(directory, relative, publicOnly = false) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => ['.', '..', ''].includes(part)) || (publicOnly && !relative.startsWith('public/'))) throw Error('模块路径无效');
  const resolved = await realpath(path.resolve(directory, relative));
  if (!inside(directory, resolved)) throw Error('模块路径超出目录');
  return resolved;
}
export async function loadModules({ modulesDir, context }) {
  const modules = [], errors = [], assets = new Map();
  let entries = [];
  try { entries = await readdir(modulesDir, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let instance;
    try {
      const directory = await realpath(path.join(modulesDir, entry.name));
      const manifest = JSON.parse(await readFile(path.join(directory, 'module.json'), 'utf8'));
      if (manifest.id !== entry.name || !/^[a-z][a-z0-9-]{0,39}$/.test(manifest.id) || manifest.apiVersion !== 1 || typeof manifest.name !== 'string' || manifest.name.length > 80 || typeof manifest.description !== 'string' || manifest.description.length > 500 || typeof manifest.version !== 'string' || !manifest.entry?.startsWith(`/modules/${manifest.id}/`)) throw Error('模块清单无效');
      const pending = [];
      for (const [url, relative] of Object.entries(manifest.assets || {})) {
        if (!url.startsWith('/') || url.includes('?') || url.includes('#') || new URL(url, 'https://localhost').pathname !== url || url.startsWith('/api/') || reserved.has(url) || assets.has(url)) throw Error('模块资源地址冲突或无效');
        const file = await localFile(directory, relative, true);
        if (!mime[path.extname(file)]) throw Error('模块资源类型无效');
        pending.push([url, { file, relative, type: mime[path.extname(file)] }]);
      }
      if (!pending.some(([url]) => url === manifest.entry)) throw Error('模块入口未公开');
      if (manifest.background && !pending.some(([url, asset]) => url === manifest.background && asset.type.startsWith('text/javascript'))) throw Error('模块后台入口未公开');
      const code = await import(pathToFileURL(await localFile(directory, manifest.server)).href);
      instance = await code.default(context);
      if (!instance || typeof instance !== 'object') throw Error('模块初始化失败');
      const record = { manifest, instance, directory };
      modules.push(record);
      for (const [url, asset] of pending) assets.set(url, { ...asset, module: record });
    } catch {
      try { await instance?.close?.(); } catch {}
      errors.push({ id: entry.name, error: '模块未加载，请检查清单、依赖和服务配置' });
      console.error(`ATB: 模块 ${entry.name} 未加载，请检查清单、依赖和服务配置。`);
    }
  }
  let closed = false;
  const registry = {
    modules, errors,
    get config() { return Object.assign({}, ...modules.map(item => item.instance.config || {})); },
    list() { return modules.map(({ manifest }) => Object.fromEntries(['id', 'name', 'description', 'version', 'entry', ...(manifest.background ? ['background'] : [])].map(key => [key, manifest[key]]))); },
    asset(url) { return assets.get(url); },
    async handle(req, res, pathname, requestConfig) { for (const { instance } of modules) if (await instance.handle?.(req, res, pathname, requestConfig)) return true; return false; },
    async attach(server) {
      for (const record of [...modules]) {
        try { await record.instance.attach?.(server); }
        catch {
          try { await record.instance.close?.(); } catch {}
          modules.splice(modules.indexOf(record), 1);
          for (const [url, asset] of assets) if (asset.module === record) assets.delete(url);
          errors.push({ id: record.manifest.id, error: '模块服务启动失败，请检查端口与配置' });
          console.error(`ATB: 模块 ${record.manifest.id} 启动失败，已释放其资源。`);
        }
      }
    },
    async close() { if (closed) return; closed = true; await Promise.allSettled([...modules].reverse().map(({ instance }) => instance.close?.())); },
  };
  return registry;
}
