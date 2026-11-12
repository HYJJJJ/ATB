import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import { attachSignaling } from './signaling.js';
import { DeviceStore } from './devices.js';
import { DetectionPreference } from './detection-preference.js';
import { createDetector } from './detector.js';
import { startStun } from './stun.js';
import { startRelay } from './relay.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
function port(value, fallback, allowZero = false) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 65535) throw Error('TURN 端口必须为 1–65535 的整数');
  return number;
}

export default async function createModule({ accounts, dataDir, config: options }) {
  const { lanIp, httpsPort, httpPort, tailscaleAddresses = [], certRootName = 'FreeCamera Local Root' } = options;
  let publicOrigin = options.publicOrigin || null, publicIp;
  let relayPublicPort = options.relayPublicPort ?? process.env.TURN_PUBLIC_PORT;
  if (publicOrigin) {
    let url;
    try { url = new URL(publicOrigin); } catch { throw Error('PUBLIC_ORIGIN 必须是 HTTPS IPv4 服务地址'); }
    if (url.protocol !== 'https:' || isIP(url.hostname) !== 4 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('PUBLIC_ORIGIN 必须是 HTTPS IPv4 地址，不含账号、路径或参数');
    publicOrigin = url.origin; publicIp = url.hostname;
    try { relayPublicPort = port(relayPublicPort); } catch { throw Error('TURN_PUBLIC_PORT 必须是公网映射端口，范围 1–65535'); }
    if (!accounts?.configured) throw Error('公网部署前须通过服务器本机初始化管理员账户');
  }
  const relayPort = port(options.relayPort ?? process.env.TURN_PORT, httpsPort === 65535 ? 65534 : httpsPort + 1, true);
  const detector = Object.hasOwn(options, 'detector') && options.detector !== undefined ? options.detector : process.env.DETECTION_ENABLED === '0' ? null : createDetector();
  const iceServers = publicOrigin ? [] : [{ urls: [...new Set([lanIp, ...tailscaleAddresses])].map(ip => `stun:${ip}:${httpsPort}`) }];
  const base = publicOrigin || `https://${lanIp}:${httpsPort}`;
  const config = {
    cameraUrl: `${base}/?mode=camera`, viewerUrl: `${base}/?mode=viewer`,
    setupUrl: publicOrigin ? `${base}/setup` : `http://${lanIp}:${httpPort}`,
    ip: publicOrigin ? publicIp : lanIp, iceServers, tailscaleAddresses: publicOrigin ? [] : tailscaleAddresses,
    requireCameraLogin: !!publicOrigin, acceptsComputeProvider: detector === null,
    ...(publicOrigin ? { iceTransportPolicy: 'relay' } : {}),
  };
  const store = await DeviceStore.load(path.join(dataDir, 'devices.json'));
  const detectionPreference = await DetectionPreference.load(path.join(dataDir, 'detection-preference.json'));
  let relay, signaling, stun, attached = false, closing;
  const requestCameraConfig = requestConfig => ({ ...config, ...requestConfig });
  function transformAsset(filename, content, requestConfig) {
    const current = requestCameraConfig(requestConfig);
    if (filename === 'public/setup.html') content = content.replaceAll('{{cameraUrl}}', current.cameraUrl).replaceAll('{{setupUrl}}', current.setupUrl)
      .replaceAll('FreeCamera Local Root', certRootName).replaceAll('{{connectionNote}}', publicOrigin ? '手机与观看设备只需能访问这台服务器，无需 Tailscale，家庭电脑可关机。首次添加摄像头需要管理员登录。' : '手机与电脑需通过局域网或同一个 Tailscale 网络互通，电脑服务需要一直运行。');
    if (publicOrigin && filename === 'public/index.html') content = content.replace('本地连接 · 本地检测', '公网连接 · 加密传输').replace('画面与模型均在本地运行。', '音视频经服务器加密中继，截图和录像保存在观看设备。').replace('局域网摄像头', '公网摄像头').replace('FREECAMERA / LOCAL FIRST', 'FREECAMERA / CLOUD');
    return content;
  }
  async function close() {
    return closing ??= (async () => {
      const results = await Promise.allSettled([
        stun?.close(), signaling ? signaling.close() : Promise.allSettled([detector?.close?.(), detector?.disable?.()]),
        relay?.close(), store.pending, detectionPreference.pending,
      ]);
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    })();
  }
  return {
    config,
    transformAsset,
    get relay() { return relay; },
    async handle(req, res, pathname, requestConfig) {
      if (!['GET', 'HEAD'].includes(req.method)) return false;
      const respond = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : body); };
      if (pathname === '/' && (requestConfig.secure === false || ['camera', 'viewer'].includes(new URL(req.url, 'http://localhost').searchParams.get('mode'))) || requestConfig.secure === false && pathname === '/setup') {
        const filename = requestConfig.secure === false ? 'setup.html' : 'index.html';
        const body = transformAsset(`public/${filename}`, await readFile(path.join(publicDir, filename), 'utf8'), requestConfig);
        respond('text/html; charset=utf-8', body); return true;
      }
      if (requestConfig.secure === false && pathname === '/style.css') {
        respond('text/css; charset=utf-8', await readFile(path.join(publicDir, 'style.css'), 'utf8')); return true;
      }
      if (pathname === '/qr.svg' || pathname === '/setup-qr.svg') {
        const current = requestCameraConfig(requestConfig);
        respond('image/svg+xml', await QRCode.toString(pathname === '/setup-qr.svg' ? current.setupUrl : current.cameraUrl, { type: 'svg', margin: 2, width: 196 }));
        return true;
      }
      return false;
    },
    async attach(secureServer) {
      if (attached || closing) throw Error('FreeCamera module already attached or closed');
      attached = true;
      try {
        relay = await startRelay({ addresses: publicOrigin ? [publicIp] : [lanIp, ...tailscaleAddresses], relayIp: lanIp, port: relayPort, advertisedPort: publicOrigin ? relayPublicPort : undefined, allowPublic: !!publicOrigin });
        signaling = attachSignaling(secureServer, { store, detector, detectionPreference, accounts, relay, iceServers, requireCameraLogin: !!publicOrigin });
        if (!publicOrigin) stun = await startStun(httpsPort);
      } catch (error) { await close(); throw error; }
    },
    close,
  };
}
