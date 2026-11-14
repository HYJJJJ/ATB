import { createModelTextFilter, unsupportedToolMessage } from '../../../public/model-content.js';
import { AiError, modelAnswer } from '../../../server/ai-settings.js';
import { readDsmlCalls } from './dsml-calls.js';

const incomplete = () => new AiError('模型回复不完整，请重试，或在语音设置中关闭快速回复。', 502);
const unsupported = () => new AiError('模型回复不完整：' + unsupportedToolMessage, 502);
async function* chunksOf(response, signal) {
  const reader=response.body.getReader?.(),iterator=reader?null:response.body[Symbol.asyncIterator]();
  let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>{reject(signal.reason);if(reader)void reader.cancel().catch(()=>{});else response.cancel?.();};signal?.addEventListener('abort',abort,{once:true});});
  try {
    signal?.throwIfAborted();
    while(true){const part=await Promise.race([reader?reader.read():iterator.next(),cancelled]);signal?.throwIfAborted();if(part.done)return;yield part.value;}
  } finally {
    signal?.removeEventListener('abort',abort);
    if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}
    else {response.cancel?.();void iterator.return?.().catch(()=>{});}
  }
}
function callsOf(data, protocol) {
  if (protocol === 'responses') {
    if (data.output?.some(item => item?.type === 'custom_tool_call')) throw unsupported();
    return (data.output || []).filter(item => item?.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
  }
  const message = data.choices?.[0]?.message;
  if (message?.function_call) throw unsupported();
  return (message?.tool_calls || []).map(call => {
    if (call.type !== 'function') throw unsupported();
    return { id: call.id, name: call.function?.name, arguments: call.function?.arguments };
  });
}
function validateCalls(calls) {
  const ids = new Set();
  if (calls.length > 6) throw new AiError('模型工具调用次数超出限制，未执行。', 502);
  for (const call of calls) {
    if (typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || ids.has(call.id)
      || typeof call.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(call.name)
      || typeof call.arguments !== 'string' || call.arguments.length > 4096) throw new AiError('模型工具调用格式无效，未执行。', 502);
    ids.add(call.id);
  }
  return calls;
}
function validStatus(data, protocol) {
  if (protocol === 'responses') {
    if (data.status && data.status !== 'completed') throw incomplete();
  } else {
    const reason = data.choices?.[0]?.finish_reason;
    if (reason && !['stop', 'tool_calls'].includes(reason)) throw incomplete();
  }
}

// Only output_text/content reaches onDelta. Native arguments and reasoning stay private.
export async function readModelRound(response, protocol, { onDelta, signal, allowTools = false, toolDefinitions = [] } = {}) {
  const compatibleRound = (content, output = [], assistant) => {
    if (!allowTools) return null;
    const calls = readDsmlCalls(content, toolDefinitions);
    if (!calls) return null;
    validateCalls(calls);
    return { answer: '', calls,
      output: [...output.filter(item => item?.type === 'reasoning'), ...calls.map(call => ({type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments}))],
      ...(assistant?.reasoning_content ? {assistant:{reasoning_content:assistant.reasoning_content}} : {}) };
  };
  if (!response.headers?.get('content-type')?.includes('text/event-stream')) {
    signal?.throwIfAborted();
    let data;
    try { data = await response.json(); } catch { throw new AiError('服务商没有返回有效 JSON，请检查接口协议。', 502); }
    signal?.throwIfAborted();
    if (JSON.stringify(data).length > 2 * 1024 * 1024) throw new AiError('模型响应过大。', 502);
    validStatus(data, protocol);
    const calls = callsOf(data, protocol);
    const content = protocol === 'responses' ? data.output_text || data.output?.filter(item => item?.type === 'message').flatMap(item => item.content || []).filter(item => item?.type === 'output_text').map(item => item.text || '').join('') : data.choices?.[0]?.message?.content;
    if (calls.length) {
      if (!allowTools) throw unsupported();
      validateCalls(calls);
      if (content) modelAnswer(protocol === 'responses' ? { output_text: content } : { choices: [{ message: { content } }] }, protocol);
      return { answer: '', calls, output: data.output || [], assistant: data.choices?.[0]?.message };
    }
    const compatible = compatibleRound(content, data.output, data.choices?.[0]?.message);
    if (compatible) return compatible;
    const answer = modelAnswer(data, protocol);
    await onDelta?.(answer);
    return { answer, calls: [], output: data.output || [] };
  }
  let buffer = '', answer = '', complete = false, bytes = 0, finishReason = '';
  const decoder = new TextDecoder('utf-8', { fatal: true }), filter = createModelTextFilter();
  const chatCalls = new Map(), outputItems = new Map(); let completedOutput;
  let received = 0, reasoning = '', rawContent = '';
  const emit = async text => { if (text) { answer += text; await onDelta?.(text); } };
  const consume = async frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || complete) return;
    if (data === '[DONE]') { if (protocol !== 'responses') complete = true; return; }
    let event; try { event = JSON.parse(data); } catch { throw new AiError('模型返回了无效的流式数据，请检查接口协议。', 502); }
    if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new AiError('模型流式回复失败，请检查接口协议及模型设置。', 502);
    if (protocol === 'responses') {
      if (event.type === 'response.completed') {
        complete = event.response?.status === 'completed'; completedOutput = event.response?.output;
        if (!complete) throw incomplete(); return;
      }
      if (['function_call', 'custom_tool_call'].includes(event.item?.type) && !allowTools) throw unsupported();
      if (event.item?.type === 'custom_tool_call') throw unsupported();
      if (['response.output_item.added', 'response.output_item.done'].includes(event.type)) {
        if (!Number.isInteger(event.output_index) || event.output_index < 0 || event.output_index > 32) throw incomplete();
        outputItems.set(event.output_index, structuredClone(event.item));
      }
      if (event.type === 'response.function_call_arguments.delta') {
        if (!allowTools) throw unsupported();
        const item = outputItems.get(event.output_index);
        if (!item || item.type !== 'function_call' || typeof event.delta !== 'string' || event.item_id && item.id !== event.item_id) throw incomplete();
        item.arguments = (item.arguments || '') + event.delta;
        if (item.arguments.length > 4096) throw new AiError('模型工具参数过长，未执行。', 502);
      }
    } else {
      const delta = event.choices?.[0]?.delta;
      if (typeof delta?.reasoning_content === 'string') {
        reasoning += delta.reasoning_content;
        if (reasoning.length > 16000) throw new AiError('模型内部响应过长。', 502);
      }
      if (delta?.function_call) throw unsupported();
      if (delta?.tool_calls?.length) {
        if (!allowTools) throw unsupported();
        for (const part of delta.tool_calls) {
          if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 6 || part.type && part.type !== 'function') throw incomplete();
          const call = chatCalls.get(part.index) || { id: '', name: '', arguments: '' };
          for (const [key, value] of [['id', part.id], ['name', part.function?.name], ['arguments', part.function?.arguments]]) {
            if (value != null) { if (typeof value !== 'string') throw incomplete(); call[key] += value; }
          }
          if (call.id.length > 128 || call.name.length > 64 || call.arguments.length > 4096) throw new AiError('模型工具参数过长，未执行。', 502);
          chatCalls.set(part.index, call);
        }
      }
      const reason = event.choices?.[0]?.finish_reason;
      if (reason) {
        finishReason = reason;
        if (['tool_calls', 'function_call'].includes(reason) && !allowTools) throw unsupported();
        if (!['stop', 'tool_calls'].includes(reason)) throw incomplete();
      }
    }
    const text = protocol === 'responses' ? event.type === 'response.output_text.delta' && event.delta : event.choices?.[0]?.delta?.content;
    if (typeof text !== 'string' || !text) return;
    received += text.length;
    if (received > 16000) throw new AiError('模型回复过长。', 502);
    rawContent += text;
    await emit(filter.push(text));
  };
  for await (const chunk of chunksOf(response, signal)) {
    signal?.throwIfAborted(); bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new AiError('模型响应过大。', 502);
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); await consume(frame); }
    if (complete) break;
  }
  signal?.throwIfAborted();
  await emit(filter.finish());
  if (!complete) throw incomplete();
  const output = completedOutput || [...outputItems.entries()].sort((a,b) => a[0] - b[0]).map(([,item]) => item);
  const calls = protocol === 'responses' ? callsOf({ output }, protocol) : [...chatCalls.entries()].sort((a,b) => a[0] - b[0]).map(([,call]) => call);
  if (filter.removed) {
    const compatible = !calls.length && compatibleRound(rawContent, output, {reasoning_content:reasoning});
    if (compatible) return compatible;
    throw unsupported();
  }
  if (calls.length) {
    if (!allowTools) throw unsupported();
    if (protocol !== 'responses' && finishReason !== 'tool_calls') throw incomplete();
    validateCalls(calls); return { answer, calls, output, ...(reasoning ? { assistant: { reasoning_content: reasoning } } : {}) };
  }
  if (finishReason === 'tool_calls' || !answer.trim()) throw incomplete();
  return { answer, calls: [], output };
}

export async function streamModelAnswer(response, protocol, options = {}) {
  return (await readModelRound(response, protocol, options)).answer;
}
