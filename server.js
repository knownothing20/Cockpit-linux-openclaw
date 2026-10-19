process.setMaxListeners(20);
const FIXED_PORT = 7001;
const requestedPort = process.env.PORT;
if (requestedPort !== undefined && requestedPort !== String(FIXED_PORT)) {
  console.error(`[cockpit-shell] Refusing to start with PORT=${requestedPort}; this service is fixed to ${FIXED_PORT}. Use systemctl --user restart openclaw-cockpit-shell.service.`);
  process.exit(1);
}

const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');
const os = require('os');
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const fs = require('fs');
const yaml = require('js-yaml');
const { Readable, Writable } = require('stream');
const config = require('./config.json');
const configuredPort = Number(config.port);
if (!Number.isInteger(configuredPort) || configuredPort !== FIXED_PORT) {
  console.error(`[cockpit-shell] Refusing to start: config.port must be ${FIXED_PORT}.`);
  process.exit(1);
}

const { loadManifests, getNavSections } = require('./registry/app-registry');
const { createModuleProxy, createRefererFallbackProxy } = require('./registry/proxy');
const { aggregateHealth, checkModuleHealth } = require('./registry/health');
const { startAllModules, getModuleStatus, getModulePort, getModuleBaseUrl } = require('./registry/module-starter');
const { loadAllNativeModules, initAllNativeModules, disposeAllNativeModules, reloadModule, NATIVE_MODULES } = require('./registry/native-loader');
const { startEventLoopMonitor, stopEventLoopMonitor, getEventLoopLag } = require('./registry/event-loop-lag');

const app = express();
app.use(compression({ level: 6, threshold: 1024 }));
const PORT = FIXED_PORT;
const HOST = config.host || '0.0.0.0';

const DASHBOARD_CACHE_TTL = 30000;
const DASHBOARD_ENDPOINT_CACHE_TTL = 60000;
const DASHBOARD_REFRESH_DELAY_MS = 25;
let _dashboardCache = null;
let _dashboardCacheTime = 0;
let _dashboardEndpointCache = {};
let _dashboardEndpointRefresh = null;
let _dashboardRefreshTimer = null;

// Load all sub-module handlers inline (shared port 7001)
const nativeMiddlewares = loadAllNativeModules({ skipOrphanGuard: true });


function startRssWatchdog() {
  const warnMb = parseInt(process.env.RSS_WARN_MB || '800', 10);
  const dumpMb = parseInt(process.env.RSS_DUMP_MB || '1200', 10);
  const exitMb = parseInt(process.env.RSS_EXIT_MB || '1500', 10);
  let heapDumped = false;

  const timer = setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMb >= exitMb) {
      console.error(`[shell-guard] RSS ${rssMb}MB >= ${exitMb}MB, exiting`);
      if (!heapDumped) {
        try {
          require('v8').writeHeapSnapshot(`/tmp/cockpit-shell-${Date.now()}.heapsnapshot`);
          heapDumped = true;
        } catch (error) {
          console.error('[shell-guard] heap snapshot failed:', error.message);
        }
      }
      process.exit(2);
    }
    if (rssMb >= dumpMb && !heapDumped) {
      console.error(`[shell-guard] RSS ${rssMb}MB >= ${dumpMb}MB, dumping heap snapshot`);
      try {
        require('v8').writeHeapSnapshot(`/tmp/cockpit-shell-${Date.now()}.heapsnapshot`);
        heapDumped = true;
      } catch (error) {
        console.error('[shell-guard] heap snapshot failed:', error.message);
      }
      return;
    }
    if (rssMb >= warnMb) {
      console.warn(`[shell-guard] RSS ${rssMb}MB >= ${warnMb}MB warning`);
    }
  }, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

console.log(`[cockpit-shell] Native modules loaded: ${Object.keys(nativeMiddlewares).join(', ')}`);

