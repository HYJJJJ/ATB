// Render a small Markdown subset with DOM nodes. Model HTML is always literal text.
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function inline(parent, text) {
  const pattern = /(!?)\[([^\]\n]*)\]\(([^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|https?:\/\/[^\s<>]+/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    let node;
    if (match[4] || match[5] || match[6]) {
      node = document.createElement(match[4] ? 'code' : match[5] ? 'strong' : 'em');
      node.textContent = match[4] || match[5] || match[6];
    } else {
      const url = safeUrl(match[3] || match[0]);
      if (url) {
        node = document.createElement('a'); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer';
        node.textContent = match[1] ? `查看图片：${match[2] || '图片'}` : match[2] || match[0];
      } else node = document.createTextNode(match[0]);
    }
    parent.append(node); cursor = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}
export function renderMessageContent(target, text, { rich = true } = {}) {
  target.replaceChildren();
  if (!rich) { target.textContent = text; return; }
  let pre, list;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      list = null;
      if (pre) pre = null;
      else { const block = document.createElement('pre'); pre = document.createElement('code'); block.append(pre); target.append(block); }
      continue;
    }
    if (pre) { pre.append(document.createTextNode(line + '\n')); continue; }
    const item = /^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const type = item[1] ? 'ul' : 'ol';
      if (!list || list.localName !== type) { list = document.createElement(type); target.append(list); }
      const li = document.createElement('li'); inline(li, item[2]); list.append(li); continue;
    }
    list = null;
    const p = document.createElement('p'), heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { const strong = document.createElement('strong'); inline(strong, heading[1]); p.append(strong); }
    else inline(p, line || '\u00a0');
    target.append(p);
  }
}
const toolLabels={weather:'天气',news:'新闻',current_time:'日期时间',api_balance:'API 余额',web_search:'网页搜索',read_webpage:'网页阅读',open_atb:'打开 ATB',list_applications:'应用列表',open_application:'打开应用',desktop_windows:'应用窗口',desktop_snapshot:'查看应用',desktop_interact:'操作应用',unsupported:'未接入的工具'};
const validTool=tool=>typeof tool?.name==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(tool.name);
export function toolResultLabel(tool){const action=['open_atb','open_application','desktop_interact'].includes(tool?.name)||tool?.name?.startsWith('mcp__');return `${toolLabels[tool?.name]||(validTool(tool)?tool.name:'工具')}${tool?.ok?action?' · 已执行':' · 已查询':action?' · 未完成':' · 未取到结果'}`;}
export function renderToolSources(target,tools){
  target.replaceChildren();target.hidden=!Array.isArray(tools)||!tools.length;
  for(const tool of Array.isArray(tools)?tools.slice(0,6):[]){
    if(!validTool(tool))continue;
    const row=document.createElement('div'),label=document.createElement('span');label.textContent=toolResultLabel(tool);row.append(label);
    for(const item of Array.isArray(tool.sources)?tool.sources.slice(0,3):[]){
      const url=safeUrl(item.url),source=document.createElement(url?'a':'span');
      source.textContent=' · '+String(item.source||item.title||'来源').slice(0,100);
      if(url){source.href=url;source.target='_blank';source.rel='noopener noreferrer';}
      const date=item.publishedAt||item.checkedAt;if(typeof date==='string')source.title=date.slice(0,100);row.append(source);
    }
    target.append(row);
  }
}
