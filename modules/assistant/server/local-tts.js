import { readFileSync } from 'node:fs';
const qwen = JSON.parse(readFileSync(new URL('../assistant/qwen-tts-capabilities.json', import.meta.url), 'utf8'));
const speakers = JSON.parse(readFileSync(new URL('../assistant/chattts-speakers.json', import.meta.url), 'utf8'));
const speakerIds = new Set(speakers.voices.map(voice => `chattts:speaker:${voice.seedId}`));
export const localProviders = ['chattts', 'qwen3tts'];
export const localNames = { chattts: 'ChatTTS', qwen3tts: 'Qwen3-TTS 0.6B' };
export const localDirectories = { chattts: 'chattts', qwen3tts: 'qwen3-tts-0.6b-customvoice' };
const speakerDescriptions = {
 serena:'Serena · 温暖柔和女声',vivian:'Vivian · 明亮年轻女声',uncle_fu:'Uncle_Fu · 低沉醇厚男声',
 dylan:'Dylan · 北京青年男声',eric:'Eric · 成都活泼男声',ryan:'Ryan · 节奏感英语男声',
 aiden:'Aiden · 美式英语男声',ono_anna:'Ono_Anna · 轻快日语女声',sohee:'Sohee · 温暖韩语女声',
};
const qwenSpeakers = Object.keys(qwen.config.talker_config.spk_id);
const qwenLanguages = qwen.languages || Object.keys(qwen.config.talker_config.codec_language_id);
export const localVoices = {
  qwen3tts: qwenSpeakers.map(speaker => ({ id: `qwen3tts:${speaker}`, name: speakerDescriptions[speaker] || speaker, locale: 'mul', languages: qwenLanguages })),
  chattts: [...speakers.voices.map(({vectorIndex, ...voice}) => ({ ...voice, id:`chattts:speaker:${voice.seedId}`, name:voice.seedId, source:'ChatTTS_Speaker', locale:'mul', languages:['zh','en'] })),
    ...[42, 1234, 2024, 10086].map(seed => ({ id: `chattts:${seed}`, name: `随机种子 ${seed} · 未评分`, locale: 'mul', languages: ['zh','en'], seed }))],
};
export const localModelFiles = {
  qwen3tts: ['model.safetensors', 'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'merges.txt', 'vocab.json', 'speech_tokenizer/config.json', 'speech_tokenizer/configuration.json', 'speech_tokenizer/model.safetensors', 'speech_tokenizer/preprocessor_config.json', 'installed.json'],
  chattts: ['asset/Decoder.safetensors', 'asset/DVAE.safetensors', 'asset/Embed.safetensors', 'asset/Vocos.safetensors', 'asset/gpt/model.safetensors', 'asset/gpt/config.json', 'asset/tokenizer/tokenizer.json', 'asset/tokenizer/tokenizer_config.json', 'asset/tokenizer/special_tokens_map.json', 'installed.json'],
};

export const localCapabilities = {
 chattts: { voiceKind:'seed', audioStreaming:true, rankedVoiceCount:speakers.voices.length, description:`ChatTTS_Speaker 榜单 ${speakers.voices.length} 个已评分音色，使用保存的说话人向量；评分衡量稳定性，Gender / Age 为估计标签。另支持自定义随机种子。` },
 qwen3tts: { voiceKind:'builtin', audioStreaming:true, description:'CustomVoice 0.6B · 模型完整预置音色；标准语速下按短句输入，音频码边生成边解码播放。调整语速时整句生成后播放，自动识别文本语言。' },
};
export function validChatVoice(voice) { return speakerIds.has(voice) || /^chattts:(0|[1-9][0-9]{0,9})$/.test(voice) && Number(voice.slice(8)) <= 4294967295; }
export function localCatalog(provider, selected) {
 const voices = [...localVoices[provider]];
 if (provider === 'chattts' && validChatVoice(selected) && !voices.some(v=>v.id===selected)) voices.push({id:selected,name:'种子 '+selected.slice(8),locale:'mul',languages:['zh','en'],seed:Number(selected.slice(8))});
 const names = {zh:'中文',en:'English',chinese:'Chinese',english:'English',german:'German',italian:'Italian',portuguese:'Portuguese',spanish:'Spanish',japanese:'Japanese',korean:'Korean',french:'French',russian:'Russian',beijing_dialect:'Beijing Dialect',sichuan_dialect:'Sichuan Dialect',auto:'Auto'};
 const ids = provider === 'qwen3tts' ? qwenLanguages : ['zh','en'];
 return {voices, provider, source:'model', languages:ids.map(id=>({id,name:names[id]||id})),capabilities:localCapabilities[provider]};
}
