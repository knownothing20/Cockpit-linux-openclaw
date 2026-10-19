'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = process.env.FILE_MANAGER_PORT || 8200;
const HOST = process.env.FILE_MANAGER_HOST || '0.0.0.0';
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_FILE_BODY = 2 * 1024 * 1024; // 2MB

function isPathAllowed(targetPath) {
  const resolved = path.resolve(targetPath);
  const allowedRoots = [
    OPENCLAW_DIR,
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'software'),
  ];
  return allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

let _agentDirCache = null;
let _agentDirCacheTime = 0;
const AGENT_DIR_CACHE_TTL = 5000;

function getAgentDirData() {
  const now = Date.now();
  if (_agentDirCache && (now - _agentDirCacheTime) < AGENT_DIR_CACHE_TTL) {
    return _agentDirCache;
  }
  const agentDirPath = getAgentDirPath();
  if (!fs.existsSync(agentDirPath)) {
    _agentDirCache = null;
    _agentDirCacheTime = now;
    return null;
  }
  try {
    _agentDirCache = JSON.parse(fs.readFileSync(agentDirPath, 'utf8'));
    _agentDirCacheTime = now;
    return _agentDirCache;
  } catch (e) {
    _agentDirCache = null;
    _agentDirCacheTime = now;
    return null;
  }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowed = [
    'http://localhost:7000',
    'http://127.0.0.1:7000',
    'http://localhost:7001',
    'http://127.0.0.1:7001',
    'http://localhost:8200',
    'http://127.0.0.1:8200',
  ];
  const allowOrigin = allowed.includes(origin) ? origin : (origin ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function serveStaticFile(filePath, res) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': contentType };
  if (ext === 'css' || ext === 'js') {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'FILE_READ_ERROR' }));
  });
  stream.pipe(res);
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getAgentDirPath() {
  return path.join(OPENCLAW_DIR, 'workspace-hr', 'AGENT_DIRECTORY.json');
}

function getAgentWorkspace(agentId) {
  const dirData = getAgentDirData();
  if (!dirData) return null;
  const agent = (dirData.agents || []).find(a => a.agentId === agentId);
  return agent?.workspace || null;
}

// ── Route Handlers ──

