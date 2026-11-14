let loading;
let modelUse = Promise.resolve();
export function withFaceModel(task, signal) {
  const next = modelUse.then(async () => {
    signal?.throwIfAborted();
    try { return await task(); } finally { releaseFaceModel(); }
  });
  modelUse = next.catch(() => {}); return next;
}
export async function loadFaceModel() {
  loading ||= (async () => {
    if (!globalThis.faceapi) await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/modules/assistant/vision/face-api.min.js'; script.onload = resolve; script.onerror = () => reject(Error('本地人脸模型未安装')); document.head.append(script);
    });
    await faceapi.tf.setBackend('cpu');
    await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri('/modules/assistant/vision'), faceapi.nets.faceLandmark68Net.loadFromUri('/modules/assistant/vision'), faceapi.nets.faceRecognitionNet.loadFromUri('/modules/assistant/vision')]);
  })().catch(error => { loading = null; throw error; });
  return loading;
}
export async function describeFaces(image) {
  await loadFaceModel();
  const results = await faceapi.detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: .5 })).withFaceLandmarks().withFaceDescriptors();
  return results.map(item => item.detection.box.width >= 80 && item.detection.box.height >= 80 ? [...item.descriptor] : null);
}
export function releaseFaceModel() {
  if (!globalThis.faceapi) return;
  for (const net of [faceapi.nets.tinyFaceDetector, faceapi.nets.faceLandmark68Net, faceapi.nets.faceRecognitionNet]) net.dispose();
  loading = null;
}
