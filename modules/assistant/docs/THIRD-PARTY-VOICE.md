# 语音组件与模型归属

本项目参考 `xinnan-tech/xiaozhi-esp32-server` 的 AI 提供者和调度方式，审阅提交 `4b1a54a41c28112bc06b1ab605d2ba723f678ad3`。未移植 ESP32 固件或完整后台。原项目：Copyright (c) 2025 xinnan-tech，MIT 许可全文见 `licenses/xiaozhi-MIT.txt`。

| 组件 | 本机安装版本/来源 | 许可与归属 |
| --- | --- | --- |
| sherpa-onnx | 1.13.8，k2-fsa/sherpa-onnx | Apache-2.0；安装包保留自身 LICENSE |
| SenseVoice INT8 | csukuangfj 的 sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17；提交 2365baeacb507f821a0c8120fcee3d484dba7a07 | 作者 FunAudioLLM / Alibaba Group；模型仓库 LICENSE 引用 FunASR 模型协议，全文见 `licenses/SenseVoice-MODEL-LICENSE.txt`，与推理库许可独立 |
| Silero VAD | 小智上述固定提交内的 snakers4_silero-vad 模型 | Copyright (c) 2020-present Silero Team；MIT 全文见 `licenses/Silero-MIT.txt` |
| edge-tts | 7.3.1，rany2/edge-tts | LGPL-3.0，安装包保留自身许可；通过在线服务合成，未分发微软音色模型 |
| numpy | 1.26.4 | BSD-3-Clause，安装包保留自身许可 |

权重由初始化脚本单独下载，校验模型及词表 SHA256；原模型 README、LICENSE、完整模型条款及来源清单保留在本机模型目录。应用发布包不包含这些权重或 Python 环境。许可证副本核查日期：2026-11-12；SenseVoice 模型卡与 FunASR MODEL_LICENSE 分别核实，不能用小智源码的 MIT 代替模型条款。
