// Search is contained in the dropdown; filtering never changes the saved selection.
export function createVoicePicker(select, { openAtStart = () => false } = {}) {
  const root = document.createElement('div'); root.className = 'voice-combobox';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'voice-combobox-trigger';
  trigger.id = 'voice-picker-trigger'; trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', '回复音色'); trigger.setAttribute('aria-controls', 'voice-picker-options');
  const panel = document.createElement('div'); panel.className = 'voice-combobox-panel'; panel.hidden = true;
  const search = document.createElement('input'); search.type = 'search'; search.id = 'voice-search'; search.placeholder = '搜索名称、语言或音色 ID'; search.autocomplete = 'off';
  search.setAttribute('role', 'combobox'); search.setAttribute('aria-label', '搜索音色'); search.setAttribute('aria-controls', 'voice-picker-options'); search.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-autocomplete', 'list');
  const list = document.createElement('div'); list.id = 'voice-picker-options'; list.className = 'voice-combobox-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '音色列表');
  const empty = document.createElement('p'); empty.className = 'field-help'; empty.textContent = '没有匹配的音色'; empty.setAttribute('role', 'status');
  panel.append(search, list, empty); root.append(trigger, panel); select.after(root); select.hidden = true; select.setAttribute('aria-hidden', 'true');
  let matches = [], active = -1;
  const close = (focus = false) => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant'); if (focus) trigger.focus(); };
  const highlight = index => {
    active = index;
    for (const [i, node] of [...list.children].entries()) node.classList.toggle('highlighted', i === active);
    if (active >= 0) { search.setAttribute('aria-activedescendant', list.children[active].id); list.children[active].scrollIntoView({block:'nearest'}); }
    else search.removeAttribute('aria-activedescendant');
  };
  const choose = option => { select.value = option.value; select.dispatchEvent(new Event('input', {bubbles:true})); select.dispatchEvent(new Event('change', {bubbles:true})); update(); close(true); };
  const render = () => {
    const query = search.value.trim().toLocaleLowerCase();
    matches = [...select.options].filter(option => option.textContent.toLocaleLowerCase().includes(query));
    list.replaceChildren(...matches.map((option, i) => {
      const node = document.createElement('div'); node.id = 'voice-option-' + i; node.setAttribute('role','option'); node.setAttribute('aria-selected', String(option.value === select.value)); node.textContent = option.textContent;
      node.addEventListener('mousedown', event => event.preventDefault()); node.addEventListener('click', () => choose(option)); return node;
    }));
    empty.hidden = !!matches.length;
    const selected = matches.findIndex(option => option.value === select.value);
    highlight(selected >= 0 ? selected : matches.length ? 0 : -1);
  };
  const update = () => { trigger.textContent = select.selectedOptions[0]?.textContent || '请选择音色'; if (!panel.hidden) render(); };
  const show = () => { panel.hidden = false; trigger.setAttribute('aria-expanded','true'); search.setAttribute('aria-expanded','true'); search.value = ''; render(); if (openAtStart() && matches.length) { highlight(0); list.scrollTop = 0; } search.focus(); };
  trigger.addEventListener('click', () => panel.hidden ? show() : close());
  trigger.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); show(); highlight(event.key === 'ArrowUp' ? matches.length - 1 : 0); } });
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); if (matches.length) highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length); }
    else if (event.key === 'Enter') { event.preventDefault(); if (active >= 0 && matches[active]) choose(matches[active]); }
  });
  root.addEventListener('focusout', () => queueMicrotask(() => { if (!root.contains(document.activeElement)) close(); }));
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); });
  select.addEventListener('input', update);
  return {update, close};
}
