"""Local ASR and online TTS, using the providers supported by xiaozhi-esp32-server.

No device provisioning, OTA, model API credentials, or microphone access lives here.
The parent owns cancellation: terminating this process also releases the recognizer.
"""
import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path


def emit(result):
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--synthesis-only", action="store_true")
    args = parser.parse_args()
    try:
        import edge_tts
        if not args.synthesis_only:
            import numpy as np
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
    except Exception:
        emit({"type": "startup-error"})
        return 1
    emit({"type": "ready", "pid": os.getpid()})

    async def synthesize(message):
        # Match upstream's EdgeTTS provider; bounded memory, no audio files retained.
        communicate = edge_tts.Communicate(
            message["text"], voice=message["voice"], rate=f'{message["rate"]:+d}%'
        )
        chunks, length = [], 0
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                length += len(chunk["data"])
                if length > 6 * 1024 * 1024:
                    raise ValueError("synthesis-too-large")
                chunks.append(chunk["data"])
        if not chunks:
            raise ValueError("no-audio")
        return {"audio": base64.b64encode(b"".join(chunks)).decode("ascii"), "mime": "audio/mpeg"}

    for line in sys.stdin:
        if len(line) > 1400000:
            return 1
        message = {}
        try:
            message = json.loads(line)
            if message["action"] == "transcribe":
                if args.synthesis_only:
                    raise ValueError("recognition-not-open")
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
            elif message["action"] == "speak":
                result = asyncio.run(asyncio.wait_for(synthesize(message), timeout=25))
            else:
                raise ValueError("unknown-action")
            emit({"id": message["id"], "ok": True, **result})
        except Exception:
            # Never echo audio, spoken text, provider bodies, paths or credentials.
            emit({"id": message.get("id"), "action": message.get("action"), "ok": False})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
