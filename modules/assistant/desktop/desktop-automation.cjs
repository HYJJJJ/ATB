const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const failure=(error,message)=>({ok:false,error,...(message?{message}:{})});
function runAutomation(request,{signal}={}){
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-automation.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
    let output='',done=false;
    const finish=(value,error)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(child.exitCode===null)child.kill();error?reject(error):resolve(value);};
    const abort=()=>finish(null,signal.reason),timer=setTimeout(()=>finish(failure('desktop-timeout','窗口没有及时响应，请稍后重试。')),12000);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>60000)finish(failure('desktop-result-too-large'));});
    child.stderr.resume();child.stdin.on('error',()=>{});child.once('error',()=>finish(failure('desktop-unavailable','Windows 控件服务不可用。')));
    child.once('exit',()=>{try{finish(JSON.parse(output.replace(/^\uFEFF/,'')));}catch{finish(failure('desktop-unavailable','窗口控件无法读取，未执行操作。'));}});
    child.stdin.end(JSON.stringify(request));if(signal?.aborted)abort();
  });
}
function createDesktopAutomation({run=runAutomation,confirm=async()=>false,now=Date.now}={}){
  const windows=new Map(),snapshots=new Map();let mutating=false;
  const guard=context=>{context.signal?.throwIfAborted();context.check?.();};
  function prune(){for(const map of [windows,snapshots])for(const [id,item]of map)if(now()-item.at>60000)map.delete(id);while(windows.size>100)windows.delete(windows.keys().next().value);while(snapshots.size>20)snapshots.delete(snapshots.keys().next().value);}
  return async(action,args={},context={})=>{
    guard(context);prune();const scope=context.scope||'local';
    if(action==='desktop_windows'){
      if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>80))return failure('invalid-arguments');
      const result=await run({action:'windows',query:args.query||''},context);guard(context);if(!result.ok)return result;
      const items=(result.windows||[]).slice(0,40).map(item=>{const id=randomUUID();windows.set(id,{...item,scope,at:now()});return{id,title:item.title,application:item.process};});return{ok:true,data:{windows:items,message:items.length?'请选择一个窗口继续查看控件':'没有找到匹配窗口；应用可能尚未打开'}};
    }
    if(action==='desktop_snapshot'){
      const win=windows.get(args.windowId);if(!win||win.scope!==scope)return failure('window-reference-expired','请重新查询窗口。');
      const result=await run({action:'snapshot',window:win},context);guard(context);if(!result.ok)return result;
      const id=randomUUID(),controls=new Map(),items=[];let bytes=0;
      for(const item of (result.nodes||[]).slice(0,60)){
        const ref=randomUUID(),visible={id:ref,name:String(item.name||'').slice(0,100),type:item.type,actions:item.actions||[],...(item.value!==undefined?{value:String(item.value).slice(0,160)}:{})};
        bytes+=JSON.stringify(visible).length;if(bytes>10500)break;controls.set(ref,item);items.push(visible);
      }
      snapshots.set(id,{win,controls,scope,inputs:result.inputs,inputsComplete:result.inputsComplete===true,at:now()});return{ok:true,data:{snapshotId:id,title:win.title,controls:items,message:items.length?'操作前会请用户确认；每次操作后需重新查看窗口。':'此窗口未提供可操作控件，不能凭空点击或宣称已完成。'}};
    }
    if(action!=='desktop_interact')return failure('unsupported-action');
    const snapshot=snapshots.get(args.snapshotId),target=snapshot?.controls.get(args.targetId);
    if(!snapshot||snapshot.scope!==scope||!target)return failure('control-reference-expired','控件引用已失效，请重新查看窗口。');
    if(!['focus','set_value','invoke','select'].includes(args.action)||!target.actions?.includes(args.action)||args.text!==undefined&&(args.action!=='set_value'||typeof args.text!=='string'||args.text.length>2000||/[\u0000-\u001f]/.test(args.text))||args.action==='set_value'&&typeof args.text!=='string')return failure('invalid-control-action');
    if(mutating)return failure('desktop-busy','已有一项窗口操作正在等待确认。');
    if(args.action!=='focus'&&(!snapshot.inputsComplete||!Array.isArray(snapshot.inputs)))return failure('incomplete-window-inputs','窗口内容无法完整核实，请手动操作或重新查看。');
    mutating=true;
    try{
      const labels={set_value:'填写内容',invoke:'点击控件',select:'选择项目',focus:'聚焦控件'};
      const edits=(snapshot.inputs||[]).filter(c=>c.value).map(c=>String(c.name||'输入框')+'：'+c.value).join('\n');
      if(edits.length>6000)return failure('window-inputs-too-large','待确认内容过长，请手动操作。');
      const approved=args.action==='focus'||await confirm({title:'确认操作应用',message:labels[args.action]+' · '+snapshot.win.title,detail:'控件：'+(target.name||target.type)+(args.action==='set_value'?'\n将填写：'+args.text:edits?'\n当前可见输入：\n'+edits:''),confirmLabel:'执行此操作',cancelLabel:'取消'},context);
      guard(context);if(!approved)return failure('user-cancelled','用户取消了此操作，未点击或填写。');
      if(now()-snapshot.at>60000)return failure('control-reference-expired','确认时控件已过期，请重新查看。');
      snapshots.delete(args.snapshotId);
      const result=await run({action:'interact',window:snapshot.win,runtimeId:target.runtimeId,expectedName:target.name,expectedType:target.type,operation:args.action,...(args.action!=='focus'?{expectedInputs:snapshot.inputs}:{}),...(args.text!==undefined?{text:args.text}:{})},context);guard(context);return result;
    }finally{mutating=false;}
  };
}
module.exports={createDesktopAutomation,runAutomation};
