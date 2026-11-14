import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { root, stageVariant, fileList, assertRuntimePath, sha256 } from '../scripts/package-atb.js';
import { assertPublicSourcePath, assertPublicText, verifyFirstPartyRuntime, createManifest } from '../scripts/release-atb.js';

test('public archive allowlist accepts release tooling and rejects private source', () => {
  for (const filename of ['modules/assistant/package-lock.json', 'modules/assistant/public/vision/LICENSE', 'modules/assistant/public/vision/face_recognition_model-shard2', 'modules/assistant/docs/licenses/node/provenance.json', 'modules/assistant/docs/licenses/pinyin-pro/LICENSE', 'modules/freecamera/archive/worker.js', 'modules/freecamera/RECORDING-ARCHIVE.md', 'scripts/test-local-desktop-ui.js', 'desktop/tray.cjs', 'desktop/tray.png', 'modules/assistant/assistant/chattts-speakers.f32', 'scripts/package-atb.js', 'scripts/release-atb.js', 'desktop/electron-builder.cjs', 'desktop/ui-source.cjs', 'docs/MODULES.md', 'docs/DEPLOYMENT.md', '.github/workflows/release.yml', 'modules/rustdesk/deploy/atb-rustdesk-supervisor.sh']) assert.doesNotThrow(() => assertPublicSourcePath(filename));
  for (const filename of ['docs/SERVER.md', 'docs/cloud-access.md', 'data/account.json', 'certs/ca.crt', 'desktop-profile/Cookies', 'modules/assistant/voice-runtime/python.exe', 'modules/freecamera/models/yolox_tiny.onnx', 'node_modules/secret.js', '../README.md', '.env', 'modules/assistant/assistant/private-speakers.f32', 'unexpected.txt', 'CONTEXT.md', 'scripts/export-macbook-handoff.py', 'modules/assistant/public/vision/arbitrary-weight', 'modules/assistant/docs/licenses/node/secret.json']) assert.throws(() => assertPublicSourcePath(filename), /rejected|not explicitly/);
  assert.throws(() => assertPublicText('-----BEGIN ' + 'PRIVATE KEY-----', 'test.txt'), /Credential/);
  assert.throws(() => assertPublicText('https://' + [93, 184, 216, 34].join('.'), 'test.txt'), /instance address/);
  assert.doesNotThrow(() => assertPublicText('DNS fixture ' + [8,8,8,8].join('.'), 'modules/assistant/test/public-information-request.test.js'));
  assert.doesNotThrow(() => assertPublicText('https://203.0.113.1 and https://127.0.0.1', 'test.txt'));
});

test('runtime inventory rejects private data and module leakage into core', () => {
  for (const filename of ['data/account.json', 'certs/ca.key', 'desktop-profile/Cookies', 'modules/assistant/voice-runtime/python.exe']) assert.throws(() => assertRuntimePath(filename, 'full'));
  for (const filename of ['modules/freecamera/module.json', 'models/model.onnx', 'node_modules/sharp/package.json', 'node_modules/ws/index.js']) assert.throws(() => assertRuntimePath(filename, 'core'));
  assert.doesNotThrow(() => assertRuntimePath('node_modules/node-forge/lib/forge.js', 'core'));
});

test('release provenance rejects altered or missing first-party runtime bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-provenance-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = new Map([['package.json', '{"name":"atb","version":"0.6.0","private":true,"type":"module"}'], ['server/index.js', 'export const platform = "ATB";\n']]);
  await mkdir(path.join(directory, 'server'));
  await writeFile(path.join(directory, 'package.json'), source.get('package.json'));
  await writeFile(path.join(directory, 'server/index.js'), source.get('server/index.js'));
  const options = { variant: 'core', sourceFiles: [...source.keys()], readSource: filename => source.get(filename) };
  await verifyFirstPartyRuntime(directory, options);
  await writeFile(path.join(directory, 'server/index.js'), 'export const platform = "altered";\n');
  await assert.rejects(verifyFirstPartyRuntime(directory, options), /differs from source commit/);
  await rm(path.join(directory, 'server/index.js'));
  await assert.rejects(verifyFirstPartyRuntime(directory, options), /file set differs/);
});

