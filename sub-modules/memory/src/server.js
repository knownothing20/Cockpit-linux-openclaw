const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const PORT = parseInt(process.env.MEMORY_PORT || '8200');
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, message, status = 500) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

function serveStatic(req, res, next) {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? '/index.html' : req.url);
  const ext = path.extname(filePath);
  if (!ext || !MIME_TYPES[ext]) filePath = path.join(PUBLIC_DIR, 'index.html');

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // In native-loader (shell) mode, fall through to shell static handler
      if (typeof next === 'function') return next();
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ct = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache, no-store' });
    res.end(data);
  });
}

// ── Data collection ──────────────────────────────────────────

function getSystemMemory() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const parse = (key) => {
      const m = meminfo.match(new RegExp(key + ':\\s+(\\d+)'));
      return m ? parseInt(m[1]) * 1024 : 0; // convert kB to bytes
    };
    const total = parse('MemTotal');
    const available = parse('MemAvailable');
    const used = total - available;
    const swapTotal = parse('SwapTotal');
    const swapFree = parse('SwapFree');
    const swapUsed = swapTotal - swapFree;
    const buffers = parse('Buffers');
    const cached = parse('Cached');
    return { total, used, available, buffers, cached, swapTotal, swapUsed, swapFree, percent: total ? Math.round(used / total * 100) : 0 };
  } catch (e) {
    return { total: 0, used: 0, available: 0, buffers: 0, cached: 0, swapTotal: 0, swapUsed: 0, swapFree: 0, percent: 0, error: e.message };
  }
}

function getProcessList() {
  try {
    // Use ps to get process info: pid, rss, vsz, %mem, command
    const output = execSync(
      `ps -eo pid,rss,vsz,%mem,comm,args --sort=-%mem | head -200`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const lines = output.trim().split('\n');
    const processes = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 5) continue;
      const pid = parseInt(parts[0]);
      const rss = parseInt(parts[1]) * 1024; // kB to bytes
      const vsz = parseInt(parts[2]) * 1024;
      const memPct = parseFloat(parts[3]);
      const comm = parts[4];
      const args = parts.slice(5).join(' ');
      if (pid === process.pid) continue; // skip self
      processes.push({ pid, rss, vsz, memPct, comm, args: args.substring(0, 200) });
    }
    return processes;
  } catch (e) {
    return [];
  }
}

