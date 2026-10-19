const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const MODULE_PROCESSES = new Map();
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY = 5000;
const restartCounts = new Map();

const SUB_MODULES_DIR = path.join(__dirname, '..', 'sub-modules');

const MODULE_CONFIG = {
  'file-manager': {
    cwd: path.join(SUB_MODULES_DIR, 'file-manager', 'src'),
    cmd: 'node',
    args: ['server.js'],
    port: 18200,
    envKey: 'FILE_MANAGER_PORT',
    host: '127.0.0.1',
  },
  'models-manager': {
    cwd: path.join(SUB_MODULES_DIR, 'openclaw-models-manager'),
    cmd: 'node',
    args: ['server.js'],
    port: 18117,
    envKey: 'PORT',
    host: '127.0.0.1',
  },
  'workspace-rule-panel': {
    cwd: path.join(SUB_MODULES_DIR, 'workspace-rule-panel'),
    cmd: 'node',
    args: ['server.js'],
    port: 17091,
    envKey: 'RULE_PANEL_PORT',
    host: '0.0.0.0',
  },
  'skill-manager': {
    cwd: path.join(SUB_MODULES_DIR, 'skill-manager'),
    cmd: 'node',
    args: ['server.js'],
    port: 27152,
    envKey: 'PORT',
    host: '0.0.0.0',
  },
  'config-recovery': {
    cwd: path.join(SUB_MODULES_DIR, 'config-recovery'),
    cmd: 'node',
    args: ['server.js'],
    port: 27151,
    envKey: 'PORT',
    host: '0.0.0.0',
  },
  'applist': {
    cwd: path.join(SUB_MODULES_DIR, 'applist'),
    cmd: 'node',
    args: ['server.js'],
    port: 17149,
    envKey: 'PORT',
    host: '0.0.0.0',
  },
  'robots': {
    cwd: path.join(SUB_MODULES_DIR, 'robots', 'src'),
    cmd: 'node',
    args: ['server.js'],
    port: 18100,
    envKey: 'ROBOTS_PORT',
    host: '0.0.0.0',
  },
};

function getModulePort(moduleId) {
  const config = MODULE_CONFIG[moduleId];
  return config ? config.port : null;
}

function getModuleBaseUrl(moduleId) {
  const config = MODULE_CONFIG[moduleId];
  if (!config) return null;
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForReady(port, host, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (await isPortAvailable(port, host)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function startModule(moduleId) {
  const config = MODULE_CONFIG[moduleId];
  if (!config) {
    console.error(`[module-starter] No config for ${moduleId}`);
    return { success: false, error: 'No config' };
  }

  if (MODULE_PROCESSES.has(moduleId)) {
    const existing = MODULE_PROCESSES.get(moduleId);
    if (!existing.killed) {
      const isRunning = await isPortAvailable(config.port, config.host === '0.0.0.0' ? '127.0.0.1' : config.host);
      if (isRunning) {
        console.log(`[module-starter] ${moduleId} already running on port ${config.port}`);
        return { success: true, port: config.port, pid: existing.pid, alreadyRunning: true };
      }
    }
  }

  const isRunning = await isPortAvailable(config.port, config.host === '0.0.0.0' ? '127.0.0.1' : config.host);
  if (isRunning) {
    console.log(`[module-starter] ${moduleId} port ${config.port} already in use by external process, skipping`);
    return { success: true, port: config.port, managedExternally: true };
  }

  const env = { ...process.env };
  env[config.envKey] = String(config.port);
  if (config.envKey === 'PORT' && config.host) {
    env.HOST = config.host;
  }

  console.log(`[module-starter] Starting ${moduleId} on port ${config.port}...`);

  const child = spawn(config.cmd, config.args, {
    cwd: config.cwd,
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log(`[${moduleId}] ${line.trim()}`);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) console.error(`[${moduleId}] ${line.trim()}`);
    }
  });

  child.on('exit', (code, signal) => {
    console.log(`[module-starter] ${moduleId} exited (code=${code}, signal=${signal})`);
    MODULE_PROCESSES.delete(moduleId);
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT' && !child._intentionalKill) {
      const attempts = (restartCounts.get(moduleId) || 0) + 1;
      if (attempts <= MAX_RESTART_ATTEMPTS) {
        const delay = RESTART_BASE_DELAY * Math.pow(2, attempts - 1);
        restartCounts.set(moduleId, attempts);
        console.log(`[module-starter] Restarting ${moduleId} in ${delay}ms (attempt ${attempts})`);
        setTimeout(() => startModule(moduleId), delay);
      } else {
        console.error(`[module-starter] ${moduleId} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`);
      }
    } else {
      restartCounts.delete(moduleId);
    }
  });

  child.on('error', (err) => {
    console.error(`[module-starter] ${moduleId} failed to start:`, err.message);
    MODULE_PROCESSES.delete(moduleId);
  });

  MODULE_PROCESSES.set(moduleId, child);

  const checkHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const started = await waitForReady(config.port, checkHost, 10000);
  if (started) {
    console.log(`[module-starter] ${moduleId} started successfully on port ${config.port} (pid=${child.pid})`);
    return { success: true, port: config.port, pid: child.pid };
  } else {
    console.warn(`[module-starter] ${moduleId} may not be ready yet on port ${config.port}`);
    return { success: true, port: config.port, pid: child.pid, warning: 'Port not responding yet' };
  }
}

async function startAllModules() {
  const results = {};
  const moduleIds = Object.keys(MODULE_CONFIG);
  const batchSize = 5;

  for (let i = 0; i < moduleIds.length; i += batchSize) {
    const batch = moduleIds.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(async (moduleId) => {
      const result = await startModule(moduleId);
      return { moduleId, ...result };
    }));

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.moduleId) {
        const mid = r.value.moduleId;
        delete r.value.moduleId;
        results[mid] = r.value;
      }
    }
  }

  return results;
}

function stopModule(moduleId) {
  const child = MODULE_PROCESSES.get(moduleId);
  if (child && !child.killed) {
    child._intentionalKill = true;
    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000);
    child.on('exit', () => {
      clearTimeout(forceKillTimer);
      MODULE_PROCESSES.delete(moduleId);
    });
    return true;
  }
  return false;
}

function stopAllModules() {
  for (const moduleId of MODULE_PROCESSES.keys()) {
    stopModule(moduleId);
  }
}

function getModuleStatus() {
  const status = {};
  for (const [moduleId, child] of MODULE_PROCESSES) {
    status[moduleId] = {
      pid: child.pid,
      port: MODULE_CONFIG[moduleId]?.port,
      killed: child.killed,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  }
  return status;
}

process.on('exit', () => {
  for (const [id, child] of MODULE_PROCESSES) {
    if (!child.killed) child.kill('SIGKILL');
  }
});

process.on('SIGINT', () => {
  console.log('\n[module-starter] SIGINT received, stopping all modules...');
  stopAllModules();
  setTimeout(() => process.exit(0), 6000);
});

process.on('SIGTERM', () => {
  console.log('\n[module-starter] SIGTERM received, stopping all modules...');
  stopAllModules();
  setTimeout(() => process.exit(0), 6000);
});

module.exports = {
  startModule,
  startAllModules,
  stopModule,
  stopAllModules,
  getModuleStatus,
  getModulePort,
  getModuleBaseUrl,
  MODULE_CONFIG,
};
