import { navigateModule } from './ui.js';
const $ = id => document.getElementById(id);
let user, needsSetup = false, sessionTask, sessionTimer, noticeTimer, version = 0, installed = [], settingsLoaded = false;
let background = [], selectedModule = null, orbitPage = 0;
const ORBIT_PAGE_SIZE = 4;
const labels = { overview: '工作台', settings: '平台设置' };
const dirty = new Set();
let aiConfig, selectedModels = [], availableModels = [], pendingSelection = new Set(), aiRevision = 0, aiTask, accountRevision = 0;
const aiFields = ['ai-provider','ai-protocol','ai-base-url','ai-api-key','ai-clear-key','ai-model'];
async function api(url, data, signal = AbortSignal.timeout(8000)) {
  const response = await fetch(url, { signal, ...(data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }) });
  let value; try { value = await response.json(); } catch { throw Error('服务返回异常，请稍后再试'); }
  if (response.status === 401 && !url.startsWith('/api/auth/')) signedOut('登录已过期，请重新登录');
  if (!response.ok) throw Error(value.error || '请求失败'); return value;
}
function notice(message) { $('notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').textContent = '', 5000); }
function show() {
  const [route, tab] = location.hash.slice(1).split('/');
  const page = labels[route] ? route : 'overview';
  document.querySelectorAll('.page').forEach(element => element.hidden = element.id !== `page-${page}`);
  document.querySelectorAll('[data-page]').forEach(element => { element.classList.toggle('active', element.dataset.page === page); if (element.dataset.page === page) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
  $('page-label').textContent = labels[page]; document.documentElement.dataset.page = page;
  if (page === 'settings' && ['general','account','ai'].includes(tab)) settingsTab(tab);
}
function connection(online) { $('service-status').textContent = online ? '平台服务已连接' : '连接中断 · 重试中'; $('network-banner').hidden = online; document.documentElement.dataset.online = String(online); }
function textElement(tag, className, value) { const element = document.createElement(tag); if (className) element.className = className; element.textContent = value; return element; }
function moduleSymbol(module, className = 'module-icon') {
  const symbols = {
    freecamera: '<rect x="3" y="5" width="18" height="14" rx="4"/><circle cx="12" cy="12" r="3.6"/><path d="M17.3 8.5h.01"/>',
    assistant: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z"/>',
    rustdesk: '<rect x="2.5" y="4" width="19" height="13" rx="2.2"/><path d="M8 21h8m-4-4v4"/>',
    module: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  };
  const symbol = document.createElement('span'); symbol.className = className;
  symbol.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (Object.hasOwn(symbols, module.id) ? symbols[module.id] : symbols.module) + '</svg>';
  return symbol;
}
function selectModule(id, focus = false) {
  const index = installed.findIndex(module => module.id === id);
  if (index < 0) return;
  const module = installed[index]; selectedModule = id;
  const nextPage = Math.floor(index / ORBIT_PAGE_SIZE);
  if (nextPage !== orbitPage) { orbitPage = nextPage; renderOrbitPage(); }
  for (const node of $('orbit-nodes').children) {
    const selected = node.dataset.moduleId === id;
    node.setAttribute('aria-pressed', String(selected)); node.tabIndex = selected ? 0 : -1;
    if (selected && focus) node.focus();
  }
  $('module-kicker').textContent = String(index + 1).padStart(2, '0') + ' / YOUR MODULE';
  $('module-name').textContent = module.name;
  $('module-description').textContent = module.description;
  $('module-version').textContent = 'v' + module.version;
  $('module-open').href = module.entry; $('module-open').hidden = false;
}
function renderOrbitPage() {
  const start = orbitPage * ORBIT_PAGE_SIZE, modules = installed.slice(start, start + ORBIT_PAGE_SIZE);
  $('orbit-pagination').hidden = installed.length <= ORBIT_PAGE_SIZE;
  $('orbit-page-status').textContent = (orbitPage + 1) + ' / ' + Math.max(1, Math.ceil(installed.length / ORBIT_PAGE_SIZE));
  $('orbit-prev').disabled = orbitPage === 0;
  $('orbit-next').disabled = start + ORBIT_PAGE_SIZE >= installed.length;
  $('orbit-nodes').replaceChildren(...modules.map((module, pageIndex) => {
    const index = start + pageIndex;
    const node = document.createElement('button'); node.type = 'button'; node.className = 'orbit-node'; node.dataset.moduleId = module.id;
    node.setAttribute('aria-label', '选择' + module.name); node.setAttribute('aria-pressed', 'false'); node.title = module.name;
    const angle = -Math.PI / 2 + pageIndex * 2 * Math.PI / modules.length;
    node.style.setProperty('--node-x', (50 + 34 * Math.cos(angle)).toFixed(3) + '%');
    node.style.setProperty('--node-y', (50 + 34 * Math.sin(angle)).toFixed(3) + '%');
    const caption = document.createElement('span'); caption.className = 'node-caption';
    caption.append(textElement('strong', '', module.name), textElement('small', '', 'MODULE / ' + String(index + 1).padStart(2, '0')));
    node.append(moduleSymbol(module, 'node-symbol'), caption);
    node.addEventListener('click', () => selectModule(module.id));
    node.addEventListener('dblclick', event => { event.preventDefault(); navigateModule(module.entry); });
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); navigateModule(module.entry); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? installed.length - 1 : (index + step + installed.length) % installed.length;
        selectModule(installed[next].id, true);
      }
    });
    return node;
  }));
}
function renderModules(modules, errors) {
  installed = modules; $('module-count').textContent = String(modules.length); $('empty-modules').hidden = modules.length > 0;
  $('orbit-count').textContent = String(modules.length).padStart(2, '0') + ' MODULES';
  $('orbit-stage').closest('.orbit-workspace').classList.toggle('empty-orbit', !modules.length);
  orbitPage = Math.floor(Math.max(0, modules.findIndex(module => module.id === selectedModule)) / ORBIT_PAGE_SIZE);
  renderOrbitPage();
  if (modules.length) selectModule(modules.some(module => module.id === selectedModule) ? selectedModule : modules[0].id);
  else { selectedModule = null; $('module-open').hidden = true; }
  $('module-list').replaceChildren(...modules.map(module => {
    const row=document.createElement('div'); row.className='module-row'; const detail=document.createElement('div');detail.className='detail'; detail.append(textElement('strong','',module.name),textElement('p','',module.description),textElement('small','',`${module.id} · v${module.version}`));
    const link=textElement('a','secondary','打开模块 ↗');link.href=module.entry;row.append(moduleSymbol(module),detail,link);return row;
  }));
  if (!modules.length) $('module-list').append(textElement('p','muted','还没有安装模块。'));
  $('module-errors').hidden = !errors.length; $('module-errors').textContent=errors.map(item=>`${item.id}：${item.error}`).join('；');
}
$('orbit-prev').addEventListener('click', () => { const module = installed[(orbitPage - 1) * ORBIT_PAGE_SIZE]; if (module) selectModule(module.id); });
$('orbit-next').addEventListener('click', () => { const module = installed[(orbitPage + 1) * ORBIT_PAGE_SIZE]; if (module) selectModule(module.id); });
async function stopBackground() { const old=background; background=[]; await Promise.allSettled(old.map(item=>item.close?.())); }
async function startBackground(config, generation) {
  await stopBackground();
  for (const module of config.modules || []) if (module.background) {
    try { const provider = await import(module.background); if (generation !== version || !user) return; const handle = await provider.activate?.({config,api}); if (generation !== version || !user) await handle?.close?.(); else if(handle) background.push(handle); } catch {}
  }
}
function signedOut(message='') {
  version++; user=null; settingsLoaded=false; void stopBackground();
  aiTask?.abort(); $('ai-model-dialog').close();
  renderModules([], []);
  $('login').hidden=false; $('workspace').hidden=true; $('user-label').textContent='访客'; $('login-error').textContent=message;
  $('server-label').value=''; $('server-host').value=''; fillAi({}); availableModels=[]; pendingSelection.clear(); $('ai-model-options').replaceChildren(); $('ai-model-suggestions').replaceChildren(); $('account-form').reset(); document.documentElement.dataset.authenticated='false'; dirty.clear();
}
async function refreshSession() {
  if (sessionTask) return sessionTask;
  sessionTask=(async()=>{
    const generation=version; let delay=document.hidden?20000:7000;
    try {
      const session=await api('/api/auth/session'); if(generation!==version)return; connection(true); needsSetup=session.needsSetup;
      $('login-title').textContent=needsSetup?'创建你的 ATB 管理员':'欢迎回到 ATB'; $('confirm-row').hidden=!needsSetup;
      $('login-note').textContent=needsSetup?session.canSetup?'建立一个账号，所有模块共同使用。':'请先在运行平台的电脑上创建管理员账号。':'登录后，连接你需要的一切。'; $('login-form').querySelector('button').disabled=needsSetup&&!session.canSetup;
      if(!session.user){if(user)signedOut('登录已过期，请重新登录');else $('login').hidden=false;return;}
      const changed=!user||user.username!==session.user.username; user=session.user; $('login').hidden=true;$('workspace').hidden=false;document.documentElement.dataset.authenticated='true';$('user-label').textContent=user.username;
      if(changed||!settingsLoaded){
        const [catalog,settings,config,ai]=await Promise.all([api('/api/platform/modules'),api('/api/platform/settings'),api('/api/config'),api('/api/platform/ai')]);
        if(generation!==version||!user)return;
        renderModules(catalog.modules,catalog.errors); if(!dirty.has('server')){$('server-label').value=settings.server.label;$('server-host').value=settings.server.publicHost;}
        if(!dirty.has('ai')) fillAi(ai); if(!dirty.has('account')) $('account-username').value=user.username; $('settings-address').textContent=location.origin;
        $('service-kind').textContent=config.publicOrigin?'云端服务':'本机服务';$('service-address').textContent=location.host;settingsLoaded=true;
        void startBackground(config,generation);
      }
    }catch{if(generation===version){delay=1500;connection(false);if(!user){$('login').hidden=false;$('login-error').textContent='暂时无法连接服务，正在自动检测恢复。';}}}
    finally{sessionTask=null;clearTimeout(sessionTimer);sessionTimer=setTimeout(()=>void refreshSession(),delay);}
  })();return sessionTask;
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button'),form=new FormData(event.currentTarget);button.disabled=true;
  try{if(needsSetup&&form.get('password')!==form.get('confirm'))throw Error('两次密码不一致');await api(needsSetup?'/api/auth/setup':'/api/auth/login',{username:form.get('username'),password:form.get('password')});$('login-form').reset();$('login-error').textContent='';await refreshSession();}catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}
});
for(const id of ['server-label','server-host'])$(id).addEventListener('input',()=>{dirty.add('server');$('save-state').textContent='未保存';$('settings-result').textContent='';});
$('server-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button'),input={label:$('server-label').value,publicHost:$('server-host').value},generation=version;button.disabled=true;
  try{const saved=await api('/api/platform/settings',{server:input});if(generation!==version||!user)return;if(input.label===$('server-label').value&&input.publicHost===$('server-host').value){dirty.delete('server');$('save-state').textContent='已保存';$('server-label').value=saved.server.label;$('server-host').value=saved.server.publicHost;}$('settings-result').textContent=dirty.has('server')?'已保存上次提交，当前修改尚未保存':'设置已保存。';}catch(error){$('settings-result').textContent=error.message;}finally{button.disabled=false;}
});
function settingsTab(name, focus=false) {
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    const active=tab.dataset.settingsTab===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
    $(tab.getAttribute('aria-controls')).hidden=!active;if(active&&focus)tab.focus();
  }
}
for (const tab of document.querySelectorAll('[data-settings-tab]')) {
  tab.addEventListener('click',()=>settingsTab(tab.dataset.settingsTab));
  tab.addEventListener('keydown',event=>{
    const names=['general','account','ai'],index=names.indexOf(tab.dataset.settingsTab);
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;settingsTab(names[next],true);}
  });
}
function aiKeyState() {
  const changed=$('ai-base-url').value.replace(/\/+$/,'')!==aiConfig?.baseUrl?.replace(/\/+$/,'');
  const retained=!!aiConfig?.hasApiKey&&!changed&&!$('ai-clear-key').checked;
  $('ai-key-state').dataset.configured=String(retained);
  $('ai-key-state').textContent=$('ai-api-key').value?'新密钥待保存':retained?'已配置 · 留空保持不变':$('ai-clear-key').checked?'保存后删除密钥':changed?'地址已更换，请填写对应密钥':'未配置';
  $('ai-api-key').placeholder=retained?'已安全保存，无需重复填写':'填写 API 密钥';
}
function renderSelectedModels() {
  $('ai-selected-models').replaceChildren(...selectedModels.map(model=>{
    const chip=textElement('span','model-chip',model),remove=textElement('button','','×');remove.type='button';remove.setAttribute('aria-label','移除模型 '+model);
    remove.addEventListener('click',()=>{selectedModels=selectedModels.filter(item=>item!==model);if($('ai-model').value===model)$('ai-model').value=selectedModels[0]||'';markAi();renderSelectedModels();});chip.append(remove);return chip;
  }));
}
function fillAi(value) {
  aiConfig=value;
  $('ai-provider').value=value.provider||'custom';$('ai-protocol').value=value.protocol||'chat';$('ai-base-url').value=value.baseUrl||'';
  $('ai-api-key').value='';$('ai-clear-key').checked=false;$('ai-model').value=value.model||'';
  selectedModels=[...new Set([...(value.selectedModels||[]),value.model].filter(Boolean))];
  $('ai-state').textContent=value.hasApiKey?'已配置':'未配置';$('ai-base-url').readOnly=value.provider!=='custom';aiKeyState();renderSelectedModels();
}
function markAi() { aiRevision++;dirty.add('ai');$('ai-state').textContent='未保存';$('ai-result').textContent='';aiKeyState(); }
function aiDraft() {
  return {provider:$('ai-provider').value,protocol:$('ai-protocol').value,baseUrl:$('ai-base-url').value,apiKey:$('ai-api-key').value,clearKey:$('ai-clear-key').checked,model:$('ai-model').value.trim(),selectedModels:[...new Set([...selectedModels,$('ai-model').value.trim()].filter(Boolean))]};
}
for(const id of aiFields)$(id).addEventListener('input',()=>{
  if(id==='ai-provider'){
    const bases={openai:'https://api.openai.com/v1',dashscope:'https://dashscope.aliyuncs.com/compatible-mode/v1'};
    $('ai-base-url').readOnly=$('ai-provider').value!=='custom';
    if(bases[$('ai-provider').value])$('ai-base-url').value=bases[$('ai-provider').value];
  }
  if(['ai-provider','ai-base-url'].includes(id)){availableModels=[];selectedModels=[];renderSelectedModels();}
  markAi();
});
$('ai-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]'),revision=aiRevision,generation=version;button.disabled=true;
  try{const value=await api('/api/platform/ai',aiDraft());if(generation!==version||!user)return;aiConfig=value;if(revision===aiRevision){dirty.delete('ai');fillAi(value);}$('ai-result').textContent=revision===aiRevision?'默认接口已保存，继承平台配置的模块会自动使用。':'已保存提交的配置，当前新修改尚未保存。';}
  catch(error){$('ai-result').textContent=error.message;}finally{button.disabled=false;}
});
function renderModelOptions() {
  const query=$('ai-model-search').value.trim().toLowerCase(),visible=availableModels.filter(model=>model.toLowerCase().includes(query));
  $('ai-model-count').textContent='已选 '+pendingSelection.size+' 个 / 共 '+availableModels.length+' 个模型';
  $('ai-model-options').replaceChildren(...visible.map(model=>{
    const row=document.createElement('label');row.className='model-option';const check=document.createElement('input');check.type='checkbox';check.checked=pendingSelection.has(model);check.value=model;
    check.addEventListener('change',()=>{check.checked?pendingSelection.add(model):pendingSelection.delete(model);$('ai-model-count').textContent='已选 '+pendingSelection.size+' 个 / 共 '+availableModels.length+' 个模型';});row.append(check,document.createTextNode(model));return row;
  }));
  if(!visible.length)$('ai-model-options').append(textElement('p','muted','没有匹配的模型。'));
}
$('ai-discover').addEventListener('click',async()=>{
  const generation=version,revision=aiRevision;$('ai-discover').disabled=true;$('ai-result').textContent='正在获取接口可用模型…';aiTask?.abort();const controller=new AbortController();aiTask=controller;
  try{const value=await api('/api/platform/ai/models',aiDraft(),AbortSignal.any([controller.signal,AbortSignal.timeout(25000)]));if(generation!==version||!user)return;if(revision!==aiRevision){$('ai-result').textContent='接口配置已变化，请重新获取模型。';return;}availableModels=value.models;pendingSelection=new Set([...selectedModels,$('ai-model').value.trim()].filter(Boolean));
    $('ai-model-suggestions').replaceChildren(...availableModels.map(model=>{const option=document.createElement('option');option.value=model;return option;}));
    $('ai-model-search').value='';renderModelOptions();$('ai-model-dialog').showModal();$('ai-result').textContent=availableModels.length?'获取成功，请勾选需要的模型。':'接口未返回模型，可手动填写模型名称。';}
  catch(error){if(generation===version)$('ai-result').textContent=error.message;}finally{if(aiTask===controller)aiTask=null;$('ai-discover').disabled=false;}
});
$('ai-model-search').addEventListener('input',renderModelOptions);
$('ai-model-select-all').addEventListener('click',()=>{const query=$('ai-model-search').value.trim().toLowerCase();for(const model of availableModels)if(model.toLowerCase().includes(query))pendingSelection.add(model);renderModelOptions();});
$('ai-model-apply').addEventListener('click',()=>{
  if(!pendingSelection.size){$('ai-model-count').textContent='请至少选择一个模型。';return;}selectedModels=[...pendingSelection];if(!pendingSelection.has($('ai-model').value))$('ai-model').value=selectedModels[0];markAi();renderSelectedModels();$('ai-model-dialog').close();$('ai-result').textContent='已选择 '+selectedModels.length+' 个模型，保存接口后即可在对话中切换。';
});
$('ai-test').addEventListener('click',async()=>{
  const button=$('ai-test'),generation=version;button.disabled=true;$('ai-result').textContent='正在测试…';
  try{const value=await api('/api/platform/ai/test',aiDraft(),AbortSignal.timeout(65000));if(generation===version&&user)$('ai-result').textContent='连接成功 · '+value.model;}
  catch(error){if(generation===version)$('ai-result').textContent=error.message;}finally{button.disabled=false;}
});
$('account-form').addEventListener('input',()=>{accountRevision++;dirty.add('account');$('account-state').textContent='未保存';$('account-result').textContent='';});
$('account-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]'),generation=version,revision=accountRevision;button.disabled=true;
  const input={username:$('account-username').value,currentPassword:$('account-current').value,...($('account-change-password').checked?{password:$('account-password').value}:{})};
  try{const saved=await api('/api/auth/account',input);if(generation!==version||!user)return;user=saved.user;$('user-label').textContent=user.username;if(revision===accountRevision){$('account-current').value='';$('account-password').value='';$('account-change-password').checked=false;dirty.delete('account');$('account-state').textContent='已保存';}$('account-result').textContent=revision===accountRevision?'账户已更新。其他观看设备需要重新登录。':'账户已更新，当前新修改尚未保存。';settingsLoaded=false;await refreshSession();}
  catch(error){$('account-result').textContent=error.message;}finally{button.disabled=false;}
});
$('service-host').textContent=location.host;$('today-label').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
window.addEventListener('hashchange',show);window.addEventListener('online',()=>void refreshSession());document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshSession();});window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});window.addEventListener('pagehide',()=>{clearTimeout(sessionTimer);aiTask?.abort();void stopBackground();});show();void refreshSession();
