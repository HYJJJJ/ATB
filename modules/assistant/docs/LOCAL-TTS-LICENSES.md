# 本地语音合成来源与许可

当前本地合成可选择 ChatTTS 或 Qwen3-TTS，F5-TTS、ZipVoice、Edge 已移除。模型权重、Python 环境与用户音频不进入源码包，初始化时单独下载。

| 组件 | 官方来源 | 许可 |
| --- | --- | --- |
| ChatTTS 0.2.5 代码 | 2noise/ChatTTS | AGPL-3.0-or-later |
| ChatTTS 权重 | huggingface.co/2Noise/ChatTTS | CC-BY-NC-4.0 |
| Qwen3-TTS / qwen-tts 0.1.1 | QwenLM/Qwen3-TTS；Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice | Apache-2.0；完整9音色，独立环境、权重不捆绑 |
| Vocos | charactr/vocos-mel-24khz | MIT；以下载资源附带条款为准 |
| PyTorch / torchaudio | pytorch.org | BSD 风格；CUDA组件保留各自条款 |
| sherpa-onnx 1.13.8 / NumPy 1.26.4 | 官方 Python 包 | Apache-2.0 / BSD-3-Clause |

固定revision、长度、SHA256与每个文件URL见 `assistant/local-tts-manifest.json`。下载器不解压归档，仅下载白名单路径并校验。推理强制从本地加载，不自动下载识别模型。ChatTTS另附ChatTTS_Speaker评测库的2646组说话人向量，并保留四个快捷随机种子及任意uint32自定义种子；该榜单不是所有可能音色。相同数字种子跨环境不保证复现，榜单直接使用保存向量，不替换原随机种子的含义。Qwen依据固定配置读取完整9个预置音色和官方API支持语言。

两者自动优先CUDA，不支持时使用CPU；不同时常驻，停止/切换终止进程。语速-50至100%、音量-100至100%、音调固定0。音色自然度需实际试听；这些模型许可证不应与代码许可证混同。权重不随ATB发行包分发，商业使用前应核对上游授权。

## ChatTTS_Speaker 说话人向量快照

来源为用户指定的 ModelScope `ttwwwaa/ChatTTS_Speaker`，上游仓库 `6drf21e/ChatTTS_Speaker`，CSV镜像 `https://huggingface.co/spaces/taa/ChatTTS_Speaker/resolve/main/evaluation_results.csv`。2026-11-13核对2646行与运行页面逐项一致。ModelScope页面元数据声明Apache License 2.0；未在上游GitHub找到独立LICENSE文件，不以此声明覆盖ChatTTS代码AGPL或模型CC-BY-NC条款。

模块附带约7.75MiB的768维float32说话人向量（不是完整模型）及标签JSON，保留来源、原始分布和分数。`rankSingle/rankMulti/rankLong`分别为单句/多句/长句稳定性，不是悦耳程度；`annotationConfidence`是标签置信度。Gender/Age为自动估计，不代表真人属性。

原始CSV SHA256：`960259aa40c82dad65366011c15e127fe951c2eec65f8667cfcf41557fdd61ae`。派生向量SHA256：`c925177d5bc2c486a04f7f1c307d019e33f01ba264cc2f675a8239098795f0c5`。导入脚本`modules/assistant/scripts/import-chattts-speakers.py`先校验固定快照哈希，再以`weights_only=True`读取源张量；运行合成只读取普通float32，不反序列化下载的pickle。用已安装tts-runtime的Python运行该脚本即可重建，支持`--input`指定已下载的固定CSV。
