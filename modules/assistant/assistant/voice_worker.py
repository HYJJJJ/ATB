"""Local SenseVoice recognition and ChatTTS / Qwen3-TTS synthesis.

No device provisioning, OTA, model API credentials, or microphone access lives here.
The parent discards cancelled job output and retains the loaded models between leases.
"""
import argparse
import base64
import json
import io
import os
import sys
import wave
from contextlib import redirect_stdout
from pathlib import Path


PROTOCOL_OUTPUT = sys.stdout

def emit(result):
    PROTOCOL_OUTPUT.write(json.dumps(result, ensure_ascii=False) + "\n")
    PROTOCOL_OUTPUT.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir")
    parser.add_argument("--synthesis-only", action="store_true")
    parser.add_argument("--tts-provider", choices=("volcengine", "chattts", "qwen3tts"), default="chattts")
    parser.add_argument("--tts-model-dir")
    args = parser.parse_args()
    recognition = None
    def load_recognition():
        nonlocal recognition
        if recognition is not None:
            return recognition
        import sherpa_onnx
        model_dir = Path(args.model_dir)
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model_dir / "model.int8.onnx"),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=2, sample_rate=16000, feature_dim=80,
            decoding_method="greedy_search", debug=False, use_itn=True,
            provider="cpu",
        )
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = str(model_dir / "silero_vad.onnx")
        vad_config.silero_vad.min_speech_duration = 0.2
        vad_config.silero_vad.min_silence_duration = 0.5
        vad_config.sample_rate = 16000
        vad_config.num_threads = 1
        vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=31)
        recognition = (recognizer, vad_config, vad)
        return recognition
    try:
        import numpy as np
        if args.tts_provider in ("chattts", "qwen3tts"):
            from local_synthesis import LocalSynthesis
            with redirect_stdout(sys.stderr):
                synthesizer = LocalSynthesis(args.tts_provider, args.tts_model_dir)
        if not args.synthesis_only:
            load_recognition()
    except Exception:
        emit({"type": "startup-error"})
        return 1
    emit({"type": "ready", "pid": os.getpid(), "backend": synthesizer.device if args.tts_provider in ("chattts", "qwen3tts") else "cpu"})

    for line in sys.stdin:
        if len(line) > 1400000:
            return 1
        message = {}
        try:
            message = json.loads(line)
            if message["action"] == "recognition-open":
                with redirect_stdout(sys.stderr):
                    load_recognition()
                result = {}
            elif message["action"] == "transcribe":
                if recognition is None:
                    raise ValueError("recognition-not-open")
                recognizer, vad_config, vad = recognition
                pcm = base64.b64decode(message["pcm"], validate=True)
                if not pcm or len(pcm) > 960000 or len(pcm) % 2:
                    raise ValueError("invalid-audio")
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                vad.reset()
                window = vad_config.silero_vad.window_size
                for start in range(0, len(samples), window):
                    vad.accept_waveform(samples[start:start + window])
                vad.flush()
                has_speech = not vad.empty()
                while not vad.empty():
                    vad.pop()
                if has_speech:
                    stream = recognizer.create_stream()
                    # Keep natural pauses and context; VAD only filters empty speech.
                    stream.accept_waveform(16000, samples)
                    recognizer.decode_stream(stream)
                    result = {"text": stream.result.text}
                else:
                    result = {"text": ""}
            elif message["action"] == "speak-stream":
                if args.tts_provider not in ('chattts', 'qwen3tts'):
                    raise ValueError('unsupported-stream')
                with redirect_stdout(sys.stderr):
                    synthesizer.stream(message, lambda pcm: emit({'id':message['id'], 'type':'audio', 'audio':base64.b64encode(pcm).decode('ascii')}))
                result = {}
            elif message["action"] == "speak":
                if args.tts_provider not in ("chattts", "qwen3tts"):
                    raise ValueError("synthesis-provider-not-local")
                with redirect_stdout(sys.stderr):
                    audio = synthesizer.synthesize(message)
                result = {"audio": base64.b64encode(audio).decode("ascii"), "mime": "audio/wav"}
            else:
                raise ValueError("unknown-action")
            emit({"id": message["id"], "ok": True, **result})
        except Exception:
            # Never echo audio, spoken text, provider bodies, paths or credentials.
            emit({"id": message.get("id"), "action": message.get("action"), "ok": False})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
