"""Local ChatTTS and Qwen3-TTS, using installed assets only."""
import io
import os
import warnings
from pathlib import Path


class LocalSynthesis:
    def __init__(self, provider, directory):
        if provider == 'chattts':
            os.environ.setdefault('NUMBA_CACHE_DIR', str(Path(directory).parent.parent / 'cache' / 'chattts-numba'))
        import torch
        torch.set_num_threads(2)
        self.torch = torch
        self.provider = provider
        self.directory = Path(directory)
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        if provider == 'chattts':
            import ChatTTS
            from ChatTTS import norm
            # Cache normalization machine code across disposable speech workers.
            # Keep the original normalizer if the cache directory is unavailable.
            for name in ('_find_index', '_fast_replace', '_split_tags', '_combine_tags'):
                try:
                    getattr(norm, name).enable_caching()
                except (OSError, RuntimeError) as error:
                    warnings.warn(f'ChatTTS normalization cache unavailable: {type(error).__name__}', RuntimeWarning)
            self.model = ChatTTS.Chat()
            if not self.model.load(source='custom', custom_path=str(self.directory), device=torch.device(self.device), compile=False):
                raise RuntimeError('chattts-load-failed')
        elif provider == 'qwen3tts':
            from qwen_tts import Qwen3TTSModel
            self.model = Qwen3TTSModel.from_pretrained(str(self.directory), device_map=self.device,
                dtype=torch.bfloat16 if self.device == 'cuda' else torch.float32, attn_implementation='sdpa', local_files_only=True)
            # The loader also casts the waveform decoder to BF16. Its periodic
            # activations amplify rounding, and different prefix lengths then
            # produce different PCM for the same codes. Keep only this decoder
            # in FP32; the much larger token generator stays in BF16 on CUDA.
            self.model.model.speech_tokenizer.model.decoder.float()
        else:
            raise ValueError('unsupported-local-provider')

    def synthesize(self, message):
        import numpy as np
        import soundfile as sf
        voice, rate = message['voice'], message.get('rate', 0)
        if message.get('pitch', 0) != 0 or not -50 <= rate <= 100:
            raise ValueError('invalid-local-controls')
        if self.provider == 'qwen3tts':
            speaker = voice.removeprefix('qwen3tts:')
            if not voice.startswith('qwen3tts:') or speaker not in self.model.get_supported_speakers():
                raise ValueError('invalid-local-voice')
            with self.torch.inference_mode():
                audio_list, sample_rate = self.model.generate_custom_voice(text=message['text'], language='Auto', speaker=speaker, max_new_tokens=2048)
            audio = audio_list[0]
            if rate:
                import librosa
                audio = librosa.effects.time_stretch(np.asarray(audio).reshape(-1), rate=1 + rate / 100)
        else:
            import ChatTTS
            speaker = self.chat_speaker(voice)
            params = ChatTTS.Chat.InferCodeParams(spk_emb=speaker, temperature=.3, top_P=.7, top_K=20,
                prompt='[speed_5]', max_new_token=1024, show_tqdm=False)
            with self.torch.inference_mode():
                audio = self.model.infer([self.chat_text(message['text'])], skip_refine_text=True,
                    params_infer_code=params, split_text=False)[0]
            sample_rate = 24000
            if rate:
                import librosa
                audio = librosa.effects.time_stretch(np.asarray(audio).reshape(-1), rate=1 + rate / 100)
        samples = np.asarray(audio, dtype=np.float32).reshape(-1)
        if not samples.size or samples.size * 2 > 6 * 1024 * 1024 or not np.isfinite(samples).all():
            raise ValueError('invalid-local-audio')
        samples = np.clip(samples * (1 + message.get('volume', 0) / 100), -1, 1)
        output = io.BytesIO()
        sf.write(output, samples, sample_rate, format='WAV', subtype='PCM_16')
        return output.getvalue()

    def chat_speaker(self, voice):
        if isinstance(voice, str) and voice.startswith('chattts:speaker:'):
            import hashlib
            import json
            import numpy as np
            if not hasattr(self, '_ranked_speakers'):
                asset_dir = Path(__file__).resolve().parent
                metadata = json.loads((asset_dir / 'chattts-speakers.json').read_text(encoding='utf-8'))
                vectors = (asset_dir / 'chattts-speakers.f32').read_bytes()
                spec = metadata['vectors']
                if spec['count'] != 2646 or spec['dimension'] != 768 or len(vectors) != 2646 * 768 * 4 or hashlib.sha256(vectors).hexdigest() != spec['sha256']:
                    raise ValueError('invalid-chattts-speaker-assets')
                self._ranked_speakers = {f"chattts:speaker:{row['seedId']}": row['vectorIndex'] for row in metadata['voices']}
                self._speaker_vectors = vectors
            index = self._ranked_speakers.get(voice)
            if index is None:
                raise ValueError('invalid-local-voice')
            samples = np.frombuffer(self._speaker_vectors, dtype='<f4', count=768, offset=index * 768 * 4).copy()
            self.torch.manual_seed(42)
            return self.torch.from_numpy(samples)
        self.torch.manual_seed(self.chat_seed(voice))
        return self.model.sample_random_speaker()

    @staticmethod
    def chat_text(text):
        # skip_refine_text omits the model's usual prosody markers. A terminal
        # unvoiced break lets it finish the final vowel before predicting EOS;
        # playback padding alone cannot restore speech it never generated.
        text = text.rstrip()
        return text if text.endswith('[uv_break]') else text + '[uv_break]'

    @staticmethod
    def chat_seed(voice):
        import re
        if not isinstance(voice, str) or not re.fullmatch(r'chattts:(0|[1-9][0-9]{0,9})', voice):
            raise ValueError('invalid-local-voice')
        seed = int(voice.split(':')[1])
        if seed > 4294967295:
            raise ValueError('invalid-local-voice')
        return seed

    def stream(self, message, on_audio):
        if self.provider == 'qwen3tts':
            return self.qwen_stream(message, on_audio)
        import ChatTTS
        import numpy as np
        if self.provider != 'chattts' or message.get('pitch', 0) != 0 or not -50 <= message.get('rate', 0) <= 100:
            raise ValueError('unsupported-stream-controls')
        speaker = self.chat_speaker(message['voice'])
        params = ChatTTS.Chat.InferCodeParams(spk_emb=speaker, temperature=.3, top_P=.7, top_K=20,
            prompt='[speed_5]', max_new_token=1024, show_tqdm=False, stream_batch=24,
            # ChatTTS re-decodes the growing prefix. Its newest tail is unstable;
            # keep two decode batches ahead of playback. The output cursor still
            # starts at sample zero, so this buffers rather than drops the opening.
            stream_speed=12000, pass_first_n_batches=2)
        total = 0
        with self.torch.inference_mode():
            for batch in self.model.infer([self.chat_text(message['text'])], stream=True, skip_refine_text=True, params_infer_code=params, split_text=False):
                if batch is None or len(batch) == 0 or batch[0] is None:
                    continue
                samples = np.asarray(batch[0], dtype=np.float32).reshape(-1)
                if not samples.size:
                    continue
                if not np.isfinite(samples).all():
                    raise ValueError('invalid-local-audio')
                if message.get('rate', 0):
                    import librosa
                    samples = librosa.effects.time_stretch(samples, rate=1 + message['rate'] / 100)
                samples = np.clip(samples * (1 + message.get('volume', 0) / 100), -1, 1)
                pcm = (samples * 32767).astype('<i2').tobytes()
                total += len(pcm)
                if total > 6 * 1024 * 1024:
                    raise ValueError('oversized-local-audio')
                for start in range(0, len(pcm), 32768):
                    on_audio(pcm[start:start+32768])
        if not total:
            raise ValueError('empty-local-audio')


    def qwen_stream(self, message, on_audio):
        import numpy as np
        if message.get('rate', 0) != 0 or message.get('pitch', 0) != 0:
            raise ValueError('unsupported-stream-controls')
        voice = message['voice']
        speaker = voice.removeprefix('qwen3tts:')
        if not voice.startswith('qwen3tts:') or speaker not in self.model.get_supported_speakers():
            raise ValueError('invalid-local-voice')
        model = self.model.model
        codes, sent, total = [], 0, 0
        def emit(samples):
            nonlocal total
            samples = np.asarray(samples, dtype=np.float32).reshape(-1)
            if not np.isfinite(samples).all():
                raise ValueError('invalid-local-audio')
            samples = np.clip(samples * (1 + message.get('volume', 0) / 100), -1, 1)
            pcm = (samples * 32767).astype('<i2').tobytes()
            total += len(pcm)
            if total > 6 * 1024 * 1024:
                raise ValueError('oversized-local-audio')
            for start in range(0, len(pcm), 32768):
                on_audio(pcm[start:start + 32768])
        def generated(module, args, result):
            nonlocal sent
            # The pinned official talker returns all 16 codebooks per frame.
            # Its public wrapper otherwise waits for every frame before decode.
            code = result.hidden_states[-1]
            if code is None:
                return  # Text prefill has no audio code.
            if code.shape != (1, model.config.talker_config.num_code_groups):
                raise ValueError('unsupported-qwen-stream-shape')
            if int(code[0, 0]) == model.config.talker_config.codec_eos_token_id:
                return
            codes.append(code.detach().clone())
            if len(codes) % 6:
                return
            # Preserve causal left context by decoding the growing prefix, and
            # emit only new samples. Never reinitialize the decoder per packet.
            wavs, sample_rate = model.speech_tokenizer.decode([{'audio_codes': self.torch.stack(codes, dim=1)[0]}])
            if sample_rate != 24000 or len(wavs[0]) < sent:
                raise ValueError('invalid-qwen-stream-audio')
            emit(wavs[0][sent:])
            sent = len(wavs[0])
        handle = model.talker.register_forward_hook(generated)
        try:
            with self.torch.inference_mode():
                wavs, sample_rate = self.model.generate_custom_voice(text=message['text'], language='Auto', speaker=speaker, max_new_tokens=2048)
                if sample_rate != 24000 or len(wavs[0]) < sent:
                    raise ValueError('invalid-qwen-stream-audio')
                emit(wavs[0][sent:])
        finally:
            handle.remove()
        if not total:
            raise ValueError('empty-local-audio')
