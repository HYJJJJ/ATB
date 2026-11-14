// Preserve the provider/model language IDs instead of grouping them into fixed UI buckets.
export function catalogueLanguages(voices, declared = []) {
 if (declared?.length) return declared;
 const ids = [...new Set(voices.flatMap(v => v.languages?.length ? v.languages : v.locale ? [v.locale] : []))];
 let display; try { display = new Intl.DisplayNames(['zh-CN'], {type:'language'}); } catch {}
 return ids.map(id => { let name=id; try { name=display?.of(id)||id; } catch {} return {id,name}; });
}
export function voiceMatchesLanguage(voice, language) {
 return language === 'all' || (voice.languages?.length ? voice.languages.includes(language) : voice.locale === language);
}


export function sortChatSpeakers(voices, metric = 'rankSingle') {
 const key = ['rankSingle','rankMulti','rankLong'].includes(metric) ? metric : 'rankSingle';
 return [...voices].sort((a,b) => {
  const rankedA=Number.isFinite(a[key]),rankedB=Number.isFinite(b[key]);
  return Number(rankedB)-Number(rankedA) || (rankedA ? b[key]-a[key] || Number(a.seedId.slice(5))-Number(b.seedId.slice(5)) : 0);
 });
}
export function voiceOptionLabel(voice, metric = 'rankSingle') {
 if (voice.source === 'ChatTTS_Speaker') {
  const key=['rankSingle','rankMulti','rankLong'].includes(metric)?metric:'rankSingle';
  const label={rankSingle:'单句',rankMulti:'多句',rankLong:'长句'}[key];
  return `${voice.seedId} · Gender ${voice.gender} · Age ${voice.age} · ${label} ${voice[key].toFixed(2)}`;
 }
 return `${voice.name} · ${voice.gender === 'Male' ? '男声' : voice.gender === 'Female' ? '女声' : voice.locale === 'mul' ? '多语言' : voice.locale} (${voice.id})`;
}
