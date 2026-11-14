import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { replyBubbleSize, replyBubblePosition, randomBubblePosition } from '../public/companion-policy.js';
const require = createRequire(import.meta.url);

test('a chosen reply side stays fixed when content grows; hints stay close to the head', () => {
  const avatar={x:850,y:330,width:160,height:190};
  for(const contentHeight of [70,300,700]){
    const size=replyBubbleSize({width:1920,height:1080,avatar,contentHeight,side:'above'});
    assert.equal(size.side,'above');assert.equal(size.maxHeight,314);
    const p=replyBubblePosition({width:1920,height:1080,avatar,bubble:{width:size.width,height:Math.min(contentHeight,size.maxHeight)},side:size.side});
    assert.equal(p.y+Math.min(contentHeight,size.maxHeight),322);
    assert.equal(p.x,755);
  }
  for(let i=0;i<100;i++){
    const point=randomBubblePosition({width:1920,height:1080,avatar,bubble:{width:184,height:85}});
    assert.ok(point);const dx=Math.max(avatar.x-point.x-184,point.x-avatar.x-avatar.width,0),dy=Math.max(avatar.y-point.y-85,point.y-avatar.y-75,0);
    assert.ok(Math.hypot(dx,dy)<=70,'hints sit around the head instead of anywhere on the canvas');
  }
});
test('desktop companion preferences persist validated choices without discarding other fields', async t => {
  const { loadCompanionSettings } = require('../desktop/companion-settings.cjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'atb-companion-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'widget.json'), settings = await loadCompanionSettings(file);
  assert.equal(settings.get().enabled,true); assert.equal(settings.get().showText,true); assert.equal(settings.get().city,null);
  await settings.update({news:false, city:{name:'上海',latitude:31.22,longitude:121.45}, position:{x:-520,y:20}});
  await settings.update({showText:false});
  const again = await loadCompanionSettings(file); assert.equal(again.get().news,false); assert.equal(again.get().showText,false); assert.equal(again.get().city.name,'上海'); assert.equal(again.get().position.x,-520);
  await assert.rejects(settings.update({enabled:'false'})); await assert.rejects(settings.update({city:{name:'错误',latitude:200,longitude:0}}));
  await assert.rejects(settings.update({unknown:'field'}));
});
test('random bubble locations vary, stay in bounds and avoid the character', async () => {
  const { randomBubblePosition, nextReminderAt } = await import('../public/companion-policy.js');
  const avatar={x:200,y:190,width:160,height:190};const locations=new Set();let previous;
  for(let n=0;n<100;n++){
    const point=randomBubblePosition({width:560,height:520,avatar,bubble:{width:188,height:100},previous});
    assert.ok(point.x>=8&&point.y>=8&&point.x+188<=552&&point.y+100<=512);
    assert.ok(point.x+188<=avatar.x-6||point.x>=avatar.x+avatar.width+6||point.y+100<=avatar.y-6||point.y>=avatar.y+avatar.height+6);
    locations.add(`${point.x},${point.y}`); previous=point;
  }
  assert.ok(locations.size>50);assert.equal(nextReminderAt(1000,()=>0),241000);assert.equal(nextReminderAt(1000,()=>1),541000);
});
test('edge bubbles avoid visible replies, and no room hides rather than overlaps', async () => {
  const { randomBubblePosition, replyBubblePosition } = await import('../public/companion-policy.js');
  const intersects=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
  for(const center of [{x:35,y:45},{x:525,y:45},{x:35,y:475},{x:525,y:475},{x:280,y:285}]){
    const avatar={x:center.x-80,y:center.y-95,width:160,height:190};
    const reply=replyBubblePosition({width:560,height:520,avatar,bubble:{width:286,height:170}});
    assert.ok(reply,'reply fits at every corner');
    const obstacle={...reply,width:286,height:170};assert.equal(intersects(obstacle,avatar),false);
    const point=randomBubblePosition({width:560,height:520,avatar,bubble:{width:190,height:100},obstacles:[obstacle],random:()=>0});
    assert.ok(point);assert.equal(intersects({...point,width:190,height:100},obstacle),false);
    assert.equal(intersects({...point,width:190,height:100},avatar),false);
    assert.ok(point.x>=8&&point.y>=8&&point.x+190<=552&&point.y+100<=512);
  }
  assert.equal(randomBubblePosition({width:200,height:200,avatar:{x:0,y:0,width:200,height:200},bubble:{width:190,height:155}}),null);
});

test('reply space grows above the character with its content and only stops at screen edges', async () => {
  const { replyBubbleSize, replyBubblePosition } = await import('../public/companion-policy.js');
  const avatar = { x: 1040, y: 800, width: 160, height: 190 };
  for (const contentHeight of [100, 350, 650]) {
    const size = replyBubbleSize({ width: 1280, height: 1080, avatar, contentHeight });
    assert.ok(size.maxHeight >= contentHeight, 'available screen space must not have a 300px ceiling');
    const point = replyBubblePosition({ width: 1280, height: 1080, avatar, bubble: { width: size.width, height: contentHeight } });
    assert.equal(point.y + contentHeight, 792, 'growing text keeps the lower edge beside the character and extends upward');
    assert.ok(point.x >= 8 && point.x + size.width <= 1272);
  }
});
