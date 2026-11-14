const { isTrustedUrl } = require('./trust.cjs');

// A module can use a remote service without replacing its installed interface.
// Keep its original origin for cookies, WebSockets and WebRTC configuration.
function createUiSource({ local, selected, modules }) {
  const remote = () => { const target = selected(); return target?.remote && target.origin !== local()?.origin ? target : null; };
  function remoteModule(value) {
    const target = remote();
    if (!target || !isTrustedUrl(value, target.origin)) return null;
    const url = new URL(value);
    return modules.find(module => module.pages.includes(url.pathname)
      || module.legacyViewer && url.pathname === '/' && url.searchParams.get('mode') === 'viewer') || null;
  }
  return {
    remoteModule,
    trustedPage(value) { return Boolean(local() && isTrustedUrl(value, local().origin) || remoteModule(value)); },
    trustedNavigation(value) { return this.trustedPage(value) || Boolean(remote() && isTrustedUrl(value, remote().origin) && new URL(value).pathname === '/platform'); },
    trustedRequest(value) {
      return [local(), remote()].some(target => target && isTrustedUrl(value.replace(/^wss:/, 'https:').replace(/^blob:/, ''), target.origin));
    },
    route(value) {
      const home = local(), target = remote();
      if (!home || !target) return null;
      const url = new URL(value);
      if (isTrustedUrl(value, home.origin)) {
        const module = modules.find(module => module.pages.includes(url.pathname)
          || module.legacyViewer && url.pathname === '/' && url.searchParams.get('mode') === 'viewer');
        if (module) return { redirect: target.origin + url.pathname + url.search };
      }
      if (!isTrustedUrl(value, target.origin)) return null;
      if (url.pathname === '/platform') return { redirect: home.origin + '/platform' + url.hash };
      if (modules.some(module => module.assets.includes(url.pathname)) || ['/ui.css', '/ui.js', '/platform.css', '/ai-presets.js'].includes(url.pathname)) return { asset: home.origin + url.pathname + url.search };
      const module = remoteModule(value);
      if (module?.legacyViewer && url.pathname === '/') return { asset: home.origin + module.entry + url.search };
      return null;
    },
  };
}

module.exports = { createUiSource };
