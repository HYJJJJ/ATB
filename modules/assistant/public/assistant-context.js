// Bound UTF-8 bytes as well as message count so long Chinese replies can continue.
export function conversationContext(messages, byteLimit = 16000, turns = 3) {
  // Only completed exchanges belong to history. An unanswered old user message
  // is not a queued instruction for the next turn (notably after failed tools).
  const completed = [];
  let question;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.status === 'failed') { question = undefined; continue; }
    if (message.role === 'user') {
      question = message;
      if (index === messages.length - 1) completed.push(message);
    } else if (message.role === 'assistant') {
      const eligible = !message.status || message.status === 'complete';
      const protocolText = /<\/?[|｜]+\s*DSML\s*[|｜]+/i.test(message.content);
      if (question && eligible && !protocolText && question.status !== 'pending') completed.push(question, message);
      question = undefined;
    }
  }
  const encoder = new TextEncoder(), result = [];
  for (const original of completed.slice(-(Math.max(1, Math.min(6, turns)) * 2 + 1)).reverse()) {
    const message = { role: original.role, content: original.content };
    if (message.role === 'assistant') message.content = message.content.slice(-8000);
    const candidate = [message, ...result];
    if (encoder.encode(JSON.stringify({ messages: candidate })).length > byteLimit) break;
    result.unshift(message);
  }
  while (result.length > 1 && result[0].role !== 'user') result.shift();
  return result;
}
