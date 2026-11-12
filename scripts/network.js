import os from 'node:os';
import { isIP } from 'node:net';

export function lanAddresses() {
  const entries = Object.entries(os.networkInterfaces()).flatMap(([name, values]) =>
    (values ?? []).filter(v => v.family === 'IPv4' && !v.internal && !v.address.startsWith('169.254.'))
      .map(v => ({ name, ip: v.address })));
  return entries.sort((a, b) => score(b) - score(a)).map(e => e.ip);
}
function score({ name, ip }) {
  return (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 10 : 0)
    - (/virtual|vEthernet|VPN|WSL|cloud|docker/i.test(name) ? 20 : 0);
}
export function selectedIp() {
  const ip = process.env.LAN_IP || lanAddresses()[0] || '127.0.0.1';
  if (isIP(ip) !== 4) throw new Error('LAN_IP 必须是电脑的 IPv4 地址，例如 192.168.1.3');
  return ip;
}
