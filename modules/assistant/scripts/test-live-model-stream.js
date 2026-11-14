import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { SharedSettings } from '../../../server/shared-settings.js';
import { effectiveAi } from '../../../server/ai-settings.js';
import { safeRequest } from '../server/model-request.js';
import { streamModelAnswer } from '../server/model-stream.js';

// Explicit opt-in diagnostic: one short fixed prompt, no history or memory.
const shared = await SharedSettings.load(path.resolve('data'));
const config = effectiveAi(shared.get('ai'));
if (!config.apiKey || !config.baseUrl || !config.model) throw Error('No saved platform model configuration');
const instructions = '这是一项语音流式测试，请只回复：你好。欢迎回家。';
const input = [{ role: 'user', content: '测试' }];
const body = config.protocol === 'responses'
  ? { model: config.model, instructions, input, stream: true, store: false, max_output_tokens: 128 }
  : { model: config.model, messages: [{ role: 'system', content: instructions }, ...input], stream: true, max_tokens: 128 };
const started = performance.now(), signal = AbortSignal.timeout(60000); let firstTextMs;
const response = await safeRequest(`${config.baseUrl}/${config.protocol === 'responses' ? 'responses' : 'chat/completions'}`, {
  method: 'POST', stream: true, signal, headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }, body: JSON.stringify(body),
});
if (!response.ok) { response.cancel?.(); throw Error(`Model stream HTTP ${response.status}`); }
const reply = await streamModelAnswer(response, config.protocol, { signal, onDelta: () => { firstTextMs ??= Math.round(performance.now() - started); } });
const result = { passed: true, protocol: config.protocol, streamed: Boolean(response.headers.get('content-type')?.includes('text/event-stream')), firstTextMs, completedMs: Math.round(performance.now() - started), replyCharacters: reply.length, input: 'fixed test prompt; no user conversation' };
await mkdir('test-results/low-latency-voice', { recursive: true });
await writeFile('test-results/low-latency-voice/live-model-report.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
