import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {createHash} from 'node:crypto';
import {toolCommand} from './tool-runtime.js';
import {spawn} from 'node:child_process';
const toolName=(id,name)=>{const full=`mcp__${id}__${name}`;return full.length<=64?full:full.slice(0,51)+'_'+createHash('sha256').update(full).digest('hex').slice(0,12);};
const failure=error=>({ok:false,error});
export class McpConnections{
  constructor(){this.owners=new Map();this.closing=false;}
  async stop(entry){
    return entry.stopping??=(async()=>{
      const pid=entry.transport?.pid;
      if(pid&&process.platform==='win32')await new Promise(resolve=>{const child=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});child.once('error',resolve);child.once('exit',resolve);});
      await entry.client.close();
    })();
  }
  async reset(owner,expected){const record=this.owners.get(owner);if(!record||expected&&expected!==record)return;this.owners.delete(owner);record.cancelled=true;record.controller.abort();await Promise.allSettled(record.clients.map(entry=>this.stop(entry)));await record.ready.catch(()=>{});}
  async registry(owner,settings,{signal}={}){
    if(this.closing)throw Error('tools-closed');
    const fingerprint=JSON.stringify(settings);let record=this.owners.get(owner);
    if(record&&record.fingerprint!==fingerprint){await this.reset(owner);record=null;}
    if(!record){
      record={fingerprint,controller:new AbortController(),clients:[],statuses:[],cancelled:false};this.owners.set(owner,record);
      record.ready=Promise.all(settings.servers.filter(s=>s.enabled).map(async server=>{
        const client=new Client({name:'ATB',version:'0.7.0'},{capabilities:{}}),entry={server,client,tools:[]};record.clients.push(entry);
        const status={id:server.id,label:server.label,state:'connecting',tools:[]};record.statuses.push(status);
        try{
          const launch=server.transport==='stdio'?toolCommand(server):null;
          const transport=launch?new StdioClientTransport({...launch,env:{...getDefaultEnvironment(),...launch.env},...(server.cwd?{cwd:server.cwd}:{}),stderr:'ignore'}):new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers}});
          entry.transport=transport;
          const deadline=AbortSignal.any([record.controller.signal,AbortSignal.timeout(12000)]);
          await client.connect(transport,{signal:deadline,timeout:12000});deadline.throwIfAborted();
          const refresh=async()=>{
            const tools=[];let cursor,pages=0;do{const result=await client.listTools(cursor?{cursor}:{},{signal:record.controller.signal,timeout:10000});tools.push(...result.tools);cursor=result.nextCursor;if(++pages>10||tools.length>100)throw Error('catalog-too-large');}while(cursor);
            const names=new Set();entry.tools=tools.filter(tool=>!server.allowedTools||server.allowedTools.includes(tool.name)).map(tool=>{if(!/^[A-Za-z0-9_-]{1,100}$/.test(tool.name)||names.has(tool.name))throw Error('catalog-invalid');names.add(tool.name);return {name:toolName(server.id,tool.name),rawName:tool.name,description:String(tool.description||tool.name).slice(0,2000),parameters:tool.inputSchema};});
            status.state='connected';status.tools=entry.tools.map(({name,description})=>({name,description}));
          };
          await refresh();client.setNotificationHandler(ToolListChangedNotificationSchema,()=>refresh().catch(()=>{status.state='error';entry.tools=[];}));
          client.onclose=()=>{status.state='disconnected';entry.tools=[];};client.onerror=()=>{status.state='error';};
          if(record.cancelled)await this.stop(entry);
        }catch{entry.tools=[];status.state='error';status.error='无法连接工具服务，请检查地址、程序和权限。';await this.stop(entry).catch(()=>{});}
      }));
    }
    if(signal){signal.throwIfAborted();let abort;try{await Promise.race([record.ready,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}}else await record.ready;
    if(record.cancelled)throw Error('tools-changed');
    const definitions=record.clients.flatMap(entry=>entry.tools.map(({rawName,...tool})=>tool));
    return {definitions,statuses:structuredClone(record.statuses),execute:async(call,{signal,check=()=>{}}={})=>{
      check();signal?.throwIfAborted();if(record.cancelled)return failure('tools-changed');
      const entry=record.clients.find(item=>item.tools.some(t=>t.name===call.name)),tool=entry?.tools.find(t=>t.name===call.name);if(!tool)return failure('tool-unavailable');
      let cancellation;const abort=()=>{cancellation=this.reset(owner,record);};signal?.addEventListener('abort',abort,{once:true});
      try{
        signal?.throwIfAborted();
        const args=JSON.parse(call.arguments);if(!args||typeof args!=='object'||Array.isArray(args))return failure('invalid-arguments');
        const result=await entry.client.callTool({name:tool.rawName,arguments:args},undefined,{signal:AbortSignal.any([record.controller.signal,...(signal?[signal]:[])]),timeout:20000});
        check();signal?.throwIfAborted();if(record.cancelled)return failure('tools-changed');
        const content=(result.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n').slice(0,12000);
        const structured=result.structuredContent;
        if(structured&&JSON.stringify(structured).length>12000)return failure('result-too-large');
        if(!content&&!structured&&!result.isError)return failure('unsupported-mcp-content');
        return {ok:!result.isError,data:{text:content,...(structured?{structured}:{}),source:entry.server.label},...(result.isError?{error:'mcp-tool-failed'}:{})};
      }catch{await this.reset(owner,record);signal?.throwIfAborted();check();return failure('mcp-tool-failed');}
      finally{signal?.removeEventListener('abort',abort);await cancellation;}
    }};
  }
  async close(){this.closing=true;await Promise.allSettled([...this.owners.keys()].map(owner=>this.reset(owner)));}
}
