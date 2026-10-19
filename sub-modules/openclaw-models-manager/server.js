'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 8117;
const HOST = process.env.HOST || '0.0.0.0';

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'shell-ui', 'modules', 'models-manager');
const CONFIG_FILE = path.join(os.homedir(), '.openclaw/openclaw.json');
// Provider 增删会写回 openclaw.json，落盘前先把原文件备份到这里（与「配置恢复」模块同一个目录，
// 这样它能在 UI 里直接列出并回滚）。只保留最新 8 份。
const BACKUP_DIR = path.join(__dirname, '..', 'config-recovery', 'backups');
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000;

let _statsCache = null;
let _statsCacheTime = 0;
const STATS_CACHE_TTL = 60000;

// ============================================================================
// v2.3.127: /api/stats-models 不再是「同步全量扫 session 日志」
// ----------------------------------------------------------------------------
// 这个 handler 是 Shell 仪表盘的第 1 个端点（server.js: getDashboardEndpoints 的 aiStats），
// 而 Shell 与全部模块跑在同一个进程、共用同一个事件循环，所以它一旦同步阻塞，整个 Shell
// （包括模块 iframe 自己的 HTML 请求）都得排队 —— 用户看到的就是「点开模块一片白」。
//
// 实测规模（2026-09-29）：~/.openclaw/agents 共 6.1GB，其中 10110 个 sessions/*.jsonl
// 合计 2288MB，单文件最大 164MB。原实现用 readFileSync 把它们全部读进来、逐行 JSON.parse、
// 再做一次 O(n²) 的响应时长配对，全程同步：
//   · CPU profile 里这一个函数自耗 13.9s，加 fs 读取共约 28~38s / 150s 窗口；
//   · 直接 curl GET /apps/models-manager/api/stats-models → 23.8s；
//   · eventLoop.maxMs 曾达 58935ms —— 与上面两项严丝合缝。
//
// 现在的做法：
//   1) stale-while-revalidate：有缓存就立刻返回（哪怕已过期），刷新丢到后台异步做，
//      请求路径永远不会等在扫描上（响应时间从 23.8s → 亚毫秒）。
//   2) 全异步 I/O：readdir / stat / readFile 一律走 fs.promises，不占事件循环。
//   3) 让出机制：解析循环每处理若干行就让出一次事件循环，单次阻塞压到 ~40ms 量级。
//   4) 文件级增量索引：按 (size, mtimeMs) 缓存每个 session 文件的聚合结果并落盘到
//      ~/.openclaw/cache/models-stats-index.json。老文件永远不变 → 只解析一次；
//      只有正在写入的活跃 session 会被重新解析。稳态下一轮扫描几乎零成本。
//   聚合口径与原实现完全一致（逐文件累加等价），返回结构不变。
// ============================================================================
const fsp = fs.promises;
const STATS_INDEX_FILE = path.join(os.homedir(), '.openclaw/cache/models-stats-index.json');
// 最终聚合结果也落盘：进程重启后能立刻给出完整数据，不必等一轮增量扫描
// （实测增量扫描在活跃 session 上仍有 ~3.6s，而仪表盘给这个端点的超时是 5s，余量太窄）
const STATS_RESULT_FILE = path.join(os.homedir(), '.openclaw/cache/models-stats-result.json');
const STATS_INDEX_VERSION = 1;
const STATS_INDEX_MAX_BYTES = 64 * 1024 * 1024; // 索引文件超过这个大小就弃用，避免拖慢启动
const STATS_INDEX_SAVE_DEBOUNCE_MS = 20000;
const STATS_YIELD_INTERVAL_MS = 40; // 单次同步片段的时长上限
// 超过这个大小就不再整文件读进内存（164MB 的 jsonl 变成 UTF-16 字符串要 ~330MB，
// 服务器 available 内存只有 2.6GB）。大文件改走流式逐行：内存有界，且天然分片。
const STATS_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

// filePath -> { key: '<size>:<mtimeMs>', agg }
let _statsFileIndex = new Map();
let _statsIndexLoaded = false;
let _statsIndexLoadedFromDisk = false;
let _statsIndexDirty = false;
let _statsIndexSaveTimer = null;
let _statsRefreshPromise = null;

function emptyStatsAgg() {
  return { models: Object.create(null), agents: Object.create(null), days: Object.create(null) };
}

function emptyStatsResult() {
  return { models: [], agents: {}, daily: {}, summary: { todayTokens: 0, todayMessages: 0, weekTokens: 0, avgResponseMs: 0 } };
}

// 事件循环让出：距上次让出超过 STATS_YIELD_INTERVAL_MS 才让，避免让出本身成为开销
function statsYield(state) {
  const now = Date.now();
  if (now - state.lastYield < STATS_YIELD_INTERVAL_MS) return null;
  state.lastYield = now;
  return new Promise((resolve) => setImmediate(resolve));
}

// 从磁盘恢复「文件级索引」与「上一次的最终结果」。
// 恢复结果之后，进程重启后第一个请求就能直接命中缓存（亚毫秒），
// 再由 SWR 在后台刷新 —— 冷启动再也不会撞上 3s+ 的增量扫描。
async function ensureStatsIndexLoaded() {
  if (_statsIndexLoaded) return;
  _statsIndexLoaded = true;

  try {
    const st = await fsp.stat(STATS_INDEX_FILE);
    if (st.size <= STATS_INDEX_MAX_BYTES) {
      const raw = await fsp.readFile(STATS_INDEX_FILE, 'utf-8');
      const doc = JSON.parse(raw);
      if (doc && doc.version === STATS_INDEX_VERSION && doc.files) {
        const next = new Map();
        for (const [p, v] of Object.entries(doc.files)) {
          if (v && typeof v.k === 'string' && v.m) next.set(p, { key: v.k, agg: v.m });
        }
        _statsFileIndex = next;
        _statsIndexLoadedFromDisk = true;
      }
    }
  } catch {
    // 索引不存在/损坏都无所谓，退化成一次全量重建
  }

  try {
    const st = await fsp.stat(STATS_RESULT_FILE);
    if (st.size <= STATS_INDEX_MAX_BYTES) {
      const raw = await fsp.readFile(STATS_RESULT_FILE, 'utf-8');
      const doc = JSON.parse(raw);
      if (doc && doc.version === STATS_INDEX_VERSION && doc.result && Array.isArray(doc.result.models)) {
        _statsCache = doc.result;
        // savedAt 决定它算不算过期：只要超过 STATS_CACHE_TTL 就会触发一次后台增量刷新
        _statsCacheTime = Date.parse(doc.savedAt) || 0;
      }
    }
  } catch {
    // 没有结果缓存也无妨
  }
}

