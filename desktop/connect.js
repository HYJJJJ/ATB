const $ = id => document.getElementById(id), api = window.atbDesktop;
function error(message) { $('connection-error').hidden = !message; $('connection-error').textContent = message || ''; }
function certificate(info) { $('certificate-info').textContent = info ? `${info.subject}\nSHA-256: ${info.fingerprint}` : '尚未选择根证书'; }
function busy(value) { document.querySelectorAll('button,input').forEach(input => input.disabled = value); }
async function connect(mode, savedOrigin) {
  error(''); busy(true); $('connection-status').textContent = mode === 'local' ? '正在启动本机服务…' : '正在验证并连接远程服务…';
  try {
    const result = await api.selectConnection({ mode, address: $('remote-address').value, savedOrigin });
    if (!result.ok) { error(result.error); $('connection-status').textContent = ''; }
  } catch (e) { error(e.message); $('connection-status').textContent = ''; }
  finally { busy(false); }
}
$('connect-local').addEventListener('click', () => void connect('local'));
$('return-viewer').addEventListener('click', async () => {
  error(''); busy(true);
  try { const result = await api.returnToViewer(); if (!result.ok) error(result.error); }
  catch (e) { error(e.message); } finally { busy(false); }
});
$('remote-form').addEventListener('submit', event => { event.preventDefault(); void connect('remote'); });
$('remote-address').addEventListener('input', () => {
  void api.saveConnectionDraft({ address: $('remote-address').value }).catch(e => error(e.message));
});
$('choose-certificate').addEventListener('click', async () => {
  error(''); busy(true);
  try { const result = await api.chooseConnectionCertificate(); if (!result.canceled) certificate(result); }
  catch (e) { error(e.message); } finally { busy(false); }
});
api.connectionState().then(state => {
  document.title = `ATB ${state.version} · 连接设置`;
  $('settings-title').textContent = `连接设置 · v${state.version}`;
  $('return-viewer').hidden = !state.canReturn;
  $('saved-services').hidden = !state.remotes.length;
  for (const remote of state.remotes) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary saved-remote';
    button.dataset.origin = remote.origin; button.textContent = `连接 ${remote.origin}`;
    button.addEventListener('click', () => void connect('remote', remote.origin));
    $('saved-connections').append(button);
  }
  $('remote-address').value = state.origin; $('local-url').textContent = state.localUrl;
  const addresses = $('tailscale-urls');
  if (!state.tailscaleUrls.length) addresses.textContent = '尚未发现 Tailscale 地址，请先安装并连接。';
  for (const url of state.tailscaleUrls) { const item = document.createElement('code'); item.textContent = url; addresses.append(item); }
  certificate(state.certificate); error(state.error);
}).catch(e => error(e.message));
