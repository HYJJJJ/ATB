import { readFile, writeFile, stat, mkdir, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, releaseDirectory, runtimePackage, sha256, fileList, assertRuntimePath, sourceMetadata } from './package-atb.js';

const require = createRequire(import.meta.url);
const privatePath = /(?:^|\/)(?:data|certs|private|desktop-profile|voice-runtime|tts-runtime|qwen-tts-runtime|\.venv|venv|test-results|node_modules|exports|\.git)(?:\/|$)|(?:^|\/)release[^/]*\/|(?:^|\/)\.env(?:\.|$)|\.(?:log|pem|key|crt|cer|pfx|p12|dpapi|sqlite|db|onnx|exe|zip)$/i;
export function assertPublicSourcePath(filename) {
  if (filename.includes('\\') || filename.startsWith('/') || filename.split('/').some(part => part === '..') || privatePath.test(filename)) throw Error(`Private or unsafe source path rejected: ${filename}`);
  const allowed = /^(?:package(?:-lock)?\.json|README\.md|LICENSE|\.gitignore|\.gitattributes|Start-ATB(?:-Desktop)?\.cmd)$/i.test(filename)
    || /^\.github\/workflows\/release\.yml$/.test(filename)
    || /^docs\/(?:MODULES|RELEASING|RELEASE|DEPLOYMENT|SECURITY|THIRD-PARTY)\.md$/.test(filename)
    || /^deploy\/[a-zA-Z0-9_.\/-]+$/.test(filename)
    || /^desktop\/(?:main|preload|module-host|service|trust|ui-source|tray|electron-builder)\.cjs$|^desktop\/connect\.(?:js|css|html)$|^desktop\/tray\.png$/.test(filename)
    || /^(?:server\/[^/]+\.js|public\/[^/]+\.(?:js|css|html|svg)|test\/[^/]+\.test\.js)$/.test(filename)
    || /^scripts\/(?:package-atb|release-atb|check|test-all|test-packaged-atb|test-local-desktop-ui|network|setup-cert)\.js$/.test(filename)
    || /^modules\/(?:assistant|freecamera|rustdesk)\/(?:module\.json|package(?:-lock)?\.json|README\.md)$/.test(filename)
    || /^modules\/freecamera\/(?:RECORDING-ARCHIVE\.md|archive\/(?:baidu|receiver|store|verify|worker)\.js|archive\/package\.json)$/.test(filename)
    || /^modules\/assistant\/docs\/licenses\/(?:node|pinyin-pro)\/(?:LICENSE(?:\.txt)?|provenance\.json)$/.test(filename)
    || /^modules\/assistant\/public\/vision\/(?:LICENSE|(?:tiny_face_detector_model|face_landmark_68_model)-shard1|face_recognition_model-shard[12])$/.test(filename)
    || /^modules\/(?:assistant|freecamera|rustdesk)\/(?:server|desktop|public|test|scripts|assistant|deploy)\/[a-zA-Z0-9_.\/-]+\.(?:[cm]?js|html|css|svg|py|sh|service|timer|json|md|txt|ps1)$/.test(filename)
    || /^modules\/(?:assistant|freecamera|rustdesk)\/docs\/(?:[a-zA-Z0-9_.-]+\.md|licenses\/[a-zA-Z0-9_.-]+\.txt)$/.test(filename)
    || /^modules\/freecamera\/models\/(?:metadata\.json|README\.md|LICENSE(?:\.txt)?)$/.test(filename);
  if (!allowed && filename !== 'modules/assistant/assistant/chattts-speakers.f32') throw Error(`Source file is not explicitly public: ${filename}`);
}
export function assertPublicText(content, filename) {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]{80,}|(?:sk-[a-zA-Z0-9]{24,})/.test(content)) throw Error(`Credential material rejected: ${filename}`);
  // Documentation examples must use placeholders, loopback, private LAN, or RFC 5737 addresses.
  for (const match of content.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
    const ip = match[0], parts = ip.split('.').map(Number);
    // The official Node license quotes a four-part zlib version, not a host.
    if (filename === 'modules/assistant/docs/licenses/node/LICENSE.txt' && ip === [1, 3, 2, 1].join('.')
      && content.includes(`version ${ip}, February`)) continue;
    // These routable addresses exercise the SSRF classifier; they are fixtures,
    // never configured production servers. Reserved ranges cannot test that branch.
    const classifierFixtures = [[8, 8, 8, 8], [1, 1, 1, 1], [93, 184, 216, 34]].map(parts => parts.join('.'));
    if (filename === 'modules/assistant/test/model-request.test.js' && classifierFixtures.includes(ip)
      || filename === 'modules/assistant/test/public-information-request.test.js' && ip === classifierFixtures[0]) continue;
    if (parts.some(n => n > 255)) continue;
    if (parts[0] >= 224 || /^(?:127\.|10\.|192\.168\.|169\.254\.|192\.0\.[02]\.|198\.51\.100\.|203\.0\.113\.)/.test(ip) || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 || parts[0] === 198 && [18, 19].includes(parts[1])) continue;
    // Version numbers like 0.6.0.1 are not network addresses.
    if (parts[0] === 0) continue;
    throw Error(`Public instance address rejected: ${filename}`);
  }
}
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`Git verification failed: ${args.slice(0, 2).join(' ')}`);
  return result.stdout.trim();
}
function gitBlob(sourceCommit, filename) {
  const result = spawnSync('git', ['show', `${sourceCommit}:${filename}`], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`Source blob unavailable: ${filename}`);
  return result.stdout;
}
function packagedSource(filename, variant) {
  if (/^(?:LICENSE|docs\/THIRD-PARTY\.md)$/.test(filename)
    || /^(?:server\/[^/]+\.js|public\/[^/]+\.(?:js|css|html|svg|png|jpg))$/.test(filename)
    || /^desktop\/(?:(?:main|preload|module-host|service|trust|ui-source|tray)\.cjs|connect\.(?:js|css|html)|tray\.png)$/.test(filename)
    || /^scripts\/(?:network|setup-cert)\.js$/.test(filename)) return true;
  if (variant !== 'full') return false;
  if(filename==='modules/assistant/desktop/windows-automation.ps1')return true;
  if (/^modules\/assistant\/public\/vision\//.test(filename)
    || /^modules\/assistant\/docs\/licenses\/(?:node|pinyin-pro)\/(?:LICENSE(?:\.txt)?|provenance\.json)$/.test(filename)) return true;
  return /^modules\/(?:assistant|freecamera|rustdesk)\/(?:module\.json|package\.json|README\.md)$/.test(filename)
    || /^modules\/(?:assistant|freecamera|rustdesk)\/(?:server|desktop|public|assistant)\/[^\s]+\.(?:[cm]?js|html|css|svg|png|jpg|py)$/.test(filename)
    || /^modules\/(?:assistant|freecamera|rustdesk)\/deploy\//.test(filename)
    || /^modules\/assistant\/(?:scripts\/(?:setup-(?:assistant-voice|local-tts)\.py|import-chattts-speakers\.py|download-local-tts\.js)|assistant\/(?:(?:local-tts-manifest|qwen-tts-capabilities)\.json|chattts-speakers\.(?:json|f32))|server\/volcengine-voices\.json|docs\/(?:THIRD-PARTY-VOICE|LOCAL-TTS-LICENSES)\.md|docs\/licenses\/[^/]+\.txt)$/.test(filename)
    || /^modules\/freecamera\/models\/(?:metadata\.json|README\.md|LICENSE(?:\.txt)?)$/.test(filename);
}
export async function verifyFirstPartyRuntime(appDir, { sourceCommit, variant, sourceFiles, readSource } = {}) {
  sourceFiles ||= git(['ls-tree', '-r', '--name-only', sourceCommit]).split('\n').filter(Boolean);
  readSource ||= filename => gitBlob(sourceCommit, filename);
  const expected = sourceFiles.filter(filename => packagedSource(filename, variant)).sort();
  const actual = (await fileList(appDir)).filter(filename => !filename.split('/').includes('node_modules') && !['package.json', 'build-info.json', 'modules/freecamera/models/yolox_tiny.onnx'].includes(filename));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Packaged first-party file set differs from source commit: ${variant}`);
  for (const filename of actual) {
    const committed = await readSource(filename), packed = await readFile(path.join(appDir, filename));
    if (!packed.equals(Buffer.from(committed))) throw Error(`Packaged runtime differs from source commit: ${filename}`);
  }
  const committedPackage = JSON.parse(String(await readSource('package.json')));
  const packedPackage = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  if (!isDeepStrictEqual(packedPackage, runtimePackage(committedPackage))) throw Error(`Packaged platform manifest differs from source commit: ${variant}`);
}
export async function verifyPortablePayload(executable, unpacked, variant) {
  if (process.platform !== 'win32') throw Error('Portable payload verification requires Windows and the bundled 7-Zip');
  const tool = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor/7z-x64.exe');
  const directory = path.join(root, 'test-results/atb/provenance', variant);
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
  const payload = path.join(directory, 'app-64.7z'), extracted = path.join(directory, 'payload');
  const fd = openSync(payload, 'w');
  let wrapper;
  try { wrapper = spawnSync(tool, ['e', '-so', executable, '$PLUGINSDIR/app-64.7z'], { windowsHide: true, stdio: ['ignore', fd, 'pipe'] }); }
  finally { closeSync(fd); }
  if (wrapper.status !== 0 || (await stat(payload)).size === 0) throw Error(`Portable embedded payload unavailable: ${variant}`);
  const extraction = spawnSync(tool, ['x', '-y', `-o${extracted}`, payload], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (extraction.status !== 0) throw Error(`Portable payload extraction failed: ${variant}`);
  const expected = await fileList(unpacked), actual = await fileList(extracted);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error(`Portable payload file set differs from tested unpacked application: ${variant}`);
  for (const filename of expected) if (await sha256(path.join(unpacked, filename)) !== await sha256(path.join(extracted, filename))) throw Error(`Portable payload differs from tested unpacked application: ${variant}/${filename}`);
  await rm(directory, { recursive: true, force: true });
}
export function verifySourceCommit(sourceCommit, version) {
  const current = sourceMetadata();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit || '') || sourceCommit !== current.sourceCommit) throw Error('Release source commit must be the clean current HEAD');
  git(['cat-file', '-e', `${sourceCommit}^{commit}`]);
  const older = tag => { const a = tag.replace(/^v/, '').split('.').map(Number), b = version.split('.').map(Number); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  const tags = git(['tag', '--sort=-version:refname']).split('\n').filter(tag => /^v?\d+\.\d+\.\d+$/.test(tag) && older(tag));
  const previousTag = tags[0] || null;
  if (previousTag) {
    const previous = git(['rev-parse', `${previousTag}^{commit}`]);
    if (sourceCommit === previous) throw Error('A new source commit is required since the previous release tag');
    git(['merge-base', '--is-ancestor', previous, sourceCommit]);
    const files = git(['diff', '--name-only', previous, sourceCommit]).split('\n').filter(Boolean);
    if (!files.some(filename => /^(?:server|public|desktop|scripts|modules)\/.*\.(?:[cm]?js|py|html|css|sh)$/.test(filename))) throw Error('A release requires a tracked source change beyond release metadata');
  }
  return previousTag;
}
export async function verifyArchive(filename, sourceCommit, version) {
  const Zip = require('adm-zip'), archive = new Zip(filename);
  const tracked = git(['ls-tree', '-r', '--name-only', sourceCommit]).split('\n').filter(Boolean).sort();
  const entries = archive.getEntries().filter(entry => !entry.isDirectory);
  const files = new Map();
  for (const entry of entries) {
    const name = entry.entryName.startsWith(`ATB-${version}/`) ? entry.entryName.slice(`ATB-${version}/`.length) : entry.entryName;
    assertPublicSourcePath(name);
    if (files.has(name)) throw Error(`Duplicate archive entry: ${name}`);
    files.set(name, entry);
  }
  if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(tracked)) throw Error('Source archive must contain exactly the committed public files');
  for (const name of tracked) {
    assertPublicSourcePath(name);
    const buffer = files.get(name).getData();
    assertPublicText(buffer.toString('utf8'), name);
    const result = spawnSync('git', ['show', `${sourceCommit}:${name}`], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0 || !createHash('sha256').update(buffer).digest().equals(createHash('sha256').update(result.stdout).digest())) throw Error(`Archive differs from source commit: ${name}`);
  }
}
export async function createManifest(output) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  output ||= releaseDirectory(pkg.version);
  const artifacts = [];
  for (const variant of ['full', 'core']) {
    const build = JSON.parse(await readFile(path.join(output, `${variant}-build.json`), 'utf8'));
    artifacts.push({ variant, file: build.file, sha256: await sha256(path.join(output, build.file)), size: (await stat(path.join(output, build.file))).size, version: build.version, sourceCommit: build.sourceCommit });
  }
  const sourceName = `ATB-${pkg.version}-source.zip`;
  const manifest = { product: 'ATB', version: pkg.version, sourceCommit: artifacts[0].sourceCommit,
    sourceArchive: { file: sourceName, sha256: await sha256(path.join(output, sourceName)), size: (await stat(path.join(output, sourceName))).size }, artifacts };
  await writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(output, 'SHA256SUMS'), await checksumText(output, manifest));
  return manifest;
}
async function checksumText(output, manifest) {
  const files = [manifest.sourceArchive.file, ...manifest.artifacts.map(item => item.file), 'release-manifest.json'];
  return (await Promise.all(files.map(async file => `${await sha256(path.join(output, file))}  ${file}`))).join('\n') + '\n';
}
export async function verifyChecksums(output, manifest) {
  const actual = await readFile(path.join(output, 'SHA256SUMS'), 'utf8');
  if (actual !== await checksumText(output, manifest)) throw Error('SHA256SUMS must match the source archive, both executables and release-manifest.json');
}
export async function checkRelease(output) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  output ||= releaseDirectory(pkg.version);
  const manifest = JSON.parse(await readFile(path.join(output, 'release-manifest.json'), 'utf8'));
  if (manifest.product !== 'ATB' || manifest.version !== pkg.version) throw Error('Release version mismatch');
  const previousTag = verifySourceCommit(manifest.sourceCommit, manifest.version);
  if (manifest.sourceArchive?.file !== `ATB-${manifest.version}-source.zip`) throw Error('Source archive name mismatch');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) throw Error('Both full and core artifacts are required');
  for (const variant of ['full', 'core']) {
    const artifact = manifest.artifacts.find(item => item.variant === variant);
    if (!artifact || artifact.file !== `ATB-${manifest.version}-Windows-x64-${variant}.exe` || artifact.version !== manifest.version || artifact.sourceCommit !== manifest.sourceCommit) throw Error(`Artifact metadata mismatch: ${variant}`);
    const build = JSON.parse(await readFile(path.join(output, `${variant}-build.json`), 'utf8'));
    if (build.development !== false || build.sourceCommit !== manifest.sourceCommit || build.variant !== variant || build.version !== manifest.version || build.sha256 !== artifact.sha256) throw Error(`Development or mismatched build: ${variant}`);
    const appDir = path.join(output, variant, 'win-unpacked/resources/app');
    const packed = JSON.parse(await readFile(path.join(appDir, 'build-info.json'), 'utf8'));
    if (packed.development !== false || packed.sourceCommit !== manifest.sourceCommit || packed.version !== manifest.version || packed.variant !== variant) throw Error(`Packaged provenance mismatch: ${variant}`);
    for (const filename of await fileList(appDir)) assertRuntimePath(filename, variant);
    await verifyFirstPartyRuntime(appDir, { sourceCommit: manifest.sourceCommit, variant });
    const expected = variant === 'full' ? ['assistant', 'freecamera', 'rustdesk'] : [];
    if (JSON.stringify(packed.modules) !== JSON.stringify(expected) || JSON.stringify(Object.keys(packed.dependencies.platform)) !== JSON.stringify(['node-forge'])) throw Error(`Packaged module/dependency metadata mismatch: ${variant}`);
    if (variant === 'full') {
      for (const id of expected) {
        const module = JSON.parse(await readFile(path.join(appDir, 'modules', id, 'module.json'), 'utf8'));
        if (module.id !== id || module.version !== manifest.version) throw Error(`Packaged module version mismatch: ${id}`);
      }
      const model = path.join(appDir, 'modules/freecamera/models');
      const metadata = JSON.parse(await readFile(path.join(model, 'metadata.json'), 'utf8'));
      if (await sha256(path.join(model, 'yolox_tiny.onnx')) !== metadata.sha256) throw Error('Packaged camera model checksum mismatch');
    }
  }
  for (const artifact of [manifest.sourceArchive, ...manifest.artifacts]) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || await sha256(path.join(output, artifact.file)) !== artifact.sha256 || (await stat(path.join(output, artifact.file))).size !== artifact.size) throw Error(`Artifact integrity mismatch: ${artifact.file}`);
  }
  for (const artifact of manifest.artifacts) await verifyPortablePayload(path.join(output, artifact.file), path.join(output, artifact.variant, 'win-unpacked'), artifact.variant);
  await verifyArchive(path.join(output, manifest.sourceArchive.file), manifest.sourceCommit, manifest.version);
  await verifyChecksums(output, manifest);
  console.log(`Release validation passed: ATB ${manifest.version}; full, core, committed source archive and SHA-256 verified${previousTag ? ` since ${previousTag}` : ' (initial release)'}`);
  return manifest;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex < 0 ? undefined : path.resolve(process.argv[outputIndex + 1]);
  if (process.argv[2] === 'manifest') await createManifest(output);
  else if (process.argv[2] === 'check') await checkRelease(output);
  else throw Error('Usage: node scripts/release-atb.js manifest|check [--output directory]');
}