let _statsResultSaveTimer = null;

function scheduleStatsResultSave(result) {
  if (_statsResultSaveTimer) return;
  _statsResultSaveTimer = setTimeout(() => {
    _statsResultSaveTimer = null;
    const doc = { version: STATS_INDEX_VERSION, savedAt: new Date().toISOString(), result };
    fsp.mkdir(path.dirname(STATS_RESULT_FILE), { recursive: true })
      .then(() => fsp.writeFile(STATS_RESULT_FILE, JSON.stringify(doc), 'utf8'))
      .catch((e) => console.warn('[models-manager] stats result save failed: ' + e.message));
  }, 2000);
  if (typeof _statsResultSaveTimer.unref === 'function') _statsResultSaveTimer.unref();
}

function scheduleStatsIndexSave() {
  if (!_statsIndexDirty || _statsIndexSaveTimer) return;
  _statsIndexSaveTimer = setTimeout(() => {
    _statsIndexSaveTimer = null;
    if (!_statsIndexDirty) return;
    _statsIndexDirty = false;
    const files = Object.create(null);
    for (const [p, v] of _statsFileIndex) files[p] = { k: v.key, m: v.agg };
    const doc = { version: STATS_INDEX_VERSION, savedAt: new Date().toISOString(), files };
    fsp.mkdir(path.dirname(STATS_INDEX_FILE), { recursive: true })
      .then(() => fsp.writeFile(STATS_INDEX_FILE, JSON.stringify(doc), 'utf8'))
      .catch((e) => console.warn('[models-manager] stats index save failed: ' + e.message));
  }, STATS_INDEX_SAVE_DEBOUNCE_MS);
  if (typeof _statsIndexSaveTimer.unref === 'function') _statsIndexSaveTimer.unref();
}

function loadOpenclawConfigCached() {
  const now = Date.now();
  if (_configCache && (now - _configCacheTime) < CONFIG_CACHE_TTL) {
    return _configCache;
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    _configCache = {};
    _configCacheTime = now;
    return {};
  }
  try {
    _configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _configCacheTime = now;
    return _configCache;
  } catch (e) {
    _configCache = {};
    _configCacheTime = now;
    return {};
  }
}

function readBody(req) {
  // 当通过 cockpit-shell 嵌入时，server.js:250 注册的 express.json() 已经
  // 消耗 body stream 并把解析结果放到 req.body 上；这里直接复用，
  // 避免对已耗尽的 stream 调用 req.on('end') 而永远 pending。
  if (req && req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    return Promise.resolve(JSON.stringify(req.body || {}));
  }
  if (req && (req.readableEnded || req.complete)) return Promise.resolve('');
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}

function jsonResponse(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function serveStaticFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    if (ext === '.css' || ext === '.js') {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function getContentType(ext) {
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  return map[ext] || 'application/octet-stream';
}

function loadOpenclawConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function atomicWriteJSON(filePath, data) {
  const tmpFile = filePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, filePath);
}
function saveOpenclawConfig(config) {
  atomicWriteJSON(CONFIG_FILE, config);
  _configCache = config;
  _configCacheTime = Date.now();
}

// 写盘前备份：失败不阻塞（返回 null），但会在响应里如实回报 backup 字段。
function backupOpenclawConfig(label) {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const fn = 'openclaw-config-' + ts + (label ? '-' + label : '') + '.json';
    fs.writeFileSync(path.join(BACKUP_DIR, fn), raw);
    const all = fs.readdirSync(BACKUP_DIR).filter(x => /^openclaw-config-.*\.json$/.test(x)).sort();
    while (all.length > 8) { try { fs.unlinkSync(path.join(BACKUP_DIR, all.shift())); } catch (e) { /* ignore */ } }
    return fn;
  } catch (e) {
    return null;
  }
}

// 找出引用了该 provider 的默认模型 / Agent 模型 —— 删除前用来拦一刀。
function collectProviderRefs(config, providerId) {
  const refs = [];
  const pref = providerId + '/';
  const dm = (config.agents && config.agents.defaults && config.agents.defaults.model)
    || (config.models && config.models.defaults && config.models.defaults.model) || {};
  [dm.primary].concat(dm.fallbacks || []).filter(Boolean).forEach(m => {
    if (String(m).startsWith(pref)) refs.push('默认模型 → ' + m);
  });
  ((config.agents && config.agents.list) || []).forEach(a => {
    const mm = a && a.model;
    const vals = [];
    if (typeof mm === 'string') vals.push(mm);
    else if (mm && typeof mm === 'object') {
      if (mm.primary) vals.push(mm.primary);
      (mm.fallbacks || []).forEach(f => vals.push(f));
    }
    vals.filter(Boolean).forEach(v => {
      if (String(v).startsWith(pref)) refs.push('Agent「' + (a.id || a.name || '?') + '」→ ' + v);
    });
  });
  return refs;
}

async function handleProvidersGet(req, res) {
  try {
    const config = loadOpenclawConfig();
    const providers = (config.models && config.models.providers) || {};
    const list = Object.entries(providers).map(([id, p]) => ({
      id,
      api: (p && p.api) || '',
      baseUrl: (p && p.baseUrl) || '',
      hasApiKey: !!(p && p.apiKey),
      modelCount: ((p && p.models) || []).length,
      refs: collectProviderRefs(config, id)
    }));
    jsonResponse(res, { success: true, providers: list, backupsDir: BACKUP_DIR });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message, providers: [] });
  }
}

