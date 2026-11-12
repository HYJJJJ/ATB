# ATB 模块契约

平台 ATB（All The Best）使用 Node 22+ 和 Electron。模块是可信的本机代码，不提供从网页上传执行代码的入口。将模块放入 `modules/<id>`，重启平台后自动发现；移走整个目录并重启即移除功能。业务数据保留在平台数据目录，以便重新安装。

## Manifest

```json
{
  "id": "example",
  "name": "示例模块",
  "description": "模块用途",
  "version": "0.7.0",
  "apiVersion": 1,
  "entry": "/modules/example/",
  "server": "server/index.js",
  "desktop": "desktop/index.cjs",
  "assets": {"/modules/example/": "public/index.html"}
}
```

资产仅通过白名单服务，禁止列目录和访问 server、desktop、测试、配置、私有数据。URL 不允许冲突。`entry` 必须指向本模块公开资源。JS/CSS/HTML/SVG 的 MIME 由平台按后缀设置。manifest 只记录代码入口和展示信息，不含服务器实例地址或密钥。

## 服务端

`server/index.js` 默认导出 `async function createModule(context)`。

Context：

- `accounts`：平台 AccountStore；模块复用现有 HttpOnly 会话和 `server/accounts.js` 的 sessionToken，不新增独立登录。
- `dataDir`：平台数据根目录，已有监控 devices.json 和 assistant 目录保持兼容。
- `shared`：平台 SharedSettings 实例，`get(section)` 返回克隆，`update(section, mutator)` 串行写入并返回新值；mutator 同步返回替换值。不存在返回 undefined。写入原子替换。
- `config`：已验证的 lanIp/httpsPort/httpPort/certDir/publicOrigin/publicIp/tailscaleAddresses/certRootName；保留 relayPort/relayPublicPort/detector 可选注入作为旧监控配置兼容。任何模块专属字段必须由该模块自己验证，缺模块时不要求这些字段。
- `platform`：`{name:'ATB',fullName:'All The Best',version:'0.7.0'}`。

返回 `{handle?,attach?,close?,config?,transformAsset?}`。`handle(req,res,pathname,requestConfig)` 返回 true 表示已处理。`attach(secureServer)` 在主 HTTP 监听前调用，可创建 WS/额外监听；失败时必须自行回收部分资源，平台继续回收已创建实例。`close()` 幂等回收自身全部运行时资源。

`config` 为公开 `/api/config` 的兼容附加字段，不得含秘密。`transformAsset(filename,content,requestConfig)` 可替换模块 HTML 模板，文件名为 manifest 中的模块相对路径，字符串输入和返回；只有文本资源执行。旧摄像头 `/?mode=camera|viewer` 的 `/` alias 由 camera 模块 handle 按 requestConfig 服务；平台 `/` 默认重定向 `/platform`。核心公共页面只包含平台代码。

共享配置 `data/platform/settings.json` 由核心维护。`server` 分组存 publicHost 和 `rustdesk: {idPort,relayPort,natPort,publicKey,deployedVersion}`；`ai` 分组存提供者连接配置（provider/baseUrl/protocol/model/selectedModels/apiKey）；助手 persona/memory 保留其平台业务数据。旧 API 配置在共享 ai 不存在时才导入，原子提交后不再回读旧密钥；保留旧文件用于回滚。普通平台接口只返回公开 server 设置与 hasApiKey，不回显任何密钥。模块不得把 SSH root 凭据作为平台通用配置。

核心提供认证后的 `GET/POST /api/platform/ai`、`POST /api/platform/ai/models` 和 `POST /api/platform/ai/test`；纯平台包同样可管理默认 AI 配置，不依赖助手目录。模型获取/测试可使用草稿配置且不会保存。留空密钥只保留相同规范化基础地址的旧密钥，改地址必须提供新密钥；`clearKey:true` 明确删除。

需要 AI 的模块默认从 `shared.get('ai')` 读取有效配置，模块的自定义覆盖保存在自己数据目录。助手用 `apiSource:platform|custom` 切换，custom 配置保存在 `assistant/settings.json.ai`；修改自定义配置不修改平台默认值。可选模型保存在 `selectedModels`，对话请求的模型必须位于有效列表。后续模块遵循此继承方式，不复制或输出共享密钥。

统一公共主题由核心 `/ui.css` 和 `/ui.js` 提供。模块保留自身样式，引用共同色值和过渡；有录屏/媒体收尾的页面通过 `atbPrepareClose` 自行管理离开流程，公共过渡不抢先导航。

## 桌面

`desktop/index.cjs` 导出 `createDesktopModule({dataRoot,app,window,chooseFile,notify})`。window 是 `() => BrowserWindow`。返回 `{handlers,suspend?,close?}`。`handlers[action](owner,options)` 仅由核心完成 sender/mainFrame/origin 验证后调用。

核心 preload 暴露 `window.atbDesktop`：isDesktop、invokeModule(id,action,options)、hasModule(id)、通用连接设置方法、notify(options)。模块使用自己的浏览器适配文件对接，不在核心塞模块专属方法。`suspend(owner)` 在页面离开、连接设置、崩溃时释放模型/麦克风；`close()` 在退出时释放全部。监控页面通过 `window.atbPrepareClose` 完成录像尾部写入。

## 迁移和部署

桌面品牌可改为 ATB，但既有 FreeCamera userData/profile 路径保持稳定；支持 ATB_DATA_DIR 及 FREECAMERA_DATA_DIR 兼容。连接发现同时接受 app='atb'/'freecamera'。

云端 RustDesk 守护进程由模块部署脚本注册为 systemd 服务，使用 PartOf 关联平台生命周期，并以 ConditionPathExists 在每次启动检查当前 ATB release 的模块 manifest。移除云端模块并重启平台时，两个服务停止且不再启动，无需平台持有 sudo 权限。模块网页不提供任意 systemctl/命令执行；只删除 Windows 上的模块不会删除云端服务。系统级 unit 属于模块的部署注册，二进制与持久数据保存在各自模块专用目录，卸载默认保留数据。

公开发行包与个人运行数据严格分开。full 含全部模块；core 不含任何模块实现或模型。第三方依赖运行于其模块职责内。core 仅保留平台所需依赖，模块安装后再按其 package.json 安装可选依赖。
