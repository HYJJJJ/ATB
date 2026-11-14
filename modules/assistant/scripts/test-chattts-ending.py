"""Real-model ChatTTS ending regression; requires the installed local TTS runtime.

Checks native audio before playback padding, including the reported seed_1244
preview. A transcript alone cannot detect an abruptly cut final vowel.
"""
import json
import sys
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'modules/assistant/assistant'))
from local_synthesis import LocalSynthesis


def main():
    evidence = ROOT / 'test-results/chattts-tail-v2'
    evidence.mkdir(parents=True, exist_ok=True)
    synth = LocalSynthesis('chattts', ROOT / 'data/assistant/models/chattts')
    reports = []
    cases = [
        ('reported-1244', 'chattts:speaker:seed_1244', '你好，我是你的助手，有什么可以帮你？'),
        ('random-42', 'chattts:42', '你好，我是你的助手，有什么可以帮你？'),
        ('ranked-2155', 'chattts:speaker:seed_2155', '你好，我是你的助手，有什么可以帮你？'),
        ('long-1244', 'chattts:speaker:seed_1244', '今天我们一起检查语音播放是否完整。最后请记住这句结束语，祝你今天一切顺利，再见。'),
    ]
    for name, voice, text in cases:
        chunks = []
        synth.stream({'text': text, 'voice': voice, 'rate': 0, 'volume': 0}, chunks.append)
        audio = np.frombuffer(b''.join(chunks), dtype='<i2').astype(np.float32) / 32768
        sf.write(evidence / (name + '.wav'), audio, 24000)
        rms = float(np.sqrt(np.mean(audio ** 2)))
        tail_rms = float(np.sqrt(np.mean(audio[-1440:] ** 2)))
        report = {'case': name, 'seconds': len(audio) / 24000, 'rms': rms,
                  'last60msRms': tail_rms, 'tailRatio': tail_rms / max(rms, 1e-9)}
        reports.append(report)
        print(json.dumps(report), flush=True)
    (evidence / 'ending-regression.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')
    assert all(row['rms'] > .01 for row in reports), 'fixtures must contain speech'
    assert all(row['tailRatio'] < .1 for row in reports), 'native voice must decay before ending, rather than cut an active syllable'
    print('CHAT_NATIVE_ENDING_PASS', flush=True)


if __name__ == '__main__':
    main()