function handleFilesCategories(req, res) {
  try {
    const categories = [];
    if (fs.existsSync(OPENCLAW_DIR)) {
      const items = fs.readdirSync(OPENCLAW_DIR, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.')) {
          categories.push(item.name);
        }
      }
    }
    jsonResponse(res, 200, { categories });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleFilesSubfolders(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const category = urlObj.searchParams.get('category') || '';
    const subfolders = [];
    let targetPath = OPENCLAW_DIR;
    if (category && category !== 'root') {
      targetPath = path.join(targetPath, category);
    }
    if (fs.existsSync(targetPath)) {
      const items = fs.readdirSync(targetPath, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.')) {
          subfolders.push(item.name);
        }
      }
    }
    jsonResponse(res, 200, { subfolders });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleFilesList(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const category = urlObj.searchParams.get('category') || '';
    const subfolder = urlObj.searchParams.get('subfolder') || '';
    const folder = urlObj.searchParams.get('folder') || '';

    let targetPath = OPENCLAW_DIR;
    if (category && category !== 'root') {
      targetPath = path.join(targetPath, category);
    }
    if (subfolder) {
      targetPath = path.join(targetPath, subfolder);
    }
    if (folder) {
      targetPath = path.join(targetPath, folder);
    }

    if (!targetPath.startsWith(OPENCLAW_DIR) || !fs.existsSync(targetPath)) {
      jsonResponse(res, 200, { files: [] });
      return;
    }

    const files = [];
    const items = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const itemPath = path.join(targetPath, item.name);
      const stat = fs.statSync(itemPath);
      files.push({
        name: item.name,
        isDirectory: item.isDirectory(),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    jsonResponse(res, 200, { files });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleFilesRead(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const category = urlObj.searchParams.get('category') || '';
    const subfolder = urlObj.searchParams.get('subfolder') || '';
    const folder = urlObj.searchParams.get('folder') || '';
    const file = urlObj.searchParams.get('file') || '';

    let targetPath = OPENCLAW_DIR;
    if (category && category !== 'root') {
      targetPath = path.join(targetPath, category);
    }
    if (subfolder) {
      targetPath = path.join(targetPath, subfolder);
    }
    if (folder) {
      targetPath = path.join(targetPath, folder);
    }
    targetPath = path.join(targetPath, file);

    if (!targetPath.startsWith(OPENCLAW_DIR) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      jsonResponse(res, 404, { error: 'File not found' });
      return;
    }

    const stat = fs.statSync(targetPath);
    if (stat.size > MAX_FILE_SIZE) {
      jsonResponse(res, 200, { content: '[文件太大，超过 1MB]' });
      return;
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    jsonResponse(res, 200, { content });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleFilesSave(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { category, subfolder, folder, file: fileName, content } = JSON.parse(body || '{}');
      if (!fileName) {
        jsonResponse(res, 400, { error: 'No file provided' });
        return;
      }

      let targetPath = OPENCLAW_DIR;
      if (category && category !== 'root') {
        targetPath = path.join(targetPath, category);
      }
      if (subfolder) {
        targetPath = path.join(targetPath, subfolder);
      }
      if (folder) {
        targetPath = path.join(targetPath, folder);
      }
      targetPath = path.join(targetPath, fileName);

      if (!targetPath.startsWith(OPENCLAW_DIR)) {
        jsonResponse(res, 403, { error: 'Access denied' });
        return;
      }
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        jsonResponse(res, 400, { error: 'Cannot save to directory' });
        return;
      }

      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      if (fs.existsSync(targetPath)) {
        try { fs.copyFileSync(targetPath, targetPath + '.bak'); } catch {}
      }
      fs.writeFileSync(targetPath, content, 'utf8');
      jsonResponse(res, 200, { success: true });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  });
}

function handleAgentWorkspaces(req, res) {
  try {
    const agents = [];
    const dirData = getAgentDirData();
    if (dirData && dirData.agents && Array.isArray(dirData.agents)) {
      for (const agent of dirData.agents) {
        if (agent.workspace && fs.existsSync(agent.workspace)) {
          agents.push({
            agentId: agent.agentId,
            displayName: agent.displayName || agent.agentId,
            nickname: agent.nickname || '',
            workspace: agent.workspace,
            department: agent.department || '',
          });
        }
      }
    }
    jsonResponse(res, 200, agents);
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleAgentFiles(req, res) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const agentId = params.get('agent') || '';
    if (!agentId) {
      jsonResponse(res, 400, { error: 'Missing agent parameter' });
      return;
    }

    const workspace = getAgentWorkspace(agentId);
    if (!workspace) {
      jsonResponse(res, 404, { error: 'Agent not found or no workspace' });
      return;
    }

    const items = [];
    const allowedExts = ['.md', '.json', '.txt', '.js', '.ts', '.py', '.sh', '.yaml', '.yml', '.html', '.css'];
    const skipDirs = ['node_modules', '.git', '__pycache__', '.cache', 'sessions', '.venv', 'venv', 'dist', 'build'];

    const folderParam = params.get('folder') || '/';
    const targetPath = folderParam === '/' ? workspace : path.join(workspace, folderParam);

    const resolvedWorkspace = path.resolve(workspace);
    const resolvedTarget = path.resolve(targetPath);
    if (!resolvedTarget.startsWith(resolvedWorkspace)) {
      jsonResponse(res, 403, { error: 'Access denied' });
      return;
    }

    function pushFileItem(fullPath, name) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size < 1024 * 1024) {
          items.push({ type: 'file', name, modified: stat.mtimeMs, size: stat.size, editable: true });
        }
      } catch {}
    }

    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(targetPath, entry.name);
          if (entry.isDirectory()) {
            if (!skipDirs.includes(entry.name) && !entry.name.startsWith('.')) {
              items.push({ type: 'folder', name: entry.name, folder: entry.name, modified: 0, size: 0, editable: false });
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (allowedExts.includes(ext) || entry.name.startsWith('.')) {
              const relativeName = folderParam === '/' ? entry.name : `${folderParam}/${entry.name}`;
              pushFileItem(fullPath, relativeName);
            }
          }
        }
      } else {
        if (stat.size < 1024 * 1024) {
          items.push({ type: 'file', name: folderParam, modified: stat.mtimeMs, size: stat.size, editable: true });
        }
      }
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    jsonResponse(res, 200, items);
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleAgentFileGet(req, res) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const agentId = params.get('agent') || '';
    const filePath = params.get('path') || '';
    if (!agentId || !filePath) {
      jsonResponse(res, 400, { error: 'Missing agent or path parameter' });
      return;
    }

    const workspace = getAgentWorkspace(agentId);
    if (!workspace) {
      jsonResponse(res, 404, { error: 'Agent not found' });
      return;
    }

    const workspacePath = path.resolve(workspace);
    const fullPath = path.resolve(workspace, filePath);
    if (!fullPath.startsWith(workspacePath)) {
      jsonResponse(res, 403, { error: 'Access denied' });
      return;
    }
    if (!fs.existsSync(fullPath)) {
      jsonResponse(res, 404, { error: 'File not found' });
      return;
    }
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) {
      jsonResponse(res, 413, { error: 'File too large (max 1MB)' });
      return;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(content);
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

function handleAgentFilePost(req, res) {
  let body = '';
  let overflow = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_FILE_BODY) { overflow = true; req.destroy(); }
  });
  req.on('end', () => {
    if (overflow) {
      jsonResponse(res, 413, { error: 'Payload too large (max 2MB)' });
      return;
    }
    try {
      const { agent: agentId, path: filePath, content } = JSON.parse(body);
      if (!agentId || !filePath || typeof content !== 'string') {
        jsonResponse(res, 400, { error: 'Invalid request body' });
        return;
      }

      const workspace = getAgentWorkspace(agentId);
      if (!workspace) {
        jsonResponse(res, 404, { error: 'Agent not found' });
        return;
      }

      const workspacePath = path.resolve(workspace);
      const fullPath = path.resolve(workspace, filePath);
      if (!fullPath.startsWith(workspacePath)) {
        jsonResponse(res, 403, { error: 'Access denied' });
        return;
      }

      try {
        if (fs.existsSync(fullPath)) {
          fs.copyFileSync(fullPath, fullPath + '.bak');
        }
      } catch {}
      const tmp = fullPath + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, fullPath);
      jsonResponse(res, 200, { success: true });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  });
}

