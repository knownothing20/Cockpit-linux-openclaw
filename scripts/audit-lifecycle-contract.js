#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const nativeLoaderPath = path.join(projectRoot, 'registry', 'native-loader.js');
const subModulesDir = path.join(projectRoot, 'sub-modules');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseNativeModules() {
  const source = readText(nativeLoaderPath);
  const modules = [];
  const pattern = /'([^']+)'\s*:\s*path\.join\(SUB_MODULES_DIR,\s*([^\n]+?)\),/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const id = match[1];
    const pathArgs = Array.from(match[2].matchAll(/'([^']+)'/g)).map((item) => item[1]);
    if (!pathArgs.length) continue;
    modules.push({
      id,
      entry: path.join(...pathArgs),
      filePath: path.join(subModulesDir, ...pathArgs),
    });
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return modules;
}

function countMatches(source, regex) {
  const matches = source.match(regex);
  return matches ? matches.length : 0;
}

function analyzeModule(moduleInfo) {
  const exists = fs.existsSync(moduleInfo.filePath);
  const source = exists ? readText(moduleInfo.filePath) : '';
  const lifecycleObject = /module\.exports\s*=\s*\{[\s\S]*?\bhandler\b/.test(source);
  const directFunctionExport = /module\.exports\s*=\s*(async\s+)?function\b/.test(source)
    || /module\.exports\s*=\s*\([^)]*\)\s*=>/.test(source)
    || /module\.exports\s*=\s*[A-Za-z_$][\w$]*\s*;/.test(source);
  const exportsAnything = /module\.exports\s*=/.test(source);
  const usesHttpCreateServer = /http\.createServer\s*\(/.test(source);
  const usesExpress = /require\(['"]express['"]\)/.test(source) || /express\s*\(/.test(source);
  const timerCount = countMatches(source, /\bsetInterval\s*\(/g) + countMatches(source, /\bsetTimeout\s*\(/g);
  const sqlite = /sqlite3|better-sqlite3|\bsqlite\b|\.db\b/.test(source);
  const websocket = /WebSocket|require\(['"]ws['"]\)|\.on\(['"]upgrade['"]\)|EventSource|\bSSE\b|server-sent/i.test(source);
  const readiness = lifecycleObject ? 'lifecycle-object' : (directFunctionExport ? 'direct-export' : (usesHttpCreateServer ? 'legacy-capture' : 'manual-review'));

  return {
    id: moduleInfo.id,
    entry: moduleInfo.entry,
    exists,
    readiness,
    exportsAnything,
    lifecycleObject,
    directFunctionExport,
    usesHttpCreateServer,
    usesExpress,
    timers: timerCount,
    sqlite,
    websocket,
  };
}

function printTable(rows) {
  const headers = ['module', 'readiness', 'http', 'exports', 'timers', 'sqlite', 'ws/sse', 'entry'];
  const formatted = rows.map((row) => [
    row.id,
    row.readiness,
    row.usesHttpCreateServer ? 'yes' : 'no',
    row.exportsAnything ? 'yes' : 'no',
    String(row.timers),
    row.sqlite ? 'yes' : 'no',
    row.websocket ? 'yes' : 'no',
    row.entry,
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...formatted.map((row) => row[index].length)));
  const line = (items) => items.map((item, index) => item.padEnd(widths[index])).join('  ');

  console.log(line(headers));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of formatted) console.log(line(row));
}

function main() {
  const rows = parseNativeModules().map(analyzeModule);
  const summary = {
    moduleCount: rows.length,
    lifecycleObjectCount: rows.filter((row) => row.lifecycleObject).length,
    legacyCaptureCount: rows.filter((row) => row.readiness === 'legacy-capture').length,
    directExportCount: rows.filter((row) => row.readiness === 'direct-export').length,
    manualReviewCount: rows.filter((row) => row.readiness === 'manual-review').length,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary, modules: rows }, null, 2));
    return;
  }

  printTable(rows);
  console.log('');
  console.log(`summary: modules=${summary.moduleCount}, lifecycle=${summary.lifecycleObjectCount}, direct=${summary.directExportCount}, legacy=${summary.legacyCaptureCount}, manual=${summary.manualReviewCount}`);
  console.log('note: this audit is read-only and does not require or start sub-modules.');
}

main();