async function handleProvidersPost(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body || '{}');
    const pid = String(parsed.id || '').trim();
    const api = String(parsed.api || '').trim();
    const baseUrl = String(parsed.baseUrl || '').trim();
    const apiKey = String(parsed.apiKey || '').trim();
    if (!PROVIDER_ID_RE.test(pid)) {
      jsonResponse(res, { success: false, error: '提供方 ID 只能用小写字母/数字/连字符/下划线，且以字母或数字开头（2-32 位）' });
      return;
    }
    if (!api) {
      jsonResponse(res, { success: false, error: 'api 字段必填（如 openai-completions）' });
      return;
    }
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      jsonResponse(res, { success: false, error: 'baseUrl 需以 http:// 或 https:// 开头' });
      return;
    }
    const config = loadOpenclawConfig();
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    if (config.models.providers[pid]) {
      jsonResponse(res, { success: false, error: '提供方「' + pid + '」已存在' });
      return;
    }
    const entry = { api: api };
    if (baseUrl) entry.baseUrl = baseUrl;
    if (apiKey) entry.apiKey = apiKey;
    entry.models = [];
    config.models.providers[pid] = entry;
    const backup = backupOpenclawConfig('provider-add-' + pid);
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true, id: pid, backup });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

async function handleProvidersDelete(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body || '{}');
    const pid = String(parsed.id || '').trim();
    const force = parsed.force === true || parsed.force === 1 || parsed.force === '1';
    const config = loadOpenclawConfig();
    const providers = (config.models && config.models.providers) || {};
    if (!providers[pid]) {
      jsonResponse(res, { success: false, error: '提供方「' + pid + '」不存在' });
      return;
    }
    if (Object.keys(providers).length <= 1) {
      jsonResponse(res, { success: false, error: '这是最后一个提供方，删掉会导致所有模型不可用，已拒绝' });
      return;
    }
    const modelCount = (providers[pid].models || []).length;
    const refs = collectProviderRefs(config, pid);
    if (!force && (modelCount > 0 || refs.length > 0)) {
      const parts = [];
      if (modelCount > 0) parts.push('仍挂着 ' + modelCount + ' 个模型');
      if (refs.length > 0) {
        parts.push('被 ' + refs.length + ' 处引用（' + refs.slice(0, 3).join('；') + (refs.length > 3 ? ' …' : '') + '）');
      }
      jsonResponse(res, {
        success: false,
        needsForce: true,
        error: '提供方「' + pid + '」' + parts.join('，') + '。确认要连模型一起删掉请再点一次。'
      });
      return;
    }
    delete config.models.providers[pid];
    const backup = backupOpenclawConfig('provider-del-' + pid);
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true, id: pid, backup: backup, removedModels: modelCount, removedRefs: refs.length });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

// ========== 模型绑定（默认模型 / 每个 Agent 的模型）==========
// 全部由实际 provider 列表驱动，不硬编码任何 provider / 模型名。

function providerModelIds(provider) {
  return ((provider && provider.models) || [])
    .map(m => (typeof m === 'string' ? m : (m && m.id)))
    .filter(Boolean);
}

function listProvidersForPicker(config) {
  const providers = (config.models && config.models.providers) || {};
  return Object.entries(providers).map(([id, p]) => ({
    id,
    api: (p && p.api) || '',
    baseUrl: (p && p.baseUrl) || '',
    models: providerModelIds(p)
  }));
}

function readModelBindings(config) {
  const agentsModel = config.agents && config.agents.defaults && config.agents.defaults.model;
  const modelsModel = config.models && config.models.defaults && config.models.defaults.model;
  const dm = agentsModel || modelsModel || {};
  return {
    defaultsSource: agentsModel ? 'agents.defaults.model' : (modelsModel ? 'models.defaults.model' : 'agents.defaults.model'),
    defaults: { primary: dm.primary || '', fallbacks: (dm.fallbacks || []).slice() },
    agents: ((config.agents && config.agents.list) || []).map(a => ({
      id: a.id,
      model: typeof a.model === 'string' ? a.model : ((a.model && a.model.primary) || '')
    }))
  };
}

function ensureModelPath(config, source) {
  if (source === 'models.defaults.model') {
    if (!config.models) config.models = {};
    if (!config.models.defaults) config.models.defaults = {};
    if (!config.models.defaults.model) config.models.defaults.model = {};
    return config.models.defaults.model;
  }
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  return config.agents.defaults.model;
}

function modelRefExists(config, ref) {
  const s = String(ref || '');
  const i = s.indexOf('/');
  if (i <= 0) return false;
  const pid = s.slice(0, i);
  const mid = s.slice(i + 1);
  const p = config.models && config.models.providers && config.models.providers[pid];
  if (!p) return false;
  return providerModelIds(p).indexOf(mid) !== -1;
}

async function handleModelBindingsGet(req, res) {
  try {
    const config = loadOpenclawConfig();
    const b = readModelBindings(config);
    const providers = listProvidersForPicker(config);
    const dangling = [];
    if (b.defaults.primary && !modelRefExists(config, b.defaults.primary)) dangling.push(b.defaults.primary);
    b.defaults.fallbacks.forEach(f => { if (!modelRefExists(config, f)) dangling.push(f); });
    b.agents.forEach(a => { if (a.model && !modelRefExists(config, a.model)) dangling.push(a.model); });
    jsonResponse(res, {
      success: true,
      defaultsSource: b.defaultsSource,
      defaults: b.defaults,
      agents: b.agents,
      providers,
      dangling: [...new Set(dangling)],
      configFile: CONFIG_FILE
    });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

async function handleModelBindingsPut(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body || '{}');
    const config = loadOpenclawConfig();
    const invalid = [];
    const apply = [];

    if (parsed.defaults) {
      const src = parsed.defaultsSource === 'models.defaults.model' ? 'models.defaults.model' : 'agents.defaults.model';
      const primary = String(parsed.defaults.primary || '').trim();
      const fallbacks = (parsed.defaults.fallbacks || []).map(f => String(f || '').trim()).filter(Boolean);
      [primary].concat(fallbacks).forEach(r => { if (r && !modelRefExists(config, r)) invalid.push(r); });
      apply.push(() => {
        const node = ensureModelPath(config, src);
        node.primary = primary;
        node.fallbacks = fallbacks;
      });
    }

    if (parsed.agents && typeof parsed.agents === 'object') {
      const list = (config.agents && config.agents.list) || [];
      Object.entries(parsed.agents).forEach(([id, model]) => {
        const m = String(model || '').trim();
        const a = list.find(x => x.id === id);
        if (!a) { invalid.push('agent:' + id); return; }
        if (m && !modelRefExists(config, m)) { invalid.push(m); return; }
        apply.push(() => { a.model = m; });
      });
    }

    if (invalid.length) {
      jsonResponse(res, { success: false, error: '这些 provider/model 不存在，已拒绝写入：' + [...new Set(invalid)].join(', ') });
      return;
    }
    if (!apply.length) {
      jsonResponse(res, { success: false, error: '没有需要修改的绑定' });
      return;
    }
    apply.forEach(fn => fn());
    const backup = backupOpenclawConfig('model-bindings');
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true, backup: backup });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

