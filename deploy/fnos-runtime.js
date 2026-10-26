'use strict';
// Opt-in Docker boundary only; Debian behavior is unchanged.
const status = {
  mode: 'fnos-read-only',
  hostManagement: 'unavailable',
  personalData: 'not-mounted',
  backgroundRecovery: 'disabled',
  notice: 'fnOS 只读查看：未接入个人配置、机器人/模型/技能数据；恢复与宿主管理不可用，进程和应用清单仅代表容器，内存总量来自共享内核。'
};
function middleware(enabled) {
  return (req, res, next) => {
    if (!enabled) return next();
    if (req.path === '/api/runtime' && req.method === 'GET') return res.json(status);
    // Config-center read handlers can initialize tracker DB schema.
    // No DB, provider test, service action, share creation, or data mutation is permitted.
    const unavailable = req.path.startsWith('/apps/config-recovery/api/') ||
      req.path.startsWith('/apps/workspace-rule-panel/api/') ||
      req.path.startsWith('/api/hermes') ||
      req.path.includes('/api/cliproxy-models') ||
      req.path === '/apps/file-manager/share' ||
      /\/(?:test[^/]*|check-model|probe|recover|restart|start|stop|kill|download|export)(?:\/|$)/i.test(req.path);
    if (unavailable || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(503).json({ ok: false, code: 'FNOS_READ_ONLY_UNAVAILABLE', error: status.notice });
    }
    return next();
  };
}
module.exports = { status, middleware };
