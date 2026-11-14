import test from 'node:test';import assert from 'node:assert/strict';import { createRequire } from 'node:module';import { EventEmitter } from 'node:events';
const require=createRequire(import.meta.url);
test('tray restores main window, hides on close and keeps explicit exit available',()=>{
 const {createDesktopTray}=require('../desktop/tray.cjs');let clicks,quit=0,shown=0;class Tray extends EventEmitter{setToolTip(){}setContextMenu(value){clicks=value}destroy(){this.destroyed=true}isDestroyed(){return !!this.destroyed}}
 const tray=createDesktopTray({electron:{Tray,Menu:{buildFromTemplate:v=>v}},show:()=>shown++,quit:()=>quit++,companion:()=>{},open:()=>{}});
 assert.equal(tray.ready,true);let prevented=false;assert.equal(tray.hideOnClose({preventDefault(){prevented=true}},()=>shown--),true);assert.equal(prevented,true);assert.equal(shown,-1);
 clicks.find(x=>x.label==='打开主界面').click();assert.equal(shown,0);clicks.find(x=>x.label==='退出 ATB').click();assert.equal(quit,1);tray.close();assert.equal(tray.ready,false);
});
