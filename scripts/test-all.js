import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function entries(directory) {
  try { return readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function tests(directory) { return entries(directory).filter(entry => entry.isFile() && entry.name.endsWith('.test.js')).map(entry => path.join(directory, entry.name)); }
const files = tests(path.join(root, 'test'));
for (const entry of entries(path.join(root, 'modules'))) if (entry.isDirectory()) files.push(...tests(path.join(root, 'modules', entry.name, 'test')));
if (!files.length) throw Error('No tests discovered');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true, cwd: root });
process.exit(result.status ?? 1);
