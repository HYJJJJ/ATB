import { describeFaces, withFaceModel } from './presence-face.js';
import { validateEnrollment } from './presence-state.js';

export function createFaceManagement({ api, onChange = () => {} }) {
  const host = document.querySelector('#page-faces');
  host.innerHTML = `<div class="section-head"><div><h1>人脸管理</h1><p class="muted">为熟悉的人建立资料，让助手认出并准确称呼对方。</p></div><button data-person-new class="primary" type="button">＋ 新增人物</button></div>
    <div class="face-management">
      <section class="card settings face-directory" aria-label="人物列表"><label>查找人物<input data-person-search type="search" placeholder="姓名、称呼、关系、职业或备注"></label><p data-person-count class="field-help" role="status">正在读取…</p><div data-person-list class="face-person-list"></div><button data-person-refresh class="quiet" type="button">刷新列表</button></section>
      <form class="card settings model-form face-editor"><div class="section-head"><h2 data-person-title>新增人物</h2><span data-person-state class="badge">未保存</span></div>
        <div class="form-grid"><label>姓名 *<input data-name maxlength="40" required autocomplete="off" placeholder="人物姓名"></label><label>助手如何称呼 TA<input data-address maxlength="40" placeholder="留空使用姓名"></label>
        <label>与你的关系<input data-relationship maxlength="60" list="face-relations" placeholder="可选择或自行输入"></label><datalist id="face-relations"><option value="本人"><option value="家人"><option value="伴侣"><option value="父亲"><option value="母亲"><option value="孩子"><option value="朋友"><option value="同事"><option value="访客"></datalist>
        <label>生日<input data-birthday type="date" min="0001-01-01" max="9999-12-31"></label><label>职业 / 身份<input data-occupation maxlength="80" placeholder="可选"></label></div>
        <label>备注<textarea data-notes maxlength="1000" rows="3" placeholder="补充人物信息、喜好等，仅用于资料管理"></textarea></label>
        <label>专属到场问候<input data-person-greeting maxlength="200" placeholder="留空使用统一问候；例如：{name}，欢迎来玩。"></label>
        <label class="check"><input data-active type="checkbox" checked>启用此人物的识别与问候</label>
        <label class="check"><input data-self type="checkbox">这是我本人（允许使用账户记忆及开启语音接续）</label>
        <p class="field-help">“本人”最多标记一位；关系文字不授予账户记忆权限。其他人物使用到场问候，不接续私人对话。生日、职业和备注仅用于资料管理。</p>
        <div class="face-enrollment"><h3>人脸样本</h3><p data-samples class="field-help">尚未录入人脸，可先保存资料。</p><label>选择3–8张照片<input data-photos type="file" accept="image/jpeg,image/png,image/webp" multiple></label><p class="field-help">每张只含该人物一张清晰人脸，选择不同角度。上传后在当前设备提取特征，只保存特征，不保留原照片。重新录入将替换整组样本。请取得对方同意后录入；照片或屏幕也可能被识别，不能用于门禁或身份认证。</p><button data-enroll class="secondary" type="button">提取并保存人脸</button></div>
        <div class="form-actions"><button data-person-save class="primary" type="submit">保存人物资料</button><button data-person-delete class="quiet danger" type="button" disabled>删除人物</button></div>
        <div data-delete-question class="face-delete-question" hidden><p data-delete-message></p><div class="form-actions"><button data-person-delete-confirm class="danger secondary" type="button">确认删除</button><button data-person-delete-cancel class="quiet" type="button">取消</button></div></div>
        <p data-person-result class="form-result" role="status" aria-live="polite"></p>
      </form>
    </div><p class="field-help">最多50位人物。支持多人资料；识别时需要画面中只有一张清晰人脸，匹配不唯一时暂停问候。后台摄像头、声音输出和时间策略在 <a href="#voice" data-face-settings class="text-link">TTS 与语音 → 到场问候与主动对话</a> 中设置。后台识别需要 ATB 桌面端。</p>`;
  const $ = key => host.querySelector(`[data-${key}]`);
  const fields = ['name', 'address', 'relationship', 'birthday', 'occupation', 'notes'];
  let people = [], selectedId = '', live = false, generation = 0, dirty = false, working = false, controller;
  const result = text => { $('person-result').textContent = text; };
  function setDirty(value) { dirty = value; $('person-state').textContent = value ? '未保存' : selectedId ? '已保存' : '新人物'; }
  function busy(value) {
    working = value;
    for (const el of host.querySelectorAll('input,textarea,button')) el.disabled = value;
    if (!value) $('person-delete').disabled = !selectedId;
  }
  function render() {
    const query = $('person-search').value.trim().toLocaleLowerCase();
    const filtered = people.filter(p => [p.name, p.address, p.relationship, p.occupation, p.notes, p.birthday].some(v => v?.toLocaleLowerCase().includes(query)));
    $('person-count').textContent = `${people.length} 位人物${query ? ` · 找到 ${filtered.length} 位` : ''}`;
    const buttons = filtered.map(person => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'face-person'; button.dataset.personId = person.id;
      button.classList.toggle('selected', selectedId === person.id); button.setAttribute('aria-pressed', String(selectedId === person.id));
      const title = document.createElement('strong'); title.textContent = person.name + (person.address && person.address !== person.name ? ` · ${person.address}` : '');
      const detail = document.createElement('span'); detail.textContent = `${person.relationship || '未填写关系'}${person.isSelf ? ' · 本人' : ''} · ${person.descriptors.length} 张样本 · ${person.active ? person.descriptors.length >= 3 ? '可识别' : '待录入' : '已停用'}`;
      button.append(title, detail); button.onclick = () => { if (!working) select(person); }; return button;
    });
    if (!buttons.length) { const empty = document.createElement('p'); empty.className = 'field-help'; empty.textContent = query ? '没有找到匹配人物。' : '还没有人物，填写右侧资料开始录入。'; buttons.push(empty); }
    $('person-list').replaceChildren(...buttons);
  }
  function select(person, discard = false) {
    if (dirty && !discard) { result('当前资料尚未保存，请先保存，或点击“放弃修改”。'); $('person-discard').hidden = false; return; }
    selectedId = person?.id || '';
    for (const key of fields) $(key).value = person?.[key] || '';
    $('person-greeting').value = person?.greeting || ''; $('active').checked = person?.active !== false; $('self').checked = Boolean(person?.isSelf);
    $('samples').textContent = person?.descriptors.length ? `已录入 ${person.descriptors.length} 张样本。可重新选择照片替换。` : '尚未录入人脸，可先保存资料。';
    $('photos').value = ''; $('person-delete').disabled = !person; $('delete-question').hidden = true; $('person-discard').hidden = true;
    $('person-title').textContent = person ? '编辑人物' : '新增人物'; setDirty(false); result(''); render();
  }
  const discardButton = document.createElement('button'); discardButton.type = 'button'; discardButton.className = 'quiet'; discardButton.dataset.personDiscard = ''; discardButton.textContent = '放弃修改'; discardButton.hidden = true;
  $('person-save').parentElement.append(discardButton); discardButton.onclick = () => select(people.find(p => p.id === selectedId), true);
  function draft() { return { ...(selectedId ? { id: selectedId } : {}), ...Object.fromEntries(fields.map(key => [key, $(key).value])), greeting: $('person-greeting').value, active: $('active').checked, isSelf: $('self').checked }; }
  const request = (body, signal) => api('/api/assistant/presence', body, signal);
  async function load() {
    const epoch = generation;
    try {
      const next = await request(undefined, controller.signal); if (!live || epoch !== generation) return;
      people = next.people || []; render(); if (!dirty) select(people.find(p => p.id === selectedId));
    } catch (error) { if (live && epoch === generation) result(error.message); }
  }
  async function save(withFaces = false) {
    if (working || !live || !host.querySelector('form').reportValidity()) return;
    const person = draft(), files = [...$('photos').files], epoch = generation, operation = controller; busy(true);
    try {
      if (withFaces) {
        if (files.length < 3 || files.length > 8) throw Error('请选择3–8张该人物的不同照片');
        result('正在本机加载模型并提取人脸…');
        person.descriptors = await withFaceModel(async () => {
        const descriptors = [], hashes = new Set();
        for (const file of files) {
          operation.signal.throwIfAborted();
          if (file.size > 10000000 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('照片需为 JPEG/PNG/WebP 且小于10MB');
          const bytes = await file.arrayBuffer(), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',');
          operation.signal.throwIfAborted();
          if (hashes.has(hash)) throw Error('请勿重复选择同一张照片'); hashes.add(hash);
          const image = await createImageBitmap(file);
          try {
            operation.signal.throwIfAborted();
            if (image.width > 8192 || image.height > 8192) throw Error('照片尺寸过大，请缩小后重试');
            const canvas = document.createElement('canvas'), scale = Math.min(1, 1280 / Math.max(image.width, image.height));
            canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            const faces = await describeFaces(canvas); operation.signal.throwIfAborted(); if (faces.length !== 1 || !faces[0]) throw Error('每张照片需只有一张清晰人脸，请使用更近、更正的照片'); descriptors.push(faces[0]);
          } finally { image.close(); }
        }
        return validateEnrollment(descriptors);
        }, operation.signal);
      }
      if (!live || epoch !== generation) return;
      const next = await request({ action: 'person-save', person }, operation.signal); if (!live || epoch !== generation) return;
      const id = person.id || next.people.at(-1).id; people = next.people; select(people.find(p => p.id === id), true);
      result(withFaces ? '人物资料及人脸已保存。可到 TTS 与语音中开启后台识别。' : '人物资料已保存。'); void onChange(next);
    } catch (error) { if (live && epoch === generation) result(error.message); }
    finally { if (epoch === generation) busy(false); }
  }
  host.querySelector('form').onsubmit = event => { event.preventDefault(); void save(); };
  host.querySelector('form').addEventListener('input', () => setDirty(true));
  $('enroll').onclick = () => void save(true); $('person-new').onclick = () => select(); $('person-refresh').onclick = () => void load();
  $('person-search').oninput = render;
  $('person-delete').onclick = () => { $('delete-message').textContent = `删除“${people.find(p => p.id === selectedId)?.name}”及其全部人脸特征？`; $('delete-question').hidden = false; };
  $('person-delete-cancel').onclick = () => { $('delete-question').hidden = true; };
  $('person-delete-confirm').onclick = async () => {
    if (working || !selectedId) return; const epoch = generation; busy(true);
    try {
      const next = await request({ action: 'person-delete', id: selectedId }, controller.signal); if (!live || epoch !== generation) return;
      people = next.people; select(undefined, true); result('人物及人脸资料已删除。'); void onChange(next);
    } catch (error) { if (live && epoch === generation) result(error.message); }
    finally { if (epoch === generation) busy(false); }
  };
  return {
    get dirty() { return dirty; },
    start() { if (live) { if (!working) void load(); return; } live = true; controller = new AbortController(); void load(); },
    stop() { live = false; generation++; controller?.abort(); people = []; selectedId = ''; dirty = false; working = false; $('person-search').value = ''; select(undefined, true); busy(false); },
  };
}
