import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {startServers} from '../../../server/index.js';
import {SESSION_COOKIE} from '../../../server/accounts.js';

for (const widget of [false,true]) test(`${widget?'widget':'main page'} excludes a failed streamed search and recovers on the next turn`,async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'atb-chat-recovery-'));
  const server=await startServers({lanIp:'127.0.0.1',httpsPort:0,httpPort:0,relayPort:0,publicOrigin:null,dataDir:path.join(dir,'data'),certDir:path.join(dir,'certs')});
  let browser;
  t.after(async()=>{await browser?.close();await server.close();await rm(dir,{recursive:true,force:true});});
  await server.accounts.setup('recovery-test','fixture-password');const session=await server.accounts.login('recovery-test','fixture-password');
  browser=await chromium.launch();const context=await browser.newContext({ignoreHTTPSErrors:true});
  await context.addCookies([{name:SESSION_COOKIE,value:session.token,domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(),origin='https://127.0.0.1:'+server.secure.address().port;
  const setup=await context.request.post(origin+'/api/assistant/settings',{headers:{origin},data:{scope:'all',name:'测试助手',prompt:'测试角色',memory:'',memoryMode:'off',provider:'custom',baseUrl:'https://fixture.example/v1',model:'fixture',apiKey:'fixture-key'}});assert.equal(setup.status(),200);
  const script=widget?'companion.js':'assistant.js';
  // workspace becomes visible before initial settings/history finish loading.
  // Wait for the production initialization task before calling its private send.
  const ready=widget?'Boolean(account&&!pollBusy)':'Boolean(user&&config&&!sessionTask)';
  await page.route('**/'+script,async route=>route.fulfill({contentType:'text/javascript',body:await readFile(path.resolve('modules/assistant/public',script),'utf8')+'\nwindow.testSend=sendMessage;window.testReady=()=>'+ready+';'}));
  if(widget)await page.addInitScript(()=>{window.atbCompanion={onEvent(){},call:async action=>action==='settings'?{enabled:true,showText:true,reminders:false}:{}};});
  const submitted=[];
  await page.route('**/api/assistant/chat',async route=>{
    submitted.push(route.request().postDataJSON());
    const events=submitted.length===1?[{type:'delta',text:'我先查一下。'},{type:'error',error:'模拟搜索后模型连接中断'}]:[{type:'delta',text:'午饭吃面吧。'},{type:'done',reply:'午饭吃面吧。'}];
    await route.fulfill({contentType:'application/x-ndjson',body:events.map(event=>JSON.stringify(event)+'\n').join('')});
  });
  await page.goto(origin+'/modules/assistant/'+(widget?'companion.html':'#assistant'));
  await page.waitForFunction(widget?()=>document.documentElement.dataset.account==='recovery-test'&&window.testSend:()=>!document.querySelector('#workspace').hidden&&window.testSend);
  await page.waitForFunction(()=>window.testReady());
  const send=text=>page.evaluate(async text=>{try{return await window.testSend(text,{onDelta(){}});}catch(error){return {error:error.message};}},text);
  await send('失败的搜索请求');
  if(!widget) {
    assert.doesNotMatch(await page.locator('#messages').textContent(),/我先查一下/,'incomplete speech is removed from visible history');
    assert.match(await page.locator('#messages').textContent(),/本次未完成：模拟搜索后模型连接中断/);
    const stored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('homebase.chat.recovery-test')));
    assert.equal(stored[0].status,'failed','failure state survives page reload');
    assert.equal(stored[1].status,'failed','the visible failure is not a completed assistant answer');
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#workspace').hidden&&window.testSend);
    await page.waitForFunction(()=>window.testReady());
  } else assert.equal(await page.locator('#reply').textContent(),'','failed partial reply must be cleared');
  assert.equal(await send('午饭吃什么'),'午饭吃面吧。');
  assert.deepEqual(submitted[1].messages,[{role:'user',content:'午饭吃什么'}]);
  await send('再聊两句');
  assert.deepEqual(submitted[2].messages,[{role:'user',content:'午饭吃什么'},{role:'assistant',content:'午饭吃面吧。'},{role:'user',content:'再聊两句'}]);
});
