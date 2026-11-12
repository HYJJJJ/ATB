const { open } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

class RecordingFiles {
  constructor() {
    this.recordings = new Map();
    this.closedOwners = new Set();
    this.openingOwners = new Set();
  }

  async begin(owner, filename) {
    if (this.closedOwners.has(owner)) throw new Error('The window is closed');
    if (this.openingOwners.has(owner) || [...this.recordings.values()].some(entry => entry.owner === owner)) throw new Error('A recording is already open or pending');
    this.openingOwners.add(owner);
    try {
      const handle = await open(filename, 'w', 0o600);
      if (this.closedOwners.has(owner)) { await handle.close(); throw new Error('The window is closed'); }
      const id = randomUUID();
      this.recordings.set(id, { owner, filename, handle, queue: Promise.resolve(), pending: 0, finishing: null });
      return { id, canceled: false };
    } finally { this.openingOwners.delete(owner); }
  }

  entry(owner, id) {
    const entry = this.recordings.get(id);
    if (!entry) throw new Error('Recording is closed or unknown');
    if (entry.owner !== owner) throw new Error('Recording belongs to another window owner');
    return entry;
  }

  async write(owner, id, data) {
    const entry = this.entry(owner, id);
    if (entry.finishing) throw new Error('Recording is closed');
    if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > MAX_CHUNK_BYTES) throw new Error('Invalid recording chunk size');
    if (entry.pending + data.byteLength > MAX_PENDING_BYTES) throw new Error('Recording write queue is too large');
    const bytes = Buffer.from(data);
    entry.pending += bytes.length;
    entry.queue = entry.queue.then(async () => {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await entry.handle.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error('Unable to write recording');
        offset += bytesWritten;
      }
    }).finally(() => { entry.pending -= bytes.length; });
    // Keep a rejected disk operation observable to callers without an unhandled rejection during shutdown.
    entry.queue.catch(() => {});
    return entry.queue;
  }

  async end(owner, id) {
    const entry = this.entry(owner, id);
    if (!entry.finishing) {
      entry.finishing = (async () => {
        try { await entry.queue; }
        finally { try { await entry.handle.close(); } finally { this.recordings.delete(id); } }
        return { path: entry.filename };
      })();
    }
    return entry.finishing;
  }

  async closeOwner(owner) {
    this.closedOwners.add(owner);
    await Promise.allSettled([...this.recordings].filter(([, entry]) => entry.owner === owner).map(([id]) => this.end(owner, id)));
  }

  async closeAll() {
    await Promise.allSettled([...new Set([...this.recordings.values()].map(entry => entry.owner))].map(owner => this.closeOwner(owner)));
  }
}

module.exports = { RecordingFiles, MAX_CHUNK_BYTES };
