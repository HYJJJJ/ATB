"""Install only local speech recognition and EdgeTTS into an isolated environment."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
import venv
from pathlib import Path

REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07"
BASE = f"https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/{REVISION}/"
MODEL_SHA256 = "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"
TOKENS_SHA256 = "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"
VAD_BASE = "https://raw.githubusercontent.com/xinnan-tech/xiaozhi-esp32-server/4b1a54a41c28112bc06b1ab605d2ba723f678ad3/main/xiaozhi-server/models/snakers4_silero-vad/src/silero_vad/data/"
VAD_SHA256 = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f"


def sha256_file(target):
    digest = hashlib.sha256()
    with target.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def download(name, directory, expected_sha256=None, base_url=BASE):
    target = directory / name
    if target.exists() and (not expected_sha256 or sha256_file(target) == expected_sha256):
        return
    temporary = target.with_name(target.name + ".partial")
    digest = hashlib.sha256()
    print(f"Downloading {name}...", flush=True)
    with urllib.request.urlopen(base_url + name, timeout=90) as source, temporary.open("wb") as output:
        while block := source.read(1024 * 1024):
            output.write(block)
            digest.update(block)
    if expected_sha256 and digest.hexdigest() != expected_sha256:
        temporary.unlink()
        raise ValueError("Model checksum did not match")
    temporary.replace(target)


def main():
    if not (3, 10) <= sys.version_info[:2] < (3, 13):
        raise SystemExit("Use Python 3.10, 3.11 or 3.12 for the pinned speech packages.")
    parser = argparse.ArgumentParser()
    default_root = Path(os.environ.get("ATB_DATA_DIR", os.environ.get("FREECAMERA_DATA_DIR", Path(__file__).resolve().parents[3])))
    parser.add_argument("--data-dir", type=Path, default=default_root / "data" / "assistant")
    args = parser.parse_args()
    root = args.data_dir.resolve()
    runtime = root / "voice-runtime"
    python = runtime / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(runtime)
    subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "numpy==1.26.4", "sherpa-onnx==1.13.8", "edge-tts==7.3.1"], check=True)
    models = root / "models" / "sensevoice-int8"
    models.mkdir(parents=True, exist_ok=True)
    download("model.int8.onnx", models, MODEL_SHA256)
    download("silero_vad.onnx", models, VAD_SHA256, VAD_BASE)
    download("tokens.txt", models, TOKENS_SHA256)
    for name in ("LICENSE", "README.md"):
        download(name, models)
    for name in ("SenseVoice-MODEL-LICENSE.txt", "Silero-MIT.txt"):
        source = Path(__file__).resolve().parents[1] / "docs" / "licenses" / name
        (models / name).write_bytes(source.read_bytes())
    (models / "source.json").write_text(json.dumps({"repository": BASE.split("/resolve/")[0], "revision": REVISION, "sha256": MODEL_SHA256, "tokensSha256": TOKENS_SHA256, "vadSource": VAD_BASE, "vadSha256": VAD_SHA256}, indent=2), encoding="utf-8")
    print("Voice runtime ready. Enable voice in ATB to load the model.")


if __name__ == "__main__":
    main()
