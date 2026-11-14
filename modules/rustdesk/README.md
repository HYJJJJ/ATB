# RustDesk 模块

本目录是 ATB 的完整 RustDesk 接入模块，包含页面、API、桌面启动适配和测试。远控由官方 RustDesk 客户端执行，full 发行包只包含本适配模块，不包含第三方客户端。

从项目根目录使用 `Start-ATB.cmd` 或 `Start-ATB-Desktop.cmd` 启动平台，再从工作台进入本模块。

## 配置

平台 `SharedSettings` 的 `server` 分组提供 `publicHost` 和 `rustdesk: {idPort,relayPort,natPort,publicKey,deployedVersion}`。所有端口均指向用户实际配置的公网映射，不假设连续端口。`publicHost` 由平台通用设置维护，RustDesk 页面管理端口和公钥。保存只更新上述三个端口及公钥，保留部署版本与其他共享字段，不会修改服务器防火墙、NAT 或进程。

`GET /api/rustdesk/config`、`GET /api/rustdesk/status`、`GET /api/rustdesk/export` 复用平台会话。`POST /api/rustdesk/config` 额外要求管理员、相同来源、JSON，验证整数端口与 Ed25519 公钥，并拒绝其他字段。公开资源完全由 manifest 白名单提供；本模块不提供文件浏览、任意下载路径或执行命令接口。

导出的 JSON 是公开配置备忘，并非官方客户端原生导入格式。两端需在官方客户端设置 ID 服务器、中继服务器和 Key。SSH 密码及私钥不进入模块；永久访问密码只在官方客户端的安全设置中管理。

## NAT 与健康检查限制

RustDesk 1.5.3 官方源码 `src/common.rs` 的 `test_nat_type_` 从 ID 服务地址派生 NAT 测试地址：`increase_port(&server1, -1)`。因此标准客户端使用 `idPort - 1`，不能通过三个连接字段单独指定另一个 NAT 测试端口。模块将已配置的 `natPort` 与派生端口比较，在不一致时给出提示。该提示只说明 NAT 检测端口不兼容，不将其作为远控不可用的判定；可先使用已配置的 ID 与中继服务进行实际远控验证。若需恢复 NAT 检测，应在服务器网络面板提供相应公网映射；只改 ATB 的端口数值不会创建实际映射。

健康检查仅从运行 ATB 的主机向共享设置中的固定公开主机、端口发起 TCP 连接，超时 1.8 秒，缓存 10 秒。NAT 检测字段缺失会显示未连通；没有完整配置不会探测。检查不验证 UDP、注册协议、密钥握手或完整远控。服务器不支持公网回环时，检查可能失败而外部网络可达，须在另一网络的两台客户端实际验证。`remoteSessionVerified` 与 `udpVerified` 固定为 false。

## Windows 桌面

适配仅通过通用 `atbDesktop.invokeModule('rustdesk', action, options)` 提供 `status`、`open`、`connect`。核心负责受信窗口、主 frame 与来源校验。适配只查找系统 Program Files、Program Files (x86) 或 LOCALAPPDATA 下固定 RustDesk 安装路径，不接受网页指定的可执行文件路径。使用 `execFile`、`shell:false`，连接 ID 限制为 6–20 位数字（允许显示用空格），参数独立传入。模块关闭不终止由用户继续使用的官方客户端。

点击“打开客户端”和“连接设备”会先检查本机 Windows `RustDesk` 服务。已运行时直接打开窗口，不重启、不重新注册；停止或暂停时启动/恢复并等待运行，启动类型设为自动；服务缺失时调用已发现官方客户端的 `--install-service`（与官方“运行服务”相同），确认服务运行后再打开窗口。只有缺失时才执行注册，不能在活动服务上重复安装。进入模块/查询客户端状态不会启动服务。

Windows 权限不足时，仅固定的服务启动操作通过系统 UAC 请求管理员授权；整个 ATB 不提权。官方注册服务流程也可能显示其自身授权提示。取消、失败或超时会显示启动失败并恢复按钮，不冒充已启动。服务准备有85秒总超时，同一模块的并发点击共用一项准备任务；客户端窗口和用户远控会话没有此超时。页面路径、参数和服务名称不可自定义。所有实现都在本模块 `desktop/windows-service.cjs` 与 `desktop/index.cjs`，既有模块运行时代码复制规则会包含新CJS文件。

官方 `--config` 路径在 1.5.3 `src/core_main.rs` 中要求已安装并具有 root/管理员权限；模块仍不自动导入服务器/密码配置，提供手动配置及复制功能。服务启动与配置导入分别处理。

## 验证

在项目根目录运行 `node --test modules/rustdesk/test/*.test.js`。浏览器测试使用项目的 Playwright，生成桌面、手机截图到忽略的 `test-results/atb/`，并覆盖原生入口等待/失败/重试提示。服务端测试使用真实 AccountStore、HTTP 请求与本机临时 TCP 服务；原生启动测试在进程创建边界替换 execFile，避免启动用户客户端；`windows-service.test.js` 使用真实PowerShell解释器与进程内替代服务命令，检查运行/停止/暂停/缺失/取消，不操作真实Windows服务。测试不连接生产服务器。

## 官方参考

- 客户端配置：https://rustdesk.com/docs/en/self-host/client-configuration/
- 客户端 NAT 检测源码：https://github.com/rustdesk/rustdesk/blob/1.5.3/src/common.rs#L693-L710
- 客户端命令行配置导入：https://github.com/rustdesk/rustdesk/blob/1.5.3/src/core_main.rs#L480-L503
- 官方客户端下载：https://github.com/rustdesk/rustdesk/releases/latest
- RustDesk 服务端：https://github.com/rustdesk/rustdesk-server

ATB 模块使用项目主许可证。RustDesk 客户端与服务端均为独立第三方项目，发行许可及源码以官方项目为准；本模块未复制或捆绑其可执行文件。