// 泛化「批量改指」：把所有指向 provider `from` 的绑定改到 `to`；
// 只有 `to` 下存在**同名模型**时才改，改不了的如实列出来（不做任何猜测映射）。
async function handleModelBindingsRemap(req, res) {
  const body = await readBody(req);
  try {
    const parsed = JSON.parse(body || '{}');
    const from = String(parsed.from || '').trim();
    const to = String(parsed.to || '').trim();
    const includeDefaults = parsed.includeDefaults !== false;
    const includeAgents = parsed.includeAgents !== false;
    if (!from || !to) { jsonResponse(res, { success: false, error: 'from / to 都要给' }); return; }
    const config = loadOpenclawConfig();
    const toProv = config.models && config.models.providers && config.models.providers[to];
    if (!toProv) { jsonResponse(res, { success: false, error: '目标提供方「' + to + '」不存在' }); return; }
    const toModels = providerModelIds(toProv);
    const changed = [];
    const skipped = [];
    const tryRemap = (ref) => {
      const s = String(ref || '');
      if (s.indexOf(from + '/') !== 0) return null;
      const mid = s.slice(from.length + 1);
      if (toModels.indexOf(mid) === -1) { skipped.push(s + '  →  ' + to + '/' + mid + '（目标下无此模型）'); return null; }
      changed.push(s + '  →  ' + to + '/' + mid);
      return to + '/' + mid;
    };
    const b = readModelBindings(config);
    let touched = false;

    if (includeDefaults) {
      const node = ensureModelPath(config, b.defaultsSource);
      const np = tryRemap(b.defaults.primary);
      if (np) { node.primary = np; touched = true; }
      if (b.defaults.fallbacks.length) {
        const nf = b.defaults.fallbacks.map(f => { const r = tryRemap(f); return r === null ? f : r; });
        if (nf.join('\u0000') !== b.defaults.fallbacks.join('\u0000')) { node.fallbacks = nf; touched = true; }
      }
    }
    if (includeAgents) {
      const list = (config.agents && config.agents.list) || [];
      list.forEach(a => {
        const r = tryRemap(typeof a.model === 'string' ? a.model : '');
        if (r) { a.model = r; touched = true; }
      });
    }
    if (!touched) {
      jsonResponse(res, { success: false, error: '没有可改指的绑定', changed: [], skipped: skipped });
      return;
    }
    const backup = backupOpenclawConfig('model-bindings-remap');
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true, changed: changed, skipped: skipped, backup: backup });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

// ========== API Handlers ==========

async function handleModelsList(req, res) {
  try {
    const config = loadOpenclawConfig();
    const providers = config.models?.providers || {};
    const agentsList = config.agents?.list || [];
    const defaultModel = config.agents?.defaults?.model?.primary || config.models?.defaults?.model?.primary || '';
    const fallbacks = config.agents?.defaults?.model?.fallbacks || [];

    const providersList = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      const models = (provider.models || []).map(m => {
        const modelId = typeof m === 'string' ? m : m.id;
        const inputTypes = (typeof m === 'object' && m.input) ? m.input : ['text'];
        const hasExplicitImage = inputTypes.includes('image');
        const nameLower = (typeof m === 'string' ? m : (m.name || m.id)).toLowerCase();
        const hasNameVision = /vision|vl|gpt-4o|claude-3|gemini-1\.5|gemini-2|qwen-vl|llava|yi-vision|minicpm/.test(nameLower);
        return {
          id: modelId,
          name: typeof m === 'string' ? m : (m.name || m.id),
          contextWindow: m.contextWindow || 128000,
          contextConfigured: typeof m === 'object' && !!m.contextWindow,
          maxTokens: m.maxTokens || 4096,
          reasoning: m.reasoning || false,
          input: inputTypes,
          hasImageSupport: hasExplicitImage || hasNameVision
        };
      });

      const usedBy = agentsList
        .filter(a => a.model && a.model.startsWith(providerId + '/'))
        .map(a => {
          const workspaceDir = a.workspace || path.join(os.homedir(), '.openclaw/workspace-' + a.id);
          const soulFile = path.join(workspaceDir, 'SOUL.md');
          let emoji = '\uD83E\uDD16', name = a.id;
          if (fs.existsSync(soulFile)) {
            const soulContent = fs.readFileSync(soulFile, 'utf8');
            const emojiMatch = soulContent.match(/\*\*Emoji\*\*[\uff1a:]\s*([^\n]+)/i);
            const nameMatch = soulContent.match(/\*\*Name[\uff1a:]\*\*\s*([^\n]+)/i);
            if (emojiMatch) emoji = emojiMatch[1].trim();
            if (nameMatch) name = nameMatch[1].trim();
          }
          return { id: a.id, emoji, name };
        });

      // Per-model usedBy
      models.forEach(model => {
        const fullId = providerId + '/' + model.id;
        model.usedBy = agentsList
          .filter(a => a.model === fullId)
          .map(a => {
            const workspaceDir = a.workspace || path.join(os.homedir(), '.openclaw/workspace-' + a.id);
            const soulFile = path.join(workspaceDir, 'SOUL.md');
            let emoji = '\uD83E\uDD16', name = a.id;
            if (fs.existsSync(soulFile)) {
              const soulContent = fs.readFileSync(soulFile, 'utf8');
              const emojiMatch = soulContent.match(/\*\*Emoji\*\*[\uff1a:]\s*([^\n]+)/i);
              const nameMatch = soulContent.match(/\*\*Name[\uff1a:]\*\*\s*([^\n]+)/i);
              if (emojiMatch) emoji = emojiMatch[1].trim();
              if (nameMatch) name = nameMatch[1].trim();
            }
            return { id: a.id, emoji, name };
          });
      });

      providersList.push({
        id: providerId,
        api: provider.api || 'unknown',
        accessMode: provider.apiKey ? 'api_key' : 'auth',
        models,
        usedBy
      });
    }

    jsonResponse(res, { providers: providersList, defaults: { model: defaultModel, fallbacks } });
  } catch (e) {
    jsonResponse(res, { error: e.message, providers: [] });
  }
}

