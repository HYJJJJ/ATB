export async function mountCompanionSettings({container,api,onDirty=()=>{}}){
 const desktop=window.atbDesktop;if(!container||!desktop?.hasModule('assistant'))return;
 let closed=false,revision=0,city,searchVersion=0;
 const invoke=settings=>desktop.invokeModule('assistant','companion',{action:'settings',...(settings?{settings}:{})});
 const value=await invoke();if(closed)return;city=value.city;
 const details=document.createElement('details');details.className='card';details.open=true;
 const summary=document.createElement('summary');summary.textContent='桌面小助手 · 鲸鱼娘';details.append(summary);
 const form=document.createElement('form');form.className='settings';form.style.cssText='border:0;padding:8px 0 0;background:none;box-shadow:none';details.append(form);
 const controls=new Map();
 for(const[key,label]of[['enabled','显示桌面小助手'],['showText','显示流式回复文字'],['reminders','允许随机信息气泡'],['balance','余额提醒'],['weather','天气提醒'],['news','新闻提醒'],['tips','使用提示']]){
  const row=document.createElement('div'),field=document.createElement('label'),input=document.createElement('input');field.className='check';input.type='checkbox';input.checked=Boolean(value[key]);field.append(input,document.createTextNode(label));row.append(field);form.append(row);controls.set(key,input);
 }
 const cityLabel=document.createElement('label');cityLabel.textContent='天气城市';cityLabel.htmlFor='companion-city';
 const cityInput=document.createElement('input');cityInput.id='companion-city';cityInput.type='search';cityInput.placeholder='输入城市，如 上海 / Shanghai';cityInput.value=city?.name||'';cityInput.maxLength=60;
 const search=document.createElement('button');search.type='button';search.className='secondary';search.textContent='搜索城市';
 const selected=document.createElement('p');selected.className='muted';selected.textContent=city?'已选：'+city.name:'未选择城市，暂不弹出天气';
 const choices=document.createElement('div');choices.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
 const note=document.createElement('p');note.className='muted';note.textContent='气泡每隔随机4–9分钟提供一次信息，语音忙碌或免打扰时暂停。余额提醒也包含近24小时消费：优先汇总当前密钥日志；不支持时记录账户余额减少估算，并标注已记录时长，充值或退款可能掩盖同期消费。天气：Open-Meteo，失败时用 wttr.in / WWO；新闻：中国新闻网。图片仅点击后加载。关闭主窗口会收进系统托盘，可从托盘退出。';
 const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='保存小助手设置';
 const result=document.createElement('p');result.className='muted';result.setAttribute('role','status');
 form.append(cityLabel,cityInput,search,selected,choices,note,save,result);container.replaceChildren(details);
 const changed=()=>{revision++;onDirty(true);result.textContent='未保存';};form.addEventListener('input',changed);
 cityInput.addEventListener('input',()=>{searchVersion++;choices.replaceChildren();});
 search.addEventListener('click',async()=>{const epoch=++searchVersion;search.disabled=true;result.textContent='正在搜索城市…';try{const response=await api('/api/assistant/companion/cities?q='+encodeURIComponent(cityInput.value.trim()));if(closed||epoch!==searchVersion)return;choices.replaceChildren();for(const item of response.cities||[]){const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=item.name+(item.region?' · '+item.region:'');button.addEventListener('click',()=>{city={name:item.name,latitude:item.latitude,longitude:item.longitude};cityInput.value=item.name;selected.textContent='已选：'+button.textContent;choices.replaceChildren();changed();});choices.append(button);}result.textContent=choices.childElementCount?'请选择匹配的城市':'未找到城市，可试试英文名';}catch{if(!closed)result.textContent='城市查询失败，请稍后重试';}finally{if(!closed)search.disabled=false;}});
 form.addEventListener('submit',async event=>{event.preventDefault();if(save.disabled)return;const epoch=revision,patch=Object.fromEntries([...controls].map(([key,input])=>[key,input.checked]));patch.city=city;save.disabled=true;try{await invoke(patch);if(closed)return;if(epoch===revision){onDirty(false);result.textContent='小助手设置已保存';}else result.textContent='已保存上次提交，当前修改尚未保存';}catch{if(!closed)result.textContent='保存失败，请稍后重试';}finally{if(!closed)save.disabled=false;}});
 return{close(){closed=true;searchVersion++;container.replaceChildren();onDirty(false);}};
}