function handleMemoryFile(req, res) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const fname = params.get('path') || '';
    const agent = params.get('agent') || '';

    let workspaceDir = getAgentWorkspace(agent) || path.join(OPENCLAW_DIR, 'workspace-' + agent);
    if (!fs.existsSync(workspaceDir)) {
      workspaceDir = path.join(OPENCLAW_DIR, 'workspace-cto');
    }

    let fpath = '';
    if (fname === 'MEMORY.md') fpath = path.join(workspaceDir, 'MEMORY.md');
    else if (fname === 'HEARTBEAT.md') fpath = path.join(workspaceDir, 'HEARTBEAT.md');
    else if (fname.startsWith('memory/') && !fname.includes('..')) fpath = path.join(workspaceDir, fname);
    else throw new Error('Invalid path');

    if (fs.existsSync(fpath)) {
      const content = fs.readFileSync(fpath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
  }
}

function handleDocsStats(req, res) {
  try {
    const openclawDir = OPENCLAW_DIR;
    const categoryRules = [
      { prefix: 'TASK-', name: '任务系统', files: [] },
      { prefix: 'PHASE', name: '阶段记录', files: [] },
      { prefix: 'AGENT-', name: 'Agent 协作', files: [] },
      { prefix: 'INTEGRATION-', name: '集成相关', files: [] },
      { prefix: 'SECURITY-', name: '安全相关', files: [] },
      { prefix: 'API-', name: 'API 设计', files: [] },
      { prefix: 'feishu-', name: '飞书相关', files: [] },
    ];

    const docs = {
      mainDocs: { count: 0, categories: [], path: 'workspace-main/docs/' },
      memory: { count: 0, path: 'workspace-main/memory/' },
      sharedRules: { count: 0, path: 'workspace-main/docs/shared-rules/' },
      workspaces: [],
      software: [],
      total: 0,
    };

    const mainDocsDir = path.join(openclawDir, 'workspace-main/docs');
    if (fs.existsSync(mainDocsDir)) {
      const allFiles = fs.readdirSync(mainDocsDir).filter(f => f.endsWith('.md'));
      docs.mainDocs.count = allFiles.length;
      allFiles.forEach(file => {
        let matched = false;
        categoryRules.forEach(cat => {
          if (file.startsWith(cat.prefix)) {
            cat.files.push(file);
            matched = true;
          }
        });
        if (!matched) {
          const otherCat = categoryRules.find(c => c.name === '其他');
          if (!otherCat) {
            categoryRules.push({ prefix: '', name: '其他', files: [file] });
          } else {
            otherCat.files.push(file);
          }
        }
      });
      docs.mainDocs.categories = categoryRules.filter(c => c.files.length > 0).map(c => ({
        name: c.name, count: c.files.length, files: c.files,
      }));
    }

    const memoryDir = path.join(openclawDir, 'workspace-main/memory');
    if (fs.existsSync(memoryDir)) {
      docs.memory.count = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).length;
    }

    const sharedDir = path.join(openclawDir, 'workspace-main/docs/shared-rules');
    if (fs.existsSync(sharedDir)) {
      docs.sharedRules.count = fs.readdirSync(sharedDir).filter(f => f.endsWith('.md')).length;
    }

    const workspaces = fs.readdirSync(openclawDir).filter(d => d.startsWith('workspace-'));
    workspaces.forEach(ws => {
      const wsPath = path.join(openclawDir, ws);
      const mdFiles = fs.readdirSync(wsPath).filter(f => f.endsWith('.md'));
      docs.workspaces.push({ name: ws.replace('workspace-', ''), count: mdFiles.length, files: mdFiles });
    });

    const softwareDir = path.join(openclawDir, 'software');
    if (fs.existsSync(softwareDir)) {
      const software = fs.readdirSync(softwareDir).filter(d => {
        try { return fs.statSync(path.join(softwareDir, d)).isDirectory(); } catch { return false; }
      });
      software.forEach(sw => {
        const swPath = path.join(softwareDir, sw);
        const whitepaper = path.join(swPath, 'WHITEPAPER.md');
        const readme = path.join(swPath, 'README.md');
        const pkgFile = path.join(swPath, 'package.json');
        const allDocs = fs.readdirSync(swPath).filter(f => f.endsWith('.md'));
        let requiresSetup = false;
        if (fs.existsSync(pkgFile)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            requiresSetup = pkg._status === 'requires_setup';
          } catch {}
        }
        docs.software.push({
          name: sw, hasWhitepaper: fs.existsSync(whitepaper), hasReadme: fs.existsSync(readme),
          hasDoc: fs.existsSync(whitepaper) || fs.existsSync(readme), docCount: allDocs.length,
          docs: allDocs, requiresSetup,
        });
      });
    }

    docs.total = docs.mainDocs.count + docs.memory.count + docs.sharedRules.count +
                 docs.workspaces.reduce((sum, ws) => sum + ws.count, 0);
    jsonResponse(res, 200, docs);
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}


