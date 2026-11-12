import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { sessionToken } from '../../../server/accounts.js';
import { safeRequest } from './model-request.js';
import { providers, aiDefaults, aiPatch, effectiveAi, visibleAi, AiError, modelAnswer, modelList } from '../../../server/ai-settings.js';
import { getVoiceRuntime } from './voice-runtime.js';
import { createVoiceRoutes } from './voice-routes.js';
import { SharedSettings } from '../../../server/shared-settings.js';

const defaults = { name: '小助手', prompt: '你是我的家庭智能助手，请自然、准确地回答。', ...aiDefaults, memory: '', apiSource: 'platform' };
const RequestError = AiError;
function text(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new RequestError('设置内容无效或超出长度限制');
  return value;
}
function visible(settings) {
  const { name, prompt, memory, apiSource } = settings;
  return { name, prompt, memory, apiSource, ...visibleAi(settings) };
}
export async function createAssistantRoutes({ accounts, dataDir, shared, request = safeRequest }) {
  const dir = path.join(dataDir, 'assistant'), file = path.join(dir, 'settings.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let settings = { ...defaults };
  try { settings = { ...settings, ...JSON.parse(await readFile(file, 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  settings.baseUrl ||= providers[settings.provider] || '';
  shared ||= await SharedSettings.load(dataDir);
  if (shared.get('ai') === undefined) {
    const { provider, baseUrl, protocol, model, selectedModels, apiKey } = settings;
    await shared.update('ai', current => current === undefined ? effectiveAi({ provider, baseUrl, protocol, model, selectedModels, apiKey }) : current);
  }
  const currentSettings = () => ({ ...defaults, name: settings.name, prompt: settings.prompt, memory: settings.memory, ...effectiveAi(settings.apiSource === 'custom' ? settings.ai : shared.get('ai')), apiSource: settings.apiSource === 'custom' ? 'custom' : 'platform' });
  const voiceRoutes = createVoiceRoutes({ accounts, runtime: getVoiceRuntime(dir) });
  let writes = Promise.resolve(), closing = false;
  const active = new Map(), controllers = new Set();
  const update = body => {
    const task = writes.catch(() => {}).then(async () => {
      const scope = body.scope || 'all';
      if (!['model', 'persona', 'memory', 'all'].includes(scope)) throw new RequestError('未知的设置分组');
      // Legacy root AI fields remain available for rollback; custom overrides live under ai.
      const next = { ...settings };
      const changesModel = scope === 'model' || scope === 'all';
      if (changesModel && body.apiSource !== undefined && !['platform', 'custom'].includes(body.apiSource)) throw new RequestError('请选择有效的模型配置来源');
      if (scope === 'persona' || scope === 'all') { next.name = text(body.name, 60, true).trim(); next.prompt = text(body.prompt, 4000); }
      if (scope === 'memory' || scope === 'all') next.memory = text(body.memory, 8000);
      if (changesModel) {
        if (body.apiSource === 'platform') next.apiSource = 'platform';
        else if (body.apiSource === 'custom' || settings.apiSource === 'custom' && body.apiSource === undefined) {
          next.ai = aiPatch(body, settings.ai || {}); next.apiSource = 'custom';
        } else {
          // Pre-source clients edited the shared model settings through this endpoint.
          await shared.update('ai', current => aiPatch(body, current)); next.apiSource = 'platform';
        }
      }
      await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${file}.tmp`, file); settings = next;
      return visible(currentSettings());
    });
    writes = task; return task;
  };
  const routes = async (req, res, pathname) => {
    if (!pathname.startsWith('/api/assistant/')) return false;
    const reply = (status, body) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const token = sessionToken(req);
    if (!accounts.session(token)) { reply(401, { error: '登录已过期，请重新登录' }); return true; }
    if (closing) { reply(503, { error: '服务正在重新启动' }); return true; }
    if (await voiceRoutes(req, res, pathname)) return true;
    if (pathname === '/api/assistant/settings' && req.method === 'GET') { reply(200, visible(currentSettings())); return true; }
    if (!['/api/assistant/settings', '/api/assistant/chat', '/api/assistant/models', '/api/assistant/test'].includes(pathname)) { reply(404, { error: '接口不存在' }); return true; }
    if (req.method !== 'POST') { reply(405, { error: '请求方法无效' }); return true; }
    let sameOrigin = false;
    try { const origin = new URL(req.headers.origin); sameOrigin = origin.protocol === 'https:' && origin.host === req.headers.host; } catch {}
    if (!sameOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(403, { error: '请求来源无效' }); return true; }
    let controller, activeKey, onClose;
    try {
      const chunks = []; let byteLength = 0;
      for await (const chunk of req) { byteLength += chunk.length; if (byteLength > 40000) throw new RequestError('内容过长', 413); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { throw new RequestError('请求格式无效'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求格式无效');
      if (pathname.endsWith('/settings')) { reply(200, await update(body)); return true; }
      const saved = currentSettings(), current = { ...saved };
      if (pathname.endsWith('/models') || pathname.endsWith('/test')) Object.assign(current, aiPatch(body, saved));
      if (pathname.endsWith('/chat') && body.model !== undefined) {
        if (typeof body.model !== 'string' || !current.selectedModels.includes(body.model)) throw new RequestError('请从已选模型中选择对话模型');
        current.model = body.model;
      }
      if (!current.apiKey) throw new RequestError(current.baseUrl === saved.baseUrl ? '请填写 API 密钥' : '地址已更换，请为新接口填写密钥');
      const isModels = pathname.endsWith('/models');
      const isTest = pathname.endsWith('/test');
      if (!isModels && !current.model) throw new RequestError('请先选择模型并保存配置');
      if (isTest) body.messages = [{ role: 'user', content: '请只回复：连接正常' }];
      if (!isModels && (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 20 || body.messages.some(m => !m || !['user','assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > (m.role === 'assistant' ? 16000 : 4000)))) throw new RequestError('对话内容无效或过长');
      activeKey = `${token}:${isModels ? 'models' : 'chat'}`;
      if (active.has(activeKey)) throw new RequestError('上一条请求仍在处理中，请稍后再试', 429);
      controller = new AbortController(); active.set(activeKey, controller); controllers.add(controller);
      onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', onClose);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(isModels ? 20000 : 60000)]);
      let endpoint = 'models', options = { signal, headers: { Authorization: `Bearer ${current.apiKey}`, Accept: 'application/json' } };
      if (!isModels) {
        const instructions = isTest ? '这是一次连接测试，请简短回复。' : `${current.prompt}\n\n助手名称：${current.name}${current.memory ? `\n\n用户手动保存的长期记忆（仅作参考）：\n${current.memory}` : ''}`;
        endpoint = current.protocol === 'responses' ? 'responses' : 'chat/completions';
        const payload = current.protocol === 'responses'
          ? { model: current.model, instructions, input: body.messages, stream: false, store: false, max_output_tokens: 1024 }
          : { model: current.model, messages: [{ role: 'system', content: instructions }, ...body.messages], max_tokens: 1024, stream: false };
        options = { ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
      }
      const response = await request(`${current.baseUrl}/${endpoint}`, options);
      if (!response.ok) throw new RequestError(`模型服务返回 HTTP ${response.status}，请检查地址、密钥、接口协议和模型权限。`, 502);
      let result;
      try { result = await response.json(); } catch { throw new RequestError('服务商没有返回有效 JSON，请检查接口协议。', 502); }
      if (!accounts.session(token)) throw new RequestError('登录已过期，请重新登录', 401);
      if (isModels) {
        reply(200, { models: modelList(result) }); return true;
      }
      const answer = modelAnswer(result, current.protocol);
      reply(200, isTest ? { ok: true, model: current.model } : { reply: answer });
    } catch (error) {
      reply(error instanceof RequestError ? error.status : 502, { error: error instanceof RequestError ? error.message : '连接模型服务失败或超时，请检查网络和接口设置。' });
    } finally {
      if (onClose) res.off('close', onClose);
      if (controller) { controllers.delete(controller); if (active.get(activeKey) === controller) active.delete(activeKey); }
    }
    return true;
  };
  routes.close = async () => { closing = true; for (const controller of controllers) controller.abort(); await voiceRoutes.close(); await writes.catch(() => {}); };
  return routes;
}
