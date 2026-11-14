import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import vm from 'node:vm';
const require=createRequire(import.meta.url);

async function layoutFixture(t, preferences = { anchor:{x:400,y:400} }, displays = [
 {id:1,bounds:{x:0,y:0,width:1280,height:900},workArea:{x:0,y:0,width:1280,height:860}},
 {id:2,bounds:{x:-1280,y:-200,width:1280,height:900},workArea:{x:-1280,y:-200,width:1280,height:860}},
]) {
 const directory=await mkdtemp(path.join(tmpdir(),'atb-companion-layout-'));
 const file=path.join(directory,'data/platform/desktop-companion.json');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(preferences));
 const handlers=new Map(),windows=[],events=[];let cursor={x:400,y:400};
 class Window extends EventEmitter {
  constructor(options){super();this.bounds={x:options.x,y:options.y,width:options.width,height:options.height};this.webContents=new EventEmitter();Object.assign(this.webContents,{id:90,mainFrame:{},getURL:()=>this.url,send:(channel,event)=>events.push(event),setWindowOpenHandler(){}});windows.push(this);}
  loadURL(url){this.url=url;return Promise.resolve();}isDestroyed(){return this.destroyed;}setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}setIgnoreMouseEvents(){}showInactive(){}hide(){}setBounds(bounds){this.bounds={...bounds};}getBounds(){return {...this.bounds};}destroy(){this.destroyed=true;this.emit('closed');}
 }
 const screen=new EventEmitter();Object.assign(screen,{getPrimaryDisplay:()=>displays[0],getAllDisplays:()=>displays,getCursorScreenPoint:()=>({...cursor}),getDisplayNearestPoint(point){return displays.find(display=>point.x>=display.bounds.x&&point.x<display.bounds.x+display.bounds.width&&point.y>=display.bounds.y&&point.y<display.bounds.y+display.bounds.height)||displays[0];},getDisplayMatching:()=>displays[0]});
 const widget=require('../desktop/companion.cjs').createCompanionDesktop({dataRoot:directory,services:()=>({local:{origin:'https://localhost:8443'}}),electron:{BrowserWindow:Window,screen,ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)}},suspend:async()=>{}});
 t.after(async()=>{await widget.close();await rm(directory,{recursive:true,force:true});});await widget.invoke(1,{action:'start'});
 const win=windows[0],event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
 return {win,widget,events,screen,file,cursor(point){cursor=point;},call:(action,options={})=>handlers.get('atb:companion')(event,{action,options})};
}

test('native window blur dismisses the widget menu',async t=>{
 const fixture=await layoutFixture(t);fixture.win.emit('blur');assert.deepEqual(fixture.events.at(-1),{type:'dismiss-menu'});
});

test('reply canvas exposes screen space for growing text and collapses without moving the character',async t=>{
 const fixture=await layoutFixture(t,{anchor:{x:1100,y:780}}),normal=fixture.win.getBounds(),original=await readFile(fixture.file,'utf8');
 const revision=(await fixture.call('layout')).positionRevision;
 for(const height of [350,600,1800]){
  await fixture.call('replySize',{height});
  const bounds=fixture.win.getBounds(),layout=await fixture.call('layout');
  assert.equal(layout.positionRevision,revision,'canvas growth is not a character move');
  assert.deepEqual({x:bounds.x+layout.x,y:bounds.y+layout.y},{x:1100,y:780});
  assert.ok(bounds.height>520,'the transparent canvas must not clip a reply at its old height');
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1280&&bounds.y+bounds.height<=900);
 }
 await fixture.call('expand',{active:true});await fixture.call('expand',{active:false});
 assert.ok(fixture.win.getBounds().height>520,'closing an image restores room for the reply');
 await fixture.call('replySize',{height:0});assert.deepEqual(fixture.win.getBounds(),normal);
 assert.equal(await readFile(fixture.file,'utf8'),original,'text growth must not rewrite the saved character position');
 await assert.rejects(fixture.call('replySize',{height:NaN}),/尺寸/);
 await assert.rejects(fixture.call('replySize',{height:-1}),/尺寸/);
});

