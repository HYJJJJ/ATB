# 发布 ATB

仅在用户明确要求上传或发布时执行本流程。日常改动只在本地实现和验证，不自动 push、打标签或创建 Release。Start-ATB-Desktop.cmd 只运行当前源码，便于验证尚未发布的改动；缺少开发依赖会提示安装，不回退到旧打包程序。桌面界面与远程服务的边界见 DESKTOP-AND-REMOTE-SERVICES.md。

每次发布必须同时包含新的源码提交、同版本源码 ZIP、Windows x64 full/core 两个便携程序及 SHA256SUMS。不发布只更改版本号却没有源码变化的版本。构建机需 Windows x64、Node22+，依赖按 package-lock.json 安装。

1. 更新 package.json 与各模块版本，运行 npm ci 及 npm ci --prefix modules/assistant，下载并校验人物模型（npm run setup:model）。
2. 运行 npm test、npm run check 和相关模块媒体回归；检查公开文件名单，无账户、CA、密钥或真实服务器资料后提交源码。将需要携带的个人数据留在受限 runtime 目录。
3. 在干净 HEAD 构建 `node scripts/package-atb.js all --source-commit <完整HEAD>`。开发测试可用 --allow-uncommitted，但该产物不能通过正式发布检查。
4. 运行 npm run test:packaged，实际启动 full/core，验证模块发现、登录、持久设置及原生模型释放。full 包含所有模块；core 不含任何模块和模型。
5. 使用 git archive 从相同 HEAD 创建 `ATB-<版本>-source.zip`，放在版本构建目录。必须包含且只包含该提交的公开文件，可使用 `ATB-<版本>/` 前缀。
6. 运行 npm run release:manifest 和 npm run release:check；校验正式产物的版本、源码提交、源文件、文件名单及摘要。检查通过后为该 HEAD 创建 v<版本> tag。
7. 发布 Release，上传源码 ZIP、full.exe、core.exe、SHA256SUMS、release-manifest.json，核实远端 tag 指向与资产摘要。不得用正在运行的旧程序目录当构建输出。

GitHub Actions 的手动 release 工作流也执行上述构建和校验，只有仓库维护者可触发发布，默认令牌只在发布任务获得 contents:write。不含自动部署服务器步骤。公开库只授予所有者维护权限，公众可浏览和 fork。

代码升级不会自动分发运行数据、证书或密钥。桌面暂未实现自动升级，更新需用户关闭旧程序再运行新包；摄像头旧URL和信令兼容本次模块化版本。云端部署另按私有SERVER档案操作并记录。
