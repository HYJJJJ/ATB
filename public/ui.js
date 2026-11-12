const root = document.documentElement;
if (window.atbDesktop) root.classList.add('desktop');
document.body.classList.add('atb-ready');
function visibility() { root.dataset.motion = document.hidden ? 'paused' : 'running'; }
visibility();
document.addEventListener('visibilitychange', visibility);
window.addEventListener('pageshow', () => root.classList.remove('atb-leaving'));
let leaving = false;
export function navigateModule(href) {
  const target = new URL(href, location.href);
  if (target.origin !== location.origin || leaving) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { location.assign(target.href); return; }
  leaving = true; root.classList.add('atb-leaving');
  setTimeout(() => {
    location.assign(target.href);
    // Restore the current page if a beforeunload prompt cancels navigation.
    setTimeout(() => { leaving = false; root.classList.remove('atb-leaving'); }, 350);
  }, 120);
}
document.addEventListener('click', event => {
  // Camera navigation finalizes the last recording chunk before leaving.
  if (typeof window.atbPrepareClose === 'function') return;
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]');
  if (!link || link.target || link.hasAttribute('download')) return;
  const target = new URL(link.href, location.href);
  if (target.origin !== location.origin || target.pathname === location.pathname || !/^\/(?:platform|modules\/)/.test(target.pathname)) return;
  event.preventDefault(); navigateModule(target.href);
});
