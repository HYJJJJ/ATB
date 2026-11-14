import { desktopAvailable, invokeRustDesk } from './desktop.js';
const $ = id => document.getElementById(id);
let configuration = null;
let noticeTimer;
function notice(message, error = false) { clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').dataset.error = String(error); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 7000); }
async function api(route) {
  const response = await fetch(`/api/rustdesk/${route}`, { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) { $('login-state').hidden = false; throw Error('请先登录 ATB 平台'); }
  if (!response.ok) throw Error('无法读取 RustDesk 服务信息');
  return response.json();
}
async function copy(value) { if (!value) return; try { await navigator.clipboard.writeText(value); notice('已复制到剪贴板'); } catch { notice('复制失败，请选中字段手动复制', true); } }
function renderConfiguration(value) {
  configuration = value;
  for (const [id, text] of [['id-server', value.idServer], ['relay-server', value.relayServer], ['public-key', value.publicKey]]) { $(id).value = text; document.querySelector(`[data-copy="${id}"]`).disabled = !text; }
  $('config-badge').textContent = value.ready ? '共享配置' : '待平台配置'; $('config-badge').dataset.ready = String(value.ready);
  $('copy-all').disabled = !value.ready; $('export-config').hidden = !value.ready; $('server-version').textContent = value.deployedVersion || '未记录';
  $('nat-warning').hidden = !value.ready || value.natMappingCompatible;
  $('nat-message').textContent = `官方客户端根据 ID 端口自动检测 ${value.clientNatTestPort ?? '未知'}，当前公开 NAT 检测映射为 ${value.natTestPort ?? '未配置'}。标准客户端不能单独设置该端口。`;
  $('refresh-status').disabled = false;
  $('setting-id-port').value = value.idPort ?? ''; $('setting-relay-port').value = value.relayPort ?? ''; $('setting-nat-port').value = value.natTestPort ?? ''; $('setting-key').value = value.publicKey;
}
async function refreshStatus() {
  $('refresh-status').disabled = true;
  try {
    const value = await api('status');
    $('health-state').textContent = ({ reachable: 'TCP 端口可达', unreachable: '部分端口未连通', unconfigured: '等待平台配置' })[value.state] || '状态未知';
    $('status-dot').dataset.state = value.state;
    $('health-time').textContent = `服务器侧检查 · ${new Date(value.checkedAt).toLocaleTimeString()}`;
    $('health-note').textContent = value.note;
    $('health-checks').replaceChildren(...value.checks.map(check => { const item = document.createElement('li'); const label = document.createElement('span'); const state = document.createElement('strong'); label.textContent = `${({ id: 'ID 服务', relay: '中继服务', 'nat-test': 'NAT 检测' })[check.service]} · ${check.port ?? '未配置'}/TCP`; state.textContent = check.reachable ? '可达' : '未连通'; state.dataset.reachable = String(check.reachable); item.append(label, state); return item; }));
  } catch (error) { $('health-state').textContent = '检查未完成'; notice(error.message, true); }
  finally { $('refresh-status').disabled = false; }
}
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => copy($(button.dataset.copy).value));
$('copy-all').addEventListener('click', () => copy(`ID 服务器: ${configuration.idServer}\n中继服务器: ${configuration.relayServer}\nKey: ${configuration.publicKey}`));
$('refresh-status').addEventListener('click', refreshStatus);
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-settings').disabled = true; $('settings-result').textContent = '';
  try {
    const response = await fetch('/api/rustdesk/config', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idPort: Number($('setting-id-port').value), relayPort: Number($('setting-relay-port').value), natPort: Number($('setting-nat-port').value), publicKey: $('setting-key').value.trim() }) });
    const value = await response.json(); if (!response.ok) throw Error(value.error || '保存失败');
    renderConfiguration(value); $('settings-result').textContent = '连接配置已保存，请同步更新两端官方客户端。'; await refreshStatus();
  } catch (error) { $('settings-result').textContent = error.message; notice(error.message, true); }
  finally { $('save-settings').disabled = false; }
});
async function launch(action, options, button) {
  button.disabled = true;
  const label = button.textContent; button.textContent = '正在启动…';
  notice('正在准备 RustDesk 本机服务…');
  try { const result = await invokeRustDesk(action, options); if (!result?.launched) throw Error(result?.error || '无法启动 RustDesk'); notice('已启动 RustDesk；请在官方客户端中继续操作'); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; button.textContent = label; }
}
$('open-client').addEventListener('click', () => launch('open', {}, $('open-client')));
$('connect-form').addEventListener('submit', event => { event.preventDefault(); const id = $('remote-id').value; if (!/^[0-9 ]{6,30}$/.test(id) || !/^[0-9]{6,20}$/.test(id.replaceAll(' ', ''))) { notice('请输入 6 至 20 位数字的 RustDesk ID', true); return; } void launch('connect', { id }, $('connect-client')); });
async function initDesktop() {
  if (!desktopAvailable()) { $('native-state').textContent = '浏览器模式 · 下载并手动打开官方 RustDesk 客户端'; return; }
  document.documentElement.classList.add('desktop');
  try { const result = await invokeRustDesk('status'); $('native-state').textContent = result.installed ? '已找到 Windows RustDesk 客户端 · 打开时自动启动本机服务' : '尚未找到已安装客户端 · 请先从官方页面安装'; $('open-client').disabled = !result.installed; $('connect-client').disabled = !result.installed; }
  catch (error) { $('native-state').textContent = error.message; }
}
void initDesktop();
void api('config').then(value => { renderConfiguration(value); return refreshStatus(); }).catch(error => { $('config-badge').textContent = '暂不可用'; notice(error.message, true); });
