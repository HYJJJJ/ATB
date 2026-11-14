// Fixed upstream release; downloads contain code/model assets, never user data.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../public/vision/', import.meta.url);
await mkdir(root, { recursive: true });
const base = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/0.22.2/';
const files = ['dist/face-api.min.js', 'LICENSE', ...['tiny_face_detector', 'face_landmark_68', 'face_recognition'].map(name => `weights/${name}_model-weights_manifest.json`)];
const hashes = {};
async function download(source, name) {
  let bytes;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(base + source, { signal: AbortSignal.timeout(90000) }); if (!response.ok) throw Error(`Upstream ${response.status}: ${source}`);
      bytes = Buffer.from(await response.arrayBuffer()); break;
    } catch (error) { if (attempt === 3) throw error; }
  }
  await writeFile(new URL(name, root), bytes); hashes[name] = createHash('sha256').update(bytes).digest('hex');
  return bytes;
}
for (const source of files) {
  const name = source.split('/').at(-1), bytes = await download(source, name);
  if (name.endsWith('_manifest.json')) for (const group of JSON.parse(bytes)) for (const shard of group.paths) if (!hashes[shard]) await download('weights/' + shard, shard);
}
await writeFile(new URL('provenance.json', root), JSON.stringify({ source: base, version: '0.22.2', sha256: hashes }, null, 2));
console.log(`Installed ${Object.keys(hashes).length} fixed-version local face assets.`);
