import test from 'node:test';
import assert from 'node:assert/strict';
const frame = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
const streaming = body => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('cancellation releases a provider stream even when no more bytes arrive', async () => {
  const {readModelRound}=await import('../server/model-stream.js');
  const abort=new AbortController();let cancelled=false;
  const response=streaming(new ReadableStream({cancel(){cancelled=true;}}));
  const result=readModelRound(response,'chat',{signal:abort.signal});
  await new Promise(resolve=>setImmediate(resolve));abort.abort();
  const status=await Promise.race([result.then(()=>false,()=>true),new Promise(resolve=>setTimeout(()=>resolve('stuck'),100))]);
  assert.equal(status,true,'abort must settle without a provider chunk');assert.equal(cancelled,true);
});

test('visible model text arrives before the provider finishes and split UTF8/SSE frames remain intact', async () => {
  const { streamModelAnswer } = await import('../server/model-stream.js');
  let controller; const chunks = [];
  const body = new ReadableStream({ start(value) { controller = value; } });
  const pending = streamModelAnswer(streaming(body), 'chat', { onDelta: text => chunks.push(text) });
  const bytes = new TextEncoder().encode(frame('你好。'));
  controller.enqueue(bytes.slice(0, 14)); controller.enqueue(bytes.slice(14));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(chunks, ['你好。'], 'first sentence must arrive while the stream is open');
  controller.enqueue(new TextEncoder().encode(frame('后一句。') + 'data: [DONE]\n\n')); controller.close();
  assert.equal(await pending, '你好。后一句。');
});

test('Responses ignores reasoning and only speaks visible text with a completed marker', async () => {
  const { streamModelAnswer } = await import('../server/model-stream.js'); const output = [];
  const events = [
    { type: 'response.reasoning_summary_text.delta', delta: 'private reasoning' },
    { type: 'response.output_text.delta', delta: '欢迎回家。' },
    { type: 'response.completed', response: { status: 'completed' } },
  ];
  const result = await streamModelAnswer(streaming(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')), 'responses', { onDelta: text => output.push(text) });
  assert.equal(result, '欢迎回家。'); assert.deepEqual(output, ['欢迎回家。']);
});

test('truncated and provider-error streams never count as successful model replies', async () => {
  const { streamModelAnswer } = await import('../server/model-stream.js');
  await assert.rejects(streamModelAnswer(streaming(frame('半句话')), 'chat', { onDelta() {} }), /不完整/);
  await assert.rejects(streamModelAnswer(streaming('data: {"error":{"message":"private-test-body"}}\n\n'), 'chat', { onDelta() {} }), error => !error.message.includes('private-test-body'));
});

for (const reason of ['length', 'content_filter', 'tool_calls']) {
  test(`Chat completion with ${reason} cannot become successful at the DONE marker`, async () => {
    const { streamModelAnswer } = await import('../server/model-stream.js');
    const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
    await assert.rejects(streamModelAnswer(streaming(frame('尚未完成。') + end + 'data: [DONE]\n\n'), 'chat'), /不完整/);
  });
}

test('Chat completion with a normal stop preserves its final visible text', async () => {
  const { streamModelAnswer } = await import('../server/model-stream.js');
  const end = `data: ${JSON.stringify({ choices: [{ delta: { content: '。' }, finish_reason: 'stop' }] })}\n\n`;
  assert.equal(await streamModelAnswer(streaming(frame('完整回复') + end + 'data: [DONE]\n\n'), 'chat'), '完整回复。');
});

test('APIs which ignore stream and return ordinary JSON still produce one visible reply', async () => {
  const { streamModelAnswer } = await import('../server/model-stream.js'); const chunks = [];
  const response = Response.json({ choices: [{ message: { content: '普通回复' } }] });
  assert.equal(await streamModelAnswer(response, 'chat', { onDelta: text => chunks.push(text) }), '普通回复');
  assert.deepEqual(chunks, ['普通回复']);
});

const leakedTool = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n<｜｜DSML｜｜ parameter name="query" string="true">G2 Falcons 比赛 结果 今天</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
test('tool markup never reaches a streaming consumer even when split into individual characters', async () => {
  const { streamModelAnswer } = await import('../server/model-stream.js');
  for (const protocol of ['chat', 'responses']) {
    const seen = [];
    const events = [...leakedTool].map(text => protocol === 'chat' ? frame(text) : `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`).join('');
    const end = protocol === 'chat' ? 'data: [DONE]\n\n' : 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
    await assert.rejects(streamModelAnswer(streaming(events + end), protocol, { onDelta: text => seen.push(text) }), /工具.*未接入/);
    assert.equal(seen.join('').trim(), '');
  }
});
test('JSON and incomplete tool attempts are rejected instead of being saved as an answer', async () => {
  const { modelAnswer } = await import('../../../server/ai-settings.js');
  const { streamModelAnswer } = await import('../server/model-stream.js');
  for (const content of [leakedTool, '我来搜索。' + leakedTool, '<|DSML|invoke name="web_search">secret', '<｜｜DSM']) {
    assert.throws(() => modelAnswer({ choices: [{ message: { content } }] }, 'chat'), /工具.*未接入/);
    const seen = [];
    await assert.rejects(streamModelAnswer(streaming(frame(content) + 'data: [DONE]\n\n'), 'chat', { onDelta: text => seen.push(text) }), /工具.*未接入/);
    assert.ok(!seen.join('').includes('DSML') && !seen.join('').includes('secret'));
  }
});

test('structured calls receive the same unsupported-tool explanation without exposing arguments', async () => {
  const { modelAnswer } = await import('../../../server/ai-settings.js');
  const { streamModelAnswer } = await import('../server/model-stream.js');
  assert.throws(() => modelAnswer({ choices: [{ message: { content: null, tool_calls: [{ function: { arguments: 'private query' } }] } }] }, 'chat'), /工具.*未接入/);
  assert.throws(() => modelAnswer({ output: [{ type: 'function_call', arguments: 'private query' }] }, 'responses'), /工具.*未接入/);
  const event = { type: 'response.output_item.added', item: { type: 'function_call', name: 'web_search', arguments: 'private query' } };
  await assert.rejects(streamModelAnswer(streaming(`data: ${JSON.stringify(event)}\n\n`), 'responses'), /工具.*未接入/);
});
