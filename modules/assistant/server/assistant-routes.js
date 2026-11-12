import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { sessionToken } from '../../../server/accounts.js';
import { normalizeBase, safeRequest } from './model-request.js';
import { getVoiceRuntime } from './voice-runtime.js';
import { createVoiceRoutes } from './voice-routes.js';
import { SharedSettings } from '../../../server/shared-settings.js';

const providers = {
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  openai: 'https://api.openai.com/v1',
};
const defaults = { name: '小助手', prompt: '你是我的家庭智能助手，请自然、准确地回答。', provider: 'custom', baseUrl: '', protocol: 'chat', model: '', apiKey: '', memory: '' };
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function text(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new RequestError('设置内容无效或超出长度限制');
  return value;
}
function modelPatch(body, current) {
  const provider = body.provider;
  if (!['custom', 'dashscope', 'openai'].includes(provider)) throw new RequestError('请选择接口类型');
  let baseUrl;
  try { baseUrl = normalizeBase(provider === 'custom' ? body.baseUrl : providers[provider]); }
  catch { throw new RequestError('请填写公网 HTTPS 基础地址，例如 https://example.com/v1'); }
  const protocol = body.protocol ?? current.protocol ?? 'chat';
  if (!['chat', 'responses'].includes(protocol)) throw new RequestError('请选择有效的接口协议');
  if (body.apiKey !== undefined) text(body.apiKey, 1000);
  if (body.clearKey !== undefined && typeof body.clearKey !== 'boolean') throw new RequestError('密钥设置无效');
  const key = body.apiKey?.trim();
  if (key && /[\r\n]/.test(key)) throw new RequestError('密钥不能包含换行');
  return {
    provider, baseUrl, protocol,
    model: body.model === undefined ? current.model : text(body.model, 100).trim(),
    apiKey: body.clearKey ? '' : key || (baseUrl === current.baseUrl ? current.apiKey : ''),
  };
}
function visible(settings) {
  const { name, prompt, provider, baseUrl, protocol, model, memory } = settings;
  return { name, prompt, provider, baseUrl, protocol, model, memory, hasApiKey: Boolean(settings.apiKey) };
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
    const { provider, baseUrl, protocol, model, apiKey } = settings;
    await shared.update('ai', current => current === undefined ? { provider, baseUrl, protocol, model, apiKey } : current);
  }
  // Only the shared AI section supplies provider credentials after migration.
  const currentSettings = () => ({ ...defaults, name: settings.name, prompt: settings.prompt, memory: settings.memory, ...shared.get('ai') });
  const voiceRoutes = createVoiceRoutes({ accounts, runtime: getVoiceRuntime(dir) });
  let writes = Promise.resolve(), closing = false;
  const active = new Map(), controllers = new Set();
  const update = body => {
    const task = writes.catch(() => {}).then(async () => {
      const scope = body.scope || 'all';
      if (!['model', 'persona', 'memory', 'all'].includes(scope)) throw new RequestError('未知的设置分组');
      // Retain legacy fields only for rollback; all live AI reads come from shared.
      const next = { ...settings };
      const changesModel = scope === 'model' || scope === 'all';
      if (changesModel) modelPatch(body, currentSettings());
      if (scope === 'persona' || scope === 'all') { next.name = text(body.name, 60, true).trim(); next.prompt = text(body.prompt, 4000); }
      if (scope === 'memory' || scope === 'all') next.memory = text(body.memory, 8000);
      if (changesModel) await shared.update('ai', current => modelPatch(body, { ...defaults, ...current }));
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
      if (pathname.endsWith('/models') && body.provider !== undefined) Object.assign(current, modelPatch(body, saved));
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
        if (!Array.isArray(result?.data)) throw new RequestError('服务商不支持标准模型列表，可手动填写模型名称。', 502);
        const models = [...new Set(result.data.map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100))].sort().slice(0, 1000);
        reply(200, { models }); return true;
      }
      let answer = result?.choices?.[0]?.message?.content;
      if (current.protocol === 'responses') answer = result?.output_text || result?.output?.filter(item => item?.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item?.type === 'output_text').map(item => item.text || '').join('');
      if (typeof answer !== 'string' || !answer.trim()) throw new RequestError('模型没有返回文字回复，请检查模型是否支持文字对话。', 502);
      reply(200, isTest ? { ok: true, model: current.model } : { reply: answer.slice(0, 16000) });
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
