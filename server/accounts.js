import { EventEmitter } from 'node:events';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const derive = promisify(scrypt);
export const SESSION_COOKIE = '__Host-freecamera';
export function sessionToken(req) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || '';
}
export class AccountStore extends EventEmitter {
  constructor(filename = null, record = null, { now = Date.now, sessionMs = 7 * 86400000 } = {}) {
    super(); this.filename = filename; this.record = record; this.now = now; this.sessionMs = sessionMs;
    this.sessions = new Map(); this.settingUp = false; this.verifying = 0; this.pending = Promise.resolve();
    this.sessionFile = filename ? path.join(path.dirname(filename), 'account-sessions.json') : null;
  }
  static async load(filename, options) {
    try {
      const accounts = new AccountStore(filename, JSON.parse(await readFile(filename, 'utf8')), options);
      let saved;
      try { saved = JSON.parse(await readFile(accounts.sessionFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved?.accountHash === accounts.record.hash && Array.isArray(saved.sessions)) {
        for (const session of saved.sessions.slice(-128)) if (/^[a-f0-9]{64}$/.test(session.id) && Number.isFinite(session.expires) && session.expires > accounts.now()) {
          accounts.sessions.set(session.id, { expires: session.expires, user: { username: accounts.record.username, role: 'admin' } });
        }
      }
      return accounts;
    }
    catch (error) { if (error.code === 'ENOENT') return new AccountStore(filename, null, options); throw error; }
  }
  get configured() { return !!this.record; }
  async setup(username, password) {
    if (this.configured || this.settingUp) throw Error('管理员账户已创建');
    if (typeof username !== 'string' || typeof password !== 'string') throw Error('账号和密码必须是文本');
    this.settingUp = true;
    try {
      const salt = randomBytes(32).toString('hex');
      const record = { username, role: 'admin', salt, hash: (await derive(password, salt, 64)).toString('hex') };
      if (this.filename) {
        await mkdir(path.dirname(this.filename), { recursive: true });
        await writeFile(`${this.filename}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
        await rename(`${this.filename}.tmp`, this.filename);
      }
      this.record = record;
    } finally { this.settingUp = false; }
  }
  async login(username, password) {
    if (!this.record || typeof username !== 'string' || typeof password !== 'string' || this.verifying >= 4) return null;
    this.verifying++;
    try {
      const candidate = await derive(password, this.record.salt, 64);
      if (!timingSafeEqual(candidate, Buffer.from(this.record.hash, 'hex')) || username !== this.record.username) return null;
      for (const [id, session] of this.sessions) if (session.expires <= this.now()) this.revoke(id);
      if (this.sessions.size >= 128) this.revoke(this.sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      const session = { token, expires: this.now() + this.sessionMs, user: { username: this.record.username, role: 'admin' } };
      this.sessions.set(this.sessionId(token), { expires: session.expires, user: session.user });
      try { await this.persistSessions(); } catch (error) { this.sessions.delete(this.sessionId(token)); throw error; }
      return session;
    } finally { this.verifying--; }
  }
  session(token) {
    const session = this.sessions.get(this.sessionId(token));
    if (!session) return null;
    if (session.expires <= this.now()) { this.logout(token); return null; }
    return session;
  }
  sessionId(token) { return createHash('sha256').update(typeof token === 'string' ? token : '').digest('hex'); }
  persistSessions() {
    if (!this.sessionFile) return Promise.resolve();
    const data = JSON.stringify({ accountHash: this.record.hash, sessions: [...this.sessions].map(([id, session]) => ({ id, expires: session.expires })) });
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.sessionFile), { recursive: true });
      await writeFile(`${this.sessionFile}.tmp`, data, { mode: 0o600 }); await rename(`${this.sessionFile}.tmp`, this.sessionFile);
    });
    this.pending.catch(error => console.error('Session persistence:', error.message)); return this.pending;
  }
  revoke(id) { if (this.sessions.delete(id)) { this.emit('revoked', id); void this.persistSessions(); } }
  logout(token) { this.revoke(this.sessionId(token)); }
}