test('legacy window position migrates to a character anchor without rewriting the preferences',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'atb-companion-migrate-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'widget.json');const original=JSON.stringify({position:{x:-520,y:-100},news:false});await writeFile(file,original);
 const store=await require('../desktop/companion-settings.cjs').loadCompanionSettings(file);assert.deepEqual(store.get().anchor,{x:-240,y:185});assert.equal(await readFile(file,'utf8'),original);
 await store.update({anchor:{x:-1250.4,y:-170.4}});assert.deepEqual((await require('../desktop/companion-settings.cjs').loadCompanionSettings(file)).get().anchor,{x:-1250,y:-170});
 await assert.rejects(store.update({anchor:{x:Infinity,y:0}}),/位置/);await assert.rejects(store.update({anchor:{x:0,y:NaN}}),/位置/);
});

test('screen cursor dragging keeps the character at a negative monitor corner without release snapback or per-move writes',async t=>{
 const fixture=await layoutFixture(t);const before=await readFile(fixture.file,'utf8');
 await fixture.call('dragStart',{x:99999,y:99999});fixture.cursor({x:-1250,y:-170});await fixture.call('drag',{x:0,y:0});
 assert.equal(await readFile(fixture.file,'utf8'),before,'movement stays in memory until release');
 const bounds=fixture.win.getBounds();assert.deepEqual(bounds,{x:-1280,y:-200,width:560,height:520});
 assert.deepEqual(await fixture.call('layout'),{x:30,y:30,width:560,height:520,positionRevision:1});
 await fixture.call('dragEnd');assert.deepEqual(fixture.win.getBounds(),bounds);assert.deepEqual(JSON.parse(await readFile(fixture.file,'utf8')).anchor,{x:-1250,y:-170});
 assert.deepEqual(fixture.events.filter(event=>event.type==='layout').at(-1),{type:'layout',layout:{x:30,y:30,width:560,height:520,positionRevision:1}});
});

test('all screen corners keep their anchor and image expansion restores canvas without moving the character',async t=>{
 const fixture=await layoutFixture(t);for(const anchor of [{x:10,y:10},{x:1270,y:10},{x:10,y:890},{x:1270,y:890}]){
  const current=await fixture.call('layout'),bounds=fixture.win.getBounds();fixture.cursor({x:bounds.x+current.x,y:bounds.y+current.y});await fixture.call('dragStart');fixture.cursor(anchor);await fixture.call('dragEnd');
  let layout=await fixture.call('layout'),normal=fixture.win.getBounds();assert.deepEqual({x:normal.x+layout.x,y:normal.y+layout.y},anchor);assert.ok(normal.x>=0&&normal.y>=0&&normal.x+normal.width<=1280&&normal.y+normal.height<=900);
  await fixture.call('expand',{active:true});layout=await fixture.call('layout');let expanded=fixture.win.getBounds();assert.deepEqual({x:expanded.x+layout.x,y:expanded.y+layout.y},anchor);assert.equal(expanded.width,840);assert.equal(expanded.height,660);
  await fixture.call('expand',{active:false});assert.deepEqual(fixture.win.getBounds(),normal);layout=await fixture.call('layout');assert.deepEqual({x:normal.x+layout.x,y:normal.y+layout.y},anchor);
 }
});

test('small displays use their complete bounds and startup recovers an anchor from a disconnected monitor',async t=>{
 const fixture=await layoutFixture(t,{anchor:{x:4000,y:2000}},[{id:1,bounds:{x:-400,y:-300,width:400,height:300},workArea:{x:-400,y:-300,width:400,height:250}}]);
 const layout=await fixture.call('layout'),bounds=fixture.win.getBounds();assert.deepEqual(bounds,{x:-400,y:-300,width:400,height:300});assert.ok(layout.x>=0&&layout.y>=0&&layout.x<400&&layout.y<300);
 const anchor={x:bounds.x+layout.x,y:bounds.y+layout.y};await fixture.call('expand',{active:true});await fixture.call('expand',{active:false});const restored=await fixture.call('layout');assert.deepEqual({x:bounds.x+restored.x,y:bounds.y+restored.y},anchor);
});

