# RustDesk 服务器部署与生命周期

安装脚本仅支持 Ubuntu systemd/x86_64，以 root 执行。操作前完整读取本机私有 `docs/SERVER.md`，核对 SSH 主机指纹、现有服务和备份；脚本不会选择主机、远程认证或修改防火墙/NAT。

固定官方服务端 1.1.16，压缩包来自 `rustdesk/rustdesk-server` 对应 Release 的 `rustdesk-server-linux-amd64.zip`，SHA256 为 `0565c41affe6c3f409b0bddfaf5a24ccbf3f64f5f8e3fec250b69a0d5f6bdbcf`。上游以 AGPL-3.0 分发；本脚本安装原始二进制，不修改协议。下载前核对固定版本与官方来源。

准备好 ATB release 后，在已核对的服务器执行：

```bash
ATB_RUSTDESK_ARCHIVE=/root/rustdesk-server-linux-amd64.zip \
ATB_RELAY_SERVER=example.com:21117 \
ATB_CURRENT=/opt/freecamera/current \
ATB_SERVICE=freecamera.service \
bash modules/rustdesk/deploy/install.sh
```

实例内部使用 TCP21115（NAT测试）、TCP+UDP21116（ID）、TCP21117（中继）。公网映射另行配置，ID 公网端口与中继端口可显式填写；标准客户端 NAT 测试固定访问 ID 公网端口减1，非连续映射会影响此项。默认 `ALWAYS_USE_RELAY=Y`，保证以中继为优先的接入；实际流量会通过服务器。

程序归 `/opt/atb-modules/rustdesk/1.1.16`；专用用户 `atb-rustdesk`，私钥/注册数据库仅在 `/var/lib/atb-rustdesk`。两个服务均使用 `-k _` 强制匹配生成的公开 Key。安装后仅读取 `id_ed25519.pub` 写入平台 `SharedSettings.server.rustdesk`；禁止读取或发布私钥。实例服务环境是部署时生成的公开参数快照，网页修改客户端连接设置不会改动 systemd、NAT 或防火墙。

systemd 注册文件由模块部署脚本生成：`atb-rustdesk-hbbs.service`、`atb-rustdesk-hbbr.service` 和平台 unit 的 rustdesk.conf drop-in。`PartOf` 将停止/重启与平台关联，`ConditionPathExists` 每次启动检查 current release 的模块 manifest。删除云端模块文件夹并重启对应平台时，两服务停止且条件不再允许启动；Windows 本地模块删除不会操作远端服务器。无需授予平台 sudo 权限。

升级前备份上述 unit、drop-in、环境与 current 指向，状态目录应保存根用户私有备份。验证须分别覆盖：systemd用户/进程、私钥权限、TCP公网入口、UDP注册、正确/错误Key、实际中继双向传输和完整客户端远控。端口状态页仅验证 TCP，不能代替完整验收。

回滚程序：停止两个新增服务，移开本模块新增的 drop-in 和 unit（或恢复备份），daemon-reload，再恢复 ATB 旧 release。保留 state 和备份；不要自动删除私钥、已有注册或其他平台数据。服务未提供 ATB账户级租户隔离，公开Key是连接校验字段，电脑访问密码和同意流程仍在官方客户端配置。
