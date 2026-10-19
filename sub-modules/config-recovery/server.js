const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { handleRequest } = require('./routes');

const PORT = process.env.PORT || 17151;
const HOST = '0.0.0.0';
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'shell-ui', 'modules', 'config-recovery');
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.join(os.homedir(), '.openclaw');
const CONFIG_FILE = path.join(OPENCLAW_ROOT, 'openclaw.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const RECOVERY_FILE = path.join(OPENCLAW_ROOT, 'config-recovery.json');
const LOG_FILE = path.join(OPENCLAW_ROOT, 'logs', 'recovery.log');

const PATROL_INTERVAL_MS = 30 * 60 * 1000;
const PATROL_START_DELAY_MS = 5 * 60 * 1000;

function validateConfig() {
  const result = { valid: true, errors: [] };

  if (!fs.existsSync(CONFIG_FILE)) {
    result.valid = false;
    result.errors.push('配置文件不存在');
    return result;
  }

  const stat = fs.statSync(CONFIG_FILE);
  if (stat.size === 0) {
    result.valid = false;
    result.errors.push('配置文件为空');
    return result;
  }

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    result.valid = false;
    result.errors.push('无法读取配置文件: ' + e.message);
    return result;
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    result.valid = false;
    result.errors.push('JSON 格式错误: ' + e.message);
    return result;
  }

  const requiredFields = ['agents', 'channels'];
  for (const field of requiredFields) {
    if (!(field in obj)) {
      result.valid = false;
      result.errors.push('缺少字段: ' + field);
    }
  }

  return result;
}

function findLatestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('openclaw-config-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(BACKUP_DIR, files[0]) : null;
}

function autoRecover() {
  const validation = validateConfig();
  if (validation.valid) return;

  console.log(`[patrol] 配置校验失败: ${validation.errors.join(', ')}`);

  const latestBackup = findLatestBackup();
  if (!latestBackup) {
    console.log('[patrol] 无可用备份，恢复失败');
    writeRecoveryStatus('failed', 'no_backup_found', null);
    notifyRecovery();
    return;
  }

  const clobberedFile = CONFIG_FILE + '.clobbered.' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(CONFIG_FILE, clobberedFile);
      console.log(`[patrol] 损坏配置已保存: ${clobberedFile}`);
    }
  } catch {}

  try {
    fs.copyFileSync(latestBackup, CONFIG_FILE);
    console.log(`[patrol] 配置已恢复: ${latestBackup}`);
  } catch (e) {
    console.log(`[patrol] 恢复失败: ${e.message}`);
    writeRecoveryStatus('failed', 'copy_failed', latestBackup);
    notifyRecovery();
    return;
  }

  const recheck = validateConfig();
  if (recheck.valid) {
    console.log('[patrol] 恢复后校验通过');
    writeRecoveryStatus('recovered', 'auto_recovery', latestBackup);
  } else {
    console.log('[patrol] 恢复后校验仍失败: ' + recheck.errors.join(', '));
    writeRecoveryStatus('failed', 'backup_also_corrupt', latestBackup);
  }

  notifyRecovery();
}

function writeRecoveryStatus(status, reason, backupFile) {
  const data = {
    status,
    time: new Date().toISOString(),
    reason,
    backup_file: backupFile
  };
  try {
    fs.writeFileSync(RECOVERY_FILE, JSON.stringify(data, null, 2));
  } catch {}
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] 配置恢复: status=${status}, reason=${reason}\n`);
  } catch {}
}

function notifyRecovery() {
  try {
    execSync(`python3 ${OPENCLAW_ROOT}/scripts/notify-recovery.py`, { timeout: 15000 });
  } catch (e) {
    console.log('[patrol] 飞书通知失败:', e.message);
  }
}

let _patrolTimer = null;
let _patrolStartTimer = null;

function startPatrol() {
  console.log(`[patrol] 自动巡检将在 ${PATROL_START_DELAY_MS / 1000}s 后启动，间隔 ${PATROL_INTERVAL_MS / 60000}min`);
  _patrolStartTimer = setTimeout(() => {
    console.log('[patrol] 首次巡检...');
    autoRecover();
    _patrolTimer = setInterval(() => {
      console.log('[patrol] 定时巡检...');
      autoRecover();
    }, PATROL_INTERVAL_MS);
    if (typeof _patrolTimer.unref === 'function') _patrolTimer.unref();
  }, PATROL_START_DELAY_MS);
  if (typeof _patrolStartTimer.unref === 'function') _patrolStartTimer.unref();
}

function stopPatrol() {
  if (_patrolStartTimer) { clearTimeout(_patrolStartTimer); _patrolStartTimer = null; }
  if (_patrolTimer) { clearInterval(_patrolTimer); _patrolTimer = null; }
}

async function init() {
  startPatrol();
}

async function dispose() {
  stopPatrol();
}

function healthFn() {
  return true;
}

const server = http.createServer(handler);

function handler(req, res) {
  const url = req.url.replace(/\?.*$/, '');

  if (url === '/' || url === '/index.html') {
    if (handleRequest({ ...req, url: '/api/config-center/page' }, res)) return;
  }

  if (url === '/api/config-center/patrol/validate' && req.method === 'GET') {
    const result = validateConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...result }));
    return;
  }

  if (url === '/api/config-center/patrol/recover' && req.method === 'POST') {
    autoRecover();
    let status = {};
    try { status = JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, status }));
    return;
  }

  if (url === '/api/config-center/patrol/status' && req.method === 'GET') {
    let status = {};
    try { status = JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      patrolRunning: !!_patrolTimer,
      intervalMinutes: PATROL_INTERVAL_MS / 60000,
      lastStatus: status
    }));
    return;
  }

  if (url === '/api/config-center/patrol/check' && req.method === 'GET') {
    let status = {};
    try { status = JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); } catch {}
    const code = status.status === 'ok' ? 0 : status.status === 'recovered' ? 1 : status.status === 'failed' ? 2 : 3;
    const messages = { ok: 'OK - 配置状态正常', recovered: 'RECOVERED - 配置已自动恢复', failed: 'FAILED - 配置恢复失败' };
    if (status.status === 'recovered' || status.status === 'failed') {
      notifyRecovery();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      code,
      status: status.status || 'unknown',
      message: messages[status.status] || 'UNKNOWN - 未知状态',
      detail: status
    }));
    return;
  }

  if (url === '/api/config-center/patrol/reset' && req.method === 'POST') {
    writeRecoveryStatus('ok', null, null);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: '配置恢复状态已重置为 ok' }));
    return;
  }

  if (handleRequest(req, res)) return;
  if (url.startsWith('/public/') || url === '/config-center-embed.html') {
    const filePath = path.join(FRONTEND_DIR, path.basename(url));
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'text/plain';
      try {
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
        res.end(fs.readFileSync(filePath, 'utf8'));
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Read error');
      }
      return;
    }
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, patrol: !!_patrolTimer }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

process.on('unhandledRejection', (reason) => {
  console.error('[config-recovery] Unhandled rejection:', reason);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[config-recovery] listening on http://${HOST}:${PORT}`);
    init();
  });
}

module.exports = {
  handler,
  init,
  dispose,
  healthFn,
  capabilities: ['timer'],
};
