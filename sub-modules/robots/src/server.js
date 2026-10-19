const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = parseInt(process.env.ROBOTS_PORT || '8100');
const HOST = '0.0.0.0';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '7000');
const DASHBOARD_DIR = path.join(os.homedir(), '.openclaw/software/openclaw-dashboard');
const CONFIG_FILE = path.join(os.homedir(), '.openclaw/openclaw.json');
const AGENTS_DIR = path.join(os.homedir(), '.openclaw/agents');
const GATEWAY_PORT = 18789;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const apiCache = {
  agents: { data: null, time: 0, ttl: 15000 },
  activity: { data: null, time: 0, ttl: 10000 },
  models: { data: null, time: 0, ttl: 30000 },
  config: { data: null, time: 0, ttl: 5000 },
  agentMeta: { data: null, time: 0, ttl: 30000 },
  cronJobs: { data: null, time: 0, ttl: 30000 },
  sessionStats: { data: null, time: 0, ttl: 30000 },
  health: { data: null, time: 0, ttl: 10000 },
  topology: { data: null, time: 0, ttl: 30000 },
};

function getCache(key) {
  const c = apiCache[key];
  if (!c || !c.data) return null;
  if (Date.now() - c.time > c.ttl) return null;
  return c.data;
}

function setCache(key, data) {
  apiCache[key].data = data;
  apiCache[key].time = Date.now();
}

function invalidateCache(keys) {
  keys.forEach(k => { apiCache[k].data = null; apiCache[k].time = 0; });
}

function readConfig() {
  const cached = getCache('config');
  if (cached) return cached;
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    setCache('config', config);
    return config;
  } catch (e) {
    return { agents: { list: [], defaults: {} }, models: { providers: {}, defaults: {} }, bindings: [], channels: {} };
  }
}

function atomicWriteJSON(filePath, data) {
  const tmpFile = filePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, filePath);
}

function getDefaultModelConfig(config) {
  const agentDefaults = config.agents?.defaults || {};
  const modelDefaults = config.models?.defaults || {};
  const agentDefaultModel = agentDefaults.model;
  const modelDefaultModel = modelDefaults.model;
  const primary = typeof agentDefaultModel === 'string'
    ? agentDefaultModel
    : (agentDefaultModel?.primary || modelDefaultModel?.primary || modelDefaultModel || '');
  const fallbacks = Array.isArray(agentDefaultModel?.fallbacks)
    ? agentDefaultModel.fallbacks
    : (Array.isArray(agentDefaults.fallbacks)
      ? agentDefaults.fallbacks
      : (Array.isArray(modelDefaults.fallbacks) ? modelDefaults.fallbacks : []));
  return { primary, fallbacks };
}

function getAgentPrimaryModel(agent, config) {
  const defaults = getDefaultModelConfig(config);
  return agent.model || agent.params?.model || defaults.primary || 'unknown';
}

function getAgentFallbackModels(agent, config) {
  const defaults = getDefaultModelConfig(config);
  return Array.isArray(agent.fallbacks)
    ? agent.fallbacks
    : (Array.isArray(agent.params?.fallback) ? agent.params.fallback : defaults.fallbacks);
}

function isPlaceholder(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  return lower.includes('pick something') || lower.includes('_(') || lower.startsWith('_') || text.length < 2;
}