function fetchWithTimeout(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('Timeout'));
    }, timeout);
    req = http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function callNativeJson(moduleId, requestPath, timeout = 1000) {
  const middleware = nativeMiddlewares[moduleId];
  if (!middleware) {
    return Promise.reject(new Error(`Native module ${moduleId} is not loaded`));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      done(reject, new Error('Timeout'));
    }, timeout);
    if (typeof timer.unref === 'function') timer.unref();

    const req = new Readable({ read() { this.push(null); } });
    req.method = 'GET';
    req.url = requestPath;
    req.originalUrl = `/apps/${moduleId}${requestPath}`;
    req.baseUrl = `/apps/${moduleId}`;
    req.headers = {
      accept: 'application/json',
      host: `127.0.0.1:${PORT}`,
      'user-agent': 'cockpit-dashboard-inmemory',
    };
    req.connection = req.socket = {
      encrypted: false,
      remoteAddress: '127.0.0.1',
      remotePort: 0,
      destroy: () => {},
    };

    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
      },
    });
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.locals = {};
    res.req = req;
    res.socket = { writable: true, cork: () => {}, uncork: () => {}, destroy: () => {} };
    req.res = res;

    const headers = {};
    res.setHeader = (name, value) => { headers[String(name).toLowerCase()] = value; return res; };
    res.getHeader = (name) => headers[String(name).toLowerCase()];
    res.getHeaders = () => ({ ...headers });
    res.removeHeader = (name) => { delete headers[String(name).toLowerCase()]; };
    res.writeHead = (statusCode, statusMessage, headerValues) => {
      res.statusCode = statusCode;
      if (typeof statusMessage === 'string') res.statusMessage = statusMessage;
      const extraHeaders = typeof statusMessage === 'object' ? statusMessage : headerValues;
      if (extraHeaders) {
        for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
      }
      return res;
    };
    res.write = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof callback === 'function') callback();
      return true;
    };
    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof callback === 'function') callback();
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        done(resolve, body ? JSON.parse(body) : {});
      } catch (error) {
        done(reject, new Error(`Parse error: ${error.message}`));
      }
      res.emit('finish');
      return res;
    };

    try {
      middleware(req, res, (error) => {
        if (error) {
          done(reject, error instanceof Error ? error : new Error(String(error)));
        } else {
          done(reject, new Error(`No native route handled ${moduleId}${requestPath}`));
        }
      });
    } catch (error) {
      done(reject, error);
    }
  });
}

async function fetchDashboardEndpoint(endpoint) {
  if (endpoint.source === 'health') {
    return aggregateHealth(config.healthTimeout || 2000, 13);
  }
  if (endpoint.moduleId && endpoint.path) {
    return callNativeJson(endpoint.moduleId, endpoint.path, endpoint.timeout || 1000);
  }
  return fetchWithTimeout(endpoint.url, endpoint.timeout || 3000);
}

let _lastCpuTimes = null;
let _lastCpuPercent = 0;

function readCpuTimes() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function getCpuPercent() {
  const now = readCpuTimes();
  if (!_lastCpuTimes) {
    _lastCpuTimes = now;
    return 0;
  }
  const totalDiff = now.total - _lastCpuTimes.total;
  const idleDiff = now.idle - _lastCpuTimes.idle;
  _lastCpuTimes = now;
  if (totalDiff <= 0) return _lastCpuPercent;
  const pct = Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
  _lastCpuPercent = Math.max(0, Math.min(100, pct));
  return _lastCpuPercent;
}

// Pre-warm CPU baseline on startup
readCpuTimes();

function getSystemStats() {
  const cpuPercent = getCpuPercent();

  const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024;
  const memAvailable = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
  const memUsed = memTotal - memAvailable;
  const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

  const stat = fs.statfsSync('/');
  const diskTotal = stat.blocks * stat.bsize;
  const diskFree = stat.bavail * stat.bsize;
  const diskUsed = diskTotal - diskFree;
  const diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  return {
    cpu: { percent: cpuPercent, load: os.loadavg()[0].toFixed(2) },
    memory: { total: memTotal, used: memUsed, percent: memPercent },
    disk: { total: diskTotal, used: diskUsed, percent: diskPercent }
  };
}

app.use(express.json({ limit: '1mb' }));

let crashCount = 0;
process.on('uncaughtException', (err) => {
  crashCount++;
  console.error(`[crash] uncaughtException #${crashCount}:`, err && err.stack || err);
  if (crashCount >= 5) {
    console.error('[crash] too many uncaught exceptions, exiting for systemd restart');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[crash] unhandledRejection:', reason && reason.stack || reason);
});

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const cspHosts = `http://127.0.0.1:* http://localhost:* http://${req.hostname}:*`;
  res.setHeader('Content-Security-Policy', `frame-src 'self' ${cspHosts}; connect-src 'self' ${cspHosts}`);
  next();
});

