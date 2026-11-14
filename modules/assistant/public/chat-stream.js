export async function readChatReply(response, { onDelta, onTool, signal } = {}) {
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, reply, received = 0;
  try {
    while (true) {
      signal?.throwIfAborted(); const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > 2 * 1024 * 1024) throw Error('回复内容过长');
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { throw Error('回复格式异常'); }
        if (event.type === 'error') throw Error(typeof event.error === 'string' ? event.error : '回复中断');
        if (event.type === 'tool' && typeof event.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(event.name) && typeof event.ok === 'boolean') await onTool?.(event);
        if (event.type === 'delta' && typeof event.text === 'string') {
          received += event.text.length; if (received > 16000) throw Error('回复内容过长');
          await onDelta?.(event.text);
        }
        if (event.type === 'done' && typeof event.reply === 'string' && event.reply.length <= 16000) reply = event.reply;
      }
    }
    signal?.throwIfAborted(); if (!reply?.trim()) throw Error('回复不完整，请重试');
    return reply;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