function getAgentMeta(agentId, workspaceDir) {
  let emoji = '🤖';
  let name = agentId;

  const identityFile = path.join(workspaceDir, 'IDENTITY.md');
  if (fs.existsSync(identityFile)) {
    const content = fs.readFileSync(identityFile, 'utf8');
    const emojiMatch = content.match(/\*\*Emoji[：:]\*\*\s*([^\n]+)/i);
    if (emojiMatch && !isPlaceholder(emojiMatch[1])) emoji = emojiMatch[1].trim();
    const nameMatch = content.match(/\*\*Name[：:]\*\*\s*([^\n]+)/i);
    if (nameMatch && !isPlaceholder(nameMatch[1])) name = nameMatch[1].trim();
  }

  const soulFile = path.join(workspaceDir, 'SOUL.md');
  if (fs.existsSync(soulFile)) {
    const content = fs.readFileSync(soulFile, 'utf8');
    const codeBlockMatch = content.match(/```\s*\n?([^\n*]+\*\*[^*]+\*\*)/);
    if (codeBlockMatch) {
      const firstLine = codeBlockMatch[1];
      const emojiMatch = firstLine.match(/^([\u{1F300}-\u{1F9FF}]+)\s*/u);
      if (emojiMatch) emoji = emojiMatch[1];
    }
    const titleMatch = content.match(/^#\s*(.+)$/m);
    if (titleMatch) {
      const title = titleMatch[1].trim();
      const cleaned = title.replace(/^[\u{1F300}-\u{1F9FF}]+\s*/u, '').replace(/SOUL\.md\s*-?\s*/i, '').replace(/[·•]/g, '-').trim();
      if (cleaned && cleaned.length > 2 && !cleaned.match(/^[_\(]/)) name = cleaned;
    }
  }

  return { emoji, name };
}

function getAgentMetaAll() {
  const cached = getCache('agentMeta');
  if (cached) return cached;

  const config = readConfig();
  const agentsList = config.agents?.list || [];
  const metaMap = {};
  for (const agent of agentsList) {
    const workspaceDir = agent.workspace || path.join(os.homedir(), '.openclaw/workspace-' + agent.id);
    metaMap[agent.id] = getAgentMeta(agent.id, workspaceDir);
  }
  setCache('agentMeta', metaMap);
  return metaMap;
}

function loadCronJobs() {
  const cached = getCache('cronJobs');
  if (cached) return cached;
  const cronJobsPath = path.join(os.homedir(), '.openclaw/cron/jobs.json');
  if (!fs.existsSync(cronJobsPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(cronJobsPath, 'utf8'));
    const jobs = Array.isArray(raw) ? raw : (Array.isArray(raw.jobs) ? raw.jobs : []);
    setCache('cronJobs', jobs);
    return jobs;
  } catch { return []; }
}

function loadCronJobStates() {
  const statePath = path.join(os.homedir(), '.openclaw/cron/jobs-state.json');
  if (!fs.existsSync(statePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return raw.jobs || raw;
  } catch { return {}; }
}

function loadAuthState(agentId) {
  const authStatePath = path.join(AGENTS_DIR, agentId, 'agent/auth-state.json');
  if (!fs.existsSync(authStatePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
  } catch { return null; }
}

function computeSessionStats(agentId) {
  const cached = getCache('sessionStats');
  if (cached && cached[agentId]) return cached[agentId];

  const result = { lastActive: null, totalTokens: 0, messageCount: 0, sessionCount: 0, todayAvgResponseMs: 0 };
  const sessionsDir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return result;

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));
    result.sessionCount = files.length;

    let latestMtime = 0;
    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(sessionsDir, file));
        if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
      } catch {}
    }
    result.lastActive = latestMtime > 0 ? latestMtime : null;

    const summaryFile = path.join(AGENTS_DIR, agentId, 'session-summary.json');
    if (fs.existsSync(summaryFile)) {
      try {
        const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        result.totalTokens = summary.totalTokens || 0;
        result.messageCount = summary.messageCount || 0;
        result.todayAvgResponseMs = summary.todayAvgResponseMs || 0;
      } catch {}
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const todayFiles = files.filter(f => {
        try { return fs.statSync(path.join(sessionsDir, f)).mtime.toISOString().slice(0, 10) === today; } catch { return false; }
      });
      const filesToScan = todayFiles.length > 0 ? todayFiles : files.slice(-3);
      const dayMap = {};

      for (const file of filesToScan) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
          const lines = content.trim().split('\n');
          const messages = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type !== 'message' || !entry.message || !entry.timestamp) continue;
              const ts = entry.timestamp;
              const date = ts.slice(0, 10);
              const msg = entry.message;
              messages.push({ role: msg.role, ts, stopReason: msg.stopReason });
              if (msg.role === 'assistant' && msg.usage) {
                if (!dayMap[date]) dayMap[date] = { totalTokens: 0, messageCount: 0, responseTimes: [] };
                const day = dayMap[date];
                day.totalTokens += msg.usage.totalTokens || (msg.usage.input || 0) + (msg.usage.output || 0);
                day.messageCount += 1;
              }
            } catch {}
          }
          for (let i = 0; i < messages.length; i++) {
            if (messages[i].role !== 'user') continue;
            for (let j = i + 1; j < messages.length; j++) {
              if (messages[j].role === 'assistant' && messages[j].stopReason === 'stop') {
                const diffMs = new Date(messages[j].ts).getTime() - new Date(messages[i].ts).getTime();
                if (diffMs > 0 && diffMs < 600000) {
                  const date = messages[i].ts.slice(0, 10);
                  if (!dayMap[date]) dayMap[date] = { totalTokens: 0, messageCount: 0, responseTimes: [] };
                  dayMap[date].responseTimes.push(diffMs);
                }
                break;
              }
            }
          }
        } catch {}
      }

      for (const date of Object.keys(dayMap)) {
        const day = dayMap[date];
        result.totalTokens += day.totalTokens;
        result.messageCount += day.messageCount;
        if (date === today && day.responseTimes.length > 0) {
          result.todayAvgResponseMs = Math.round(day.responseTimes.reduce((a, b) => a + b, 0) / day.responseTimes.length);
        }
      }
    }

    const allCached = cached || {};
    allCached[agentId] = result;
    setCache('sessionStats', allCached);
  } catch {}

  return result;
}

function extractCurrentActivity(agentId) {
  const sessionsDir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));
    if (files.length === 0) return null;

    let latestFile = null;
    let latestMtime = 0;
    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(sessionsDir, file));
        if (stat.mtimeMs > latestMtime) { latestMtime = stat.mtimeMs; latestFile = file; }
      } catch {}
    }
    if (!latestFile) return null;

    const content = fs.readFileSync(path.join(sessionsDir, latestFile), 'utf-8');
    const lines = content.trim().split('\n');
    const lastLines = lines.slice(-30);

    for (let i = lastLines.length - 1; i >= 0; i--) {
      if (!lastLines[i].trim()) continue;
      try {
        const entry = JSON.parse(lastLines[i]);
        if (entry.type !== 'message' || !entry.message) continue;
        const msg = entry.message;
        if (msg.role !== 'assistant') continue;
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'toolCall' && typeof block.name === 'string') {
            const toolName = block.name;
            if (toolName === 'edit' || toolName === 'write' || toolName === 'read') {
              const filePath = block.params?.path || block.params?.file || '';
              return toolName + ': ' + path.basename(filePath);
            }
            if (toolName === 'exec') {
              const cmd = block.params?.command || block.params?.cmd || '';
              return 'exec: ' + cmd.substring(0, 50);
            }
            return '调用: ' + toolName;
          }
        }
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            const firstLine = block.text.trim().split('\n')[0];
            if (firstLine.length > 60) return firstLine.substring(0, 60) + '...';
            return firstLine;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function parseSessionWorkflow(agentId, limit) {
  const sessionsDir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));
    if (files.length === 0) return [];

    let latestFile = null;
    let latestMtime = 0;
    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(sessionsDir, file));
        if (stat.mtimeMs > latestMtime) { latestMtime = stat.mtimeMs; latestFile = file; }
      } catch {}
    }
    if (!latestFile) return [];

    const content = fs.readFileSync(path.join(sessionsDir, latestFile), 'utf-8');
    const lines = content.trim().split('\n');
    const maxLines = limit || 200;
    const scanLines = lines.slice(-maxLines);

    const steps = [];
    let stepIdx = 0;

    for (const line of scanLines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || !entry.message) continue;
        const msg = entry.message;
        const ts = entry.timestamp || '';

        if (msg.role === 'user' && msg.content) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text.trim()) {
            steps.push({ idx: stepIdx++, type: 'user', text: text.substring(0, 200), ts, tokens: msg.usage?.input || 0 });
          }
        } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text && block.text.trim()) {
              steps.push({ idx: stepIdx++, type: 'text', text: block.text.substring(0, 200), ts, tokens: msg.usage?.output || 0 });
            } else if (block.type === 'toolCall' && block.name) {
              const toolInfo = { idx: stepIdx++, type: 'toolCall', name: block.name, ts, params: {} };
              if (block.name === 'exec' && block.params?.command) {
                toolInfo.params = { command: block.params.command.substring(0, 100) };
              } else if ((block.name === 'edit' || block.name === 'write' || block.name === 'read') && block.params?.path) {
                toolInfo.params = { path: path.basename(block.params.path) };
              } else if (block.name === 'dispatchAgent' || block.name === 'spawn') {
                toolInfo.type = 'subagent';
                toolInfo.params = { agentId: block.params?.agentId || block.params?.id || '', message: (block.params?.message || '').substring(0, 100) };
              }
              steps.push(toolInfo);
            } else if (block.type === 'toolResult') {
              const resultText = typeof block.result === 'string' ? block.result : (block.result?.text || block.result?.output || '');
              steps.push({ idx: stepIdx++, type: 'toolResult', name: block.name || block.toolUseId || '', text: resultText.substring(0, 150), ts, isError: block.isError || false });
            }
          }
        }
      } catch {}
    }

    return steps;
  } catch {}
  return [];
}

function computeTopology() {
  const cached = getCache('topology');
  if (cached) return cached;

  const config = readConfig();
  const agentsList = config.agents?.list || [];
  const metaMap = getAgentMetaAll();

  const nodes = agentsList.map(a => {
    const meta = metaMap[a.id] || { emoji: '🤖', name: a.id };
    const allow = a.subagents?.allowAgents;
    return {
      id: a.id, name: meta.name, emoji: meta.emoji,
      model: a.model || '', allowAgents: Array.isArray(allow) ? allow : (allow === '*' ? ['*'] : []),
    };
  });

  const edges = [];
  const callCounts = {};

  for (const agent of agentsList) {
    const allow = agent.subagents?.allowAgents;
    const targets = Array.isArray(allow) ? allow : [];
    for (const target of targets) {
      if (target === '*') {
        for (const other of agentsList) {
          if (other.id !== agent.id) {
            const key = agent.id + '->' + other.id;
            edges.push({ from: agent.id, to: other.id, type: 'config' });
            callCounts[key] = (callCounts[key] || 0);
          }
        }
      } else {
        const key = agent.id + '->' + target;
        edges.push({ from: agent.id, to: target, type: 'config' });
        callCounts[key] = (callCounts[key] || 0);
      }
    }
  }

  for (const agent of agentsList) {
    const sessionsDir = path.join(AGENTS_DIR, agent.id, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;

    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));
      const filesToScan = files.slice(-5);

      for (const file of filesToScan) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
          const lines = content.trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type !== 'message' || !entry.message) continue;
              const msg = entry.message;
              if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
              for (const block of msg.content) {
                if (block.type === 'toolCall' && (block.name === 'dispatchAgent' || block.name === 'spawn')) {
                  const targetId = block.params?.agentId || block.params?.id || '';
                  if (targetId) {
                    const key = agent.id + '->' + targetId;
                    callCounts[key] = (callCounts[key] || 0) + 1;
                    if (!edges.find(e => e.from === agent.id && e.to === targetId)) {
                      edges.push({ from: agent.id, to: targetId, type: 'runtime' });
                    }
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  for (const edge of edges) {
    const key = edge.from + '->' + edge.to;
    edge.count = callCounts[key] || 0;
  }

  const bindings = (config.bindings || []).map(b => ({
    agentId: b.agentId,
    channel: b.match?.channel || '',
    peerId: b.match?.peer?.id || '',
    peerKind: b.match?.peer?.kind || '',
  }));

  const data = { nodes, edges, bindings };
  setCache('topology', data);
  return data;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['http://localhost:7000', 'http://localhost:7001', 'http://localhost:8100'];
  const allowOrigin = allowed.includes(origin) ? origin : (origin ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function serveStaticFile(filePath, res) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

function proxyToDashboard(req, res, targetPath) {
  const targetUrl = `http://127.0.0.1:${DASHBOARD_PORT}${targetPath}`;
  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${DASHBOARD_PORT}` },
  }, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];
    delete headers['set-cookie'];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Dashboard service unavailable' }));
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function readBody(req, maxBytes) {
  const limit = maxBytes || 1024 * 1024;
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
    return Promise.resolve(JSON.stringify(req.body || {}));
  }
  if (req.readableEnded || req.complete) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', (e) => reject(e));
  });
}

function sendJson(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, error, status) {
  res.writeHead(status || 500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: String(error) }));
}

const server = http.createServer(handler);

async function handler(req, res) {
  try {
  if (setCorsHeaders(req, res)) return;

  const url = req.url.split('?')[0];

  if (url === '/' || url === '/agents') {
    serveStaticFile(path.join(__dirname, '../../../shell-ui/modules/robots/index.html'), res);
    return;
  }

  if (url === '/office' || url === '/robots' || url === '/pixel-office') {
    res.writeHead(302, { 'Location': '/' });
    res.end();
    return;
  }

  // GET /api/agents
  if (url === '/api/agents' && req.method === 'GET') {
    const cached = getCache('agents');
    if (cached) { sendJson(res, cached); return; }

    try {
      const config = readConfig();
      const agentsList = config.agents?.list || [];
      const agentDefaults = config.agents?.defaults || {};
      const modelDefaults = config.models?.defaults || {};
      const bindings = config.bindings || [];
      const feishuGroups = config.channels?.feishu?.groups || {};
      const defaults = { ...agentDefaults, model: getDefaultModelConfig(config) };

      const agentChannels = {};
      bindings.forEach((b) => {
        if (!agentChannels[b.agentId]) agentChannels[b.agentId] = [];
        if (b.match?.channel === 'feishu' && b.match?.peer?.id) {
          const groupInfo = feishuGroups[b.match.peer.id] || {};
          agentChannels[b.agentId].push({ platform: 'feishu', groupId: b.match.peer.id, enabled: groupInfo.enabled !== false });
        }
      });

      const metaMap = getAgentMetaAll();
      const cronJobs = loadCronJobs();
      const cronStates = loadCronJobStates();

      const agents = agentsList.map((agent) => {
        const meta = metaMap[agent.id] || { emoji: '🤖', name: agent.id };
        const fullModel = getAgentPrimaryModel(agent, config);
        let modelName = fullModel;
        let providerId = 'unknown';
        if (modelName.includes('/')) { const parts = modelName.split('/'); providerId = parts[0]; modelName = parts[1]; }

        const sessionInfo = computeSessionStats(agent.id);
        let state = 'offline';
        if (sessionInfo.lastActive) {
          const timeSince = Date.now() - sessionInfo.lastActive;
          if (timeSince < 300000) state = 'working';
          else if (timeSince < 86400000) state = 'idle';
        }

        const agentCronJobs = cronJobs.filter((j) => j.agentId === agent.id);
        const currentActivity = (state === 'working' || state === 'idle') ? extractCurrentActivity(agent.id) : null;
        const authState = loadAuthState(agent.id);

        const cronJobsWithState = agentCronJobs.map((j) => {
          const jState = cronStates[j.id]?.state || {};
          return {
            jobId: j.id, label: j.label || j.name, enabled: j.enabled !== false,
            lastStatus: jState.lastRunStatus || jState.lastStatus || 'pending',
            lastSummary: jState.lastDiagnosticSummary || jState.lastSummary || null,
            nextRunAt: jState.nextRunAtMs || null,
            consecutiveFailures: jState.consecutiveErrors || 0,
            durationMs: jState.lastDurationMs || null,
            lastError: jState.lastError || null,
            lastDiagnostics: jState.lastDiagnostics || null,
          };
        });

        const health = computeAgentHealth(agent.id, state, sessionInfo, authState, cronJobsWithState);

        return {
          id: agent.id, name: meta.name, emoji: meta.emoji,
          model: modelName, provider: providerId,
          fullModel,
          fallbacks: getAgentFallbackModels(agent, config),
          platforms: agentChannels[agent.id] || [],
          session: sessionInfo, state, currentActivity,
          subagents: [], recentSubagents: [],
          cronJobs: cronJobsWithState,
          health,
        };
      });

      const gateway = { port: GATEWAY_PORT, host: '', token: '' };
      const data = { agents, defaults, gateway };
      setCache('agents', data);
      sendJson(res, data);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/health
  if (url === '/api/health' && req.method === 'GET') {
    const cached = getCache('health');
    if (cached) { sendJson(res, cached); return; }

    // Guard: ensure health responds within 1500ms even if Gateway is slow
    let healthResponded = false;
    const healthTimeout = setTimeout(() => {
      if (!healthResponded) {
        healthResponded = true;
        sendJson(res, { healthy: 0, warning: 0, critical: 0, alerts: [], gateway: { status: 'timeout', ok: false }, checkedAt: Date.now(), _timeout: true });
      }
    }, 1500);

    try {
      const config = readConfig();
      const agentsList = config.agents?.list || [];
      const cronJobs = loadCronJobs();
      const cronStates = loadCronJobStates();

      let healthy = 0, warning = 0, critical = 0;
      const alerts = [];

      for (const agent of agentsList) {
        const sessionInfo = computeSessionStats(agent.id);
        let state = 'offline';
        if (sessionInfo.lastActive) {
          const timeSince = Date.now() - sessionInfo.lastActive;
          if (timeSince < 300000) state = 'working';
          else if (timeSince < 86400000) state = 'idle';
        }

        const authState = loadAuthState(agent.id);
        const agentCronJobs = cronJobs.filter(j => j.agentId === agent.id);
        const cronJobsWithState = agentCronJobs.map(j => {
          const jState = cronStates[j.id]?.state || {};
          return { jobId: j.id, label: j.label || j.name, consecutiveFailures: jState.consecutiveErrors || 0, lastError: jState.lastError || null };
        });

        const health = computeAgentHealth(agent.id, state, sessionInfo, authState, cronJobsWithState);

        if (health.level === 'critical') { critical++; alerts.push(...health.issues.map(i => ({ agentId: agent.id, ...i }))); }
        else if (health.level === 'warning') { warning++; alerts.push(...health.issues.map(i => ({ agentId: agent.id, ...i }))); }
        else { healthy++; }
      }

      for (const [jobId, jobState] of Object.entries(cronStates)) {
        const st = jobState.state || {};
        if (st.consecutiveErrors >= 3) {
          const jobDef = cronJobs.find(j => j.id === jobId);
          alerts.push({ agentId: jobDef?.agentId || 'system', type: 'cron_critical', message: `Cron "${jobDef?.name || jobId}" 连续失败 ${st.consecutiveErrors} 次`, detail: st.lastError || st.lastDiagnosticSummary || '' });
          critical++;
        } else if (st.consecutiveErrors >= 1) {
          const jobDef = cronJobs.find(j => j.id === jobId);
          alerts.push({ agentId: jobDef?.agentId || 'system', type: 'cron_warning', message: `Cron "${jobDef?.name || jobId}" 失败 ${st.consecutiveErrors} 次`, detail: st.lastError || '' });
          warning++;
        }
      }

      let gwHealth = null;
      try {
        gwHealth = await new Promise((resolve) => {
          const gwReq = http.request({ hostname: '127.0.0.1', port: GATEWAY_PORT, path: '/health', method: 'GET', timeout: 1000 }, (gwRes) => {
            let data = '';
            gwRes.on('data', chunk => data += chunk);
            gwRes.on('end', () => {
              try { const json = JSON.parse(data); resolve({ status: (json.ok || json.status === 'ok') ? 'healthy' : 'degraded', ok: true }); }
              catch { resolve({ status: 'degraded', ok: true }); }
            });
          });
          gwReq.on('error', () => resolve({ status: 'down', ok: false }));
          gwReq.on('timeout', () => { gwReq.destroy(); resolve({ status: 'down', ok: false }); });
          gwReq.end();
        });
      } catch { gwHealth = { status: 'down', ok: false }; }

      const data = { healthy, warning, critical, alerts, gateway: gwHealth, checkedAt: Date.now() };
      setCache('health', data);
      clearTimeout(healthTimeout);
      if (!healthResponded) { healthResponded = true; sendJson(res, data); }
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/agent/:id/workflow
  if (url.match(/^\/api\/agent\/[^/]+\/workflow$/) && req.method === 'GET') {
    const agentId = url.split('/')[3];
    if (!agentId || agentId.includes('..') || agentId.includes('/') || agentId.includes('\\')) {
      sendError(res, 'Invalid agent ID', 400); return;
    }
    try {
      const steps = parseSessionWorkflow(agentId, 300);
      sendJson(res, { agentId, steps, count: steps.length });
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/topology
  if (url === '/api/topology' && req.method === 'GET') {
    try {
      const data = computeTopology();
      sendJson(res, data);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/models-list
  if (url === '/api/models-list' && req.method === 'GET') {
    const cached = getCache('models');
    if (cached) { sendJson(res, cached); return; }

    try {
      const config = readConfig();
      const providers = config.models?.providers || {};
      const agentsList = config.agents?.list || [];
      const defaultConfig = getDefaultModelConfig(config);
      const defaultModel = defaultConfig.primary;
      const fallbacks = defaultConfig.fallbacks;
      const metaMap = getAgentMetaAll();

      const providersList = [];
      for (const [providerId, provider] of Object.entries(providers)) {
        const models = (provider.models || []).map((m) => ({
          id: typeof m === 'string' ? m : m.id,
          name: typeof m === 'string' ? m : (m.name || m.id),
          contextWindow: m.contextWindow || 128000,
          maxTokens: m.maxTokens || 4096,
          reasoning: m.reasoning || false,
          input: m.input || ['text'],
        }));
        const usedBy = agentsList.filter((a) => getAgentPrimaryModel(a, config).startsWith(providerId + '/')).map((a) => {
          const meta = metaMap[a.id] || { emoji: '🤖', name: a.id };
          return { id: a.id, emoji: meta.emoji, name: meta.name };
        });
        providersList.push({ id: providerId, api: provider.api || 'unknown', accessMode: provider.apiKey ? 'api_key' : 'auth', models, usedBy });
      }
      const data = { providers: providersList, defaults: { model: defaultModel, fallbacks } };
      setCache('models', data);
      sendJson(res, data);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/agent-activity
  if (url === '/api/agent-activity' && req.method === 'GET') {
    const cached = getCache('activity');
    if (cached) { sendJson(res, cached, 200); return; }

    try {
      const cronJobs = loadCronJobs();
      const agents = [];

      if (fs.existsSync(AGENTS_DIR)) {
        const agentDirs = fs.readdirSync(AGENTS_DIR).filter((id) => fs.statSync(path.join(AGENTS_DIR, id)).isDirectory());
        const metaMap = getAgentMetaAll();

        for (const agentId of agentDirs) {
          const meta = metaMap[agentId] || { emoji: '🤖', name: agentId };
          const sessionStats = computeSessionStats(agentId);
          const lastActive = sessionStats.lastActive;
          let state = 'offline';
          if (lastActive) { const timeSince = Date.now() - lastActive; if (timeSince < 300000) state = 'working'; else if (timeSince < 86400000) state = 'idle'; }
          const agentCronJobs = cronJobs.filter((j) => j.agentId === agentId);
          agents.push({
            agentId, name: meta.name, emoji: meta.emoji, state, lastActive,
            currentActivity: null, currentModel: null, isFallback: false,
            subagents: [], recentSubagents: [],
            cronJobs: agentCronJobs.map((j) => ({ jobId: j.id, label: j.label || j.name, lastStatus: j.lastStatus || 'pending' })),
          });
        }
      }

      const data = { agents };
      setCache('activity', data);
      sendJson(res, data);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/agents-list
  if (url === '/api/agents-list' && req.method === 'GET') {
    try {
      const agents = [];
      if (fs.existsSync(AGENTS_DIR)) {
        fs.readdirSync(AGENTS_DIR).forEach((agentId) => {
          const agentPath = path.join(AGENTS_DIR, agentId);
          const modelsFile = path.join(agentPath, 'agent/models.json');
          if (fs.statSync(agentPath).isDirectory()) agents.push({ id: agentId, hasModels: fs.existsSync(modelsFile) });
        });
      }
      sendJson(res, { agents });
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/agent-models/:id
  if (url.startsWith('/api/agent-models/') && req.method === 'GET') {
    const agentId = url.split('/')[3];
    if (!agentId || agentId.includes('..') || agentId.includes('/') || agentId.includes('\\')) { sendError(res, 'Invalid agent ID', 400); return; }
    try {
      const modelsFile = path.join(AGENTS_DIR, agentId, 'agent/models.json');
      if (fs.existsSync(modelsFile)) {
        const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
        const providers = models.providers || {};
        const providersList = [];
        for (const [providerId, provider] of Object.entries(providers)) {
          const modelList = (provider.models || []).map((m) => ({ id: typeof m === 'string' ? m : m.id, name: typeof m === 'string' ? m : (m.name || m.id), contextWindow: m.contextWindow || 128000, maxTokens: m.maxTokens || 4096, reasoning: m.reasoning || false, input: m.input || ['text'] }));
          providersList.push({ id: providerId, api: provider.api || 'unknown', accessMode: provider.apiKey ? 'api_key' : 'auth', models: modelList });
        }
        sendJson(res, { agentId, providers: providersList });
      } else { sendJson(res, { agentId, providers: [], error: 'models.json not found' }); }
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // PUT /api/agent/:id/model
  if (req.method === 'PUT' && url.match(/^\/api\/agent\/[^/]+\/model$/)) {
    const agentId = url.split('/')[3];
    if (!agentId || agentId.includes('..') || agentId.includes('/') || agentId.includes('\\')) { sendError(res, 'Invalid agent ID', 400); return; }
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const agentList = config.agents?.list || (Array.isArray(config.agents) ? config.agents : []);
      const agentIndex = agentList.findIndex((a) => a.id === agentId);
      if (agentIndex === -1) { sendError(res, 'Agent not found', 404); return; }
      const primary = data.primary || data.model;
      if (primary) {
        agentList[agentIndex].model = primary;
        if (!agentList[agentIndex].params || typeof agentList[agentIndex].params !== 'object') agentList[agentIndex].params = {};
        agentList[agentIndex].params.model = primary;
      }
      if (data.fallbacks !== undefined) {
        if (!Array.isArray(data.fallbacks)) { sendError(res, 'fallbacks must be an array', 400); return; }
        if (!agentList[agentIndex].params || typeof agentList[agentIndex].params !== 'object') agentList[agentIndex].params = {};
        agentList[agentIndex].params.fallback = data.fallbacks;
        // Store fallbacks inside defaults.model object to keep openclaw schema happy
        if (!config.agents) config.agents = { defaults: { model: { primary: primary || '', fallbacks: data.fallbacks } }, list: agentList };
        if (!config.agents.defaults) config.agents.defaults = {};
        const currentDefaultModel = config.agents.defaults.model;
        if (typeof currentDefaultModel === 'string' && currentDefaultModel) {
          config.agents.defaults.model = { primary: currentDefaultModel, fallbacks: data.fallbacks };
        } else if (currentDefaultModel && typeof currentDefaultModel === 'object') {
          config.agents.defaults.model.fallbacks = data.fallbacks;
          if (!config.agents.defaults.model.primary) config.agents.defaults.model.primary = primary || '';
        } else {
          config.agents.defaults.model = { primary: primary || '', fallbacks: data.fallbacks };
        }
      }
      if (!config.agents) config.agents = { defaults: { model: { primary: '', fallbacks: [] } }, list: agentList };
      else if (!config.agents.list) config.agents.list = agentList;
      atomicWriteJSON(CONFIG_FILE, config);
      invalidateCache(['agents', 'activity', 'models', 'config', 'agentMeta', 'cronJobs', 'sessionStats', 'health', 'topology']);
      sendJson(res, { success: true, agent: agentList[agentIndex] });
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/gateway/status
  if (url === '/api/gateway/status' && req.method === 'GET') {
    exec('systemctl --user is-active openclaw-gateway', (error, stdout) => {
      sendJson(res, { status: stdout.trim() === 'active' ? 'running' : 'stopped', active: stdout.trim() === 'active' });
    });
    return;
  }

  // POST /api/gateway/restart
  if (url === '/api/gateway/restart' && req.method === 'POST') {
    exec('systemctl --user restart openclaw-gateway', { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) sendJson(res, { success: false, error: error.message });
      else sendJson(res, { success: true, output: stdout || 'Gateway restarted' });
    });
    return;
  }

  // GET /api/test-model
  if (url === '/api/test-model' && req.method === 'GET') {
    try {
      const config = readConfig();
      const providers = config.models?.providers || {};
      const results = [];
      for (const [providerId, provider] of Object.entries(providers)) {
        const hasKey = !!(provider.apiKey || provider.key);
        results.push({ provider: providerId, ok: hasKey, status: hasKey ? 'configured' : 'no_api_key', models: (provider.models || []).map((m) => m.id || m).slice(0, 3) });
      }
      sendJson(res, { results });
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // POST /api/test-model
  if (url === '/api/test-model' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      let { provider, modelId, agentId, model } = JSON.parse(body);
      if (agentId && model) { const parts = model.split('/'); if (parts.length === 2) { provider = parts[0]; modelId = parts[1]; } }
      if (!provider || !modelId) { sendError(res, 'Missing provider or modelId', 400); return; }
      const config = readConfig();
      const providerConfig = config.models?.providers?.[provider];
      if (!providerConfig) { sendJson(res, { results: [{ ok: false, error: 'Provider not found: ' + provider, provider, modelId }] }); return; }
      if (!providerConfig.apiKey) { sendJson(res, { results: [{ ok: false, error: 'No API key configured', provider, modelId }] }); return; }

      const start = Date.now();
      const testPayload = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 };
      let baseUrl = providerConfig.baseUrl || 'https://api.openai.com';
      let endpoint = '/v1/chat/completions';
      if (baseUrl.includes('openrouter.ai')) endpoint = '/chat/completions';
      else if (baseUrl.includes('qianfan.baidubce.com')) endpoint = '/chat/completions';
      else if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3);
      const fullUrl = baseUrl + endpoint;

      const testRes = await new Promise((resolve, reject) => {
        const urlObj = new URL(fullUrl);
        const reqLib = urlObj.protocol === 'https:' ? https : http;
        const reqOptions = {
          hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + providerConfig.apiKey },
          timeout: 30000,
        };
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        if (proxyUrl) { try { const { HttpsProxyAgent } = require('https-proxy-agent'); const hostname = urlObj.hostname; const isPrivate = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.'); if (!isPrivate) reqOptions.agent = new HttpsProxyAgent(proxyUrl); } catch {} }
        const testReq = reqLib.request(reqOptions, resolve);
        testReq.on('error', (e) => reject(new Error(e.message || 'Request failed')));
        testReq.on('timeout', () => { testReq.destroy(); reject(new Error('Request timeout after 30s')); });
        testReq.write(JSON.stringify(testPayload));
        testReq.end();
      });

      let responseBody = '';
      testRes.on('data', (chunk) => { responseBody += chunk; });
      testRes.on('end', () => {
        const elapsed = Date.now() - start;
        if (testRes.statusCode === 200) {
          let promptTokens = 0, completionTokens = 0;
          try { const json = JSON.parse(responseBody); promptTokens = json.usage?.prompt_tokens || 0; completionTokens = json.usage?.completion_tokens || 0; } catch {}
          sendJson(res, { results: [{ ok: true, elapsed, model: modelId, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens }] });
        } else {
          sendJson(res, { results: [{ ok: false, elapsed, status: testRes.statusCode, error: responseBody.substring(0, 500), model: modelId, provider }] });
        }
      });
    } catch (e) { sendJson(res, { results: [{ ok: false, error: e.message }] }); }
    return;
  }

  // GET /api/test-platforms
  if (url === '/api/test-platforms' && req.method === 'GET') {
    try {
      const config = readConfig();
      const channels = config.channels || {};
      const platforms = [{ id: 'feishu', name: '飞书' }, { id: 'discord', name: 'Discord' }, { id: 'telegram', name: 'Telegram' }, { id: 'whatsapp', name: 'WhatsApp' }];
      const results = platforms.map((p) => { const ch = channels[p.id] || {}; const hasConfig = !!(ch.appId || ch.token || ch.phoneNumberId); return { platform: p.id, name: p.name, ok: hasConfig, status: hasConfig ? 'configured' : 'not_configured' }; });
      sendJson(res, { results });
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/sessions
  if (url === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = {};
      if (fs.existsSync(AGENTS_DIR)) {
        fs.readdirSync(AGENTS_DIR).forEach((agentId) => {
          const agentPath = path.join(AGENTS_DIR, agentId);
          if (!fs.statSync(agentPath).isDirectory()) return;
          const sessDir = path.join(agentPath, 'sessions');
          if (!fs.existsSync(sessDir)) return;
          fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl') && !f.includes('.deleted.')).forEach((f) => { sessions[f.replace('.jsonl', '')] = { agentId, file: f }; });
        });
      }
      sendJson(res, sessions);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/agents/rules
  if (url === '/api/agents/rules' && req.method === 'GET') { sendJson(res, { rules: [] }); return; }

  // GET /api/gateway-health
  if (url === '/api/gateway-health' && req.method === 'GET') {
    const startTime = Date.now();
    const gwReq = http.request({ hostname: '127.0.0.1', port: GATEWAY_PORT, path: '/health', method: 'GET', timeout: 1000 }, (gwRes) => {
      let data = '';
      gwRes.on('data', chunk => data += chunk);
      gwRes.on('end', () => {
        const responseMs = Date.now() - startTime;
        try { const json = JSON.parse(data); const isHealthy = json.ok === true || json.status === 'ok' || json.status === 'live'; sendJson(res, { status: isHealthy ? 'healthy' : 'degraded', ok: isHealthy, responseMs, checkedAt: Date.now(), error: null }); }
        catch { sendJson(res, { status: 'degraded', ok: true, responseMs, checkedAt: Date.now(), error: 'parse error' }); }
      });
    });
    gwReq.on('error', (e) => { sendJson(res, { status: 'down', ok: false, responseMs: null, checkedAt: Date.now(), error: e.code || 'connection refused' }); });
    gwReq.on('timeout', () => { gwReq.destroy(); sendJson(res, { status: 'down', ok: false, responseMs: null, checkedAt: Date.now(), error: 'timeout' }); });
    gwReq.end();
    return;
  }

  // POST /api/ai-fix — 调用系统默认大模型进行智能修复
  if (url === '/api/ai-fix' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { agentId, issueType, issueMessage, issueDetail, context } = JSON.parse(body);
      const config = readConfig();

      // 尝试多种路径获取默认模型
      let defaultModel = '';
      const rawDefaultModel = config.agents?.defaults?.model;
      if (typeof rawDefaultModel === 'string') {
        defaultModel = rawDefaultModel;
      } else if (rawDefaultModel && typeof rawDefaultModel === 'object' && rawDefaultModel.primary) {
        defaultModel = rawDefaultModel.primary;
      } else if (config.agents?.defaults?.params?.model) {
        defaultModel = config.agents.defaults.params.model;
      } else if (config.agents?.list?.[0]?.model) {
        defaultModel = config.agents.list[0].model;
      } else if (config.agents?.list?.[0]?.params?.model) {
        defaultModel = config.agents.list[0].params.model;
      }

      if (!defaultModel) { sendJson(res, { success: false, error: '未配置默认模型' }); return; }

      const parts = defaultModel.split('/');
      const provider = parts[0];
      const modelId = parts[1] || parts[0];
      const providerConfig = config.models?.providers?.[provider];
      if (!providerConfig || !providerConfig.apiKey) { sendJson(res, { success: false, error: '默认模型提供商未配置 API Key' }); return; }

      const systemPrompt = '你是一个专业的系统运维助手。请根据提供的 Agent 告警信息，进行深入分析并给出建议。分析要包含问题根因、影响范围和操作建议，使用中文回答。';
      const userPrompt = `Agent: ${agentId}\n告警类型: ${issueType}\n告警信息: ${issueMessage}\n详细错误: ${issueDetail || '无'}\n上下文: ${context || '无'}\n\n请对以上告警进行深入分析，包含：1.问题根因分析 2.影响范围评估 3.具体的操作建议（3-5条）。`;

      const testPayload = {
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 800,
        temperature: 0.3
      };

      let baseUrl = providerConfig.baseUrl || 'https://api.openai.com';
      let endpoint = '/v1/chat/completions';
      if (baseUrl.includes('openrouter.ai')) endpoint = '/chat/completions';
      else if (baseUrl.includes('qianfan.baidubce.com')) endpoint = '/chat/completions';
      else if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3);
      const fullUrl = baseUrl + endpoint;

      const aiRes = await new Promise((resolve, reject) => {
        const urlObj = new URL(fullUrl);
        const reqLib = urlObj.protocol === 'https:' ? https : http;
        const reqOptions = {
          hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + providerConfig.apiKey },
          timeout: 60000,
        };
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        if (proxyUrl) { try { const { HttpsProxyAgent } = require('https-proxy-agent'); const hostname = urlObj.hostname; const isPrivate = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.'); if (!isPrivate) reqOptions.agent = new HttpsProxyAgent(proxyUrl); } catch {} }
        const testReq = reqLib.request(reqOptions, resolve);
        testReq.on('error', (e) => reject(new Error(e.message || 'Request failed')));
        testReq.on('timeout', () => { testReq.destroy(); reject(new Error('Request timeout after 60s')); });
        testReq.write(JSON.stringify(testPayload));
        testReq.end();
      });

      let responseBody = '';
      aiRes.on('data', (chunk) => { responseBody += chunk; });
      aiRes.on('end', () => {
        if (aiRes.statusCode === 200) {
          try {
            const json = JSON.parse(responseBody);
            const fixContent = json.choices?.[0]?.message?.content || '';
            sendJson(res, { success: true, fix: fixContent, model: defaultModel });
          } catch { sendJson(res, { success: false, error: '解析 AI 响应失败', raw: responseBody.substring(0, 500) }); }
        } else {
          sendJson(res, { success: false, error: 'AI 请求失败: ' + aiRes.statusCode, raw: responseBody.substring(0, 500) });
        }
      });
    } catch (e) { sendJson(res, { success: false, error: e.message }); }
    return;
  }

  // ===== 静态文件 =====
  const FRONTEND_DIR = path.join(__dirname, '../../../shell-ui/modules/robots');
  const localPath = path.resolve(FRONTEND_DIR, url.replace(/^\//, ''));
  if (localPath.startsWith(FRONTEND_DIR) && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    serveStaticFile(localPath, res);
    return;
  }

  if (url.startsWith('/public/') || url.match(/\.(js|css|png|jpg|svg|ico|mp3|woff|woff2)$/)) {
    proxyToDashboard(req, res, url);
    return;
  }

  sendError(res, 'Not found', 404);
  } catch (err) {
    console.error('[robots] Uncaught error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    }
  }
}

function healthFn() {
  return true;
}

function computeAgentHealth(agentId, state, sessionInfo, authState, cronJobsWithState) {
  const issues = [];
  let score = 100;

  if (authState?.usageStats) {
    for (const [, stats] of Object.entries(authState.usageStats)) {
      if (stats.errorCount > 0) {
        const hoursSinceFailure = stats.lastFailureAt ? (Date.now() - stats.lastFailureAt) / 3600000 : 999;
        if (hoursSinceFailure < 1) { issues.push({ type: 'auth_error', level: 'critical', message: '模型调用最近1小时内失败' }); score -= 30; }
        else if (hoursSinceFailure < 24) { issues.push({ type: 'auth_error', level: 'warning', message: '模型调用24小时内失败过' }); score -= 15; }
      }
    }
  }

  if (sessionInfo.todayAvgResponseMs > 30000) {
    issues.push({ type: 'slow_response', level: 'warning', message: '响应时间异常 (' + Math.round(sessionInfo.todayAvgResponseMs / 1000) + 's)' });
    score -= 10;
  }

  const hasCronButOffline = cronJobsWithState.some(j => j.enabled) && state === 'offline';
  if (hasCronButOffline) {
    issues.push({ type: 'cron_offline', level: 'warning', message: '有定时任务但Agent不活跃' });
    score -= 10;
  }

  for (const job of cronJobsWithState) {
    if (job.consecutiveFailures >= 3) {
      issues.push({ type: 'cron_critical', level: 'critical', message: `Cron "${job.label}" 连续失败${job.consecutiveFailures}次`, detail: job.lastError || '' });
      score -= 20;
    } else if (job.consecutiveFailures >= 1) {
      issues.push({ type: 'cron_warning', level: 'warning', message: `Cron "${job.label}" 失败${job.consecutiveFailures}次`, detail: job.lastError || '' });
      score -= 5;
    }
  }

  score = Math.max(0, score);
  let level = 'healthy';
  if (score < 50) level = 'critical';
  else if (score < 80) level = 'warning';

  return { score, level, issues };
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Robots module: http://127.0.0.1:${PORT}`);
    console.log(`  Agents:  http://127.0.0.1:${PORT}/`);
  });
}

module.exports = {
  handler,
  healthFn,
  capabilities: [],
};
