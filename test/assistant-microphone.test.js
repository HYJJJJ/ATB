import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServers } from '../server/index.js';
import { SESSION_COOKIE } from '../server/accounts.js';

test('microphone orb toggles conversation, supports keyboard and cancels a pending start', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-microphone-'));
  const server = await startServers({lanIp:'127.0.0.1',httpsPort:0,httpPort:0,relayPort:0,publicOrigin:null,dataDir:path.join(directory,'data'),certDir:path.join(directory,'certs')});
  let browser;
  t.after(async()=>{await browser?.close();await server.close();await rm(directory,{recursive:true,force:true});});
  await server.accounts.setup('mic-test','local-test-only');
  const session=await server.accounts.login('mic-test','local-test-only');
  browser=await chromium.launch(); const context=await browser.newContext({ignoreHTTPSErrors:true});
  await context.addCookies([{name:SESSION_COOKIE,value:session.token,domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(), errors=[], closes=[];let opens=0,available=true,holdOpen=false,releaseOpen;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.micRequests=0;window.micStops=0;window.denyMic=false;
    navigator.mediaDevices.getUserMedia=async()=>{window.micRequests++;if(window.denyMic)throw new DOMException('denied','NotAllowedError');return{getTracks:()=>[{stop:()=>window.micStops++}]};};
    window.AudioContext=class{constructor(){this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};this.destination={};}async resume(){}async close(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}};
    window.AudioWorkletNode=class{constructor(){this.port={close(){}};}connect(){}disconnect(){}};
  });
  const settings={enabled:true,provider:'qwen3tts',voice:'qwen3tts:serena',rate:0,volume:0,autoListen:true};
  await page.route('**/api/assistant/settings',route=>route.fulfill({json:{name:'助手',hasApiKey:true,model:'fixture',selectedModels:['fixture'],contextTurns:3}}));
  await page.route('**/api/assistant/voice/**',async route=>{
    const action=new URL(route.request().url()).pathname.split('/').at(-1);
    let value={};
    if(action==='status')value={available,synthesisAvailable:true,settings};
    else if(action==='open'){opens++;if(holdOpen)await new Promise(resolve=>releaseOpen=resolve);value={leaseId:route.request().postDataJSON().leaseId};}
    else if(action==='close')closes.push(route.request().postDataJSON());
    await route.fulfill({json:value});
  });
  await page.goto('https://127.0.0.1:'+server.secure.address().port+'/modules/assistant/');await page.locator('#workspace').waitFor({state:'visible'});
  const orb=page.locator('#voice-orb');
  assert.equal(await orb.evaluate(el=>el.tagName),'BUTTON');
  await orb.waitFor();await page.waitForFunction(()=>!document.querySelector('#voice-orb').disabled);
  assert.equal(await orb.getAttribute('aria-pressed'),'false');
  await orb.click();await page.waitForFunction(()=>document.querySelector('#voice-live').dataset.phase==='listening');
  assert.equal(await orb.getAttribute('aria-pressed'),'true');assert.equal(await orb.getAttribute('aria-label'),'关闭语音对话');
  await orb.click();await page.waitForFunction(()=>document.querySelector('#voice-orb').getAttribute('aria-pressed')==='false');
  assert.equal(await page.evaluate(()=>window.micStops),1);assert.ok(closes.at(-1).keepWarm);
  await orb.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#voice-live').dataset.phase==='listening');
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#voice-orb').getAttribute('aria-pressed')==='false');
  assert.equal(await page.evaluate(()=>window.micRequests),2);assert.equal(await page.evaluate(()=>window.micStops),2);
  holdOpen=true;await orb.click();await page.waitForFunction(()=>document.querySelector('#voice-orb').getAttribute('aria-pressed')==='true');
  while(!releaseOpen)await new Promise(resolve=>setTimeout(resolve,10));
  await orb.click();await page.waitForFunction(()=>document.querySelector('#voice-orb').getAttribute('aria-pressed')==='false');
  releaseOpen();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.micRequests),2,'cancelled loading never opens a microphone late');
  holdOpen=false;await page.evaluate(()=>window.denyMic=true);await orb.click();
  await page.waitForFunction(()=>document.querySelector('#chat-error').textContent.includes('麦克风权限'));
  assert.equal(await orb.getAttribute('aria-pressed'),'false');assert.equal(await orb.isEnabled(),true);
  available=false;await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await orb.isDisabled(),true);
  assert.equal(opens,4);assert.deepEqual(errors,[]);
});
