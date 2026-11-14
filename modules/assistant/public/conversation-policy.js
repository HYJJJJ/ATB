// Shared saved conversation preferences; no model or microphone access here.
export const conversationDefaults = { responseStyle: 'natural', followUpQuestions: true, proactiveChat: false, proactiveIdleSeconds: 30, opportunityProbability: 0.55, opportunityDailyLimit: 8 };
export function conversationPatch(input, previous = conversationDefaults) {
  const next = { ...conversationDefaults, ...previous };
  if (input.responseStyle !== undefined) {
    if (!['concise', 'natural', 'talkative'].includes(input.responseStyle)) throw Error('请选择简洁、自然或健谈');
    next.responseStyle = input.responseStyle;
  }
  for (const key of ['followUpQuestions', 'proactiveChat']) if (input[key] !== undefined) {
    if (typeof input[key] !== 'boolean') throw Error('对话开关格式无效'); next[key] = input[key];
  }
  if (input.proactiveIdleSeconds !== undefined) {
    if (!Number.isInteger(input.proactiveIdleSeconds) || input.proactiveIdleSeconds < 15 || input.proactiveIdleSeconds > 300) throw Error('主动接话等待需在15到300秒之间');
    next.proactiveIdleSeconds = input.proactiveIdleSeconds;
  }
  if (input.opportunityProbability !== undefined) {
    if (typeof input.opportunityProbability !== 'number' || !Number.isFinite(input.opportunityProbability) || input.opportunityProbability < 0 || input.opportunityProbability > 1) throw Error('机会命中概率需在0到1之间');
    next.opportunityProbability = input.opportunityProbability;
  }
  if (input.opportunityDailyLimit !== undefined) {
    if (!Number.isInteger(input.opportunityDailyLimit) || input.opportunityDailyLimit < 1 || input.opportunityDailyLimit > 8) throw Error('每天机会数需在1到8之间');
    next.opportunityDailyLimit = input.opportunityDailyLimit;
  }
  return Object.fromEntries(Object.keys(conversationDefaults).map(key => [key, next[key]]));
}
export function conversationInstructions(settings) {
  const style = {
    concise: '交流风格：简洁。先直接回答，通常1–2句；复杂问题仍需说清关键内容。',
    natural: '交流风格：自然。像熟悉的伙伴交流，通常2–4句，有回应也有具体内容，不局限于一句。',
    talkative: '交流风格：健谈。围绕用户话题展开，适当分享相关角度、具体例子或建议，通常4–8句；不要只给一句敷衍回应。',
  }[settings.responseStyle] || '';
  return `${style}\n${settings.followUpQuestions ? '适合继续聊时，自然提出最多一个相关问题；不是每次都追问，不连续盘问。' : '不主动追问；需要关键澄清信息时才提问。'}\n用户明确要求简短、只要结论或结束聊天时优先遵从；简单确认不硬凑句数，不重复、说教或编造共同经历。语音表达采用自然短句，避免无必要的列表和格式。`;
}
