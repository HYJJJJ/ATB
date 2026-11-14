"""Real installed Qwen PCM streaming regression; run with qwen-tts-runtime Python."""
import sys
import time
import json
import argparse
from pathlib import Path
import numpy as np
import soundfile as sf
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'modules/assistant/assistant'))
from local_synthesis import LocalSynthesis


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', default='test-results/qwen-streaming')
    options = parser.parse_args()
    evidence = ROOT / options.evidence
    evidence.mkdir(exist_ok=True, parents=True)
    synth = LocalSynthesis('qwen3tts', ROOT / 'data/assistant/models/qwen3-tts-0.6b-customvoice')
    reports = []
    for name, voice, text in [
        ('serena-short', 'qwen3tts:serena', '你好，我是你的助手，有什么可以帮你？'),
        ('vivian-long', 'qwen3tts:vivian', '今天我们一起检查语音是否流畅。最后祝你今天一切顺利，再见。'),
        ('dylan-short', 'qwen3tts:dylan', '你好，我是你的助手，有什么可以帮你？'),
    ]:
        synth.torch.manual_seed(42)
        chunks, times, decoded = [], [], []
        original = synth.model.model.speech_tokenizer.decode
        def decode(*args, **kwargs):
            result = original(*args, **kwargs)
            decoded.append(result[0][0].copy())
            return result
        synth.model.model.speech_tokenizer.decode = decode
        started = time.perf_counter()
        def receive(data):
            times.append(time.perf_counter() - started)
            chunks.append(np.frombuffer(data, dtype='<i2').astype(np.float32)/32767)
        try:
            synth.stream({'text': text, 'voice': voice, 'rate': 0, 'volume': 0}, receive)
        finally:
            synth.model.model.speech_tokenizer.decode = original
        audio = np.concatenate(chunks)
        reference = decoded[-1]
        boundaries = np.cumsum([len(chunk) for chunk in chunks])[:-1]
        errors, jumps = [], []
        for at in boundaries:
            errors.append(float(np.sqrt(np.mean((audio[max(0,at-240):at+240] - reference[max(0,at-240):at+240])**2))))
            jumps.append(float(abs((audio[at]-audio[at-1])-(reference[at]-reference[at-1]))))
        report = {'case': name, 'firstMs': round(times[0]*1000), 'totalMs': round(1000*(time.perf_counter()-started)),
                  'packets': len(chunks), 'samples': len(audio), 'referenceSamples': len(reference),
                  'talkerDtype': str(synth.model.model.talker.dtype),
                  'decoderDtype': str(synth.model.model.speech_tokenizer.model.decoder.dtype),
                  'rmsError': float(np.sqrt(np.mean((audio-reference)**2))), 'maxBoundaryRmsError': max(errors), 'maxExtraJump': max(jumps)}
        reports.append(report)
        sf.write(evidence/(name+'.wav'), audio, 24000)
        sf.write(evidence/(name+'-reference.wav'), reference, 24000)
        print(json.dumps(report), flush=True)
        assert len(chunks)>2 and report['firstMs']<report['totalMs']*.8, 'PCM must arrive during generation'
        assert len(audio)==len(reference), 'first and final audio samples must survive'
        assert not synth.model.model.talker._forward_hooks, 'remove the request hook before model reuse'
    (evidence/'stream-regression.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
    for report in reports:
        # BF16 decoder rounding varies with prefix length, producing extra noise
        # and seams even with identical codec tokens. Keep this below -80 dBFS
        # overall and -70 dBFS around boundaries (including PCM16 rounding).
        assert report['rmsError'] < .0001 and report['maxBoundaryRmsError'] < .0003 and report['maxExtraJump'] < .001, f"{report['case']}: chunked decode adds audible precision noise: {report}"
        assert report['decoderDtype'] == 'torch.float32', 'waveform decoding must retain full precision'
        assert report['talkerDtype'] == ('torch.bfloat16' if synth.device == 'cuda' else 'torch.float32'), 'keep the token generator efficient'
    print('QWEN_PCM_STREAM_PASS',flush=True)


if __name__=='__main__':
    main()
