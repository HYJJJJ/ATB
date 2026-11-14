import { openVolcengineTts } from './volcengine-stream.js';
export { volcengineVoices, volcenginePatch, visibleVolcengine, volcengineSetupError } from './volcengine-settings.js';

// Compatibility for consumers requesting a completed MP3. Live playback uses PCM chunks.
export async function synthesizeVolcengine(options) {
  const chunks = []; let bytes = 0;
  const session = await openVolcengineTts({ ...options, format: 'mp3', onAudio: chunk => {
    bytes += chunk.length; if (bytes > 6 * 1024 * 1024) throw Error('合成音频过大，请缩短朗读文字'); chunks.push(chunk);
  } });
  try { await session.write(options.text); await session.finish(); await session.done; return { audio: Buffer.concat(chunks, bytes).toString('base64'), mime: 'audio/mpeg' }; }
  finally { session.cancel(); }
}
