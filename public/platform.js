const $ = id => document.getElementById(id);
let user, needsSetup = false, sessionTask, sessionTimer, noticeTimer, version = 0, dirty = false, installed = [], settingsLoaded = false;
let background = [];
const labels = { overview: '工作台', settings: '共享设置', modules: '模块管理' };
async function api(url, data, signal = AbortSignal.timeout(8000)) {
  const response = await fetch(url, { signal, ...(data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }) });
  let value; try { value = await response.json(); } catch { throw Error('服务返回异常，请稍后再试'); }
  if (response.status === 401 && !url.startsWith('/api/auth/')) signedOut('登录已过期，请重新登录');
  if (!response.ok) throw Error(value.error || '请求失败'); return value;
}
function notice(message) { $('notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').textContent = '', 5000); }
function show() {
  const page = labels[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('.page').forEach(element => element.hidden = element.id !== `page-${page}`);
  document.querySelectorAll('[data-page]').forEach(element => { element.classList.toggle('active', element.dataset.page === page); if (element.dataset.page === page) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
  $('page-label').textContent = labels[page];
}
function connection(online) { $('service-status').textContent = online ? '平台服务已连接' : '连接中断 · 重试中'; $('network-banner').hidden = online; document.documentElement.dataset.online = String(online); }
function textElement(tag, className, value) { const element = document.createElement(tag); if (className) element.className = className; element.textContent = value; return element; }
function renderModules(modules, errors) {
  installed = modules; $('module-count').textContent = String(modules.length); $('empty-modules').hidden = modules.length > 0;
  $('module-nav').replaceChildren(...modules.map(module => { const link = document.createElement('a'); link.className='nav'; link.href=module.entry; link.append(textElement('span','',module.name.slice(0,1)),document.createTextNode(module.name)); return link; }));
  $('module-cards').replaceChildren(...modules.map(module => {
    const card = document.createElement('a'); card.className='card module-card'; card.href=module.entry;
    const top = document.createElement('div'); top.className='module-top'; top.append(textElement('span','module-icon',module.name.slice(0,1)),textElement('span','badge','已安装'));
    const foot = textElement('span','module-link','进入模块'); foot.append(textElement('span','','↗'));
    card.append(top,textElement('h2','',module.name),textElement('p','',module.description),foot); return card;
  }));
  $('module-list').replaceChildren(...modules.map(module => {
    const row=document.createElement('div'); row.className='module-row'; const detail=document.createElement('div');detail.className='detail'; detail.append(textElement('strong','',module.name),textElement('p','',module.description),textElement('small','',`${module.id} · v${module.version}`));
    const link=textElement('a','secondary','打开模块 ↗');link.href=module.entry;row.append(textElement('span','module-icon',module.name.slice(0,1)),detail,link);return row;
  }));
  if (!modules.length) $('module-list').append(textElement('p','muted','还没有安装模块。'));
  $('module-errors').hidden = !errors.length; $('module-errors').textContent=errors.map(item=>`${item.id}：${item.error}`).join('；');
}
async function stopBackground() { const old=background; background=[]; await Promise.allSettled(old.map(item=>item.close?.())); }
async function startBackground(config, generation) {
  await stopBackground();
  for (const module of config.modules || []) if (module.background) {
    try { const provider = await import(module.background); if (generation !== version || !user) return; const handle = await provider.activate?.({config,api}); if (generation !== version || !user) await handle?.close?.(); else if(handle) background.push(handle); } catch {}
  }
}
function signedOut(message='') {
  version++; user=null; settingsLoaded=false; void stopBackground();
  $('login').hidden=false; $('workspace').hidden=true; $('logout').hidden=true; $('user-label').textContent='访客'; $('login-error').textContent=message;
  $('server-label').value=''; $('server-host').value=''; dirty=false;
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
      const changed=!user||user.username!==session.user.username; user=session.user; $('login').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;$('user-label').textContent=user.username;
      if(changed||!settingsLoaded){
        const [catalog,settings,config]=await Promise.all([api('/api/platform/modules'),api('/api/platform/settings'),api('/api/config')]);
        if(generation!==version||!user)return;
        renderModules(catalog.modules,catalog.errors); if(!dirty){$('server-label').value=settings.server.label;$('server-host').value=settings.server.publicHost;}
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
$('logout').addEventListener('click',async()=>{try{await api('/api/auth/logout',{});await stopBackground();signedOut();await refreshSession();}catch(error){notice(error.message);}});
for(const id of ['server-label','server-host'])$(id).addEventListener('input',()=>{dirty=true;$('save-state').textContent='未保存';$('settings-result').textContent='';});
$('server-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button'),input={label:$('server-label').value,publicHost:$('server-host').value},generation=version;button.disabled=true;
  try{const saved=await api('/api/platform/settings',{server:input});if(generation!==version||!user)return;if(input.label===$('server-label').value&&input.publicHost===$('server-host').value){dirty=false;$('save-state').textContent='已保存';$('server-label').value=saved.server.label;$('server-host').value=saved.server.publicHost;}$('settings-result').textContent=dirty?'已保存上次提交，当前修改尚未保存':'共享设置已保存，模块下次请求时自动使用。';}catch(error){$('settings-result').textContent=error.message;}finally{button.disabled=false;}
});
if(window.atbDesktop){document.documentElement.classList.add('desktop');$('connection').hidden=false;$('connection').addEventListener('click',()=>window.atbDesktop.openConnectionSettings().catch(error=>notice(error.message)));}
$('service-host').textContent=location.host;$('today-label').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
window.addEventListener('hashchange',show);window.addEventListener('online',()=>void refreshSession());document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshSession();});window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});window.addEventListener('pagehide',()=>{clearTimeout(sessionTimer);void stopBackground();});show();void refreshSession();