function groupBySoftware(processes) {
  const groups = {};
  for (const p of processes) {
    let group = null;
    const cmd = (p.comm + ' ' + p.args).toLowerCase();
    const comm = p.comm.toLowerCase();
    const args = p.args.toLowerCase();
    const isKernelThread = p.args.startsWith('[') || p.pid < 50;

    // ── Priority matching: most specific first ──────────

    // Kernel threads
    if (isKernelThread) { group = 'Kernel'; }

    // OpenClaw ecosystem (must be before Node.js)
    else if (args.includes('openclaw') || args.includes('cockpit-shell') || args.includes('hermes-agent') || comm === 'openclaw' || comm === 'inotifywait') { group = 'OpenClaw'; }

    // IDE / Editor (must be before Shell/Node.js since they spawn bash/node)
    else if (args.includes('windsurf-server') || args.includes('cursor-server') || args.includes('vscode-server') || args.includes('code-server')) { group = 'IDE Server'; }
    else if (args.includes('/usr/lib/chromium') || args.includes('/opt/google/chrome') || args.includes('/usr/lib/firefox') || comm === 'chrome_crashpad') { group = 'Browser'; }

    // Node.js (but not if already matched above)
    else if (comm === 'node' || args.includes('/bin/node ') || args.includes('/usr/bin/node') || args.match(/\bnode\s/)) { group = 'Node.js'; }

    // Python
    else if (comm === 'python3' || comm === 'python' || args.includes('/bin/python') || args.includes('/usr/bin/python')) { group = 'Python'; }

    // Java
    else if (comm === 'java' || args.includes('/bin/java ')) { group = 'Java'; }

    // Go
    else if (comm === 'go ' || args.includes('/usr/local/go') || args.includes('/usr/bin/go ')) { group = 'Go'; }

    // Rust
    else if (comm === 'cargo' || args.includes('/.cargo/bin') || args.includes('rustup')) { group = 'Rust'; }

    // Databases
    else if (cmd.includes('postgres') || cmd.includes('pg_')) { group = 'PostgreSQL'; }
    else if (cmd.includes('mongod')) { group = 'MongoDB'; }
    else if (comm === 'redis-server' || comm === 'redis-sentinel') { group = 'Redis'; }
    else if (cmd.includes('mysql') || cmd.includes('mariadbd')) { group = 'MySQL'; }

    // Web servers
    else if (cmd.includes('nginx')) { group = 'Nginx'; }
    else if (cmd.includes('apache') || cmd.includes('httpd')) { group = 'Apache'; }
    else if (cmd.includes('caddy')) { group = 'Caddy'; }

    // Container / Virtualization
    else if (cmd.includes('dockerd') || cmd.includes('docker-proxy') || cmd.includes('docker-init')) { group = 'Docker'; }
    else if (cmd.includes('containerd')) { group = 'Containerd'; }
    else if (cmd.includes('qemu') || cmd.includes('kvm') || cmd.includes('libvirt')) { group = 'Virtualization'; }

    // SSH
    else if (comm === 'sshd' || comm === 'sshd-session' || comm === 'sftp-server' || cmd.includes('sshd: ')) { group = 'SSH'; }

    // XRDP
    else if (comm.startsWith('xrdp')) { group = 'XRDP'; }

    // Samba
    else if (comm === 'smbd' || comm === 'nmbd' || comm === 'smbd-notifyd' || comm === 'smbd-cleanupd') { group = 'Samba'; }

    // System services
    else if (comm.startsWith('systemd') || comm === '(sd-pam)') { group = 'Systemd'; }
    else if (comm === 'cron' || comm === 'crond') { group = 'Cron'; }
    else if (comm === 'dbus-daemon' || comm === 'dbus') { group = 'D-Bus'; }
    else if (cmd.includes('networkmanager') || cmd.includes('wpa_supplicant') || cmd.includes('modemmanager')) { group = 'Network'; }
    else if (cmd.includes('avahi')) { group = 'Avahi'; }
    else if (cmd.includes('cupsd') || cmd.includes('cups-')) { group = 'Printing'; }
    else if (comm === 'polkitd' || comm === 'polkit-agent') { group = 'PolicyKit'; }
    else if (comm === 'accounts-daemon') { group = 'Accounts'; }
    else if (comm === 'rtkit-daemon') { group = 'RealtimeKit'; }
    else if (comm === 'qemu-ga') { group = 'QEMU Guest'; }
    else if (comm === 'unattended-upgr') { group = 'Upgrades'; }
    else if (comm === 'agetty' || comm === 'login' || comm === 'loginctl') { group = 'Login'; }
    else if (comm === 'syslogd' || comm === 'rsyslogd' || comm === 'journald') { group = 'Logging'; }

    // Audio
    else if (comm === 'pipewire' || comm === 'pipewire-pulse' || comm === 'wireplumber' || comm === 'pulseaudio') { group = 'Audio'; }

    // Desktop / GNOME / X11
    else if (comm.startsWith('gvfs') || comm.startsWith('xdg-') || comm === 'dconf-service' || comm === 'gnome-keyring-d' || comm === 'at-spi-bus-laun' || comm === 'at-spi2-registr' || comm === 'goa-daemon' || comm === 'gdm' || comm === 'gnome-shell' || comm === 'xwayland' || comm === 'Xwayland' || comm === 'xauth') { group = 'Desktop'; }

    // Shell
    else if (comm === 'bash' || comm === 'zsh' || comm === 'dash' || comm === 'fish') { group = 'Shell'; }
    else if (comm === 'sh' && !args.includes('/bin/')) { group = 'Shell'; }

    // Short-lived commands (ps, grep, head, sleep, cat, etc.)
    else if (['ps', 'grep', 'head', 'tail', 'cat', 'sleep', 'awk', 'sed', 'sort', 'wc', 'tr', 'cut', 'xargs', 'find', 'ls', 'curl', 'wget'].includes(comm)) { group = 'Transient'; }

    // Fallback
    else { group = 'Other'; }

    if (!groups[group]) groups[group] = { name: group, rss: 0, count: 0, processes: [] };
    groups[group].rss += p.rss;
    groups[group].count += 1;
    groups[group].processes.push(p);
  }

  // Sort groups by rss desc, but always put Kernel and Transient at the end
  return Object.values(groups).sort((a, b) => {
    const order = (g) => { if (g === 'Kernel') return 9998; if (g === 'Transient') return 9999; return 0; };
    const oa = order(a.name), ob = order(b.name);
    if (oa !== ob) return oa - ob;
    return b.rss - a.rss;
  });
}

// ── HTTP handler ─────────────────────────────────────────────

function handler(req, res, next) {
  const url = req.url.split('?')[0];
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API routes
  if (url === '/api/health' && method === 'GET') {
    const mem = getSystemMemory();
    sendJson(res, { ok: true, memoryPercent: mem.percent, checkedAt: new Date().toISOString() });
    return;
  }

  if (url === '/api/system-memory' && method === 'GET') {
    sendJson(res, getSystemMemory());
    return;
  }

  if (url === '/api/processes' && method === 'GET') {
    const processes = getProcessList();
    const groups = groupBySoftware(processes);
    const mem = getSystemMemory();
    sendJson(res, { system: mem, groups, processes, count: processes.length, checkedAt: new Date().toISOString() });
    return;
  }

  if (url === '/api/kill' && method === 'POST') {
    const handleParsed = (data) => {
      try {
        const obj = typeof data === 'string' ? JSON.parse(data || '{}') : data;
        const { pid, signal } = obj || {};
        if (!pid || typeof pid !== 'number' || pid <= 1) {
          sendError(res, 'Invalid PID', 400);
          return;
        }
        const sig = signal || 'SIGTERM';
        // Only allow safe signals
        if (!['SIGTERM', 'SIGINT', 'SIGKILL'].includes(sig)) {
          sendError(res, 'Invalid signal', 400);
          return;
        }
        try {
          process.kill(pid, sig);
          sendJson(res, { success: true, pid, signal: sig, message: `Sent ${sig} to PID ${pid}` });
        } catch (e) {
          sendError(res, `Failed to kill PID ${pid}: ${e.message}`, 400);
        }
      } catch (e) {
        sendError(res, 'Invalid JSON body', 400);
      }
    };
    // express.json() may have pre-parsed the body in shell (native-loader) mode
    if (req.body !== undefined) {
      handleParsed(req.body);
    } else {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => handleParsed(body));
    }
    return;
  }

  // Static files
  serveStatic(req, res, next);
}

if (require.main === module) {
  const server = http.createServer(handler);

  process.on('unhandledRejection', (reason) => {
    console.error('[memory] Unhandled rejection:', reason);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[memory-monitor] Listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  handler,
  healthFn: () => true,
  capabilities: [],
};
