import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createDshAgent } from './dsh-agent.js';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
export const CONVERSATION_TOOLS = [
  { name: 'weather', description: '查询当前天气。省略city使用桌面助手保存城市；明确城市先查城市候选，有歧义须询问用户。用户确认后保留city名称并填region为候选中的省/国家来筛选，不能猜测地区。只提供当前天气，不提供预报。', parameters: object({ city: { type: 'string', minLength: 2, maxLength: 60 }, region: { type: 'string', minLength: 2, maxLength: 100 } }) },
  { name: 'news', description: '查询中国新闻网RSS当前头条，返回真实来源、链接和发布时间；不是通用网络搜索，不支持关键词搜索。', parameters: object({}) },
  { name: 'current_time', description: '查询当前日期时间；可指定IANA时区，默认Asia/Shanghai。', parameters: object({ timeZone: { type: 'string', minLength: 1, maxLength: 80 } }) },
  { name: 'api_balance', description: '只读查询本账户当前对话API余额或配额；区分现金币种、token额度、不支持和查询失败，不提供密钥。', parameters: object({}) },
];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (error, message) => ({ ok: false, error, ...(message ? { message } : {}) });
const cityOf = value => value && typeof value.name === 'string' && value.name.length <= 100 && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
  ? { name: value.name, latitude: value.latitude, longitude: value.longitude, ...(typeof value.region === 'string' ? { region: value.region.slice(0,100) } : {}) } : null;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

export function createConversationTools({ dataDir, feed, readBalance, getSettings, now = Date.now }) {
  return {
    definitions: CONVERSATION_TOOLS,
    async execute(call, { check = () => {}, signal } = {}) {
      const guard = () => { signal?.throwIfAborted(); check(); }; guard();
      const definition = CONVERSATION_TOOLS.find(tool => tool.name === call.name);
      if (!definition) return failure('unsupported-tool', '此工具未接入，未执行；没有执行网络搜索。');
      let args;
      try {
        if (typeof call.arguments !== 'string' || call.arguments.length > 4096) throw Error();
        args = JSON.parse(call.arguments);
        if (!plain(args) || Object.keys(args).some(key => !Object.hasOwn(definition.parameters.properties, key))) throw Error();
        for (const [key, value] of Object.entries(args)) {
          const schema = definition.parameters.properties[key];
          if (typeof value !== 'string' || value.length < schema.minLength || value.length > schema.maxLength || !value.trim() || /[\u0000-\u001f]/.test(value)) throw Error();
        }
        if (args.region && !args.city) throw Error();
      } catch { return failure('invalid-arguments', '参数格式无效，未执行。'); }
      try {
        let data;
        if (call.name === 'current_time') {
          const timeZone = args.timeZone || 'Asia/Shanghai';
          let local;
          try { local = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(now()); } catch { return failure('invalid-time-zone'); }
          data = { timeZone, local, iso: new Date(now()).toISOString(), source: '本机系统时间' };
        } else if (call.name === 'weather') {
          let city;
          if (args.city !== undefined) {
            const cities = (await feed.cities(args.city)).map(cityOf).filter(Boolean).filter(city => !args.region || city.region?.includes(args.region)); guard();
            if (!cities.length) return failure('city-not-found', '未找到城市，请用户提供完整城市名。');
            if (cities.length !== 1) return { ...failure('ambiguous-city', '城市存在歧义，请用户确认候选，不能猜测。'), candidates: cities };
            city = cities[0];
          } else {
            try { city = cityOf(JSON.parse(await readFile(path.join(dataDir, 'platform', 'desktop-companion.json'), 'utf8')).city); } catch { /* Only the selected city is read from this fixed settings file. */ }
            guard(); if (!city) return failure('city-required', '未保存天气城市，请询问用户城市。');
          }
          const weather = await feed.weather(city); guard();
          data = { city, ...pick(weather, ['temperature', 'feelsLike', 'description', 'time', 'source', 'sourceUrl', 'checkedAt']), units: '°C' };
        } else if (call.name === 'news') {
          const items = await feed.news(); guard();
          data = { items: items.slice(0,12).map(item => pick(item, ['title', 'url', 'publishedAt', 'source'])), checkedAt: new Date(now()).toISOString(), source: '中国新闻网 RSS' };
          if (!data.items.length) return failure('no-news', '新闻源没有返回可核实的头条。');
        } else {
          const value = await readBalance(getSettings()); guard();
          data = pick(value, ['kind', 'scope', 'checkedAt', 'unlimited', 'accountBalanceUnavailable', 'reason', 'available']);
          if (Array.isArray(value.amounts)) data.amounts = value.amounts.slice(0,10).map(item => pick(item, ['currency', 'amount']));
          if (value.kind === 'unavailable') return failure('balance-unavailable', '余额查询失败，不能推测余额。');
          if (value.kind === 'unsupported') return failure('balance-unsupported', '此服务商没有可用的余额查询接口，不能推测余额。');
          if (value.kind === 'unconfigured') return failure('balance-unconfigured', '当前对话接口尚未配置。');
          data.source = '当前对话API的余额接口';
        }
        guard();
        if (JSON.stringify(data).length > 12000) return failure('result-too-large');
        return { ok: true, data };
      } catch { guard(); return failure('query-failed', '实时查询失败，请如实告知用户，不能编造查询结果。'); }
    },
  };
}

// Compatibility entry point: DSH is the only ordinary conversation tool loop.
export async function runConversation(options) {
  const agent=createDshAgent({request:options.request});
  try {return await agent.run(options);} finally {await agent.close();}
}
