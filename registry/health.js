const http = require('http');
const { loadManifests } = require('./app-registry');
const { getNativeMiddleware, getLoadError, getLifecycle, NATIVE_MODULES } = require('./native-loader');

function checkUrl(url, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        healthy: res.statusCode >= 200 && res.statusCode < 400,
      });
    });
    req.on('error', () => resolve({ status: 0, healthy: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, healthy: false });
    });
  });
}

const NATIVE_MODULE_IDS = Object.keys(NATIVE_MODULES);

async function checkModuleHealth(module, timeout = 2000) {
  const healthPath = module.healthPath || '/';
  const isNative = NATIVE_MODULE_IDS.includes(module.id);

  if (isNative) {
    const middleware = getNativeMiddleware(module.id);
    const lc = getLifecycle(module.id);
    let fnHealthy = true;
    if (lc && lc.healthFn) {
      try { fnHealthy = lc.healthFn() !== false; }
      catch (e) { fnHealthy = false; }
    }
    const healthy = Boolean(middleware) && fnHealthy;
    const result = {
      status: healthy ? 'healthy' : 'unhealthy',
      healthy,
      httpStatus: healthy ? 200 : 0,
      native: true,
      inMemory: true,
      checkedAt: new Date().toISOString(),
    };
    if (!healthy) result.error = getLoadError(module.id) || 'not loaded';
    return result;
  }

  const baseUrl = module.baseUrl;
  if (!baseUrl) {
    return { status: 'unknown', healthy: false, checkedAt: new Date().toISOString() };
  }
  const url = baseUrl.replace(/\/$/, '') + healthPath;
  const result = await checkUrl(url, timeout);
  return {
    status: result.healthy ? 'healthy' : 'unhealthy',
    healthy: result.healthy,
    httpStatus: result.status,
    native: false,
    checkedAt: new Date().toISOString(),
  };
}

async function aggregateHealth(timeout = 2000, concurrency = 13) {
  const manifests = loadManifests();
  const results = [];
  for (let i = 0; i < manifests.length; i += concurrency) {
    const batch = manifests.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (m) => {
        const health = await checkModuleHealth(m, timeout);
        return { id: m.id, ...health };
      })
    );
    results.push(...batchResults);
  }
  const allHealthy = results.every((r) => r.healthy);
  return {
    overall: allHealthy ? 'healthy' : 'degraded',
    checkedAt: new Date().toISOString(),
    modules: results,
  };
}

module.exports = {
  checkModuleHealth,
  aggregateHealth,
};
