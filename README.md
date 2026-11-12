# ATB · All The Best

ATB 是个人工具管理平台，提供统一账户、服务器配置和可移除模块。网页与 Windows 桌面共用同一服务，采用深蓝色界面。

| 模块 | 当前功能 |
| --- | --- |
| FreeCamera | 手机摄像头、实时画面与声音、设备列表和备注、自动重连、对讲、截图录像、可选本机人物检测 |
| 智能助手 | 自定义 OpenAI 兼容 API、模型列表、文字对话、角色和手工记忆；可选本机 SenseVoice 识别及在线 EdgeTTS |
| RustDesk | 自建服务配置、公开公钥与端口管理、状态检查、配置复制、启动已安装的官方 Windows 客户端 |

RustDesk 远控由官方客户端执行，ATB 不包含其客户端程序。当前助手尚未实现微信接入、人脸身份比对、语音唤醒和跨设备长期记忆同步。

## Windows 使用

在 Releases 下载同版本便携程序：

- `ATB-<版本>-Windows-x64-full.exe`：平台与全部三个模块，含人物检测模型。
- `ATB-<版本>-Windows-x64-core.exe`：纯平台，没有模块实现、模型和摄像头运行时。

首次本地启动创建管理员账户。连接已有服务器时，在连接设置填写 HTTPS 地址并导入该服务器的公开根证书，然后用服务器账户登录。私人配置、账户、证书和 API 密钥均不包含在下载包中。

运行数据与程序分开保存，桌面沿用旧版 FreeCamera 用户数据目录以保留连接记录。可设置 `ATB_DATA_DIR` 指定数据根目录，兼容 `FREECAMERA_DATA_DIR`。语音运行时需在使用电脑单独初始化，见智能助手模块文档。

## 从源码运行

需要 Node.js 22 或更新版本，桌面构建需 Windows x64。

```powershell
npm ci
npm run setup:model
npm start
# 或启动桌面
npm run desktop
```

使用启动日志显示的本地地址。iPhone 摄像头网页需要 HTTPS、系统信任证书并允许摄像头/麦克风；长时间采集需保持页面前台。公网部署须先初始化管理员，见 [部署说明](docs/DEPLOYMENT.md)。

```powershell
npm test
npm run check
npm run package:desktop
```

## 模块与共享配置

模块放在 `modules/<id>/`，通过 `module.json` 发现。移走文件夹并重启对应平台后，导航、网页、API、原生处理器和所属监听一并移除，个人业务数据保留。云端 RustDesk 服务注册由模块部署脚本管理，生命周期见其部署说明；仅在本地删除模块不会修改远端服务。

平台统一提供账户、会话、服务地址及 `data/platform/settings.json`。模块通过平台接口读写共享分组，SSH 密码和私钥不存入平台设置。详见 [模块契约](docs/MODULES.md)、[发布流程](docs/RELEASING.md) 和 [安全说明](docs/SECURITY.md)。

公开仓库允许浏览和 fork，维护写权限由所有者控制。原创代码使用范围见 LICENSE；第三方组件遵循各自许可，见 [第三方清单](docs/THIRD-PARTY.md)。
