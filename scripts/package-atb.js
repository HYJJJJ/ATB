import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const releaseDirectory = version => path.join(root, `release-atb-${version.replaceAll('.', '')}`);
export function runtimePackage(pkg) {
  return JSON.parse(JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', main: pkg.main, description: pkg.description, author: pkg.author, engines: pkg.engines, dependencies: pkg.dependencies }));
}
const require = createRequire(import.meta.url);
const platformDesktop = ['main.cjs', 'preload.cjs', 'module-host.cjs', 'service.cjs', 'trust.cjs', 'ui-source.cjs', 'tray.cjs', 'tray.png', 'connect.html', 'connect.js', 'connect.css'];
const runtimeExtension = /\.(?:[cm]?js|html|css|svg|png|jpg|py)$/i;
const forbiddenPart = /^(?:data|certs|private|desktop-profile|voice-runtime|tts-runtime|qwen-tts-runtime|\.venv|venv|__pycache__|test-results|exports|\.git)$/i;

export async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function fileList(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`Symbolic link is not allowed in staging: ${relative}`);
    if (entry.isDirectory()) result.push(...await fileList(path.join(directory, entry.name), relative + '/'));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}
export function assertRuntimePath(relative, variant) {
  const parts = relative.replaceAll('\\', '/').split('/');
  const firstParty=parts.includes('node_modules')?parts.slice(0,parts.indexOf('node_modules')):parts;
  if (firstParty.some(part => forbiddenPart.test(part)) || /\.(?:log|pem|key|crt|cer|pfx|p12|dpapi|sqlite|db)$/i.test(relative) || /(?:^|\/)\.env(?:\.|$)/i.test(relative)) throw Error(`Private runtime file rejected: ${relative}`);
  if (variant === 'core' && (parts.includes('modules') || parts.includes('models') || /onnx|sharp|qrcode|turn-server|(?:^|\/)ws\//i.test(relative))) throw Error(`Module file in core: ${relative}`);
  if (variant === 'core' && parts[0] === 'node_modules' && parts[1] !== 'node-forge') throw Error(`Non-platform dependency in core: ${relative}`);
}
async function copyRuntimeTree(source, destination) {
  await cp(source, destination, { recursive: true, filter: async filename => {
    const relative = path.relative(source, filename);
    if (!relative) return true;
    if (relative.split(path.sep).some(part => forbiddenPart.test(part) || ['node_modules', 'test', 'tests'].includes(part))) return false;
    return (await stat(filename)).isDirectory() || runtimeExtension.test(filename) || filename.replaceAll('\\','/').endsWith('/modules/assistant/desktop/windows-automation.ps1');
  } });
}
async function copyOptional(source, target, options = {}) {
  try { await access(source); await cp(source, target, options); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function copyDependencies(dependencies, destination, sourceRoot = root) {
  const installed = new Map();
  let dependencyRoot = sourceRoot;
  for (;;) {
    try { await access(path.join(dependencyRoot, 'node_modules')); break; } catch {}
    if (dependencyRoot === path.dirname(dependencyRoot)) throw Error('Dependency installation missing');
    dependencyRoot = path.dirname(dependencyRoot);
  }
  async function install(name, from, optional = false) {
    let source;
    for (let directory = from;; directory = path.dirname(directory)) {
      const candidate = path.join(directory, 'node_modules', name);
      try { await access(path.join(candidate, 'package.json')); source = candidate; break; } catch {}
      if (directory === path.dirname(directory)) break;
    }
    if (!source) { if (optional) return; throw Error(`Required dependency missing: ${name}`); }
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    if (manifest.os && !manifest.os.includes('win32') && !manifest.os.includes('!linux') || manifest.cpu && !manifest.cpu.includes('x64')) return;
    const relativePackage = path.relative(path.join(dependencyRoot, 'node_modules'), source);
    if (relativePackage.startsWith('..') || path.isAbsolute(relativePackage)) throw Error(`Dependency resolves outside installation: ${name}`);
    if (installed.has(source)) return;
    installed.set(source, { name: relativePackage.replaceAll('\\', '/'), version: manifest.version });
    const target = path.join(destination, 'node_modules', relativePackage);
    await cp(source, target, { recursive: true, filter: filename => {
      const relative = path.relative(source, filename).replaceAll('\\', '/');
      if (!relative) return true;
      if (relative.split('/').some(part => ['node_modules', 'test', 'tests', 'example', 'examples', '.git'].includes(part))) return false;
      if (name === 'onnxruntime-node' && /(?:^|\/)(?:linux|darwin|arm64|ia32)(?:\/|$)/.test(relative)) return false;
      return !/\.(?:log|pem|key|pfx|p12)$/i.test(relative);
    } });
    for (const dependency of Object.keys(manifest.dependencies || {})) await install(dependency, source);
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) await install(dependency, source, true);
    for (const dependency of Object.keys(manifest.peerDependencies || {})) await install(dependency, source, manifest.peerDependenciesMeta?.[dependency]?.optional===true);
  }
  for (const dependency of Object.keys(dependencies)) await install(dependency, sourceRoot);
  return Object.fromEntries([...installed.values()].map(({ name, version }) => [name, version]));
}
function git(args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); }
export function sourceMetadata({ allowUncommitted = false, sourceCommit } = {}) {
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) { if (allowUncommitted) return { sourceCommit: null, development: true }; throw Error('A sanitized source commit is required; use --allow-uncommitted for a development build'); }
  const commit = head.stdout.trim();
  if (sourceCommit && commit !== sourceCommit) throw Error('--source-commit must match HEAD');
  const changed = git(['status', '--porcelain', '--untracked-files=normal']);
  if (changed.status !== 0) throw Error('Unable to verify source status');
  if (changed.stdout.trim() && !allowUncommitted) throw Error('Commit all public source changes before release packaging');
  return { sourceCommit: commit, development: Boolean(allowUncommitted || changed.stdout.trim()) };
}
export async function stageVariant(variant, { stageRoot = path.join(root, 'test-results/atb/staging'), metadata = { sourceCommit: null, development: true }, sourceRoot = root } = {}) {
  if (!['full', 'core'].includes(variant)) throw Error(`Unknown variant: ${variant}`);
  const stage = path.resolve(stageRoot, variant);
  if (stage === path.resolve(sourceRoot) || !stage.startsWith(path.resolve(stageRoot) + path.sep)) throw Error('Unsafe staging path');
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const directory of ['server', 'public']) await copyRuntimeTree(path.join(sourceRoot, directory), path.join(stage, directory));
  for (const filename of platformDesktop) { await mkdir(path.join(stage, 'desktop'), { recursive: true }); await copyFile(path.join(sourceRoot, 'desktop', filename), path.join(stage, 'desktop', filename)); }
  await mkdir(path.join(stage, 'scripts'));
  for (const filename of ['network.js', 'setup-cert.js']) await copyFile(path.join(sourceRoot, 'scripts', filename), path.join(stage, 'scripts', filename));
  const stagedPackage = runtimePackage(pkg);
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(stagedPackage, null, 2) + '\n');
  await copyOptional(path.join(sourceRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
  await copyOptional(path.join(sourceRoot, 'docs/THIRD-PARTY.md'), path.join(stage, 'docs/THIRD-PARTY.md'));
  const dependencies = { platform: await copyDependencies(pkg.dependencies, stage, sourceRoot) };
  const moduleIds = [];
  if (variant === 'full') {
    for (const id of ['assistant', 'freecamera', 'rustdesk']) {
      const source = path.join(sourceRoot, 'modules', id), target = path.join(stage, 'modules', id);
      const manifest = JSON.parse(await readFile(path.join(source, 'module.json'), 'utf8'));
      if (manifest.id !== id || manifest.version !== pkg.version) throw Error(`Module metadata mismatch: ${id}`);
      await mkdir(target, { recursive: true });
      await copyFile(path.join(source, 'module.json'), path.join(target, 'module.json'));
      await copyOptional(path.join(source, 'README.md'), path.join(target, 'README.md'));
      await copyOptional(path.join(source, 'deploy'), path.join(target, 'deploy'), { recursive: true });
      for (const directory of ['server', 'public', 'desktop', 'assistant']) {
        try { await access(path.join(source, directory)); await copyRuntimeTree(path.join(source, directory), path.join(target, directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      try {
        const modulePackage = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
        await writeFile(path.join(target, 'package.json'), JSON.stringify(modulePackage, null, 2) + '\n');
        dependencies[id] = await copyDependencies(modulePackage.dependencies || {}, target, source);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (id === 'assistant') {
        await copyOptional(path.join(source, 'public/vision'), path.join(target, 'public/vision'), { recursive: true });
        await mkdir(path.join(target, 'scripts'));
        for (const filename of ['scripts/setup-assistant-voice.py', 'scripts/setup-local-tts.py', 'scripts/download-local-tts.js', 'scripts/import-chattts-speakers.py', 'assistant/chattts-speakers.json', 'assistant/chattts-speakers.f32', 'assistant/local-tts-manifest.json', 'assistant/qwen-tts-capabilities.json', 'server/volcengine-voices.json']) {
          await copyFile(path.join(source, filename), path.join(target, filename));
        }
        await cp(path.join(source, 'docs/licenses'), path.join(target, 'docs/licenses'), { recursive: true });
        await copyOptional(path.join(source, 'docs/THIRD-PARTY-VOICE.md'), path.join(target, 'docs/THIRD-PARTY-VOICE.md'));
        await copyFile(path.join(source, 'docs/LOCAL-TTS-LICENSES.md'), path.join(target, 'docs/LOCAL-TTS-LICENSES.md'));
      }
      if (id === 'freecamera') {
        await mkdir(path.join(target, 'models'));
        for (const filename of ['yolox_tiny.onnx', 'metadata.json', 'README.md']) await copyFile(path.join(source, 'models', filename), path.join(target, 'models', filename));
        await copyOptional(path.join(source, 'models/LICENSE'), path.join(target, 'models/LICENSE'));
        await copyOptional(path.join(source, 'models/LICENSE.txt'), path.join(target, 'models/LICENSE.txt'));
      }
      moduleIds.push(id);
    }
  }
  const build = { product: 'ATB', version: pkg.version, variant, arch: 'x64', platform: 'win32', ...metadata, modules: moduleIds, dependencies };
  if (metadata.development === false && metadata.sourceCommit) {
    // Windows working files may use CRLF even when the clean committed source is
    // normalized to LF. Release runtime files come from the commit's exact bytes.
    for (const filename of await fileList(stage)) {
      if (filename.split('/').includes('node_modules') || filename === 'package.json' || filename === 'modules/freecamera/models/yolox_tiny.onnx') continue;
      const blob = spawnSync('git', ['show', `${metadata.sourceCommit}:${filename}`], { cwd: sourceRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      if (blob.status !== 0) throw Error(`Release runtime file is not committed: ${filename}`);
      await writeFile(path.join(stage, filename), blob.stdout);
    }
  }
  await writeFile(path.join(stage, 'build-info.json'), JSON.stringify(build, null, 2) + '\n');
  for (const filename of await fileList(stage)) assertRuntimePath(filename, variant);
  return { stage, build };
}
export async function packageVariants(options = {}) {
  const variants = (options.variant || 'all') === 'all' ? ['full', 'core'] : [options.variant];
  const metadata = { ...sourceMetadata(options), builtAt: new Date().toISOString() };
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const output = path.resolve(options.output || releaseDirectory(pkg.version));
  await mkdir(output, { recursive: true });
  for (const variant of variants) {
    const { stage, build } = await stageVariant(variant, { metadata });
    console.log(`Staged ATB ${build.version} ${variant}; ${build.modules.length} modules`);
    if (options.stageOnly) continue;
    const { build: electronBuild, Platform, Arch } = require('electron-builder');
    // electron-builder normalizes/mutates config arrays during a build.
    const configuration = structuredClone(require('../desktop/electron-builder.cjs'));
    process.env.ATB_BUILD_VARIANT = variant;
    await electronBuild({ targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), publish: 'never', config: {
      ...configuration, directories: { app: stage, output: path.join(output, variant) },
      electronDist: path.join(root, 'node_modules/electron/dist'), electronVersion: require('electron/package.json').version,
      portable: { artifactName: `ATB-${build.version}-Windows-x64-${variant}.exe` },
    } });
    const filename = `ATB-${build.version}-Windows-x64-${variant}.exe`;
    await copyFile(path.join(output, variant, filename), path.join(output, filename));
    await writeFile(path.join(output, `${variant}-build.json`), JSON.stringify({ ...build, file: filename, sha256: await sha256(path.join(output, filename)), size: (await stat(path.join(output, filename))).size }, null, 2) + '\n');
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  await packageVariants({ variant: args.find(arg => ['all', 'full', 'core'].includes(arg)) || 'all', allowUncommitted: args.includes('--allow-uncommitted'), sourceCommit: value('--source-commit'), output: value('--output'), stageOnly: args.includes('--stage-only') });
}