// ── HTTP Share Helpers (migrated from http-share-service) ──

// v2.3.109: ROOT_SYSTEM_DIRS 黑名单取消. 之前 (v2.3.106) 把 boot/dev/etc/proc/sys/run/var/tmp/srv/opt/usr 等都隐藏了, 用户反馈 "之前有很多文件夹的", 觉得功能被砍. 实际上后端 handleShareBrowse 已经用 try/catch 包裹 statSync 跟 readdirSync, 遇到 EACCES / ENOENT 时单条跳过, 整体 EACCES 返回空列表 + 友好 error, 不会 500 报错. 不需要前端再黑名单过滤, 让所有目录都显示出来.
// 保留 ROOT_SYSTEM_DIRS 这个常量名字, 方便以后需要时再加白/黑名单.
const ROOT_SYSTEM_DIRS = new Set([
  // 故意留空, 全部目录都显示.
]);

function isReadableDir(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

const SHARE_CONFIG_PATH = path.join(__dirname, '..', 'share-config.json');
let shareConfig = {
  uploadDir: '/tmp/http-share-uploads',
  sharesFile: '/tmp/http-shares.json',
  cleanupInterval: 60,
  defaultExpiry: 10,
  maxUploadSize: 1024 * 1024 * 1024,
};
try {
  if (fs.existsSync(SHARE_CONFIG_PATH)) {
    shareConfig = { ...shareConfig, ...JSON.parse(fs.readFileSync(SHARE_CONFIG_PATH, 'utf8')) };
  }
} catch (e) {
  console.error('[file-manager] failed to load share config:', e.message);
}

const SHARE_UPLOAD_DIR = shareConfig.uploadDir;
const SHARES_FILE = shareConfig.sharesFile;
const SHARE_CLEANUP_INTERVAL = shareConfig.cleanupInterval * 1000;
const SHARE_MAX_UPLOAD_SIZE = shareConfig.maxUploadSize;

try {
  if (!fs.existsSync(SHARE_UPLOAD_DIR)) fs.mkdirSync(SHARE_UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(SHARES_FILE)) fs.writeFileSync(SHARES_FILE, JSON.stringify({ shares: [] }, null, 2));
} catch (e) {
  console.error('[file-manager] failed to init share storage:', e.message);
}

let isWritingShares = false;
let shareWriteQueue = [];
function withShareLock(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      if (isWritingShares) {
        shareWriteQueue.push(task);
        return;
      }
      isWritingShares = true;
      Promise.resolve()
        .then(fn)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          isWritingShares = false;
          const next = shareWriteQueue.shift();
          if (next) next();
        });
    };
    task();
  });
}

function getLocalIP() {
  if (process.env.SHARE_IP) return process.env.SHARE_IP;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && (iface.address.startsWith('192.168.') || iface.address.startsWith('10.'))) {
        return iface.address;
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function getShareBasePath(req) {
  const originalUrl = req.originalUrl || req.url || '';
  return originalUrl.startsWith('/apps/file-manager') ? '/apps/file-manager' : '';
}

function getShareUrl(req, token) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `${getLocalIP()}:${PORT}`;
  return `${proto}://${host}${getShareBasePath(req)}/d/${token}`;
}

function readShares() {
  try {
    if (!fs.existsSync(SHARES_FILE)) return { shares: [] };
    const data = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
    if (!Array.isArray(data.shares)) return { shares: [] };
    return data;
  } catch (e) {
    console.error('[file-manager] read shares failed:', e.message);
    return { shares: [] };
  }
}

function writeShares(data) {
  return withShareLock(() => {
    fs.writeFileSync(SHARES_FILE, JSON.stringify(data, null, 2));
  });
}

function appendShare(share) {
  const data = readShares();
  data.shares.push(share);
  return writeShares(data);
}

