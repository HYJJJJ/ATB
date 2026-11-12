import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServers } from '../../../server/index.js';
async function port() { const s=net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }

test('production service advertises private STUN and returns a valid XOR mapped address over real UDP, then releases the port', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'freecamera-stun-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const httpsPort=await port(), httpPort=await port();
  const service=await startServers({ relayPort: 0, lanIp:'127.0.0.1',httpsPort,httpPort,certDir:path.join(directory,'certs'),dataDir:path.join(directory,'data')});
  t.after(()=>service.close());
  const ca=await readFile(path.join(directory,'certs','ca.crt'));
  const config=await new Promise((resolve,reject)=>https.get(`https://127.0.0.1:${httpsPort}/api/config`,{ca},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(JSON.parse(body)));}).on('error',reject));
  assert.ok(config.iceServers?.some(server=>server.urls.includes(`stun:127.0.0.1:${httpsPort}`)),'browser must discover a usable private STUN URL');
  const client=dgram.createSocket('udp4'); await new Promise(r=>client.bind(0,'127.0.0.1',r)); t.after(()=>client.close());
  const transaction=Buffer.from('0102030405060708090a0b0c','hex');
  const request=Buffer.from('000100002112a4420102030405060708090a0b0c','hex');
  const received=once(client,'message'); client.send(request,httpsPort,'127.0.0.1');
  const [response]=await Promise.race([received,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('STUN response timed out')),1000);timer.unref();})]);
  assert.equal(response.readUInt16BE(0),0x0101); assert.equal(response.readUInt16BE(2),12);
  assert.deepEqual(response.subarray(8,20),transaction); assert.equal(response.readUInt16BE(20),0x0020);
  assert.equal(response.readUInt16BE(26)^0x2112,client.address().port);
  assert.equal(response.readUInt32BE(28)^0x2112a442,0x7f000001);
  await service.close();
  const replacement=dgram.createSocket('udp4'); await new Promise(r=>replacement.bind(httpsPort,'127.0.0.1',r)); replacement.close();
});
