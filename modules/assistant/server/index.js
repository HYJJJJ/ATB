import { createAssistantRoutes } from './assistant-routes.js';
import { readFile } from 'node:fs/promises';
import { sessionToken } from '../../../server/accounts.js';
import { createCompanionFeed, createCompanionFeedRoutes } from './companion-feed.js';

const visionFiles = new Set(['face-api.min.js', 'tiny_face_detector_model-weights_manifest.json', 'tiny_face_detector_model-shard1', 'face_landmark_68_model-weights_manifest.json', 'face_landmark_68_model-shard1', 'face_recognition_model-weights_manifest.json', 'face_recognition_model-shard1', 'face_recognition_model-shard2']);

export async function createModule(context) {
  context = { ...context, companionFeed: context.companionFeed || createCompanionFeed({ request: context.companionRequest }) };
  const handle = await createAssistantRoutes(context);
  const companion = createCompanionFeedRoutes(context);
  return { async handle(req, res, pathname, config) {
    if (await companion(req, res, pathname)) return true;
    if (pathname.startsWith('/modules/assistant/vision/')) {
      const filename = pathname.slice('/modules/assistant/vision/'.length);
      if (!context.accounts.session(sessionToken(req))) { res.writeHead(401); res.end(); return true; }
      if (req.method !== 'GET' || !visionFiles.has(filename)) { res.writeHead(404); res.end(); return true; }
      try {
        const bytes = await readFile(new URL('../public/vision/' + filename, import.meta.url));
        res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' }); res.end(bytes);
      } catch { res.writeHead(503); res.end('Local face model unavailable'); }
      return true;
    }
    return handle(req, res, pathname, config);
  }, close: () => handle.close() };
}
export default createModule;
