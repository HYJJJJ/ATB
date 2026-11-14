const root = document.documentElement;
if (window.atbDesktop) root.classList.add('desktop');
document.body.classList.add('atb-ready');
function visibility() { root.dataset.motion = document.hidden ? 'paused' : 'running'; }
visibility();
document.addEventListener('visibilitychange', visibility);
window.addEventListener('pageshow', () => root.classList.remove('atb-leaving'));

// Keep native wheel/touch/keyboard scrolling, with an overlay only for the thumb.
const scrollbars = new Map();
let scrollFrame = 0, discoverScrollers = false;
function scheduleScrollbars(discover = false) {
  discoverScrollers ||= discover;
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScrollbars);
}
const scrollResize = new ResizeObserver(() => scheduleScrollbars());
function updateScrollbars() {
  scrollFrame = 0;
  if (discoverScrollers) {
    discoverScrollers = false;
    for (const element of document.querySelectorAll('.atb-scroll-region,[data-atb-scroll],dialog,textarea')) {
      if (scrollbars.has(element)) continue;
      const bar = document.createElement('div'), thumb = document.createElement('div');
      bar.className = 'atb-scrollbar'; thumb.className = 'atb-scrollbar-thumb';
      bar.setAttribute('aria-hidden', 'true'); bar.hidden = true; bar.append(thumb);
      // A modal's scrollbars must belong to the same browser top layer.
      (element.closest('dialog') || document.body).append(bar);
      element.setAttribute('data-atb-scrollable', '');
      const entry = { element, bar, thumb, height: 0, thumbHeight: 0 };
      scrollbars.set(element, entry); scrollResize.observe(element);
      bar.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const rect = bar.getBoundingClientRect(), max = element.scrollHeight - element.clientHeight;
        if (event.target !== thumb) element.scrollTop = (event.clientY - rect.top - entry.thumbHeight / 2) / Math.max(1, entry.height - entry.thumbHeight) * max;
        const startY = event.clientY, startScroll = element.scrollTop;
        bar.setPointerCapture(event.pointerId); bar.dataset.dragging = '';
        const move = next => { element.scrollTop = startScroll + (next.clientY - startY) * max / Math.max(1, entry.height - entry.thumbHeight); };
        const finish = () => { delete bar.dataset.dragging; bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', finish); bar.removeEventListener('lostpointercapture', finish); };
        bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', finish); bar.addEventListener('lostpointercapture', finish);
        scheduleScrollbars();
      });
    }
  }
  for (const [element, entry] of scrollbars) {
    const { bar, thumb } = entry;
    if (!element.isConnected) { scrollResize.unobserve(element); bar.remove(); scrollbars.delete(element); continue; }
    const style = getComputedStyle(element), dialog = element.closest('dialog');
    const show = element.getClientRects().length && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1 && (!dialog || dialog.open) && (!document.fullscreenElement || document.fullscreenElement.contains(element));
    let top = 0, bottom = 0, right = 0;
    if (show) {
      const rect = element.getBoundingClientRect();
      top = Math.max(0, rect.top + element.clientTop); bottom = Math.min(innerHeight, rect.top + element.clientTop + element.clientHeight);
      right = Math.min(innerWidth, rect.left + element.clientLeft + element.clientWidth);
      for (let parent = element === dialog ? null : element.parentElement; parent; parent = parent.parentElement) {
        const clipping = getComputedStyle(parent);
        if (/auto|scroll|hidden|clip/.test(clipping.overflowY)) {
          const bounds = parent.getBoundingClientRect();
          top = Math.max(top, bounds.top + parent.clientTop); bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
        if (parent === dialog) break;
      }
    }
    const visible = Boolean(show && bottom - top > 24 && right > 12);
    if (bar.hidden === visible) bar.hidden = !visible;
    if (!visible) continue;
    entry.height = bottom - top;
    entry.thumbHeight = Math.min(entry.height, Math.max(24, entry.height * element.clientHeight / element.scrollHeight));
    const offset = (entry.height - entry.thumbHeight) * element.scrollTop / (element.scrollHeight - element.clientHeight);
    Object.assign(bar.style, { top: top + 'px', left: (right - 12) + 'px', height: entry.height + 'px' });
    Object.assign(thumb.style, { height: entry.thumbHeight + 'px', transform: `translateY(${offset}px)` });
  }
}
document.addEventListener('scroll', () => scheduleScrollbars(), { capture: true, passive: true });
document.addEventListener('load', () => scheduleScrollbars(), true);
document.addEventListener('fullscreenchange', () => scheduleScrollbars());
window.addEventListener('resize', () => scheduleScrollbars());
new MutationObserver(records => {
  if (records.some(record => !record.target.closest?.('.atb-scrollbar'))) scheduleScrollbars(true);
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
scheduleScrollbars(true);

// The nearest scroll region owns the wheel even when it reaches a boundary.
// Overlay thumbs target their region; fixed chrome still targets the main page.
document.addEventListener('wheel', event => {
  if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const target = event.target instanceof Element ? event.target : event.target.parentElement;
  const modal = [...document.querySelectorAll('dialog[open]')].findLast(node => node.matches(':modal'));
  let node = target;
  const overlay = target?.closest('.atb-scrollbar');
  if (overlay) node = [...scrollbars.values()].find(entry => entry.bar === overlay)?.element || node;
  if (modal && !modal.contains(node)) node = modal;
  const candidates = [];
  for (let current = node; current; current = current.parentElement) {
    // An unfocused form field must not swallow page scrolling on hover.
    if (current.matches('input,textarea,select') && current !== document.activeElement) continue;
    if (/auto|scroll/.test(getComputedStyle(current).overflowY)) candidates.push(current);
    if (current === modal) break;
  }
  if (!modal) {
    const main = document.querySelector('.atb-page-shell>.atb-scroll-region');
    if (main && !candidates.includes(main) && /auto|scroll/.test(getComputedStyle(main).overflowY)) candidates.push(main);
  }
  const element = candidates[0];
  if (element) {
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.max(0, Math.min(max, element.scrollTop + delta));
  }
  // Consume boundary events too; native scrolling must not chain to an ancestor.
  if (element || modal) event.preventDefault();
}, { passive: false, capture: true });

let leaving = false, allowLeaveOnce = false;
window.addEventListener('beforeunload', event => { if (allowLeaveOnce) { allowLeaveOnce = false; event.stopImmediatePropagation(); } }, { capture: true });
export async function navigateModule(href) {
  const target = new URL(href, location.href);
  if (target.origin !== location.origin || leaving) return;
  if (window.atbHasUnsavedChanges?.()) {
    leaving = true;
    const approved = await window.atbConfirmLeave();
    leaving = false;
    if (!approved) return;
    allowLeaveOnce = true;
  }
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

// App message dialogs share the same modal surface and safe keyboard defaults.
let messageTask,messageRequestId,messageCancel;
function showMessage({ title = 'ATB', message = '', detail = '', confirmLabel = '确定', cancelLabel = '', requestId } = {}) {
  if (messageTask) return requestId ? Promise.resolve(false) : messageTask;
  messageRequestId=requestId;
  root.classList.remove('atb-leaving'); leaving = false;
  messageTask = new Promise(resolve => {
    const previous = document.activeElement, modal = document.createElement('dialog');
    modal.className = 'atb-message-dialog';
    const heading = document.createElement('h2'), body = document.createElement('p'), note = document.createElement('p'), actions = document.createElement('div');
    heading.id = 'atb-message-title'; heading.textContent = title;
    body.id = 'atb-message-body'; body.textContent = message;
    note.className = 'atb-dialog-detail'; note.textContent = detail; note.hidden = !detail;
    actions.className = 'atb-dialog-actions';
    modal.setAttribute('aria-labelledby', heading.id); modal.setAttribute('aria-describedby', body.id);
    const finish = value => { modal.close(); modal.remove(); previous?.focus?.({ preventScroll: true }); resolve(value); };
    messageCancel=()=>finish(false);
    if (cancelLabel) {
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = cancelLabel; cancel.autofocus = true;
      cancel.addEventListener('click', () => finish(false)); actions.append(cancel);
    }
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = confirmLabel; confirm.className = 'atb-dialog-confirm'; confirm.autofocus = !cancelLabel;
    confirm.addEventListener('click', () => finish(true)); actions.append(confirm);
    modal.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    modal.append(heading, body, note, actions); document.body.append(modal); modal.showModal();
    actions.querySelector('[autofocus]')?.focus();
  }).finally(() => { messageTask = null; messageRequestId=messageCancel=null; });
  return messageTask;
}
window.atbConfirm = options => showMessage({ cancelLabel: '取消', ...options });
window.atbCancelConfirm=requestId=>{if(requestId&&requestId===messageRequestId)messageCancel?.();};
window.atbAlert = options => showMessage(options);
window.atbConfirmLeave = () => window.atbConfirm({ title: '有未保存的设置', message: '是否放弃未保存的设置并离开当前页面？', detail: '选择“继续编辑”会保留当前页面和输入。', cancelLabel: '继续编辑', confirmLabel: '放弃修改并离开' });