app.use((req, res, next) => {
  const allowedOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://${req.hostname}:${PORT}`];
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use((req, res, next) => {
  if (!req.path.match(/\.(css|js|png|jpg|svg|ico|woff2|map)$/)) {
    console.log(`[cockpit-shell] ${req.method} ${req.originalUrl}`);
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'openclaw-cockpit-shell',
    timestamp: new Date().toISOString(),
    eventLoop: getEventLoopLag(),
  });
});

function getDashboardEndpoints() {
  return [
    // v2.3.127: aiStats 原来是同步全量扫 ~/.openclaw/agents 下的 session 日志（2.23GB / 10110 个
    // jsonl，实测单次 23.8s），把 Shell 的事件循环整段锁死。现在 handler 已改为
    // stale-while-revalidate + 异步 + 按文件 (size,mtime) 增量索引，正常路径是亚毫秒。
    // 这里把超时从 1s 放宽到 5s，只为兜住「磁盘索引存在、增量扫描偏慢」的冷启动那一下。
    { key: 'aiStats', moduleId: 'models-manager', path: '/api/stats-models', timeout: 5000 },
    { key: 'models', moduleId: 'models-manager', path: '/api/models-list' },
    { key: 'docs', moduleId: 'file-manager', path: '/api/docs-stats' },
    { key: 'rules', moduleId: 'workspace-rule-panel', path: '/api/check?mode=quick' },
    { key: 'shares', moduleId: 'file-manager', path: '/recent' },
    { key: 'skills', moduleId: 'skill-manager', path: '/api/skills/overview' },
    { key: 'configCenter', moduleId: 'config-recovery', path: '/api/config-center/overview' },
    { key: 'robots', moduleId: 'robots', path: '/api/agents' },
  ];
}

function isDashboardEndpointFresh(entry, now = Date.now()) {
  return entry && (now - entry.updatedAt) < DASHBOARD_ENDPOINT_CACHE_TTL;
}

async function refreshDashboardEndpointCache(endpoints) {
  if (_dashboardEndpointRefresh) return _dashboardEndpointRefresh;
  _dashboardEndpointRefresh = (async () => {
    // v2.3.127: 逐个端点串行刷新，并在每个端点之前让出一次事件循环。
    // 模块是以 in-process 中间件挂进来的、handler 本身是同步的，而 callNativeJson()
    // 的 timeout 在同步阻塞下根本抢不动它。原来的 Promise.allSettled(endpoints.map(...))
    // 会把 11 个同步 handler 挤在同一个宏任务里连续跑完 —— 实测整批独占事件循环约 25s，
    // 期间连模块 iframe 自己的 HTML 请求都要排队到刷新结束；浏览器把 iframe 留在
    // about:blank，用户看到的就是"点开模块是一片白"。
    // 每个端点前 setImmediate 让出一次，单次阻塞就从"整批"压缩到"最慢的单个模块"。
    const results = [];
    for (const ep of endpoints) {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        const data = await fetchDashboardEndpoint(ep);
        results.push({ status: 'fulfilled', value: { key: ep.key, value: { status: 'ok', data } } });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }
    }
    const updatedAt = Date.now();
    for (let i = 0; i < endpoints.length; i += 1) {
      const key = endpoints[i].key;
      const result = results[i];
      if (result.status === 'fulfilled') {
        _dashboardEndpointCache[key] = { ...result.value.value, updatedAt };
      } else {
        _dashboardEndpointCache[key] = {
          status: 'unavailable',
          error: result.reason && result.reason.message ? result.reason.message : 'unavailable',
          updatedAt,
        };
      }
    }
    _dashboardCache = null;
    _dashboardCacheTime = 0;
  })().finally(() => {
    _dashboardEndpointRefresh = null;
  });
  return _dashboardEndpointRefresh;
}

function scheduleDashboardEndpointRefresh(endpoints) {
  if (_dashboardEndpointRefresh || _dashboardRefreshTimer) return;
  _dashboardRefreshTimer = setTimeout(() => {
    _dashboardRefreshTimer = null;
    refreshDashboardEndpointCache(endpoints).catch((error) => {
      console.error('[dashboard] background refresh failed:', error.message);
    });
  }, DASHBOARD_REFRESH_DELAY_MS);
  if (typeof _dashboardRefreshTimer.unref === 'function') _dashboardRefreshTimer.unref();
}

async function buildDashboardSnapshot({ forceRefresh = false } = {}) {
  const endpoints = getDashboardEndpoints();
  const now = Date.now();
  const dashboard = {};
  let needsRefresh = forceRefresh;

  try {
    dashboard.health = { status: 'ok', data: await fetchDashboardEndpoint({ source: 'health' }) };
  } catch (error) {
    dashboard.health = { status: 'unavailable', error: error.message };
  }

  for (const ep of endpoints) {
    const cached = _dashboardEndpointCache[ep.key];
    if (isDashboardEndpointFresh(cached, now) || cached) {
      dashboard[ep.key] = {
        status: cached.status,
        data: cached.data,
        error: cached.error,
        stale: !isDashboardEndpointFresh(cached, now),
      };
      if (!isDashboardEndpointFresh(cached, now)) needsRefresh = true;
    } else {
      dashboard[ep.key] = { status: 'unavailable', error: 'refresh pending', refreshing: true };
      needsRefresh = true;
    }
  }

  try {
    const systemStats = getSystemStats();
    dashboard.system = { status: 'ok', data: systemStats };
  } catch (e) {
    dashboard.system = { status: 'unavailable', error: e.message };
  }

  dashboard.cachedAt = new Date().toISOString();
  dashboard.refreshing = Boolean(needsRefresh || _dashboardEndpointRefresh);
  if (needsRefresh) scheduleDashboardEndpointRefresh(endpoints);
  _dashboardCache = dashboard;
  _dashboardCacheTime = Date.now();
  return dashboard;
}

app.get('/api/dashboard', async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === 'true';
  if (!forceRefresh && _dashboardCache && (now - _dashboardCacheTime) < DASHBOARD_CACHE_TTL) {
    return res.json(_dashboardCache);
  }

  try {
    res.json(await buildDashboardSnapshot({ forceRefresh }));
  } catch (err) {
    res.status(500).json({ error: 'Dashboard refresh failed' });
  }
});

