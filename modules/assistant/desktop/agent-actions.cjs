const path=require('node:path');
const {readdir,stat}=require('node:fs/promises');
const {createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const pages=new Set(['main','assistant','voice','faces','platform','persona','model','tools']);
function createAgentActions({navigate,menuDirs,launch,confirmDesktopAction,automation}={}){
  automation??=require('./desktop-automation.cjs').createDesktopAutomation({confirm:confirmDesktopAction});
  menuDirs??=[process.env.APPDATA,process.env.ProgramData].filter(Boolean).map(root=>path.join(root,'Microsoft','Windows','Start Menu','Programs'));
  launch??=async filename=>{
    if(filename.endsWith('.lnk')){const error=await require('electron').shell.openPath(filename);if(error)throw Error('launch-failed');return;}
    await new Promise((resolve,reject)=>{const child=spawn(filename,[],{windowsHide:false,detached:true,stdio:'ignore',shell:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
  };
  let cached,updated=0;
  async function catalog(){
    if(cached&&Date.now()-updated<60000)return cached;
    const entries=[{id:'calculator',name:'计算器',filename:path.join(process.env.SystemRoot||'C:\\Windows','System32','calc.exe')},{id:'notepad',name:'记事本',filename:path.join(process.env.SystemRoot||'C:\\Windows','System32','notepad.exe')}];
    async function walk(dir,depth=0){if(depth>6||entries.length>=800)return;let files;try{files=await readdir(dir,{withFileTypes:true});}catch{return;}
      for(const file of files){if(file.isSymbolicLink())continue;const filename=path.join(dir,file.name);if(file.isDirectory())await walk(filename,depth+1);else if(file.isFile()&&file.name.toLowerCase().endsWith('.lnk'))entries.push({id:'app_'+createHash('sha256').update(filename.toLowerCase()).digest('hex').slice(0,24),name:file.name.slice(0,-4),filename});}
    }
    for(const dir of menuDirs)await walk(dir);cached=entries;updated=Date.now();return entries;
  }
  return async(action,args={},context={})=>{
    const guard=()=>{context.signal?.throwIfAborted();context.check?.();};guard();
    if(['desktop_windows','desktop_snapshot','desktop_interact'].includes(action))return automation(action,args,context);
    if(action==='open_atb'){
      const page=args.page||'main';if(!pages.has(page)||typeof navigate!=='function')return{ok:false,error:'invalid-navigation'};
      guard();if(await navigate(page,context)===false)return{ok:false,error:'navigation-cancelled'};guard();return{ok:true,data:{page,message:'已打开 ATB 界面'}};
    }
    const applications=await catalog();guard();
    if(action==='list_applications')return{ok:true,data:{items:applications.filter(item=>!args.query||item.name.toLowerCase().includes(args.query.toLowerCase())).slice(0,100).map(({id,name})=>({id,name}))}};
    if(action!=='open_application')return{ok:false,error:'unsupported-action'};
    const app=applications.find(item=>item.id===args.id);if(!app)return{ok:false,error:'application-not-found'};
    try{if(app.id.startsWith('app_')&&!(await stat(app.filename)).isFile())throw Error();guard();await launch(app.filename);return{ok:true,data:{name:app.name,message:'已提交应用启动请求'}};}catch{guard();return{ok:false,error:'application-launch-failed'};}
  };
}
module.exports={createAgentActions};
