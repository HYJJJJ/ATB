import { readFile, mkdir, stat, rename, writeFile, open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
const manifest = JSON.parse(await readFile(new URL('../assistant/local-tts-manifest.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const root = path.resolve(args.includes('--data-dir') ? value('--data-dir') : 'data/assistant');
const requested = args.includes('--provider') ? value('--provider') : 'all';
if (!['all',...Object.keys(manifest.models)].includes(requested)) throw Error('Invalid local provider');
const digest = async filename => { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); };
const valid = async (filename, item) => { try { return (await stat(filename)).size === item.size && await digest(filename) === item.sha256; } catch { return false; } };
for (const [provider, model] of Object.entries(manifest.models)) {
  if (requested !== 'all' && provider !== requested) continue;
  const directory = path.join(root, 'models', model.directory);
  for (const item of model.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(item.path) || item.path.split('/').some(p => p === '..' || !p) || item.path.startsWith('/')) throw Error('Invalid manifest path');
    const target = path.join(directory, item.path), partial = target + '.partial';
    if (await valid(target, item)) continue;
    if (args.includes('--verify-only')) throw Error(`Missing or corrupt ${provider}/${item.path}`);
    await mkdir(path.dirname(target), {recursive:true});
    let complete = false;
    for (let attempt = 0; attempt < 4 && !complete; attempt++) {
      try {
        let offset = await stat(partial).then(s => s.size).catch(() => 0);
        if (offset >= item.size) { if (await valid(partial,item)) { await rename(partial,target); complete = true; break; } offset = 0; }
        console.log(`Downloading ${provider}/${item.path} (${Math.round(offset/1048576)}/${Math.round(item.size/1048576)} MiB)`);
        const url = new URL(item.url);
        if (!['huggingface.co','hf-mirror.com','raw.githubusercontent.com'].includes(url.hostname)) throw Error('Invalid asset host');
        if (url.hostname === 'huggingface.co' && args.includes('--mirror')) url.hostname = 'hf-mirror.com';
        if (provider === 'qwen3tts' && item.path.endsWith('.safetensors') && args.includes('--modelscope')) { url.hostname = 'modelscope.cn'; url.pathname = '/models/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice/resolve/master/' + item.path; }
        if (item.size > 32 * 1048576) {
          const output = await open(partial, offset ? 'a' : 'w');
          try {
            while (offset < item.size) {
              const starts = Array.from({length:4}, (_, i) => offset + i * 8 * 1048576).filter(at => at < item.size);
              const blocks = await Promise.all(starts.map(async start => {
                const end = Math.min(item.size - 1, start + 8 * 1048576 - 1);
                const response = await fetch(url, {headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(90000)});
                if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${item.size}`) { await response.body?.cancel(); throw Error('Invalid asset range'); }
                const chunks = []; let bytes = 0;
                for await (const chunk of Readable.fromWeb(response.body)) { bytes += chunk.length; if (bytes > end - start + 1) throw Error('Oversized asset chunk'); chunks.push(chunk); }
                if (bytes !== end - start + 1) throw Error('Truncated asset chunk');
                return Buffer.concat(chunks);
              }));
              for (const block of blocks) { await output.writeFile(block); offset += block.length; }
              console.log(`Progress ${provider}/${item.path}: ${Math.round(offset / 1048576)}/${Math.round(item.size / 1048576)} MiB`);
            }
          } finally { await output.close(); }
          if (!await valid(partial,item)) throw Error('Asset checksum mismatch');
          await rename(partial,target); complete = true; continue;
        }
        const response = await fetch(url, {headers:offset ? {Range:`bytes=${offset}-`} : {},signal:AbortSignal.timeout(90000)});
        if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(`Asset HTTP ${response.status}`); }
        if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw Error('Invalid asset range');
        if (response.status !== 206) offset = 0;
        let size = offset;
        const bounded = async function* () { for await (const chunk of Readable.fromWeb(response.body)) { size += chunk.length; if (size > item.size) throw Error('Asset exceeded declared size'); yield chunk; } };
        await pipeline(bounded(),createWriteStream(partial,{flags:offset?'a':'w'}));
        if (!await valid(partial,item)) throw Error('Asset checksum mismatch');
        await rename(partial,target); complete = true;
      } catch (error) { console.log(`Retry ${attempt+1}: ${error.message.replace(/https?:\/\/\S+/g,'[asset]')}`); }
    }
    if (!complete) throw Error(`Unable to install ${provider}/${item.path}`);
  }
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'installed.json'),JSON.stringify({model:model.name,files:model.files.length,revision:model.revision}));
  console.log(`LOCAL_MODEL_VERIFIED ${provider}`);
}
