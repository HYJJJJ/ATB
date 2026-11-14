import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

test('archive CLI runs through the release symlink instead of silently exiting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atb-archive-entry-'));
  const alias = path.join(root, 'current');
  await symlink(fileURLToPath(new URL('../archive', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = spawnSync(process.execPath, [path.join(alias, 'worker.js'), path.join(root, 'missing-config.json')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1, 'the CLI must actually attempt the supplied configuration');
    assert.match(result.stderr, /archive-start-failed/);
    assert.doesNotMatch(result.stderr, /missing-config/);
  } finally { await rm(alias); await rm(root, { recursive: true, force: true }); }
});
