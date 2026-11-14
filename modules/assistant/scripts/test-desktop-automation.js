import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url),{createDesktopAutomation}=require('../desktop/desktop-automation.cjs');
const directory=await mkdtemp(path.join(tmpdir(),'atb-uia-')),name='ATB UIA '+path.basename(directory),source=path.join(directory,'fixture.cs'),exe=path.join(directory,'atb-uia-fixture.exe');let child;
try{
 await writeFile(source,`using System;using System.Windows;using System.Windows.Controls;using System.Windows.Automation;
 public class Fixture {
 [STAThread] public static void Main(){var app=new Application();var win=new Window(){Title="${name}",Width=380,Height=180,Left=10,Top=10,ShowInTaskbar=false,ShowActivated=false};
 var panel=new StackPanel(){Margin=new Thickness(15)};var input=new TextBox(){Width=280,Height=26};AutomationProperties.SetName(input,"Test input");
 var result=new TextBlock(){Text="Waiting"};var send=new Button(){Content="Simulate send",Width=140,Height=28,Margin=new Thickness(0,8,0,8)};AutomationProperties.SetName(send,"Simulate send");send.Click+=(s,e)=>{result.Text="Executed: "+input.Text;};panel.Children.Add(input);panel.Children.Add(send);panel.Children.Add(result);win.Content=panel;
 var timer=new System.Windows.Threading.DispatcherTimer(){Interval=TimeSpan.FromSeconds(60)};timer.Tick+=(s,e)=>win.Close();timer.Start();app.Run(win);}}`);
 const framework=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319');
 await promisify(execFile)(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/reference:System.Xaml.dll','/reference:'+path.join(framework,'WPF','PresentationFramework.dll'),'/reference:'+path.join(framework,'WPF','PresentationCore.dll'),'/reference:'+path.join(framework,'WPF','WindowsBase.dll'),'/out:'+exe,source],{windowsHide:true});
 child=spawn(exe,[],{windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});
 let approve=async()=>true;
 const approvals=[],execute=createDesktopAutomation({confirm:async details=>{approvals.push(details);return approve(details);}}),context={scope:'isolated-uia-test'};
 let list;for(let i=0;i<20;i++){list=await execute('desktop_windows',{query:name},context);if(list.ok&&list.data.windows.length)break;await new Promise(r=>setTimeout(r,150));}
 assert.equal(list.ok,true);assert.equal(list.data.windows.length,1);const windowId=list.data.windows[0].id;
 let snap=await execute('desktop_snapshot',{windowId},context);assert.equal(snap.ok,true);let input=snap.data.controls.find(c=>c.name==='Test input');assert.ok(input,JSON.stringify(snap));
 assert.equal((await execute('desktop_interact',{snapshotId:snap.data.snapshotId,targetId:input.id,action:'set_value',text:'你好123'},context)).ok,true);
 snap=await execute('desktop_snapshot',{windowId},context);assert.equal(snap.data.controls.find(c=>c.name==='Test input').value,'你好123');const send=snap.data.controls.find(c=>c.name==='Simulate send');assert.ok(send);
 assert.equal((await execute('desktop_interact',{snapshotId:snap.data.snapshotId,targetId:send.id,action:'invoke'},context)).ok,true);
 snap=await execute('desktop_snapshot',{windowId},context);assert.ok(snap.data.controls.some(c=>c.name==='Executed: 你好123'),JSON.stringify(snap));assert.equal(approvals.length,2);assert.match(approvals[1].detail,/你好123/);
 const pendingText='完整内容'.repeat(60)+'确认结尾';input=snap.data.controls.find(c=>c.name==='Test input');
 assert.equal((await execute('desktop_interact',{snapshotId:snap.data.snapshotId,targetId:input.id,action:'set_value',text:pendingText},context)).ok,true);
 snap=await execute('desktop_snapshot',{windowId},context);
 const other=createDesktopAutomation({confirm:async()=>true});
 approve=async details=>{
  assert.ok(details.detail.includes(pendingText),'approval includes the entire pending content');
  const windows=await other('desktop_windows',{query:name},context),view=await other('desktop_snapshot',{windowId:windows.data.windows[0].id},context),field=view.data.controls.find(c=>c.name==='Test input');
  assert.equal((await other('desktop_interact',{snapshotId:view.data.snapshotId,targetId:field.id,action:'set_value',text:'Changed while confirming'},context)).ok,true);return true;
 };
 assert.equal((await execute('desktop_interact',{snapshotId:snap.data.snapshotId,targetId:snap.data.controls.find(c=>c.name==='Simulate send').id,action:'invoke'},context)).ok,false,'changed text blocks invocation');
 snap=await execute('desktop_snapshot',{windowId},context);assert.ok(snap.data.controls.some(c=>c.name==='Executed: 你好123'),'stale send never reached the button');
 approve=async()=>false;
 assert.equal((await execute('desktop_interact',{snapshotId:snap.data.snapshotId,targetId:snap.data.controls.find(c=>c.name==='Simulate send').id,action:'invoke'},context)).error,'user-cancelled');
 await mkdir('test-results/desktop-automation',{recursive:true});await writeFile('test-results/desktop-automation/real-result.json',JSON.stringify({passed:true,checks:['Own WPF window discovery','UI Automation snapshot','Unicode ValuePattern write','InvokePattern click','Reinspect result','Complete content approval','Changed input blocks click','Cancelled action blocks click'],approvals:approvals.length},null,2));
 console.log('Real Windows UI Automation: 8 checks passed on an isolated test window. No private applications or outgoing messages.');
}finally{
 if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
 assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
