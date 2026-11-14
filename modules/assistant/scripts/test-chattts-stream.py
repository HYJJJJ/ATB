"""Real-model regression: emitted ChatTTS seams must match the final decode.

Run with data/assistant/tts-runtime/Scripts/python.exe. Uses fixed public test
text and fresh model state; writes only ignored test-results artifacts.
"""
import json
import sys
import time
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "modules/assistant/assistant"))
from local_synthesis import LocalSynthesis


def main():
    evidence = ROOT / "test-results/chattts-noise"
    evidence.mkdir(parents=True, exist_ok=True)
    synth = LocalSynthesis("chattts", ROOT / "data/assistant/models/chattts")
    reports = []
    cases = [
        ("random-short", "chattts:42", "你好，我是你的助手，有什么可以帮你？"),
        ("ranked-long", "chattts:speaker:seed_2155", "今天我们一起检查语音播放是否完整。先把第一句话说完，再继续说第二句话。最后请记住这句结束语，祝你今天一切顺利，再见。"),
    ]
    for name, voice, text in cases:
        original_decode, original_infer = synth.model._decode_to_wavs, synth.model.infer
        decoded, boundaries, packets = [], [], []
        first_ms = None
        started = time.perf_counter()
        def decode(*args, **kwargs):
            result = original_decode(*args, **kwargs)
            decoded.append(result[0].copy())
            return result
        def infer(*args, **kwargs):
            offset = 0
            for batch in original_infer(*args, **kwargs):
                if batch is not None and len(batch) and batch[0] is not None and len(batch[0]):
                    offset += len(batch[0]); boundaries.append(offset)
                yield batch
        def receive(pcm):
            nonlocal first_ms
            if first_ms is None:
                first_ms = round((time.perf_counter() - started) * 1000)
            packets.append(np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32767)
        synth.model._decode_to_wavs, synth.model.infer = decode, infer
        try:
            synth.stream({"text": text, "voice": voice, "rate": 0, "volume": 0}, receive)
        finally:
            synth.model._decode_to_wavs, synth.model.infer = original_decode, original_infer
        audio = np.concatenate(packets)
        reference = np.clip(decoded[-1], -1, 1)
        errors, extra_jumps = [], []
        for at in boundaries[:-1]:
            errors.append(float(np.sqrt(np.mean((audio[max(0, at-240):at] - reference[max(0, at-240):at]) ** 2))))
            extra_jumps.append(float(abs((audio[at]-audio[at-1]) - (reference[at]-reference[at-1]))))
        report = {"case": name, "voice": voice, "firstMs": first_ms,
                  "totalMs": round((time.perf_counter()-started)*1000),
                  "seams": len(errors), "maxBoundaryRmsError": max(errors, default=0),
                  "maxExtraJump": max(extra_jumps, default=0),
                  "samples": len(audio), "referenceSamples": len(reference)}
        reports.append(report)
        sf.write(evidence / (name+"-stream.wav"), audio, 24000)
        sf.write(evidence / (name+"-reference.wav"), reference, 24000)
        print(json.dumps(report), flush=True)
        assert len(errors) >= 2, "regression must exercise multiple model decode boundaries"
        assert max(errors) < .005, "unstable decoder tails introduce broadband seam noise"
        assert max(extra_jumps) < .005, "stream splice differs from the final continuous waveform"
        # Upstream removes samples below 1e-5 only from its final flush. Natural
        # trailing silence contains many such samples; verify the exact retained
        # tail instead of treating all length differences as lost speech.
        tail_start = boundaries[-2]
        raw_tail = reference[tail_start:]
        expected_tail = raw_tail[np.abs(raw_tail) > 1e-5]
        assert len(audio) == tail_start + len(expected_tail), "only upstream near-zero tail samples may be omitted"
        assert np.max(np.abs(audio[tail_start:] - expected_tail), initial=0) < 1 / 32767 + 1e-7, "every audible final sample must survive the stream flush"
        assert first_ms < report["totalMs"], "first audio must remain incremental"
    (evidence / "stream-regression.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")
    print("CHAT_STREAM_SEAMS_PASS", flush=True)


if __name__ == "__main__":
    main()
