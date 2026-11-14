import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {startServers} from '../../../server/index.js';
import {SESSION_COOKIE} from '../../../server/accounts.js';

test('role tags save, switch immediately, delete independently and retain drafts with themed confirmation',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'persona-tags-ui-'));
 const server=await startServers({lanIp:'127.0.0.1',httpsPort:0,httpPort:0,relayPort:0,publicOrigin:null,dataDir:path.join(dir,'data'),certDir:path.join(dir,'certs')});let browser;
 t.after(async()=>{await browser?.close();await server.close();await rm(dir,{recursive:true,force:true});});
 await server.accounts.setup('role-test','fixture-password');const session=await server.accounts.login('role-test','fixture-password');
 browser=await chromium.launch();const context=await browser.newContext({ignoreHTTPSErrors:true});await context.addCookies([{name:SESSION_COOKIE,value:session.token,domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage({viewport:{width:1366,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(7000);
 await page.goto('https://127.0.0.1:'+server.secure.address().port+'/modules/assistant/#assistant');await page.locator('#workspace').waitFor();await page.locator('#persona-form').evaluate(el=>el.closest('details').open=true);
 assert.equal(await page.locator('#persona-presets').count(),1,'role tags live above the name field');
 const save=async(name,prompt)=>{await page.locator('#name').fill(name);await page.locator('#prompt').fill(prompt);await page.locator('#persona-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#persona-result').textContent==='已保存');};
 const tag=name=>page.getByRole('button',{name:'切换角色：'+name,exact:true});
 const remove=name=>page.getByRole('button',{name:'删除角色预设：'+name,exact:true});
 await page.waitForFunction(()=>document.querySelectorAll('.persona-preset-select').length===5);
 await mkdir('test-results/persona-layout',{recursive:true});
 for(const name of ['小鲸鱼','暖暖','阿策','皮皮','知衡']){
  await tag(name).click();await page.waitForFunction(name=>document.querySelector('#name').value===name,name);
  assert.equal(await page.locator('#persona-state').getAttribute('data-status'),'saved');
  assert.ok((await page.locator('#prompt').inputValue()).length>100);
 }
 for(const width of [390,1366]){
  await page.setViewportSize({width,height:900});await page.locator('#persona-presets').scrollIntoViewIfNeeded();
  const geometry=await page.locator('#persona-presets').evaluate(el=>{const a=el.closest('details').querySelector('summary').getBoundingClientRect(),b=el.getBoundingClientRect(),c=document.querySelector('#name').closest('label').getBoundingClientRect();return {above:b.top-a.bottom,below:c.top-b.bottom};});
  assert.ok(geometry.above<=14&&Math.abs(geometry.above-geometry.below)<=8,JSON.stringify(geometry));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#persona-form').evaluate(el=>el.closest('details').scrollIntoView());await page.screenshot({path:'test-results/persona-layout/presets-'+width+'.png'});
 }
 await page.setViewportSize({width:1366,height:900});
 for(const name of ['暖暖','阿策','皮皮','知衡']){await tag(name).hover();await remove(name).click();await page.waitForFunction(name=>![...document.querySelectorAll('.persona-preset-select')].some(el=>el.textContent===name),name);}

 await save('小鲸鱼','自然短句');await save('小猫','认真回答');assert.equal(await page.locator('.persona-preset-select').count(),2);
 await save('小猫','新的说明');assert.equal(await page.locator('.persona-preset-select').count(),2,'same name updates one tag');
 await tag('小鲸鱼').click();await page.waitForFunction(()=>document.querySelector('#name').value==='小鲸鱼');assert.equal(await page.locator('#prompt').inputValue(),'自然短句');assert.equal(await tag('小鲸鱼').getAttribute('aria-pressed'),'true');
 await page.reload();await page.locator('#workspace').waitFor();await page.locator('#persona-form').evaluate(el=>el.closest('details').open=true);await page.waitForFunction(()=>document.querySelector('#name').value==='小鲸鱼');assert.equal(await page.locator('.persona-preset-select').count(),2);
 const heading=await page.locator('#persona-form').evaluate(el=>{const r=el.closest('details').querySelector('summary').getBoundingClientRect();return {y:r.y,height:r.height};}),tags=await page.locator('#persona-presets').boundingBox(),nameField=await page.locator('#name').boundingBox();assert.ok(tags.y>=heading.y+heading.height&&tags.y+tags.height<=nameField.y,'tags sit between heading and name');
 const badge=page.locator('#persona-state');assert.equal(await badge.evaluate(el=>el.closest('summary')!==null),true,'save badge belongs beside the summary subtitle');
 const gaps=await page.locator('#persona-presets').evaluate(el=>{const summary=el.closest('details').querySelector('summary').getBoundingClientRect(),r=el.getBoundingClientRect(),label=document.querySelector('#name').closest('label').getBoundingClientRect();return {above:r.y-summary.bottom,below:label.y-r.bottom};});assert.ok(gaps.above<=14&&Math.abs(gaps.above-gaps.below)<=8,JSON.stringify(gaps));
 await page.locator('#prompt').fill('还没保存的草稿');await tag('小猫').click();await page.locator('.atb-message-dialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await page.locator('#prompt').inputValue(),'还没保存的草稿');
 await tag('小猫').click();await page.getByRole('button',{name:'放弃修改并切换',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#name').value==='小猫');assert.equal(await page.locator('#prompt').inputValue(),'新的说明');
 await page.mouse.move(0,0);await page.locator('#name').focus();assert.equal(await remove('小鲸鱼').evaluate(el=>getComputedStyle(el).opacity),'0');await tag('小鲸鱼').hover();assert.equal(await remove('小鲸鱼').evaluate(el=>getComputedStyle(el).opacity),'1');
 await remove('小鲸鱼').click();await page.waitForFunction(()=>document.querySelectorAll('.persona-preset-select').length===1);assert.equal(await page.locator('#name').inputValue(),'小猫','deleting a tag must not activate it');
 await tag('小猫').hover();await remove('小猫').click();await page.waitForFunction(()=>document.querySelectorAll('.persona-preset-select').length===0);assert.equal(await page.locator('#name').inputValue(),'小猫','deleting active preset retains current applied persona');
 await page.reload();await page.locator('#workspace').waitFor();await page.locator('#persona-form').evaluate(el=>el.closest('details').open=true);assert.equal(await page.locator('.persona-preset-select').count(),0);
 await save('<img src=x onerror=alert(1)>','名称仅作为文字');await save('很长的角色名称'.repeat(6),'长名称换行测试');assert.equal(await page.locator('#persona-presets img').count(),0);
 await mkdir('test-results/persona-presets',{recursive:true});
 for(const width of [390,1366]){await page.setViewportSize({width,height:900});await page.locator('#persona-presets').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.ok((await page.locator('#persona-form').boundingBox()).width<=width,'role form stays within the viewport with long tags');await page.locator('#persona-form').screenshot({path:'test-results/persona-presets/roles-'+width+'.png'});}
 await tag('<img src=x onerror=alert(1)>').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#name').value==='<img src=x onerror=alert(1)>');
 let arrived,release;const reached=new Promise(r=>arrived=r),held=new Promise(r=>release=r);
 await page.route('**/api/assistant/settings',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}const response=await route.fetch();arrived();await held;await route.fulfill({response});});
 await page.locator('#name').fill('提交中的角色');await page.locator('#prompt').fill('提交的说明');await page.locator('#persona-form [type=submit]').click();await reached;assert.equal(await page.locator('#persona-state').getAttribute('data-status'),'saving');
 await page.locator('#prompt').fill('保存期间的新草稿');release();await page.waitForFunction(()=>document.querySelector('#persona-result').textContent.includes('当前新修改尚未保存'));
 assert.equal(await page.locator('#prompt').inputValue(),'保存期间的新草稿');assert.equal(await tag('提交中的角色').count(),1);assert.equal(await page.locator('#persona-state').textContent(),'未保存');
 await page.unroute('**/api/assistant/settings');
 await page.route('**/api/assistant/settings',async route=>{if(route.request().method()==='POST')await route.fulfill({status:500,json:{error:'模拟预设删除失败'}});else await route.continue();});
 await tag('提交中的角色').hover();await remove('提交中的角色').click();await page.waitForFunction(()=>document.querySelector('#persona-result').textContent.includes('模拟预设删除失败'));assert.equal(await tag('提交中的角色').count(),1);assert.equal(await page.locator('#prompt').inputValue(),'保存期间的新草稿');assert.equal(await page.locator('#persona-state').getAttribute('data-status'),'error');
 await page.unroute('**/api/assistant/settings');
 assert.deepEqual(errors,[]);
});
