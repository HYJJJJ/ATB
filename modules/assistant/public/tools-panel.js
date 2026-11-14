import {TOOL_CAPABILITIES,capabilityEnabled} from './tool-capabilities.js';
const ICONS={search:'M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',weather:'M8 16a5 5 0 1 1 10-2h1a3 3 0 0 1 0 6H8a4 4 0 0 1 0-8M8 2v2M2 8h2M3 3l2 2',news:'M5 3h14v18H5zM8 7h8M8 11h8M8 15h4',time:'M12 7v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',balance:'M3 6h18v14H3zM3 6V4h15M15 11h6v5h-6z',atb:'M3 4h18v13H3zM8 21h8M12 17v4',applications:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',desktop:'M3 4h18v13H3zM8 21h8M12 17v4M10 8l6 3-3 1-1 3z',browser:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',mcp:'M8 8l8 8M5 11l6-6M13 19l6-6M3 13l8-8M13 21l8-8'};
export function createToolsPanel({api,isLoggedIn,onDirty=()=>{}}){
  const $=id=>document.getElementById(id);let state={settings:{servers:[]},tools:[],servers:[]},version=0,busy=false,dirty=false;
  const node=(tag,text,className)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(className)el.className=className;return el;};
  const message=(text,error=false)=>{$('tools-result').textContent=text;$('tools-result').dataset.error=String(error);};
  const mark=value=>{dirty=value;onDirty(value);};
  function form(server={}){
    for(const key of ['id','label','command','url','cwd'])$('tool-'+key).value=server[key]||'';
    $('tool-transport').value=server.transport||'stdio';$('tool-enabled').checked=server.enabled!==false;
    for(const key of ['args','env','headers'])$('tool-'+key).value=JSON.stringify(server[key]||(key==='args'?[]:{}),null,2);
    toggle();mark(false);
  }
  function toggle(){const stdio=$('tool-transport').value==='stdio';$('tool-stdio').hidden=!stdio;$('tool-http').hidden=stdio;}
  const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),p=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');p.setAttribute('d',ICONS[name]||ICONS.mcp);svg.append(p);return svg;};
  async function edit(server){
    if(dirty&&!await window.atbConfirm({title:'有未保存的工具设置',message:'放弃当前修改并编辑此连接？',confirmLabel:'放弃并编辑',cancelLabel:'继续编辑'}))return;
    form(server);$('tools-advanced').open=true;$('tool-editor').open=true;$('tool-editor').scrollIntoView({block:'nearest'});$('tool-id').focus({preventScroll:true});
  }
  const saveSettings=patch=>transact({action:'save',settings:{...state.settings,...patch}});
  function render(){
    $('tools-engine').textContent='执行核心：'+(state.engine||'DeepSeek Harness');
    const enabled=$('tools-enabled'),disabled=$('tools-disabled');enabled.replaceChildren();disabled.replaceChildren();
    function card({id,name,description,example,kind,enabled:on,status='ready',count,edit:editAction,toggle:toggleAction,remove}){
      const el=node('article',null,'capability-card');el.dataset[kind==='builtin'?'capability':'server']=id;el.dataset.enabled=String(on);
      const top=node('div',null,'capability-top'),glyph=node('span',null,'capability-icon');glyph.append(icon(kind==='builtin'?id:id==='browser'?'browser':'mcp'));
      const title=node('div',null,'capability-title'),label=node('h3',name),badge=node('span',kind==='builtin'?'内置能力':'MCP','capability-kind');title.append(label,badge);top.append(glyph,title);
      const button=(text,action,handler,label)=>{const b=node('button',text,'quiet capability-'+action);b.type='button';b.dataset.action=action;b.disabled=busy;if(label){b.setAttribute('aria-label',label);b.title=label;}b.addEventListener('click',()=>void handler());return b;};
      if(on)top.append(button('×','disable',()=>toggleAction(false),'停用'+name));
      el.append(top,node('p',description,'capability-description'));
      if(example)el.append(node('p','“'+example+'”','capability-example'));
      const foot=node('div',null,'capability-footer'),statusLabel=node('span',!on?'未启用':status==='connected'?'已连接'+(count?' · '+count+' 项':''):status==='error'||status==='disconnected'?'连接失败':status==='connecting'?'连接中':'已就绪','tool-connection');statusLabel.dataset.state=on?status:'off';foot.append(statusLabel);
      if(!on)foot.append(button('启用','enable',()=>toggleAction(true),'启用'+name));
      if(editAction)foot.append(button('设置','edit',editAction,'设置'+name));
      el.append(foot);
      if(remove){const more=node('details',null,'capability-more'),summary=node('summary','更多');more.append(summary,button('删除连接','delete',remove));el.append(more);}
      (on?enabled:disabled).append(el);
    }
    for(const group of TOOL_CAPABILITIES)card({...group,kind:'builtin',enabled:capabilityEnabled(state.settings,group),toggle:value=>saveSettings({capabilities:{...state.settings.capabilities,[group.id]:value}})});
    const servers=state.settings.servers||[];
    if(!servers.some(s=>s.id==='browser'))card({id:'browser',name:'网页浏览器',description:'浏览动态网页，读取页面内容和标签页',example:'用浏览器查看这个网页',enabled:false,toggle:()=>transact({action:'browser'})});
    for(const server of servers){
      const status=state.servers.find(item=>item.id===server.id);
      card({id:server.id,name:server.id==='browser'?'网页浏览器':server.label,description:server.id==='browser'?'使用独立浏览器查看网页，不读取你的日常登录信息':status?.error||'自定义能力 · '+(server.transport==='stdio'?'本地连接':'网络连接'),enabled:server.enabled,status:status?.state||'error',count:status?.tools?.length,
        toggle:value=>saveSettings({servers:servers.map(s=>s.id===server.id?{...s,enabled:value}:s)}),edit:()=>edit(server),remove:async()=>{if(await window.atbConfirm({title:'删除能力连接',message:'删除“'+server.label+'”的连接配置？停用可以保留配置。',confirmLabel:'删除',cancelLabel:'保留'}))await saveSettings({servers:servers.filter(s=>s.id!==server.id)});}});
    }
    if(!enabled.children.length)enabled.append(node('p','还没有启用的能力，从下方选择一个吧','field-help'));
    $('tools-count').textContent=enabled.querySelectorAll('.capability-card').length;
    $('tools-disabled-count').textContent=disabled.querySelectorAll('.capability-card').length;
    const catalog=$('tools-catalog');catalog.replaceChildren();
    for(const tool of state.tools){const detail=node('details',null,'tool-definition');detail.append(node('summary',tool.name),node('p',tool.description));catalog.append(detail);}
  }
  async function transact(body,{submitted=false}={}){
    if(busy||!isLoggedIn())return;busy=true;const epoch=++version;$('tools-save').disabled=true;render();message('正在应用能力设置…');
    if(submitted)$('tool-form').inert=true;
    try{
      const next=await api('/api/assistant/tools',body);if(epoch!==version||!isLoggedIn())return;state=next;
      if(submitted){const saved=state.settings.servers.find(s=>s.id===$('tool-id').value.trim());if(saved)form(saved);else mark(false);}
      const failed=next.servers?.some(item=>item.state==='error');message(failed?'设置已保存，部分能力连接失败，可在卡片中调整。':'能力设置已生效。',failed);
    }catch(error){if(epoch===version)message(error.message,true);}
    finally{if(epoch===version){busy=false;$('tools-save').disabled=false;$('tool-form').inert=false;render();}}
  }
  $('tool-form').addEventListener('input',()=>mark(true));$('tool-form').addEventListener('change',()=>mark(true));$('tool-transport').addEventListener('change',toggle);
  $('tool-form').addEventListener('submit',event=>{event.preventDefault();try{
    const transport=$('tool-transport').value,server={id:$('tool-id').value.trim(),label:$('tool-label').value.trim(),enabled:$('tool-enabled').checked,transport};
    if(transport==='stdio')Object.assign(server,{command:$('tool-command').value.trim(),args:JSON.parse($('tool-args').value),env:JSON.parse($('tool-env').value),...($('tool-cwd').value.trim()?{cwd:$('tool-cwd').value.trim()}:{})});
    else Object.assign(server,{url:$('tool-url').value.trim(),headers:JSON.parse($('tool-headers').value)});
    const old=state.settings.servers.find(item=>item.id===server.id);if(old?.allowedTools)server.allowedTools=old.allowedTools;
    const servers=old?state.settings.servers.map(item=>item.id===server.id?server:item):[...state.settings.servers,server];void transact({action:'save',settings:{...state.settings,servers}},{submitted:true});
  }catch{message('参数、环境变量及请求头必须是有效 JSON。',true);}});
  $('tools-refresh').addEventListener('click',()=>void transact({action:'probe'}));
  $('tools-browser').addEventListener('click',()=>void transact({action:'browser'}));
  $('tools-new').addEventListener('click',()=>void edit());
  form();
  return {get dirty(){return dirty;},async start(){if(!isLoggedIn()||busy)return;const epoch=++version;message('正在读取能力…');try{const next=await api('/api/assistant/tools');if(epoch!==version||!isLoggedIn())return;state=next;render();message('已启用的能力可在语音对话中直接使用。');}catch(error){if(epoch===version)message(error.message,true);}},stop(){version++;busy=false;$('tool-form').inert=false;$('tools-save').disabled=false;state={settings:{servers:[]},tools:[],servers:[]};form();render();$('tools-advanced').open=false;$('tool-editor').open=false;message('');}};
}
