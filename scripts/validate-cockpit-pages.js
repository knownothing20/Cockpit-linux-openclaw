#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const baseUrl = process.env.COCKPIT_BASE_URL || 'http://127.0.0.1:7001';
const version = process.env.COCKPIT_ASSET_VERSION || '20261010-fm-docs-real-pct';
const smokeTheme = process.env.COCKPIT_SMOKE_THEME || 'dark';
const args = process.argv.slice(2);
const outputArg = args[0];
const dateStamp = process.env.COCKPIT_SMOKE_DATE || new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.TZ || 'Asia/Shanghai',
}).format(new Date());
const compactDate = dateStamp.replace(/-/g, '');
const outDir = outputArg || path.join(root, `docs/_audit/screenshots/smoke-${compactDate}`);
const reportPath = path.join(path.dirname(outDir), `cockpit-page-smoke-${dateStamp}.md`);
const CDP_PORT = Number(process.env.COCKPIT_CDP_PORT || 19224);
const chromeProfile = path.join('/tmp', `cockpit-smoke-profile-${process.pid}`);
const chromeLogPath = path.join('/tmp', `cockpit-smoke-chromium-${process.pid}.log`);

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function manifests() {
  const dir = path.join(root, 'modules');
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.module.json'))
    .map((name) => JSON.parse(read(path.join(dir, name))))
    .filter((m) => m.showInNav !== false)
    .sort((a, b) => (a.order || 99) - (b.order || 99) || a.id.localeCompare(b.id));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitPort(port, ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const s = net.createConnection({ port, host: '127.0.0.1' }, () => { s.end(); resolve(); });
      s.on('error', () => {
        if (Date.now() - start > ms) reject(new Error(`port ${port} timeout`));
        else setTimeout(check, 250);
      });
    };
    check();
  });
}

function httpPut(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT' }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectWS(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    let resolved = false;
    const socket = net.createConnection({ host: u.hostname, port: Number(u.port) }, () => {
      socket.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const listeners = [];
    const api = {
      onMessage(fn) { listeners.push(fn); },
      send(str) {
        const payload = Buffer.from(str);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(6);
          header[0] = 0x81; header[1] = 0x80 | payload.length; mask.copy(header, 2);
        } else {
          header = Buffer.alloc(8);
          header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); mask.copy(header, 4);
        }
        socket.write(Buffer.concat([header, masked]));
      },
      close() { socket.end(); },
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        buf = buf.slice(i + 4);
        upgraded = true;
        if (!resolved) {
          resolved = true;
          resolve(api);
        }
      }
      while (buf.length >= 2) {
        const frame = parseFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.len);
        if (frame.opcode === 1) listeners.forEach((fn) => fn(frame.payload));
      }
    });
    socket.on('error', reject);
  });
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let offset = 2;
  let length = buf[1] & 0x7f;
  if (length === 126) {
    if (buf.length < offset + 2) return null;
    length = buf.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buf.length < offset + 8) return null;
    length = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  if (buf.length < offset + length) return null;
  return { opcode, payload: buf.slice(offset, offset + length).toString('utf8'), len: offset + length };
}