app.get('/api/apps', (req, res) => {
  try {
    const manifests = loadManifests();
    res.json(manifests.map(m => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      type: m.type,
      navSection: m.navSection,
      integration: m.integration,
      mountPath: m.mountPath,
      embedPath: m.embedPath,
      capabilities: m.capabilities,
      showInNav: m.showInNav,
      nativeReady: m.nativeReady,
    })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load modules' });
  }
});

app.get('/api/apps/health', async (req, res) => {
  try {
    const result = await aggregateHealth(config.healthTimeout || 2000, 13);
    res.json(Object.assign({}, result, { eventLoop: getEventLoopLag() }));
  } catch (e) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.get('/api/apps/:id/health', async (req, res) => {
  const { loadManifests } = require('./registry/app-registry');
  const manifests = loadManifests();
  const module = manifests.find(m => m.id === req.params.id);
  if (!module) return res.status(404).json({ error: 'Module not found' });
  try {
    const result = await checkModuleHealth(module, config.healthTimeout || 2000);
    res.json({ id: module.id, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

// Module local static files
const modulesDir = path.join(__dirname, 'shell-ui', 'modules');

// Lock legacy duplicate entrypoints: fold old sub-module public entry routes into unified shell module route
app.get(['/apps/:moduleId/public', '/apps/:moduleId/public/', '/apps/:moduleId/public/index.html'], (req, res) => {
  const moduleId = req.params.moduleId;
  res.redirect(302, `/apps/${moduleId}/`);
});


// Canonicalize historical module html paths to unified apps embed route
app.get(['/modules/:moduleId', '/modules/:moduleId/', '/modules/:moduleId/index.html'], (req, res) => {
  const moduleId = req.params.moduleId;
  res.redirect(302, `/apps/${moduleId}/?__embed=1`);
});

function isEmbeddedModuleRequest(req) {
  const secFetchDest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
  if (secFetchDest) return secFetchDest === 'iframe';
  return String(req.query.__embed || '') === '1';
}

// In-memory cache for processed module HTML (invalidated on file change)
const _moduleHtmlCache = new Map();

function serveModuleHtml(req, res, moduleIndex, isIframe, moduleId) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (!isIframe) {
    return res.sendFile(path.join(__dirname, 'shell-ui', 'index.html'));
  }

  // Check in-memory cache first
  try {
    const stat = fs.statSync(moduleIndex);
    const mtime = stat.mtimeMs;
    const cacheKey = moduleIndex;
    const cached = _moduleHtmlCache.get(cacheKey);
    if (cached && cached.mtime === mtime) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(cached.html);
    }
  } catch (_) { /* cache miss, proceed to read */ }

  fs.readFile(moduleIndex, 'utf8', (err, html) => {
    if (err) {
      return res.status(500).send('Module load error');
    }

    let result = html;
    if (!result.trim().endsWith('</html>')) {
      if (result.trim().endsWith('</html')) {
        result = result.replace(/<\/html\s*$/, '</html>');
      } else {
        result += '\n</html>';
      }
    }

    const hasTheme = result.includes('unified-theme.css');
    const hasComponents = result.includes('unified-components.css');
    const hasBase = result.includes('base href');
    const hasApiRewrite = result.includes('var P=');
    const hasThemeBridge = result.includes('openclaw-theme-bridge-v2');
    const hasLangScript = result.includes('openclaw-lang');

    if (hasTheme && hasComponents && hasBase && hasApiRewrite && hasThemeBridge && hasLangScript) {
      // already fully injected
    } else {
      let inject = '';
      if (!hasBase) {
        inject += `<base href="/apps/${moduleId}/">`;
      }
      if (!hasApiRewrite) {
        inject += `<script>(function(){var P='/apps/${moduleId}';var OF=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&!u.startsWith(P)&&!u.startsWith('/apps/')&&!u.startsWith('/unified-theme')&&!u.startsWith('/unified-components')&&!u.startsWith('/shell.')&&!u.startsWith('/i18n.')&&!u.startsWith('/profile-switcher')&&!u.startsWith('/api/hermes')){u=P+u;}return OF.call(this,u,o);};var OX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&u.charAt(0)==='/'&&!u.startsWith(P)&&!u.startsWith('/apps/')&&!u.startsWith('/unified-theme')&&!u.startsWith('/unified-components')&&!u.startsWith('/shell.')&&!u.startsWith('/i18n.')&&!u.startsWith('/profile-switcher')&&!u.startsWith('/api/hermes')){u=P+u;}return OX.apply(this,arguments);};var OE=window.EventSource;if(OE){window.EventSource=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&!u.startsWith(P)&&!u.startsWith('/apps/')&&!u.startsWith('/unified-theme')&&!u.startsWith('/unified-components')&&!u.startsWith('/shell.')&&!u.startsWith('/i18n.')&&!u.startsWith('/profile-switcher')&&!u.startsWith('/api/hermes')){u=P+u;}return new OE(u,o);};}var OS=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==='href'||n==='src'||n==='action')&&typeof v==='string'&&v.charAt(0)==='/'&&!v.startsWith(P)&&!v.startsWith('/apps/')&&!v.startsWith('/unified-theme')&&!v.startsWith('/public/')&&!v.startsWith('/api/hermes')){v=P+v;}return OS.call(this,n,v);};})();</script>`;
      }
      /* A.2: muted -- CSS inject handled by stub files
      if (!hasTheme) {
        inject += `<link rel="stylesheet" href="/unified-theme.css">`;
      }
      */
      /* A.2: muted -- CSS inject handled by stub files
      if (!hasComponents) {
        inject += `<link rel="stylesheet" href="/unified-components.css">`;
      }
      */
      if (!hasThemeBridge) {
        inject += `<script data-openclaw-theme-bridge-v2=true>(function(){var V={light:1,dark:1};var PK='openclaw-profile';var TK='openclaw-theme';function gp(){try{var p=localStorage.getItem(PK)||'openclaw';return p==='hermes'||p==='openclaw'?p:'openclaw';}catch(e){return 'openclaw';}}function sk(p){return TK+':'+(p||gp());}function rt(p){try{var t=localStorage.getItem(sk(p))||localStorage.getItem(TK);return V[t]?t:'dark';}catch(e){return 'dark';}}function pt(t,p){if(!V[t])return;try{localStorage.setItem(sk(p),t);localStorage.setItem(TK,t);}catch(e){}}function at(t,p){if(!V[t])return;document.documentElement.setAttribute('data-theme',t);pt(t,p);}function rq(){try{if(window.parent&&window.parent!==window){window.parent.postMessage({type:'openclaw-theme-request',profile:gp()},location.origin);}}catch(e){}}at(rt());window.addEventListener('message',function(e){var d=e.data||{};if(d.type==='openclaw-theme'&&V[d.theme]){at(d.theme,d.profile);}if(d.type==='openclaw-design'&&V[d.theme]){at(d.theme,d.profile);}if(d.type==='openclaw-profile'&&(d.profile==='openclaw'||d.profile==='hermes')){try{localStorage.setItem(PK,d.profile);}catch(x){}at(rt(d.profile),d.profile);rq();}});if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',rq,{once:true});}rq();setTimeout(rq,80);})();</script>`;
      }
      if (!hasLangScript) {
        inject += `<script>(function(){var l=localStorage.getItem('openclaw-lang')||'zh';document.documentElement.setAttribute('lang',l==='zh'?'zh-CN':'en');window.addEventListener('message',function(e){if(e.data&&e.data.type==='openclaw-lang'){var lang=e.data.lang;if(lang==='zh'||lang==='en'){localStorage.setItem('openclaw-lang',lang);document.documentElement.setAttribute('lang',lang==='zh'?'zh-CN':'en');if(typeof window.onShellLangChange==='function'){window.onShellLangChange(lang);}}}});})();</script>`;
      }
      const hasProfileScript = result.includes('openclaw-profile');
      if (!hasProfileScript) {
        inject += `<script>(function(){window.addEventListener('message',function(e){if(e.data&&e.data.type==='openclaw-profile'){var p=e.data.profile;if(p==='openclaw'||p==='hermes'){localStorage.setItem('openclaw-profile',p);if(typeof window.ProfileSwitcher!=='undefined'){ProfileSwitcher.setProfile(p);}document.querySelectorAll('.profile-switcher .ps-btn').forEach(function(btn){btn.classList.toggle('active',btn.dataset.profile===p);});var evt=new CustomEvent('profile-change',{detail:{profile:p}});document.dispatchEvent(evt);}}});})();</script>`;
      }
      // v2.3.124: v2.3.123 改成方案 C — 子页面复用 shell 顶栏, 自身不再渲染 lang/theme.
      // 注入 cockpit-embedded-module 类到 <html> (跟 polish.js 同步), 让 CSS 在首帧就能
      // 触发 .oc-ph-main { padding-top:56px } 和隐藏 .oc-ph-side 工具栏.
      if (!result.includes('cockpit-embedded-module')) {
        inject += `<script>document.documentElement.classList.add('cockpit-embedded-module');</script>`;
      }

      if (inject) {
        const headPos = result.indexOf('<head');
        if (headPos !== -1) {
          const insertAfter = result.indexOf('>', headPos);
          if (insertAfter !== -1) {
            result = result.slice(0, insertAfter + 1) + inject + result.slice(insertAfter + 1);
          }
        }
      }
    }

    // Cache the processed HTML in memory (keyed by file mtime for auto-invalidation)
    try {
      const stat = fs.statSync(moduleIndex);
      _moduleHtmlCache.set(moduleIndex, { html: result, mtime: stat.mtimeMs });
    } catch (_) { /* non-critical */ }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(result);
  });
}

// Module HTML routes - MUST come before native middleware so shell handles HTML pages
// with proper theme injection, Referer detection, and SPA fallback
app.get('/apps/:moduleId/', (req, res, next) => {
  const moduleId = req.params.moduleId;
  const moduleIndex = path.join(modulesDir, moduleId, 'index.html');

  if (!fs.existsSync(moduleIndex)) {
    return next();
  }

  const isIframe = isEmbeddedModuleRequest(req);

  serveModuleHtml(req, res, moduleIndex, isIframe, moduleId);
});

app.get('/apps/:moduleId/index.html', (req, res, next) => {
  const moduleId = req.params.moduleId;
  const moduleIndex = path.join(modulesDir, moduleId, 'index.html');

  if (!fs.existsSync(moduleIndex)) {
    return next();
  }

  const isIframe = isEmbeddedModuleRequest(req);

  serveModuleHtml(req, res, moduleIndex, isIframe, moduleId);
});

// Non-index module HTML files (e.g. tasks-embed.html) - inject theme/base/API-rewrite
app.get('/apps/:moduleId/:htmlFile([\\w-]+\\.html)', (req, res, next) => {
  const moduleId = req.params.moduleId;
  const htmlFile = req.params.htmlFile;
  const moduleHtml = path.join(modulesDir, moduleId, htmlFile);

  if (!fs.existsSync(moduleHtml)) {
    return next();
  }

  const isIframe = isEmbeddedModuleRequest(req);

  serveModuleHtml(req, res, moduleHtml, isIframe, moduleId);
});

// Native module routes - handlers loaded inline on port 7001
// Only handles API and non-HTML requests; HTML pages are handled above
for (const [moduleId, middleware] of Object.entries(nativeMiddlewares)) {
  app.use(`/apps/${moduleId}`, middleware);
}

// Serve static files inside each module directory (CSS, JS, images, etc.)
// Use a custom middleware to only serve files, not directories
app.use('/apps', (req, res, next) => {
  if (req.path.endsWith('/') || !req.path.includes('.')) {
    return next();
  }
  const filePath = path.join(modulesDir, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    if (ext === '.css' || ext === '.js') {
      // Versioned resources (cache-bust param) get long cache; unversioned get no-cache
      if (/[?&]v=/.test(req.originalUrl || req.url)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    } else if (ext === '.html' || ext === '.htm') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (ext === '.png' || ext === '.jpg' || ext === '.svg' || ext === '.ico' || ext === '.woff2') {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
    return res.sendFile(filePath);
  }
  next();
});

// Module proxy routes - fallback for modules not yet native
app.use('/apps', createModuleProxy());
app.use('/api/proxy', createModuleProxy());

// Static files for shell UI root (unified-theme.css, shell.css, shell.js, etc.)
// Detect versioned requests before express.static so setHeaders can use the flag
app.use((req, res, next) => {
  res.locals._hasCacheBust = /[?&]v=/.test(req.originalUrl || req.url);
  next();
});
app.use(express.static(path.join(__dirname, 'shell-ui'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    if (ext === '.css' || ext === '.js') {
      if (res.locals._hasCacheBust) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    } else if (ext === '.html' || ext === '.htm') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (ext === '.png' || ext === '.jpg' || ext === '.svg' || ext === '.ico' || ext === '.woff2') {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// Referer-based fallback proxy: when module iframe JS makes absolute-path requests
// (e.g. fetch('/api/xxx') or <script src="/xxx.js">), the Referer header tells us
// which module to proxy to
app.use(createRefererFallbackProxy());

// API: Module process management
app.get('/api/modules/status', (req, res) => {
  const nativeIds = Object.keys(nativeMiddlewares);
  const proxyStatus = getModuleStatus();
  const modules = {};
  // Native modules share the shell process
  for (const id of nativeIds) {
    modules[id] = { pid: process.pid, port: PORT, native: true };
  }
  // Proxy modules still have independent processes
  for (const [id, info] of Object.entries(proxyStatus)) {
    if (!nativeIds.includes(id)) {
      modules[id] = { ...info, native: false };
    }
  }
  res.json({
    shell: { pid: process.pid, port: PORT },
    modules,
  });
});

// 模块热重启：dispose → 清 require 缓存 → 重新加载 → init
app.post('/api/modules/:id/restart', async (req, res) => {
  if (!NATIVE_MODULES[req.params.id]) {
    res.status(404).json({ ok: false, error: 'unknown module' });
    return;
  }
  const result = await reloadModule(req.params.id);
  res.status(result.ok ? 200 : 500).json(result);
});

function hermesReadConfig() {
  const cfgPath = path.join(HERMES_HOME, 'config.yaml');
  if (!fs.existsSync(cfgPath)) return null;
  try { return yaml.load(fs.readFileSync(cfgPath, 'utf8')); } catch { return null; }
}

function hermesReadEnv() {
  const envPath = path.join(HERMES_HOME, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

function hermesReadSoul() {
  const soulPath = path.join(HERMES_HOME, 'SOUL.md');
  if (!fs.existsSync(soulPath)) return '';
  return fs.readFileSync(soulPath, 'utf8');
}

function hermesListDir(sub) {
  const dir = path.join(HERMES_HOME, sub);
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')); } catch { return []; }
}

function hermesReadJsonFiles(sub) {
  const files = hermesListDir(sub);
  const items = [];
  for (const f of files) {
    const fp = path.join(HERMES_HOME, sub, f);
    try {
      const stat = fs.statSync(fp);
      if (f.endsWith('.json')) {
        items.push({ ...JSON.parse(fs.readFileSync(fp, 'utf8')), _file: f, _mtime: stat.mtimeMs });
      } else if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        items.push({ ...yaml.load(fs.readFileSync(fp, 'utf8')), _file: f, _mtime: stat.mtimeMs });
      } else if (f.endsWith('.md')) {
        items.push({ name: f.replace(/\.md$/, ''), content: fs.readFileSync(fp, 'utf8'), _file: f, _mtime: stat.mtimeMs });
      }
    } catch {}
  }
  return items;
}

function hermesGatewayRunning() {
  try {
    const statePath = path.join(HERMES_HOME, 'gateway_state.json');
    if (!fs.existsSync(statePath)) return false;
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return data && data.gateway_state === 'running';
  } catch {
    return false;
  }
}

app.get('/api/hermes/status', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json({ available: false, reason: 'no config' });
  res.json({
    available: true,
    version: 'file-based',
    hermesHome: HERMES_HOME,
    model: cfg.model || '',
    openaiBaseUrl: cfg.openai_base_url || '',
    gateway_running: hermesGatewayRunning(),
    activeSessions: hermesListDir('sessions').length,
    skillCount: hermesListDir('skills').length,
    cronCount: hermesListDir('cron').length,
    memoryCount: hermesListDir('memories').length,
  });
});

app.get('/api/hermes/models-list', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json({ providers: [], agents: [], defaults: {} });
  const modelStr = cfg.model || '';
  const [prov, modelId] = modelStr.includes(':') ? modelStr.split(':') : ['', modelStr];
  const provider = {
    id: prov || 'default',
    api: prov || 'openai',
    accessMode: 'api_key',
    models: [{
      id: modelId || 'unknown',
      name: modelId || 'unknown',
      contextWindow: cfg.agent?.max_context_length || 128000,
      contextConfigured: false,
      reasoning: false,
      hasImageSupport: false,
      usedBy: [],
    }],
    usedBy: [],
  };
  res.json({
    providers: [provider],
    agents: [],
    defaults: { model: modelStr, fallbacks: cfg.fallback_providers || [] },
  });
});

app.get('/api/hermes/model/info', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json({});
  res.json({
    model: cfg.model || '',
    provider: '',
    openaiBaseUrl: cfg.openai_base_url || '',
    agent: cfg.agent || {},
    terminal: cfg.terminal || {},
  });
});

app.get('/api/hermes/skills', (req, res) => {
  const skills = hermesReadJsonFiles('skills');
  const mapped = skills.map(s => ({
    id: s.name || s._file,
    name: s.name || s._file,
    description: s.description || s.content?.substring(0, 120) || '',
    source: 'hermes',
    version: s.version || '',
    category: s.category || 'hermes',
    status: 'available',
    emoji: s.emoji || '🔧',
    location: path.join(HERMES_HOME, 'skills', s._file),
  }));
  res.json({ skills: mapped });
});

app.get('/api/hermes/skills/overview', (req, res) => {
  const skills = hermesReadJsonFiles('skills');
  const categories = {};
  for (const s of skills) { const c = s.category || 'other'; categories[c] = (categories[c] || 0) + 1; }
  res.json({
    total: skills.length,
    withMeta: skills.filter(s => s.description).length,
    withDependencies: 0,
    totalDiskBytes: 0,
    categories,
    sources: { hermes: skills.length },
  });
});

app.get('/api/hermes/cron/jobs', (req, res) => {
  const jobs = hermesReadJsonFiles('cron');
  const mapped = jobs.map(j => ({
    id: j.id || j.name || j._file,
    name: j.name || j._file,
    agentId: j.agentId || j.agent_id || '',
    schedule: j.schedule || { kind: 'cron', expr: j.cron || '', tz: j.tz || 'UTC' },
    payload: j.payload || { kind: 'agent', message: j.message || j.prompt || '' },
    enabled: j.enabled !== false,
    state: j.state || {},
  }));
  res.json({ jobs: mapped });
});

app.get('/api/hermes/sessions', (req, res) => {
  const sessions = hermesReadJsonFiles('sessions');
  const mapped = sessions.map(s => ({
    key: s.key || s.id || s._file,
    label: s.label || s.name || s._file,
    displayName: s.displayName || s.label || s.name || s._file,
    status: s.status || 'idle',
    agentId: s.agentId || s.agent_id || '',
    channel: s.channel || 'cli',
    updatedAt: s.updatedAt || s.updated_at || null,
    createdAt: s.createdAt || s.created_at || null,
    totalTokens: s.totalTokens || s.total_tokens || 0,
  }));
  res.json({ sessions: mapped, total: mapped.length, returned: mapped.length });
});

app.get('/api/hermes/sessions/agents', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json([]);
  res.json([{ agent: 'hermes-default', sessionCount: hermesListDir('sessions').length, totalSize: 0 }]);
});

app.get('/api/hermes/session-summary/list', (req, res) => {
  res.json([]);
});

app.get('/api/hermes/session-summary/:id', (req, res) => {
  res.json({});
});

app.get('/api/hermes/agents', (req, res) => {
  const cfg = hermesReadConfig();
  const soul = hermesReadSoul();
  const agent = {
    id: 'hermes-default',
    name: 'Hermes Agent',
    emoji: '⚡',
    state: 'idle',
    fullModel: cfg?.model || '',
    session: {
      totalTokens: 0,
      messageCount: 0,
      sessionCount: hermesListDir('sessions').length,
      todayAvgResponseMs: 0,
      lastActive: null,
    },
    currentActivity: null,
    subagents: [],
    recentSubagents: [],
    cronJobs: hermesReadJsonFiles('cron').map(j => ({
      label: j.name || j._file,
      consecutiveFailures: 0,
      lastStatus: 'unknown',
      nextRun: '',
    })),
    health: { score: 100, level: 'healthy', issues: [] },
    soul: soul.substring(0, 200),
  };
  res.json({ agents: [agent], defaults: {}, gateway: { port: null } });
});

app.get('/api/hermes/memories', (req, res) => {
  const memories = hermesReadJsonFiles('memories');
  res.json({ memories, total: memories.length });
});

app.get('/api/hermes/config', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json({});
  const env = hermesReadEnv();
  res.json({ config: cfg, envKeys: Object.keys(env), hasEnv: Object.keys(env).length > 0 });
});

app.get('/api/hermes/tools/toolsets', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json([]);
  const toolsets = cfg.toolsets || ['hermes-cli'];
  const disabled = cfg.agent?.disabled_toolsets || [];
  res.json(toolsets.filter(t => !disabled.includes(t)).map(t => ({
    name: t,
    label: t,
    enabled: true,
    available: true,
    configured: true,
    tools: [],
  })));
});

app.get('/api/hermes/profiles', (req, res) => {
  const cfg = hermesReadConfig();
  const soul = hermesReadSoul();
  res.json({
    profiles: [{
      name: 'default',
      path: HERMES_HOME,
      is_default: true,
      model: cfg?.model || '',
      provider: null,
      has_env: fs.existsSync(path.join(HERMES_HOME, '.env')),
      skill_count: hermesListDir('skills').length,
      soul_preview: soul.substring(0, 100),
    }],
  });
});

app.put('/api/hermes/config', express.json({ limit: '1mb' }), (req, res) => {
  const cfgPath = path.join(HERMES_HOME, 'config.yaml');
  try {
    const existing = hermesReadConfig() || {};
    const merged = { ...existing, ...req.body };
    fs.writeFileSync(cfgPath, yaml.dump(merged), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/hermes/soul', express.text({ limit: '1mb' }), (req, res) => {
  const soulPath = path.join(HERMES_HOME, 'SOUL.md');
  try {
    fs.writeFileSync(soulPath, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/hermes/config-center/overview', (req, res) => {
  const cfg = hermesReadConfig();
  if (!cfg) return res.json({ error: 'no config' });
  const soul = hermesReadSoul();
  res.json({
    hasConfig: true,
    configPath: path.join(HERMES_HOME, 'config.yaml'),
    soulPath: path.join(HERMES_HOME, 'SOUL.md'),
    hasSoul: soul.length > 0,
    model: cfg.model || '',
    provider: cfg.openai_base_url || '',
    skillCount: hermesListDir('skills').length,
    cronCount: hermesListDir('cron').length,
    sessionCount: hermesListDir('sessions').length,
    memoryCount: hermesListDir('memories').length,
    toolsets: (cfg.toolsets || []).length,
    mcpServers: Object.keys(cfg.mcp_servers || {}).length,
  });
});

app.get('/api/hermes/config-center/changes', (req, res) => {
  res.json({ changes: [], total: 0, today: 0, thisWeek: 0 });
});

app.get('/api/hermes/config-center/mapping', (req, res) => {
  res.json({ mapping: {}, fields: [] });
});

// SPA catch-all: only serve index.html for non-API, non-apps routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/apps/') || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'shell-ui', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[server] Error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server - native modules are already loaded inline
const server = app.listen(PORT, HOST, async () => {
  console.log(`[cockpit-shell] Running at http://${HOST}:${PORT}`);
  console.log(`[cockpit-shell] Native modules inline: ${Object.keys(nativeMiddlewares).join(', ')}`);
  startEventLoopMonitor();
  try {
    await initAllNativeModules();
    console.log('[cockpit-shell] Native modules initialized');
  } catch (e) {
    console.error('[cockpit-shell] Native module init error:', e.message);
  }
  startRssWatchdog();
});

async function shutdown(signal) {
  console.log(`[cockpit-shell] ${signal} received, disposing modules...`);
  stopEventLoopMonitor();
  try {
    await disposeAllNativeModules();
  } catch (e) {
    console.error('[cockpit-shell] Dispose error:', e.message);
  }
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