async function handleModelsGet(req, res) {
  try {
    const config = loadOpenclawConfig();
    const providers = config.models?.providers || {};
    const models = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      if (provider.models) {
        for (const model of provider.models) {
          const modelId = typeof model === 'string' ? model : model.id;
          const modelName = typeof model === 'string' ? model : (model.name || model.id);
          models.push({ id: modelId, name: modelName, provider: providerId, contextWindow: model.contextWindow || 128000 });
        }
      }
    }
    jsonResponse(res, { models });
  } catch (e) {
    jsonResponse(res, { error: e.message });
  }
}

async function handleModelsPost(req, res) {
  const body = await readBody(req);
  try {
    const { provider, modelId, name, contextWindow } = JSON.parse(body);
    if (!provider || !modelId) {
      jsonResponse(res, { success: false, error: 'Missing provider or modelId' });
      return;
    }
    const config = loadOpenclawConfig();
    if (!config.models?.providers?.[provider]) {
      jsonResponse(res, { success: false, error: 'Provider not found' });
      return;
    }
    const models = config.models.providers[provider].models || [];
    if (models.find(m => (typeof m === 'string' ? m : m.id) === modelId)) {
      jsonResponse(res, { success: false, error: 'Model already exists' });
      return;
    }
    config.models.providers[provider].models = models.concat([{
      id: modelId, name: name || modelId, contextWindow: contextWindow || 128000
    }]);
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

async function handleModelsPut(req, res) {
  const body = await readBody(req);
  try {
    const { provider, modelId, name, contextWindow } = JSON.parse(body);
    if (!provider || !modelId) {
      jsonResponse(res, { success: false, error: 'Missing provider or modelId' });
      return;
    }
    const config = loadOpenclawConfig();
    if (!config.models?.providers?.[provider]) {
      jsonResponse(res, { success: false, error: 'Provider not found' });
      return;
    }
    const models = config.models.providers[provider].models || [];
    const modelIndex = models.findIndex(m => (typeof m === 'string' ? m : m.id) === modelId);
    if (modelIndex === -1) {
      jsonResponse(res, { success: false, error: 'Model not found' });
      return;
    }
    models[modelIndex] = { ...models[modelIndex], id: modelId, name: name || modelId, contextWindow: contextWindow || 128000 };
    config.models.providers[provider].models = models;
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

async function handleModelsDelete(req, res) {
  const body = await readBody(req);
  try {
    const { provider, modelId } = JSON.parse(body);
    if (!provider || !modelId) {
      jsonResponse(res, { success: false, error: 'Missing provider or modelId' });
      return;
    }
    const config = loadOpenclawConfig();
    if (!config.models?.providers?.[provider]) {
      jsonResponse(res, { success: false, error: 'Provider not found' });
      return;
    }
    const models = config.models.providers[provider].models || [];
    const newModels = models.filter(m => (typeof m === 'string' ? m : m.id) !== modelId);
    if (newModels.length === models.length) {
      jsonResponse(res, { success: false, error: 'Model not found' });
      return;
    }
    config.models.providers[provider].models = newModels;
    saveOpenclawConfig(config);
    jsonResponse(res, { success: true });
  } catch (e) {
    jsonResponse(res, { success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// 逐行喂给 onLine：小文件整读 + 手工切行（快，且按时间片让出事件循环）；
// 大文件走 readline 流式（内存有界，且按 chunk 天然分片）。
// ---------------------------------------------------------------------------
async function forEachLine(filePath, size, onLine) {
  if (size <= STATS_STREAM_THRESHOLD_BYTES) {
    const content = await fsp.readFile(filePath, 'utf-8');
    const len = content.length;
    const state = { lastYield: Date.now() };
    let pos = 0;
    let n = 0;
    while (pos < len) {
      let nl = content.indexOf('\n', pos);
      if (nl === -1) nl = len;
      onLine(content.slice(pos, nl));
      pos = nl + 1;
      n += 1;
      if ((n & 511) === 511) {
        const y = statsYield(state);
        if (y) await y;
      }
    }
    return;
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) onLine(line);
  } finally {
    try { rl.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 把单个 session .jsonl 解析成「可累加」的聚合（与原实现逐文件等价）
// ---------------------------------------------------------------------------
async function parseSessionAgg(filePath, agentId, size) {
  const agg = emptyStatsAgg();
  const messages = [];

  try {
    await forEachLine(filePath, size, (line) => {
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      if (entry.type !== 'message' || !entry.message || !entry.timestamp) return;

      const msg = entry.message;
      const ts = entry.timestamp;
      const date = ts.slice(0, 10);
      messages.push({ role: msg.role, ts, stopReason: msg.stopReason, model: msg.model, provider: msg.provider });

      if (msg.role !== 'assistant' || !msg.usage || !msg.model) return;

      const modelKey = `${msg.provider || 'unknown'}/${msg.model}`;
      let m = agg.models[modelKey];
      if (!m) {
        m = agg.models[modelKey] = {
          modelId: msg.model, provider: msg.provider || 'unknown',
          inputTokens: 0, outputTokens: 0, totalTokens: 0,
          messageCount: 0, durSum: 0, durCount: 0, daily: Object.create(null),
        };
      }
      const t = msg.usage.totalTokens || (msg.usage.input || 0) + (msg.usage.output || 0);
      m.inputTokens += msg.usage.input || 0;
      m.outputTokens += msg.usage.output || 0;
      m.totalTokens += t;
      m.messageCount += 1;
      let md = m.daily[date];
      if (!md) md = m.daily[date] = { tokens: 0, messages: 0 };
      md.tokens += t;
      md.messages += 1;

      let a = agg.agents[agentId];
      if (!a) a = agg.agents[agentId] = { tokens: 0, messages: 0, daily: Object.create(null) };
      a.tokens += t;
      a.messages += 1;
      let ad = a.daily[date];
      if (!ad) ad = a.daily[date] = { tokens: 0, messages: 0 };
      ad.tokens += t;
      ad.messages += 1;

      let d = agg.days[date];
      if (!d) d = agg.days[date] = { tokens: 0, messages: 0 };
      d.tokens += t;
      d.messages += 1;
    });
  } catch {
    return null;
  }

  // 响应时长配对：只看本文件内的消息序列，等价于原实现的 per-file 行为。
  // 只累加 sum/count，最终再取整 —— 与原先 push 全部值再求平均的结果一致。
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'assistant' && messages[j].stopReason === 'stop' && messages[j].model) {
        const diffMs = new Date(messages[j].ts).getTime() - new Date(messages[i].ts).getTime();
        if (diffMs > 0 && diffMs < 600000) {
          const key = `${messages[j].provider || 'unknown'}/${messages[j].model}`;
          const m = agg.models[key];
          if (m) { m.durSum += diffMs; m.durCount += 1; }
        }
        break;
      }
    }
  }

  return agg;
}

function mergeStatsAgg(target, agg) {
  const models = agg.models || {};
  for (const k in models) {
    const src = models[k];
    let t = target.models[k];
    if (!t) {
      t = target.models[k] = {
        modelId: src.modelId, provider: src.provider,
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        messageCount: 0, durSum: 0, durCount: 0, daily: Object.create(null),
      };
    }
    t.inputTokens += src.inputTokens || 0;
    t.outputTokens += src.outputTokens || 0;
    t.totalTokens += src.totalTokens || 0;
    t.messageCount += src.messageCount || 0;
    t.durSum += src.durSum || 0;
    t.durCount += src.durCount || 0;
    const sd = src.daily || {};
    for (const d in sd) {
      let td = t.daily[d];
      if (!td) td = t.daily[d] = { tokens: 0, messages: 0 };
      td.tokens += sd[d].tokens || 0;
      td.messages += sd[d].messages || 0;
    }
  }

  const agents = agg.agents || {};
  for (const a in agents) {
    const src = agents[a];
    let t = target.agents[a];
    if (!t) t = target.agents[a] = { tokens: 0, messages: 0, daily: Object.create(null) };
    t.tokens += src.tokens || 0;
    t.messages += src.messages || 0;
    const sd = src.daily || {};
    for (const d in sd) {
      let td = t.daily[d];
      if (!td) td = t.daily[d] = { tokens: 0, messages: 0 };
      td.tokens += sd[d].tokens || 0;
      td.messages += sd[d].messages || 0;
    }
  }

  const days = agg.days || {};
  for (const d in days) {
    let t = target.days[d];
    if (!t) t = target.days[d] = { tokens: 0, messages: 0 };
    t.tokens += days[d].tokens || 0;
    t.messages += days[d].messages || 0;
  }
}

// 全量 / 增量扫描。只有 (size, mtimeMs) 变过的文件才会被重新解析。
async function runStatsScan() {
  const startedAt = Date.now();
  await ensureStatsIndexLoaded();

  const agentsDir = path.join(os.homedir(), '.openclaw/agents');
  let agentIds = [];
  try {
    const ents = await fsp.readdir(agentsDir, { withFileTypes: true });
    agentIds = ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}

  const merged = emptyStatsAgg();
  const alive = new Set();
  let parsedFiles = 0, reusedFiles = 0, parsedBytes = 0, failedFiles = 0;

  for (const agentId of agentIds) {
    const sessionsDir = path.join(agentsDir, agentId, 'sessions');
    let names = [];
    try {
      names = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl') && !f.includes('.deleted.'));
    } catch {
      continue;
    }

    for (const name of names) {
      const filePath = path.join(sessionsDir, name);
      alive.add(filePath);

      let st;
      try { st = await fsp.stat(filePath); } catch { continue; }
      if (!st.isFile()) continue;

      const key = `${st.size}:${Math.floor(st.mtimeMs)}`;
      const hit = _statsFileIndex.get(filePath);
      let agg;
      if (hit && hit.key === key && hit.agg) {
        agg = hit.agg;
        reusedFiles += 1;
      } else {
        agg = await parseSessionAgg(filePath, agentId, st.size);
        if (!agg) { failedFiles += 1; continue; }
        _statsFileIndex.set(filePath, { key, agg });
        _statsIndexDirty = true;
        parsedFiles += 1;
        parsedBytes += st.size;
      }
      mergeStatsAgg(merged, agg);
    }
  }

  // 清理已删除的文件，防止索引无限膨胀
  for (const p of _statsFileIndex.keys()) {
    if (!alive.has(p)) {
      _statsFileIndex.delete(p);
      _statsIndexDirty = true;
    }
  }
  if (_statsIndexDirty) scheduleStatsIndexSave();

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = now - 7 * 86400000;

  const models = Object.keys(merged.models).map((k) => {
    const m = merged.models[k];
    m.avgResponseMs = m.durCount > 0 ? Math.round(m.durSum / m.durCount) : 0;
    delete m.durSum;
    delete m.durCount;
    return m;
  });
  models.sort((a, b) => b.totalTokens - a.totalTokens);

  const dayMap = merged.days;
  const todayTokens = dayMap[today] ? dayMap[today].tokens : 0;
  const todayMessages = dayMap[today] ? dayMap[today].messages : 0;
  let weekTokens = 0;
  Object.keys(dayMap).forEach((date) => {
    if (new Date(date).getTime() > weekAgo) weekTokens += dayMap[date].tokens;
  });

  let totalResponseMs = 0;
  let responseCount = 0;
  models.forEach((m) => {
    if (m.avgResponseMs > 0) {
      totalResponseMs += m.avgResponseMs * m.messageCount;
      responseCount += m.messageCount;
    }
  });
  const avgResponseMs = responseCount > 0 ? Math.round(totalResponseMs / responseCount) : 0;

  const result = {
    models,
    agents: merged.agents,
    daily: dayMap,
    summary: { todayTokens, todayMessages, weekTokens, avgResponseMs },
  };

  _statsCache = result;
  _statsCacheTime = Date.now();
  scheduleStatsResultSave(result);
  console.log(
    '[models-manager] stats scan ' + (Date.now() - startedAt) + 'ms' +
    ' files=' + (parsedFiles + reusedFiles) +
    ' parsed=' + parsedFiles + ' reused=' + reusedFiles +
    ' bytes=' + parsedBytes + ' failed=' + failedFiles +
    ' index=' + (_statsIndexLoadedFromDisk ? 'disk' : 'cold')
  );
  return result;
}

// 后台刷新（同刻只跑一份，避免堆积）
function scheduleStatsRefresh() {
  if (_statsRefreshPromise) return _statsRefreshPromise;
  _statsRefreshPromise = runStatsScan()
    .catch((e) => {
      console.warn('[models-manager] stats scan failed: ' + (e && e.message));
      return null;
    })
    .finally(() => { _statsRefreshPromise = null; });
  return _statsRefreshPromise;
}

// stale-while-revalidate：请求路径永不等待扫描结果
async function handleStatsModels(req, res) {
  try {
    const now = Date.now();
    if (_statsCache) {
      if ((now - _statsCacheTime) >= STATS_CACHE_TTL) scheduleStatsRefresh();
      jsonResponse(res, _statsCache);
      return;
    }

    // 冷启动（进程刚起、内存缓存还是空的）
    await ensureStatsIndexLoaded();
    if (_statsCache) {
      // 上次的结果缓存已从磁盘恢复 —— 立刻给完整数据，后台再增量刷新
      scheduleStatsRefresh();
      jsonResponse(res, _statsCache);
      return;
    }
    if (_statsIndexLoadedFromDisk) {
      // 有磁盘索引：增量扫描只解析变过的文件，可以直接等
      const result = await scheduleStatsRefresh();
      jsonResponse(res, result || emptyStatsResult());
      return;
    }

    // 索引也不存在（首次部署 / 索引被清）：不给请求挂 20 多秒，
    // 先返回一份合法的空结构，后台把索引建起来，之后的请求就是亚毫秒。
    scheduleStatsRefresh();
    jsonResponse(res, emptyStatsResult());
  } catch (e) {
    jsonResponse(res, { error: e.message, models: [] });
  }
}

// 启动预热：Shell 首屏仪表盘本来就会取这个端点，提前在后台把索引建好/刷新，
// 避免「重启后第一次打开仪表盘」撞上冷扫描。异步 + 让出，不阻塞启动。
const _statsWarmTimer = setTimeout(() => { scheduleStatsRefresh(); }, 8000);
if (typeof _statsWarmTimer.unref === 'function') _statsWarmTimer.unref();

async function handleTestModelGet(req, res) {
  try {
    const results = [];
    const config = loadOpenclawConfig();
    const providers = config.models?.providers || {};
    for (const [providerId, provider] of Object.entries(providers)) {
      const hasKey = !!(provider.apiKey || provider.key);
      results.push({
        provider: providerId, ok: hasKey,
        status: hasKey ? 'configured' : 'no_api_key',
        models: (provider.models || []).map(m => m.id || m).slice(0, 3)
      });
    }
    jsonResponse(res, { results });
  } catch (e) {
    jsonResponse(res, { error: e.message });
  }
}

async function handleTestModelPost(req, res) {
  const body = await readBody(req);
  try {
    let { provider, modelId, agentId, model } = JSON.parse(body);
    if (agentId && model) {
      const parts = model.split('/');
      if (parts.length === 2) { provider = parts[0]; modelId = parts[1]; }
    }
    if (!provider || !modelId) {
      jsonResponse(res, { results: [{ ok: false, error: 'Missing provider or modelId' }] });
      return;
    }

    const config = loadOpenclawConfig();
    const providers = config.models?.providers || {};
    const providerConfig = providers[provider];
    if (!providerConfig) {
      jsonResponse(res, { results: [{ ok: false, error: 'Provider not found: ' + provider, provider, modelId }] });
      return;
    }
    if (!providerConfig.apiKey) {
      jsonResponse(res, { results: [{ ok: false, error: 'No API key configured', provider, modelId }] });
      return;
    }

    const start = Date.now();
    const testPayload = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 };
    let baseUrl = providerConfig.baseUrl || 'https://api.openai.com';
    let endpoint = '/v1/chat/completions';
    if (baseUrl.includes('openrouter.ai')) endpoint = '/chat/completions';
    else if (baseUrl.includes('qianfan.baidubce.com')) endpoint = '/chat/completions';
    else if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3);
    const fullUrl = baseUrl + endpoint;

    const urlObj = new URL(fullUrl);
    const reqLib = urlObj.protocol === 'https:' ? https : http;

    const hostname = urlObj.hostname;
    const isPrivateIP = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname);

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + providerConfig.apiKey
      },
      timeout: 30000
    };

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (!isPrivateIP && proxyUrl) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        reqOptions.agent = new HttpsProxyAgent(proxyUrl);
      } catch {}
    }

    const testRes = await new Promise((resolve, reject) => {
      const request = reqLib.request(reqOptions, resolve);
      request.on('error', (e) => reject(new Error(e.message || 'Request failed')));
      request.on('timeout', () => { request.destroy(); reject(new Error('Request timeout after 30s')); });
      request.write(JSON.stringify(testPayload));
      request.end();
    });

    let responseBody = '';
    testRes.on('data', chunk => responseBody += chunk);
    testRes.on('end', () => {
      const elapsed = Date.now() - start;
      if (testRes.statusCode === 200) {
        let promptTokens = 0, completionTokens = 0;
        try {
          const json = JSON.parse(responseBody);
          promptTokens = json.usage?.prompt_tokens || 0;
          completionTokens = json.usage?.completion_tokens || 0;
        } catch {}
        jsonResponse(res, { results: [{ ok: true, elapsed, model: modelId, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens }] });
      } else {
        jsonResponse(res, { results: [{ ok: false, elapsed, status: testRes.statusCode, error: responseBody.substring(0, 500), model: modelId, provider }] });
      }
    });
  } catch (e) {
    jsonResponse(res, { results: [{ ok: false, error: e.message }] });
  }
}

