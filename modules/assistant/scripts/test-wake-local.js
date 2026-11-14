import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, unlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VoiceRuntime } from '../server/voice-runtime.js';
import { resamplePcm16 } from '../public/voice-audio.js';
import { matchWakePhrase } from '../public/wake-listener.js';

// Installed models read-only, synthetic phrases, isolated settings. No physical
// microphone/speakers, personal configuration or conversational API requests.
const root=path.resolve(import.meta.dirname,'../../..'),evidence=path.join(root,'test-results/wake');
await mkdir(evidence,{recursive:true}); const directory=await mkdtemp(path.join(evidence,'runtime-')),dataDir=path.join(directory,'assistant'); await mkdir(dataDir);
const runtime=new VoiceRuntime({dataDir}),links=[],report=[];let heartbeat;
function wavPcm(audio){
  assert.equal(audio.toString('ascii',0,4),'RIFF');let rate,pcm;
  for(let offset=12;offset+8<=audio.length;){const kind=audio.toString('ascii',offset,offset+4),length=audio.readUInt32LE(offset+4),start=offset+8;
    if(kind==='fmt '){assert.equal(audio.readUInt16LE(start),1);assert.equal(audio.readUInt16LE(start+2),1);assert.equal(audio.readUInt16LE(start+14),16);rate=audio.readUInt32LE(start+4);}
    if(kind==='data')pcm=audio.subarray(start,start+length);offset=start+length+(length%2);
  }
  assert.ok(rate&&pcm);const samples=new Float32Array(pcm.length/2);for(let i=0;i<samples.length;i++)samples[i]=pcm.readInt16LE(i*2)/32768;
  const result=resamplePcm16(samples,rate);return Buffer.from(result.buffer).toString('base64');
}
try{
  for(const name of ['voice-runtime','tts-runtime','models']){const link=path.join(dataDir,name);await symlink(path.join(root,'data/assistant',name),link,process.platform==='win32'?'junction':'dir');links.push(link);}
  await runtime.configure({enabled:true,wakeEnabled:true,wakePhrases:['你好助手'],provider:'chattts'});const prepared=await runtime.prepare('fixture');
  const synthesis=await runtime.open('fixture');heartbeat=setInterval(()=>runtime.heartbeat('fixture',synthesis),3000);
  const cases=[
    {text:'小鲸鱼，今天二十四度吗？',wake:true},
    {text:'你好助手，现在几点？',wake:true},
    {text:'金鱼，今天二十四度吗？',wake:true},
    {text:'今天午饭吃什么？',wake:false},
    {text:'我养了一条金鱼，很可爱。',wake:false},
  ],clips=[],failures=[];
  // Extended diagnostic: this very short synthetic address can become “基于”,
  // which is outside homophone/nasal tolerance. Preserve the failed probe
  // rather than adding a common unrelated expression to the wake aliases.
  if(process.argv.includes('--probe-short'))cases.push({text:'鲸鱼，现在几点？',wake:true});
  for(const {text} of cases){const result=await runtime.speak('fixture',{leaseId:synthesis.leaseId,text});clips.push(wavPcm(Buffer.from(result.audio,'base64')));}
  clearInterval(heartbeat);await runtime.close('fixture',synthesis.leaseId,{keepWarm:true});
  const wake=await runtime.open('fixture',{mode:'wake'});assert.equal(wake.pid,prepared.pid);heartbeat=setInterval(()=>runtime.heartbeat('fixture',wake),3000);
  for(let i=0;i<cases.length;i++){const start=performance.now(),asr=await runtime.transcribe('fixture',{leaseId:wake.leaseId,pcm:clips[i]}),match=matchWakePhrase(asr.text,{name:'小鲸鱼',phrases:['你好助手']});report.push({input:cases[i].text,recognized:asr.text,matched:match,asrMs:Math.round(performance.now()-start)});console.log(JSON.stringify(report.at(-1)));if(Boolean(match)!==cases[i].wake)failures.push({input:cases[i].text,recognized:asr.text});}
  await runtime.close('fixture',wake.leaseId,{keepWarm:true});const conversation=await runtime.open('fixture');assert.equal(conversation.pid,prepared.pid);
  await runtime.close();assert.equal(runtime.state.pid,null);
  await writeFile(path.join(evidence,process.argv.includes('--probe-short')?'local-asr-probe.json':'local-asr.json'),JSON.stringify({passed:failures.length===0,reused:true,report,failures},null,2));assert.deepEqual(failures,[],'all fixed wake/negative utterances should classify correctly');console.log('WAKE_LOCAL_ASR_PASS');
}finally{clearInterval(heartbeat);await runtime.dispose();for(const link of links)await unlink(link);await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
