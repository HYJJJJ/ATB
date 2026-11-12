// Bound UTF-8 bytes as well as message count so long Chinese replies can continue.
export function conversationContext(messages, byteLimit = 30000) {
  const encoder = new TextEncoder(), result = [];
  for (const original of messages.slice(-20).reverse()) {
    const message = { role: original.role, content: original.content };
    if (message.role === 'assistant') message.content = message.content.slice(-8000);
    const candidate = [message, ...result];
    if (encoder.encode(JSON.stringify({ messages: candidate })).length > byteLimit) break;
    result.unshift(message);
  }
  while (result.length > 1 && result[0].role !== 'user') result.shift();
  return result;
}