async function handleCliproxyModels(req, res) {
  try {
    const config = loadOpenclawConfig();
    const providers = (config.models && config.models.providers) || {};
    const q = url.parse(req.url, true).query || {};
    // 指定 ?provider=<id> 优先；否则回退 cliproxy（向后兼容）；再否则挑第一个配了 baseUrl 的。
    // 2026-10-02：provider 已可由用户自增删，不能再把 cliproxy 写死。
    let pid = String(q.provider || '').trim();
    if (!pid || !providers[pid]) {
      pid = providers.cliproxy ? 'cliproxy'
        : (Object.keys(providers).find(k => providers[k] && providers[k].baseUrl) || '');
    }
    const providerConfig = pid ? providers[pid] : null;
    if (!providerConfig || !providerConfig.baseUrl) {
      jsonResponse(res, {
        error: '没有可拉取的提供方 —— 请先新建一个配了 Base URL 的 provider',
        models: [],
        provider: pid || null,
        providers: Object.keys(providers)
      });
      return;
    }
    const baseUrl = providerConfig.baseUrl.replace(/\/v1\/?$/, '');
    const apiKey = providerConfig.apiKey || '';
    const urlObj = new URL(baseUrl + '/v1/models');
    const reqLib = urlObj.protocol === 'https:' ? https : http;

    const modelReq = reqLib.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    }, (modelRes) => {
      let body = '';
      modelRes.on('data', chunk => body += chunk);
      modelRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          const models = (data.data || []).map(m => ({ id: m.id, name: m.id, owned_by: m.owned_by || 'unknown' }));
          jsonResponse(res, { models, total: models.length, provider: pid });
        } catch (e) {
          jsonResponse(res, { error: 'Parse failed: ' + e.message, models: [], provider: pid });
        }
      });
    });
    modelReq.on('error', (e) => jsonResponse(res, { error: 'Request failed: ' + e.message, models: [], provider: pid }));
    modelReq.setTimeout(10000, () => { modelReq.destroy(); jsonResponse(res, { error: 'Timeout', models: [], provider: pid }); });
    modelReq.end();
  } catch (e) {
    jsonResponse(res, { error: e.message, models: [] });
  }
}