function cleanupExpiredShares() {
  const data = readShares();
  const now = new Date();
  const active = [];
  let removed = 0;
  for (const share of data.shares) {
    if (new Date(share.expiresAt) > now) {
      active.push(share);
    } else {
      removed += 1;
      if (share.isTempZip && share.path && fs.existsSync(share.path)) {
        try { fs.unlinkSync(share.path); } catch {}
      }
    }
  }
  if (removed > 0) {
    data.shares = active;
    writeShares(data).catch(e => console.error('[file-manager] cleanup shares failed:', e.message));
  }
}
let cleanupTimer = null;

function startCleanup() {
  cleanupTimer = setInterval(cleanupExpiredShares, SHARE_CLEANUP_INTERVAL);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

async function init() {
  startCleanup();
}

async function dispose() {
  stopCleanup();
}

function healthFn() {
  return true;
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function zipPaths(paths, outputPath) {
  return new Promise((resolve, reject) => {
    let scriptPath;
    try {
      const script = `import zipfile, os, sys
out = sys.argv[1]
paths = sys.argv[2:]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for p in paths:
        if os.path.isdir(p):
            base = os.path.dirname(p)
            for r, d, fs in os.walk(p):
                for f in fs:
                    fp = os.path.join(r, f)
                    zf.write(fp, os.path.relpath(fp, base))
        else:
            zf.write(p, os.path.basename(p))
`;
      scriptPath = `/tmp/zip-${Date.now()}-${Math.random().toString(16).slice(2)}.py`;
      fs.writeFileSync(scriptPath, script);
    } catch (e) {
      return reject(e);
    }
    const pathArgs = paths.map(p => `"${String(p).replace(/"/g, '\\"')}"`).join(' ');
    exec(`python3 "${scriptPath}" "${String(outputPath).replace(/"/g, '\\"')}" ${pathArgs}`, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(scriptPath); } catch (e) {}
      if (err) {
        console.error('[file-manager] zip failed:', err.message);
        return reject(err);
      }
      resolve();
    });
  });
}

function getShareMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  }[ext] || 'application/octet-stream';
}

