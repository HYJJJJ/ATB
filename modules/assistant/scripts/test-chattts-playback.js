import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium, _electron as electron } from 'playwright';
import {createRequire} from 'node:module';
import { startServers } from '../../../server/index.js';
import { SESSION_COOKIE } from '../../../server/accounts.js';
import { getVoiceRuntime } from '../server/voice-runtime.js';

const reported=process.argv.includes('--reported');
const ranked=reported || process.argv.includes('--ranked');
const desktop=process.argv.includes('--desktop'),seed=process.argv.includes('--short')?'42':'987654321';
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test(`real ChatTTS whole-text playback and seed persistence (${desktop?'desktop IPC':'web HTTP'})`, async t => {
 await mkdir('test-results/chattts-diagnosis',{recursive:true});
 const directory=await mkdtemp(path.join(tmpdir(),'chattts-preview-')),dataDir=path.join(directory,'data'),assistant=path.join(dataDir,'assistant');
 await mkdir(assistant,{recursive:true});
 for(const name of ['models','tts-runtime','voice-runtime'])await symlink(path.resolve('data/assistant',name),path.join(assistant,name),'junction');
 const runtime=getVoiceRuntime(assistant);await runtime.configure({provider:'chattts',voice:'chattts:42'});
 const server=await startServers({lanIp:'127.0.0.1',httpsPort:0,httpPort:0,relayPort:0,publicOrigin:null,dataDir,certDir:path.join(directory,'certs')});let browser,app;
 t.after(async()=>{await browser?.close();if(app)await app.close();await server.close();for(const name of ['models','tts-runtime','voice-runtime'])await unlink(path.join(assistant,name));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
 await server.accounts.setup('voice-test','fixture-password');const session=await server.accounts.login('voice-test','fixture-password');
 let context,page;
 if(desktop){
  const httpsPort=await freePort(),httpPort=await freePort();
  const env={...process.env,ATB_DATA_DIR:directory,FREECAMERA_DATA_DIR:directory,LAN_IP:'127.0.0.1',HTTPS_PORT:String(httpsPort),HTTP_PORT:String(httpPort),TURN_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('.'),'--mute-audio'],env});page=await app.firstWindow();await page.waitForURL('**/platform');context=page.context();
 }else{browser=await chromium.launch({args:['--mute-audio']});context=await browser.newContext({ignoreHTTPSErrors:true});page=await context.newPage();}
 await context.addCookies([{name:SESSION_COOKIE,value:session.token,domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
 page.setDefaultTimeout(120000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.testChunks=[];window.testEnded=0;window.testStages=[];
  const start=AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start=function(...args){window.testChunks.push(Array.from(this.buffer.getChannelData(0)));this.addEventListener('ended',()=>window.testEnded++);return start.apply(this,args);};
  new MutationObserver(()=>{const state=document.querySelector('#voice-result')?.textContent;if(state && window.testStages.at(-1)?.state!==state)window.testStages.push({state,ms:Math.round(performance.now())});}).observe(document,{subtree:true,childList:true,characterData:true});
 });
 const origin=desktop?new URL(page.url()).origin:`https://127.0.0.1:${server.secure.address().port}`;
 await page.goto(`${origin}/modules/assistant/#voice`);await page.locator('#workspace').waitFor();
 await page.waitForFunction(()=>document.querySelector('#voice-name').value==='chattts:42');
 const voice=ranked?'chattts:speaker:seed_'+(reported?'1244':'2155'):'chattts:'+seed;
 if(ranked)await page.locator('#voice-name').selectOption(voice,{force:true});else { await page.locator('#chattts-seed-toggle').click(); await page.locator('#chattts-seed').fill(seed); }
 assert.equal(await page.locator('#voice-name').inputValue(),voice,'editing the seed must immediately select it without a second apply step');
 assert.equal(await page.locator('#voice-state').textContent(),'未保存');assert.equal(await page.locator('#voice-preview').isDisabled(),true);
 await page.locator('#voice-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#voice-state').textContent==='已保存');
 const text=process.argv.includes('--short')?'你好，我是你的助手，有什么可以帮你？':'今天我们一起检查语音播放是否完整。先把第一句话说完，再继续说第二句话。最后请记住这句结束语，祝你今天一切顺利，再见。';
 await page.locator('#voice-preview-text').fill(text);await page.locator('#voice-preview').click();
 await page.waitForFunction(()=>document.querySelector('#voice-result').textContent==='试听播放完成');
 const capture=await page.evaluate(()=>({chunks:window.testChunks,ended:window.testEnded,stages:window.testStages}));
 assert.ok(capture.chunks.length);assert.equal(capture.ended,capture.chunks.length,'completion must await the final scheduled PCM buffer');
 const padding=capture.chunks.filter(chunk=>chunk.length===5280 && chunk.every(sample=>sample===0));
 assert.equal(padding.length,1,'only the complete utterance gets a 220ms ending pause');
 assert.equal(capture.chunks.at(-1),padding[0],'the ending pause follows all speech');
 const release=capture.chunks.at(-2);assert.equal(release.length,192);assert.equal(release.at(-1),0,'the final 8ms release ends at zero');
 const speech=capture.chunks.slice(0,-1).flat();
 const rms=values=>Math.sqrt(values.reduce((total,v)=>total+v*v,0)/values.length);
 assert.ok(rms(speech.slice(-1440))/rms(speech)<.1,'the generated final syllable must decay before playback padding');
 const samples=capture.chunks.flat(),pcm=Buffer.alloc(samples.length*2);samples.forEach((v,i)=>pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v*32768))),i*2));
 const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
 await writeFile(`test-results/chattts-diagnosis/${desktop?'desktop':'browser'}${ranked?'-ranked':''}${reported?'-1244':''}-scheduled.wav`,Buffer.concat([header,pcm]));
 await writeFile(`test-results/chattts-diagnosis/${desktop?'desktop':'browser'}${ranked?'-ranked':''}${reported?'-1244':''}-stages.json`,JSON.stringify({text,voice,seed:await page.locator('#chattts-seed').inputValue(),chunks:capture.chunks.length,ended:capture.ended,stages:capture.stages},null,2));
 const status = () => page.evaluate(async()=>window.atbDesktop?.hasModule('assistant')?window.atbDesktop.invokeModule('assistant','voice',{action:'status'}):(await fetch('/api/assistant/voice/status')).json());
 const first = await status(); assert.equal(first.modelLoaded,true); assert.ok(first.pid);
 await page.locator('#voice-preview').click();
 await page.waitForFunction(previous=>window.testEnded>previous && document.querySelector('#voice-result').textContent==='试听播放完成',capture.ended);
 const second = await status(); assert.equal(second.pid,first.pid,'independent PCM previews retain the model');
 const counts=await page.evaluate(()=>({chunks:window.testChunks.length,ended:window.testEnded}));assert.equal(counts.chunks,counts.ended);
 console.log('CHAT_RESIDENCY_PASS',JSON.stringify({pid:first.pid,...counts}));
 assert.equal(await page.locator('#voice-name').inputValue(),voice);assert.deepEqual(errors,[]);
 console.log(desktop?'REAL_CHAT_DESKTOP_PASS':'REAL_CHAT_PLAYBACK_PASS',JSON.stringify({chunks:capture.chunks.length,ended:capture.ended,duration:pcm.length/48000,voice,seed:await page.locator('#chattts-seed').inputValue()}));
});
