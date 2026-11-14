import { randomUUID } from 'node:crypto';

export const synthesisMethods = ['ws-bidirectional', 'ws-unidirectional', 'http-chunked', 'http-sse'];
export const modelNames = ['seed-tts-2.0', 'seed-tts-1.0', 'seed-tts-1.0-concurr', 'seed-icl-2.0', 'seed-icl-1.0', 'seed-icl-1.0-concurr'];
export const volcengineVoices = [{ id: 'zh_female_wanwanxiaohe_moon_bigtts', name: '湾湾小何 · 台湾口音', gender: 'Female', locale: 'zh-TW' }];
const defaults = { authMode: 'apiKey', appId: '', apiKey: '', accessKey: '', modelName: 'seed-tts-1.0', method: 'http-chunked', sampleRate: 24000, emotion: '', emotionScale: 4, contextTexts: '', modelVersion: 'seed-tts-2.0-standard' };

export function volcenginePatch(patch = {}, saved = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('火山引擎配置无效');
  const next = { ...defaults, ...saved, modelName: saved.modelName || saved.resourceId || defaults.modelName };
  for (const field of ['authMode', 'appId', 'apiKey', 'accessKey', 'modelName', 'method', 'emotion', 'contextTexts', 'modelVersion']) if (field in patch) {
    if (typeof patch[field] !== 'string' || patch[field].length > 2000 || /[\r\n\0]/.test(patch[field])) throw Error('火山引擎配置格式无效');
    const value = patch[field].trim(); if (!['apiKey', 'accessKey'].includes(field) || value) next[field] = value;
  }
  if (!('modelName' in patch) && 'resourceId' in patch) next.modelName = patch.resourceId;
  if (!modelNames.includes(next.modelName)) throw Error('请选择有效模型名称');
  next.resourceId = next.modelName; // Compatibility with saved ATB settings, not a user-facing label.
  if (!synthesisMethods.includes(next.method)) throw Error('请选择有效合成方式');
  if (!['apiKey', 'legacy'].includes(next.authMode)) throw Error('请选择火山引擎认证方式');
  if (!/^\d{0,32}$/.test(next.appId)) throw Error('APP ID 应为控制台中的数字编号');
  if ('sampleRate' in patch) next.sampleRate = patch.sampleRate;
  if (![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(next.sampleRate)) throw Error('请选择有效采样率');
  if ('emotionScale' in patch) next.emotionScale = patch.emotionScale;
  if (!Number.isInteger(next.emotionScale) || next.emotionScale < 1 || next.emotionScale > 5) throw Error('情感强度需在 1 到 5 之间');
  if (!/^[a-zA-Z-]{0,40}$/.test(next.emotion)) throw Error('情感参数无效');
  if (!['seed-tts-2.0-standard', 'seed-tts-2.0-expressive'].includes(next.modelVersion)) throw Error('请选择有效复刻模型版本');
  if ('clearCredentials' in patch && typeof patch.clearCredentials !== 'boolean') throw Error('清除凭据选项无效');
  if (patch.clearCredentials) { next.apiKey = ''; next.accessKey = ''; }
  if (saved.appId && next.appId !== saved.appId && !patch.accessKey?.trim()) next.accessKey = '';
  return next;
}
export function visibleVolcengine(saved) {
  const { apiKey, accessKey, ...next } = volcenginePatch({}, saved);
  return { ...next, hasApiKey: Boolean(apiKey), hasAccessKey: Boolean(accessKey) };
}
export function volcengineSetupError(saved = {}) {
  const config = volcenginePatch({}, saved);
  return config.authMode === 'legacy' ? config.appId && config.accessKey ? '' : '请先填写火山引擎 APP ID 和 Access Token' : config.apiKey ? '' : '请先填写火山引擎语音 API Key';
}
export function synthesisHeaders(config) {
  const headers = { 'X-Api-Resource-Id': config.modelName, 'X-Api-Request-Id': randomUUID(), 'X-Api-Connect-Id': randomUUID() };
  if (config.authMode === 'legacy') { headers['X-Api-App-Id'] = config.appId; headers['X-Api-Access-Key'] = config.accessKey; }
  else headers['X-Api-Key'] = config.apiKey;
  return headers;
}
export function synthesisPayload({ voice, rate = 0, volume = 0, pitch = 0, config, format = 'pcm' }, text) {
  for (const [value, min, max] of [[rate, -50, 100], [volume, -50, 100], [pitch, -12, 12]]) if (!Number.isInteger(value) || value < min || value > max) throw Error('语速、音量或音调超出官方范围');
  if (typeof voice !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(voice)) throw Error('音色 ID 无效');
  const second = config.modelName.endsWith('2.0'), clone = config.modelName.startsWith('seed-icl-');
  const additions = { post_process: { pitch } };
  if (second && config.contextTexts && (!clone || config.modelVersion === 'seed-tts-2.0-expressive')) additions.context_texts = [config.contextTexts];
  return { user: { uid: 'atb-assistant' }, req_params: {
    ...(text === undefined ? {} : { text }), speaker: voice,
    ...(clone && second ? { model: config.modelVersion } : {}),
    audio_params: { format, sample_rate: config.sampleRate, speech_rate: rate, loudness_rate: volume,
      ...(!second && config.emotion ? { emotion: config.emotion, emotion_scale: config.emotionScale } : {}) },
    additions: JSON.stringify(additions),
  } };
}
export class SynthesisError extends Error {}
export function providerError({ status, code, message, config, logId }) {
  let reason = '服务拒绝请求，请核对所选模型、音色与该项目的服务配置';
  if (code === 45000030 || /requested resource not granted/i.test(message || '')) reason = '所请求模型资源尚未授权；请在此 API Key 所属项目检查对应服务的开通与授权';
  else if (code === 45000010 || /invalid x-api-key/i.test(message || '')) reason = '当前请求的 API Key 鉴权失败，请核对当前运行端保存的 Key、项目及认证方式';
  else if (/speaker permission denied/i.test(message || '')) reason = '该音色未获授权或与模型不匹配，请核对音色 ID 及模型名称';
  else if (/quota exceeded.*concurrency/i.test(message || '')) reason = '当前并发数超过服务限制，请稍后重试';
  else if (/quota|balance/i.test(message || '')) reason = '服务返回额度限制，请在控制台检查对应服务的额度';
  const trace = /^[a-zA-Z0-9-]{1,80}$/.test(logId || '') && ![config.apiKey, config.accessKey].includes(logId) ? `；日志 ID：${logId}` : '';
  return new SynthesisError(`火山引擎语音${status ? ` HTTP ${status}` : ''}${Number.isInteger(code) ? ` / 错误 ${code}` : ''}：${reason}（模型名称：${config.modelName}）${trace}`);
}
