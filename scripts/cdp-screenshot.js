#!/usr/bin/env node
// CDP Screenshot Tool - No external dependencies
// Usage: node cdp-screenshot.js <url> [selector] <outPath> [timeout]
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const CDP_PORT = 19222;

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.error('Usage: node cdp-screenshot.js <url> [selector] <outPath> [timeout]'); process.exit(1); }
  const url = args[0];
  let selector = null, outPath, timeout = '15000';
  if (args.length === 2) { outPath = args[1]; }
  else if (args.length === 3) { selector = args[1]; outPath = args[2]; }
  else { selector = args[1]; outPath = args[2]; timeout = args[3]; }
  const timeoutMs = parseInt(timeout, 10);

  const proc = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900', '--hide-scrollbars'
  ], { stdio: 'ignore', detached: true });

  try {
    await waitPort(CDP_PORT, 10000);
    const target = await httpPut(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`);
    const { webSocketDebuggerUrl } = JSON.parse(target);
    const ws = await connectWS(webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    ws.onMessage = (data) => {
      try { const msg = JSON.parse(data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch (e) {}
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs + 10000);
      pending.set(id, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg); });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    if (selector) {
      await send('Runtime.evaluate', {
        expression: `new Promise((resolve) => { const t = setTimeout(() => resolve(false), ${timeoutMs}); const c = () => { if (document.querySelector(${JSON.stringify(selector)})) { clearTimeout(t); resolve(true); } else requestAnimationFrame(c); }; c(); })`,
        awaitPromise: true, timeout: timeoutMs + 5000
      });
      await sleep(500);
    } else {
      await sleep(Math.min(timeoutMs, 5000));
    }

    const { result } = await send('Page.captureScreenshot', { format: 'png' });
    const dir = outPath.substring(0, outPath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    console.log(`OK: ${outPath}`);
    ws.close();
  } finally {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) {}
  }
}

function waitPort(port, ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const s = net.createConnection({ port, host: '127.0.0.1' }, () => { s.end(); resolve(); });
      s.on('error', () => { if (Date.now() - start > ms) reject(new Error('port timeout')); else setTimeout(check, 300); });
    };
    check();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}

function httpPut(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT' };
    const req = http.request(opts, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectWS(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection({ host: u.hostname, port: parseInt(u.port) }, () => {
      socket.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let upgraded = false, buf = Buffer.alloc(0), onMsg = null;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; buf = buf.slice(i + 4); upgraded = true; }
      while (buf.length >= 2) { const f = parseFrame(buf); if (!f) break; buf = buf.slice(f.len); if (f.opcode === 1 && onMsg) onMsg(f.payload); else if (f.opcode === 8) socket.end(); }
    });
    socket.on('error', reject);
    resolve({
      onMessage: (cb) => { onMsg = cb; },
      send: (str) => {
        const p = Buffer.from(str); const m = crypto.randomBytes(4);
        const masked = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ m[i % 4];
        let h;
        if (p.length < 126) { h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | p.length; m.copy(h, 2); }
        else if (p.length < 65536) { h = Buffer.alloc(8); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); m.copy(h, 4); }
        else { h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h[4] = (p.length >> 24) & 0xff; h[5] = (p.length >> 16) & 0xff; h[6] = (p.length >> 8) & 0xff; h[7] = p.length & 0xff; m.copy(h, 10); }
        socket.write(Buffer.concat([h, masked]));
      },
      close: () => socket.end()
    });
  });
}

function parseFrame(b) {
  if (b.length < 2) return null;
  const op = b[0] & 0x0f; let o = 1, pl = b[o] & 0x7f; o++;
  if (pl === 126) { if (b.length < o + 2) return null; pl = b.readUInt16BE(o); o += 2; }
  else if (pl === 127) { if (b.length < o + 8) return null; pl = (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]; o += 8; }
  if (b.length < o + pl) return null;
  return { opcode: op, payload: b.slice(o, o + pl).toString('utf8'), len: o + pl };
}

main().catch(e => { console.error(e.message); process.exit(1); });
