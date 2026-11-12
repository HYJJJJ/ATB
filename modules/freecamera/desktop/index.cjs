const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { NativeCompute } = require('./compute.cjs');
const { RecordingFiles } = require('./recording-files.cjs');

function createDesktopModule({ app, window, chooseFile }) {
  const compute = new NativeCompute();
  const recordings = new RecordingFiles();
  const generations = new Map();
  let closed = false;
  const generation = owner => generations.get(owner) || 0;
  const valid = (owner, epoch) => !closed && generation(owner) === epoch && window() && !window().isDestroyed() && window().webContents.id === owner;
  const handlers = {
    'compute-open': () => compute.open(),
    'compute-close': (_owner, { leaseId } = {}) => compute.close(leaseId),
    'compute-heartbeat': (_owner, options) => compute.heartbeat(options),
    'detection-state': () => compute.state,
    'detection-configure': (_owner, options) => compute.configure(options),
    'detection-frame': (_owner, options) => compute.detect(options),
    async 'recording-begin'(owner, { mimeType }) {
      if (typeof mimeType !== 'string' || mimeType.length > 200 || !/^video\/(webm|mp4)(;.*)?$/i.test(mimeType)) throw Error('Unsupported recording format');
      const epoch = generation(owner), extension = /^video\/mp4/i.test(mimeType) ? 'mp4' : 'webm';
      const result = await chooseFile(owner, {
        title: '保存监控录像', defaultPath: path.join(app.getPath('videos'), `FreeCamera-${Date.now()}.${extension}`),
        filters: [{ name: `${extension.toUpperCase()} 录像`, extensions: [extension] }],
      });
      if (result.canceled || !result.filePath || !valid(owner, epoch)) return { canceled: true };
      recordings.closedOwners.delete(owner);
      return recordings.begin(owner, result.filePath);
    },
    'recording-write': (owner, { id, data }) => recordings.write(owner, id, data),
    'recording-end': (owner, { id }) => recordings.end(owner, id),
    async snapshot(owner, { data }) {
      const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!(data instanceof Uint8Array) || data.byteLength < 8 || data.byteLength > 32 * 1024 * 1024 || !Buffer.from(data.buffer, data.byteOffset, 8).equals(signature)) throw Error('Invalid PNG snapshot');
      const epoch = generation(owner);
      const result = await chooseFile(owner, { title: '保存监控截图', defaultPath: path.join(app.getPath('pictures'), `FreeCamera-${Date.now()}.png`), filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      if (result.canceled || !result.filePath || !valid(owner, epoch)) return { canceled: true };
      await writeFile(result.filePath, data, { mode: 0o600 });
      return { path: result.filePath, canceled: false };
    },
  };
  return {
    handlers,
    async suspend(owner) { generations.set(owner, generation(owner) + 1); await compute.close(); await recordings.closeOwner(owner); },
    async close() { if (closed) return; closed = true; await compute.close(); await recordings.closeAll(); },
  };
}
module.exports = { createDesktopModule };
