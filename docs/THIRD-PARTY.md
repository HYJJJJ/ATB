# 第三方归属

ATB 的模块代码与第三方运行时、权重分别管理。第三方组件原有许可不受 ATB 主 LICENSE 限制。

| 组件 | 用途与来源 | 许可 |
| --- | --- | --- |
| Electron | Windows 桌面运行时，electron/electron | MIT，发行包附带 Chromium 等许可 |
| node-forge | 证书，digitalbazaar/forge | BSD-3-Clause 或 GPL-2.0 双许可，使用 BSD 条款 |
| ws / qrcode / turn-server | 摄像头连接与二维码 | 各自 npm 包携带的许可 |
| ONNX Runtime | 本机人物推理，microsoft/onnxruntime | MIT，依赖及通知随包保留 |
| sharp / libvips | 图像预处理 | Apache-2.0 / LGPL-2.1，随运行时保留相应许可 |
| YOLOX tiny ONNX | Megvii-BaseDetection/YOLOX 官方权重 | Apache-2.0，模型元数据与许可保留于 FreeCamera 模块 |
| RustDesk 服务端与客户端 | rustdesk/rustdesk-server、rustdesk/rustdesk | AGPL-3.0，以对应上游 LICENSE 为准；未修改，ATB 包不捆绑二进制，部署使用独立官方服务端 |
| 小智 AI 参考、SenseVoice、Silero、EdgeTTS | 智能助手可选语音 | 详见模块内语音归属及许可证副本 |

源码不包含下载的模型；Windows full 包包含官方 YOLOX tiny 权重，core 包没有模型。语音依赖及权重由初始化脚本单独下载。第三方原始代码、完整许可和对应源码以模块元数据、固定版本下载来源和包内 LICENSE/NOTICE 为准。
