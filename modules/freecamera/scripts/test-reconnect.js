import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, chromium } from 'playwright';
import { startServers } from '../../../server/index.js';
import { loginViewer } from './account-test-helper.js';
import WebSocket from 'ws';
import { once } from 'node:events';
const require=createRequire(import.meta.url), root=path.resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const directory=await mkdtemp(path.join(tmpdir(),'freecamera-reconnect-'));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const httpsPort=await port(),httpPort=await port(),origin=`https://127.0.0.1:${httpsPort}`;
const options = { relayPort: 0, lanIp:'127.0.0.1',httpsPort,httpPort,certDir:path.join(directory,'certs'),dataDir:path.join(directory,'data')};
const env={...process.env, TURN_PORT: '0', FREECAMERA_DATA_DIR:directory,LAN_IP:'127.0.0.1',HTTPS_PORT:String(httpsPort),HTTP_PORT:String(httpPort)};delete env.ELECTRON_RUN_AS_NODE;
let desktop,service,browser,step='startup';const reserved=[],pages=[];
try{
 desktop=await electron.launch({executablePath:process.env.FREECAMERA_DESKTOP_EXECUTABLE||require('electron'),args:process.env.FREECAMERA_DESKTOP_EXECUTABLE?[]:[root],env});
 const desktopPage=await desktop.firstWindow();await loginViewer(desktopPage);
 browser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({ignoreHTTPSErrors:true,permissions:['camera','microphone']});
 await context.addInitScript(()=>{
  window.testPageBoot=crypto.randomUUID();window.testSockets=[];window.testPeers=[];window.testBlockedSockets=new Set();
  const Socket=window.WebSocket,Peer=window.RTCPeerConnection;
  window.WebSocket=class extends Socket{constructor(...args){super(...args);window.testSockets.push(this);}send(data){if(!window.testBlockedSockets.has(this))return super.send(data);}set onmessage(handler){super.onmessage=event=>{if(!window.testBlockedSockets.has(this))handler(event);};}get onmessage(){return super.onmessage;}};
  window.RTCPeerConnection=class extends Peer{constructor(...args){super(...args);window.testPeers.push(this);}};
 });
 const camera=await context.newPage(),viewer=await context.newPage(),errors=[];pages.push(camera,viewer);
 for(const page of [camera,viewer])page.on('pageerror',error=>errors.push(error.message));
 await camera.goto(`${origin}/?mode=camera`);await camera.locator('#start').click();await camera.waitForFunction(()=>/^\d{8}$/.test(document.querySelector('#pair-code').textContent));
 await viewer.goto(`${origin}/?mode=viewer`);await loginViewer(viewer);await viewer.locator('.device-connect').click();
 const live=()=>viewer.waitForFunction(()=>document.querySelector('#status').textContent==='实时画面',null,{timeout:18000});await live();
 const cameraBefore=await camera.evaluate(()=>({boot:window.testPageBoot,track:document.querySelector('video').srcObject.getVideoTracks()[0].id,identity:localStorage.getItem('freecamera.camera')}));
 const viewerBoot=await viewer.evaluate(()=>window.testPageBoot);
 step='desktop to standalone handoff';await desktop.close();desktop=null;await viewer.waitForTimeout(700);service=await startServers(options);
 await live();
 assert.equal(await viewer.evaluate(()=>window.testPageBoot),viewerBoot,'viewer must not reload or require login after same-service restart');
 assert.deepEqual(await camera.evaluate(()=>({boot:window.testPageBoot,track:document.querySelector('video').srcObject.getVideoTracks()[0].id,identity:localStorage.getItem('freecamera.camera')})),cameraBefore,'camera must retain its page, capture and identity');
 step='occupied camera';const replacement=await context.newPage();replacement.on('pageerror',error=>errors.push(error.message));
 await replacement.goto(`${origin}/?mode=camera`);await replacement.locator('#start').click();
 await replacement.waitForFunction(()=>document.querySelector('#status').textContent.includes('旧连接'));
 assert.equal(await replacement.locator('video').evaluate(video=>video.srcObject.getVideoTracks()[0].readyState),'live','temporary camera-in-use must not discard capture');
 await camera.locator('#stop').click();await replacement.waitForFunction(()=>/^\d{8}$/.test(document.querySelector('#pair-code').textContent));await live();
 await replacement.locator('#stop').click();await replacement.close();await camera.locator('#start').click();await live();
 step='viewer capacity';const cameraId=await camera.evaluate(()=>JSON.parse(localStorage.getItem('freecamera.camera')).deviceId);
 const sessionCookie=(await context.cookies(origin)).find(cookie=>cookie.name==='__Host-freecamera');
 for(let index=0;index<3;index++){
  const ws=new WebSocket(`${origin.replace('https:','wss:')}/signal`,{origin,rejectUnauthorized:false,headers:{Cookie:`${sessionCookie.name}=${sessionCookie.value}`}});reserved.push(ws);await once(ws,'open');
  const watching=new Promise(resolve=>ws.on('message',raw=>{if(JSON.parse(raw).type==='watching')resolve();}));ws.send(JSON.stringify({type:'watch',deviceId:cameraId}));await watching;
 }
 const waiting=await context.newPage();waiting.on('pageerror',error=>errors.push(error.message));await waiting.goto(`${origin}/?mode=viewer`);
 await waiting.waitForFunction(()=>document.querySelector('#error').textContent.includes('已满'));
 reserved.pop().terminate();await waiting.waitForFunction(()=>document.querySelector('#status').textContent==='实时画面',null,{timeout:12000});await waiting.close();
 for(const ws of reserved.splice(0))ws.terminate();
 // A live TCP socket can stop delivering control messages without firing close.
 step='silent signaling loss';await camera.evaluate(()=>{for(const ws of window.testSockets)window.testBlockedSockets.add(ws);});await camera.waitForTimeout(12000);await camera.evaluate(()=>window.dispatchEvent(new Event('online')));
 await live();
 step='media failure';const priorPeers=await viewer.evaluate(()=>window.testPeers.length);
 await viewer.evaluate(()=>window.testPeers.at(-1).close());
 await viewer.waitForFunction(count=>window.testPeers.length>count&&document.querySelector('#status').textContent==='实时画面',priorPeers,{timeout:18000});
 step='automatic recovery toggle';const pausedPeers=await viewer.evaluate(()=>window.testPeers.length);
 await viewer.evaluate(()=>window.testPeers.at(-1).close());await viewer.waitForFunction(()=>document.querySelector('#status').textContent.includes('中断'));
 await viewer.locator('#auto-connect').uncheck();await viewer.waitForTimeout(4500);
 assert.equal(await viewer.evaluate(()=>window.testPeers.length),pausedPeers,'disabling automatic recovery must cancel a retry already scheduled');
 await viewer.locator('#auto-connect').check();await viewer.waitForFunction(count=>window.testPeers.length>count&&document.querySelector('#status').textContent==='实时画面',pausedPeers,{timeout:18000});
 step='manual disconnect';await viewer.locator('#disconnect').click();const stopped=await viewer.evaluate(()=>window.testPeers.length);
 await viewer.evaluate(()=>window.dispatchEvent(new Event('online')));await viewer.waitForTimeout(4500);assert.equal(await viewer.evaluate(()=>window.testPeers.length),stopped,'manual disconnect must remain disconnected');
 assert.deepEqual(errors,[]);
 await mkdir('test-results/reconnect',{recursive:true});await viewer.screenshot({path:'test-results/reconnect/viewer.png',fullPage:true});
  await writeFile('test-results/reconnect/report.json',JSON.stringify({passed:true,time:new Date().toISOString(),checks:['desktop to standalone handoff without phone/viewer reload or login','same capture track and camera identity','temporary occupied camera retries without discarding capture','viewer capacity recovery after stale connection releases','silent signaling loss and online recovery','failed media peer automatic renegotiation','disabling automatic recovery cancels queued retries','manual disconnect respected']},null,2));
 console.log('PASS: service handoff automatically restores capture and viewing, silent signal loss and media failure recover, manual disconnect respected');
}catch(error){
 const snapshots=await Promise.all(pages.map(page=>page.evaluate(async ()=>({url:location.href,status:document.querySelector('#status').textContent,error:document.querySelector('#error').textContent,detail:document.querySelector('#connection-detail').textContent,sockets:window.testSockets.map(ws=>ws.readyState),peers:window.testPeers.map(pc=>({state:pc.connectionState,ice:pc.iceConnectionState,signal:pc.signalingState})),video:{ready:document.querySelector('video').readyState,time:document.querySelector('video').currentTime}})).catch(e=>({error:e.message}))));
 await mkdir('test-results/reconnect',{recursive:true});await writeFile('test-results/reconnect/failure.json',JSON.stringify({step,snapshots,error:error.message},null,2));console.error('FAIL:',step,JSON.stringify(snapshots));throw error;
}finally{for(const ws of reserved)ws.terminate();await desktop?.close();await browser?.close();await service?.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
