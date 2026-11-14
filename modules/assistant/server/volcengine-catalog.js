import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const volcengineCatalogUrl = 'https://docs.volcengine.com/docs/zh/doubao-voice/tone-list-3.md';
const resources = new Set(['seed-tts-1.0', 'seed-tts-2.0']);
const emotionNames = { 开心: 'happy', 愉悦: 'happy', 悲伤: 'sad', 生气: 'angry', 愤怒: 'angry', 惊讶: 'surprised', 恐惧: 'fear', 厌恶: 'hate', 激动: 'excited', 冷漠: 'coldness', 中性: 'neutral', 沮丧: 'depressed', 深情: 'affectionate', 温暖: 'warm', 撒娇: 'lovey-dovey', 害羞: 'shy', 安慰鼓励: 'comfort', '咆哮/焦急': 'tension', 温柔: 'tender', '讲故事 / 自然讲述': 'storytelling', 情感电台: 'radio', 磁性: 'magnetic', 广告营销: 'advertising', 气泡音: 'vocal-fry', 低语: 'ASMR', 新闻播报: 'news', 娱乐八卦: 'entertainment', 方言: 'dialect', 权威: 'authoritative', 兴奋: 'excited', ASMR: 'ASMR', '对话/闲聊': 'chat' };
const clean = text => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/\\-/g, '-').replace(/[*`]/g, '').trim();

export function parseVolcengineCatalog(markdown) {
  let resourceId = ''; const voices = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      const model = line.match(/豆包语音合成模型([12])\.0/);
      resourceId = model ? `seed-tts-${model[1]}.0` : '';
    }
    if (!resourceId || !line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(clean);
    const index = cells.findIndex(cell => /^[a-zA-Z][a-zA-Z0-9_]{5,159}$/.test(cell) && /(?:bigtts|^ICL_)/.test(cell));
    if (index < 1) continue;
    const id = cells[index], language = cells[index + 1] || '', emotions = [];
    if (resourceId === 'seed-tts-1.0') for (const label of (cells[index + 2] || '').split(/[、，,]/)) {
      const value = emotionNames[label.trim()]; if (value && !emotions.some(item => item.value === value)) emotions.push({ label: label.trim(), value });
    }
    voices.set(id, { id, name: cells[index - 1] || id, gender: /_female_/.test(id) ? 'Female' : /_male_/.test(id) ? 'Male' : 'Unknown',
      locale: /台湾/.test(language) ? 'zh-TW' : /中文|普通话/.test(language) ? 'zh-CN' : id.split('_')[0], language: language.slice(0, 300), resourceId, emotions, availability: 'unverified' });
  }
  if (!voices.size || voices.size > 2000) throw Error('官方音色目录格式已变化，保留现有列表');
  return [...voices.values()];
}

export async function readBoundedText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength; if (size > limit) throw Error('服务响应过大');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function validCatalog(value) {
  if (!Array.isArray(value?.voices) || !value.voices.length || value.voices.length > 2000 ||
    !value.voices.every(v => /^[a-zA-Z][a-zA-Z0-9_]{5,159}$/.test(v.id) && resources.has(v.resourceId) && typeof v.name === 'string' && typeof v.locale === 'string' && Array.isArray(v.emotions))) throw Error('音色缓存无效');
  return { ...value, voices: value.voices.map(v => ({ ...v, availability: 'unverified' })) };
}

export async function loadVolcengineCatalog(dataDir) {
  try { return { ...validCatalog(JSON.parse(await readFile(path.join(dataDir, 'volcengine-catalog.json'), 'utf8'))), source: 'official-cache' }; }
  catch { return { ...validCatalog(JSON.parse(await readFile(new URL('./volcengine-voices.json', import.meta.url), 'utf8'))), source: 'official-snapshot' }; }
}

export async function refreshVolcengineCatalog(dataDir, request = fetch) {
  const response = await request(volcengineCatalogUrl, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'text/markdown' } });
  if (!response.ok) { await response.body?.cancel(); throw Error('官方音色目录获取失败，保留现有列表'); }
  const voices = parseVolcengineCatalog(await readBoundedText(response, 1024 * 1024));
  const result = { voices, updatedAt: new Date().toISOString(), source: 'official-online', sourceUrl: volcengineCatalogUrl };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'volcengine-catalog.json');
  await writeFile(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 }); await rename(`${file}.tmp`, file);
  return result;
}
