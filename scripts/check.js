import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['node_modules', 'test-results', 'data', 'certs', 'private', 'desktop-profile', '__pycache__', '.git']);
async function check(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) await check(filename);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ['server', 'public', 'desktop', 'scripts', 'test', 'modules']) await check(path.join(root, directory));
console.log('All platform and module JavaScript syntax checks passed.');