function parseMultipart(req, callback) {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('multipart/form-data')) return callback(new Error('Invalid content type'));
  const boundary = contentType.split('boundary=')[1];
  if (!boundary) return callback(new Error('No boundary found'));
  let body = Buffer.alloc(0);
  req.on('data', chunk => {
    body = Buffer.concat([body, chunk]);
    if (body.length > SHARE_MAX_UPLOAD_SIZE) {
      callback(new Error('File too large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    const parts = [];
    const boundaryBuffer = Buffer.from('--' + boundary);
    let start = body.indexOf(boundaryBuffer);
    while (start !== -1) {
      const end = body.indexOf(boundaryBuffer, start + boundaryBuffer.length);
      if (end === -1) break;
      const part = body.slice(start + boundaryBuffer.length, end);
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = part.slice(0, headerEnd).toString();
        const data = part.slice(headerEnd + 4);
        const cleanData = data.slice(0, Math.max(0, data.length - 2));
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        parts.push({ name: nameMatch ? nameMatch[1] : null, filename: filenameMatch ? filenameMatch[1] : null, data: cleanData });
      }
      start = end;
    }
    callback(null, parts);
  });
}

function sendSharedFile(req, res, share) {
  if (!share || new Date(share.expiresAt) < new Date()) {
    res.writeHead(share ? 410 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(share ? 'Share has expired' : 'Share not found or expired');
    return;
  }
  if (!fs.existsSync(share.path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found');
    return;
  }
  const stat = fs.statSync(share.path);
  const filename = path.basename(share.originalPath || share.path);
  const downloadName = share.isDirectory ? `${filename}.zip` : filename;
  res.writeHead(200, {
    'Content-Type': getShareMimeType(share.path),
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`
  });
  const stream = fs.createReadStream(share.path);
  stream.pipe(res);
  stream.on('error', err => {
    console.error('[file-manager] share stream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error reading file');
    }
  });
  if (share.isTempZip) {
    stream.on('close', () => setTimeout(() => {
      try { if (fs.existsSync(share.path)) fs.unlinkSync(share.path); } catch {}
    }, 5000));
  }
}

function handleShareRecent(req, res) {
  const now = new Date();
  const activeShares = readShares().shares
    .filter(s => new Date(s.expiresAt) > now)
    .slice(-10)
    .map(s => ({ token: s.token, path: s.originalPath || s.path, createdAt: s.createdAt, expiresAt: s.expiresAt, isDirectory: !!s.isDirectory }));
  jsonResponse(res, 200, activeShares);
}

function handleShareDelete(req, res, urlPath) {
  const token = decodeURIComponent(urlPath.replace('/share/', ''));
  const data = readShares();
  const share = data.shares.find(s => s.token === token);
  if (share && share.isTempZip && share.path && fs.existsSync(share.path)) {
    try { fs.unlinkSync(share.path); } catch {}
  }
  data.shares = data.shares.filter(s => s.token !== token);
  writeShares(data).then(() => jsonResponse(res, 200, { success: true })).catch(e => jsonResponse(res, 500, { error: e.message }));
}

function handleShareUpload(req, res) {
  parseMultipart(req, (err, parts) => {
    if (err) return jsonResponse(res, 400, { error: err.message });
    const filePart = parts.find(p => p.filename);
    if (!filePart) return jsonResponse(res, 400, { error: 'No file uploaded' });
    const filename = filePart.filename;
    const safeName = Date.now() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(SHARE_UPLOAD_DIR, safeName);
    try {
      fs.writeFileSync(filePath, filePart.data);
      const token = generateToken();
      const expiresAt = new Date(Date.now() + shareConfig.defaultExpiry * 60 * 1000).toISOString();
      appendShare({ token, path: filePath, originalPath: filename, createdAt: new Date().toISOString(), expiresAt, isDirectory: false, isTempZip: false, isUpload: true })
        .then(() => jsonResponse(res, 200, { success: true, url: getShareUrl(req, token), token, expiresAt, filename }))
        .catch(e => jsonResponse(res, 500, { error: e.message }));
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  });
}

async function handleSharePath(req, res, parsedUrl) {
  const filePath = parsedUrl.query.path;
  const expiry = parseInt(parsedUrl.query.expiry, 10) || shareConfig.defaultExpiry;
  if (!filePath) return jsonResponse(res, 400, { error: 'Missing path parameter' });
  if (!isPathAllowed(filePath)) {
    return jsonResponse(res, 403, { error: 'PATH_NOT_ALLOWED' });
  }
  if (!fs.existsSync(filePath)) return jsonResponse(res, 404, { error: 'File or directory not found' });
  const stat = fs.statSync(filePath);
  const isDirectory = stat.isDirectory();
  let targetPath = filePath;
  let isTempZip = false;
  if (isDirectory) {
    const zipPath = `/tmp/share-${Date.now()}.zip`;
    try {
      await zipPaths([filePath], zipPath);
    } catch (e) {
      return jsonResponse(res, 500, { error: 'Failed to compress directory' });
    }
    targetPath = zipPath;
    isTempZip = true;
  }
  const token = generateToken();
  const expiresAt = new Date(Date.now() + expiry * 60 * 1000).toISOString();
  appendShare({ token, path: targetPath, originalPath: filePath, createdAt: new Date().toISOString(), expiresAt, isDirectory, isTempZip })
    .then(() => jsonResponse(res, 200, { success: true, url: getShareUrl(req, token), token, expiresAt, isDirectory }))
    .catch(e => jsonResponse(res, 500, { error: e.message }));
}

function handleShareCompress(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { paths } = JSON.parse(body || '{}');
      if (!Array.isArray(paths) || paths.length === 0) return jsonResponse(res, 400, { error: 'paths must be a non-empty array' });
      if (!paths.every(p => typeof p === 'string' && isPathAllowed(p))) {
        return jsonResponse(res, 403, { error: 'PATH_NOT_ALLOWED' });
      }
      const existing = paths.filter(p => typeof p === 'string' && fs.existsSync(p));
      if (existing.length === 0) return jsonResponse(res, 404, { error: 'No existing paths to compress' });
      const zipPath = `/tmp/compress-${Date.now()}.zip`;
      try {
        await zipPaths(existing, zipPath);
      } catch (e) {
        return jsonResponse(res, 500, { error: 'Failed to compress' });
      }
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      appendShare({ token, path: zipPath, originalPath: 'compressed-files.zip', createdAt: new Date().toISOString(), expiresAt, isDirectory: false, isTempZip: true })
        .then(() => jsonResponse(res, 200, { success: true, url: getShareUrl(req, token), token }))
        .catch(e => jsonResponse(res, 500, { error: e.message }));
    } catch (e) {
      jsonResponse(res, 400, { error: e.message });
    }
  });
}

function handleShareUploadTo(req, res, parsedUrl) {
  let targetDir = parsedUrl.query.dir || SHARE_UPLOAD_DIR;
  if (parsedUrl.query.dir && !isPathAllowed(targetDir)) {
    return jsonResponse(res, 403, { error: 'PATH_NOT_ALLOWED' });
  }
  // v2.3.127: 自动创建目标目录, 允许用户在前端直接填写不存在的目录.
  if (!fs.existsSync(targetDir)) {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {
      return jsonResponse(res, 400, { error: '无法创建目录: ' + e.message });
    }
  }
  if (!fs.statSync(targetDir).isDirectory()) return jsonResponse(res, 400, { error: 'Invalid directory' });
  // v2.3.108: 预先检查目录是否可写, 上传到根目录等只读目录时, 直接返回友好提示, 避免 multipart 解析 + writeFile EACCES 后才报错.
  try { fs.accessSync(targetDir, fs.constants.W_OK); } catch (e) {
    return jsonResponse(res, 403, { error: '该目录为只读, 无法上传. 请切换到可写目录 (例如 /tmp 或用户主目录) 后再上传.', code: 'DIR_READONLY' });
  }
  parseMultipart(req, (err, parts) => {
    if (err) return jsonResponse(res, 400, { error: err.message });
    const filePart = parts.find(p => p.filename);
    if (!filePart) return jsonResponse(res, 400, { error: 'No file uploaded' });
    const filename = filePart.filename;
    const safeName = Date.now() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(targetDir, safeName);
    try {
      fs.writeFileSync(filePath, filePart.data);
      const token = generateToken();
      const expiresAt = new Date(Date.now() + shareConfig.defaultExpiry * 60 * 1000).toISOString();
      appendShare({ token, path: filePath, originalPath: filename, createdAt: new Date().toISOString(), expiresAt, isDirectory: false, isTempZip: false, isUpload: true })
        .then(() => jsonResponse(res, 200, { success: true, url: getShareUrl(req, token), token, filename, path: filePath }))
        .catch(e => jsonResponse(res, 500, { error: e.message }));
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  });
}

function handleShareTree(req, res, parsedUrl) {
  const targetPath = parsedUrl.query.path || '/';
  try {
    if (!fs.existsSync(targetPath)) return jsonResponse(res, 404, { error: 'Path not found' });
    if (!fs.statSync(targetPath).isDirectory()) return jsonResponse(res, 400, { error: 'Not a directory' });
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;                          // 跳过文件
      // v2.3.106: 根路径下隐藏系统目录, 跟 handleShareBrowse 一致
      if ((targetPath === '/' || targetPath === '') && ROOT_SYSTEM_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;                    // 跳过隐藏目录
      const itemPath = path.join(targetPath, e.name);
      try { fs.accessSync(itemPath, fs.constants.R_OK); } catch (err) { continue; }   // v2.3.106: 不可读目录跳过
      items.push({ name: e.name, path: itemPath, isDirectory: true });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    jsonResponse(res, 200, { path: targetPath, items });
  } catch (e) {
    // v2.3.106: 整目录 EACCES 降级为空列表, 不报 500
    jsonResponse(res, 200, { path: targetPath, items: [], error: e.code === 'EACCES' ? '没有读取该目录的权限' : e.message });
  }
}

function handleShareBrowse(req, res, parsedUrl) {
  const targetPath = parsedUrl.query.path || '/';
  // v2.3.106: 根路径下隐藏系统目录, 避免用户点击后 EACCES 报错. 根目录以外的路径不受影响.
  if (targetPath === '/' || targetPath === '') {
    try {
      if (!fs.existsSync(targetPath)) return jsonResponse(res, 404, { error: 'Path not found' });
      if (!fs.statSync(targetPath).isDirectory()) return jsonResponse(res, 400, { error: 'Not a directory' });
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const items = [];
      for (const e of entries) {
        if (ROOT_SYSTEM_DIRS.has(e.name)) continue;          // 跳过系统目录
        if (!e.isDirectory() && !e.isFile()) continue;        // 跳过符号链接 / 设备 / 套接字
        if (e.name.startsWith('.')) continue;                 // 跳过隐藏文件
        const itemPath = path.join(targetPath, e.name);
        let itemStat;
        try { itemStat = fs.statSync(itemPath); } catch (err) { continue; }   // v2.3.106: statSync EACCES 跳过, 不再返回 500
        items.push({ name: e.name, path: itemPath, isDirectory: e.isDirectory(), size: itemStat.size, mtime: itemStat.mtime.toISOString() });
      }
      items.sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
      jsonResponse(res, 200, { path: targetPath, parent: null, items });
    } catch (e) {
      jsonResponse(res, 200, { path: targetPath, parent: null, items: [] });   // v2.3.106: 整体 EACCES 也降级为空列表, 不报 500
    }
    return;
  }
  // v2.3.106: 非根路径, 单个 statSync EACCES 跳过, 整体 readdirSync EACCES 返回空.
  try {
    if (!fs.existsSync(targetPath)) return jsonResponse(res, 404, { error: 'Path not found' });
    if (!fs.statSync(targetPath).isDirectory()) return jsonResponse(res, 400, { error: 'Not a directory' });
    const items = [];
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const e of entries) {
      const itemPath = path.join(targetPath, e.name);
      let itemStat;
      try { itemStat = fs.statSync(itemPath); } catch (err) { continue; }    // v2.3.106: statSync EACCES 跳过
      items.push({ name: e.name, path: itemPath, isDirectory: e.isDirectory(), size: itemStat.size, mtime: itemStat.mtime.toISOString() });
    }
    items.sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
    const parent = path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath);
    jsonResponse(res, 200, { path: targetPath, parent, items });
  } catch (e) {
    // v2.3.106: 整目录 EACCES 降级为空列表 + 友好 error, 不让前端报 "加载失败: EACCES ...".
    jsonResponse(res, 200, { path: targetPath, parent: null, items: [], error: e.code === 'EACCES' ? '没有读取该目录的权限' : e.message });
  }
}

function handleShareDownload(req, res, parsedUrl) {
  const targetPath = parsedUrl.query.path;
  if (!targetPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found');
    return;
  }
  if (!isPathAllowed(targetPath)) {
    return jsonResponse(res, 403, { error: 'PATH_NOT_ALLOWED' });
  }
  if (!fs.existsSync(targetPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found');
    return;
  }
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Cannot download directory directly');
    return;
  }
  const filename = path.basename(targetPath);
  res.writeHead(200, {
    'Content-Type': getShareMimeType(targetPath),
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`
  });
  const stream = fs.createReadStream(targetPath);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'FILE_READ_ERROR' }));
  });
  stream.pipe(res);
}

