import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {readFile,mkdir} from 'node:fs/promises';import path from 'node:path';import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..');

test('widget shows the original failed news error after voice stops and keeps cancellation silent',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript; charset=utf-8':asset.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');const body=await readFile(path.join(root,asset),'utf8');res.end(body+(asset.endsWith('/companion.js')?'\nwindow.testVoice=voice;window.testReady=()=>Boolean(account&&!pollBusy&&config.hasApiKey&&config.model);':''));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage({viewport:{width:560,height:520}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
   let pending,lease;window.failSynthesis=()=>pending?.(null);
   window.atbCompanion={onEvent(){},call:async(action,options)=>{
     if(action==='settings')return {enabled:true,showText:true,reminders:false};
     if(action!=='voice')return {};
     if(options.action==='status')return {available:true,synthesisAvailable:true,settings:{enabled:true,wakeEnabled:false,provider:'qwen3tts',autoListen:true}};
     if(options.action==='wakeSettings')return {enabled:true,wakeEnabled:false};
     if(options.action==='prepare')return {prepared:true};
     if(options.action==='open'){lease=options.leaseId;return {leaseId:lease};}
     if(options.action==='speak')return new Promise((resolve,reject)=>{pending=value=>value===null?reject(Error('语音合成 HTTP 503')):resolve(value);});
     if(options.action==='close'){pending?.({cancelled:true});pending=null;return {ok:true};}
     return {};
   }};
   Object.defineProperty(navigator,'mediaDevices',{value:{async getUserMedia(){return {getTracks:()=>[{stop(){}}]};}}});
   window.AudioContext=class {sampleRate=16000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){}createMediaStreamSource(){return {connect(){},disconnect(){}};}};
   window.AudioWorkletNode=class {port={close(){}};connect(){}disconnect(){}};
 });
 await page.route('**/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/api/assistant/chat'){
     const question=route.request().postDataJSON().messages.at(-1).content;
     const events=question==='正常查询'?[{type:'delta',text:'这是查到的新闻。'},{type:'done',reply:'这是查到的新闻。'}]:[{type:'delta',text:'我查一下。'},{type:'error',error:'新闻查询后模型 HTTP 503，请稍后重试。'}];
     await route.fulfill({contentType:'application/x-ndjson',body:events.map(event=>JSON.stringify(event)+'\n').join('')});return;
   }
   await route.fulfill({json:pathname==='/api/auth/session'?{user:{username:'news-test'}}:pathname==='/api/assistant/settings'?{name:'测试助手',hasApiKey:true,model:'fixture'}:{enabled:false,quietEnabled:false}});
 });
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='news-test'&&window.testVoice&&window.testReady());
 await page.evaluate(()=>window.testVoice.start({initialText:'查近期新闻'}));
 await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('visible')&&document.querySelector('#notice-text').textContent.includes('HTTP 503'));
 assert.equal(await page.locator('#companion').getAttribute('data-phase'),'off');
 assert.equal(await page.locator('#reply').textContent(),'');
 assert.equal(await page.evaluate(()=>window.testVoice.active),false);
 assert.doesNotMatch(await page.locator('#notice-text').textContent(),/语音已停止/);
 await page.evaluate(()=>window.testVoice.start({initialText:'正常查询'}));
 await page.waitForFunction(()=>document.querySelector('#reply').textContent==='这是查到的新闻。');
 await page.evaluate(()=>window.failSynthesis());
 await page.waitForFunction(()=>!window.testVoice.active);
 await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('visible')&&document.querySelector('#notice-text').textContent==='语音合成 HTTP 503',null,{timeout:1500});
 assert.equal(await page.locator('#reply').textContent(),'','failed playback yields its bubble to the error notice');
 assert.deepEqual(errors,[]);
});
test('local voice keeps its listening and thinking poses when another window sends late events',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript; charset=utf-8':asset.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520},reducedMotion:'reduce'});
 await page.route('**/assistant-voice.js',route=>route.fulfill({contentType:'text/javascript',body:`export function createAssistantVoice({onState,onLevel}){let active=false;const voice={get active(){return active},setOutputDevice(){},async stop(){active=false;onState({active:false,phase:'off'})},phase(phase){active=phase!=='off';onState({active,phase});onLevel(.7)}};window.localVoice=voice;return voice;}`}));
 await page.addInitScript(()=>{window.events=[];window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async action=>action==='settings'?{enabled:true,showText:true,reminders:false}:{}};});
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/auth/session'?{user:{username:'alice'}}:{enabled:false,quietEnabled:false}}));
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 for(const phase of ['speaking','listening','transcribing','thinking','listening']){
  await page.evaluate(phase=>{window.localVoice.phase(phase);for(const event of [{type:'state',active:false,phase:'off'},{type:'level',level:0},{type:'delta',text:'过期回复'},{type:'reply',text:'过期回复'}])window.events.forEach(fn=>fn({...event,account:'alice',source:200}));},phase);
  assert.equal(await page.locator('#companion').getAttribute('data-phase'),phase);
  assert.equal(await page.locator('#companion').evaluate(el=>el.style.getPropertyValue('--level')),'0.7');
  assert.equal(await page.locator('.listening-hand').evaluate(el=>getComputedStyle(el).opacity),phase==='listening'?'1':'0');
  assert.equal(await page.locator('.thinking-hand').evaluate(el=>getComputedStyle(el).opacity),['transcribing','thinking'].includes(phase)?'1':'0');
  assert.equal(await page.locator('#reply').textContent(),'');
 }
 await page.evaluate(()=>{window.localVoice.phase('off');window.events.forEach(fn=>fn({type:'state',active:true,phase:'listening',account:'alice',source:100}));});
 assert.equal(await page.locator('#companion').getAttribute('data-phase'),'listening','a new remote owner can take over after local voice stops');
});
test('visible widget prepares voice without opening the microphone and shows a hand beside the ear only while listening', async t => {
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.events=[];window.calls=[];window.microphoneCalls=0;window.preferences={enabled:true,showText:true,reminders:false};
  navigator.mediaDevices.getUserMedia=async()=>{window.microphoneCalls++;throw Error('must not capture during preparation');};
  window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async(action,options)=>{window.calls.push({action,options});if(action==='settings')return window.preferences;if(action==='voice'&&options.action==='prepare')return{prepared:true,status:'idle',modelLoaded:true,recognitionLoaded:true};if(action==='toggleVoice')return{forwarded:true};return{};}};
 });
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/auth/session'?{user:{username:'alice'}}:{enabled:false,quietEnabled:false}}));
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');
 await page.waitForFunction(()=>window.calls.some(c=>c.action==='voice'&&c.options.action==='prepare'),null,{timeout:1500});
 assert.equal(await page.evaluate(()=>window.microphoneCalls),0);assert.equal(await page.evaluate(()=>window.calls.some(c=>c.action==='voice'&&c.options.action==='open')),false);
 assert.match(await page.locator('#avatar').getAttribute('title'),/已就绪/);
 const hand=page.locator('.listening-hand'),emit=data=>page.evaluate(event=>window.events.forEach(fn=>fn(event)),data);
 assert.equal(await hand.evaluate(el=>getComputedStyle(el).opacity),'0');
 await emit({type:'state',account:'alice',active:true,phase:'listening'});
 assert.equal(await hand.evaluate(el=>getComputedStyle(el).opacity),'1','listening posture also works with reduced motion');
 await emit({type:'state',account:'alice',source:100,active:true,phase:'listening'});
 await emit({type:'state',account:'alice',source:200,active:false,phase:'off'});
 assert.equal(await page.locator('#companion').getAttribute('data-phase'),'listening','a different window stopping must not override the current voice owner');
 await emit({type:'state',account:'alice',source:100,active:true,phase:'thinking'});
 assert.equal(await page.locator('.thinking-hand').evaluate(el=>getComputedStyle(el).opacity),'1','waiting for an answer has a visible thinking pose');
 await emit({type:'state',account:'alice',source:100,active:true,phase:'listening'});
 const posture=await page.evaluate(()=>{const h=document.querySelector('.listening-hand').getBoundingClientRect(),ear=document.querySelector('.listening-ear').getBoundingClientRect();return{hand:{x:h.x,y:h.y,right:h.right,bottom:h.bottom},ear:{x:ear.x,y:ear.y,right:ear.right,bottom:ear.bottom}};});
 assert.ok(posture.hand.x<posture.ear.right+15&&posture.hand.right>posture.ear.x-15&&posture.hand.y<posture.ear.bottom+20&&posture.hand.bottom>posture.ear.y-20,'raised hand is beside the ear');
 await mkdir('test-results/companion-listening',{recursive:true});await page.screenshot({path:'test-results/companion-listening/listening.png'});
 for(const phase of ['speaking','thinking','off']){await emit({type:'state',account:'alice',active:phase!=='off',phase});assert.equal(await hand.evaluate(el=>getComputedStyle(el).opacity),'0');}
 await page.locator('#avatar').click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='toggleVoice').length),1);
 await page.evaluate(()=>{window.preferences={enabled:false,showText:true};window.events.forEach(fn=>fn({type:'settings',settings:window.preferences}));});const count=await page.evaluate(()=>window.calls.filter(c=>c.action==='voice'&&c.options.action==='prepare').length);
 await page.waitForTimeout(3200);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='voice'&&c.options.action==='prepare').length),count,'hidden widget does not prepare models');assert.deepEqual(errors,[]);
});
async function trackReplyExpiry(page){await page.addInitScript(()=>{const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms===5000)window.replyTimeout=fn;return timeout(fn,ms,...args);};});}
async function expireReply(page){await page.evaluate(()=>{const account=document.documentElement.dataset.account,text=document.querySelector('#reply').textContent;window.events.forEach(fn=>fn({type:'state',account,active:false,phase:'off'}));window.events.forEach(fn=>fn({type:'reply',account,text}));window.replyTimeout();});await page.waitForFunction(()=>document.querySelector('#speech').hidden);}
test('reply bubble has no frame on the character, preserves the start of long text and fades five seconds after speech',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.events=[];window.expiryCount=0;const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms===5000){window.expiryCount++;window.replyTimeout=fn;}return timeout(fn,ms,...args);};window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async action=>action==='settings'?{enabled:true,showText:true,reminders:false}:action==='toggleVoice'?{forwarded:true}:{} };});
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/auth/session'?{user:{username:'alice'}}:{enabled:false,quietEnabled:false}}));
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 const emit=data=>page.evaluate(event=>window.events.forEach(fn=>fn(event)),data),speech=page.locator('#speech');
 assert.equal(await page.locator('#speech-close').count(),0,'reply has no close button');await page.locator('#avatar').focus();assert.equal(await page.locator('#avatar').evaluate(el=>getComputedStyle(el).outlineStyle),'none','the character has no rectangular focus outline');
 await emit({type:'state',account:'alice',active:true,phase:'speaking'});
 const text='这是仍然在朗读的长回复。'.repeat(80)+'最后是最新的数字：1.22元';await emit({type:'reply',account:'alice',text});
 assert.equal(await page.evaluate(()=>window.expiryCount),0,'text completion must not start expiry while audio is playing');
 for(const anchor of [{x:35,y:45},{x:525,y:45},{x:35,y:475},{x:525,y:475},{x:280,y:285}]){
  await emit({type:'layout',layout:{...anchor,width:560,height:520}});
  const r=await speech.boundingBox(),a=await page.locator('#avatar').boundingBox();assert.ok(r&&r.width>286&&r.x>=8&&r.y>=8&&r.x+r.width<=552&&r.y+r.height<=512);assert.ok(r.x+r.width<=a.x||r.x>=a.x+a.width||r.y+r.height<=a.y||r.y>=a.y+a.height);
  const body=await page.locator('#speech-body').evaluate(el=>({overflow:getComputedStyle(el).overflowY,top:el.scrollTop}));assert.equal(body.overflow,'auto');assert.equal(body.top,0,'long replies keep their opening lines visible instead of forcing the last line');
 }
 await mkdir('test-results/companion-reply',{recursive:true});await page.screenshot({path:'test-results/companion-reply/stream.png'});
 await emit({type:'state',account:'alice',active:true,phase:'listening'});assert.equal(await page.evaluate(()=>window.expiryCount),1);
 await page.waitForTimeout(4400);assert.equal(await speech.isVisible(),true,'keep text for about five seconds after playback');
 await page.waitForFunction(()=>document.querySelector('#speech').hidden,null,{timeout:1800});
 await emit({type:'settings',settings:{enabled:true,showText:true,reminders:false}});assert.equal(await speech.isVisible(),false,'polls do not restore expired replies');
 await emit({type:'proactive',account:'alice',text:'新的主动回复'});assert.equal(await speech.isVisible(),true);assert.deepEqual(errors,[]);
});
test('streamed reply expands upward beyond 300px, keeps all text, and lets screen-sized replies be read',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript; charset=utf-8':asset.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:1280,height:1080},reducedMotion:'no-preference'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.events=[];window.calls=[];window.preferences={enabled:true,showText:true,reminders:false};window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async(action,options)=>{window.calls.push({action,options});return action==='settings'?window.preferences:{};}};});
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/auth/session'?{user:{username:'alice'}}:{enabled:false,quietEnabled:false}}));
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 const emit=data=>page.evaluate(event=>window.events.forEach(fn=>fn(event)),data),speech=page.locator('#speech');
 await emit({type:'layout',layout:{x:1120,y:940,width:1280,height:1080}});
 await emit({type:'state',account:'alice',active:true,phase:'speaking'});
 const lines=Array.from({length:30},(_,i)=>i===0?'开头必须一直完整保留':`第${i+1}行，流式文字继续增加`);
 let previous;
 for(const count of [6,16,30]){
  await emit({type:'delta',account:'alice',text:lines.slice(0,count).join('\n')});
  if(previous){await page.waitForTimeout(60);const middle=await speech.boundingBox();assert.ok(middle.height>previous.height&&middle.height<(count*22+60),'the frame expands gradually');}
  await page.waitForTimeout(220);const rect=await speech.boundingBox();
  const body=await page.locator('#speech-body').evaluate(el=>({top:el.scrollTop,full:el.scrollHeight,visible:el.clientHeight}));
  assert.equal(body.top,0);assert.ok(body.full<=body.visible+1,'both the beginning and new lines fit without clipping');
  assert.ok(rect.y>=8&&rect.y+rect.height<=837,'reply grows above the character within the screen');
  if(previous){assert.ok(rect.height>previous.height);assert.ok(rect.y<previous.y);assert.ok(Math.abs(rect.y+rect.height-previous.y-previous.height)<=1);}
  if(previous)assert.equal(rect.x,previous.x,'streaming must keep the chosen horizontal anchor');
  previous=rect;
 }
 assert.ok(previous.height>600,'the reply must grow well beyond the old fixed maximum');
 assert.equal(await page.locator('#reply').textContent(),lines.join('\n'));
 await mkdir('test-results/companion-growth',{recursive:true});await page.screenshot({path:'test-results/companion-growth/long-reply.png'});
 const long=lines.concat(Array.from({length:150},(_,i)=>`后续第${i+31}行，仍保留完整内容`)).join('\n');
 await emit({type:'delta',account:'alice',text:long});await page.waitForTimeout(240);
 const body=page.locator('#speech-body'),box=await body.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,180);await page.waitForFunction(()=>document.querySelector('#speech-body').scrollTop>0);
 const scrolled=await body.evaluate(el=>el.scrollTop);await emit({type:'delta',account:'alice',text:long+'\n最后一行'});
 await emit({type:'settings',settings:{enabled:true,showText:true,reminders:false}});
 assert.equal(await body.evaluate(el=>el.scrollTop),scrolled,'new chunks and settings polls preserve the reader position');
 assert.equal(await page.locator('#reply').textContent(),long+'\n最后一行');
 await emit({type:'reply',account:'alice',text:long+'\n最后一行'});await emit({type:'state',account:'alice',active:false,phase:'off'});
 await page.waitForTimeout(5300);assert.equal(await speech.isVisible(),true,'reading with the pointer over a long reply pauses auto-hide');
 await page.setViewportSize({width:840,height:660});await emit({type:'layout',layout:{x:820,y:640,width:840,height:660}});
 await emit({type:'layout',layout:{x:1120,y:940,width:1280,height:1080}});
 assert.equal(await speech.isVisible(),true,'layout arriving before native resize must not hide a long reply');
 await page.setViewportSize({width:1280,height:1080});await page.waitForTimeout(240);
 await emit({type:'proactive',account:'alice',text:'下一条是短回复'});await page.waitForTimeout(240);
 assert.ok((await speech.boundingBox()).height<100,'a new short reply shrinks to its own content instead of keeping the previous height');
 assert.equal(await body.evaluate(el=>el.scrollTop),0,'new replies start at the beginning');
 assert.ok(await page.evaluate(()=>window.calls.filter(c=>c.action==='replySize').at(-1).options.height<100),'native canvas can shrink again after a long reply');
 await emit({type:'settings',settings:{enabled:true,showText:false,reminders:false}});assert.equal(await speech.isVisible(),false);
 assert.ok(await page.evaluate(()=>window.calls.some(c=>c.action==='replySize'&&c.options.height>600)),'request enough native canvas room for the text');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='replySize').at(-1).options.height),0,'hidden text releases the extra canvas');
 assert.deepEqual(errors,[]);
});

