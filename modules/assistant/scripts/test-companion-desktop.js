import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import net from 'node:net';
import {_electron as electron} from 'playwright';
import {startServers} from '../../../server/index.js';import {SESSION_COOKIE} from '../../../server/accounts.js';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../../..'),directory=await mkdtemp(path.join(tmpdir(),'atb-whale-')),output=path.join(root,'test-results/companion');await mkdir(output,{recursive:true});
const historyOnly=process.argv.includes('--history');
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
const service=await startServers({lanIp:'127.0.0.1',httpsPort:await port(),httpPort:await port(),relayPort:0,publicOrigin:null,certDir:path.join(directory,'certs'),dataDir:path.join(directory,'data')});const origin='https://127.0.0.1:'+service.secure.address().port;
// Electron's trusted-origin proxy uses session.fetch, which bypasses renderer
// routes. Serve these two fixed fixtures from this isolated HTTPS service.
let historyFixture=false;
const requestHandlers=service.secure.listeners('request');service.secure.removeAllListeners('request');
service.secure.on('request',(req,res)=>{
 const pathname=new URL(req.url,origin).pathname;
 if(historyFixture&&pathname==='/modules/assistant/companion.js'){
  void readFile(path.join(root,'modules/assistant/public/companion.js'),'utf8').then(body=>{res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(body+'\nwindow.testSend=sendMessage;window.testReady=()=>Boolean(account&&!pollBusy);');}).catch(()=>res.writeHead(500).end());return;
 }
 if(historyFixture&&pathname==='/api/assistant/chat'){
  res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'隔离测试：模型工具调用达到限制'}));return;
 }
 for(const handler of requestHandlers)handler.call(service.secure,req,res);
});
let app;const errors=[],checks=[];
try{
 await service.accounts.setup('whale-fixture','fixture-password-only');const session=await service.accounts.login('whale-fixture','fixture-password-only');
 const env={...process.env,ATB_DATA_DIR:directory,LAN_IP:'127.0.0.1',HTTPS_PORT:String(service.secure.address().port),HTTP_PORT:String(service.plain.address().port),TURN_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
 console.log('launching isolated desktop');app=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:20000});app.process().stderr?.on('data',bytes=>errors.push(bytes.toString()));
 const main=await app.firstWindow();main.setDefaultTimeout(15000);console.log('first window',main.url());await main.waitForURL('**/platform',{timeout:20000});console.log('platform loaded');
 await main.context().addCookies([{name:SESSION_COOKIE,value:session.token,domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);await main.reload();await main.locator('#workspace').waitFor();
 console.log('authenticated');let widget;for(let attempt=0;attempt<60;attempt++){widget=app.windows().find(page=>page.url().endsWith('/companion.html'));if(widget)break;await main.waitForTimeout(100);}assert.ok(widget,'independent widget created');widget.setDefaultTimeout(15000);widget.on('pageerror',e=>errors.push(e.message));await widget.waitForFunction(()=>document.documentElement.dataset.account==='whale-fixture');console.log('widget authenticated');
 const native=await app.evaluate(async({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼');for(let i=0;i<60&&!win.isVisible();i++)await new Promise(r=>setTimeout(r,100));return{top:win.isAlwaysOnTop(),visible:win.isVisible(),bounds:win.getBounds()};});console.log('native window',native);if(!historyOnly)assert.equal(native.top,true);assert.equal(native.visible,true);checks.push(historyOnly?'独立窗口可见（专项不验收置顶）':'独立置顶窗口（透明参数另有原生单元覆盖）');
 await main.goto(origin+'/modules/assistant/');await main.locator('#workspace').waitFor();
 await widget.evaluate(async()=>{const {createChatHistory}=await import('./chat-history.js');window.testHistory=createChatHistory();await window.testHistory.open('whale-fixture');await window.testHistory.save([{id:'desktop-sync-user',role:'user',content:'隔离桌面同步测试'},{id:'desktop-sync-reply',role:'assistant',content:'已同步这次对话'}]);});
 await main.waitForFunction(()=>document.querySelector('#messages').textContent.includes('已同步这次对话'));
 await main.locator('#clear-chat').click();await widget.waitForFunction(()=>window.testHistory.read().messages.length===0);checks.push('真实独立Electron窗口共享近期文字记录与清空（无模型或语音调用）');
 historyFixture=true;
 await widget.reload();await widget.waitForFunction(()=>window.testSend&&window.testReady());
 const failure=await widget.evaluate(async()=>{try{await window.testSend('查查英雄联盟相关新闻');}catch(error){return error.message;}});assert.match(failure,/模型工具调用达到限制/);
 await main.waitForFunction(()=>document.querySelector('#messages').textContent.includes('本次未完成：隔离测试：模型工具调用达到限制'));
 assert.match(await main.locator('#messages').textContent(),/查查英雄联盟相关新闻/);
 await main.reload();await main.waitForFunction(()=>document.querySelector('#messages').textContent.includes('模型工具调用达到限制'));
 await main.locator('#clear-chat').click();historyFixture=false;
 checks.push('摆件真实失败问题和原始原因同步主窗口，重载后仍在（HTTP失败夹具，无付费请求）');
 if(!historyOnly){
 const {executeDesktopAction}=await import('../server/desktop-action-bridge.js');
 assert.equal((await executeDesktopAction(path.join(directory,'data'),'open_atb',{page:'tools'})).ok,true);
 await main.waitForURL('**/modules/assistant/#tools');await main.locator('#tools-enabled [data-capability=search]').waitFor();checks.push('独立本机服务通过可信管道打开真实桌面工具页面');
 await main.evaluate(()=>{window.__approval=window.atbConfirm({title:'确认操作应用',message:'点击模拟按钮',detail:'Test input：测试123',confirmLabel:'执行此操作',cancelLabel:'取消',requestId:'fixture-one'});});
 await main.locator('.atb-message-dialog').waitFor();assert.equal(await main.getByRole('button',{name:'取消',exact:true}).evaluate(el=>el===document.activeElement),true);
 assert.equal(await main.evaluate(()=>window.atbConfirm({message:'另一条请求',requestId:'fixture-two'})),false,'concurrent confirmation cannot inherit another approval');
 await main.evaluate(()=>window.atbCancelConfirm('other-request'));assert.equal(await main.locator('.atb-message-dialog').isVisible(),true);
 await main.screenshot({path:path.join(output,'desktop-action-confirm.png')});await main.getByRole('button',{name:'执行此操作',exact:true}).click();assert.equal(await main.evaluate(()=>window.__approval),true);
 await main.evaluate(()=>{window.__approval=window.atbConfirm({title:'确认操作应用',message:'应取消的模拟操作',requestId:'fixture-cancel'});});
 await main.locator('.atb-message-dialog').waitFor();await main.evaluate(()=>window.atbCancelConfirm('fixture-cancel'));assert.equal(await main.evaluate(()=>window.__approval),false);assert.equal(await main.locator('.atb-message-dialog').count(),0);checks.push('真实主题操作确认默认取消、请求隔离、执行与取消');
 await main.goto(origin+'/modules/assistant/');await main.locator('#workspace').waitFor();
 const preparation=await widget.evaluate(()=>window.atbCompanion.call('voice',{action:'prepare'}));assert.equal(preparation.prepared,false);assert.equal(preparation.reason,'disabled');checks.push('真实IPC预加载遵守语音总开关');
 const wakeWorker=path.join(directory,'wake-fixture.cjs');await writeFile(wakeWorker,"const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',s=>{const m=JSON.parse(s);console.log(JSON.stringify({id:m.id,ok:true,text:'你好助手'}));});console.log(JSON.stringify({type:'ready'}));");
 await app.evaluate(async(_,options)=>{const {getVoiceRuntime}=process.mainModule.require(options.filename);const runtime=getVoiceRuntime(options.dataDir);runtime.command=runtime.ttsCommand=options.node;runtime.worker=options.worker;runtime.verifyInstallation=false;},{filename:path.join(root,'modules','assistant','server','voice-runtime.js'),dataDir:path.join(directory,'data','assistant'),node:process.execPath,worker:wakeWorker});
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','voice',{action:'settings',enabled:true,wakeEnabled:true,wakePhrases:['你好助手']}));
 assert.deepEqual(await widget.evaluate(()=>window.atbCompanion.call('voice',{action:'wakeSettings'})),{enabled:true,wakeEnabled:true,wakePhrases:['你好助手']});
 const wakeLease=await widget.evaluate(()=>window.atbCompanion.call('voice',{action:'wakeOpen',leaseId:'desktop-wake-00000001'}));assert.equal(wakeLease.mode,'wake');
 const mainLease=await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','voice',{action:'open',leaseId:'desktop-chat-00000001'}));assert.equal(mainLease.reused,true);assert.equal(mainLease.pid,wakeLease.pid);
 await widget.evaluate(leaseId=>window.atbCompanion.call('voice',{action:'close',leaseId,keepWarm:true}),wakeLease.leaseId);
 assert.equal((await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','voice',{action:'status'}))).mode,'conversation');
 await main.evaluate(leaseId=>window.atbDesktop.invokeModule('assistant','voice',{action:'close',leaseId,keepWarm:true}),mainLease.leaseId);
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','voice',{action:'settings',enabled:false}));checks.push('真实IPC唤醒设置/待机租约/前台优先及模型复用（隔离worker，无实体麦克风）');
 const errorOffset=errors.length;
 await app.evaluate((_,options)=>{
  const {getVoiceRuntime}=process.mainModule.require(options.filename),runtime=getVoiceRuntime(options.dataDir);
  runtime.ttsRequest=async()=>new Response(new ReadableStream({start(){}}));
 },{filename:path.join(root,'modules/assistant/server/voice-runtime.js'),dataDir:path.join(directory,'data','assistant')});
 await widget.evaluate(()=>window.atbCompanion.call('voice',{action:'settings',provider:'volcengine',volcengine:{apiKey:'fixture-no-real-key',method:'http-chunked'}}));
 const stoppedRead=await widget.evaluate(async()=>{
  const call=options=>window.atbCompanion.call('voice',options),lease=await call({action:'open',mode:'synthesis'}),stream=await call({action:'ttsStart',leaseId:lease.leaseId}),args={leaseId:lease.leaseId,streamId:stream.streamId};
  await call({action:'ttsText',...args,text:'我查一下近期新闻。'});await call({action:'ttsFinish',...args});
  const reading=call({action:'ttsRead',...args});await call({action:'close',leaseId:lease.leaseId,keepWarm:true});return reading;
 });
 assert.deepEqual(stoppedRead,{cancelled:true});
 await widget.waitForTimeout(50);assert.doesNotMatch(errors.slice(errorOffset).join(''),/Error occurred in handler for 'atb:companion'|SynthesisError/);
 await widget.evaluate(()=>window.atbCompanion.call('voice',{action:'settings',provider:'chattts'}));
 checks.push('真实atb:companion取消待取PCM返回取消状态，无Electron语音异常日志（模拟上游）');
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type:'delta',account:'whale-fixture',text:'真实桌面流式回复'}}));await widget.waitForFunction(()=>document.querySelector('#reply').textContent==='真实桌面流式回复');checks.push('真实IPC回复镜像');
 await main.evaluate(async()=>{for(const event of [{type:'state',account:'whale-fixture',active:true,phase:'speaking'},{type:'reply',account:'whale-fixture',text:'真实桌面流式回复'}])await window.atbDesktop.invokeModule('assistant','companion',{action:'event',event});});
 assert.equal(await widget.locator('#speech-close').count(),0);assert.equal(await widget.locator('#speech-body').evaluate(el=>getComputedStyle(el).overflowY),'auto');
 const originalLayout=await widget.evaluate(()=>window.atbCompanion.call('layout')),originalBounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds());const originalAnchor={x:originalBounds.x+originalLayout.x,y:originalBounds.y+originalLayout.y};
 // Control only this isolated instance's cursor reader; never move the user's OS cursor.
 const corner=await app.evaluate(({screen})=>{globalThis.__companionCursorReader=screen.getCursorScreenPoint;globalThis.__companionCursor={x:400,y:400};screen.getCursorScreenPoint=()=>({...globalThis.__companionCursor});const area=screen.getPrimaryDisplay().bounds;return{x:area.x+area.width-20,y:area.y+area.height-20};});
 try {
  await widget.evaluate(()=>window.atbCompanion.call('dragStart'));await app.evaluate((_,point)=>{globalThis.__companionCursor={x:400+point.x,y:400+point.y};},{x:corner.x-originalAnchor.x,y:corner.y-originalAnchor.y});await widget.evaluate(()=>window.atbCompanion.call('drag'));
  const during=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds());const edgeLayout=await widget.evaluate(()=>window.atbCompanion.call('layout'));assert.deepEqual({x:during.x+edgeLayout.x,y:during.y+edgeLayout.y},corner);
  await widget.evaluate(()=>window.atbCompanion.call('dragEnd'));const after=await app.evaluate(({BrowserWindow,screen})=>{const bounds=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds(),area=screen.getDisplayMatching(bounds).bounds;return{bounds,bounded:bounds.x>=area.x&&bounds.y>=area.y&&bounds.x+bounds.width<=area.x+area.width&&bounds.y+bounds.height<=area.y+area.height};});assert.deepEqual(after.bounds,during);assert.equal(after.bounded,true);assert.deepEqual(JSON.parse(await readFile(path.join(directory,'data/platform/desktop-companion.json'),'utf8')).anchor,corner);
  await widget.waitForFunction(expected=>{const r=document.querySelector('#avatar').getBoundingClientRect();return Math.abs(r.x+r.width/2-expected.x)<1&&Math.abs(r.y+r.height/2-expected.y)<1;},edgeLayout);
  const bubble=await widget.locator('#speech').boundingBox();assert.ok(bubble&&bubble.x>=8&&bubble.y>=8&&bubble.x+bubble.width<=during.width-8&&bubble.y+bubble.height<=during.height-8);await widget.screenshot({path:path.join(output,'desktop-bottom-right.png')});
  const display=await app.evaluate(({screen})=>screen.getPrimaryDisplay().bounds),lineCount=Math.max(8,Math.min(30,Math.floor((display.height-190)/22)));
  const lines=Array.from({length:lineCount},(_,i)=>`第${i+1}行：真实桌面回复逐步向上延展`);
  let replyAnchor;
  for(const count of [4,Math.ceil(lineCount/2),lineCount]){
   await main.evaluate(text=>window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type:'delta',account:'whale-fixture',text}}),lines.slice(0,count).join('\n'));
   await widget.waitForTimeout(350);
   const bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds()),box=await widget.locator('#speech').boundingBox(),currentLayout=await widget.evaluate(()=>window.atbCompanion.call('layout'));
   const anchor={x:bounds.x+box.x,bottom:bounds.y+box.y+box.height,revision:currentLayout.positionRevision};
   if(replyAnchor){assert.ok(Math.abs(anchor.x-replyAnchor.x)<=1,'native canvas growth preserves bubble horizontal anchor');assert.ok(Math.abs(anchor.bottom-replyAnchor.bottom)<=1,'growth preserves attachment to character');assert.equal(anchor.revision,replyAnchor.revision,'canvas growth is not a character move');}replyAnchor=anchor;
  }
  const grown=await widget.locator('#speech').boundingBox(),body=await widget.locator('#speech-body').evaluate(el=>({top:el.scrollTop,full:el.scrollHeight,visible:el.clientHeight}));
  assert.equal(body.top,0);assert.ok(body.full<=body.visible+1);if(display.height>650)assert.ok(grown.height>350);
  const grownBounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds()),grownLayout=await widget.evaluate(()=>window.atbCompanion.call('layout'));
  assert.deepEqual({x:grownBounds.x+grownLayout.x,y:grownBounds.y+grownLayout.y},corner);assert.ok(grown.x>=8&&grown.y>=8&&grown.x+grown.width<=grownBounds.width-8&&grown.y+grown.height<=grownBounds.height-8);
  await widget.screenshot({path:path.join(output,'desktop-growing-reply.png')});checks.push('长回复按文字向上延展、原生画布扩展、首尾完整与人物锚点保持');
  await main.evaluate(text=>window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type:'reply',account:'whale-fixture',text}}),lines.join('\n'));
  await widget.evaluate(()=>window.atbCompanion.call('expand',{active:true}));let expandedLayout=await widget.evaluate(()=>window.atbCompanion.call('layout'));let expandedBounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds());assert.deepEqual({x:expandedBounds.x+expandedLayout.x,y:expandedBounds.y+expandedLayout.y},corner);
  await widget.waitForFunction(size=>innerWidth===size.width&&innerHeight===size.height,expandedBounds);
  await widget.evaluate(()=>window.atbCompanion.call('expand',{active:false}));
  await widget.waitForFunction(size=>innerWidth===size.width&&innerHeight===size.height&&!document.querySelector('#speech').hidden,grownBounds);
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').getBounds()),grownBounds);
  await widget.evaluate(()=>window.atbCompanion.call('dragStart'));await app.evaluate(()=>{globalThis.__companionCursor={x:400,y:400};});await widget.evaluate(()=>window.atbCompanion.call('dragEnd'));
 } finally { await app.evaluate(({screen})=>{screen.getCursorScreenPoint=globalThis.__companionCursorReader;delete globalThis.__companionCursorReader;delete globalThis.__companionCursor;}); }
 checks.push('形象屏幕锚点拖到角落不回弹、松手持久化与图片扩展恢复');
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type:'state',account:'whale-fixture',active:true,phase:'listening'}}));
 await widget.waitForFunction(()=>getComputedStyle(document.querySelector('.listening-hand')).opacity==='1');await widget.screenshot({path:path.join(output,'desktop-listening.png')});checks.push('倾听状态抬手靠耳');
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type:'state',account:'whale-fixture',active:true,phase:'thinking'}}));
 await widget.waitForFunction(()=>getComputedStyle(document.querySelector('.thinking-hand')).opacity==='1');await widget.screenshot({path:path.join(output,'desktop-thinking.png')});
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','companion',{action:'event',event:{type:'state',account:'whale-fixture',active:true,phase:'listening'}}));checks.push('思考手托下巴与思考气泡，回到倾听姿势');
 await widget.waitForFunction(()=>document.querySelector('#speech').hidden,null,{timeout:6500});checks.push('无关闭按钮或滚动条，朗读结束后5秒淡出');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').focus());
 await widget.locator('#avatar').click({button:'right'});assert.equal(await widget.locator('#menu').isVisible(),true);
 await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 智能助手');win.show();win.focus();});await main.locator('body').click({position:{x:15,y:80}});
 await widget.waitForFunction(()=>document.querySelector('#menu').hidden,null,{timeout:2500});checks.push('菜单在点击主窗口后自动关闭');
 await widget.locator('#avatar').click({button:'right'});await widget.getByRole('button',{name:'平台设置',exact:true}).click();await main.waitForURL('**/platform#settings/general');await main.getByRole('button',{name:'保存小助手设置',exact:true}).waitFor();checks.push('主题右键菜单导航与平台设置');
 await main.getByLabel('新闻提醒',{exact:true}).uncheck();await main.getByRole('button',{name:'保存小助手设置',exact:true}).click();await main.getByText('小助手设置已保存',{exact:true}).waitFor();assert.equal(JSON.parse(await readFile(path.join(directory,'data/platform/desktop-companion.json'),'utf8')).news,false);checks.push('平台偏好真实持久化');
 await widget.screenshot({path:path.join(output,'desktop-widget.png')});await main.screenshot({path:path.join(output,'desktop-settings.png')});
 const closed=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/platform'));win.close();return{destroyed:win.isDestroyed(),visible:win.isVisible()};});assert.deepEqual(closed,{destroyed:false,visible:false});checks.push('关闭主窗收进系统托盘');
 await widget.locator('#avatar').click({button:'right'});await widget.getByRole('button',{name:'打开智能助手',exact:true}).click();await main.waitForURL('**/modules/assistant/#assistant');assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/modules/assistant/#assistant')).isVisible()),true);checks.push('摆件恢复主窗');
 await widget.evaluate(()=>window.atbCompanion.call('update',{enabled:false}));assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='ATB · 小鲸鱼').isVisible()),false);checks.push('显隐即时生效');
 await main.evaluate(()=>window.atbDesktop.invokeModule('assistant','companion',{action:'settings',settings:{enabled:true}}));const logoutStatus=await main.evaluate(async()=>{const response=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return response.status;});assert.equal(logoutStatus,200);await widget.waitForFunction(()=>document.documentElement.dataset.account==='');assert.equal(await widget.locator('#reply').textContent(),'');checks.push('真实会话注销清理');
 }
 await app.close();app=null;checks.push('退出回收所有自有窗口');await writeFile(path.join(output,historyOnly?'history-desktop-report.json':'desktop-report.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks},null,2));
}catch(error){console.log('FAIL',error.message,'desktop errors',errors);await writeFile(path.join(output,'desktop-failure.json'),JSON.stringify({message:error.message,checks,errors},null,2));throw error;}finally{if(app)await app.evaluate(({BrowserWindow,app})=>{for(const win of BrowserWindow.getAllWindows())win.webContents.on('will-prevent-unload',event=>event.preventDefault());app.quit();}).catch(()=>{});await app?.close().catch(()=>{});await service.close();await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
