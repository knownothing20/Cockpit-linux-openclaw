# Cockpit 架构

Node.js 主入口统一加载八个管理模块，通过 registry 提供注册、健康检查与代理，shell-ui 提供导航、主题和嵌入式页面。模块保持独立路由，局部故障不应使整个面板失效。

源码与本地运行状态分离。源码仓库只保存可公开材料；账号、连接信息、主机清单、备份、数据库和日志由本地配置与数据目录保存。Git 发布使用脱敏示例与推送前隐私检查。

宿主管理权限由运行用户和本机部署决定。fnOS、容器权限及不同发行版需单独验证。


## fnOS entry boundary (2026-10-26 candidate)

The Debian service entry is preserved. deploy/fnos.sh supplies the separate manual fnOS entry, with private paths.fnos.env and the pinned existing Node image. prepare/check/start validate the real disk mount and bounded staging path; start consumes the prepared snapshot. Emergency stop/status use validated Docker identity and full ID independently of runtime.env and mount availability. The internal Compose project remains leon-cockpit-7001 and the container remains cockpit. No autostart, personal config, DB, whole-home, Docker socket or host-management mount is added. The existing read-only business integration is a separate publication dependency, not included by adopting unrelated dirty files.
