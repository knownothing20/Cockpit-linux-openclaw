# fnOS 手动只读入口（7001）

Debian 仍用原 start-shell.sh / systemd。fnOS 独立入口：

先核对当前挂载，再将 `deploy/paths.fnos.env.example` 复制为私有的 `deploy/paths.fnos.env`；不覆盖 Debian `paths.env`，不提交私有文件。

```sh
sh deploy/fnos.sh prepare
sh deploy/fnos.sh check
sh deploy/fnos.sh start
COCKPIT_CONTAINER_ROOT='/home/user/workspace/openclaw-cockpit-shell' sh deploy/fnos.sh status
COCKPIT_CONTAINER_ROOT='/home/user/workspace/openclaw-cockpit-shell' sh deploy/fnos.sh stop
```

通过 AgentPort daemon job 在本项目目录运行。启动只创建 cockpit；
restart:no，不设置开机启动。固定已有 Node24 toolbox image ID，不安装宿主依赖，
不更改 Debian node_modules。纯 JS 依赖以当前 package-lock 和只读 node_modules 提供；
配置追踪数据库/API禁用，不加载 native sqlite 二进制。

prepare 在私有迁移暂存区建立仅含 Git 跟踪公开源码的快照，从已审阅示例初始化
非个人配置；不复制 Git、忽略的机器配置/数据库/备份/凭据。快照与依赖均只读。
`paths.fnos.env` 独立声明磁盘和暂存区；只接受该磁盘约定工作区内的暂存区，路径含空格受支持。所有 prepare/start/check 操作先验证实际 mountpoint、项目与暂存区边界，再创建目录；挂载缺失时直接失败。
`start` 仅复用已有 prepare 回执，不再隐式制作新快照；`check` 只验证现有回执、依赖锁、固定镜像和 Compose 配置，不启动或创建快照。
`stop/status` 不读取私有 env、Compose 或磁盘状态，先校验完整 ID、名称、项目/服务标签、Compose 来源和工作目录，再按完整 ID 操作；Docker 查询和停止的真实失败会保留非零退出码。磁盘不可用时需要此前保留、可访问的脚本副本，并显式设置 COCKPIT_HOST_ROOT 为原项目绝对路径以验证标签身份；不可能从已掉线的盘上执行文件。
不存在个人 .openclaw/.hermes、Docker socket、宿主 PID、systemd 或整家目录挂载。

0.5 CPU、512MiB（不额外交换）、PID128，日志10MiB×3，64MiB临时目录。
启动前要求至少2GiB MemAvailable，保留至少1.5GiB余量。

真实可用：Shell导航/主题/页面、八个模块HTML、容器内进程/应用只读信息。
未接入：个人机器人、模型、技能、文件及历史运行数据；空数据不代表原状态已恢复。
不可用：配置恢复API（避免GET统计初始化DB/schema）、自动巡检/清理、服务/宿主管理、
真实模型调用及写操作。相关请求503并返回明确原因；页面常驻同样限制说明。
Shell健康仅代表HTTP进程，module health代表handler装载，不代表宿主能力。

容器名称统一为 cockpit（2026-10-23）；已有 Compose 项目标识 leon-cockpit-7001 保留以继续管理同一实例，部署脚本无需创建第二个项目。

本次仅补齐入口，不启动已停止的 cockpit。回退时保持服务停止，只恢复已核对的入口文件；保留既有快照、runtime.env、数据及 Node 镜像，不执行 down/remove-orphans 或删除历史快照。兼容入口依赖当前 server.js/registry 等 fnOS 只读保护及 shell-ui/runtime-notice.js；这些既有业务改动需独立审阅，不能只提交 deploy 目录便声称完整只读发布已可重现。

公开模板仅使用示例路径和回环地址。实际磁盘、工作区、容器逻辑根和绑定地址只填入忽略的私有 paths.fnos.env；复用原实例时必须保持原映射，不能把示例直接当作现场值。stop/status 不加载此文件，因此需由命令环境明确传入 COCKPIT_CONTAINER_ROOT，继续与已核对的名称、项目/服务标签、宿主根及Compose来源共同精确校验。缺少或不匹配时拒绝操作；应急副本另传 COCKPIT_HOST_ROOT。
