import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startServers } from '../../../server/index.js';
import { SESSION_COOKIE } from '../../../server/accounts.js';

test('voice settings save custom wake phrases with the unified save button and default follows persona name', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wake-settings-'));
  const server = await startServers({ lanIp:'127.0.0.1', httpsPort:0, httpPort:0, relayPort:0, publicOrigin:null, dataDir:path.join(directory,'data'), certDir:path.join(directory,'certs') });
  let browser; t.after(async () => { await browser?.close(); await server.close(); await rm(directory, { recursive:true, force:true }); });
  await server.accounts.setup('wake-test', 'fixture-password'); const session = await server.accounts.login('wake-test', 'fixture-password');
  browser = await chromium.launch(); const context = await browser.newContext({ ignoreHTTPSErrors:true });
  await context.addCookies([{ name:SESSION_COOKIE, value:session.token, domain:'127.0.0.1', path:'/', secure:true, httpOnly:true, sameSite:'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  await page.goto(`https://127.0.0.1:${server.secure.address().port}/modules/assistant/#voice`);
  await page.locator('#workspace').waitFor();
  await page.locator('#wake-enabled').waitFor();
  assert.equal(await page.locator('#wake-enabled').isChecked(), true);
  await page.locator('#wake-phrases').fill('小金鱼\n你好助手');
  assert.equal(await page.locator('#voice-state').textContent(), '未保存');
  await page.locator('#voice-save').click(); await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  const saved = JSON.parse(await readFile(path.join(directory,'data','assistant','voice-settings.json'),'utf8'));
  assert.deepEqual(saved.wakePhrases, ['小金鱼', '你好助手']);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#wake-phrases')?.value === '小金鱼\n你好助手');
  await page.locator('[data-page=assistant]').click(); await page.locator('#persona-form').evaluate(el=>el.closest('details').open=true); await page.locator('#name').fill('小海豚');
  await page.locator('#persona-form [type=submit]').click(); await page.waitForFunction(() => document.querySelector('#assistant-name').textContent === '小海豚');
  await page.locator('[data-page=voice]').click(); assert.equal(await page.locator('#wake-default').textContent(), '小海豚');
  await page.locator('#wake-enabled').uncheck(); await page.locator('#voice-save').click(); await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  await page.reload(); await page.waitForFunction(() => document.querySelector('#wake-enabled') && !document.querySelector('#wake-enabled').checked);
  for (const width of [390,1366]) { await page.setViewportSize({ width, height:900 }); await page.locator('#wake-section').scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await mkdir('test-results/wake',{recursive:true}); await page.screenshot({path:`test-results/wake/settings-${width}.png`}); }
});

test('widget wakes locally, sends trailing request once and suspends capture during foreground activity, hide and logout', async t => {
  const root = path.resolve(import.meta.dirname,'..'), manifest = JSON.parse(await readFile(path.join(root,'module.json'),'utf8'));
  const server = http.createServer(async (req,res) => { const asset = manifest.assets[new URL(req.url,'http://local').pathname]; if(!asset){res.writeHead(404).end();return;} res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset))); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const browser = await chromium.launch(); t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page = await browser.newPage({viewport:{width:560,height:520}}), errors = [], requests = [], preparations = [];
  page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.events=[]; window.calls=[]; window.mics=0; window.stopped=0; window.asrText=''; window.loggedIn=true; window.audioDelay=20;
    window.config={name:'小鲸鱼',hasApiKey:true,model:'fixture'}; window.preferences={enabled:true,showText:true,reminders:false}; window.wakeOptions={enabled:true,wakeEnabled:true,wakePhrases:['你好助手']};
    navigator.mediaDevices.getUserMedia=async()=>{window.mics++;return{getTracks:()=>[{stop(){window.stopped++;}}]};};
    window.AudioContext=class{sampleRate=16000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}createMediaElementSource(){return{connect(){}};}};
    window.AudioWorkletNode=class{constructor(){window.capture=this;this.port={close(){}};}connect(){}disconnect(){}};
    window.Audio=class{play(){this.onplaying?.();setTimeout(()=>this.onended?.(),window.audioDelay);return Promise.resolve();}pause(){}removeAttribute(){}load(){}};
    window.atbCompanion={onEvent:fn=>window.events.push(fn),call:async(action,options)=>{
      window.calls.push({action,options}); if(action==='settings')return window.preferences;
      if(action==='voice'){if(options.action==='prepare')return{prepared:true};if(options.action==='wakeSettings')return window.wakeOptions;if(options.action==='wakeOpen'||options.action==='open')return{leaseId:options.leaseId};if(options.action==='transcribe')return{text:window.asrText};if(options.action==='status')return{available:true,synthesisAvailable:true,settings:{enabled:true,provider:'qwen3tts',autoListen:true,silenceMs:600}};if(options.action==='speak')return{mime:'audio/wav',audio:'UklGRg=='};} return{};
    }};
    window.utterance=text=>{window.asrText=text;for(let i=0;i<4;i++)window.capture.port.onmessage({data:new Float32Array(1600).fill(.15).buffer});for(let i=0;i<7;i++)window.capture.port.onmessage({data:new Float32Array(1600).buffer});};
  });
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/assistant/wake-replies'){const name=await page.evaluate(()=>window.config.name);preparations.push(name);if(name==='未准备角色'){await route.fulfill({status:503,json:{error:'fixture-unavailable'}});return;}await route.fulfill({json:{replies:name==='小鲸鱼'?['在呢，白饭呢','嗯，你说呀','来了来了']:['在听，请说','嗯，我在']}});return;}
    if(pathname==='/api/assistant/chat'){requests.push(route.request().postDataJSON());await route.fulfill({json:{reply:'现在24度。'}});return;}
    const value=await page.evaluate(path=>path==='/api/auth/session'?{user:window.loggedIn?{username:'alice'}:null}:path==='/api/assistant/settings'?window.config:{enabled:false,quietEnabled:false},pathname);
    await route.fulfill({json:value});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/modules/assistant/companion.html`);
  await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='true');
  assert.equal(await page.evaluate(()=>window.mics),1);assert.match(await page.locator('#avatar').getAttribute('title'),/等待唤醒.*小鲸鱼/);
  await page.evaluate(()=>window.utterance('今天吃什么'));await page.waitForTimeout(120);assert.equal(requests.length,0);
  await page.evaluate(()=>window.utterance('小鲸鱼，今天24度吗？'));
  await page.waitForFunction(()=>document.querySelector('#companion').dataset.phase==='listening');
  assert.equal(requests.length,1);assert.equal(requests[0].messages.at(-1).content,'今天24度吗？');
  const spoken=await page.evaluate(()=>window.calls.filter(item=>item.action==='voice'&&item.options.action==='speak').map(item=>item.options.text));
  assert.ok(['在呢，白饭呢','嗯，你说呀','来了来了'].includes(spoken[0]),'wake acknowledgement follows the prepared persona');
  assert.equal(spoken[1],'现在24度。');assert.deepEqual(preparations,['小鲸鱼']);
  assert.equal(await page.evaluate(()=>window.stopped),1,'wake microphone released before conversation');
  await page.locator('#avatar').click();await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='true');
  await page.evaluate(()=>{window.events.forEach(fn=>fn({type:'suspend-wake'}));window.events.forEach(fn=>fn({type:'state',account:'alice',active:true,phase:'speaking'}));});
  await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='false');const mics=await page.evaluate(()=>window.mics);await page.waitForTimeout(3200);assert.equal(await page.evaluate(()=>window.mics),mics);
  await page.evaluate(()=>{window.config.name='小海豚';window.events.forEach(fn=>fn({type:'state',account:'alice',active:false,phase:'off'}));});
  await page.waitForFunction(()=>document.querySelector('#avatar').title.includes('等待唤醒：小海豚'));
  await page.evaluate(()=>window.utterance('小鲸鱼'));await page.waitForTimeout(120);assert.equal(requests.length,1);
  await page.evaluate(()=>window.utterance('你好助手'));await page.waitForFunction(()=>document.querySelector('#companion').dataset.phase==='listening');assert.equal(requests.length,1,'phrase alone starts listening without invented request');
  const firstReply=await page.evaluate(()=>window.calls.filter(item=>item.options?.action==='speak').at(-1).options.text);
  assert.ok(['在听，请说','嗯，我在'].includes(firstReply),'new role must not use the old role response pool');assert.deepEqual(preparations,['小鲸鱼','小海豚']);
  await page.locator('#avatar').click();await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='true');
  await page.evaluate(()=>window.utterance('你好助手'));await page.waitForFunction(()=>document.querySelector('#companion').dataset.phase==='listening');
  assert.notEqual(await page.evaluate(()=>window.calls.filter(item=>item.options?.action==='speak').at(-1).options.text),firstReply,'avoid repeating the last acknowledgement');
  assert.equal(preparations.length,2,'do not call the model for every wake');
  await page.locator('#avatar').click();await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='true');
  const beforeManual=await page.evaluate(()=>window.calls.filter(item=>item.options?.action==='speak').length);
  await page.locator('#avatar').click();await page.waitForFunction(()=>document.querySelector('#companion').dataset.phase==='listening');
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.options?.action==='speak').length),beforeManual,'manual clicks do not add a wake greeting');
  await page.locator('#avatar').click();await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='true');
  await page.evaluate(()=>{window.audioDelay=2000;window.utterance('你好助手');});await page.waitForFunction(()=>document.querySelector('#companion').dataset.phase==='speaking');
  const beforeHide=await page.evaluate(()=>window.mics);
  await page.evaluate(()=>{window.preferences.enabled=false;window.events.forEach(fn=>fn({type:'settings',settings:window.preferences}));});await page.waitForFunction(()=>window.stopped===window.mics);
  await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.mics),beforeHide,'hiding while acknowledging must not open a late conversation microphone');
  await page.evaluate(()=>{window.config.name='未准备角色';window.audioDelay=20;window.preferences.enabled=true;window.events.forEach(fn=>fn({type:'settings',settings:window.preferences}));});await page.waitForFunction(()=>document.querySelector('#companion').dataset.wake==='true');
  await page.evaluate(()=>window.utterance('你好助手'));await page.waitForFunction(()=>document.querySelector('#companion').dataset.phase==='listening');
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.options?.action==='speak').at(-1).options.text),'我在，你说。','failed preparation falls back to an audible neutral acknowledgement');
  assert.equal(requests.length,1);await page.waitForTimeout(3200);assert.deepEqual(preparations,['小鲸鱼','小海豚','未准备角色'],'failed preparation does not retry each poll');
  await page.evaluate(()=>{window.loggedIn=false;window.events.forEach(fn=>fn({type:'reset',account:'alice'}));});await page.waitForFunction(()=>window.stopped===window.mics);assert.deepEqual(errors,[]);
});
