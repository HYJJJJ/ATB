import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AiError} from '../../../server/ai-settings.js';
import {TOOL_CAPABILITIES} from '../public/tool-capabilities.js';
const fail=()=>{throw new AiError('工具配置无效：请检查服务名称、连接方式及参数。',400);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const string=(v,max,empty=false)=>{if(typeof v!=='string'||v.length>max||!empty&&!v.trim()||/[\u0000\r\n]/.test(v))fail();return v;};
const defaults=()=>({servers:[]});
function secrets(value,previous={}){
  if(value===undefined)return {...previous};if(!plain(value)||Object.keys(value).length>40)fail();
  return Object.fromEntries(Object.entries(value).map(([key,v])=>{if(!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(key))fail();return[key,v===''&&previous[key]?previous[key]:string(v,4096,true)];}));
}
export function validateToolSettings(value,previous=defaults()){
  if(!plain(value)||!Array.isArray(value.servers)||value.servers.length>16)fail();const ids=new Set();
  const capabilities={...previous.capabilities};
  if(value.capabilities!==undefined){if(!plain(value.capabilities))fail();for(const [id,enabled]of Object.entries(value.capabilities)){if(!TOOL_CAPABILITIES.some(c=>c.id===id)||typeof enabled!=='boolean')fail();capabilities[id]=enabled;}}
  return {capabilities,servers:value.servers.map(server=>{
    if(!plain(server)||!/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(server.id)||ids.has(server.id)||typeof server.enabled!=='boolean')fail();ids.add(server.id);
    const old=previous.servers.find(s=>s.id===server.id&&s.transport===server.transport),result={id:server.id,label:string(server.label||server.id,80),enabled:server.enabled,transport:server.transport};
    if(server.transport==='stdio'){
      result.command=string(server.command,2048);
      if(!Array.isArray(server.args)||server.args.length>60)fail();result.args=server.args.map(v=>string(v,4096,true));
      result.env=secrets(server.env,old?.env);if(server.cwd)result.cwd=string(server.cwd,2048);
    }else if(server.transport==='streamable-http'){
      let url;try{url=new URL(string(server.url,2048));}catch{fail();}if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash)fail();
      if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))fail();result.url=url.href;result.headers=secrets(server.headers,old?.url===url.href?old.headers:{});
    }else fail();
    if(server.allowedTools!==undefined){if(!Array.isArray(server.allowedTools)||server.allowedTools.length>80)fail();result.allowedTools=server.allowedTools.map(v=>string(v,100));}
    return result;
  })};
}
export class ToolSettings{
  constructor(dataDir){this.dir=path.join(dataDir,'tool-settings');this.accounts=new Map();this.writes=Promise.resolve();}
  async load(){await mkdir(this.dir,{recursive:true,mode:0o700});}
  key(owner){return createHash('sha256').update(owner).digest('hex');}
  async ensure(owner){if(this.accounts.has(owner))return;try{const raw=JSON.parse(await readFile(path.join(this.dir,this.key(owner)+'.json'),'utf8'));this.accounts.set(owner,validateToolSettings(raw));}catch(error){if(error.code!=='ENOENT')throw new AiError('工具配置读取失败，请检查数据目录。',500);this.accounts.set(owner,defaults());}}
  get(owner){return structuredClone(this.accounts.get(owner)||defaults());}
  visible(owner){const value=this.get(owner);for(const server of value.servers)for(const group of ['env','headers'])if(server[group])server[group]=Object.fromEntries(Object.keys(server[group]).map(k=>[k,'']));return value;}
  async save(owner,value){await this.ensure(owner);const task=this.writes.catch(()=>{}).then(async()=>{const next=validateToolSettings(value,this.get(owner)),file=path.join(this.dir,this.key(owner)+'.json');await writeFile(file+'.tmp',JSON.stringify(next,null,2),{mode:0o600});await rename(file+'.tmp',file);this.accounts.set(owner,next);return this.visible(owner);});this.writes=task;return task;}
}