function handleShareTokenDownload(req, res, urlPath) {
  const token = decodeURIComponent(urlPath.replace('/d/', ''));
  const share = readShares().shares.find(s => s.token === token);
  sendSharedFile(req, res, share);
}

// ── Main Server ──

const server = http.createServer(handler);

function handler(req, res) {
  if (setCorsHeaders(req, res)) return;

  const publicDir = path.join(__dirname, '..', '..', '..', 'shell-ui', 'modules', 'file-manager');
  const urlPath = req.url.split('?')[0];

  // API routes
  if (urlPath === '/health' && req.method === 'GET') {
    jsonResponse(res, 200, { success: true, status: 'healthy', service: 'openclaw-file-manager', port: PORT, ip: getLocalIP(), shareService: true, timestamp: new Date().toISOString() });
    return;
  }
  // HTTP share routes migrated from http-share-service
  const parsedShareUrl = url.parse(req.url, true);
  if (urlPath === '/recent' && req.method === 'GET') { handleShareRecent(req, res); return; }
  if (urlPath.startsWith('/share/') && req.method === 'DELETE') { handleShareDelete(req, res, urlPath); return; }
  if (urlPath === '/upload' && req.method === 'POST') { handleShareUpload(req, res); return; }
  if (urlPath === '/share' && req.method === 'GET') { handleSharePath(req, res, parsedShareUrl); return; }
  if (urlPath === '/compress' && req.method === 'POST') { handleShareCompress(req, res); return; }
  if (urlPath === '/upload-to' && req.method === 'POST') { handleShareUploadTo(req, res, parsedShareUrl); return; }
  if (urlPath === '/tree' && req.method === 'GET') { handleShareTree(req, res, parsedShareUrl); return; }
  if (urlPath === '/browse' && req.method === 'GET') { handleShareBrowse(req, res, parsedShareUrl); return; }
  if (urlPath === '/download' && req.method === 'GET') { handleShareDownload(req, res, parsedShareUrl); return; }
  if (urlPath.startsWith('/d/') && req.method === 'GET') { handleShareTokenDownload(req, res, urlPath); return; }

  if (urlPath === '/api/files/categories' && req.method === 'GET') {
    handleFilesCategories(req, res); return;
  }
  if (urlPath === '/api/files/subfolders' && req.method === 'GET') {
    handleFilesSubfolders(req, res); return;
  }
  if (urlPath === '/api/files/list' && req.method === 'GET') {
    handleFilesList(req, res); return;
  }
  if (urlPath === '/api/files/read' && req.method === 'GET') {
    handleFilesRead(req, res); return;
  }
  if (urlPath === '/api/files/save' && req.method === 'POST') {
    handleFilesSave(req, res); return;
  }
  if (urlPath === '/api/agent-workspaces' && req.method === 'GET') {
    handleAgentWorkspaces(req, res); return;
  }
  if (urlPath === '/api/agent-files' && req.method === 'GET') {
    handleAgentFiles(req, res); return;
  }
  if (urlPath === '/api/agent-file' && req.method === 'GET') {
    handleAgentFileGet(req, res); return;
  }
  if (urlPath === '/api/agent-file' && req.method === 'POST') {
    handleAgentFilePost(req, res); return;
  }
  if (urlPath === '/api/memory-file' && req.method === 'GET') {
    handleMemoryFile(req, res); return;
  }
  if (urlPath === '/api/docs-stats' && req.method === 'GET') {
    handleDocsStats(req, res); return;
  }

  // Static files
  let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  serveStaticFile(filePath, res);
}

process.on('unhandledRejection', (reason) => {
  console.error('[file-manager] Unhandled rejection:', reason);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[file-manager] running at http://${HOST}:${PORT}`);
  });
  init();
}

module.exports = {
  handler,
  init,
  dispose,
  healthFn,
  capabilities: ['timer'],
};
