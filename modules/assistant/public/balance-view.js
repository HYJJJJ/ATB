const decimal = value => typeof value === 'string' && /^-?\d{1,16}(?:\.\d{1,10})?$/.test(value);
export function usageView(result = {}) {
  if (['collecting','estimate'].includes(result.kind) && result.method === 'balance-decrease' && ['account','billing'].includes(result.scope) && ['CNY','USD'].includes(result.currency)) {
    if (result.kind === 'collecting') return {title:'消费统计积累中',text:'已开始记录当前账户余额'};
    if (!decimal(result.amount) || Number(result.amount) < 0 || Number(result.amount) > 1e12 || !Number.isFinite(result.observedSeconds) || result.observedSeconds <= 0) return null;
    const minutes=Math.floor(result.observedSeconds/60),duration=minutes>=60?(minutes/60).toFixed(1)+'小时':minutes?minutes+'分钟':'不足1分钟';
    return {title:'近24h余额减少估算',text:(result.currency==='CNY'?'¥':result.currency+' ')+result.amount+' · 已记录'+duration};
  }
  if (result.kind !== 'usage' || result.scope !== 'key' || !['CNY','USD'].includes(result.currency) || !decimal(result.amount) || Math.abs(Number(result.amount)) > 1e12 || !Number.isInteger(result.records) || result.records < 1) return null;
  return {
    title:'近24小时'+(result.coverage === 'window' ? '' : '已查')+(result.refunds ? '净消费' : '消费'),
    text:'当前密钥 '+(result.currency === 'CNY' ? '¥' : result.currency+' ')+result.amount,
  };
}
export function balanceView(result = {}) {
  let text = '暂不可用', title = '暂时无法查询余额，请稍后刷新。', level = 'unknown';
  if (result.kind === 'local') return { text: '本地免费', title: '本地语音合成不消耗语音 API 余额。', level: 'free' };
  if (result.kind === 'balance') {
    const amounts = Array.isArray(result.amounts) ? result.amounts : [];
    const amount = amounts.find(item => item.currency === 'CNY' && decimal(String(item.amount))) || amounts.find(item => /^[A-Z]{3}$/.test(item.currency) && decimal(String(item.amount)));
    if (amount) {
      text = (amount.currency === 'CNY' ? '¥' : amount.currency + ' ') + amount.amount;
      title = `${result.scope === 'billing' ? '接口账单可用金额' : '账户可用余额'}：${text}。`;
      if (amount.currency === 'CNY') level = Number(amount.amount) < 5 ? 'low' : Number(amount.amount) <= 15 ? 'medium' : 'high';
    } else if (decimal(String(result.available))) {
      text = String(result.available); title = '火山账户可用余额（AvailableBalance）。接口未注明币种，按原值显示。';
    }
  } else if (result.kind === 'quota') {
    if (result.reason === 'currency-unavailable') {
      text = '币种未提供'; title = '接口返回了账户额度，但缺少明确的币种或换算单位，暂时无法显示金额。';
    } else {
      text = '余额未开放';
      title = '接口仅返回密钥消费上限，未返回账户余额。请在服务商控制台的 API 密钥（令牌）管理中编辑当前密钥，展开“高级设置”，开启“允许查询用户额度”并保存，然后点击余额刷新。若没有此选项，请联系服务商开放账户余额查询。';
    }
  }
  else if (result.kind === 'unconfigured') { text = '未配置'; title = '尚未配置余额查询凭据；火山账务查询需要单独的 AK/SK。'; }
  else if (result.kind === 'unsupported') { text = '不支持查询'; title = '该厂商未提供当前接口可用的余额查询方式。'; }
  else if (result.kind === 'signedOut') { text = '请先登录'; title = ''; }
  else if (result.kind === 'loading') { text = '检测中'; title = '正在查询余额。'; }
  if (result.checkedAt) title += ' 查询时间：' + new Date(result.checkedAt).toLocaleString();
  return { text, title, level };
}
