import test from 'node:test';
import assert from 'node:assert/strict';

test('browser chat reader forwards split NDJSON text immediately and requires a final reply', async () => {
  const { readChatReply } = await import('../public/chat-stream.js');
  let source; const chunks = [];
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }));
  const reading = readChatReply(response, { onDelta: text => chunks.push(text) });
  const frame = new TextEncoder().encode('{"type":"delta","text":"第一句。"}\n');
  source.enqueue(frame.slice(0, 25)); source.enqueue(frame.slice(25));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(chunks, ['第一句。']);
  source.enqueue(new TextEncoder().encode('{"type":"done","reply":"第一句。"}\n')); source.close();
  assert.equal(await reading, '第一句。');
  await assert.rejects(readChatReply(new Response('{"type":"delta","text":"不完整"}\n')), /不完整/);
  await assert.rejects(readChatReply(new Response('{"type":"error","error":"接口不可用"}\n')), /接口不可用/);
});
test('tool result metadata is separate from spoken deltas',async()=>{
  const {readChatReply}=await import('../public/chat-stream.js'),spoken=[],tools=[];
  const result=await readChatReply(new Response([
    {type:'tool',name:'weather',ok:true,sources:[{source:'Open-Meteo',url:'https://open-meteo.com/'}]},
    {type:'tool',name:'web_search',ok:true,sources:[]},
    {type:'tool',name:'mcp__browser__browser_snapshot',ok:true,sources:[]},
    {type:'tool',name:'<script>',ok:true,sources:[]},
    {type:'delta',text:'上海多云'},
    {type:'done',reply:'上海多云'},
  ].map(e=>JSON.stringify(e)+'\n').join('')),{onDelta:text=>spoken.push(text),onTool:tool=>tools.push(tool)});
  assert.equal(result,'上海多云');assert.deepEqual(spoken,['上海多云']);assert.deepEqual(tools.map(t=>t.name),['weather','web_search','mcp__browser__browser_snapshot']);
});
