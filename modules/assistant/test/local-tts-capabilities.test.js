import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VoiceRuntime} from '../server/voice-runtime.js';

test('local catalogues expose model languages, all Qwen speakers and unlimited Chat seed selection',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'tts-capabilities-')); const r=new VoiceRuntime({dataDir});t.after(async()=>{await r.dispose();await rm(dataDir,{recursive:true,force:true})});
 const c=await r.catalog({provider:'chattts'});assert.equal(c.capabilities.voiceKind,'seed');assert.equal(c.capabilities.audioStreaming,true);assert.deepEqual(c.languages.map(x=>x.id),['zh','en']);
 for(const seed of [0,987654321,4294967295]) {const s=await r.configure({provider:'chattts',voice:`chattts:${seed}`});assert.equal(s.voice,`chattts:${seed}`);assert.ok(s.voiceCatalog.some(x=>x.id===s.voice));}
 for(const seed of ['-1','4294967296','01','abc'])await assert.rejects(r.configure({provider:'chattts',voice:`chattts:${seed}`}),/音色/);
 const q=await r.catalog({provider:'qwen3tts'});assert.equal(q.voices.length,9);assert.equal(new Set(q.voices.map(v=>v.id)).size,9);assert.ok(q.languages.some(l=>l.id==='russian'));assert.ok(q.voices.some(v=>v.id==='qwen3tts:vivian'));assert.equal(q.capabilities.audioStreaming,true);
 await r.configure({provider:'qwen3tts',voice:'qwen3tts:sohee'});await r.configure({provider:'chattts'});assert.equal((await r.configure({provider:'qwen3tts'})).voice,'qwen3tts:sohee');
});

test('ChatTTS PCM arrives before synthesis completes and cancel releases a pending reader',async t=>{
 const {writeFile}=await import('node:fs/promises'); const dataDir=await mkdtemp(path.join(tmpdir(),'tts-stream-'));
 const worker=path.join(dataDir,'worker.cjs');await writeFile(worker,`const rl=require('node:readline').createInterface({input:process.stdin});console.log(JSON.stringify({type:'ready'}));rl.on('line',line=>{const m=JSON.parse(line); if(m.action==='speak-stream'){console.log(JSON.stringify({id:m.id,type:'audio',audio:Buffer.alloc(4800,1).toString('base64')}));setTimeout(()=>console.log(JSON.stringify({id:m.id,ok:true})),300)}});`);
 const r=new VoiceRuntime({dataDir,command:process.execPath,worker,verifyInstallation:false,requestTimeoutMs:2000});t.after(async()=>{await r.dispose();await rm(dataDir,{recursive:true,force:true})});
 await r.configure({provider:'chattts',voice:'chattts:987654321'});const lease=await r.open('test',{mode:'synthesis'}),started=await r.ttsStart('test',lease); const args={leaseId:lease.leaseId,streamId:started.streamId};
 assert.equal(started.method,'local-stream');assert.equal(started.sampleRate,24000);
 await r.ttsText('test',{...args,text:'测试'});await r.ttsFinish('test',args);const first=await r.ttsRead('test',args);assert.equal(first.done,false);assert.equal(Buffer.from(first.audio,'base64').length,4800);
 const pending=r.ttsRead('test',args),rejection=assert.rejects(pending,/停止|失效/);await r.close('test',lease.leaseId);await rejection;assert.equal(r.state.pid,null);
});


test('language selectors follow actual provider IDs without hardcoded buckets',async()=>{
 const {catalogueLanguages,voiceMatchesLanguage}=await import('../public/voice-catalog.js');
 const voices=[{id:'a',locale:'zh-TW'},{id:'b',locale:'de-DE'},{id:'c',locale:'ja-JP'}];
 assert.deepEqual(catalogueLanguages(voices).map(x=>x.id),['zh-TW','de-DE','ja-JP']);
 assert.equal(voiceMatchesLanguage(voices[0],'zh-CN'),false);assert.equal(voiceMatchesLanguage(voices[1],'de-DE'),true);
 assert.deepEqual(catalogueLanguages([{languages:['chinese','russian']}],[{id:'russian',name:'Russian'}]),[{id:'russian',name:'Russian'}]);
});


test('all ranked ChatTTS speakers retain original metadata and deterministic score ordering', async () => {
 const {localCatalog,validChatVoice}=await import('../server/local-tts.js');
 const c=localCatalog('chattts','chattts:42'), ranked=c.voices.filter(v=>v.source==='ChatTTS_Speaker');
 assert.equal(ranked.length,2646);
 assert.equal(new Set(ranked.map(v=>v.id)).size,2646);
 assert.ok(ranked.every(v=>v.id===`chattts:speaker:${v.seedId}` && v.gender && v.age && Number.isFinite(v.rankSingle)));
 assert.ok(ranked.every((v,i)=>i===0||ranked[i-1].rankSingle>=v.rankSingle));
 assert.ok(validChatVoice(ranked[0].id));assert.equal(validChatVoice('chattts:speaker:seed_999999999'),false);
 assert.ok(c.voices.some(v=>v.id==='chattts:42'),'existing random seeds keep their original meaning');
 assert.ok(!JSON.stringify(c).includes('emb_data'),'public catalogue must not duplicate speaker tensors');
});


