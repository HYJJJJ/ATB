// Presets use their default China region; alternate regions use Custom.
export const aiPresets = {
  custom: { label: '自定义兼容接口', baseUrl: '', responses: true },
  openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', responses: true },
  dashscope: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  volcengine: { label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
};
function draftOf(provider, value = {}) {
  const preset = aiPresets[provider] || aiPresets.custom;
  return { provider, baseUrl: provider === 'custom' ? value.baseUrl || '' : preset.baseUrl,
    protocol: preset.responses ? value.protocol || 'chat' : 'chat', model: value.model || '',
    selectedModels: [...(value.selectedModels || [])], apiKey: value.apiKey || '', clearKey: !!value.clearKey };
}
// Draft secrets live only in this page's memory. reset/clear must run on logout/account change.
export function createAiProfileDrafts() {
  let profiles = {}, drafts = new Map();
  return {
    reset(value = {}) { profiles = { ...(value.profiles || {}), [value.provider || 'custom']: value }; drafts.clear(); },
    remember(value) {
      const draft = draftOf(value.provider, value);
      if (JSON.stringify(draft) === JSON.stringify(draftOf(value.provider, profiles[value.provider]))) drafts.delete(value.provider);
      else drafts.set(value.provider, draft);
    },
    get(provider) { return structuredClone(drafts.get(provider) || draftOf(provider, profiles[provider])); },
    saved(provider) { return structuredClone(profiles[provider] || {}); },
    accept(value) { profiles = { ...profiles, ...(value.profiles || {}), [value.provider]: value }; drafts.delete(value.provider); },
    hasDrafts() { return drafts.size > 0; },
    clear() { profiles = {}; drafts.clear(); },
  };
}
export function fillAiProviderOptions(select) {
  select.replaceChildren(...Object.entries(aiPresets).map(([id, preset]) => {
    const option = document.createElement('option'); option.value = id; option.textContent = preset.label; return option;
  }));
}
export function applyAiPresetControls(provider, baseInput, protocolSelect) {
  const preset = aiPresets[provider] || aiPresets.custom;
  baseInput.readOnly = provider !== 'custom';
  if (baseInput.readOnly) baseInput.value = preset.baseUrl;
  const responses = protocolSelect.querySelector('option[value="responses"]');
  if (responses) { responses.disabled = !preset.responses; responses.hidden = !preset.responses; }
  if (!preset.responses) protocolSelect.value = 'chat';
}
