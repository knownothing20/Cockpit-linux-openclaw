const path = require('path');

const SUB_MODULES_DIR = path.join(__dirname, '..', 'sub-modules');
let loadedNativeMiddlewares = {};
let loadErrors = {};
let lifecycles = {};

function installNativeLoaderOrphanGuard(options = {}) {
  if (require.main === module) {
    console.error('[native-loader] This module must be loaded by server.js, not invoked directly.');
    process.exit(1);
  }
  if (options.skipOrphanGuard) return;

  const guardMs = parseInt(process.env.NATIVE_LOADER_ORPHAN_GUARD_MS || '5000', 10);
  const timer = setTimeout(() => {
    if (typeof process._getActiveHandles !== 'function') {
      return;
    }
    const serverHandles = process._getActiveHandles().filter((handle) => {
      return handle && handle.constructor && handle.constructor.name === 'Server';
    });
    if (serverHandles.length === 0) {
      console.error('[native-loader] No server is listening after native modules loaded. Exiting likely orphan probe.');
      process.exit(1);
    }
  }, guardMs);
  if (typeof timer.unref === 'function') timer.unref();
}

const NATIVE_MODULES = {
  'models-manager':     path.join(SUB_MODULES_DIR, 'openclaw-models-manager', 'server.js'),
  'config-recovery':    path.join(SUB_MODULES_DIR, 'config-recovery', 'server.js'),
  'file-manager':       path.join(SUB_MODULES_DIR, 'file-manager', 'src', 'server.js'),
  'skill-manager':      path.join(SUB_MODULES_DIR, 'skill-manager', 'server.js'),
  'workspace-rule-panel': path.join(SUB_MODULES_DIR, 'workspace-rule-panel', 'server.js'),
  'robots':             path.join(SUB_MODULES_DIR, 'robots', 'src', 'server.js'),
  'applist':            path.join(SUB_MODULES_DIR, 'applist', 'server.js'),
  'memory':             path.join(SUB_MODULES_DIR, 'memory', 'src', 'server.js'),
};

// B-M3.6: 删除 http.createServer monkey-patch 兜底，契约强制化。
// 仅接受两种导出形态：lifecycle 对象（{ handler, init, dispose, ... }）或直接 handler 函数。
function captureHandler(moduleId, serverPath) {
  delete require.cache[require.resolve(serverPath)];
  let exported = null;
  try {
    exported = require(serverPath);
  } catch (e) {
    loadErrors[moduleId] = e.message;
    console.error(`[native-loader] Failed to load ${moduleId}:`, e.message);
    return null;
  }

  if (exported && typeof exported === 'object' && typeof exported.handler === 'function') {
    lifecycles[moduleId] = {
      init: exported.init || null,
      dispose: exported.dispose || null,
      healthFn: exported.healthFn || null,
      capabilities: exported.capabilities || [],
    };
    console.log(`[native-loader] ${moduleId} lifecycle export captured`);
    return exported.handler;
  }

  if (typeof exported === 'function') {
    console.log(`[native-loader] ${moduleId} exported handler captured`);
    return exported;
  }

  loadErrors[moduleId] = 'module does not export lifecycle object { handler } or direct handler function';
  console.error(`[native-loader] ${moduleId} rejected: missing handler export`);
  return null;
}

function wrapAsMiddleware(moduleId, handler) {
  return (req, res, next) => {
    handler(req, res, next);
  };
}

function loadAllNativeModules(options = {}) {
  installNativeLoaderOrphanGuard(options);
  const middlewares = {};
  loadErrors = {};
  lifecycles = {};

  for (const [moduleId, serverPath] of Object.entries(NATIVE_MODULES)) {
    try {
      const handler = captureHandler(moduleId, serverPath);
      if (handler) {
        middlewares[moduleId] = wrapAsMiddleware(moduleId, handler);
      }
    } catch (e) {
      loadErrors[moduleId] = e.message;
      console.error(`[native-loader] Error loading ${moduleId}:`, e.message);
    }
  }

  loadedNativeMiddlewares = middlewares;
  const ok = Object.keys(middlewares).length;
  const total = Object.keys(NATIVE_MODULES).length;
  const failed = Object.keys(NATIVE_MODULES).filter(id => !middlewares[id]);
  console.log(`[native-loader] loaded ${ok}/${total}${failed.length ? ', failed: ' + failed.join(',') : ''}`);
  return middlewares;
}