async function newPage(browserUrl) {
  const target = JSON.parse(await httpPut(`${browserUrl}/json/new?${encodeURIComponent('about:blank')}`));
  const ws = await connectWS(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onMessage((data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}, timeout = 20000) => new Promise((resolve, reject) => {
    const msgId = ++id;
    const timer = setTimeout(() => {
      pending.delete(msgId);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeout);
    pending.set(msgId, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg);
    });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  if (smokeTheme === 'dark' || smokeTheme === 'light') {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        try {
          localStorage.setItem('openclaw-theme', ${JSON.stringify(smokeTheme)});
          localStorage.setItem('openclaw-theme:openclaw', ${JSON.stringify(smokeTheme)});
          document.documentElement.setAttribute('data-theme', ${JSON.stringify(smokeTheme)});
        } catch (error) {}
      `,
    });
  }
  return { send, events, close: () => ws.close() };
}

async function evaluate(page, expression, timeout = 20000) {
  const msg = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  }, timeout + 5000);
  return msg.result.result.value;
}

async function navigate(page, url) {
  await page.send('Page.navigate', { url });
  await evaluate(page, `new Promise((resolve) => {
    const done = () => document.readyState === 'complete' && resolve(true);
    if (document.readyState === 'complete') resolve(true);
    else window.addEventListener('load', done, { once: true });
    setTimeout(() => resolve(false), 15000);
  })`);
  await sleep(1200);
}

async function screenshot(page, file) {
  const msg = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
}

function eventErrors(events) {
  return events
    .filter((event) => {
      if (event.method === 'Runtime.exceptionThrown') return true;
      if (event.method === 'Log.entryAdded' && event.params && event.params.entry && event.params.entry.level === 'error') return true;
      if (event.method === 'Network.responseReceived' && event.params && event.params.response) return event.params.response.status >= 400;
      if (event.method === 'Network.loadingFailed') return event.params && event.params.errorText !== 'net::ERR_ABORTED';
      return false;
    })
    .map((event) => {
      if (event.method === 'Runtime.exceptionThrown') return event.params.exceptionDetails.text || 'Runtime exception';
      if (event.method === 'Network.responseReceived') return `${event.params.response.status} ${event.params.response.url}`;
      if (event.method === 'Network.loadingFailed') return `${event.params.errorText || 'Network failed'} ${event.params.requestId || ''}`;
      return event.params.entry.text || 'Log error';
    });
}

async function inspectModule(page, manifest, mode) {
  const embedPath = manifest.embedPath || '/';
  const modulePath = embedPath === '/' ? '/index.html' : (embedPath.startsWith('/') ? embedPath : '/' + embedPath);
  const shellRoute = `/apps/${manifest.id}`;
  const directRoute = `/apps/${manifest.id}${modulePath}`;
  const url = mode === 'direct'
    ? `${baseUrl}${directRoute}${directRoute.includes('?') ? '&' : '?'}__embed=1&v=${version}`
    : `${baseUrl}${shellRoute}`;
  const eventStart = page.events.length;
  await navigate(page, url);
  await evaluate(page, `new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const f = document.querySelector('.module-frame');
      if (!f) resolve(true);
      else if (f.classList.contains('is-ready') || f.contentDocument?.readyState === 'complete') resolve(true);
      else if (Date.now() - started > 15000) resolve(false);
      else setTimeout(check, 250);
    };
    check();
  })`);
  const tabClicks = await evaluate(page, `new Promise(async (resolve) => {
    const shellFrame = document.querySelector('.module-frame');
    const doc = (shellFrame && shellFrame.contentDocument) || document;
    const candidates = Array.from(doc.querySelectorAll('.oc-tab,[role="tab"],[data-tab],[data-page]')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    }).slice(0, 12);
    const out = [];
    for (const el of candidates) {
      const label = (el.textContent || el.getAttribute('data-tab') || el.getAttribute('data-page') || '').trim().replace(/\\s+/g, ' ');
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }));
        await new Promise((r) => setTimeout(r, 350));
        out.push({ label, clicked: true });
      } catch (err) {
        out.push({ label, clicked: false, error: String(err && err.message || err) });
      }
    }
    resolve(out);
  })`);
  const stat = await evaluate(page, `(() => {
    const shellFrame = document.querySelector('.module-frame');
    const doc = (shellFrame && shellFrame.contentDocument) || document;
    const win = doc.defaultView || window;
    const innerFrame = doc.querySelector('.module-frame');
    const visibleText = (doc.body && doc.body.innerText || '').trim();
    const tabs = Array.from(doc.querySelectorAll('.oc-tab,[role="tab"],[data-tab],[data-page]')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map(el => (el.textContent || el.getAttribute('data-tab') || el.getAttribute('data-page') || '').trim()).slice(0, 12);
    const links = Array.from(doc.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).slice(0, 20);
    const nav = win.performance && win.performance.getEntriesByType ? win.performance.getEntriesByType('navigation')[0] : null;
    const resources = win.performance && win.performance.getEntriesByType ? win.performance.getEntriesByType('resource') : [];
    const slowResources = resources
      .slice()
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 3)
      .map((entry) => {
        const name = (entry.name || '').replace(location.origin, '');
        return name.slice(-90) + ' ' + Math.round(entry.duration) + 'ms';
      });
    const encodedBytes = resources.reduce((sum, entry) => sum + (entry.encodedBodySize || entry.transferSize || 0), 0);
    return {
      url: location.href,
      title: doc.title || '',
      textLength: visibleText.length,
      heading: ((doc.querySelector('h1,h2,h3,.oc-page-title,.page-title') || {}).textContent || '').trim().slice(0, 120),
      frameSrc: innerFrame ? innerFrame.getAttribute('src') : '',
      frameReady: innerFrame ? innerFrame.classList.contains('is-ready') : null,
      buttons: doc.querySelectorAll('button,.oc-btn').length,
      tabs,
      links,
      bodyChildren: doc.body ? doc.body.children.length : 0,
      perf: {
        navMs: nav ? Math.round(nav.duration) : 0,
        domContentMs: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
        loadMs: nav ? Math.round(nav.loadEventEnd) : 0,
        resourceCount: resources.length,
        encodedKb: Math.round(encodedBytes / 1024),
        slowResources,
      },
    };
  })()`);
  const errors = eventErrors(page.events.slice(eventStart));
  const png = path.join(outDir, `${manifest.id}-${mode}.png`);
  await screenshot(page, png);
  return { manifest, mode, stat, errors, tabClicks, screenshot: png };
}

async function clickShellNav(page, moduleList) {
  await navigate(page, `${baseUrl}/?v=${version}`);
  const results = await evaluate(page, `new Promise(async (resolve) => {
    const items = Array.from(document.querySelectorAll('.nav-item')).filter((el, index) => index > 0);
    const output = [];
    for (const item of items) {
      item.click();
      const result = await new Promise((innerResolve) => {
        const started = Date.now();
        const check = () => {
          const frame = document.querySelector('.module-frame');
          const src = frame ? frame.getAttribute('src') || '' : '';
          const match = src.match(/\\/apps\\/([^/?#]+)/);
          if (match) {
            innerResolve({
              id: match[1],
              clicked: true,
              activeText: (document.querySelector('.nav-item.active') || item).textContent.trim(),
              frameSrc: src,
              path: location.pathname,
            });
          } else if (Date.now() - started > 10000) {
            innerResolve({
              id: '',
              clicked: false,
              activeText: item.textContent.trim(),
              reason: 'iframe did not switch',
              path: location.pathname,
            });
          } else setTimeout(check, 250);
        };
        check();
      });
      output.push(result);
    }
    resolve(output);
  })`);
  const found = new Set(results.map((r) => r.id).filter(Boolean));
  for (const manifest of moduleList) {
    if (!found.has(manifest.id)) results.push({ id: manifest.id, clicked: false, reason: 'nav item not reached' });
  }
  await screenshot(page, path.join(outDir, 'shell-nav-final.png'));
  return results;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const proc = spawn('chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1440,900',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', fs.openSync(chromeLogPath, 'w')], detached: true });
  const browserUrl = `http://127.0.0.1:${CDP_PORT}`;
  try {
    await waitPort(CDP_PORT, 15000);
    const mods = manifests();
    const page = await newPage(browserUrl);
    const navResults = await clickShellNav(page, mods);
    const checks = [];
    for (const manifest of mods) {
      checks.push(await inspectModule(page, manifest, 'shell'));
      checks.push(await inspectModule(page, manifest, 'direct'));
    }
    page.close();
    const lines = [];
    lines.push(`# Cockpit Page Smoke Validation - ${dateStamp}`);
    lines.push('');
    lines.push(`Base URL: \`${baseUrl}\``);
    lines.push(`Theme: \`${smokeTheme}\``);
    lines.push(`Screenshots: \`${path.relative(root, outDir)}\``);
    lines.push('');
    lines.push('## Shell Menu Clicks');
    lines.push('');
    lines.push('| Module | Clicked | Frame | Route | Note |');
    lines.push('|---|---:|---|---|---|');
    for (const r of navResults) {
      lines.push(`| ${r.id} | ${r.clicked ? 'yes' : 'no'} | ${r.frameSrc || '-'} | ${r.path || '-'} | ${r.reason || r.activeText || '-'} |`);
    }
    lines.push('');
    lines.push('## Page Render Checks');
    lines.push('');
    lines.push('| Module | Mode | Text chars | Buttons | Tabs found | Tab clicks | JS/log errors | Screenshot | Heading |');
    lines.push('|---|---|---:|---:|---|---:|---:|---|---|');
    for (const item of checks) {
      const relShot = path.relative(root, item.screenshot);
      const clicked = (item.tabClicks || []).filter((tab) => tab.clicked).length;
      lines.push(`| ${item.manifest.id} | ${item.mode} | ${item.stat.textLength} | ${item.stat.buttons} | ${(item.stat.tabs || []).join('<br>') || '-'} | ${clicked}/${(item.tabClicks || []).length} | ${item.errors.length} | \`${relShot}\` | ${(item.stat.heading || item.stat.title || '-').replace(/\|/g, '/')} |`);
    }
    lines.push('');
    lines.push('## Performance Snapshot');
    lines.push('');
    lines.push('| Module | Mode | Nav | DOMContent | Load | Resources | Encoded KB | Slowest resources |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---|');
    for (const item of checks) {
      const perf = item.stat.perf || {};
      lines.push(`| ${item.manifest.id} | ${item.mode} | ${perf.navMs || 0}ms | ${perf.domContentMs || 0}ms | ${perf.loadMs || 0}ms | ${perf.resourceCount || 0} | ${perf.encodedKb || 0} | ${(perf.slowResources || []).join('<br>') || '-'} |`);
    }
    const failures = [];
    for (const r of navResults) if (!r.clicked) failures.push(`menu:${r.id}`);
    for (const item of checks) {
      if (item.stat.textLength < 40) failures.push(`blank:${item.manifest.id}:${item.mode}`);
      if (item.errors.length) failures.push(`errors:${item.manifest.id}:${item.mode}`);
    }
    lines.push('');
    const errorItems = checks.filter((item) => item.errors.length);
    if (errorItems.length) {
      lines.push('## Error Details');
      lines.push('');
      for (const item of errorItems) {
        lines.push(`- \`${item.manifest.id}\` ${item.mode}: ${item.errors.join(' / ')}`);
      }
      lines.push('');
    }
    lines.push('## Result');
    lines.push('');
    lines.push(failures.length ? `Failures: ${failures.join(', ')}` : 'All smoke checks passed.');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, lines.join('\n') + '\n');
    console.log(`wrote ${path.relative(root, reportPath)}`);
    if (failures.length) {
      console.error(`smoke failures: ${failures.join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
