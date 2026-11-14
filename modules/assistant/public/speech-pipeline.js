// Sentence-level streaming: one audio playing, at most one prepared ahead.
export function createSpeechPipeline({ synthesize, play, flushMs = 500, firstClauseMin = 0 }) {
  let buffer = '', queue = [], ended = false, cancelled = false, wake, received = 0, first = true, flushTimer;
  const signal = () => { wake?.(); wake = null; };
  function split(flush = false, final = false) {
    while (buffer.length) {
      const limit = first ? 40 : 80, head = buffer.slice(0, limit);
      const punctuation = /[。！？!?；;\n]|\.(?=\s)/.exec(head);
      let end = punctuation ? punctuation.index + 1 : 0;
      const commaAfter=start=>{for(const match of head.matchAll(/[，,、]/g)){const at=match.index;if(at<start)continue;if(match[0]===','&&/\d/.test(buffer[at-1]||'')&&(!buffer[at+1]||/\d/.test(buffer[at+1])))continue;return at+1;}return 0;};
      if (first && firstClauseMin > 0) {
        const clauseEnd = commaAfter(firstClauseMin);
        if (clauseEnd && (!end || clauseEnd < end)) end = clauseEnd;
      }
      if (!end && head.length >= 28) end = commaAfter(12);
      if (!end && buffer.length < limit && !flush) break;
      end ||= Math.min(limit, buffer.length);
      // A token or a model pause can land inside 1,234.56, dates or a clock time.
      // Keep that numeric run together until its following character or end of input.
      for(const match of buffer.matchAll(/[\d０-９]+(?:[.,:/-][\d０-９]+)*(?:[.,:/-])?/g)){
        const start=match.index,stop=start+match[0].length;
        if(end>start&&end<stop)end=start||stop;
        if(!final&&stop===buffer.length&&end===stop)end=start;
      }
      if (/[\uD800-\uDBFF]/.test(buffer[end - 1])) end--;
      if (!end) break;
      const text = buffer.slice(0, end); buffer = buffer.slice(end);
      if (text.trim()) { queue.push(text); first = false; }
    }
    signal();
  }
  function scheduleFlush() {
    if (buffer.length < (first ? 12 : 24)) { clearTimeout(flushTimer); flushTimer = null; return; }
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; if (!cancelled && !ended) split(true); }, flushMs);
  }
  async function prepare() {
    while (!queue.length && !ended && !cancelled) await new Promise(resolve => { wake = resolve; });
    if (cancelled || !queue.length) return null;
    const result = await synthesize(queue.shift());
    return cancelled ? null : result;
  }
  const settled = task => task.then(value => ({ value }), error => ({ error }));
  const done = (async () => {
    let next = settled(prepare());
    try {
      while (!cancelled) {
        const current = await next;
        if (cancelled) break;
        if (current.error) throw current.error;
        if (current.value === null) return true;
        next = settled(prepare());
        if (!await play(current.value)) { cancelled = true; break; }
      }
      return false;
    } finally { cancelled = true; clearTimeout(flushTimer); queue = []; buffer = ''; signal(); }
  })();
  // The owner awaits this promise; attach now so a fast provider error is handled.
  done.catch(() => {});
  return {
    done,
    write(text) {
      if (cancelled || ended) return;
      if (typeof text !== 'string' || (received += text.length) > 16000) throw Error('语音回复过长');
      buffer += text;
      split();
      if (!buffer.length) { clearTimeout(flushTimer); flushTimer = null; }
      scheduleFlush();
    },
    finish() { if (!cancelled && !ended) { clearTimeout(flushTimer); flushTimer = null; split(true,true); ended = true; signal(); } },
    cancel() { cancelled = true; clearTimeout(flushTimer); queue = []; buffer = ''; signal(); },
  };
}