test('normal dragging does not impose a character boundary when the pointer crosses a screen edge',async t=>{
 const fixture=await layoutFixture(t);await fixture.call('dragStart');fixture.cursor({x:1350,y:950});await fixture.call('drag');const during=fixture.win.getBounds();await fixture.call('dragEnd');
 const layout=await fixture.call('layout');assert.deepEqual({x:during.x+layout.x,y:during.y+layout.y},{x:1350,y:950});assert.deepEqual(fixture.win.getBounds(),during);assert.deepEqual(JSON.parse(await readFile(fixture.file,'utf8')).anchor,{x:1350,y:950});
});
test('companion is always-on-top, owns only its main-frame IPC and hides via persistent settings',async t=>{
 const {createCompanionDesktop}=require('../desktop/companion.cjs');const dir=await mkdtemp(path.join(tmpdir(),'atb-companion-native-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handlers=new Map(),windows=[];class Window extends EventEmitter{constructor(options){super();this.options=options;this.bounds={x:0,y:0,width:options.width,height:options.height};this.webContents=new EventEmitter();Object.assign(this.webContents,{id:88,mainFrame:{},getURL:()=>this.url,send(){},isDestroyed:()=>false,setWindowOpenHandler(){}});windows.push(this)}loadURL(url){this.url=url;return Promise.resolve()}isDestroyed(){return this.destroyed}setAlwaysOnTop(v){this.top=v}setVisibleOnAllWorkspaces(){}setIgnoreMouseEvents(){}setBounds(b){this.bounds={...this.bounds,...b}}getBounds(){return this.bounds}showInactive(){this.visible=true}hide(){this.visible=false}destroy(){this.destroyed=true;this.emit('closed')}}
 const electron={BrowserWindow:Window,ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1280,height:900}}),getDisplayMatching:()=>({workArea:{x:0,y:0,width:1280,height:900}}),getCursorScreenPoint:()=>({x:400,y:400})},shell:{openExternal:async()=>{}},Menu:{buildFromTemplate:()=>({popup(){}})}};
 const suspended=[];const widget=createCompanionDesktop({dataRoot:dir,services:()=>({local:{origin:'https://localhost:8443'}}),electron,voice:async()=>({}),suspend:async owner=>suspended.push(owner),isBusy:()=>false,registerBackground:()=>()=>{}});
 await widget.invoke(1,{action:'start'});const win=windows[0];assert.equal(win.options.alwaysOnTop,true);assert.equal(win.options.transparent,true);assert.equal(win.options.skipTaskbar,true);win.emit('ready-to-show');await new Promise(resolve=>setImmediate(resolve));assert.equal(win.visible,true);
 const call=handlers.get('atb:companion'),event={sender:win.webContents,senderFrame:win.webContents.mainFrame};assert.equal((await call(event,{action:'settings'})).enabled,true);
 await assert.rejects(call({...event,senderFrame:{}},{action:'settings'}),/来源/);await assert.rejects(call({...event,sender:{}},{action:'settings'}),/来源/);await assert.rejects(call({...event,senderFrame:{}},{action:'layout'}),/来源/);
 await call(event,{action:'release'});assert.deepEqual(suspended,[88]);await assert.rejects(call({...event,senderFrame:{}},{action:'release'}),/来源/);
 await widget.invoke(1,{action:'settings',settings:{enabled:false}});assert.equal(win.visible,false);await widget.close();assert.equal(handlers.has('atb:companion'),false);
});

test('corrupt companion preferences preserve the file and still remove IPC on close',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'atb-companion-corrupt-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'data/platform/desktop-companion.json');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'{broken');const handlers=new Map();const {createCompanionDesktop}=require('../desktop/companion.cjs');const widget=createCompanionDesktop({dataRoot:dir,services:()=>({}),electron:{ipcMain:{handle:(key,value)=>handlers.set(key,value),removeHandler:key=>handlers.delete(key)}}});await assert.rejects(widget.invoke(1,{action:'settings'}));await assert.rejects(widget.close());assert.equal(handlers.size,0);assert.equal(await readFile(file,'utf8'),'{broken');
});

test('companion cleanup failure cannot skip background cleanup',async()=>{
 const events=[],commonjs={exports:{}};
 const source=await readFile(new URL('../desktop/index.cjs',import.meta.url),'utf8');vm.runInNewContext(source,{module:commonjs,require:name=>name==='node:path'?require(name):name==='./companion.cjs'?{createCompanionDesktop:()=>({invoke:async()=>{},close:async()=>{events.push('companion');throw Error('corrupt preferences')}})}:{createPresenceDesktop:()=>({invoke:async()=>{},close:()=>events.push('presence')})}});
 const module=commonjs.exports.createDesktopModule({dataRoot:'fixture',services:()=>({})});await module.handlers.companion(1,{action:'settings'});await module.handlers.presence(1,{action:'status'});await assert.rejects(module.close(),/corrupt/);assert.deepEqual(events,['companion','presence']);
});
