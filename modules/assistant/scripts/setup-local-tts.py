"""Install ChatTTS and Qwen3-TTS in a dedicated environment and verify pinned assets."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv

MODULE = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    configured = os.environ.get('ATB_DATA_DIR', os.environ.get('FREECAMERA_DATA_DIR'))
    default = Path(configured) / 'assistant' if configured else MODULE.parents[1] / 'data' / 'assistant'
    parser.add_argument('--data-dir', type=Path, default=default)
    parser.add_argument('--provider', choices=('all', 'chattts', 'qwen3tts'), default='all')
    parser.add_argument('--mirror', action='store_true')
    parser.add_argument('--modelscope', action='store_true', help='Download Qwen weights from official ModelScope mirror; the pinned SHA256 must still match')
    parser.add_argument('--cpu', action='store_true', help='Install CPU PyTorch instead of CUDA 12.8')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    if not (3, 10) <= sys.version_info[:2] <= (3, 12):
        raise SystemExit('Use Python 3.10, 3.11 or 3.12.')
    directory = args.data_dir.resolve()
    runtime = directory / 'tts-runtime'
    python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not args.verify_only:
        if not python.exists():
            venv.EnvBuilder(with_pip=True).create(runtime)
        def pip(*packages):
            subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', *packages], check=True)
        pip('--upgrade', 'pip')
        cuda = not args.cpu and os.name == 'nt'
        suffix = '+cu128' if cuda else '+cpu'
        pip('torch==2.8.0' + suffix, 'torchaudio==2.8.0' + suffix,
            '--extra-index-url', 'https://download.pytorch.org/whl/' + ('cu128' if cuda else 'cpu'))
        pip('ChatTTS==0.2.5', 'numpy==1.26.4', 'transformers==4.44.2', 'sherpa-onnx==1.13.8')
    if not python.is_file():
        raise SystemExit('Local TTS runtime is not installed.')
    subprocess.run([str(python), '-c', 'import torch, torchaudio, ChatTTS, sherpa_onnx; print("LOCAL_TTS_RUNTIME_READY", torch.cuda.is_available())'], check=True)
    if args.provider in ('all', 'qwen3tts'):
        qwen_runtime = directory / 'qwen-tts-runtime'
        qwen_python = qwen_runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        if not args.verify_only:
            if not qwen_python.exists():
                venv.EnvBuilder(with_pip=True).create(qwen_runtime)
            # Share large CUDA libraries read-only; Qwen's pinned transformers wins in its own environment.
            purelib = subprocess.check_output([str(qwen_python), '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], text=True).strip()
            shared_site = subprocess.check_output([str(python), '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], text=True).strip()
            (Path(purelib) / 'atb_shared_torch.pth').write_text(shared_site + '\n', encoding='utf-8')
            subprocess.run([str(qwen_python), '-m', 'pip', 'install', '--upgrade', 'pip'], check=True)
            subprocess.run([str(qwen_python), '-m', 'pip', 'install', 'qwen-tts==0.1.1'], check=True)
        subprocess.run([str(qwen_python), '-c', 'from qwen_tts import Qwen3TTSModel; import torch, transformers; assert transformers.__version__ == "4.57.3"; print("QWEN_RUNTIME_READY", torch.cuda.is_available())'], check=True)
    command = ['node', str(MODULE / 'scripts' / 'download-local-tts.js'), '--data-dir', str(directory), '--provider', args.provider]
    if args.mirror:
        command.append('--mirror')
    if args.modelscope:
        command.append('--modelscope')
    if args.verify_only:
        command.append('--verify-only')
    subprocess.run(command, check=True)
    print('LOCAL_TTS_INSTALL_PASS; choose ChatTTS or Qwen3-TTS in ATB voice settings.', flush=True)

if __name__ == '__main__':
    main()
