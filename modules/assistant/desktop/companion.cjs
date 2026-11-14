const path = require('node:path');
const { loadCompanionSettings } = require('./companion-settings.cjs');
function createCompanionDesktop({ dataRoot, services, registerBackground, voice, suspend, isBusy = () => false, toggleForeground = () => false, navigate = () => {}, quit = () => {}, electron = require('electron') }) {
  const { BrowserWindow, ipcMain, screen, shell } = electron;
  const storeTask = loadCompanionSettings(path.join(dataRoot, 'data', 'platform', 'desktop-companion.json'));
  // Keep failures observable to callers without an unhandled startup rejection.
  void storeTask.catch(() => {});
  let window, closed = false, dragging, expanded = false, anchor, layout, replyHeight = 0, positionRevision = 0;
  const url = () => `${services().local.origin}/modules/assistant/companion.html`;
  function emit(value) { if (window && !window.isDestroyed()) window.webContents.send('atb:companion-event', value); }
  const displayBounds = display => display.bounds || display.workArea;
  function anchorDisplay() {
    return screen.getDisplayNearestPoint?.(anchor) || screen.getDisplayMatching({ ...anchor, width:1, height:1 });
  }
  function recoverAnchor() {
    const displays = screen.getAllDisplays?.() || [screen.getPrimaryDisplay()];
    if (displays.some(display => { const area=displayBounds(display);return anchor.x>=area.x&&anchor.x<area.x+area.width&&anchor.y>=area.y&&anchor.y<area.y+area.height; })) return;
    const area=displayBounds(anchorDisplay()),marginX=Math.min(80,Math.floor(area.width/2)),marginY=Math.min(95,Math.floor(area.height/2));
    anchor={x:Math.round(Math.max(area.x+marginX,Math.min(area.x+area.width-marginX,anchor.x))),y:Math.round(Math.max(area.y+marginY,Math.min(area.y+area.height-marginY,anchor.y)))};
  }
  function canvasBounds() {
    const area=displayBounds(anchorDisplay()),width=Math.min(expanded?840:560,area.width),height=Math.min(expanded?660:520,area.height);
    const x=Math.round(Math.max(area.x,Math.min(area.x+area.width-width,anchor.x-width/2))),y=Math.round(Math.max(area.y,Math.min(area.y+area.height-height,anchor.y-height/2-25)));
    const above=anchor.y-y-95-16,below=y+height-anchor.y-95-16;
    if(!expanded&&replyHeight>0&&replyHeight>Math.max(above,below)){
      // The invisible canvas must grow too, otherwise a content-sized bubble is
      // still clipped by its native window. Keep the character's screen anchor.
      layout={x:anchor.x-area.x,y:anchor.y-area.y,width:area.width,height:area.height,positionRevision};return {...area};
    }
    layout={x:anchor.x-x,y:anchor.y-y,width,height,positionRevision};return {x,y,width,height};
  }
  function relayout() {
    if (!window || window.isDestroyed()) return;
    window.setBounds(canvasBounds());layout.positionRevision=positionRevision;emit({type:'layout',layout:{...layout}});
  }
  function moveAnchor() {
    if (!dragging) return;
    const point=screen.getCursorScreenPoint(),next={x:dragging.anchor.x+point.x-dragging.point.x,y:dragging.anchor.y+point.y-dragging.point.y};if(next.x!==anchor.x||next.y!==anchor.y)positionRevision++;anchor=next;relayout();
  }
  function displayChanged() { if(anchor&&!closed&&!dragging){recoverAnchor();positionRevision++;relayout();} }
  for(const event of ['display-added','display-removed','display-metrics-changed'])screen?.on?.(event,displayChanged);
  async function sync() {
    const settings = (await storeTask).get(); if (closed || !services().local) return settings;
    if (!window || window.isDestroyed()) {
      if (!settings.enabled) return settings;
      const area = displayBounds(screen.getPrimaryDisplay());
      anchor=settings.anchor || {x:area.x+area.width-292,y:area.y+area.height-247};recoverAnchor();
      const size = canvasBounds();
      window = new BrowserWindow({ ...size, show:false, frame:false, transparent:true, backgroundColor:'#00000000', alwaysOnTop:true, skipTaskbar:true, resizable:false, maximizable:false, fullscreenable:false, title:'ATB · 小鲸鱼', webPreferences:{preload:path.join(__dirname,'companion-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'} });
      window.setAlwaysOnTop(true,'floating'); window.setVisibleOnAllWorkspaces?.(true,{visibleOnFullScreen:true});
      window.setIgnoreMouseEvents(true,{forward:true});
      const owner = window.webContents.id, unregister = registerBackground?.(window.webContents);
      window.once('closed',()=>{unregister?.();void suspend?.(owner);});
      window.on('blur',()=>emit({type:'dismiss-menu'}));
      window.on('close',event=>{if(!closed){event.preventDefault();void update({enabled:false});}});
      window.once('ready-to-show',()=>{if(!closed && window && !window.isDestroyed())void storeTask.then(store=>{if(store.get().enabled)window?.showInactive();});});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      window.webContents.on('will-navigate',(event,target)=>{if(target!==url())event.preventDefault();});
      window.webContents.on('render-process-gone',()=>{void suspend?.(owner);});
      await window.loadURL(url());
    } else if (settings.enabled) window.showInactive();
    else { emit({type:'stop'}); window.hide(); await suspend?.(window.webContents.id); }
    emit({type:'settings',settings});emit({type:'layout',layout:{...layout}});return settings;
  }
  async function update(patch) { const settings = await (await storeTask).update(patch); await sync(); return settings; }
  async function toggleVoice() { if (await toggleForeground(window?.webContents.id)) return { forwarded:true }; if(isBusy(window?.webContents.id)) throw Error('主界面正在处理消息，请稍后再试'); return { forwarded:false }; }
  ipcMain.handle('atb:companion',async(event,{action,options={}}={})=>{
    if(closed || !window || window.isDestroyed() || event.sender!==window.webContents || event.senderFrame!==event.sender.mainFrame || event.sender.getURL()!==url())throw Error('桌面助手请求来源无效');
    if(action==='settings')return (await storeTask).get();
    if(action==='layout')return {...layout};
    if(action==='replySize'){
      if(!Number.isFinite(options.height)||options.height<0||options.height>1000000)throw Error('回复尺寸无效');
      if(replyHeight!==options.height){replyHeight=options.height;relayout();}return {...layout};
    }
    if(action==='update') { const allowed=['showText','enabled','nextReminderAt'];if(Object.keys(options).some(key=>!allowed.includes(key)))throw Error('桌面设置无效'); return update(options); }
    if(action==='voice'){if(options.action==='prepare'&&(!(await storeTask).get().enabled||isBusy(window.webContents.id)))return {prepared:false,reason:'unavailable'};if(['open','wakeOpen'].includes(options.action)&&(!(await storeTask).get().enabled||isBusy(window.webContents.id)))throw Error('桌面助手已隐藏或另一个入口正在使用语音');return voice(window.webContents.id,options);}
    if(action==='toggleVoice')return toggleVoice();
    if(action==='release'){await suspend?.(window.webContents.id);return {ok:true};}
    if(action==='open'){if(!['main','assistant','voice','faces','platform','persona','model'].includes(options.page))throw Error('快捷入口无效');await navigate(options.page);return {ok:true};}
    if(action==='quit'){quit();return {ok:true};}
    if(action==='hit'){window.setIgnoreMouseEvents(options.active!==true,{forward:true});return;}
    if(action==='dragStart'){dragging={point:screen.getCursorScreenPoint(),anchor:{...anchor}};return;}
    if(action==='drag'){moveAnchor();return;}
    if(action==='dragEnd'){if(dragging){moveAnchor();dragging=null;await(await storeTask).update({anchor:{...anchor}});}return;}
    if(action==='expand'){
      if(options.active===true && !expanded){expanded=true;relayout();window.setIgnoreMouseEvents(false);}
      else if(options.active!==true&&expanded){expanded=false;relayout();}return;
    }
    if(action==='external'){const target=new URL(options.url);if(target.protocol!=='https:'||target.username||target.password||target.port&&target.port!=='443'||!['www.chinanews.com.cn','www.chinanews.com','open-meteo.com','wttr.in'].includes(target.hostname))throw Error('链接来源无效');await shell.openExternal(target.href);return;}
    throw Error('桌面助手操作无效');
  });
  return {
    owns(owner){return Boolean(window&&!window.isDestroyed()&&window.webContents.id===owner);},
    event(value){emit(value);},
    async invoke(_owner,{action,settings,event}={}){
      if(closed)throw Error('桌面助手已关闭');
      if(action==='start')return sync();
      if(action==='settings')return settings?update(settings):(await storeTask).get();
      if(action==='toggle')return update({enabled:!(await storeTask).get().enabled});
      if(action==='event'){if(event&&['state','delta','reply','level','reset','proactive'].includes(event.type)){const safe={type:event.type,source:_owner,account:typeof event.account==='string'?event.account.slice(0,80):'',text:typeof event.text==='string'?event.text.slice(0,16000):'',phase:typeof event.phase==='string'?event.phase.slice(0,32):'',active:event.active===true,level:Number.isFinite(event.level)?Math.max(0,Math.min(1,event.level)):0};emit(safe);}return {ok:true};}
      throw Error('桌面助手操作无效');
    },
    async close(){closed=true;for(const event of ['display-added','display-removed','display-metrics-changed'])screen?.removeListener?.(event,displayChanged);try{if(window&&!window.isDestroyed()){const owner=window.webContents.id;window.destroy();await suspend?.(owner);}}finally{ipcMain.removeHandler('atb:companion');await(await storeTask).flush();}},
  };
}
module.exports={createCompanionDesktop};
