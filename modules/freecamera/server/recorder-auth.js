import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

export function loadRecorderToken(file = process.env.ATB_RECORDER_TOKEN_FILE) {
  if (!file) return null;
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid private recorder credential');
  return token;
}
export function recorderAuthorized(req, token) {
  if (!token || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(p => p.trim());
  return protocols.length === 2 && protocols[0] === 'atb-archive' && /^[a-f0-9]{64}$/.test(protocols[1]) && timingSafeEqual(Buffer.from(protocols[1]), Buffer.from(token));
}
