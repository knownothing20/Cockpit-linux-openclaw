const http = require('http');
const path = require('path');
const fs = require('fs');
const { handleRequest } = require('./routes');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = process.env.PORT || config.port || 17152;
const HOST = config.host || '0.0.0.0';
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'shell-ui', 'modules', 'skill-manager');

function handler(req, res) {
  const url = req.url.replace(/\?.*$/, '');

  // Root path → embed page
  if (url === '/' || url === '/index.html') {
    const htmlPath = path.join(FRONTEND_DIR, 'skill-manager-embed.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf8'));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Page not found');
    }
    return;
  }

  // API routes
  if (handleRequest(req, res)) return;

  // Static files
  if (url.startsWith('/public/') || url.endsWith('.html')) {
    const filePath = path.join(FRONTEND_DIR, path.basename(url));
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'text/plain';
      try {
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
        res.end(fs.readFileSync(filePath, 'utf8'));
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Read error');
      }
      return;
    }
  }

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, service: 'skill-manager' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

if (require.main === module) {
  const server = http.createServer(handler);
  server.timeout = 60000;

  process.on('unhandledRejection', (reason) => {
    console.error('[skill-manager] Unhandled rejection:', reason);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[skill-manager] listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  handler,
  healthFn: () => true,
  capabilities: [],
};