async function handleAgentsList(req, res) {
  try {
    const agentsDir = path.join(os.homedir(), '.openclaw/agents');
    const agents = [];
    if (fs.existsSync(agentsDir)) {
      fs.readdirSync(agentsDir).forEach(agentId => {
        const agentPath = path.join(agentsDir, agentId);
        const modelsFile = path.join(agentPath, 'agent/models.json');
        try {
          if (fs.statSync(agentPath).isDirectory()) {
            agents.push({ id: agentId, hasModels: fs.existsSync(modelsFile) });
          }
        } catch {}
      });
    }
    jsonResponse(res, { agents });
  } catch (e) {
    jsonResponse(res, { error: e.message, agents: [] });
  }
}

async function handleAgentModels(req, res, agentId) {
  try {
    const agentDir = path.join(os.homedir(), '.openclaw/agents', agentId, 'agent');
    const modelsFile = path.join(agentDir, 'models.json');
    if (fs.existsSync(modelsFile)) {
      const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
      const providers = models.providers || {};
      const providersList = [];
      for (const [providerId, provider] of Object.entries(providers)) {
        const modelList = (provider.models || []).map(m => ({
          id: typeof m === 'string' ? m : m.id,
          name: typeof m === 'string' ? m : (m.name || m.id),
          contextWindow: m.contextWindow || 128000,
          maxTokens: m.maxTokens || 4096,
          reasoning: m.reasoning || false,
          input: m.input || ['text']
        }));
        providersList.push({ id: providerId, api: provider.api || 'unknown', accessMode: provider.apiKey ? 'api_key' : 'auth', models: modelList });
      }
      jsonResponse(res, { agentId, providers: providersList });
    } else {
      jsonResponse(res, { agentId, providers: [], error: 'models.json not found' });
    }
  } catch (e) {
    jsonResponse(res, { error: e.message, providers: [] });
  }
}

