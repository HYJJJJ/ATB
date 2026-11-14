import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, _electron as electron } from 'playwright';
import { startServers } from '../../../server/index.js';

const root = path.resolve('.'), evidence = path.join(root, 'test-results/low-latency-voice');
const desktop = process.argv.includes('--desktop');
const bargeIn = process.argv.includes('--barge-in');
const pcmMode = process.argv.includes('--pcm');
const proactiveMode = process.argv.includes('--proactive');
await mkdir(evidence, { recursive: true });
const dir = await mkdtemp(path.join(evidence, 'ui-profile-')), assistant = path.join(dir, 'data/assistant');
await mkdir(assistant, { recursive: true });
for (const name of ['voice-runtime', 'tts-runtime', 'qwen-tts-runtime', 'models']) await symlink(path.join(root, 'data/assistant', name), path.join(assistant, name), process.platform === 'win32' ? 'junction' : 'dir');
const reference = await readFile(path.join(root, 'test-results/voice-integration/reference-zh.wav'));
let offset = 12, pcm;
while (offset + 8 <= reference.length) { const size = reference.readUInt32LE(offset + 4); if (reference.toString('ascii', offset, offset + 4) === 'data') { pcm = reference.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + size % 2; }
const header = Buffer.from(reference.subarray(0, 44)), samples = Buffer.concat([Buffer.alloc(32000), pcm, Buffer.alloc(32000 * 35)]);
header.writeUInt32LE(samples.length + 36, 4); header.writeUInt32LE(samples.length, 40);
const mic = path.join(dir, 'microphone.wav'); await writeFile(mic, Buffer.concat([header, samples]));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const httpsPort = await port(), httpPort = await port();
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--mute-audio'];
let service, app, browser, page;
try {
  if (desktop) {
    const env = { ...process.env, ATB_DATA_DIR: dir, FREECAMERA_DATA_DIR: dir, LAN_IP: '127.0.0.1', HTTPS_PORT: String(httpsPort), HTTP_PORT: String(httpPort), TURN_PORT: '0' }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root, ...args], env });
    page = await app.firstWindow(); await page.waitForURL('**/platform', { timeout: 30000 });
    await page.goto(new URL('/modules/assistant/', page.url()).href);
  } else {
    service = await startServers({ lanIp: '127.0.0.1', httpsPort, httpPort, relayPort: 0, certDir: path.join(dir, 'certs'), dataDir: path.join(dir, 'data'), detector: null });
    browser = await chromium.launch({ args }); const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] }); page = await context.newPage();
    await page.goto(`https://127.0.0.1:${httpsPort}/modules/assistant/`);
  }
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    window.testAudioEvents = []; window.testTracks = []; window.testPcmEvents = []; window.testVoiceStates = [];
    new MutationObserver(() => { const text = document.querySelector('#voice-live')?.textContent; if (text && window.testVoiceStates.at(-1)?.text !== text) window.testVoiceStates.push({text,hidden:document.hidden,at:Date.now()}); }).observe(document,{subtree:true,childList:true,characterData:true});
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.testPcmEvents.push(performance.now()); return originalStart.apply(this,args); };
    const Capture = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Capture {
      constructor(...args) { super(...args); window.testVoiceCapture = this; window.testCaptureContext = args[0]; }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await getUserMedia(options); window.testTracks.push(...stream.getTracks()); return stream; };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.addEventListener('playing', () => window.testAudioEvents.push({ time: performance.now(), source: this.currentSrc }), { once: true });
      return play.call(this);
    };
  });
  await page.reload(); await page.locator('#login').waitFor();
  await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill('1'); await page.locator('[name=confirm]').fill('1'); await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor();
  await page.locator('[data-page=voice]').click(); await page.locator('#voice-provider').selectOption('qwen3tts');
  await page.waitForFunction(() => document.querySelector('#voice-name').value === 'qwen3tts:serena');
  assert.equal(await page.locator('#voice-pitch').isDisabled(), true);
  assert.equal(await page.locator('#tts-local').isVisible(), true);
  assert.match(await page.locator('#local-tts-state').textContent(), /已安装/);
  await page.locator('#voice-language').selectOption('all'); assert.equal(await page.locator('#voice-name option').count(), 9);
  await page.locator('#voice-rate').evaluate(el => { el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#voice-low-latency').uncheck(); await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  await page.reload(); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#voice-provider').value === 'qwen3tts');
  assert.equal(await page.locator('#voice-rate').inputValue(), '15'); assert.equal(await page.locator('#voice-low-latency').isChecked(), false);
  await page.locator('#voice-provider').selectOption('volcengine'); await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  await page.locator('#voice-provider').selectOption('qwen3tts'); assert.equal(await page.locator('#voice-rate').inputValue(), '15');
  if (pcmMode) await page.locator('#voice-rate').evaluate(el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#voice-low-latency').check(); await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  await page.locator('#voice-preview-text').fill('你好，欢迎回家。'); await page.locator('#voice-preview').click();
  await page.waitForFunction(() => document.querySelector('#voice-result').textContent === '试听播放完成', {}, { timeout: 120000 });
  assert.ok(await page.evaluate(pcmMode => (pcmMode ? window.testPcmEvents : window.testAudioEvents).length > 0, pcmMode), 'real Qwen audio must reach playback');
  assert.equal(await page.evaluate(() => window.testTracks.length), 0, 'preview must not access microphone');
  const getState = () => page.evaluate(async () => window.atbDesktop?.hasModule('assistant') ? window.atbDesktop.invokeModule('assistant', 'voice', { action: 'status' }) : (await fetch('/api/assistant/voice/status')).json());
  assert.equal((await getState()).modelLoaded, true);
  const decoded = await page.evaluate(async audio => { const ctx = new AudioContext(); try { const buffer = await ctx.decodeAudioData(Uint8Array.from(atob(audio), c => c.charCodeAt(0)).buffer); return { channels: buffer.numberOfChannels, duration: buffer.duration }; } finally { await ctx.close(); } }, (await readFile(path.join(evidence, 'qwen3tts-reference.wav'))).toString('base64'));
  assert.equal(decoded.channels, 1); assert.ok(decoded.duration > 3);
  await page.locator('#voice-provider').selectOption('chattts');
  await page.waitForFunction(() => document.querySelector('#voice-name').value === 'chattts:42');
  await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  const beforeChatNative = await page.evaluate(() => window.testPcmEvents?.length || 0);
  await page.locator('#voice-preview').click();
  await page.waitForFunction(() => document.querySelector('#voice-result').textContent === '试听播放完成', {}, {timeout:120000});
  assert.ok(await page.evaluate(count => window.testPcmEvents.length > count, beforeChatNative));
  assert.equal((await getState()).modelLoaded, true);
  await page.locator('#voice-provider').selectOption('qwen3tts');
  await page.locator('#voice-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');

  if (proactiveMode) {
    await page.locator('[data-page=assistant]').click();
    await page.locator('#persona-form').evaluate(el => { el.closest('details').open = true; });
    await page.locator('#responseStyle').selectOption('talkative'); await page.locator('#followUpQuestions').check();
    await page.locator('#proactiveChat').check(); await page.locator('#opportunityProbability').fill('0.55');
    await page.locator('#persona-form [type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#persona-result').textContent === '已保存');
    await page.evaluate(() => fetch('/api/assistant/presence', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'settings',quietEnabled:false})}));
  }
  await page.locator('[data-page=model]').click(); await page.locator('#api-source').selectOption('custom'); await page.locator('#base-url').fill('https://example.com/v1'); await page.locator('#model').fill('test-model'); await page.locator('#api-key').fill('test-only'); await page.locator('#model-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#model-state').textContent === '已保存');
  // Delay model completion until after actual audio playback begins. Renderer seam
  // works for both HTTP and Electron's native protocol handler without a paid call.
  await page.evaluate(() => {
    const original = window.fetch.bind(window); window.testModelRequests = []; window.testOpportunityRequests = []; window.testModelComplete = false; window.testModelAborts = 0;
    window.fetch = async (url, options) => {
      const pathname = new URL(url, location.href).pathname;
      if (pathname === '/api/assistant/balance') return Response.json({ kind: 'unsupported' });
      if (pathname === '/api/assistant/opportunity' && options?.method === 'POST') {
        window.testOpportunityRequests.push(JSON.parse(options.body));
        if (window.testOpportunityReady && !window.testOpportunityDelivered) { window.testOpportunityDelivered = true; return Response.json({action:'chat',reply:'刚才说到回家休息。可以先做一点让自己放松的事情。你今天有什么想分享的吗？',id:'fixture-opportunity'}); }
        return Response.json({action:'none',reply:''});
      }
      if (pathname !== '/api/assistant/chat') return original(url, options);
      const body = JSON.parse(options.body); window.testModelRequests.push(body);
      if (!body.stream) return Response.json({ reply: '普通回复。' });
      window.testModelComplete = false;
      return new Response(new ReadableStream({ start(controller) {
        const send = value => controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
        if (window.testBargeIn && window.testModelRequests.length === 2) {
          send({ type: 'delta', text: '已经听到你的新问题。' }); send({ type: 'done', reply: '已经听到你的新问题。' }); controller.close(); window.testModelComplete = true;
          return;
        }
        const abort = () => { window.testModelAborts++; controller.error(new DOMException('Interrupted', 'AbortError')); };
        options.signal?.addEventListener('abort', abort, { once: true });
        send({ type: 'delta', text: '欢迎回家。' });
        window.testReleaseModel = () => { options.signal?.removeEventListener('abort', abort); send({ type: 'delta', text: '今天辛苦了。' }); send({ type: 'done', reply: '欢迎回家。今天辛苦了。' }); controller.close(); window.testModelComplete = true; };
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  });
  const previewEvents = await page.evaluate(pcmMode => (pcmMode ? window.testPcmEvents : window.testAudioEvents).length, pcmMode);
  await page.evaluate(enabled => { window.testBargeIn = enabled; }, bargeIn);
  await page.locator('[data-page=assistant]').click(); await page.locator('#voice-start').click();
  await page.waitForFunction(() => Number(document.querySelector('#voice-stage').style.getPropertyValue('--voice-level')) > .01 && document.querySelector('#voice-stage').dataset.phase === 'listening', {}, {timeout:120000});
  await page.waitForFunction(({previous, pcmMode}) => (pcmMode ? window.testPcmEvents : window.testAudioEvents).length > previous && document.querySelector('#voice-timing').textContent.includes('识别'), {previous:previewEvents,pcmMode}, { timeout: 60000 });
  const dispatched = await page.evaluate(() => window.testModelRequests);
  assert.equal(await page.evaluate(() => window.testModelComplete), false, 'first real playback must precede model completion');
  await page.waitForFunction(() => Number(document.querySelector('#voice-stage').style.getPropertyValue('--voice-level')) > .01 && document.querySelector('#voice-stage').dataset.phase === 'speaking');
  await page.screenshot({ path: path.join(evidence, 'voice-home-speaking-' + (desktop ? 'desktop' : 'web') + '.png') });
  if (proactiveMode) {
    // Preserve the real microphone and ASR first turn; silence later capture
    // so the fixed WAV looping cannot manufacture a second user utterance.
    await page.evaluate(() => {
      const capture = window.testVoiceCapture, deliver = capture.port.onmessage;
      capture.port.onmessage = event => deliver({data:new Float32Array(new Float32Array(event.data).length).buffer});
      window.testReleaseModel();
    });
    await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'listening', {}, {timeout:120000});
    const previous = await page.evaluate(() => window.testPcmEvents.length);
    // Real ASR/audio, synthetic opportunity choice. Do not wait45minutes or send a paid decision.
    await page.evaluate(() => { window.testOpportunityReady=true;const originalNow=Date.now;Date.now=()=>originalNow()+31000;window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(count => window.testOpportunityDelivered && window.testPcmEvents.length > count, previous, {timeout:60000});
    await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'listening', {}, {timeout:120000});
    const autonomous = await page.evaluate(() => window.testModelRequests);
    assert.equal(autonomous.length,1,'opportunity does not fabricate a user chat request');
    assert.equal(autonomous[0].messages.filter(m=>m.role==='user').length,1);
    assert.match(await page.locator('.bubble.assistant').last().textContent(),/你今天有什么想分享/);
    await new Promise(resolve => setTimeout(resolve,17000));
    assert.equal(await page.evaluate(() => window.testModelRequests.length),1,'no synthetic user requests from optional opportunities');
    assert.equal(await page.evaluate(() => window.testTracks.length),1);
    await page.locator('#voice-stop').click(); await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
    assert.equal((await getState()).modelLoaded,true); assert.deepEqual(errors,[]);
    console.log(JSON.stringify({mode:desktop?'desktop IPC':'browser HTTP',passed:true,pcmMode,proactiveMode,checks:'real ASR/Qwen PCM; playback before model completion; real voice settings persisted; synthetic opportunity chat plays through production audio; no synthetic user; scheduler randomness covered separately; stop retains model'}));
  } else if (bargeIn) {
    // Replay fixed speech at the existing worklet boundary while real ASR/TTS
    // and the original live microphone track remain in use. No paid provider.
    const interruptedEvents = await page.evaluate(pcmMode => (pcmMode ? window.testPcmEvents : window.testAudioEvents).length, pcmMode);
    console.log('BARGE_CAPTURE', JSON.stringify(await page.evaluate(() => ({sampleRate:window.testCaptureContext.sampleRate,contextState:window.testCaptureContext.state,requests:window.testModelRequests.length}))));
    await page.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
      const capture = window.testVoiceCapture, deliver = capture.port.onmessage;
      capture.port.onmessage = () => {};
      try {
        for (let offset = 0; offset < bytes.length + 32000; offset += 3200) {
          const samples = new Float32Array(1600);
          for (let i = 0; i < samples.length && offset + i * 2 + 1 < bytes.length; i++) samples[i] = view.getInt16(offset + i * 2, true) / 32768;
          deliver({ data: samples.buffer }); await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { capture.port.onmessage = deliver; }
    }, pcm.toString('base64'));
    await page.waitForFunction(({previous, pcmMode}) => window.testModelRequests.length === 2 && (pcmMode ? window.testPcmEvents : window.testAudioEvents).length > previous, {previous:interruptedEvents,pcmMode}, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.testModelAborts), 1);
    assert.equal(await page.evaluate(() => window.testTracks.length), 1, 'interruption preserves the microphone');
    assert.equal(await page.evaluate(() => window.testTracks[0].readyState), 'live');
    assert.match(await page.locator('.bubble.assistant').last().textContent(), /新问题/);
    await page.locator('#voice-stop').click(); await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
    assert.equal((await getState()).modelLoaded, true); assert.equal(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode: desktop ? 'desktop IPC' : 'browser HTTP', passed: true, pcmMode, interruption: 'fixed PCM to actual ASR, cancel old model/audio, retain mic, actual new Qwen3-TTS playback, stop releases microphone and retains model' }));
  } else {
  await page.evaluate(() => window.testReleaseModel());
  assert.equal(dispatched.length, 1); assert.equal(dispatched[0].stream, true);
  assert.match(await page.locator('.bubble.assistant').last().textContent(), /欢迎回家/);
  await page.locator('#voice-stop').click(); await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
  assert.equal((await getState()).modelLoaded, true); assert.equal(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), true);
  const timings = await page.locator('#voice-timing').textContent();
  await page.locator('[data-page=voice]').click(); await page.locator('#voice-low-latency').uncheck();
  await page.locator('#voice-form [type=submit]').click(); await page.waitForFunction(() => document.querySelector('#voice-state').textContent === '已保存');
  const previousEvents = await page.evaluate(pcmMode => (pcmMode ? window.testPcmEvents : window.testAudioEvents).length, pcmMode);
  await page.locator('[data-page=assistant]').click(); await page.locator('#voice-start').click();
  await page.waitForFunction(({previous, pcmMode}) => (pcmMode ? window.testPcmEvents : window.testAudioEvents).length > previous && document.querySelector('#voice-timing').textContent.includes('识别'), {previous:previousEvents,pcmMode}, { timeout: 60000 });
  const nonstream = await page.evaluate(() => window.testModelRequests);
  assert.equal(nonstream.length, 2); assert.equal(nonstream[1].stream, undefined);
  assert.match(await page.locator('.bubble.assistant').last().textContent(), /普通回复/);
  await page.locator('#voice-stop').click(); await page.waitForFunction(() => document.querySelector('#voice-live').dataset.phase === 'off');
  assert.equal((await getState()).modelLoaded, true);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 }); await page.locator('[data-page=voice]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, `${desktop ? 'desktop' : 'web'}-${width}.png`), fullPage: true });
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 }); await page.locator('[data-page=assistant]').click();
    assert.equal(await page.locator('#transcript').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, 'voice-home-' + (desktop ? 'desktop' : 'web') + '-' + width + '.png') });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ mode: desktop ? 'desktop IPC' : 'browser HTTP', passed: true, pcmMode, decoded, timings, localVoices: {chattts:"seed based", qwen3tts:9}, model: 'synthetic NDJSON reply; real ASR/Qwen3-TTS/audio playback' }));
  }
} catch (error) {
  if (page && !page.isClosed()) {
    console.error('UI diagnostic:', JSON.stringify(await page.evaluate(() => ({ phase: document.querySelector('#voice-live')?.dataset.phase, state: document.querySelector('#voice-live')?.textContent, error: document.querySelector('#chat-error')?.textContent, metrics: document.querySelector('#voice-timing')?.textContent, events: window.testAudioEvents?.length, requests:window.testModelRequests?.length, aborted:window.testModelAborts, hidden:document.hidden,proactiveChecked:document.querySelector('#proactiveChat')?.checked,voiceStates:window.testVoiceStates?.slice(-12),pcmEvents:window.testPcmEvents?.length,captureRate:window.testCaptureContext?.sampleRate, captureState:window.testCaptureContext?.state, tracks: window.testTracks?.map(track => track.readyState) })).catch(() => ({}))));
    await page.screenshot({ path: path.join(evidence, `${desktop ? 'desktop' : 'web'}-failure.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close(); await app?.close(); await service?.close();
  for (const name of ['voice-runtime', 'tts-runtime', 'qwen-tts-runtime', 'models']) await unlink(path.join(assistant, name));
  await rm(dir, { recursive: true, force: true });
}
