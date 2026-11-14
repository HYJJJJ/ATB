import { gunzipSync } from 'node:zlib';
const connectionEvents = new Set([1, 2, 50, 51, 52]);
const number = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
export function encodeTtsFrame(event = 0, payload = {}, sessionId = '') {
  const body = Buffer.from(JSON.stringify(payload)), id = Buffer.from(sessionId);
  return Buffer.concat([Buffer.from([0x11, event ? 0x14 : 0x10, 0x10, 0]),
    ...(event ? [number(event), ...(!connectionEvents.has(event) ? [number(id.length), id] : [])] : []), number(body.length), body]);
}
export function decodeTtsFrame(data) {
  const bytes = Buffer.from(data); let offset = (bytes[0] & 15) * 4;
  if (bytes.length < 4 || bytes[0] >> 4 !== 1 || offset < 4 || offset > bytes.length || ![0, 1].includes(bytes[2] & 15)) throw Error('语音二进制帧格式或压缩无效');
  const take = count => { if (count < 0 || offset + count > bytes.length) throw Error('语音二进制帧长度无效'); const value = bytes.subarray(offset, offset + count); offset += count; return value; };
  const uint = () => take(4).readUInt32BE(), type = bytes[1] >> 4, flags = bytes[1] & 15;
  if (![1, 9, 11, 15].includes(type) || ![0, 1, 2, 3, 4].includes(flags) || ![0, 1].includes(bytes[2] >> 4)) throw Error('语音二进制帧格式无效');
  let sequence, code, event = 0, sessionId = '', connectId = '';
  if (type === 15) code = uint(); else if (flags === 1 || flags === 3) sequence = take(4).readInt32BE();
  if (flags === 4) {
    event = uint();
    if ([50, 51, 52].includes(event)) connectId = take(uint()).toString('utf8');
    else if (!connectionEvents.has(event)) sessionId = take(uint()).toString('utf8');
  }
  let payload = take(uint()); if (offset !== bytes.length) throw Error('语音二进制帧长度无效');
  if (bytes[2] & 15) payload = gunzipSync(payload, { maxOutputLength: 1024 * 1024 });
  return { type, flags, event, sessionId, connectId, sequence, code, payload };
}
