import path from 'node:path';
import net from 'node:net';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
const hosts=new Map();
const key=dir=>path.resolve(dir).toLowerCase();
const address=dir=>{const id=createHash('sha256').update(key(dir)).digest('hex').slice(0,32);return process.platform==='win32'?'\\\\.\\pipe\\atb-assistant-'+id:path.join(tmpdir(),'atb-assistant-'+id+'.sock');};
const metadata=dir=>path.join(dir,'assistant','desktop-actions.json');
const unavailable=()=>({ok:false,error:'desktop-unavailable',message:'当前服务没有连接本机桌面宿主，未打开任何窗口或应用。'});
const actions=new Set(['open_atb','list_applications','open_application','desktop_windows','desktop_snapshot','desktop_interact']);

// Private authenticated local pipe also supports a desktop that reuses a separate service.
export async function registerDesktopActions(dataDir,execute){
  const id=key(dataDir),token=randomBytes(32).toString('hex'),host={execute};let closing=false;
  const sockets=new Set();
  const server=net.createServer(socket=>{
    socket.setEncoding('utf8');
    sockets.add(socket);socket.setTimeout(60000,()=>socket.destroy());
    const controller=new AbortController();let buffer='',received=false;
    socket.on('error',()=>{});socket.once('close',()=>{sockets.delete(socket);controller.abort();});
    socket.on('data',async chunk=>{
      if(received)return;buffer+=chunk.toString('utf8');if(buffer.length>16000){socket.destroy();return;}
      if(!buffer.includes('\n'))return;received=true;
      try{
        const request=JSON.parse(buffer.trim());if(closing||request.token!==token||!actions.has(request.action))throw Error('unauthorized');
        const check=()=>{controller.signal.throwIfAborted();if(closing)throw Error('host-closed');};
        const result=await execute(request.action,request.args,{signal:controller.signal,check,scope:typeof request.scope==='string'?request.scope.slice(0,100):''});check();
        socket.end(JSON.stringify(result)+'\n');
      }catch{if(!socket.destroyed)socket.end(JSON.stringify(unavailable())+'\n');}
    });
  });
  server.on('error',()=>{});
  await mkdir(path.dirname(metadata(dataDir)),{recursive:true,mode:0o700});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address(dataDir),resolve);});server.unref();
  try {await writeFile(metadata(dataDir),JSON.stringify({token}),{mode:0o600});}catch(error){server.close();throw error;}
  hosts.set(id,host);
  return async()=>{
    if(closing)return;closing=true;if(hosts.get(id)===host)hosts.delete(id);
    for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
    try{if(JSON.parse(await readFile(metadata(dataDir),'utf8')).token===token)await rm(metadata(dataDir),{force:true});}catch{}
  };
}
export async function executeDesktopAction(dataDir,action,args,context={}){
  const check=()=>{context.signal?.throwIfAborted();context.check?.();};check();
  if(!actions.has(action))return unavailable();
  const host=hosts.get(key(dataDir));if(host)return host.execute(action,args,context);
  let token;try{token=JSON.parse(await readFile(metadata(dataDir),'utf8')).token;if(!/^[a-f0-9]{64}$/.test(token))return unavailable();}catch{return unavailable();}check();
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(address(dataDir));let buffer='',finished=false;
    socket.setEncoding('utf8');
    const finish=(value,error)=>{if(finished)return;finished=true;context.signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(value);};
    const abort=()=>finish(null,context.signal.reason);context.signal?.addEventListener('abort',abort,{once:true});
    socket.setTimeout(60000,()=>finish(unavailable()));
    socket.once('connect',()=>{try{check();socket.write(JSON.stringify({token,action,args,scope:context.scope})+'\n');}catch(error){finish(null,error);}});
    socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>64000){finish(unavailable());return;}if(buffer.includes('\n')){try{check();finish(JSON.parse(buffer.trim()));}catch(error){finish(null,error);}}});
    socket.once('error',()=>finish(unavailable()));socket.once('end',()=>{if(!finished)finish(unavailable());});
    if(context.signal?.aborted)abort();
  });
}
