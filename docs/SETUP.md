# 安装与本地配置

1. 按 README 安装 Node、Python、Git 与必要编译工具，使用 npm ci 安装锁定依赖。
2. 运行 python3 scripts/setup-local-config.py，根据示例生成缺失的 config.json。脚本不覆盖已有文件，不启动服务。
3. 本地私有配置权限为 0600。检查目录、端口和 OpenClaw 安装位置。示例中的 HOME 与 PROJECT_ROOT 占位符由初始化脚本展开。
4. 配置恢复的 AI 字段映射需要单独填写 sub-modules/config-recovery/provider.local.json。没有连接信息时，不执行此功能；不要将真实值写进源码。
5. 软件管理模块的本机 registry 文件留在本地，不能通过 Git 复制另一台机器的服务控制清单。
6. 复制并核对 deploy/openclaw-cockpit-shell.service.example。模板假设源码位于用户 workspace 下，ExecStart 中的 Node 路径必须与实际安装一致。
7. 只手动 start 用户服务。模板不自动 enable，也不安装 cron、定时重启或其他常驻任务。

## 验证

~~~sh
curl -f http://127.0.0.1:7001/health
curl -f http://127.0.0.1:7001/api/apps
curl -f http://127.0.0.1:7001/api/apps/health
~~~

随后在浏览器确认导航、主题及实际模块页面。健康接口可用不等于所有管理操作、模型连接或数据库恢复已完成验证。

升级时保留本地 config.json、provider.local.json、data、backups、tracker 和本机 registry；这些文件不在 Git 中。恢复数据前先确认版本、权限与一致性，不覆盖正在写入的运行数据。
