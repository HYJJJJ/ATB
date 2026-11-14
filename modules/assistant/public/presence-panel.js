import { validatePresencePolicy, presenceGreeting, presenceContext, quietReason } from './presence-state.js';
export function createPresencePanel({ api, voice, onDirty = () => {}, onResult = () => {} }) {
  const desktop = window.atbDesktop;
  const host = document.createElement('details'); host.className = 'card atb-settings-section presence-settings model-form'; host.open = true;
  host.innerHTML = `<summary>到场问候与免打扰</summary><div class="atb-settings-body settings"><p class="field-help">在人脸管理页录入人物后，在本机后台识别所选监控画面。连续确认约2秒后问候；短暂遮挡不重复，连续离场1分钟后才能再次到场，每人问候至少间隔5分钟。不从外貌判断精神状态。</p><p data-status role="status">正在读取…</p><p><a href="#faces" class="text-link">打开人脸管理 → 新增人物、姓名与关系</a></p><label>监控摄像头<select data-camera><option value="">请选择已登记摄像头</option></select></label><p class="field-help">使用桌面当前选择的监控服务。远程监控需先在 FreeCamera 登录。切换服务后请重新选择摄像头。</p><label>声音输出<select data-output><option value="">系统默认输出设备</option></select></label><label>统一问候语（人物专属问候优先）<input data-greeting maxlength="200" value="你好，{name}，欢迎回来。"></label><label class="check"><input data-follow type="checkbox">本人到场问候后开启麦克风，接续现有语音对话</label><label class="check"><input data-enabled type="checkbox">开启后台人物识别与到场问候</label><div class="form-actions"><button data-refresh class="secondary" type="button">刷新设备和运行状态</button><button data-test class="quiet" type="button">试听问候</button></div><p class="field-help">“试听问候”朗读当前问候模板与时间日程预览，不运行人脸识别。“刷新设备和运行状态”重新获取摄像头、声音输出设备与后台识别状态，保留未保存的输入。</p><ol data-history class="field-help"></ol></div>`;
  document.querySelector('#page-voice').append(host);
  host.querySelector('[data-follow]').closest('label').insertAdjacentHTML('beforebegin', `
    <details open><summary>时间、日程与本人反馈</summary>
      <label class="check"><input data-context type="checkbox">按时段、日期、工作休息日补充问候</label>
      <label>时区<input data-timezone maxlength="80" placeholder="Asia/Shanghai"></label>
      <p class="field-help">常规工作周（特殊日期优先，不自动猜测法定节假日）</p>
      <div class="form-actions">${[1, 2, 3, 4, 5, 6, 0].map(day => `<label class="check"><input data-workday type="checkbox" value="${day}">周${'日一二三四五六'[day]}</label>`).join('')}</div>
      <label>特殊工作日期<textarea data-workdates rows="2" placeholder="2026-11-14，每行或逗号分隔"></textarea></label>
      <label>特殊休息日期<textarea data-restdates rows="2" placeholder="YYYY-MM-DD，每行或逗号分隔"></textarea></label>
      <p class="field-help">问候语支持 {name}、{period}、{date}、{weekday}、{dayType}、{care}。</p>
      <p data-preview class="field-help" role="status"></p>
      <label>我今天的状态<select data-feedback><option value="neutral">一般／未反馈</option><option value="good">精神不错</option><option value="tired">有些累</option><option value="busy">正在忙，减少打扰</option></select></label>

      <p class="field-help">仅使用你主动反馈的状态，当日有效；不会从脸部外观判断情绪或健康。正在忙时暂停主动开场。</p>
    </details>
    <details open><summary>随机机会与免打扰</summary>
      <label class="check"><input data-proactive type="checkbox">本人持续在场时，允许接收随机机会（同时需开启助手设定中的随机机会）</label>
      <label hidden>旧主动开场语（已停用）<textarea data-proactivetext rows="2" maxlength="200"></textarea></label>
      <label hidden>最短间隔（分钟，5–240）<input data-interval type="number" min="5" max="240" step="1"></label>
      <label hidden>每天最多主动开场次数（1–12）<input data-limit type="number" min="1" max="12" step="1"></label>
      <label class="check"><input data-quiet type="checkbox">开启免打扰时段（同时暂停到场问候）</label>
      <label>免打扰开始<input data-quietstart type="time"></label><label>免打扰结束<input data-quietend type="time"></label>
      <label class="check"><input data-aiopening type="checkbox">用当前AI模型生成到场问候（会消耗模型额度）</label>
      <p class="field-help">随机机会使用助手设定中的概率和限额，45–90分钟随机间隔，允许什么都不做，每天最多主动聊天2次。到场AI问候失败时使用本地问候。画面与人脸特征不发给AI。前台语音优先；无清晰本人画面、免打扰或暂停时不主动聊天。</p>
      <div class="form-actions"><button data-snooze30 type="button" class="secondary">暂停30分钟</button><button data-snooze120 type="button" class="secondary">暂停2小时</button><button data-resume type="button" class="quiet">恢复互动</button><button data-stopvoice type="button" class="quiet">停止当前对话</button></div>
      <p data-policy-status class="field-help" role="status"></p>
      <p class="field-help">开启接续麦克风后，可以说“先别打扰我”暂停两小时；无人回应时语音会自动暂停。关闭主动开场仍可保留到场问候。</p>
    </details>`);
  const actions = document.querySelector('#voice-actions');
  for (const button of host.querySelectorAll('[data-refresh],[data-test]')) actions.querySelector('.voice-action-buttons').append(button);
  host.querySelector('.form-actions:empty')?.remove();
  const $ = key => host.querySelector(`[data-${key}]`) || actions.querySelector(`[data-${key}]`);
  $('test').title = '朗读当前到场问候模板，包含已启用的时间、日期和本人状态；不测试人脸识别';
  $('refresh').title = '重新获取摄像头和声音输出设备，刷新本地语音服务与后台识别状态；保留未保存的设置';
  let settings, timer, live = false, editing = false, generation = 0, editVersion = 0;
  const native = action => desktop.invokeModule('assistant', 'presence', { action });
  const result = text => onResult(text);
  const dates = text => text.split(/[\s,，;；]+/).filter(Boolean);
  function draft() {
    return { greeting: $('greeting').value, ...validatePresencePolicy({ contextEnabled: $('context').checked, timeZone: $('timezone').value.trim(), workdays: [...host.querySelectorAll('[data-workday]:checked')].map(el => Number(el.value)), workDates: dates($('workdates').value), restDates: dates($('restdates').value), proactiveEnabled: $('proactive').checked, proactiveText: $('proactivetext').value, intervalMinutes: Number($('interval').value), dailyLimit: Number($('limit').value), quietEnabled: $('quiet').checked, quietStart: $('quietstart').value, quietEnd: $('quietend').value, aiOpening: $('aiopening').checked }) };
  }
  function greetingDraft() { const next = { ...settings, ...draft() }; next.feedback = { state: $('feedback').value, date: presenceContext(next).date }; return next; }
  function preview() { try { $('preview').textContent = '本地问候预览：' + presenceGreeting(greetingDraft()); } catch (error) { $('preview').textContent = error.message; } }
  host.addEventListener('input', () => { editing = true; editVersion++; onDirty(); preview(); });
  async function updateStatus() {
    if (!live || !desktop?.hasModule('assistant')) return;
    try {
      const state = await native('status');
      if (!live) return;
      const latest = await api('/api/assistant/presence'); if (!live) return;

      $('policy-status').textContent = `${quietReason(latest) || '当前允许互动'} · 后台接收随机机会${latest.proactiveEnabled ? '已开启' : '未开启'}${latest.snoozeUntil > Date.now() ? ' · 暂停至' + new Date(latest.snoozeUntil).toLocaleTimeString() : ''}`;
      $('status').textContent = `已登记${latest.people.length}位人物，${latest.people.filter(p => p.active && p.descriptors.length >= 3).length}位可识别 · ${state.text}`;
      $('history').replaceChildren(...(state.history || []).map(event => { const li = document.createElement('li'); li.textContent = `${new Date(event.time).toLocaleTimeString()} ${event.text}`; return li; }));
    } catch (error) { if (live) result(error.message); }
  }
  async function devices() {
    const epoch = generation;
    const outputs = await navigator.mediaDevices?.enumerateDevices() || [];
    if (!live || epoch !== generation) return;
    const value = editing ? $('output').value : settings?.outputId || ''; $('output').replaceChildren(new Option('系统默认输出设备', ''), ...outputs.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default').map((d, i) => new Option(d.label || `输出设备 ${i + 1}`, d.deviceId)));
    if (value && ![...$('output').options].some(o => o.value === value)) $('output').add(new Option('已保存的输出设备（当前不可用）', value));
    $('output').value = value;
    if (!desktop?.hasModule('freecamera')) { result('到场问候需要同时安装 FreeCamera 模块。'); return; }
    const data = await desktop.invokeModule('assistant', 'presence', { action: 'devices' });
    if (!live || epoch !== generation || data.cancelled) return;
    if (data.error) { result(data.error); return; }
    const camera = editing ? $('camera').value : settings.cameraId;
    $('camera').replaceChildren(new Option('请选择已登记摄像头', ''), ...data.devices.map(d => new Option(`${d.name} · ${d.online ? '在线' : '离线'}`, d.deviceId)));
    if (camera && !data.devices.some(d => d.deviceId === camera)) $('camera').add(new Option('所选摄像头（当前服务未发现）', camera));
    $('camera').value = camera;
  }
  async function load() {
    if (!live) return;
    const epoch = generation;
    try {
      const next = await api('/api/assistant/presence'); if (epoch !== generation || !live) return; settings = next;
      if (!editing) {
        $('greeting').value = next.greeting; $('enabled').checked = next.enabled; $('follow').checked = next.followUp;
        for (const [key, value] of [['context', next.contextEnabled], ['proactive', next.proactiveEnabled], ['quiet', next.quietEnabled], ['aiopening', next.aiOpening]]) $(key).checked = value;
        for (const [key, value] of [['timezone', next.timeZone], ['proactivetext', next.proactiveText], ['interval', next.intervalMinutes], ['limit', next.dailyLimit], ['quietstart', next.quietStart], ['quietend', next.quietEnd], ['workdates', next.workDates.join('\n')], ['restdates', next.restDates.join('\n')]]) $(key).value = value;
        for (const el of host.querySelectorAll('[data-workday]')) el.checked = next.workdays.includes(Number(el.value));
        $('feedback').value = presenceContext(next).state; preview();
      }
      if (next.enabled && desktop?.hasModule('assistant')) await native('start');
      await devices(); await updateStatus();
    } catch (error) { if (live) result(error.message); }
  }
  function prepare() {
    if (!live) return null;
    if (!settings) throw Error('正在读取到场问候设置，请稍后保存');
    for (const input of host.querySelectorAll('input,select,textarea')) {
      if (!input.checkValidity()) { input.reportValidity(); throw Error('请检查到场问候设置中的输入'); }
    }
    return { epoch: generation, edit: editVersion, feedback: $('feedback').value,
      feedbackChanged: $('feedback').value !== presenceContext(settings).state,
      options: { action: 'settings', ...draft(), enabled: $('enabled').checked, cameraId: $('camera').value, outputId: $('output').value, followUp: $('follow').checked } };
  }
  async function save(snapshot = prepare()) {
    if (!snapshot) return;
    const current = () => live && generation === snapshot.epoch;
    const next = await api('/api/assistant/presence', snapshot.options);
    if (!current()) return;
    settings = next;
    if (snapshot.feedbackChanged) {
      const response = await api('/api/assistant/presence', { action: 'feedback', state: snapshot.feedback });
      if (!current()) return;
      settings.feedback = response.feedback;
    }
    await native('pause'); if (!current()) return;
    await native(settings.enabled ? 'start' : 'stop'); if (!current()) return;
    if (editVersion === snapshot.edit) editing = false;
    onDirty(); await updateStatus();
  }
  $('refresh').onclick = () => void load();
  $('test').onclick = async () => { try { voice.setOutputDevice($('output').value); const completed = await voice.read(presenceGreeting(greetingDraft())); result(completed ? '试听完成' : '试听已停止'); } catch (error) { result(error.message); } };
  async function snooze(minutes) { try { const next = await api('/api/assistant/presence', { action: 'snooze', minutes }); settings.snoozeUntil = next.snoozeUntil; if (minutes) await native('pause'); await updateStatus(); result(minutes ? `主动互动已暂停${minutes}分钟` : '已恢复，仍遵守免打扰时段与频率限制'); } catch (error) { result(error.message); } }
  $('snooze30').onclick = () => void snooze(30); $('snooze120').onclick = () => void snooze(120); $('resume').onclick = () => void snooze(0);
  $('stopvoice').onclick = () => void snooze(30);
  if (!desktop?.hasModule('assistant')) { for (const control of [...host.querySelectorAll('button,input,select,textarea'), $('refresh'), $('test')]) control.disabled = true; $('status').textContent = '后台到场问候目前仅支持 ATB 桌面端，请在桌面端设置。'; }
  return {
    get dirty() { return editing; },
    prepare, save,
    refresh() { if (live) return load(); },
    start() { if (live || !desktop?.hasModule('assistant')) return; live = true; settings = undefined; editing = false; void load(); timer = setInterval(updateStatus, 3000); },
    stop() { live = false; editing = false; editVersion++; generation++; clearInterval(timer); $('history').replaceChildren(); },
  };
}
