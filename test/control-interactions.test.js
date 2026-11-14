import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {presencePolicyDefaults,presenceContext} from '../modules/assistant/public/presence-state.js';

async function fixture(t) {
 const manifest=JSON.parse(await readFile('modules/assistant/module.json','utf8'));
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local').pathname;
  if(url==='/controls') {res.setHeader('content-type','text/html');res.end('<html class="atb-contained-page"><head><style>body{margin:0}.settings{padding:20px}.settings label{display:block}.settings .check{display:flex;gap:8px}textarea,select,input{display:block}textarea{height:75px;width:300px;overflow:auto}.space{height:1400px}</style><link rel="stylesheet" href="/ui.css"><script type="module" src="/ui.js"></script></head><body class="atb-page-shell"><main class="atb-scroll-region settings"><label class="check"><input id="toggle" type="checkbox"><span>只点这里</span></label><div id="buttons"><button id="action">执行</button></div><label>多行<textarea id="text">短文字</textarea></label><label>选择<select id="select"><option>一</option><option>二</option></select></label><label>数字<input id="number" type="number" value="7"></label><div class="space"></div></main></body></html>');return;}
  const shared=['/ui.css','/ui.js','/ai-presets.js','/model-content.js'].includes(url);
  const file=shared?'public'+url:manifest.assets[url]?'modules/assistant/'+manifest.assets[url]:null;
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:1366,height:900}});return {page,origin:'http://127.0.0.1:'+server.address().port};
}
test('checkbox text is clickable but row whitespace and action row whitespace are inert',async t=>{
 const {page,origin}=await fixture(t);await page.goto(origin+'/controls');await page.waitForFunction(()=>document.body.classList.contains('atb-ready'));
 await page.locator('#toggle').locator('..').locator('span').click();assert.equal(await page.locator('#toggle').isChecked(),true);
 const r=await page.locator('#toggle').locator('..').boundingBox();await page.mouse.click(900,r.y+r.height/2);
 assert.equal(await page.locator('#toggle').isChecked(),true,'blank space after checkbox text must not toggle it');
 await page.evaluate(()=>{window.clicks=0;document.querySelector('#action').onclick=()=>window.clicks++;});
 const b=await page.locator('#buttons').boundingBox();await page.mouse.click(900,b.y+b.height/2);assert.equal(await page.evaluate(()=>window.clicks),0);
 await page.locator('#action').click();assert.equal(await page.evaluate(()=>window.clicks),1);
});
test('unfocused fields pass wheel to page while a focused textarea retains its own boundary',async t=>{
 const {page,origin}=await fixture(t);await page.goto(origin+'/controls');await page.waitForFunction(()=>document.body.classList.contains('atb-ready'));
 for(const id of ['text','select','number']) {
  await page.evaluate(()=>{document.activeElement.blur();document.querySelector('main').scrollTop=0;});
  await page.locator('#'+id).hover();await page.mouse.wheel(0,100);await page.waitForTimeout(70);
  assert.ok(await page.locator('main').evaluate(el=>el.scrollTop)>0,id+': hovering an unfocused field must scroll the page');
 }
 assert.equal(await page.locator('#number').inputValue(),'7');
 await page.locator('main').evaluate(el=>el.scrollTop=0);await page.locator('#text').fill(Array(50).fill('正文').join('\n'));
 await page.locator('#text').hover();const outer=await page.locator('main').evaluate(el=>el.scrollTop);
 await page.mouse.wheel(0,100);await page.waitForTimeout(70);assert.equal(await page.locator('main').evaluate(el=>el.scrollTop),outer);
 await page.locator('#text').evaluate(el=>el.scrollTop=el.scrollHeight);await page.mouse.wheel(0,500);await page.waitForTimeout(70);
 assert.equal(await page.locator('main').evaluate(el=>el.scrollTop),outer,'focused textarea boundary remains contained');
});
test('voice page has a fixed unified save bar, preserves drafts on refresh and reports partial save failure',async t=>{
 const {page,origin}=await fixture(t);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.nativeCalls=[];window.atbDesktop={hasModule:()=>true,invokeModule:async(id,handler,options)=>{window.nativeCalls.push(options.action);if(options.action==='status')return {text:'测试后台未运行',history:[]};if(options.action==='devices')return {devices:[{deviceId:'cam-a',name:'测试镜头A',online:true},{deviceId:'cam-b',name:'测试镜头B',online:true}]};return {};}};navigator.mediaDevices.enumerateDevices=async()=>[{kind:'audiooutput',deviceId:'out-a',label:'测试输出A'},{kind:'audiooutput',deviceId:'out-b',label:'测试输出B'}];navigator.mediaDevices.getUserMedia=async()=>{throw Error('must not open microphone');};});
 let voice={enabled:false,provider:'qwen3tts',voice:'qwen3tts:serena',rate:0,volume:0,pitch:0,silenceMs:1000,autoListen:false,voiceCatalog:[{id:'qwen3tts:serena',name:'Serena',locale:'zh-CN'}]};
 let presence={...presencePolicyDefaults(),enabled:false,cameraId:'cam-a',outputId:'out-a',followUp:false,greeting:'你好，{name}',people:[],name:'测试称呼'};
 const writes=[];let failPresence=false, holdPresence=false, releasePresence;
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()).pathname;let value={};
  if(url==='/api/auth/session')value={user:{username:'fixture',role:'admin'}};
  else if(url==='/api/assistant/settings')value={name:'测试助手',prompt:'',model:'fixture',selectedModels:['fixture'],hasApiKey:true,apiSource:'platform'};
  else if(url==='/api/assistant/voice/status')value={available:false,synthesisAvailable:true,settings:voice};
  else if(url==='/api/assistant/voice/catalog')value={voices:voice.voiceCatalog};
  else if(url==='/api/assistant/voice/settings'){writes.push('voice');voice={...voice,...req.postDataJSON()};value=voice;}
  else if(url==='/api/assistant/presence'){
   if(req.method()==='POST'){const body=req.postDataJSON();writes.push(body.action);if(body.action==='settings'){if(holdPresence)await new Promise(r=>{releasePresence=r;});if(failPresence){await route.fulfill({status:500,json:{error:'模拟问候保存失败'}});return;}presence={...presence,...body};}if(body.action==='feedback')presence.feedback={state:body.state,date:presenceContext(presence).date};}value=presence;
  }else if(url.endsWith('/balance'))value={kind:'unconfigured'};
  else if(url==='/api/assistant/opportunity')value={todayCount:0,chatCount:0,outcomes:[]};
  else if(url==='/api/assistant/memory')value={version:2,core:[],light:[]};
  await route.fulfill({json:value});
 });
 await page.goto(origin+'/modules/assistant/#voice');await page.locator('#workspace').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-camera]').value==='cam-a');
 assert.equal(await page.locator('#voice-actions').isVisible(),true,'voice actions are always visible on this page');
 assert.equal(await page.locator('#voice-actions button[type=submit]').count(),1);
 assert.equal(await page.locator('#page-voice [data-save]').count(),0,'remove duplicate presence save');
 assert.equal(await page.getByRole('button',{name:'去语音对话',exact:true}).count(),0);
 for(const width of [1366,390]){
  await page.setViewportSize({width,height:800});const before=await page.locator('#voice-actions').boundingBox();
  await page.locator('main').evaluate(el=>el.scrollTop=el.scrollHeight);const after=await page.locator('#voice-actions').boundingBox();
  assert.equal(after.y,before.y);assert.ok(Math.abs(after.y+after.height-800)<2,'bar sits at viewport bottom');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir('test-results/controls',{recursive:true});await page.screenshot({path:'test-results/controls/voice-'+width+'.png'});
 }
 await page.setViewportSize({width:1366,height:900});
 const caption=page.locator('#voice-enabled').locator('..');await caption.click();assert.equal(await page.locator('#voice-enabled').isChecked(),true);
 const hit=await caption.boundingBox();await page.mouse.click(hit.x+hit.width+30,hit.y+hit.height/2);assert.equal(await page.locator('#voice-enabled').isChecked(),true,'real voice checkbox ignores row whitespace');await page.locator('#voice-enabled').uncheck();
 await page.locator('#voice-provider').selectOption('volcengine');
 const method=page.locator('.tts-method-option').first();await method.scrollIntoViewIfNeeded();await method.locator('.tts-method-fee').click();assert.equal(await method.locator('input').isChecked(),false,'price caption is not a radio hit target');
 const radioLabel=await method.locator('label').boundingBox(),row=await method.boundingBox();await page.mouse.click(radioLabel.x+radioLabel.width+10,row.y+row.height/2);assert.equal(await method.locator('input').isChecked(),false,'radio row whitespace is inert');await method.locator('label').click();assert.equal(await method.locator('input').isChecked(),true);
 await page.locator('#voice-provider').selectOption('qwen3tts');await page.waitForFunction(()=>document.querySelector('#voice-name').options.length>0);
 await page.locator('#voice-rate').fill('15');await page.locator('[data-greeting]').fill('回来啦，{name}');
 await page.locator('[data-camera]').selectOption('cam-b');await page.locator('[data-output]').selectOption('out-b');await page.locator('[data-feedback]').selectOption('good');assert.match(await page.locator('[data-preview]').textContent(),/精神不错/,'preview includes the unsaved daily feedback');
 await page.locator('[data-refresh]').click();assert.equal(await page.locator('[data-camera]').inputValue(),'cam-b');assert.equal(await page.locator('[data-output]').inputValue(),'out-b');assert.equal(await page.locator('[data-greeting]').inputValue(),'回来啦，{name}');
 assert.equal(await page.evaluate(()=>window.atbHasUnsavedChanges()),true);
 await page.locator('#voice-save').click();await page.waitForFunction(()=>document.querySelector('#voice-result').textContent==='全部语音设置已保存');
 assert.equal(voice.rate,15);assert.equal(presence.greeting,'回来啦，{name}');assert.equal(presence.cameraId,'cam-b');assert.equal(presence.outputId,'out-b');assert.equal(presence.feedback.state,'good');assert.equal(await page.evaluate(()=>window.atbHasUnsavedChanges()),false);
 const prior=writes.length;await page.locator('[data-timezone]').fill('not/a/timezone');await page.locator('#voice-save').click();await page.waitForTimeout(100);assert.equal(writes.length,prior,'validate both sections before saving either');
 await page.locator('[data-timezone]').fill('Asia/Shanghai');await page.locator('[data-greeting]').fill('新的问候');failPresence=true;await page.locator('#voice-save').click();await page.waitForFunction(()=>document.querySelector('#voice-result').textContent.includes('问候未保存'));assert.equal(await page.evaluate(()=>window.atbHasUnsavedChanges()),true);
 failPresence=false;await page.locator('#voice-save').click();await page.waitForFunction(()=>document.querySelector('#voice-result').textContent==='全部语音设置已保存');
 holdPresence=true;await page.locator('[data-greeting]').fill('准备保存的问候');await page.locator('#voice-save').click();
 const deadline=Date.now()+5000;while(!releasePresence&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(releasePresence,'save reached presence persistence');
 await page.locator('[data-greeting]').fill('保存期间的新修改');holdPresence=false;releasePresence();
 await page.waitForFunction(()=>document.querySelector('#voice-result').textContent==='已保存，新的修改尚未保存');assert.equal(await page.locator('[data-greeting]').inputValue(),'保存期间的新修改');assert.equal(await page.evaluate(()=>window.atbHasUnsavedChanges()),true);
 await page.locator('#voice-save').click();await page.waitForFunction(()=>document.querySelector('#voice-result').textContent==='全部语音设置已保存');
 await page.locator('[data-page=assistant]').click();assert.equal(await page.locator('#voice-actions').isVisible(),false);assert.deepEqual(errors,[]);
});
