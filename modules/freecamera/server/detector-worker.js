import { fileURLToPath } from 'node:url';
import path from 'node:path';

function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

// Official YOLOX ONNX export has raw [1, anchors, 85] output: offsets, objectness, 80 COCO class scores.
export function decodeYolox(data, { inputSize = 416, imageWidth, imageHeight, ratio, scoreThreshold = 0.4, nmsThreshold = 0.45 } = {}) {
  const anchorCount = [8, 16, 32].reduce((sum, stride) => sum + Math.floor(inputSize / stride) ** 2, 0);
  if (!data?.length || data.length % 85 || data.length / 85 > anchorCount) throw new Error('Unexpected YOLOX output shape');
  if (!(imageWidth > 0 && imageHeight > 0 && ratio > 0)) throw new Error('Invalid YOLOX image dimensions');
  const candidates = [];
  let anchor = 0;
  for (const stride of [8, 16, 32]) {
    const grid = Math.floor(inputSize / stride);
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++, anchor++) {
      const offset = anchor * 85;
      if (offset >= data.length) break;
      const score = data[offset + 4] * data[offset + 5]; // COCO class 0: person.
      if (!Number.isFinite(score) || score < scoreThreshold || score > 1) continue;
      const centerX = (data[offset] + x) * stride;
      const centerY = (data[offset + 1] + y) * stride;
      const boxWidth = Math.exp(data[offset + 2]) * stride;
      const boxHeight = Math.exp(data[offset + 3]) * stride;
      if (![centerX, centerY, boxWidth, boxHeight].every(Number.isFinite)) continue;
      const left = Math.max(0, (centerX - boxWidth / 2) / ratio / imageWidth);
      const top = Math.max(0, (centerY - boxHeight / 2) / ratio / imageHeight);
      const right = Math.min(1, (centerX + boxWidth / 2) / ratio / imageWidth);
      const bottom = Math.min(1, (centerY + boxHeight / 2) / ratio / imageHeight);
      if (right <= left || bottom <= top) continue;
      candidates.push({ x: left, y: top, width: right - left, height: bottom - top, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const boxes = [];
  for (const candidate of candidates) {
    if (boxes.every(box => overlap(box, candidate) <= nmsThreshold)) boxes.push(candidate);
    if (boxes.length >= 100) break;
  }
  return boxes;
}

async function startWorker() {
  let session, ort, sharp, inputSize = 416, scoreThreshold = 0.4;
  let loading = false, busy = false, stopping = false;
  const send = message => { if (process.connected) process.send(message); };
  const stop = () => { stopping = true; process.exit(0); };
  process.on('disconnect', stop);
  process.on('message', async message => {
    if (message?.type === 'shutdown') return stop();
    if (stopping) return;
    try {
      if (message?.type === 'init' && !session && !loading) {
        loading = true;
        const [runtime, images] = await Promise.all([import('onnxruntime-node'), import('sharp')]);
        ort = runtime.default ?? runtime;
        sharp = images.default;
        sharp.cache(false);
        sharp.concurrency(1);
        scoreThreshold = message.scoreThreshold;
        session = await ort.InferenceSession.create(message.modelPath, {
          executionProviders: ['cpu'],
          executionMode: 'sequential',
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
          graphOptimizationLevel: 'all',
        });
        const dimensions = session.inputMetadata?.[0]?.shape;
        if (Number.isInteger(dimensions?.[2])) inputSize = dimensions[2];
        send({ type: 'ready' });
      } else if (message?.type === 'detect' && session && !busy) {
        busy = true;
        const base64 = message.jpegBase64;
        if (typeof base64 !== 'string' || base64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid detector image');
        const jpeg = Buffer.from(base64, 'base64');
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error('Detector requires a JPEG image');
        const image = sharp(jpeg, { limitInputPixels: 4096 * 4096, failOn: 'error' });
        const metadata = await image.metadata();
        const { width: imageWidth, height: imageHeight } = metadata;
        const ratio = Math.min(inputSize / imageWidth, inputSize / imageHeight);
        const width = Math.max(1, Math.floor(imageWidth * ratio));
        const height = Math.max(1, Math.floor(imageHeight * ratio));
        const pixels = await image.resize(width, height, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
        const area = inputSize * inputSize;
        const input = new Float32Array(3 * area).fill(114);
        // Match YOLOX's OpenCV BGR, unnormalized CHW, top-left letterbox preprocessing.
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const source = (y * width + x) * 3;
          const target = y * inputSize + x;
          input[target] = pixels[source + 2];
          input[area + target] = pixels[source + 1];
          input[2 * area + target] = pixels[source];
        }
        const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, inputSize, inputSize]) });
        const boxes = decodeYolox(output[session.outputNames[0]].data, { inputSize, imageWidth, imageHeight, ratio, scoreThreshold });
        send({ type: 'result', id: message.id, boxes });
        busy = false;
      }
    } catch (error) {
      // Messages contain diagnostic text only; frames and paths are never logged.
      send({ type: 'error', error: error.code === 'ENOENT' ? 'Person model missing. Run npm run setup:model.' : String(error.message).slice(0, 300) });
    }
  });
}

if (process.send && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startWorker();
