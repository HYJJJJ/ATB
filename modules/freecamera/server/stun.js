import dgram from 'node:dgram';
import { isIP } from 'node:net';

export function privateAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
export async function startStun(port) {
  const socket = dgram.createSocket('udp4'), attempts = new Map();
  let closing = false;
  socket.on('message', (packet, source) => {
    if (closing || !privateAddress(source.address) || packet.length < 20 || packet.length > 1200 || packet.readUInt16BE(0) !== 1 || packet.readUInt32BE(4) !== 0x2112a442 || packet.readUInt16BE(2) !== packet.length - 20 || packet.length % 4) return;
    for (let offset = 20; offset < packet.length;) {
      if (offset + 4 > packet.length) return;
      offset += 4 + ((packet.readUInt16BE(offset + 2) + 3) & ~3); if (offset > packet.length) return;
    }
    const now = Date.now();
    for (const [ip, entry] of attempts) if (now - entry.time > 1000) attempts.delete(ip);
    if (!attempts.has(source.address)) { if (attempts.size >= 1024) return; attempts.set(source.address, { time: now, count: 0 }); }
    if (++attempts.get(source.address).count > 20) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101,0); response.writeUInt16BE(12,2); response.writeUInt32BE(0x2112a442,4); packet.copy(response,8,8,20);
    response.writeUInt16BE(0x0020,20); response.writeUInt16BE(8,22); response[25] = 1;
    response.writeUInt16BE(source.port ^ 0x2112,26);
    const octets = source.address.split('.').map(Number), cookie = [0x21,0x12,0xa4,0x42];
    for (let i=0;i<4;i++) response[28+i] = octets[i] ^ cookie[i];
    socket.send(response,source.port,source.address,()=>{});
  });
  try { await new Promise((resolve,reject) => { socket.once('error',reject); socket.bind(port,'0.0.0.0',()=>{ socket.off('error',reject); resolve(); }); }); }
  catch (error) { try { socket.close(); } catch {} throw error; }
  socket.on('error',error=>console.error('Private STUN:',error.message));
  return { close() { if (closing) return Promise.resolve(); closing = true; return new Promise(resolve=>socket.close(resolve)); } };
}
