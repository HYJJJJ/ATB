import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionFeedRoutes} from '../server/companion-feed.js';
import {SESSION_COOKIE} from '../../../server/accounts.js';
test('feed authenticates before and after work and limits expensive reads',async()=>{
 let session={username:'fixture'},calls=0,release;const route=createCompanionFeedRoutes({accounts:{session:()=>session},companionRequest:async()=>{calls++;await new Promise(r=>release=r);return {ok:true,json:async()=>({results:[]})};}});
 const req={method:'GET',headers:{cookie:SESSION_COOKIE+'=fixture'},url:'/api/assistant/companion/cities?q=Shanghai'};const response=()=>({writeHead(code){this.code=code;return this;},end(body){this.body=body;}});
 session=null;let res=response();await route(req,res,'/api/assistant/companion/cities');assert.equal(res.code,401);assert.equal(calls,0);
 session={username:'fixture'};res=response();const job=route(req,res,'/api/assistant/companion/cities');await new Promise(r=>setImmediate(r));session=null;release();await job;assert.equal(res.code,401);
 session={username:'fixture'};const responses=[];for(let i=0;i<25;i++){const out=response();await route(req,out,'/api/assistant/companion/cities');responses.push(out.code);}assert.ok(responses.includes(429));
});
test('public feed validates city, maps weather and caches fixed upstream sources',async()=>{
 const { createCompanionFeed }=await import('../server/companion-feed.js');let calls=0;const feed=createCompanionFeed({request:async url=>{calls++;const u=new URL(url);if(u.hostname==='geocoding-api.open-meteo.com')return {ok:true,json:async()=>({results:[{name:'上海',latitude:31.22,longitude:121.45,country:'中国',admin1:'上海市'}]})};return {ok:true,json:async()=>({current:{temperature_2m:21.5,apparent_temperature:20,weather_code:3,is_day:1,time:'2026-11-14T14:00'},current_units:{temperature_2m:'°C'}})};}});
 const cities=await feed.cities('上海');assert.equal(cities[0].name,'上海');
 const weather=await feed.weather({latitude:31.22,longitude:121.45});assert.equal(weather.temperature,21.5);assert.equal(weather.description,'阴');assert.equal(weather.source,'Open-Meteo');
 await feed.weather({latitude:31.22,longitude:121.45});assert.equal(calls,2);await assert.rejects(feed.weather({latitude:100,longitude:0}));
});
test('weather falls back to a public source when Open-Meteo is unavailable',async()=>{
 const {createCompanionFeed}=await import('../server/companion-feed.js');let calls=0;
 const feed=createCompanionFeed({request:async url=>{calls++;if(url.hostname==='api.open-meteo.com')throw Error('network');assert.equal(url.hostname,'wttr.in');return {ok:true,json:async()=>({current_condition:[{temp_C:'19',FeelsLikeC:'21',weatherCode:'176',weatherDesc:[{value:'Patchy rain nearby'}]}]})};}});
 const result=await feed.weather({latitude:31.22,longitude:121.46});assert.equal(result.temperature,19);assert.match(result.source,/wttr/);assert.equal(calls,2);await feed.weather({latitude:31.22,longitude:121.46});assert.equal(calls,2);
});
test('news keeps source and publication time, strips markup and rejects dangerous links',async()=>{
 const { parseHeadlines }=await import('../server/companion-feed.js');const xml='<rss><channel><item><title><![CDATA[<b>标题</b> &amp; 测试]]></title><link>https://www.chinanews.com.cn/2026/a.shtml</link><pubDate>Sat, 14 Nov 2026 02:00:00 GMT</pubDate></item><item><title>恶意</title><link>javascript:alert(1)</link></item></channel></rss>';
 const news=parseHeadlines(xml);assert.equal(news.length,1);assert.equal(news[0].title,'标题 & 测试');assert.ok(news[0].publishedAt);assert.equal(news[0].source,'中国新闻网');
});
test('explicit image loader refuses internal destinations and requires a real bounded raster',async()=>{
 const { imageTarget, readRaster }=await import('../server/companion-feed.js');
 for(const url of ['http://example.com/a.png','https://127.0.0.1/a','https://u:p@example.com/a','https://example.com:8443/a','file:///a'])assert.throws(()=>imageTarget(url));
 assert.equal(imageTarget('https://images.example.com/a.png').hostname,'images.example.com');
 const fake=Buffer.from('<svg onload="alert(1)"/>');assert.throws(()=>readRaster(fake,'image/png'));assert.throws(()=>readRaster(Buffer.alloc(4*1024*1024+1),'image/png'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNn8AAAAASUVORK5CYII=','base64');assert.equal(readRaster(png,'image/png').mime,'image/png');
});
