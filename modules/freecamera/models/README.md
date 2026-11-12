# Local person detection model

Run `npm run setup:model` (or `node modules/freecamera/scripts/setup-model.js`) to download the official Megvii YOLOX tiny ONNX model. The download is pinned by size and SHA-256 in `metadata.json`; incomplete or modified files are replaced only after a complete verified download. The model is approximately 20 MB and uses the upstream Apache-2.0 license: https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE.

Detection is off by default. Enabling it forks a separate Node process, loads the ONNX model on CPU with two inference threads, and returns person bounding boxes only. No GPU execution provider is used. Disabling waits for that process to exit, which releases the model and native runtime. A timeout forcibly kills a worker that is stuck loading or running. Frames are never written to disk or logged.

The official 416×416 model expects BGR float32 pixels in the 0–255 range, CHW layout, and a top-left letterbox filled with 114. Output is raw YOLOX anchor offsets and COCO class scores; class 0 is person. Confidence threshold is 0.4 and nonmaximum suppression overlap is 0.45. Boxes are clipped to the original image and normalized to 0–1.

For an optional reproducible inference check, run `node modules/freecamera/scripts/setup-model.js --validation-image`, then `node --test modules/freecamera/test/detector.test.js`. This downloads the public [Ultralytics bus sample](https://github.com/ultralytics/assets/releases/download/v0.0.0/bus.jpg) as `validation-person.jpg`; it contains people and is used only for validation, not as application content. The test checks real inference and verifies the process PID no longer exists after disabling. Without the model/sample/runtime, only that real inference test is skipped; all process lifecycle and decoder tests still run.

Downloaded weights, sample images, and temporary downloads are local generated files and should be excluded from source control. Packaged desktop distributions must include `yolox_tiny.onnx` at the same path relative to `server/`, along with the installed native `onnxruntime-node` and `sharp` runtime files.
