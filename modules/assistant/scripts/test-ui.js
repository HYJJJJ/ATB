import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(moduleRoot, 'module.json'), 'utf8'));
const evidence = path.resolve('test-results/atb');
await mkdir(evidence, { recursive: true });
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = manifest.assets[pathname];
  if (['/ui.css', '/ui.js', '/ai-presets.js', '/model-content.js'].includes(pathname)) { res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(path.resolve('public' + pathname))); return; }
  if (!filename) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
  let content = await readFile(path.join(moduleRoot, filename));
  // Expose the production voice-to-chat callback only in this isolated fixture.
  // The product has no manual composer or test-only global.
  if (filename.endsWith('assistant-voice.js')) content = content.toString().replace('  let generation =', '  globalThis.testSubmitVoice = sendMessage;\n  let generation =');
  if (filename.endsWith('/assistant.js')) content = content.toString().replace('const opportunityTimer =', 'globalThis.testOpportunityPoll = force => opportunityClient.poll(force);\nconst opportunityTimer =');
  res.end(content);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.addInitScript(() => {
    window.testSpeech = []; window.testSpeechFailure = false; let timer;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [],
      cancel: () => clearTimeout(timer),
      speak: utterance => { window.testSpeech.push(utterance.text); timer = setTimeout(() => window.testSpeechFailure ? utterance.onerror({ error: 'synthesis-failed' }) : utterance.onend(), 150); },
    } });
    window.Audio = function(url) { const element = document.createElement('audio'); element.src = url; element.play = async () => { if (window.testSpeechFailure) throw Error('test playback failure'); window.testSpeech.push('played'); element.onplaying?.(); setTimeout(() => element.onended?.(), 150); }; return element; };
    navigator.mediaDevices.getUserMedia = async () => { throw Error('Read-aloud must not request a microphone'); };
  });
  const errors = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => unexpected.push(socket.url()));
  let settings = { name: '测试助手', prompt: '', memory: '', provider: 'custom', protocol: 'chat', baseUrl: '', model: '', hasApiKey: true, apiSource: 'platform', selectedModels: ['platform-one', 'platform-two'], model: 'platform-one', baseUrl: 'https://example.com/v1' };
  let sessionOffline = false;
  let settingsGets = 0, expectedChatModel = 'second-model', holdChat, releaseChat;
  let volcBalance = { kind: 'unconfigured' }, chatBalance = { kind: 'unconfigured' }; const spokenTexts = [];
  const balanceRequests = [], presenceRequests = [], opportunityRequests = []; let opportunityReply = '';
  const memoryHook = '争吵后他说愿意继续沟通';
  let memoryState = {version:2,core:[{emotion:'争吵',content:memoryHook}],light:[{category:'activeTopic',content:'<img src=x onerror=alert(1)>'}],lastPruneAt:null,report:null};
  const memoryRequests = [];
  let voiceSettings = { enabled: false, provider: 'qwen3tts', voice: 'qwen3tts:serena', rate: 0, volume: 0, pitch: 0, silenceMs: 1000, autoListen: true, voiceCatalog: [{ id: 'qwen3tts:serena', name: '清晰', locale: 'zh-CN', gender: 'Female' }, { id: 'qwen3tts:sohee', name: '沉稳', locale: 'zh-CN', gender: 'Female' }] };
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let value;
    if (pathname === '/api/auth/session' && sessionOffline) { await route.abort('failed'); return; }
    if (pathname === '/api/auth/session') value = { user: { username: 'test-admin', role: 'admin' }, needsSetup: false };
    else if (pathname === '/api/assistant/voice/status') value = { available: false, synthesisAvailable: true, synthesis: 'Qwen3-TTS', pid: null, settings: voiceSettings };
    else if (pathname === '/api/assistant/voice/settings') { voiceSettings = { ...voiceSettings, ...request.postDataJSON() }; value = voiceSettings; }
    else if (pathname === '/api/assistant/voice/catalog') value = { voices: request.postDataJSON().provider === 'volcengine' ? [{id:'zh_female_wanwanxiaohe_moon_bigtts',name:'湾湾小何',locale:'zh-CN',gender:'Female',resourceId:'seed-tts-1.0'}] : voiceSettings.voiceCatalog };
    else if (pathname === '/api/assistant/voice/open') value = {leaseId:'ui-test'};
    else if (pathname === '/api/assistant/voice/speak') { spokenTexts.push(request.postDataJSON().text); value = { audio:'UklGRg==', mime:'audio/wav' }; }
    else if (pathname === '/api/assistant/voice/close') value = {};
    else if (pathname === '/api/assistant/balance') { balanceRequests.push(request.url()); value = chatBalance; }
    else if (pathname === '/api/assistant/presence') { if (request.method() === 'POST') presenceRequests.push(request.postDataJSON()); value = {}; }
    else if (pathname === '/api/assistant/opportunity') { if(request.method()==='POST') { opportunityRequests.push(request.postDataJSON()); value={reply:opportunityReply,action:opportunityReply?'chat':'none'}; opportunityReply=''; } else value={todayCount:1,chatCount:0,nextAt:Date.now()+3600000,outcomes:[{ts:Date.now(),woke:true,action:'none',detail:'none',roll:0.24,hit:true,postponed:false}]}; }
    else if (pathname === '/api/assistant/memory') {
      if (request.method() === 'POST') { const body=request.postDataJSON(); memoryRequests.push(body);
        if(body.action==='clear') memoryState={...memoryState,core:[],light:[],report:null};
        if(body.action==='prune') memoryState={...memoryState,lastPruneAt:new Date().toISOString(),report:{date:'2026-11-14',kept:memoryState.core.map(item=>({type:'core',content:item.content})),removed:[{type:'pendingThought',content:'过期的想法',reason:'expired'}],rejected:[{type:'draft',reason:'protected-or-invalid-target'}]}};
      } value=memoryState;
    }
    else if (pathname === '/api/platform/billing/volcengine/balance') { balanceRequests.push(request.url()); value = volcBalance; }
    else if (pathname === '/api/assistant/settings') {
      if (request.method() === 'GET') settingsGets++;
      if (request.method() === 'POST') { const body = request.postDataJSON(); delete body.scope; settings = { ...settings, ...body, hasApiKey: Boolean(body.apiKey) || settings.hasApiKey }; delete settings.apiKey; delete settings.clearKey; }
      value = settings;
    } else if (pathname === '/api/assistant/models') value = { models: ['test-model', 'second-model', 'unselected-model'] };
    else if (pathname === '/api/assistant/chat') { assert.equal(request.postDataJSON().model, expectedChatModel); if (holdChat) await new Promise(resolve => { releaseChat = resolve; }); value = { reply: '已收到测试消息' }; }
    else { unexpected.push(pathname); value = {}; }
    await route.fulfill({ json: value });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/modules/assistant/');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#service-status').dataset.state === 'connected');
  assert.equal(await page.locator('#service-status').evaluate(el=>getComputedStyle(el).color),'rgb(111, 204, 162)');
  sessionOffline = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#service-status').dataset.state === 'retrying');
  assert.equal(await page.locator('#service-status').evaluate(el=>getComputedStyle(el).color),'rgb(234, 178, 91)');
  await page.waitForFunction(() => document.querySelector('#service-status').dataset.state === 'offline');
  assert.equal(await page.locator('#service-status').evaluate(el=>getComputedStyle(el).color),'rgb(242, 119, 125)');
  sessionOffline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#service-status').dataset.state === 'connected');
  await page.waitForFunction(() => document.querySelector('#speech-api-balance').dataset.level === 'free');
  assert.equal(await page.locator('#speech-api-balance i').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(111, 204, 162)');
  await page.locator('[data-page=voice]').click();
  for(const width of [390,1366,1920]) {
    await page.setViewportSize({width,height:900});
    const geometry=await page.locator('#voice-form').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};});
    assert.ok(Math.abs(geometry.left-(width-geometry.right))<3,'voice settings are centered');
    if(width>=1366)assert.ok(geometry.width>=1100,'desktop form uses the available canvas');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(evidence,'settings-layout-'+width+'.png')});
  }
  const group=page.locator('#voice-form>.atb-settings-section').nth(1);
  assert.equal(await group.count(),1);
  const previous=await page.locator('#voice-name').inputValue();
  await group.locator(':scope>summary').click();
  assert.equal(await page.locator('#voice-picker').isVisible(),false);
  await group.locator(':scope>summary').click();
  assert.equal(await page.locator('#voice-name').inputValue(),previous,'folding retains selected voice');
  assert.ok(await page.locator('#voice-form>.atb-settings-section').evaluateAll(elements=>elements.slice(1).every((el,i)=>el.getBoundingClientRect().top-elements[i].getBoundingClientRect().bottom>=18)),'groups have visible gaps');
  await page.setViewportSize({width:1366,height:900});
  await page.locator('[data-page=assistant]').click();
  await page.locator('#persona-form').evaluate(node => { node.closest('details').open = true; });
  assert.equal(await page.locator('#responseStyle').inputValue(), 'natural');
  assert.equal(await page.locator('#followUpQuestions').isChecked(), true);
  assert.equal(await page.locator('#proactiveChat').isChecked(), false);
  await page.locator('#responseStyle').selectOption('talkative');
  await page.locator('#proactiveChat').check(); await page.locator('#opportunityProbability').fill('0.6'); await page.locator('#opportunityDailyLimit').fill('6');
  await page.locator('#persona-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#persona-result').textContent === '已保存');
  assert.equal(settings.responseStyle,'talkative'); assert.equal(settings.proactiveChat,true); assert.equal(settings.opportunityProbability,0.6); assert.equal(settings.opportunityDailyLimit,6);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#responseStyle').inputValue(),'talkative'); assert.equal(await page.locator('#proactiveChat').isChecked(),true);
  for (const width of [390,1366]) {
    await page.setViewportSize({width,height:960});
    await page.locator('#persona-form').evaluate(el=>{el.closest('details').open=true;});
    await page.locator('#responseStyle').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(evidence,`conversation-settings-${width}.png`)});
  }

  await page.locator('#persona-form').evaluate(node => { node.closest('details').open = true; });
  await page.locator('#proactiveChat').uncheck(); await page.locator('#persona-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#persona-result').textContent === '已保存');

  await page.waitForFunction(() => document.querySelector('#auto-memory').textContent.includes('争吵后他说愿意继续沟通'));
  assert.equal(await page.locator('#working-memory img').count(),0,'working memory renders as text');
  assert.match(await page.locator('#working-memory').textContent(), /<img src=x/);
  assert.equal(await page.locator('[id*=diary]').count(),0,'no diary reader in owner interface');
  assert.equal(await page.locator('#transcript').isVisible(), false);
  assert.equal(await page.locator('#voice-orb').isVisible(), true);
  assert.equal(await page.locator('.api-balance-box').count(), 2);
  await page.waitForFunction(() => document.querySelector('#speech-balance-value').textContent === '本地免费');
  await page.waitForFunction(() => document.querySelector('#chat-balance-value').textContent === '未配置');
  assert.equal(await page.locator('.balance-settings').getAttribute('href'), '/platform#settings/ai');
  for (const [amount,level] of [['0','low'],['4.99','low'],['5','medium'],['15','medium'],['15.01','high']]) {
    chatBalance = {kind:'balance',scope:'account',amounts:[{currency:'CNY',amount}]};
    await page.locator('#refresh-balance').click();
    await page.waitForFunction(({amount,level}) => document.querySelector('#chat-balance-value').textContent === '¥'+amount && document.querySelector('#chat-api-balance').dataset.level === level, {amount,level});
    assert.equal(new URL(balanceRequests.at(-1)).searchParams.get('refresh'), '1');
    assert.equal(await page.locator('#chat-api-balance').getAttribute('title'), '', 'a normal balance has no explanatory tooltip');
    await page.locator('#chat-api-balance').click();
    assert.equal(await page.locator('dialog[open]').count(), 0, 'a normal balance never opens the old threshold explanation');

  }
  chatBalance = {kind:'quota',unlimited:true}; await page.locator('#refresh-balance').click();
  await page.waitForFunction(() => document.querySelector('#chat-balance-value').textContent === '余额未开放');
  await page.locator('#chat-api-balance').click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').textContent(), /允许查询用户额度/);
  await page.getByRole('dialog').getByRole('button', {name:'确定',exact:true}).click();
  await page.locator('#chat-api-balance').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#chat-api-balance').getAttribute('data-level'),'unknown');
  chatBalance = {kind:'unavailable'}; await page.locator('#refresh-balance').click();
  await page.waitForFunction(() => document.querySelector('#chat-balance-value').textContent === '暂不可用');
  assert.equal(await page.locator('#chat-api-balance').getAttribute('data-level'),'unknown');
  assert.equal(balanceRequests.some(url=>url.includes('/billing/')),false,'local synthesis never queries a cloud account');
  await page.locator('#auto-memory').evaluate(node => { node.closest('details').open = true; });
  await page.locator('.memory-preferences').evaluate(node => { node.open = true; });
  await page.locator('#memory-mode').selectOption('off');
  await page.locator('#context-turns').selectOption('1');
  await page.locator('#memory-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#memory-result').textContent === '已保存');
  assert.equal(settings.memoryMode, 'off'); assert.equal(settings.contextTurns, 1);
  await page.locator('[data-page=model]').click();
  assert.equal(await page.locator('#api-source').inputValue(), 'platform');
  assert.match(await page.locator('#key-state').textContent(), /已配置|已保存/);
  await page.locator('#api-source').selectOption('custom');
  await page.locator('#base-url').fill('https://example.com/v1');
  await page.locator('#api-key').fill('test-key');
  await page.locator('#model').fill('test-model');
  await page.locator('#load-models').click();
  await page.locator('#model-dialog').waitFor({ state: 'visible' });
  await page.locator('#model-filter').fill('second');
  await page.getByRole('checkbox', { name: 'second-model', exact: true }).check();
  await page.locator('#apply-models').click();
  await page.locator('#model-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#model-result').textContent === '已保存');
  await page.locator('[data-page=assistant]').click();
  const centeredVoice = await page.locator('#voice-stage').boundingBox();
  await page.locator('#toggle-transcript').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#transcript')).opacity === '1');
  const shiftedVoice = await page.locator('#voice-stage').boundingBox(), journal = await page.locator('#transcript').boundingBox();
  assert.ok(shiftedVoice.x < centeredVoice.x - 100, 'opening the journal moves the whole voice companion left');
  assert.ok(journal.x > shiftedVoice.x + shiftedVoice.width - 10, 'journal floats to the right without covering the voice companion');
  assert.ok(journal.width < 520 && journal.height <= 510, 'journal stays compact');
  assert.equal(await page.locator('#transcript input, #transcript textarea, #transcript form').count(), 0, 'transcript is a read-only conversation log');
  await page.locator('#messages').focus();
  await page.evaluate(() => document.querySelector('#toggle-transcript').click());
  assert.equal(await page.locator('#transcript').evaluate(node => node.inert), true, 'closing journal immediately leaves the tab order');
  assert.equal(await page.locator('#toggle-transcript').evaluate(node => node === document.activeElement), true);
  await page.evaluate(() => document.querySelector('#toggle-transcript').click());
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#transcript').isVisible(), true, 'rapid reopen must cancel deferred hide');
  await page.locator('#chat-model').selectOption('second-model');
  await page.evaluate(() => window.testSubmitVoice('测试消息', { fromVoice: true }));
  await page.locator('.bubble.assistant').waitFor();
  assert.match(await page.locator('.bubble.assistant').textContent(), /已收到测试消息/);
  assert.equal(await page.locator('[data-page=camera], #page-overview').count(), 0);
  assert.equal(await page.getByRole('link', { name: '返回工作台', exact: true }).count(), 1);
  assert.equal(await page.locator('#connection, #logout').count(), 0);
  assert.equal(await page.locator('.bubble.assistant .message-speak').count(), 1);
  assert.equal(await page.locator('.message-memory, .message-actions').count(), 0);
  assert.equal(await page.locator('.bubble.assistant .message-speak').textContent(), '');
  assert.equal(await page.locator('.bubble.assistant .message-body > .message-speak').count(), 1);
  await page.locator('.bubble.assistant .message-speak').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.testSpeech.length === 1);
  assert.equal(spokenTexts[0], '已收到测试消息');
  assert.match(await page.locator('#voice-live').textContent(), /Qwen3-TTS/);
  await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
  await page.locator('[data-page=voice]').click();
  await page.locator('#voice-picker-trigger').click();
  await page.locator('#voice-search').fill('不存在的音色');
  assert.equal(await page.locator('#voice-picker-options [role=option]').count(), 0);
  assert.equal(await page.getByText('没有匹配的音色', {exact:true}).isVisible(), true);
  assert.equal(await page.locator('#voice-name').inputValue(), 'qwen3tts:serena');
  await page.locator('#voice-search').fill('沉稳');
  assert.equal(await page.locator('#voice-picker-options [role=option]').count(), 1);
  await page.locator('#voice-search').press('Enter');
  assert.equal(await page.locator('#voice-search').isVisible(), false);
  assert.equal(await page.locator('#voice-name').inputValue(), 'qwen3tts:sohee');
  await page.locator('#voice-picker-trigger').click();
  await page.locator('#voice-search').fill('清晰');
  await page.locator('#voice-search').press('Escape');
  assert.equal(await page.locator('#voice-name').inputValue(), 'qwen3tts:sohee');
  await page.locator('#voice-barge-threshold').evaluate(el => { el.value = '18'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#voice-barge-duration').selectOption('800');
  for (const [id, value] of [['voice-rate', 37], ['voice-volume', -10], ['voice-pitch', 0]]) await page.locator('#' + id).evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-result').textContent === '全部语音设置已保存');
  assert.equal(voiceSettings.voice, 'qwen3tts:sohee'); assert.equal(voiceSettings.rate, 37); assert.equal(voiceSettings.volume, -10); assert.equal(voiceSettings.pitch, 0);
  assert.equal(voiceSettings.bargeInThreshold, 18); assert.equal(voiceSettings.bargeInDurationMs, 800);
  assert.equal(await page.locator('#voice-barge-threshold-value').textContent(), '18%');
  await page.locator('#voice-barge-in').uncheck();
  assert.equal(await page.locator('#voice-barge-threshold').isDisabled(), true);
  await page.locator('#voice-barge-in').check();
  assert.equal(await page.locator('#voice-barge-threshold').isDisabled(), false);
  await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-result').textContent === '全部语音设置已保存');
  assert.equal(await page.locator('#voice-rate-value').textContent(), '+37%');
  await page.evaluate(() => { window.testSpeechFailure = true; });
  await page.locator('#voice-preview').click();
  await page.waitForFunction(() => document.querySelector('#voice-result').textContent.includes('允许声音播放'));
  assert.equal(await page.locator('#voice-preview-stop').isVisible(), false);
  await page.screenshot({ path: path.join(evidence, 'assistant-voice-controls.png'), fullPage: true });
  await page.locator('[data-page=assistant]').click();
  await page.locator('#persona-form').evaluate(node => { node.closest('details').open = true; });
  const layout = await page.evaluate(() => ({chat: document.querySelector('.chat').getBoundingClientRect().bottom, persona: document.querySelector('#persona-form').getBoundingClientRect().top}));
  assert.ok(layout.persona >= layout.chat);
  assert.equal(await page.locator('#memory').count(), 0, 'no manual memory editor');
  await page.locator('#memory-mode').selectOption('summary');
  assert.equal(await page.locator('#memory-state').textContent(), '未保存');
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
  await page.screenshot({ path: path.join(evidence, 'assistant-ui.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => {
    const voice = document.querySelector('#voice-stage').getBoundingClientRect(), panel = document.querySelector('#transcript').getBoundingClientRect();
    const orbit = document.querySelector('.voice-orbit').getBoundingClientRect();
    return panel.top >= voice.bottom - 1 && orbit.left >= 0 && orbit.right <= innerWidth;
  });
  await page.waitForTimeout(380);
  const mobileLayout = await page.evaluate(() => {
    const voice = document.querySelector('#voice-stage').getBoundingClientRect(), panel = document.querySelector('#transcript').getBoundingClientRect();
    return { voiceLeft: voice.left, voiceRight: voice.right, voiceBottom: voice.bottom, panelTop: panel.top };
  });
  assert.ok(mobileLayout.voiceLeft >= 0 && mobileLayout.voiceRight <= 390, 'mobile voice companion must stay inside the viewport');
  assert.ok(mobileLayout.panelTop >= mobileLayout.voiceBottom, 'mobile journal stacks below all voice controls');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, 'assistant-mobile.png'), fullPage: true });
  await page.locator('#prompt').fill('尚未保存的角色草稿');
  await page.locator('[data-page=model]').click();
  await page.locator('#api-key').fill('unsaved-key-draft');
  await page.locator('[data-page=assistant]').click();
  settings = { ...settings, apiSource: 'platform', selectedModels: ['new-platform-model'], model: 'new-platform-model' };
  const previousGets = settingsGets;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#chat-model').value === 'new-platform-model');
  assert.ok(settingsGets > previousGets);
  assert.equal(await page.locator('#prompt').inputValue(), '尚未保存的角色草稿');
  assert.equal(await page.locator('#api-key').inputValue(), 'unsaved-key-draft');
  assert.equal(await page.locator('#memory-state').textContent(), '未保存');
  settings = { ...settings, selectedModels: ['newest-platform-model'], model: 'newest-platform-model' };
  expectedChatModel = 'newest-platform-model'; holdChat = true;
  await page.evaluate(() => { window.testSending = window.testSubmitVoice('发送前校准平台模型', { fromVoice: true }); });
  const chatDeadline = Date.now() + 5000;
  while (!releaseChat && Date.now() < chatDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseChat, 'the next message must reach chat with the refreshed model');
  assert.equal(await page.locator('#chat-model').inputValue(), 'newest-platform-model');
  settings = { ...settings, selectedModels: ['later-platform-model'], model: 'later-platform-model' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#chat-model').inputValue(), 'newest-platform-model', 'background refresh must not change a running chat model');
  holdChat = false; releaseChat();
  await page.evaluate(() => window.testSending);
  assert.equal(await page.locator('#prompt').inputValue(), '尚未保存的角色草稿');
  assert.equal(await page.locator('#api-key').inputValue(), 'unsaved-key-draft');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.orbit-path').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('.voice-orb').evaluate(node => getComputedStyle(node).transform), 'none');
  await page.locator('#toggle-transcript').click();
  assert.equal(await page.locator('#transcript').isVisible(), false, 'reduced motion closes without a timer');
  await page.locator('#toggle-transcript').click();
  assert.equal(await page.locator('#transcript').isVisible(), true);
  assert.equal(await page.locator('#chat-api-balance i').evaluate(node=>getComputedStyle(node).animationName),'none');
  await page.locator('[data-page=voice]').click();
  await page.locator('#voice-provider').selectOption('volcengine');
  await page.waitForFunction(() => document.querySelector('#voice-name').value === 'zh_female_wanwanxiaohe_moon_bigtts');
  volcBalance = {kind:'balance',available:'77.0100',cash:'83.01'};
  await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#speech-balance-value').textContent === '77.0100');
  assert.equal(await page.locator('#speech-api-balance').getAttribute('data-level'),'unknown','cash without declared currency never uses a guessed CNY threshold');
  assert.doesNotMatch(await page.locator('#speech-api-balance').textContent(),/83\.01|USD/);
  volcBalance = {kind:'unavailable'}; await page.locator('#refresh-balance').click();
  await page.waitForFunction(() => document.querySelector('#speech-balance-value').textContent === '暂不可用');
  assert.doesNotMatch(await page.locator('#speech-api-balance').getAttribute('title'),/77\.0100/);
  assert.equal(await page.locator('#speech-api-balance i').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(242, 119, 125)');
  await page.locator('#voice-provider').selectOption('qwen3tts');
  await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#speech-balance-value').textContent === '本地免费');
  await page.evaluate(() => window.testSubmitVoice('先别打扰我', {fromVoice:true}));
  assert.ok(presenceRequests.some(body => body.action === 'snooze' && body.minutes === 120));
  await page.locator('[data-page=assistant]').click();
  await page.locator('#auto-memory').evaluate(node=>{node.closest('details').open=true;});
  await page.locator('.memory-prune-report').first().evaluate(node=>{node.open=true;});
  await page.locator('#prune-memory').click();
  await page.waitForFunction(()=>document.querySelector('#memory-prune-report').textContent.includes('争吵后他说愿意继续沟通'));
  assert.ok(memoryRequests.some(body=>body.action==='prune'));
  assert.match(await page.locator('#memory-prune-report').textContent(),/过期的想法/);
  assert.doesNotMatch(await page.locator('#memory-prune-report').textContent(),/expired|protected-or-invalid-target/);
  for(const width of [1366,390]) {
    await page.setViewportSize({width,height:900});
    await page.locator('#memory-prune-report').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(evidence,'layered-memory-'+width+'.png')});
  }
  await page.locator('.memory-preferences').evaluate(node=>{node.open=true;});
  await page.locator('#clear-auto-memory').click();
  await page.waitForFunction(()=>document.querySelector('#auto-memory').textContent.includes('还没有核心记忆'));
  assert.ok(memoryRequests.some(body=>body.action==='clear'));
  assert.match(await page.locator('#working-memory').textContent(),/暂无/);
  await page.locator('#persona-form').evaluate(form=>form.closest('details').open=true);
  await page.locator('#prompt').fill('自然交流');await page.locator('#proactiveChat').check();await page.locator('#persona-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#persona-state').textContent==='已保存');
  const before=await page.locator('.bubble.assistant').count();await page.evaluate(()=>window.testOpportunityPoll(true));assert.equal(await page.locator('.bubble.assistant').count(),before,'none stays silent');
  opportunityReply='刚才想到个有趣的事';await page.evaluate(()=>window.testOpportunityPoll(true));assert.match(await page.locator('#messages').textContent(),/刚才想到个有趣的事/);
  await page.locator('#opportunity-log').evaluate(el=>el.closest('details').open=true);await page.locator('#refresh-opportunity').click();await page.waitForFunction(()=>document.querySelector('#opportunity-log').textContent.includes('选择待着'));
  assert.match(await page.locator('#opportunity-log').textContent(),/掷骰 0.240 命中/);
  for(const width of [1366,390]){await page.setViewportSize({width,height:900});await page.locator('#opportunity-status').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(evidence,'opportunity-'+width+'.png')});}
  assert.equal(await page.locator('#proactiveIdleSeconds').count(),0,'old seconds control removed');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('Assistant UI passed: model save, chat, isolated navigation, desktop/mobile rendering, no page errors or camera network calls.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