// ========== HTTP Server ==========

const server = http.createServer(handler);

async function handler(req, res) {
  try {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // API routes
  if (pathname === '/health' && req.method === 'GET') {
    jsonResponse(res, { status: 'healthy', service: 'openclaw-models-manager', port: PORT, timestamp: new Date().toISOString() });
    return;
  }

  if (pathname === '/api/models-list' && req.method === 'GET') { await handleModelsList(req, res); return; }
  if (pathname === '/api/models' && req.method === 'GET') { await handleModelsGet(req, res); return; }
  if (pathname === '/api/models' && req.method === 'POST') { await handleModelsPost(req, res); return; }
  if (pathname === '/api/models' && req.method === 'PUT') { await handleModelsPut(req, res); return; }
  if (pathname === '/api/models' && req.method === 'DELETE') { await handleModelsDelete(req, res); return; }
  if (pathname === '/api/providers' && req.method === 'GET') { await handleProvidersGet(req, res); return; }
  if (pathname === '/api/providers' && req.method === 'POST') { await handleProvidersPost(req, res); return; }
  if (pathname === '/api/providers' && req.method === 'DELETE') { await handleProvidersDelete(req, res); return; }
  if (pathname === '/api/model-bindings' && req.method === 'GET') { await handleModelBindingsGet(req, res); return; }
  if (pathname === '/api/model-bindings' && req.method === 'PUT') { await handleModelBindingsPut(req, res); return; }
  if (pathname === '/api/model-bindings/remap' && req.method === 'POST') { await handleModelBindingsRemap(req, res); return; }
  if (pathname === '/api/stats-models' && req.method === 'GET') { await handleStatsModels(req, res); return; }
  if (pathname === '/api/test-model' && req.method === 'GET') { await handleTestModelGet(req, res); return; }
  if (pathname === '/api/test-model' && req.method === 'POST') { await handleTestModelPost(req, res); return; }
  if (pathname === '/api/cliproxy-models' && req.method === 'GET') { await handleCliproxyModels(req, res); return; }
  if (pathname === '/api/agents-list' && req.method === 'GET') { await handleAgentsList(req, res); return; }
  if (pathname.startsWith('/api/agent-models/') && req.method === 'GET') {
    const agentId = pathname.split('/')[3];
    await handleAgentModels(req, res, agentId);
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/ui') {
    serveStaticFile(res, path.join(FRONTEND_DIR, 'models-embed.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/models-embed.js') {
    serveStaticFile(res, path.join(FRONTEND_DIR, 'models-embed.js'), 'application/javascript; charset=utf-8');
    return;
  }

  if (pathname === '/pages/models-fragment.html') {
    serveStaticFile(res, path.join(FRONTEND_DIR, 'pages', 'models-fragment.html'), 'text/html; charset=utf-8');
    return;
  }

  // Generic static file serving
  let filePath = path.join(FRONTEND_DIR, pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    serveStaticFile(res, filePath, getContentType(ext));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('[models-manager] Uncaught error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    }
  }
}

function healthFn() {
  return true;
}

process.on('unhandledRejection', (reason) => {
  console.error('[models-manager] Unhandled rejection:', reason);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[models-manager] Running at http://${HOST}:${PORT}`);
  });
}

module.exports = {
  handler,
  healthFn,
  capabilities: [],
};
