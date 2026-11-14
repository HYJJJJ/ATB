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

const desktop=process.argv.includes('--desktop'), pcmMode=!process.argv.includes('--wav');
const speaker=process.argv.find(arg=>arg.startsWith('--speaker='))?.slice(10)||'serena';
assert.ok(/^(serena|vivian|uncle_fu|dylan|eric|ryan|aiden|ono_anna|sohee)$/.test(speaker));
const voice=`qwen3tts:${speaker}`, evidence=path.resolve(process.argv.find(arg=>arg.startsWith('--evidence='))?.slice(11)||'test-results/qwen-diagnosis');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test(`real Qwen short-clause preview, completion and resource release (${desktop?'desktop IPC':'web HTTP'})`, async t => {
 await mkdir(evidence,{recursive:true});
 const directory=await mkdtemp(path.join(tmpdir(),'qwen-preview-')),dataDir=path.join(directory,'data'),assistant=path.join(dataDir,'assistant');
 await mkdir(assistant,{recursive:true});
 for(const name of ['models','tts-runtime','qwen-tts-runtime','voice-runtime'])await symlink(path.resolve('data/assistant',name),path.join(assistant,name),'junction');
 const runtime=getVoiceRuntime(assistant);await runtime.configure({provider:'qwen3tts',voice,rate:pcmMode?0:15});
 const server=await startServers({lanIp:'127.0.0.1',httpsPort:0,httpPort:0,relayPort:0,publicOrigin:null,dataDir,certDir:path.join(directory,'certs')});let browser,app;
 t.after(async()=>{await browser?.close();if(app)await app.close();await server.close();for(const name of ['models','tts-runtime','qwen-tts-runtime','voice-runtime'])await unlink(path.join(assistant,name));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
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
  window.testWaves=[];window.testStarted=0;window.testEnded=0;window.testStages=[];window.testPcm=[];window.testPcmEnded=0;window.testPcmTimeline=[];
  const start=AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start=function(...args){window.testPcm.push(Array.from(this.buffer.getChannelData(0)));window.testPcmTimeline.push({at:args[0]??this.context.currentTime,duration:this.buffer.duration,now:this.context.currentTime});this.addEventListener('ended',()=>window.testPcmEnded++);return start.apply(this,args);};
  const create=URL.createObjectURL;
  URL.createObjectURL=function(blob){if(blob.type==='audio/wav')window.testWaves.push(blob.arrayBuffer().then(buffer=>Array.from(new Uint8Array(buffer))));return create.call(this,blob);};
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(...args){this.addEventListener('playing',()=>window.testStarted++,{once:true});this.addEventListener('ended',()=>window.testEnded++,{once:true});return play.apply(this,args);};
  new MutationObserver(()=>{const state=document.querySelector('#voice-result')?.textContent;if(state && window.testStages.at(-1)?.state!==state)window.testStages.push({state,ms:Math.round(performance.now())});}).observe(document,{subtree:true,childList:true,characterData:true});
 });
 const origin=desktop?new URL(page.url()).origin:`https://127.0.0.1:${server.secure.address().port}`;
 await page.goto(`${origin}/modules/assistant/#voice`);await page.locator('#workspace').waitFor();
 await page.waitForFunction(voice=>document.querySelector('#voice-name').value===voice,voice);
 const text='你好，我是你的助手，有什么可以帮你？';
 await page.locator('#voice-preview-text').fill(text);await page.locator('#voice-preview').click();
 await page.waitForFunction(()=>document.querySelector('#voice-result').textContent==='试听播放完成');
 const capture=await page.evaluate(async()=>({waves:await Promise.all(window.testWaves),started:window.testStarted,ended:window.testEnded,stages:window.testStages,pcm:window.testPcm,pcmEnded:window.testPcmEnded,timeline:window.testPcmTimeline}));
 if(pcmMode){
  assert.equal(capture.waves.length,0,'streaming must not wait for WAV blobs');
  assert.ok(capture.pcm.length>4);assert.equal(capture.pcmEnded,capture.pcm.length,'every PCM buffer must finish');
  assert.equal(capture.pcm.filter(chunk=>chunk.length===5280&&chunk.every(v=>v===0)).length,1,'only the whole reply has a completion pause');
  const samples=capture.pcm.flat(),pcm=Buffer.alloc(samples.length*2);samples.forEach((v,i)=>pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v*32768))),i*2));
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  await writeFile(path.join(evidence,`${desktop?'desktop':'browser'}-pcm.wav`),Buffer.concat([header,pcm]));
 }else{
  assert.equal(capture.waves.length,2,'changed-speed WAV retains both clauses');
  assert.equal(capture.started,2);assert.equal(capture.ended,2);
  for(let i=0;i<capture.waves.length;i++)await writeFile(path.join(evidence,`${desktop?'desktop':'browser'}-${i}.wav`),Buffer.from(capture.waves[i]));
 }
 assert.equal(await page.locator('#voice-name').inputValue(),voice);
 const status=await page.evaluate(async()=>window.atbDesktop?.hasModule('assistant')?window.atbDesktop.invokeModule('assistant','voice',{action:'status'}):(await fetch('/api/assistant/voice/status')).json());
 assert.ok(status.pid, 'preview retains its loaded model'); assert.equal(status.modelLoaded,true);
 await page.locator('#voice-preview').click();
 await page.waitForFunction(({pcmMode,ended})=>(pcmMode?window.testPcmEnded:window.testEnded)>ended && document.querySelector('#voice-result').textContent==='试听播放完成',{pcmMode,ended:pcmMode?capture.pcmEnded:capture.ended});
 const warm=await page.evaluate(async()=>({status:window.atbDesktop?.hasModule('assistant')?await window.atbDesktop.invokeModule('assistant','voice',{action:'status'}):await (await fetch('/api/assistant/voice/status')).json(),stages:window.testStages}));
 assert.equal(warm.status.pid,status.pid,'independent previews must reuse the same model process');
 assert.ok(warm.stages.some(item=>item.state.includes('复用已加载模型')));
 for(const enabled of [true,false])await page.evaluate(async enabled=>window.atbDesktop?.hasModule('assistant')?window.atbDesktop.invokeModule('assistant','voice',{action:'settings',enabled}):fetch('/api/assistant/voice/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})}),enabled);
 const released=await page.evaluate(async()=>window.atbDesktop?.hasModule('assistant')?window.atbDesktop.invokeModule('assistant','voice',{action:'status'}):(await fetch('/api/assistant/voice/status')).json());
 assert.equal(released.pid,null,'disabling voice releases the resident worker');

 assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,`${desktop?'desktop':'browser'}${pcmMode?'-pcm':''}-stages.json`),JSON.stringify({text,voice,pcmMode,chunks:capture.pcm.length,pcmEnded:capture.pcmEnded,started:capture.started,ended:capture.ended,stages:warm.stages,reusedPid:status.pid,timeline:capture.timeline},null,2));
 console.log('REAL_QWEN_PREVIEW_PASS',JSON.stringify({desktop,pcmMode,chunks:capture.pcm.length,pcmEnded:capture.pcmEnded,started:capture.started,ended:capture.ended,stages:warm.stages,reusedPid:status.pid}));
});
