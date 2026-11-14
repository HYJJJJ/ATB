# 第三方归属

ATB 的模块代码与第三方运行时、权重分别管理。第三方组件原有许可不受 ATB 主 LICENSE 限制。

| 组件 | 用途与来源 | 许可 |
| --- | --- | --- |
| Electron | Windows 桌面运行时，electron/electron | MIT，发行包附带 Chromium 等许可 |
| DeepSeek Harness SDK/CLI 0.2.2-rc.1 | deepseek-ai/deepseek-harness，普通助手唯一执行核心 | MIT，保留各依赖包 LICENSE/NOTICE |
| Model Context Protocol TypeScript SDK 1.26.0 | modelcontextprotocol/typescript-sdk，自定义工具连接 | MIT |
| Playwright MCP 0.0.85 | microsoft/playwright-mcp，独立无头Edge浏览器工具 | Apache-2.0；浏览器按自身许可单独安装 |
| Node.js 24.22.3 / npm 11.14.1 | 助手私有Node运行时及npm/npx，不替换系统安装 | Node为MIT及第三方通知，完整副本和固定来源/SHA256见 `modules/assistant/docs/licenses/node/`；npm为Artistic-2.0，包含各依赖许可 |
| linkedom 0.18.12 | WebReflection/linkedom，公开网页正文/RSS解析 | ISC |
| node-forge | 证书，digitalbazaar/forge | BSD-3-Clause 或 GPL-2.0 双许可，使用 BSD 条款 |
| ws / qrcode / turn-server | 摄像头连接与二维码 | 各自 npm 包携带的许可 |
| ONNX Runtime | 本机人物推理，microsoft/onnxruntime | MIT，依赖及通知随包保留 |
| sharp / libvips | 图像预处理 | Apache-2.0 / LGPL-2.1，随运行时保留相应许可 |
| YOLOX tiny ONNX | Megvii-BaseDetection/YOLOX 官方权重 | Apache-2.0，模型元数据与许可保留于 FreeCamera 模块 |
| face-api.js 0.22.2、TinyFaceDetector、68点与人脸特征权重 | justadudewhohacks/face-api.js 官方固定0.22.2版本，本地到场识别 | MIT（Vincent Mühler），许可与下载来源/SHA256见 `modules/assistant/public/vision/LICENSE` 和 `provenance.json` |
| RustDesk 服务端与客户端 | rustdesk/rustdesk-server、rustdesk/rustdesk | AGPL-3.0，以对应上游 LICENSE 为准；未修改，ATB 包不捆绑二进制，部署使用独立官方服务端 |
| 小智 AI 参考、SenseVoice、Silero、ChatTTS、Qwen3-TTS、Vocos | 智能助手可选语音 | 详见模块内语音归属及许可证副本 |

当前源码工作区包含助手 `public/vision` 下固定版本的人脸模型资产，随助手资源分发；Windows full 暂存规则包括这些资产和官方 YOLOX tiny 权重，core 包没有模块或模型。正式发行需按发布流程核对暂存文件、源码来源和模型摘要。语音依赖及权重由初始化脚本单独下载。第三方原始代码、完整许可和对应源码以模块元数据、固定版本下载来源和包内 LICENSE/NOTICE 为准。
