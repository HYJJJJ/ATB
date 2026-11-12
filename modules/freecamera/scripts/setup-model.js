import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = fileURLToPath(new URL('../models/', import.meta.url));

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destination, { sha256, bytes } = {}) {
  try {
    const existing = await stat(destination);
    if (existing.size > 0 && (!bytes || existing.size === bytes) && (!sha256 || await digest(destination) === sha256)) {
      console.log(`Already verified: ${path.basename(destination)}`);
      return;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${destination}.${process.pid}.part`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    let received = 0;
    const hash = createHash('sha256');
    const verify = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; hash.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary, { flags: 'wx' }));
    const actualHash = hash.digest('hex');
    if (bytes && received !== bytes) throw new Error(`Unexpected model size: ${received}`);
    if (sha256 && actualHash !== sha256) throw new Error('Model checksum verification failed');
    await rename(temporary, destination);
    console.log(`Downloaded and verified: ${path.basename(destination)} (${received} bytes, SHA256 ${actualHash})`);
  } finally { await rm(temporary, { force: true }); }
}

async function main() {
  const metadata = JSON.parse(await readFile(path.join(folder, 'metadata.json'), 'utf8'));
  await mkdir(folder, { recursive: true });
  await download(metadata.url, path.join(folder, metadata.filename), metadata);
  if (process.argv.includes('--validation-image')) {
    await download(metadata.validationImage.url, path.join(folder, metadata.validationImage.filename), metadata.validationImage);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