async function initAllNativeModules() {
  for (const [moduleId, lc] of Object.entries(lifecycles)) {
    if (!lc.init) continue;
    try {
      await Promise.race([lc.init(), new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), 10000))]);
    } catch (e) {
      loadErrors[moduleId] = e.message;
      console.error(`[native-loader] Init failed for ${moduleId}:`, e.message);
      delete loadedNativeMiddlewares[moduleId];
    }
  }
}

async function disposeAllNativeModules() {
  for (const [moduleId, lc] of Object.entries(lifecycles)) {
    if (!lc.dispose) continue;
    try {
      await Promise.race([lc.dispose(), new Promise((_, reject) => setTimeout(() => reject(new Error('dispose timeout')), 5000))]);
    } catch (e) {
      console.error(`[native-loader] Dispose failed for ${moduleId}:`, e.message);
    }
  }
}

// 计算模块自身根目录（sub-modules/<name>/），用于精确清除 require 缓存
function getModuleRoot(serverPath) {
  // serverPath 形如 .../sub-modules/<name>/src/server.js 或 .../sub-modules/<name>/server.js
  // 取父目录直到 basename 为模块名（即 NATIVE_MODULES 中 key 对应的路径段）
  let dir = path.dirname(serverPath);
  while (dir !== SUB_MODULES_DIR && dir !== path.dirname(dir)) {
    const parent = path.dirname(dir);
    if (parent === SUB_MODULES_DIR) return dir;
    dir = parent;
  }
  return dir;
}

async function reloadModule(moduleId) {
  const entry = NATIVE_MODULES[moduleId];
  if (!entry) return { ok: false, error: 'unknown module' };

  const lc = lifecycles[moduleId];
  if (lc && lc.dispose) {
    try {
      await Promise.race([lc.dispose(), new Promise((_, reject) => setTimeout(() => reject(new Error('dispose timeout')), 5000))]);
    } catch (e) {
      console.error(`[reload] dispose ${moduleId}:`, e.message);
    }
  }

  // 清除该模块自身根目录下的所有 require 缓存
  const moduleRoot = getModuleRoot(entry);
  const prefix = moduleRoot + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
  // 同时清除入口文件自身缓存（即使它在模块根目录外）
  delete require.cache[require.resolve(entry)];
  delete lifecycles[moduleId];
  delete loadErrors[moduleId];

  const handler = captureHandler(moduleId, entry);
  if (!handler) {
    return { ok: false, error: loadErrors[moduleId] || 'load failed' };
  }
  loadedNativeMiddlewares[moduleId] = wrapAsMiddleware(moduleId, handler);

  const newLc = lifecycles[moduleId];
  if (newLc && newLc.init) {
    try {
      await Promise.race([newLc.init(), new Promise((_, reject) => setTimeout(() => reject(new Error('init timeout')), 10000))]);
    } catch (e) {
      loadErrors[moduleId] = e.message;
      console.error(`[reload] init ${moduleId}:`, e.message);
      return { ok: false, error: e.message };
    }
  }

  console.log(`[native-loader] ${moduleId} reloaded`);
  return { ok: true };
}

function getNativeMiddleware(moduleId) {
  return loadedNativeMiddlewares[moduleId] || null;
}

function getLoadError(moduleId) {
  return loadErrors[moduleId] || null;
}

function getLifecycle(moduleId) {
  return lifecycles[moduleId] || null;
}

module.exports = {
  loadAllNativeModules,
  initAllNativeModules,
  disposeAllNativeModules,
  reloadModule,
  getNativeMiddleware,
  getLoadError,
  getLifecycle,
  NATIVE_MODULES,
};
