# Changelog

## 2026-10-19

- 建立独立源码基线，旧仓库历史留在原仓库。
- 分离本地配置、提供脱敏示例与不会覆盖现有文件的初始化脚本。
- 新增暂存区与拟推送完整历史的隐私门禁、pre-push hook 和回归测试。
- 整理中文项目说明、部署模板与 GitHub About。


## 2026-10-26 fnOS entry candidate (not activated)

- Add independent fnOS path template and guarded prepare/check/start. Validate the disk and path boundary before directory creation; reuse the prepared snapshot on start.
- Stop/status validate the existing cockpit container and act on its full ID without private env or mounted data. Keep Compose project leon-cockpit-7001, restart:no, and the pinned Node image.
- Offline launcher tests cover foreign identity, ambiguous IDs, Docker failures and missing disk. This entry-only candidate requires the separately reviewed read-only application integration before release.
