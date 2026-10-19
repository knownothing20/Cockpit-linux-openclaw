const http = require('http');
const { getModuleById } = require('./app-registry');
const { getModulePort, getModuleBaseUrl } = require('./module-starter');

const proxyAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 2,
  keepAliveMsecs: 30000,
  timeout: 30000,
});

function createModuleProxy() {
  return async (req, res, next) => {
    const pathToMatch = req.originalUrl || req.path;
    const match = pathToMatch.match(/^\/(?:apps|api\/proxy)\/([^\/]+)(?:\/(.*))?$/);
    if (!match) return next();

    const moduleId = match[1];
    const module = getModuleById(moduleId);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }

    if (module.integration !== 'proxy') {
      // Native modules are served inline; let them fall through to their middleware
      return next();
    }

    // Get the actual URL from module-starter (new unified port)
    const dynamicUrl = getModuleBaseUrl(moduleId);
    
    // Build target URL - use dynamic URL if available, fallback to baseUrl
    let target;
    if (dynamicUrl) {
      target = dynamicUrl;
    } else {
      target = module.baseUrl;
    }
    
    if (!target) {
      return res.status(500).json({ error: 'Module not started' });
    }

    const embedPath = module.embedPath || '/';
    const subPath = match[2] || '';

    let targetPath;
    if (!subPath) {
      targetPath = embedPath;
    } else {
      targetPath = '/' + subPath;
    }

    const targetUrl = new URL(targetPath, target);

    const headers = {
      ...req.headers,
      host: targetUrl.host,
    };
    delete headers['cookie'];
    delete headers['authorization'];

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers,
      timeout: 30000,
      agent: proxyAgent,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode);
      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const isMainPage = !subPath || subPath === '';

      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (key.toLowerCase() === 'content-security-policy') continue;
        if (isHtml && key.toLowerCase() === 'content-length') continue;
        res.setHeader(key, value);
      }

      if (isHtml && isMainPage) {
        const baseTag = `<base href="/apps/${moduleId}/">`;
        const apiRewriteScript = `<script>(function(){var P='/apps/${moduleId}';var OF=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&!u.startsWith(P)&&!u.startsWith('/unified-theme')){u=P+u;}return OF.call(this,u,o);};var OX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&u.charAt(0)==='/'&&!u.startsWith(P)&&!u.startsWith('/unified-theme')){u=P+u;}return OX.apply(this,arguments);};var OS=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==='href'||n==='src'||n==='action')&&typeof v==='string'&&v.charAt(0)==='/'&&!v.startsWith(P)&&!v.startsWith('/unified-theme')&&!v.startsWith('/public/')){v=P+v;}return OS.call(this,n,v);};})();</script>`;
        const themeScript = `<script>(function(){var t=localStorage.getItem('openclaw-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}else{document.documentElement.setAttribute('data-theme','dark');}window.addEventListener('message',function(e){if(e.data&&e.data.type==='openclaw-theme'){document.documentElement.setAttribute('data-theme',e.data.theme);localStorage.setItem('openclaw-theme',e.data.theme);}});})();</script>`;
        const unifiedThemeCss = `<link rel="stylesheet" href="/unified-theme.css">`;
        const injectContent = baseTag + apiRewriteScript + unifiedThemeCss + themeScript;
        let injected = false;
        let buffer = Buffer.alloc(0);

        proxyRes.on('data', (chunk) => {
          if (injected) {
            res.write(chunk);
            return;
          }
          buffer = Buffer.concat([buffer, chunk]);
          const str = buffer.toString('utf8');
          const headPos = str.indexOf('<head');
          if (headPos !== -1) {
            const insertAfter = str.indexOf('>', headPos);
            if (insertAfter !== -1) {
              injected = true;
              const before = str.substring(0, insertAfter + 1);
              const after = str.substring(insertAfter + 1);
              res.write(before + injectContent + after);
              buffer = Buffer.alloc(0);
            }
          } else if (buffer.length > 65536) {
            injected = true;
            res.write(buffer);
            buffer = Buffer.alloc(0);
          }
        });

        proxyRes.on('end', () => {
          if (!injected && buffer.length > 0) {
            res.write(buffer);
          }
          res.end();
        });
      } else {
        const contentLength = parseInt(proxyRes.headers['content-length'], 10);
        if (contentLength > 50 * 1024 * 1024) {
          proxyRes.resume();
          if (!res.headersSent) res.status(507).json({ error: 'Response too large' });
          return;
        }
        proxyRes.setTimeout(30000, () => {
          proxyRes.destroy();
          if (!res.headersSent) res.status(504).json({ error: 'Response timeout', moduleId });
        });
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      console.error(`[proxy] ${moduleId} error:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Module offline', moduleId });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Module timeout', moduleId });
      }
    });

    req.pipe(proxyReq);
  };
}

function createRefererFallbackProxy() {
  return async (req, res, next) => {
    const referer = req.headers['referer'];
    if (!referer) return next();

    let moduleId = null;
    try {
      const refererUrl = new URL(referer);
      const refererMatch = refererUrl.pathname.match(/^\/apps\/([^\/]+)/);
      if (refererMatch) {
        moduleId = refererMatch[1];
      }
    } catch (e) {
      return next();
    }

    if (!moduleId) return next();

    const module = getModuleById(moduleId);
    if (!module || module.integration !== 'proxy' || !module.baseUrl) {
      return next();
    }

    // Use dynamic URL if available
    const dynamicUrl = getModuleBaseUrl(moduleId);
    const target = dynamicUrl || module.baseUrl;
    const targetUrl = new URL(req.originalUrl || req.path, target);

    const headers = { ...req.headers, host: targetUrl.host };
    delete headers['cookie'];
    delete headers['authorization'];

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers,
      timeout: 30000,
      agent: proxyAgent,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (key.toLowerCase() === 'content-security-policy') continue;
        res.setHeader(key, value);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[referer-proxy] ${moduleId} error:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Module offline', moduleId });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Module timeout', moduleId });
      }
    });

    req.pipe(proxyReq);
  };
}

module.exports = { createModuleProxy, createRefererFallbackProxy };
