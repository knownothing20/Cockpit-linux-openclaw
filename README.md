# Cockpit Linux for OpenClaw

面向 Linux 的 OpenClaw 模块化管理面板。在一个网页中查看应用、资源、文件、工作区规则、配置恢复、Agent、技能与模型。

Cockpit 由 Node.js 主进程统一加载模块，提供导航、主题、健康状态和模块间代理。适合已有 OpenClaw 环境的个人服务器与可信局域网管理。

## 功能

| 模块 | 用途 |
| --- | --- |
| 应用管理 | 发现本机软件、查看服务与容器状态，并按已有权限执行管理操作 |
| 内存监控 | 查看内存统计、进程分组和占用情况 |
| 文件管理 | 浏览本地文件、查看文本内容及已有文件管理入口 |
| 工作区规则 | 检查工作区文档、规则与项目约定 |
| 配置恢复 | 本地备份、配置编辑、变更追踪与恢复入口 |
| Agent 管理 | 查看和管理 OpenClaw Agent 相关配置 |
| 技能管理 | 查看技能、审计与维护已有技能工作区 |
| 模型管理 | 模型配置、使用统计与连接测试入口 |

管理、恢复、进程终止、配置写入和模型测试都是实际操作，应按需手动执行。界面中出现入口不代表当前账户已具备对应系统权限。

## 架构与目录

~~~text
server.js                   主入口，固定端口 7001
shell-ui/                   导航、主题和模块页面
registry/                   模块注册、加载、代理与健康检查
sub-modules/                模块实现
config.example.json         可公开的配置示例
scripts/check-privacy.py    离线 Git 隐私检查
.githooks/pre-push          Git 推送前检查
docs/                      安装与隐私说明
~~~

本地 config.json、provider.local.json、软件注册表、data、backups 和 tracker 不进入版本库。它们与源码分开管理，Git 不是这些运行数据的备份。

## 环境

- Linux，带 systemd 用户会话。
- 本次迁移在 Node.js 24.21.0 上验证；请使用与原生依赖兼容的 Node 版本。
- Python 3、Git、npm。
- 安装 better-sqlite3 等原生依赖时，可能需要 Python、make 和 C/C++ 编译工具。
- 已有 OpenClaw 安装及本机配置；部分功能还会读取 Hermes、systemd、Docker 或其他本地组件。

仓库提供源码与配置示例，不包含账号、真实数据、浏览器状态或本机软件清单。fnOS、容器权限适配及不同发行版尚需分别验证。

## 安装与手动启动

~~~sh
mkdir -p "$HOME/workspace"
cd "$HOME/workspace"
git clone https://github.com/knownothing20/Cockpit-linux-openclaw.git
cd Cockpit-linux-openclaw
npm ci
python3 scripts/setup-local-config.py
sh scripts/install-privacy-hook.sh
~~~

初始化脚本只创建缺失的本地配置，不覆盖已有配置。请先检查生成的文件，设置本机目录与需要的集成。模型网关的连接信息只填写到配置恢复模块的 provider.local.json，默认不提供凭据。

使用 deploy/openclaw-cockpit-shell.service.example 作为用户服务模板，核对源码目录、Node 的绝对路径和本机权限后，将它保存为用户服务 openclaw-cockpit-shell.service。再执行：

~~~sh
systemctl --user daemon-reload
systemctl --user start openclaw-cockpit-shell.service
~~~

访问 http://127.0.0.1:7001 。7001 固定使用，冲突时应先排查占用，不启动第二份进程，也不改用随机端口。

以上步骤不启用开机自启。日常开启与关闭：

~~~sh
systemctl --user start openclaw-cockpit-shell.service
systemctl --user stop openclaw-cockpit-shell.service
systemctl --user status openclaw-cockpit-shell.service
~~~

更详细的配置步骤见 [安装说明](docs/SETUP.md)。

## 开发与隐私检查

~~~sh
python3 scripts/check-privacy.py --staged
python3 scripts/check-privacy.py --history
python3 -B tests/test_privacy_gate.py
~~~

安装 hook 后，正常 git push 会自动检查暂存区及拟推送引用的完整可达提交树、提交身份和标签信息。发现问题返回非零状态，阻止此次推送，只报告路径、位置和类型，不输出敏感内容。

检查覆盖常见密钥、短格式 Bearer Token、私钥、凭据 URL、个人邮箱、个人目录、内网地址、私有运行文件、符号链接及未审查的二进制文件；支持带 BOM 的 UTF-16/UTF-32 文本。详细规则见 [隐私说明](docs/PRIVACY.md)。

这是本地启发式检查，不能保证发现全部秘密。Git hook 需要每个克隆单独安装，也可以被绕过；检查通过不能替代发布前人工审查。

## 数据与稳定性

- 源码、依赖锁文件和本地运行数据分开管理，更新源码前先保护本地配置与数据。
- 不将旧 OpenClaw 仓库历史导入本仓库，避免携带过去的配置备份和凭据。
- 使用 npm ci 按锁文件安装；本仓库没有自动升级依赖或自动重启任务。
- 配置恢复模块的 SQLite 原生扩展加载状态与 HTTP 健康状态不同，必要时查看本机日志；既有 JSON 回退路径不等于原生 SQLite 已通过验证。
- 服务会以当前用户权限操作主机。仅在可信环境部署，并自行设置访问控制和网络边界。
- 不提供整盘恢复、数据库迁移或 fnOS 内存容量保证。

## 项目状态

当前是从已有 Linux 运行环境整理出的独立源码基线。已加入配置示例、手动启动说明、推送前隐私检查与回归测试；更多平台的全新安装与宿主管理权限需要继续验证。
