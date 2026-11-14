import { publicInformationRequest } from './public-information-request.js';
import { sessionToken } from '../../../server/accounts.js';
import { isIP } from 'node:net';

export function imageTarget(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('图片地址无效');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')) throw Error('仅支持公网 HTTPS 图片');
  return url;
}
export function readRaster(bytes, mime) {
  const type = String(mime || '').split(';')[0].toLowerCase();
  if (!bytes?.length || bytes.length > 2 * 1024 * 1024) throw Error('图片过大或为空（上限2MB）');
  const png = type === 'image/png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  const webp = type === 'image/webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  if (!png && !jpeg && !webp) throw Error('仅支持 PNG、JPEG、WebP 图片');
  return { bytes, mime: type };
}
function clean(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (known[entity]) return known[entity];
    const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/\s+/g, ' ').trim();
}
export function parseHeadlines(xml) {
  if (typeof xml !== 'string' || xml.length > 512000) throw Error('新闻响应过大');
  const result = [], seen = new Set();
  for (const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const field = key => item[1].match(new RegExp(`<${key}[^>]*>([\\s\\S]*?)<\\/${key}>`, 'i'))?.[1] || '';
    const title = clean(field('title')).slice(0, 140), link = clean(field('link')), date = Date.parse(clean(field('pubDate')));
    let url; try { url = new URL(link); } catch { continue; }
    if (!title || url.protocol !== 'https:' || !['www.chinanews.com.cn', 'www.chinanews.com'].includes(url.hostname) || url.username || url.password || !Number.isFinite(date) || seen.has(link)) continue;
    seen.add(link); result.push({ title, url: url.href, publishedAt: new Date(date).toISOString(), source: '中国新闻网' });
    if (result.length === 12) break;
  }
  return result;
}
export function weatherDescription(code) {
  if (code === 0) return '晴'; if ([1,2].includes(code)) return '多云'; if (code === 3) return '阴';
  if ([45,48].includes(code)) return '雾'; if (code >= 51 && code <= 67) return '雨'; if (code >= 71 && code <= 77) return '雪'; if ([80,81,82].includes(code)) return '阵雨'; if ([85,86].includes(code)) return '阵雪'; if (code >= 95) return '雷雨'; return '天气数据';
}
export function createCompanionFeed({ request = publicInformationRequest, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  async function cached(key, ttl, read) {
    if (cache.get(key)?.expires > now()) return cache.get(key).value;
    if (pending.has(key)) return pending.get(key);
    const job = (async () => { const value = await read(); if (cache.size >= 80) cache.delete(cache.keys().next().value); cache.set(key, { value, expires: now() + ttl }); return value; })();
    pending.set(key, job); try { return await job; } finally { pending.delete(key); }
  }
  async function get(url, stream = false, timeout = 8000) { const res = await request(new URL(url), { stream, signal: AbortSignal.timeout(timeout), headers: { Accept: stream ? '*/*' : 'application/json' } }); if (!res.ok) { res.cancel?.(); throw Error('公开数据源暂时不可用'); } return res; }
  async function bytes(res, limit) { const chunks = []; let length = 0; try { for await (const chunk of res.body) { const value = Buffer.from(chunk); length += value.length; if (length > limit) throw Error('公开数据响应过大'); chunks.push(value); } return Buffer.concat(chunks); } finally { res.cancel?.(); } }
  return {
    async cities(query) {
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 60) throw Error('请输入至少两个字的城市名称');
      return cached('city:' + query.trim(), 3600000, async () => {
        const url = new URL('https://geocoding-api.open-meteo.com/v1/search'); url.search = new URLSearchParams({ name: query.trim(), count: '8', language: 'zh', format: 'json' }).toString();
        const data = await (await get(url)).json();
        return (Array.isArray(data.results) ? data.results : []).filter(city => Number.isFinite(city.latitude) && Math.abs(city.latitude) <= 90 && Number.isFinite(city.longitude) && Math.abs(city.longitude) <= 180 && typeof city.name === 'string').slice(0,8).map(city => ({ name: city.name.slice(0,80), latitude: city.latitude, longitude: city.longitude, region: [city.admin1, city.country].filter(value => typeof value === 'string').join(' · ').slice(0,100) }));
      });
    },
    async weather({ latitude, longitude }) {
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw Error('请选择天气城市');
      latitude = Math.round(latitude * 10000) / 10000; longitude = Math.round(longitude * 10000) / 10000;
      return cached(`weather:${latitude}:${longitude}`, 15 * 60000, async () => {
        const url = new URL('https://api.open-meteo.com/v1/forecast'); url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), current: 'temperature_2m,apparent_temperature,weather_code,is_day', timezone: 'auto' }).toString();
        try {
        const data = await (await get(url,false,3000)).json(), current = data.current;
        if (!Number.isFinite(current?.temperature_2m) || !Number.isFinite(current?.weather_code)) throw Error('天气数据格式异常');
        return { temperature: current.temperature_2m, feelsLike: current.apparent_temperature, description: weatherDescription(current.weather_code), time: typeof current.time === 'string' ? current.time.slice(0,32) : '', source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', checkedAt: new Date(now()).toISOString() };
        } catch {
          const fallback = new URL(`https://wttr.in/${latitude},${longitude}`);fallback.search = 'format=j1&lang=zh';
          const current=(await(await get(fallback,false,7000)).json()).current_condition?.[0];
          const temperature=Number(current?.temp_C),feelsLike=Number(current?.FeelsLikeC);
          if(!current||!Number.isFinite(temperature)||current.temp_C==null||temperature < -100||temperature > 70)throw Error('天气数据格式异常');
          const descriptions={113:'晴',116:'多云',119:'阴',122:'阴',143:'雾',176:'附近有阵雨',179:'附近有阵雪',182:'雨夹雪',185:'冻毛毛雨',200:'雷雨',227:'风雪',230:'暴风雪',248:'雾',260:'冻雾',263:'毛毛雨',266:'毛毛雨',293:'小雨',296:'小雨',299:'中雨',302:'中雨',305:'大雨',308:'大雨',353:'小阵雨',356:'阵雨',359:'强阵雨',386:'雷阵雨',389:'雷雨'};
          const description=descriptions[Number(current.weatherCode)]||String(current.weatherDesc?.[0]?.value||'天气数据').slice(0,80);
          return {temperature,feelsLike:current.FeelsLikeC!=null&&Number.isFinite(feelsLike)?feelsLike:undefined,description,time:typeof current.localObsDateTime==='string'?current.localObsDateTime.slice(0,40):'',source:'wttr.in · WWO',sourceUrl:'https://wttr.in/',checkedAt:new Date(now()).toISOString()};
        }
      });
    },
    news() { return cached('news', 15 * 60000, async () => parseHeadlines((await bytes(await get('https://www.chinanews.com.cn/rss/scroll-news.xml', true), 512000)).toString('utf8'))); },
    async image(url) { const target = imageTarget(url), res = await get(target, true); return readRaster(await bytes(res, 2 * 1024 * 1024), res.headers?.get('content-type')); },
  };
}
export function createCompanionFeedRoutes({ accounts, companionRequest, companionFeed }) {
  const feed = companionFeed || createCompanionFeed({ request: companionRequest });
  const limits = new Map(); let inFlight = 0;
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/assistant/companion/')) return false;
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
    const token = sessionToken(req);
    if (!accounts.session(token)) { reply(401, { error: '请先登录 ATB' }); return true; }
    if (!['GET','HEAD'].includes(req.method)) { reply(405,{error:'请求方法无效'}); return true; }
    if (!['cities','weather','news','image'].includes(pathname.split('/').at(-1))) { reply(404,{error:'接口不存在'}); return true; }
    if (req.method === 'HEAD') { reply(200,{}); return true; }
    const at = Date.now();
    for(const [key,item] of limits)if(item.until<=at&&!item.active)limits.delete(key);
    let quota=limits.get(token);
    if(!quota){if(limits.size>=1000){reply(429,{error:'请求过于频繁'});return true;}quota={count:0,active:0,until:at+60000};limits.set(token,quota);}
    if(quota.until<=at){quota.until=at+60000;quota.count=0;}
    if(quota.count>=20||quota.active>=3||inFlight>=8){reply(429,{error:'请求过于频繁，请稍后再试'});return true;}
    quota.count++;quota.active++;inFlight++;
    try {
      const url = new URL(req.url, 'https://localhost'), kind = pathname.split('/').at(-1); let value;
      if (kind === 'cities') value = { cities: await feed.cities(url.searchParams.get('q')) };
      if (kind === 'weather') value = await feed.weather({ latitude: url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : NaN, longitude: url.searchParams.has('lon') ? Number(url.searchParams.get('lon')) : NaN });
      if (kind === 'news') value = { items: await feed.news() };
      if (kind === 'image') value = await feed.image(url.searchParams.get('url'));
      if (!accounts.session(token)) reply(401, { error: '登录已过期' });
      else if (kind === 'image') { res.writeHead(200,{ 'Content-Type': value.mime, 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store' }); res.end(value.bytes); }
      else reply(200,value);
    } catch { reply(502,{error:'信息暂时无法获取，请检查城市或稍后重试。'}); }
    finally {quota.active--;inFlight--;}
    return true;
  };
}
