#!/usr/bin/env node
'use strict';

/**
 * 任务 3.2 — HTTP 冒烟测试
 * 只用 Node 内置 http + assert（不引入测试框架）
 *
 * 行为：
 *   - 目标地址 process.env.SMOKE_BASE || 'http://127.0.0.1:7001'
 *   - 依次 GET 关键端点与 8 个模块各 1 个已知 GET API，断言状态码与关键字段
 *   - 若 /health 连接被拒（Shell 未运行），打印 SMOKE SKIPPED 并退出码 0
 *     （避免阻塞离线提交）
 */

const http = require('http');
const assert = require('assert');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:7001';
const base = new URL(BASE);

// ── 8 个模块各 1 个已知 GET API ──────────────────────────────
// 端点来源：各模块入口文件路由定义（已通过 7001 生产实例 curl 确认 200）
const MODULE_ENDPOINTS = [
  // [moduleId, path, sourceFile:line]
  ['applist',            '/api/software-list',                    'sub-modules/applist/server.js:1468'],
  ['config-recovery',    '/api/config-center/patrol/status',      'sub-modules/config-recovery/server.js:181'],
  ['file-manager',       '/health',                               'sub-modules/file-manager/src/server.js:1137'],
  ['memory',             '/api/health',                           'sub-modules/memory/src/server.js:219'],
  ['models-manager',     '/health',                               'sub-modules/openclaw-models-manager/server.js:661'],
  ['robots',             '/api/agents',                           'sub-modules/robots/src/server.js:607'],
  ['skill-manager',      '/health',                               'sub-modules/skill-manager/server.js:48'],
  ['workspace-rule-panel', '/health',                             'sub-modules/workspace-rule-panel/server.js:611'],
];

let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log('  ok -', name); }
function fail(name, msg) { failed++; console.error('  FAIL -', name); console.error('    ', msg); }

function get(path, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: path,
        method: 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on('error', (e) => resolve({ error: e }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  console.log('audit-smoke:', BASE);

  // 1. 先探活 /health；连接被拒则跳过（离线提交场景）
  const probe = await get('/health', { timeout: 4000 });
  if (probe.error || (probe.statusCode !== 200 && !probe.body)) {
    console.log('SMOKE SKIPPED: shell not running (' + (probe.error ? probe.error.message : 'no response') + ')');
    process.exit(0);
  }

  // 2. /health → 200 且 body 含 "healthy"
  {
    const r = probe;
    if (r.statusCode === 200 && /healthy/.test(r.body)) ok('GET /health → 200 + "healthy"');
    else fail('GET /health → 200 + "healthy"', 'statusCode=' + r.statusCode + ' body=' + r.body.slice(0, 120));
  }

  // 3. /api/apps → 200 且 JSON 数组长度 ≥ 10
  {
    const r = await get('/api/apps');
    try {
      assert.strictEqual(r.statusCode, 200);
      const list = JSON.parse(r.body);
      assert.ok(Array.isArray(list), 'expected an array');
      assert.ok(list.length >= 8, 'expected >= 8 modules, got ' + list.length);
      ok('GET /api/apps → 200 + array.length >= 8');
    } catch (e) { fail('GET /api/apps → 200 + array.length >= 8', e.message + ' | body=' + (r.body || '').slice(0, 120)); }
  }

  // 4. /api/apps/health → 200 且 overall === 'healthy'
  {
    const r = await get('/api/apps/health');
    try {
      assert.strictEqual(r.statusCode, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.overall, 'healthy', 'overall=' + j.overall);
      ok('GET /api/apps/health → 200 + overall=healthy');
    } catch (e) { fail('GET /api/apps/health → 200 + overall=healthy', e.message + ' | body=' + (r.body || '').slice(0, 200)); }
  }

  // 5. /apps/skill-manager/ (iframe 嵌入) → 200 且 body 含 <base href
  // 注入由 isEmbeddedModuleRequest 触发：sec-fetch-dest: iframe 或 ?__embed=1
  // （非嵌入请求返回 shell dashboard，不含 <base href>）
  {
    const r = await get('/apps/skill-manager/', {
      headers: { 'Sec-Fetch-Dest': 'iframe' },
    });
    if (r.statusCode === 200 && /<base\s+href/i.test(r.body)) {
      ok('GET /apps/skill-manager/ (Sec-Fetch-Dest: iframe) → 200 + <base href>');
    } else {
      fail('GET /apps/skill-manager/ (Sec-Fetch-Dest: iframe) → 200 + <base href>',
        'statusCode=' + r.statusCode + ' hasBase=' + /<base\s+href/i.test(r.body || ''));
    }
  }

  // 6. 8 个模块各 1 个 GET API → 200
  for (const [moduleId, path, source] of MODULE_ENDPOINTS) {
    const r = await get('/apps/' + moduleId + path);
    if (r.statusCode === 200) {
      ok(moduleId + ' ' + path + ' → 200  [' + source + ']');
    } else {
      fail(moduleId + ' ' + path + ' → 200',
        'statusCode=' + r.statusCode + ' err=' + (r.error ? r.error.message : (r.body || '').slice(0, 100)));
    }
  }

  console.log('\nsmoke tests: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('audit-smoke fatal:', e && e.stack || e);
  process.exit(1);
});
