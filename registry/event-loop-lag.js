'use strict';

// Cockpit Shell 事件循环延迟监控
//
// 背景: 8 个子模块以 in-process native 中间件方式跑在同一个事件循环上,
// 任何模块的同步重活(例如 models-manager 的全量日志扫描)都会阻塞整条 Shell。
// 本模块提供 event loop lag 指标, 作为"单进程阻塞"的提前预警信号。
//
// 设计要点:
// - 使用 Node 内置 perf_hooks.monitorEventLoopDelay(), 不引入任何新依赖。
// - 采用"窗口快照"模型: 每 WINDOW_MS 采集一次并 reset, 读取方拿到的始终是
//   最近一个完整窗口的统计, 因此多个调用方( /health, /api/apps/health )
//   读取时不会互相偷走数据。
// - 校准说明: Node 的 histogram 读数基线恒等于 resolution(实测 idle 状态下
//   p50 == resolution)。因此对外暴露的 meanMs/p50Ms/p99Ms/maxMs 均为
//   「扣除 resolution 基线后的真实阻塞量」, idle 时约等于 0; 原始读数保留在
//   raw 字段中以便对照。
// - 纯只读, 不改变任何现有响应字段语义, 仅做追加。

const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_RESOLUTION_MS = parseInt(process.env.SHELL_ELD_RESOLUTION_MS || '20', 10);
const WINDOW_MS = parseInt(process.env.SHELL_ELD_WINDOW_MS || '15000', 10);
const DEGRADED_P99_MS = parseInt(process.env.SHELL_ELD_DEGRADED_P99_MS || '500', 10);

let histogram = null;
let windowTimer = null;
let snapshot = null;
let startedAt = 0;

function nsToMs(ns) {
  if (typeof ns !== 'number' || !Number.isFinite(ns) || ns < 0) return null;
  return Math.round((ns / 1e6) * 100) / 100;
}

// 扣除 resolution 基线, 得到真实阻塞量
function excess(ms) {
  if (ms === null) return null;
  return Math.max(0, Math.round((ms - SAMPLE_RESOLUTION_MS) * 100) / 100);
}

function collectWindow() {
  if (!histogram) return;
  // 先读全部统计量, 再 reset, 顺序不可颠倒。
  const rawMean = nsToMs(histogram.mean);
  const rawP50 = nsToMs(histogram.percentile(50));
  const rawP99 = nsToMs(histogram.percentile(99));
  const rawMax = nsToMs(histogram.max);
  histogram.reset();

  const p99 = excess(rawP99);
  const degraded = p99 !== null && p99 > DEGRADED_P99_MS;
  snapshot = {
    available: true,
    sampledAt: new Date().toISOString(),
    windowMs: WINDOW_MS,
    resolutionMs: SAMPLE_RESOLUTION_MS,
    meanMs: excess(rawMean),
    p50Ms: excess(rawP50),
    p99Ms: p99,
    maxMs: excess(rawMax),
    raw: { meanMs: rawMean, p50Ms: rawP50, p99Ms: rawP99, maxMs: rawMax },
    degraded,
    thresholdMs: DEGRADED_P99_MS,
  };

  if (degraded) {
    console.warn(
      `[event-loop-lag] event loop blocked in last ${WINDOW_MS}ms window: ` +
      `p99=${p99}ms max=${snapshot.maxMs}ms (threshold ${DEGRADED_P99_MS}ms)`
    );
  }
}

function startEventLoopMonitor() {
  if (histogram) return;

  if (typeof monitorEventLoopDelay !== 'function') {
    snapshot = { available: false, reason: 'monitorEventLoopDelay unavailable in this Node build' };
    console.warn('[event-loop-lag] monitor unavailable: monitorEventLoopDelay is not a function');
    return;
  }

  try {
    histogram = monitorEventLoopDelay({ resolution: SAMPLE_RESOLUTION_MS });
    histogram.enable();
  } catch (e) {
    histogram = null;
    snapshot = { available: false, reason: e.message };
    console.error('[event-loop-lag] failed to start monitor:', e.message);
    return;
  }

  startedAt = Date.now();
  snapshot = {
    available: true,
    sampledAt: new Date().toISOString(),
    windowMs: WINDOW_MS,
    resolutionMs: SAMPLE_RESOLUTION_MS,
    meanMs: null,
    p50Ms: null,
    p99Ms: null,
    maxMs: null,
    raw: null,
    degraded: false,
    thresholdMs: DEGRADED_P99_MS,
    warmingUp: true,
  };

  windowTimer = setInterval(collectWindow, WINDOW_MS);
  if (typeof windowTimer.unref === 'function') windowTimer.unref();

  console.log(
    `[event-loop-lag] monitor started (resolution=${SAMPLE_RESOLUTION_MS}ms, ` +
    `window=${WINDOW_MS}ms, degraded when p99>${DEGRADED_P99_MS}ms)`
  );
}

function stopEventLoopMonitor() {
  if (windowTimer) {
    clearInterval(windowTimer);
    windowTimer = null;
  }
  if (histogram) {
    try { histogram.disable(); } catch (e) { /* ignore */ }
    histogram = null;
  }
}

function getEventLoopLag() {
  if (!snapshot) return { available: false, reason: 'monitor not started' };
  return Object.assign({}, snapshot, {
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
  });
}

module.exports = {
  startEventLoopMonitor,
  stopEventLoopMonitor,
  getEventLoopLag,
};