test('ranked speaker sorting uses the chosen stability metric and labels estimated gender/age', async () => {
 const {sortChatSpeakers,voiceOptionLabel}=await import('../public/voice-catalog.js');
 const {localCatalog}=await import('../server/local-tts.js');
 const voices=localCatalog('chattts','chattts:42').voices;
 for(const key of ['rankSingle','rankMulti','rankLong']) {
  const sorted=sortChatSpeakers(voices,key);
  assert.equal(sorted.length,2650);assert.ok(!Number.isFinite(sorted.at(-1)[key]));
  assert.ok(sorted.slice(0,2646).every((v,i)=>!i||sorted[i-1][key]>=v[key]));
  const label=voiceOptionLabel(sorted[0],key);
  assert.ok(label.includes(sorted[0].seedId));assert.ok(label.includes('Gender '+sorted[0].gender));assert.ok(label.includes('Age '+sorted[0].age));assert.ok(label.includes(sorted[0][key].toFixed(2)));
 }
 const ties=[{seedId:'seed_10',rankSingle:5},{seedId:'seed_2',rankSingle:5}];
 assert.deepEqual(sortChatSpeakers(ties).map(v=>v.seedId),['seed_2','seed_10']);
 assert.equal(voices.at(-1).id,'chattts:10086','sorting must not mutate provider catalogue');
});

test('cancelled Chat PCM cannot leak into a new stream on the same loaded worker', async t => {
  const { writeFile } = await import('node:fs/promises');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tts-resident-stream-')), worker = path.join(dataDir, 'worker.cjs');
  await writeFile(worker, `const rl=require('node:readline').createInterface({input:process.stdin}); console.log(JSON.stringify({type:'ready'})); let count=0; rl.on('line',line=>{const m=JSON.parse(line),value=++count; const send=()=>console.log(JSON.stringify({id:m.id,type:'audio',audio:Buffer.alloc(4800,value).toString('base64')}));send();setTimeout(()=>{send();console.log(JSON.stringify({id:m.id,ok:true}));},120);});`);
  const r = new VoiceRuntime({ dataDir, command: process.execPath, worker, verifyInstallation: false });
  t.after(async () => { await r.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const first = await r.open('reader', { mode: 'synthesis' }), stream = await r.ttsStart('reader', first);
  const old = { leaseId: first.leaseId, streamId: stream.streamId };
  await r.ttsText('reader', { ...old, text: '旧段' }); await r.ttsFinish('reader', old); await r.ttsRead('reader', old);
  const pending = r.ttsRead('reader', old), rejected = assert.rejects(pending, /停止|失效/);
  await r.close('reader', first.leaseId, { keepWarm: true }); await rejected;
  const next = await r.open('reader', { mode: 'synthesis' }); assert.equal(next.pid, first.pid);
  const fresh = { leaseId: next.leaseId, streamId: (await r.ttsStart('reader', next)).streamId };
  await r.ttsText('reader', { ...fresh, text: '新段' }); await r.ttsFinish('reader', fresh);
  for (;;) { const result = await r.ttsRead('reader', fresh); if (result.done) break; assert.ok(Buffer.from(result.audio, 'base64').every(value => value === 2)); }
});


test('Qwen exposes PCM before completion and keeps a WAV path for changed speed', async t => {
 const {writeFile}=await import('node:fs/promises');const dataDir=await mkdtemp(path.join(tmpdir(),'qwen-pcm-'));
 const worker=path.join(dataDir,'worker.cjs');await writeFile(worker,`const rl=require('node:readline').createInterface({input:process.stdin});console.log(JSON.stringify({type:'ready'}));rl.on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,type:'audio',audio:Buffer.alloc(4800,1).toString('base64')}));setTimeout(()=>console.log(JSON.stringify({id:m.id,ok:true})),80);});`);
 const r=new VoiceRuntime({dataDir,command:process.execPath,worker,verifyInstallation:false});t.after(async()=>{await r.dispose();await rm(dataDir,{recursive:true,force:true});});
 await r.configure({provider:'qwen3tts',voice:'qwen3tts:serena'});
 assert.equal((await r.settings()).synthesisCapabilities.audioStreaming,true);
 const lease=await r.open('test',{mode:'synthesis'}),start=await r.ttsStart('test',lease),args={leaseId:lease.leaseId,streamId:start.streamId};
 assert.equal(start.mime,'audio/pcm');await r.ttsText('test',{...args,text:'streaming fixture'});await r.ttsFinish('test',args);
 assert.equal((await r.ttsRead('test',args)).done,false);assert.equal((await r.ttsRead('test',args)).done,true);
 await r.close('test',lease.leaseId);await r.configure({rate:10});assert.equal((await r.settings()).synthesisCapabilities.audioStreaming,false);
});
