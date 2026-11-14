import https from 'node:https';
import dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
const blocked = new BlockList();
for (const [address,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,bits,'ipv4');
// Public information endpoints need query strings. Pin public DNS addresses and
// send no account headers; unlike model requests, these are always plain GETs.
export async function publicInformationRequest(value, options = {}, { lookup = dns.lookup, transport = https.request } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || isIP(url.hostname.replace(/^\[|\]$/g,'')) || url.href.length > 4096) throw Error('公开数据地址无效');
  const signal = options.signal || AbortSignal.timeout(8000); signal.throwIfAborted();
  let cancel; const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  let records; try { records = await Promise.race([lookup(url.hostname,{all:true,family:4}),aborted]); } finally { signal.removeEventListener('abort',cancel); }
  signal.throwIfAborted();
  if (!records.length || records.some(item => isIP(item.address) !== 4 || blocked.check(item.address,'ipv4'))) throw Error('禁止读取内网地址');
  const chosen = { address: records[0].address, family: 4 };
  return new Promise((resolve,reject) => {
    const req = transport(url,{ method:'GET',agent:false,signal,timeout:8000,headers:{Accept:options.headers?.Accept || '*/*','User-Agent':'ATB-Desktop/0.7'},lookup:(_host,opts,callback)=>opts?.all?callback(null,[chosen]):callback(null,chosen.address,4) },res => {
      res.on('error',()=>{});
      const body = (async function*(){let length=0;try{for await(const chunk of res){signal.throwIfAborted();length+=chunk.length;if(length>2*1024*1024)throw Error('公开响应过大');yield chunk;}}finally{if(!res.readableEnded)req.destroy();}})();
      resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,headers:new Headers(res.headers),body,cancel:()=>req.destroy(),json:async()=>{const chunks=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString('utf8'));}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('公开数据请求超时')));req.end();
  });
}