test('manifest writes exact SHA256SUMS including its own hash and rejects checksum tampering', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-checksums-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const source = `ATB-${version}-source.zip`;
  await writeFile(path.join(directory, source), 'source fixture');
  for (const variant of ['full', 'core']) {
    const file = `ATB-${version}-Windows-x64-${variant}.exe`;
    await writeFile(path.join(directory, file), `${variant} executable fixture`);
    await writeFile(path.join(directory, `${variant}-build.json`), JSON.stringify({ file, version, sourceCommit: 'a'.repeat(40) }));
  }
  const manifest = await createManifest(directory);
  const files = [source, ...manifest.artifacts.map(item => item.file), 'release-manifest.json'];
  const expected = (await Promise.all(files.map(async file => `${await sha256(path.join(directory, file))}  ${file}`))).join('\n') + '\n';
  assert.equal(await readFile(path.join(directory, 'SHA256SUMS'), 'utf8'), expected);
  assert.equal('checksums' in manifest, false, 'manifest must not depend on its own checksum file');
  const { verifyChecksums } = await import('../scripts/release-atb.js');
  await verifyChecksums(directory, manifest);
  await writeFile(path.join(directory, 'SHA256SUMS'), expected.replace(/^[a-f0-9]/, value => value === 'a' ? 'b' : 'a'));
  await assert.rejects(verifyChecksums(directory, manifest), /SHA256SUMS/);
});

test('release provenance includes local synthesis setup, pinned data and desktop UI routing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-voice-provenance-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = new Map([
    ['package.json', '{"name":"atb","version":"0.7.0","private":true,"type":"module"}'],
    ['desktop/ui-source.cjs', 'module.exports = {};\n'],
    ['desktop/tray.cjs', 'module.exports = {};\n'],
    ['modules/assistant/desktop/windows-automation.ps1', '# native UI Automation\n'],
    ['desktop/tray.png', Buffer.from([137,80,78,71])],
    ['modules/assistant/scripts/setup-local-tts.py', '# fixed model installer\n'],
    ['modules/assistant/scripts/download-local-tts.js', 'console.log("download");\n'],
    ['modules/assistant/assistant/qwen-tts-capabilities.json', '{}\n'],
    ['modules/assistant/scripts/import-chattts-speakers.py', '# pinned speaker importer\n'],
    ['modules/assistant/assistant/chattts-speakers.json', '{}\n'],
    ['modules/assistant/assistant/chattts-speakers.f32', Buffer.from([0,255,128,1])],
    ['modules/assistant/assistant/local-tts-manifest.json', '{"files":[]}\n'],
    ['modules/assistant/server/volcengine-voices.json', '{"voices":[]}\n'],
    ['modules/assistant/docs/LOCAL-TTS-LICENSES.md', 'Model licensing notice\n'],
    ['modules/assistant/public/vision/LICENSE', 'MIT fixture\n'],
    ['modules/assistant/public/vision/provenance.json', '{}\n'],
    ['modules/assistant/public/vision/face_recognition_model-shard2', Buffer.from([1,2,3])],
    ['modules/assistant/docs/licenses/node/LICENSE.txt', 'Node license\n'],
    ['modules/assistant/docs/licenses/node/provenance.json', '{}\n'],
    ['modules/assistant/docs/licenses/pinyin-pro/LICENSE', 'MIT fixture\n'],
    ['modules/assistant/docs/licenses/pinyin-pro/provenance.json', '{}\n'],
  ]);
  for (const [filename, content] of source) {
    await mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
    await writeFile(path.join(directory, filename), content);
  }
  await verifyFirstPartyRuntime(directory, { variant: 'full', sourceFiles: [...source.keys()], readSource: filename => source.get(filename) });
  await rm(path.join(directory, 'modules/assistant/assistant/local-tts-manifest.json'));
  await assert.rejects(verifyFirstPartyRuntime(directory, { variant: 'full', sourceFiles: [...source.keys()], readSource: filename => source.get(filename) }), /file set differs/);
});

