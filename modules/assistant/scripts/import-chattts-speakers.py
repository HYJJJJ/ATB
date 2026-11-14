"""Import the pinned public ChatTTS_Speaker table as plain metadata and float32 vectors.
Run with the installed tts-runtime Python. No downloaded pickle is used at runtime.
"""
import argparse
import base64
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import urllib.request

SOURCE = 'https://huggingface.co/spaces/taa/ChatTTS_Speaker/resolve/main/evaluation_results.csv'
SOURCE_SHA256 = '960259aa40c82dad65366011c15e127fe951c2eec65f8667cfcf41557fdd61ae'
COUNT, DIMENSION = 2646, 768

def label(value):
    if not value:
        return '未知'
    parts = [part.split(':') for part in value.split(';')]
    return max(parts, key=lambda part: float(part[1]))[0]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, help='Previously downloaded pinned CSV')
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'assistant')
    args = parser.parse_args()
    if args.input:
        data = args.input.read_bytes()
    else:
        with urllib.request.urlopen(SOURCE, timeout=60) as response:
            data = response.read(20 * 1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError('Source table differs from the reviewed snapshot')
    import numpy as np
    import torch
    rows = list(csv.DictReader(io.StringIO(data.decode('utf-8'))))
    if len(rows) != COUNT or len({row['seed_id'] for row in rows}) != COUNT:
        raise ValueError('Unexpected speaker count or duplicate IDs')
    voices, vectors = [], []
    for index, row in enumerate(rows):
        if not re.fullmatch(r'seed_[0-9]{1,10}', row['seed_id']):
            raise ValueError('Invalid speaker ID')
        raw = base64.b64decode(row['emb_data'], validate=True)
        if len(raw) > 16384:
            raise ValueError('Oversized source tensor')
        tensor = torch.load(io.BytesIO(raw), map_location='cpu', weights_only=True)
        if not isinstance(tensor, torch.Tensor) or tensor.shape != (DIMENSION,) or not torch.isfinite(tensor).all():
            raise ValueError('Invalid speaker tensor')
        vector = tensor.detach().to(dtype=torch.float32).numpy().astype('<f4')
        vectors.append(vector.tobytes())
        scores = {key: float(row[column]) for key, column in [('rankSingle','rank_single'),('rankMulti','rank_multi'),('rankLong','rank_long'),('annotationConfidence','score')]}
        if not all(math.isfinite(value) for value in scores.values()):
            raise ValueError('Invalid score')
        voices.append({'seedId':row['seed_id'], 'vectorIndex':index, **scores,
                       'gender':label(row['gender']), 'age':label(row['age']),
                       'genderDistribution':row['gender'], 'ageDistribution':row['age']})
    binary = b''.join(vectors)
    voices.sort(key=lambda voice: (-voice['rankSingle'], int(voice['seedId'].split('_')[1])))
    catalogue = {'schemaVersion':1,'source':{'project':'ChatTTS_Speaker','studio':'https://www.modelscope.cn/studios/ttwwwaa/ChatTTS_Speaker',
        'repository':'https://github.com/6drf21e/ChatTTS_Speaker','url':SOURCE,'sha256':SOURCE_SHA256,
        'retrievedAt':'2026-11-13','licenseDeclaration':'Apache License 2.0 (ModelScope studio metadata)',
        'notes':'Stability ranks are not sound-quality scores; gender and age are estimated labels.'},
        'vectors':{'filename':'chattts-speakers.f32','dtype':'float32-le','dimension':DIMENSION,'count':COUNT,'sha256':hashlib.sha256(binary).hexdigest()},'voices':voices}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / 'chattts-speakers.f32').write_bytes(binary)
    (args.output_dir / 'chattts-speakers.json').write_text(json.dumps(catalogue,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
    print(json.dumps({'count':COUNT,'vectorBytes':len(binary),'sha256':catalogue['vectors']['sha256']}))

if __name__ == '__main__':
    main()
