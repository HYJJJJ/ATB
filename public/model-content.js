// Model protocol text must be filtered before display, speech or successful memory writes.
export const unsupportedToolMessage = '模型尝试调用工具，但当前对话接口未接入这些工具，未执行搜索。请使用普通对话模式，或在服务商处关闭工具模式。';
export function createModelTextFilter() {
  let pending = '', root = '', depth = 0, removed = false;
  const starts = ['<|DSML|', '</|DSML|'];
  function drain(final) {
    let output = '';
    while (pending) {
      const at = pending.indexOf('<');
      if (at < 0) { if (!root) output += pending; pending = ''; break; }
      if (at) { if (!root) output += pending.slice(0, at); pending = pending.slice(at); }
      const normalized = pending.replaceAll('｜', '|').replace(/\|+/g, '|');
      const possible = starts.some(start => start.startsWith(normalized) || normalized.startsWith(start));
      if (possible) {
        const end = pending.indexOf('>');
        if (end < 0) {
          if (!final) break;
          // A bare comparison sign remains ordinary text; partial protocol markers do not.
          if (normalized.includes('|')) removed = true;
          else if (!root) output += pending;
          pending = ''; break;
        }
        const tag = pending.slice(0, end + 1).replaceAll('｜', '|').replace(/\|+/g, '|');
        const match = /^<(\/?)\|DSML\|\s*([\w]+)\b[^>]*>$/i.exec(tag);
        if (match) {
          removed = true;
          const name = match[2].toLowerCase();
          if (!root && !match[1]) { root = name; depth = 1; }
          else if (root === name) { depth += match[1] ? -1 : 1; if (!depth) root = ''; }
          pending = pending.slice(end + 1); continue;
        }
      }
      if (!root) output += '<';
      pending = pending.slice(1);
    }
    return output;
  }
  return {
    push(text) { pending += text; return drain(false); },
    finish() { return drain(true); },
    get removed() { return removed; },
  };
}
export function cleanModelText(text) {
  const filter = createModelTextFilter();
  const content = filter.push(String(text ?? '')) + filter.finish();
  return { content, removed: filter.removed };
}