test('clean staging has no private assets and core loads without a modules directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-package-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  let fullAvailable = true;
  for (const filename of ['modules/assistant/module.json', 'modules/rustdesk/module.json', 'modules/freecamera/models/yolox_tiny.onnx']) {
    try { await access(path.join(root, filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; fullAvailable = false; }
  }
  if (fullAvailable) {
    const { stage: full } = await stageVariant('full', { stageRoot: directory });
    const fullFiles = await fileList(full);
    assert.ok(fullFiles.includes('modules/assistant/desktop/windows-automation.ps1'));
    assert.ok(fullFiles.includes('modules/freecamera/models/yolox_tiny.onnx'));
    assert.ok(fullFiles.includes('modules/freecamera/node_modules/onnxruntime-node/package.json'));
    assert.ok(fullFiles.includes('modules/assistant/scripts/setup-assistant-voice.py'));
    for (const filename of ['scripts/setup-local-tts.py', 'scripts/download-local-tts.js', 'scripts/import-chattts-speakers.py', 'assistant/chattts-speakers.json', 'assistant/chattts-speakers.f32', 'assistant/local-tts-manifest.json', 'assistant/qwen-tts-capabilities.json', 'server/volcengine-voices.json', 'docs/LOCAL-TTS-LICENSES.md']) {
      assert.ok(fullFiles.includes(`modules/assistant/${filename}`), `Missing assistant distribution asset: ${filename}`);
    }
    assert.equal(fullFiles.some(filename => /\.(?:key|crt)$/.test(filename)||!filename.includes('/node_modules/')&&/(?:^|\/)voice-runtime\/|(?:^|\/)data\//.test(filename)), false);
    const {createDshAgent}=await import(pathToFileURL(path.join(full,'modules/assistant/server/dsh-agent.js')).href);
    const agent=createDshAgent({request:async()=>Response.json({choices:[{message:{content:'暂存运行通过'}}]})});
    try {const result=await agent.run({url:'https://fixture.example/v1',protocol:'chat',options:{body:JSON.stringify({messages:[{role:'user',content:'隔离分发检查'}]})},registry:{definitions:[],execute:async()=>{throw Error('unexpected tool');}}});assert.equal(result.answer,'暂存运行通过');}finally{await agent.close();}
  } else t.diagnostic('Full staging check requires all three modules and the downloaded model; core check still runs.');
  const { stage: core } = await stageVariant('core', { stageRoot: directory });
  const files = await fileList(core);
  const { createUiSource } = await import(pathToFileURL(path.join(core, 'desktop/ui-source.cjs')).href);
  assert.equal(createUiSource({ local: () => ({ origin: 'https://localhost:8443' }), selected: () => null, modules: [] }).trustedPage('https://localhost:8443/platform'), true);
  for (const filename of files) assertRuntimePath(filename, 'core');
  await assert.rejects(access(path.join(core, 'modules')), { code: 'ENOENT' });
  const { loadModules } = await import(pathToFileURL(path.join(core, 'server/modules.js')).href);
  const modules = await loadModules({ modulesDir: path.join(core, 'modules'), context: {} });
  assert.deepEqual(modules.list(), []); await modules.close();
});

test('test runner supports an absent modules directory and recursive syntax checks include module code', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atb-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts')); await mkdir(path.join(directory, 'test'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(directory, 'test/smoke.test.js'), 'import test from "node:test"; test("core only", () => {});');
  for (const name of ['check.js', 'test-all.js']) await cp(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
  assert.equal(spawnSync(process.execPath, ['scripts/test-all.js'], { cwd: directory, windowsHide: true }).status, 0);
  await mkdir(path.join(directory, 'modules/example/server'), { recursive: true });
  await writeFile(path.join(directory, 'modules/example/server/broken.js'), 'invalid { syntax');
  assert.notEqual(spawnSync(process.execPath, ['scripts/check.js'], { cwd: directory, windowsHide: true }).status, 0);
  await rm(path.join(directory, 'modules/example/server/broken.js'));
  await mkdir(path.join(directory, 'modules/example/data'), { recursive: true });
  await writeFile(path.join(directory, 'modules/example/data/private.js'), 'invalid { syntax');
  assert.equal(spawnSync(process.execPath, ['scripts/check.js'], { cwd: directory, windowsHide: true }).status, 0);
});