test('widget context menu dismisses on outside clicks and window blur without activating an option',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.calls=[];window.atbCompanion={onEvent(fn){window.companionEvent=fn;},call:async(action,options)=>{window.calls.push({action,options});return action==='settings'?{enabled:true,showText:true,reminders:false}:action==='toggleVoice'?{forwarded:true}:{};}};});
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/auth/session'?{user:{username:'alice'}}:{enabled:false,quietEnabled:false}}));
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 const avatar=page.locator('#avatar'),menu=page.locator('#menu');
 await avatar.click({button:'right'});assert.equal(await menu.isVisible(),true);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await menu.isVisible(),false,'losing focus closes the menu');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='hit').at(-1)?.options.active),false,'dismissal releases the transparent canvas');
 await avatar.click({button:'right'});await page.evaluate(()=>window.companionEvent({type:'dismiss-menu'}));assert.equal(await menu.isVisible(),false,'native blur closes the menu even without a DOM blur event');
 await avatar.click({button:'right'});await page.mouse.click(10,10);assert.equal(await menu.isVisible(),false);
 assert.equal(await page.evaluate(()=>window.calls.some(c=>['open','toggleVoice','update','quit'].includes(c.action))),false,'dismissing never chooses an option');
 await avatar.click({button:'right'});await avatar.click({position:{x:10,y:10}});assert.equal(await menu.isVisible(),false,'the character is also outside the menu');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='toggleVoice').length),1,'clicking the character still toggles voice');
 await avatar.click({button:'right'});await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
 await avatar.click({button:'right'});await page.getByRole('button',{name:'平台设置',exact:true}).click();assert.equal(await menu.isVisible(),false);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='open'&&c.options.page==='platform').length),1);
 assert.deepEqual(errors,[]);
});
test('passive hints float briefly, avoid the character and fade quickly when conversation starts',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520},reducedMotion:'no-preference'}),errors=[];page.on('pageerror',e=>errors.push(e.message));await trackReplyExpiry(page);let usageValue={kind:'usage',scope:'key',amount:'0.70',currency:'CNY',coverage:'recent-records',records:3,refunds:0};
 await page.addInitScript(()=>{window.events=[];window.calls=[];window.preferences={enabled:true,showText:true,reminders:true,nextReminderAt:Date.now()+999999};window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async(action,options)=>{window.calls.push({action,options});return action==='settings'?window.preferences:action==='toggleVoice'?{forwarded:true}:{};}};});
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;return route.fulfill({json:p==='/api/auth/session'?{user:{username:'alice'}}:p==='/api/assistant/settings'?{name:'小鲸鱼',hasApiKey:true,model:'fixture'}:p.endsWith('/usage')?usageValue:p.endsWith('/balance')?{kind:'balance',amounts:[{currency:'CNY',amount:'8.60'}]}:p.endsWith('/news')?{items:[{title:'测试新闻标题'.repeat(40),url:'https://www.chinanews.com.cn/test-'+Math.random()+'.shtml',source:'中国新闻网',publishedAt:'2026-11-14T00:00:00Z'}]}:{enabled:false,quietEnabled:false}});});
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 assert.equal(await page.locator('#status,#more,#notice-close').count(),0,'no status pill or close control on passive hints');
 const hint=page.locator('#notice');
 const emit=data=>page.evaluate(event=>window.events.forEach(fn=>fn(event)),data);
 const remind=async()=>{await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'新闻提醒',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('visible'));await page.waitForTimeout(300);};
 for(const anchor of [{x:280,y:285},{x:35,y:45},{x:525,y:45},{x:35,y:475},{x:525,y:475}]){
  await emit({type:'layout',layout:{...anchor,width:560,height:520}});await remind();
  const info=await hint.evaluate(el=>{const r=el.getBoundingClientRect(),a=document.querySelector('#avatar').getBoundingClientRect();return{r:{x:r.x,y:r.y,width:r.width,height:r.height},a:{x:a.x,y:a.y,width:a.width,height:a.height},text:document.querySelector('#notice-text').textContent,overflow:getComputedStyle(el).overflowY,pointer:getComputedStyle(el).pointerEvents,duration:el.getAnimations()[0]?.effect.getTiming().duration};});
  const {r,a}=info;assert.deepEqual({x:a.x+a.width/2,y:a.y+a.height/2},anchor,'focus and context menus must not scroll the clipped canvas');assert.ok(r.width<=200&&r.height<=90);assert.ok(r.x>=8&&r.y>=8&&r.x+r.width<=552&&r.y+r.height<=512,JSON.stringify({anchor,info}));assert.ok(r.x+r.width<=a.x||r.x>=a.x+a.width||r.y+r.height<=a.y||r.y>=a.y+a.height);assert.ok([...info.text].length<=56);assert.equal(info.overflow,'hidden');assert.equal(info.pointer,'none');assert.ok(info.duration>=3000&&info.duration<=5000);
 }
 const y=(await hint.boundingBox()).y;await page.waitForTimeout(700);assert.ok((await hint.boundingBox()).y<y-1,'hint drifts upward');
 const opacity=await hint.evaluate(el=>Number(getComputedStyle(el).opacity));await emit({type:'state',account:'alice',active:true,phase:'listening'});await page.waitForTimeout(60);
 const fading=await hint.evaluate(el=>Number(getComputedStyle(el).opacity));assert.ok(fading>0&&fading<opacity,'conversation dismisses with a fade');await page.waitForFunction(()=>!document.querySelector('#notice').classList.contains('visible'));
 await remindSuppressed();
 await emit({type:'state',account:'alice',active:false,phase:'off'});await remind();await emit({type:'delta',account:'alice',text:'新的文字回复'});await page.waitForFunction(()=>!document.querySelector('#notice').classList.contains('visible'));await remindSuppressed();
 await expireReply(page);await remind();
 await page.evaluate(()=>window.events.forEach(fn=>fn({type:'settings',settings:window.preferences})));
 await page.waitForFunction(()=>!document.querySelector('#notice').classList.contains('visible'),null,{timeout:5500});assert.equal(await hint.evaluate(el=>getComputedStyle(el).opacity),'0','natural expiry fades completely');
 const balanceHint=async()=>{await page.locator('#notice').evaluate(el=>el.getAnimations().forEach(a=>a.finish()));await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'余额提醒',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('visible'));};
 await balanceHint();assert.match(await page.locator('#notice-title').textContent(),/近24小时.*已查/);assert.match(await page.locator('#notice-text').textContent(),/当前密钥.*¥0.70/);assert.doesNotMatch(await hint.textContent(),/8.60/);
 await balanceHint();assert.equal(await page.locator('#notice-title').textContent(),'API 余额');assert.match(await hint.textContent(),/8.60/);
 usageValue={kind:'unsupported'};await balanceHint();assert.equal(await page.locator('#notice-title').textContent(),'API 余额');assert.doesNotMatch(await hint.textContent(),/消费.*0/,'unsupported usage never turns into zero expenditure');
 usageValue={kind:'estimate',scope:'account',method:'balance-decrease',currency:'CNY',amount:'0.80',observedSeconds:7200};await balanceHint();assert.match(await hint.textContent(),/余额减少估算.*0.80.*2.0小时/);await mkdir('test-results/usage-24h',{recursive:true});await page.waitForTimeout(350);await page.screenshot({path:'test-results/usage-24h/estimate.png'});
 await page.locator('#avatar').click();await page.waitForFunction(()=>window.calls.some(c=>c.action==='toggleVoice'));await page.locator('#avatar').click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='toggleVoice').length),2,'character click remains the voice toggle');
 await remind();await mkdir('test-results/companion-hints',{recursive:true});await page.screenshot({path:'test-results/companion-hints/passive.png'});assert.deepEqual(errors,[]);
 async function remindSuppressed(){await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'新闻提醒',exact:true}).click();await page.waitForTimeout(100);assert.equal(await hint.evaluate(el=>el.classList.contains('visible')),false);}
});
test('whale widget streams, randomizes notices, enlarges images on click and clears on logout',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':asset.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(path.join(root,asset)));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520}}),errors=[];page.on('pageerror',e=>errors.push(e.message));let account='alice',images=0,weatherGate,weatherStarted;
 await page.addInitScript(()=>{window.events=[];window.calls=[];window.preferences={enabled:true,showText:true,reminders:true,balance:true,weather:true,news:true,tips:true,city:{name:'上海',latitude:31,longitude:121},nextReminderAt:Date.now()+999999};window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async(action,options)=>{window.calls.push({action,options});if(action==='settings')return window.preferences;if(action==='update')return Object.assign(window.preferences,options);if(action==='voice'&&options.action==='status')return{settings:{enabled:false,provider:'chattts'}};return{};}};});
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let body;if(url.pathname==='/api/auth/session')body={user:account?{username:account}:null};else if(url.pathname==='/api/assistant/settings')body={name:'小鲸鱼',hasApiKey:true,model:'fixture'};else if(url.pathname==='/api/assistant/presence')body={enabled:false,quietEnabled:false};else if(url.pathname.endsWith('/weather')){weatherStarted?.();await weatherGate;body={temperature:21,description:'多云',source:'Open-Meteo',time:'2026-11-14T14:00'};}else if(url.pathname.endsWith('/news'))body={items:[{title:'测试新闻',url:'https://www.chinanews.com.cn/a.shtml',source:'中国新闻网',publishedAt:'2026-11-14T01:00:00Z'}]};else if(url.pathname.endsWith('/balance'))body={kind:'balance',amounts:[{currency:'CNY',amount:'8.60'}]};else if(url.pathname.endsWith('/image')){images++;await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNn8AAAAASUVORK5CYII=','base64')});return;}else throw Error('unexpected '+url.pathname);await route.fulfill({json:body});});
 await trackReplyExpiry(page);
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 await page.evaluate(()=>window.events.forEach(fn=>fn({type:'delta',account:'alice',text:'你好'})));assert.match(await page.locator('#reply').textContent(),/你好/);
 await page.evaluate(()=>window.events.forEach(fn=>fn({type:'reply',account:'alice',text:'你好，看看 ![测试图片](https://images.example.com/a.png)'})));assert.equal(images,0);await page.locator('.image-open').click();await page.locator('#image-viewer[open]').waitFor();await page.waitForFunction(()=>document.querySelector('#large-image').complete&&document.querySelector('#large-image').naturalWidth>0);assert.equal(images,1);assert.ok(await page.evaluate(()=>window.calls.some(c=>c.action==='expand'&&c.options.active===true)));await page.getByRole('button',{name:'关闭图片'}).click();
 await expireReply(page);
 const positions=new Set();for(let i=0;i<4;i++){await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'天气提醒',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('visible'));positions.add(await page.locator('#notice').getAttribute('style'));await page.locator('#notice').evaluate(el=>el.getAnimations().forEach(a=>a.finish()));await page.waitForFunction(()=>!document.querySelector('#notice').classList.contains('visible'));}assert.ok(positions.size>1);assert.match(await page.locator('#notice').textContent(),/上海.*21.*多云/);
 await page.evaluate(()=>window.events.forEach(fn=>fn({type:'settings',settings:window.preferences})));assert.equal(await page.locator('#speech').isVisible(),false,'expired replies stay hidden on settings polls');
 await page.evaluate(()=>window.events.forEach(fn=>fn({type:'settings',settings:{...window.preferences,showText:false}})));assert.equal(await page.locator('#speech').isVisible(),false);
 let finishWeather;weatherGate=new Promise(resolve=>finishWeather=resolve);const started=new Promise(resolve=>weatherStarted=resolve);await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'天气提醒',exact:true}).click();await started;await page.evaluate(()=>window.events.forEach(fn=>fn({type:'state',account:'alice',active:true,phase:'listening'})));finishWeather();await page.waitForResponse('**/companion/weather?*');await page.waitForTimeout(100);assert.equal(await page.locator('#notice').evaluate(el=>el.classList.contains('visible')),false,'late weather does not interrupt active voice');
 const releases=await page.evaluate(()=>window.calls.filter(c=>c.action==='release').length);account=null;await page.waitForFunction(()=>document.documentElement.dataset.account==='');assert.equal(await page.locator('#reply').textContent(),'');assert.equal(await page.locator('.image-open').count(),0);assert.deepEqual(errors,[]);
 await page.waitForFunction(count=>window.calls.filter(c=>c.action==='release').length>count,releases);
 await mkdir('test-results/companion',{recursive:true});await page.screenshot({path:'test-results/companion/widget-ui.png'});
});

