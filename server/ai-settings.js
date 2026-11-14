import { cleanModelText, unsupportedToolMessage } from '../public/model-content.js';
import { normalizeBase, safeRequest } from './model-request.js';

export const providers = { dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1', openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', siliconflow: 'https://api.siliconflow.cn/v1', volcengine: 'https://ark.cn-beijing.volces.com/api/v3' };
const providerIds = ['custom', ...Object.keys(providers)];
export const aiDefaults = { provider: 'custom', baseUrl: '', protocol: 'chat', model: '', selectedModels: [], apiKey: '' };
export class AiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function modelName(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\r\n]/.test(value)) throw new AiError('模型名称无效或过长');
  return value.trim();
}
export function effectiveAi(value = {}) {
  const result = { ...aiDefaults, ...value };
  result.baseUrl ||= providers[result.provider] || '';
  result.selectedModels = [...new Set([result.model, ...(Array.isArray(result.selectedModels) ? result.selectedModels : [])].filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  return result;
}
function profileOf(value = {}) {
  const { baseUrl, protocol, model, selectedModels, apiKey } = effectiveAi(value);
  return { baseUrl, protocol, model, selectedModels, apiKey };
}
function savedProfiles(saved = {}) {
  const profiles = {};
  for (const provider of providerIds) if (saved.profiles?.[provider]) profiles[provider] = profileOf({ ...saved.profiles[provider], provider });
  if (providerIds.includes(saved.provider || 'custom')) profiles[saved.provider || 'custom'] = profileOf(saved);
  return profiles;
}
export function visibleAi(value = {}) {
  const redact = (provider, profile) => {
    const { baseUrl, protocol, model, selectedModels, apiKey } = profileOf({ ...profile, provider });
    return { provider, baseUrl, protocol, model, selectedModels, hasApiKey: Boolean(apiKey) };
  };
  const current = effectiveAi(value), profiles = {};
  for (const [provider, profile] of Object.entries(savedProfiles(value))) profiles[provider] = redact(provider, profile);
  return { ...redact(current.provider, current), profiles };
}
export function aiPatch(body, saved = {}) {
  const active = effectiveAi(saved), provider = body.provider ?? active.provider;
  if (!providerIds.includes(provider)) throw new AiError('请选择接口类型');
  const profiles = savedProfiles(saved);
  const current = effectiveAi({ ...profiles[provider], provider });
  let baseUrl = provider === 'custom' ? body.baseUrl ?? current.baseUrl : providers[provider];
  if (typeof baseUrl !== 'string') throw new AiError('接口地址无效');
  if (baseUrl) { try { baseUrl = normalizeBase(baseUrl); } catch { throw new AiError('请填写公网 HTTPS 基础地址，例如 https://example.com/v1'); } }
  const protocol = body.protocol ?? current.protocol;
  if (!['chat', 'responses'].includes(protocol)) throw new AiError('请选择有效的接口协议');
  if (protocol === 'responses' && !['custom', 'openai'].includes(provider)) throw new AiError('此预设当前仅支持 Chat Completions；使用其他协议请选择自定义接口');
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 1000 || /[\r\n]/.test(body.apiKey))) throw new AiError('密钥设置无效');
  if (body.clearKey !== undefined && typeof body.clearKey !== 'boolean') throw new AiError('密钥设置无效');
  const model = body.model === undefined ? current.model : modelName(body.model);
  let selectedModels = body.selectedModels ?? current.selectedModels;
  if (!Array.isArray(selectedModels) || selectedModels.length > 1000) throw new AiError('请选择有效的模型列表');
  selectedModels = [...new Set([model, ...selectedModels.map(modelName)].filter(Boolean))];
  let previousBase = current.baseUrl;
  try { if (previousBase) previousBase = normalizeBase(previousBase); } catch { previousBase = ''; }
  const apiKey = body.clearKey ? '' : body.apiKey?.trim() || (baseUrl === previousBase ? current.apiKey : '');
  const profile = { baseUrl, protocol, model, selectedModels, apiKey };
  profiles[provider] = profile;
  return { provider, ...profile, profiles };
}
export function modelList(result) {
  if (!Array.isArray(result?.data)) throw new AiError('服务商不支持标准模型列表，可手动填写模型名称。', 502);
  return [...new Set(result.data.map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100))].sort().slice(0, 1000);
}
export function modelAnswer(result, protocol) {
  const message = result?.choices?.[0]?.message;
  if (message?.tool_calls?.length || message?.function_call || result?.output?.some(item => ['function_call', 'custom_tool_call'].includes(item?.type))) throw new AiError(unsupportedToolMessage, 502);
  let answer = message?.content;
  if (protocol === 'responses') answer = result?.output_text || result?.output?.filter(item => item?.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item?.type === 'output_text').map(item => item.text || '').join('');
  if (typeof answer !== 'string' || !answer.trim()) throw new AiError('模型没有返回文字回复，请检查模型是否支持文字对话。', 502);
  const cleaned = cleanModelText(answer);
  if (cleaned.removed) throw new AiError(unsupportedToolMessage, 502);
  return cleaned.content.slice(0, 16000);
}
export async function probeAi(config, { models = false, signal, request = safeRequest } = {}) {
  if (!config.baseUrl || !config.apiKey) throw new AiError('请填写接口地址和 API 密钥');
  if (!models && !config.model) throw new AiError('请先选择模型');
  const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' };
  let endpoint = 'models', options = { signal, headers };
  if (!models) {
    const messages = [{ role: 'user', content: '请只回复：连接正常' }], instructions = '这是一次连接测试，请简短回复。';
    endpoint = config.protocol === 'responses' ? 'responses' : 'chat/completions';
    const payload = config.protocol === 'responses'
      ? { model: config.model, instructions, input: messages, stream: false, store: false, max_output_tokens: 1024 }
      : { model: config.model, messages: [{ role: 'system', content: instructions }, ...messages], max_tokens: 1024, stream: false };
    options = { ...options, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  }
  const response = await request(`${config.baseUrl}/${endpoint}`, options);
  if (!response.ok) throw new AiError(`模型服务返回 HTTP ${response.status}，请检查地址、密钥、接口协议和模型权限。`, 502);
  let result;
  try { result = await response.json(); } catch { throw new AiError('服务商没有返回有效 JSON，请检查接口协议。', 502); }
  if (models) return { models: modelList(result) };
  modelAnswer(result, config.protocol);
  return { ok: true, model: config.model };
}