test('widget adapts to screen anchors, preserves long text without a visible scrollbar and expires each reply',async t=>{
 const manifest=JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
 const server=http.createServer(async(req,res)=>{const asset=manifest.assets[new URL(req.url,'http://local').pathname];if(!asset){res.writeHead(404).end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:560,height:520},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));await trackReplyExpiry(page);
 await page.addInitScript(()=>{window.events=[];window.preferences={enabled:true,showText:true,reminders:true,nextReminderAt:Date.now()+999999};window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async(action)=>action==='settings'?window.preferences:action==='layout'?{x:525,y:475,width:560,height:520}:{} };});
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;return route.fulfill({json:p==='/api/auth/session'?{user:{username:'alice'}}:p==='/api/assistant/settings'?{name:'小鲸鱼',hasApiKey:true,model:'fixture'}:p.endsWith('/news')?{items:[{title:'一条真实来源的测试新闻'.repeat(25),url:'https://www.chinanews.com.cn/test-'+Math.random()+'.shtml',source:'中国新闻网',publishedAt:'2026-11-14T00:00:00Z'}]}:{enabled:false,quietEnabled:false}});});
 await page.goto('http://127.0.0.1:'+server.address().port+'/modules/assistant/companion.html');await page.waitForFunction(()=>document.documentElement.dataset.account==='alice');
 const center=await page.locator('#avatar').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});assert.deepEqual(center,{x:525,y:475},'native anchor determines avatar position');
 const emit=data=>page.evaluate(event=>window.events.forEach(fn=>fn(event)),data);
 await emit({type:'proactive',account:'alice',text:'你好'.repeat(500)});
 assert.equal(await page.locator('#speech').isVisible(),true);assert.equal(await page.locator('#notice').evaluate(el=>el.classList.contains('visible')),false,'one proactive message produces one bubble');
 for(const anchor of [{x:35,y:45},{x:525,y:45},{x:35,y:475},{x:525,y:475},{x:280,y:285}]){
   await emit({type:'layout',layout:{...anchor,width:560,height:520}});
   const r=await page.locator('#speech').boundingBox();assert.ok(r.x>=8&&r.y>=8&&r.x+r.width<=552&&r.y+r.height<=512,JSON.stringify({anchor,r}));
 }
 const body=page.locator('#speech-body');assert.ok(await body.evaluate(el=>el.scrollHeight>el.clientHeight));
 assert.equal(await body.evaluate(el=>getComputedStyle(el).overflowY),'auto');assert.equal(await body.evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');assert.equal(await page.locator('#speech-close').count(),0);
 await expireReply(page);
 await emit({type:'delta',account:'alice',text:'你好'.repeat(501)});await emit({type:'reply',account:'alice',text:'你好'.repeat(502)});await emit({type:'settings',settings:{enabled:true,showText:true,reminders:true}});
 assert.equal(await page.locator('#speech').isVisible(),false,'dismissal persists through final delta and settings polls');
 await emit({type:'proactive',account:'alice',text:'你好'.repeat(502)+'，今天有什么计划？'});assert.equal(await page.locator('#speech').isVisible(),true,'a new proactive reply opens even when it repeats the old prefix');await expireReply(page);
 await emit({type:'state',account:'alice',active:true,phase:'thinking'});await emit({type:'delta',account:'alice',text:'新一轮'});assert.equal(await page.locator('#speech').isVisible(),true);
 await emit({type:'state',account:'alice',active:false,phase:'off'});await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'新闻提醒',exact:true}).click();await page.waitForResponse('**/companion/news');assert.equal(await page.locator('#notice').evaluate(el=>el.classList.contains('visible')),false,'conversation text takes priority over reminders');
 await expireReply(page);await page.locator('#avatar').click({button:'right'});await page.getByRole('button',{name:'新闻提醒',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice').classList.contains('visible'));
 assert.equal(await page.locator('#notice button').count(),0);assert.deepEqual(errors,[]);
 await mkdir('test-results/companion-layout',{recursive:true});await page.screenshot({path:'test-results/companion-layout/bubbles.png'});
});
