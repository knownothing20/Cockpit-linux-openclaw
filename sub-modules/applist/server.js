const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');

const PORT = parseInt(process.env.PORT) || 17149;
const HOST = '0.0.0.0';
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const SOFTWARE_DIR = path.join(OPENCLAW_DIR, 'software');
const SYSTEMD_USER_DIR = path.join(os.homedir(), '.config/systemd/user');
// v2.4.0：`systemd-run` 创建的「瞬时单元」不落在上面那个目录，而在 /run/user/<uid>/systemd/transient/。
// applist 原先只扫单元文件目录，于是 book-money-v6-live 这类「明明在跑」的服务在列表里完全看不见。
const SYSTEMD_TRANSIENT_DIR = path.join(
  '/run/user',
  String(typeof process.getuid === 'function' ? process.getuid() : 1000),
  'systemd/transient'
);
const REGISTRY_DIR = path.join(__dirname, 'registry');
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'shell-ui', 'modules', 'applist');
// 清单缓存 TTL。applist 是 in-process native 模块，和 Shell 共用同一个事件循环，
// 每次"冷"扫描都是同步的（实测约 220ms，卡顿时会长得多），期间 Shell 的所有请求
// 都会排队——包括模块 iframe 自己的页面，表现就是"点开软件管理是白屏"。
// 5s 的 TTL 意味着只要有人开着页面就几乎每 5s 阻塞一次；放宽到 15s，并且配合
// getCachedSoftwareInventory() 的 stale-while-revalidate，请求路径上不再做全量扫描。
const SOFTWARE_INVENTORY_CACHE_MS = 15000;
let _softwareInventoryCache = null;
let _softwareInventoryCacheTime = 0;
let _inventoryRefreshPending = false;

const KNOWN_CORE_SERVICES = {
  'openclaw-gateway': { isCore: true, port: 18789, description: 'OpenClaw 网关' },
  'openclaw-dashboard': { isCore: true },
  'openclaw-recovery-monitor': { isCore: false, description: '配置恢复监控' },
  'task-scheduler': { isCore: false, description: '定时任务调度器' },
  'task-review': { isCore: false, description: '任务审核系统' },
  'task-service': { isCore: false, description: '任务服务' },
  'openclaw-profile-api': { isCore: false, description: '用户画像 API' },
  'profile-api': { isCore: false, description: 'Profile API' },
  'toonflow-dev': { isCore: false, description: 'ToonFlow 开发服务' },
  'all-in-one-video-watchdog': { isCore: false, description: '视频服务看门狗' },
};

const MERGED_INTO_SHELL = new Set([
  'robots', 'skill-manager',
  'config-recovery',
  'workspace-rule-panel', 'applist', 'openclaw-models-manager',
  'file-manager', 'openclaw-dashboard',
]);

// ⚠️ 声明顺序 = 匹配优先级：`categorizeSoftware()` 逐分类、逐关键词，取**首个命中**即返回。
// 规则：**越「具体」的分类越靠前**。厂商/产品名（lark / 飞书 / slack…）比通用技术词更具体，
// 故 'communication' 排最前 —— 否则 `@larksuite/openclaw-lark`（也含 `openclaw`）会被 'ai-coding' 抢走、
// `@larksuiteoapi/node-sdk`（也含 `node`）会被 'dev-tool' 抢走。同理 'ai-coding' 必须早于 'ai-tool'，
// 否则 `@openai/codex`（也含 `openai`）会被判成 AI 工具。
const SOFTWARE_CATEGORIES = {
  'communication': { label: '通信/协作', icon: '💬', keywords: ['slack', 'lark', 'feishu', 'openclaw-lark', 'websockets'] },
  'ai-coding': { label: 'AI 编程', icon: '🤖', keywords: ['claude', 'codex', 'gemini', 'aider', 'openclaw', 'opencli', 'codebuddy'] },
  // 'hf' 已移除：两个字符的关键词走 `name.includes()` 会匹配到任何含 "hf" 的包名（如 hf-xet），
  // 而 HuggingFace 系包名本身已含 'huggingface'，不需要这个缩写兜底。
  'ai-tool': { label: 'AI 工具', icon: '✨', keywords: ['litellm', 'openai', 'huggingface', 'dreamina'] },
  'dev-tool': { label: '开发工具', icon: '🛠️', keywords: ['node', 'npm', 'npx', 'pnpm', 'pm2', 'git', 'ruff', 'flake8', 'pytest', 'uvicorn', 'flask', 'fastapi', 'invoke', 'pipx', 'wheel'] },
  'browser-automation': { label: '浏览器自动化', icon: '🌐', keywords: ['playwright', 'puppeteer', 'chromium', 'chrome-remote', 'agent-browser'] },
  'devops': { label: '运维/部署', icon: '⚙️', keywords: ['docker', 'docker-compose', 'uvicorn', 'watchfiles', 'websockets'] },
  // 'curl' 已从本类移出：它是系统自带的通用网络工具，改由 'system' 唯一持有。
  // 两处都声明时先声明的本类会独占它，导致「系统工具」分类恒为空、永远不出现。
  'data-scrape': { label: '数据/爬虫', icon: '📊', keywords: ['cheerio', 'akshare', 'baostock', 'yt-dlp', 'beautifulsoup4', 'httpx', 'pytesseract'] },
  'doc-content': { label: '文档/内容', icon: '📝', keywords: ['wenyan', 'markdown', 'pypandoc', 'pygmentize', 'tabulate', 'obsidian', 'uipro'] },
  // 'curl' 的唯一归属（配合上面 data-scrape 的移除）。
  // 注意：**不要**往这里加 'ss' 这类两字符词 —— `name.includes('ss')` 会命中 pytesseract。
  'system': { label: '系统工具', icon: '🖥️', keywords: ['jq', 'tmux', 'findutils', 'coreutils', 'curl', 'cron'] },
  'library': { label: '库/依赖', icon: '📦', keywords: ['better-sqlite3', 'numpy', 'jinja2', 'cryptography', 'certifi', 'greenlet'] }
};

// pip 包里「装了 console_scripts 但本质是支撑库」的收纳名单（键名已去掉 -/_）。
// 这些包会随依赖被 pip 装出可执行入口，但没人把它当独立软件用；
// 不做这层收纳，「系统软件」页就会被 pip 依赖清单撑爆。
const SUPPORT_LIBRARY_NAMES = new Set([
  'tqdm', 'tabulate', 'wheel', 'httpx', 'jsonschema', 'distro', 'shtab',
  'userpath', 'watchfiles', 'websockets', 'grepast', 'html2text',
  'curlcffi', 'typer', 'pycodestyle', 'pyflakes',
]);

function normalizePkgName(name) {
  return String(name || '').toLowerCase().replace(/[-_]/g, '');
}

/**
 * 分类口径：只有「能被当独立工具使用」的包才进工具分类。
 * - pip / npm 包没有可执行入口 → 一律算库（它们是别的软件的零件）
 * - pip 包虽有 CLI 但命中支撑库名单 → 也算库
 * 库会归入 library 分类，该分类不进「系统软件」展示（见 scanSystemSoftware）。
 */
function classifySoftwareCategory(name, hasCli, source) {
  if (source === 'pip-user' || source === 'npm-global') {
    if (!hasCli) return 'library';
    if (source === 'pip-user' && SUPPORT_LIBRARY_NAMES.has(normalizePkgName(name))) return 'library';
  }
  return categorizeSoftware(name, hasCli);
}

function loadScanPaths() {
  const applistConfig = readJsonSafe(path.join(__dirname, 'config.json'));
  const paths = applistConfig?.scanPaths || [];
  return paths.map(p => p.replace(/^~/, os.homedir())).filter(p => fileExists(p));
}

// ============ 工具函数 ============

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function getCachedSoftwareInventory() {
  const now = Date.now();
  if (_softwareInventoryCache) {
    if (now - _softwareInventoryCacheTime < SOFTWARE_INVENTORY_CACHE_MS) {
      return _softwareInventoryCache;
    }
    // 已过期：先立刻返回旧数据，把同步扫描推到当前这一轮 I/O 之后再跑。
    // 这样请求路径永远不会等在扫描上；同一时刻只排一次刷新，避免堆积。
    if (!_inventoryRefreshPending) {
      _inventoryRefreshPending = true;
      setImmediate(() => {
        _inventoryRefreshPending = false;
        try {
          _softwareInventoryCache = buildSoftwareInventory();
          _softwareInventoryCacheTime = Date.now();
        } catch (e) { /* 刷新失败就继续用旧缓存，不要让页面挂掉 */ }
      });
    }
    return _softwareInventoryCache;
  }
  _softwareInventoryCache = buildSoftwareInventory();
  _softwareInventoryCacheTime = now;
  return _softwareInventoryCache;
}

function loadRegistryEntries() {
  const entries = [];
  if (!fileExists(REGISTRY_DIR)) return entries;

  try {
    fs.readdirSync(REGISTRY_DIR)
      .filter(file => file.endsWith('.json'))
      .sort()
      .forEach(file => {
        const configPath = path.join(REGISTRY_DIR, file);
        const config = readJsonSafe(configPath);
        if (!config || typeof config !== 'object') return;

        const id = String(config.id || config.name || path.basename(file, '.json')).trim();
        if (!id) return;
        const runtimePath = config.runtimePath || config.path || '';

        entries.push({
          name: id,
          dir: runtimePath || REGISTRY_DIR,
          source: 'registry',
          config,
          configDir: REGISTRY_DIR,
          configPath
        });
      });
  } catch {}

  return entries;
}

// ============ 孤儿元数据检测 ============
// applist 的 registry 是「只增不减」的：软件卸载后 registry/<id>.json 没人清理，
// 卡片就永久留在列表里；又因为元数据里声明了 service / port，UI 会降级显示成
// 「已停止（来源 systemd）」，让人误以为软件还在、只是没启动。
// 判定：软件已卸载 ⟺ 以下三项强证据全部不成立
//   ① systemd 单元存在  ② start 命令的可执行文件存在  ③ 声明端口正在监听
// 弱证据（runtimePath 存在）不可作数：它经常是共享目录（如 ~/.local/bin），存在 ≠ 软件存在。
const SHARED_RUNTIME_DIRS = new Set([
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), 'bin'),
  '/usr/bin', '/usr/local/bin', '/bin', '/opt'
]);

// ============ 删除安全护栏（v2.4.0） ============
// 背景：`DELETE /api/software/:id` 原先直接 `fs.rmSync(item.path, { recursive: true, force: true })`。
// 而 item.path 来自「候选条目」的路径，候选又来自 SOFTWARE_DIR + config.scanPaths ——
// 本机 scanPaths 里就有 `~/.openclaw/shared-skills`，于是界面上任何一张共享技能卡的 🗑️
// 都会真的把那个共享技能目录连同内容一起递归删掉（`~/.local/bin` 同理）。
// 这里改成三件事：① 目标必须落在受管扫描根的直接子层；② 不递归硬删，改为移入回收站；
// ③ 必须显式带 confirm=1。三者任一不满足就拒绝，宁可拒绝也不误删。
const TRASH_DIR = path.join(OPENCLAW_DIR, '.applist-trash');

/** applist 认可的「可删除根」：SOFTWARE_DIR 与配置里的 scanPaths（都解析成绝对路径） */
function deletableRoots() {
  const roots = [SOFTWARE_DIR, ...loadScanPaths()];
  return Array.from(new Set(roots.map((r) => path.resolve(r))));
}

/**
 * 判定某个路径是否允许被删除。
 * 返回 { ok:true, real } 或 { ok:false, reason }。
 * 注意：调用方不得在 ok=false 时做任何写操作。
 */
function assertDeletableTarget(rawPath) {
  if (!rawPath) return { ok: false, reason: '目标路径为空' };
  let st;
  try { st = fs.lstatSync(rawPath); } catch (e) { return { ok: false, reason: '无法读取路径属性: ' + e.message }; }
  if (st.isSymbolicLink()) return { ok: false, reason: '目标是符号链接，拒绝删除' };
  if (!st.isDirectory()) return { ok: false, reason: '目标不是目录，拒绝删除' };
  let real;
  try { real = fs.realpathSync(rawPath); } catch (e) { return { ok: false, reason: '路径不可解析: ' + e.message }; }

  const home = path.resolve(os.homedir());
  if (real === path.parse(real).root) return { ok: false, reason: '拒绝删除文件系统根目录' };
  if (real === home) return { ok: false, reason: '拒绝删除家目录' };
  if (real === path.resolve(OPENCLAW_DIR)) return { ok: false, reason: '拒绝删除 OpenClaw 根目录' };
  if (SHARED_RUNTIME_DIRS.has(real)) return { ok: false, reason: '共享运行时目录，拒绝删除' };
  // v2.5.0：扫描根（非 SOFTWARE_DIR）下的直接子目录，必须与「候选准入判据」同源 ——
  // 技能包 / 内部共享目录 / 无运行时迹象的容器目录都不是软件，这个接口不该动它们。
  // UI 上它们已不再出现（没有 🗑️ 入口），这层兜的是「手工构造 DELETE 请求」：
  // scanPaths 同样在 deletableRoots 里，只靠 UI 收敛挡不住直接打接口。
  if (path.dirname(real) !== path.resolve(SOFTWARE_DIR) && !looksLikeManageableSoftware(real)) {
    return { ok: false, reason: '扫描根下的非软件目录（技能包 / 内部共享目录 / 无运行时迹象），拒绝删除' };
  }
  // 目标里含有 Cockpit 自己（applist 模块就在 <shell>/sub-modules/applist）→ 绝不能删，
  // 否则会把自己连同整个 Shell 一起搬走。属于「便宜且通用」的一层兜底。
  const selfDir = path.resolve(__dirname);
  if (selfDir === real || selfDir.startsWith(real + path.sep)) {
    return { ok: false, reason: '目标包含 Cockpit Shell 自身，拒绝删除' };
  }
  // 家目录下至少两级（拦住 ~/.local、~/Documents 这类顶层目录）
  const rel = path.relative(home, real);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).filter(Boolean).length < 2) {
    return { ok: false, reason: '层级过浅（家目录下的顶层目录），拒绝删除' };
  }

  const roots = deletableRoots();
  if (roots.includes(real)) return { ok: false, reason: '目标是扫描根本身，拒绝删除' };
  if (!roots.includes(path.dirname(real))) {
    return { ok: false, reason: '目标不在可删除范围内（只允许删除受管扫描根的直接子目录）' };
  }
  return { ok: true, real };
}

/** 不硬删：改名为回收站里的一个时间戳条目，可人工恢复 */
function softDeleteToTrash(realPath) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(TRASH_DIR, stamp + '__' + path.basename(realPath));
  fs.renameSync(realPath, dest);   // 同设备内改名：原子、可逆、不产生半删状态
  return dest;
}

function systemdUnitExists(unitName, systemdStates) {
  if (!unitName) return false;
  const want = unitName.endsWith('.service') ? unitName : unitName + '.service';
  if (systemdStates && (
    (systemdStates.active && systemdStates.active[want] !== undefined) ||
    (systemdStates.enabled && systemdStates.enabled[want] !== undefined) ||
    (systemdStates.activeState && systemdStates.activeState[want] !== undefined)
  )) return true;
  return fileExists(path.join(SYSTEMD_USER_DIR, want))
    || fileExists(path.join('/etc/systemd/system', want))
    || fileExists(path.join('/lib/systemd/system', want));
}

// 归一化：统一补 .service 后缀，便于按「服务」查表
function normalizeUnitSuffix(unitName) {
  if (!unitName) return '';
  const u = String(unitName).trim();
  if (!u) return '';
  return /\.(service|target|socket|timer|path|mount)$/.test(u) ? u : u + '.service';
}

// v2.6.0：判断一个单元「是否具备开机自启能力」。
// 只看该单元自身是否 enabled 是不够的 —— 本机大量项目用「.target 拉起一组服务」的写法：
//   例如 image-studio.target（WantedBy=default.target，enabled）Wants= 四个 image-studio-*.service，
//   那四个 service 自身虽然是 disabled，但开机时会被 target 拉起来。
// 旧判据（仅看 service.enabled）会把这类「明明设了自启、只是当前没在跑」的项目误判成「已停用」，
// 于是 Eat Good / Hot Pic / Image Studio 都被错标了 dormant，反而与「已停用」的语义相反。
// 现按反向依赖（WantedBy）递归回溯：自身 enabled，或被某个「可达自启」的单元 Wants —— 都算具备自启能力。
// learn-solo.target 这种 enabled 但 Wants 为空的空壳 target 不会误伤：它到不了任何 service，回溯自然为 false。
// v2.9.0：单元「坏掉了」——启动失败，或卡在启动中出不来。
// 面板与 dormant 判定都要把「启动失败」与「用户主动停掉」分开：
// 前者是异常（要报警、不该被灰化并排到列表末尾），后者才是「已停用」。
// 背景：v2.8.0 修好 list-units 的 `●` 错位后，failed 才第一次能被正确读到；
// 但 dormant 仍只看 systemdStates.active（active===true 才算「在跑」），
// 于是「整组启动失败 + 没设自启」会被错标成「已停用」——与语义正好相反。
function unitIsBroken(unitName, systemdStates) {
  if (!unitName || !systemdStates || !systemdStates.activeState) return false;
  const u = normalizeUnitSuffix(unitName);
  if (!u) return false;
  const st = systemdStates.activeState[u];
  return st === 'failed' || st === 'activating';
}

function unitHasAutostart(unitName, systemdStates) {
  if (!unitName || !systemdStates) return false;
  const memo = new Map();   // unit -> true/false（本次判定内缓存，避免重复递归）
  const visiting = new Set(); // 环保护
  const enabledTargets = systemdStates.enabledTargets || new Set();
  const isSelfEnabled = (u) => (systemdStates.enabled && systemdStates.enabled[u] === true)
    || enabledTargets.has(u);
  const walk = (raw) => {
    const u = normalizeUnitSuffix(raw);
    if (!u) return false;
    if (memo.has(u)) return memo.get(u);
    if (visiting.has(u)) return false;      // 依赖成环：这一支当作不可达，交给其它支
    if (isSelfEnabled(u)) { memo.set(u, true); return true; }
    visiting.add(u);
    const parents = (systemdStates.wantedBy && systemdStates.wantedBy[u]) || [];
    const hit = parents.some((p) => walk(p));
    visiting.delete(u);
    memo.set(u, hit);
    return hit;
  };
  return walk(unitName);
}

// 从 start 命令解析首个可执行文件并判断是否存在。
// 返回 true / false / null（null = 无法判定，例如纯 PATH 命令 "npm start" 且没给 runtimePath）
function startExecutableExists(startCmd, runtimePath) {
  if (!startCmd) return null;
  let s = String(startCmd).trim();
  const cdMatch = s.match(/^cd\s+\S+\s*&&\s*([\s\S]+)$/);
  if (cdMatch) s = cdMatch[1].trim();
  const m = s.match(/^(\S+)/);
  if (!m) return null;
  const exe = m[1];
  // 解释器 / 包装器：真正目标在参数里，无法靠首个 token 定位
  if (['cd', 'sudo', 'env', 'bash', 'sh', 'nohup', 'exec'].includes(exe)) return null;
  if (exe.startsWith('/')) return fileExists(exe);
  if (exe.includes('/')) return fileExists(path.join(runtimePath || '', exe));
  // 无路径分隔符 = 依赖 PATH 查找；配合 runtimePath 再试一次，仍不中则视为无法判定
  return runtimePath ? fileExists(path.join(runtimePath, exe)) : null;
}

function detectOrphanRegistryEntry(config, systemdStates, listeningPorts) {
  const unitOk = systemdUnitExists(config && config.service, systemdStates);
  const runtimePath = (config && (config.runtimePath || config.path)) || '';
  const exeOk = startExecutableExists(config && config.start, runtimePath) === true;
  const portOk = !!(config && config.port && listeningPorts && listeningPorts.has(Number(config.port)));
  // 弱证据但足以免判：runtimePath 是「专属目录」（非共享 bin 目录）且确实存在 ——
  // 说明软件文件还在磁盘上，只是服务没起/单元没装，不该当孤儿。反之 ~/.local/bin 这类
  // 共享目录存在与否完全不能说明问题（它属于很多软件）。
  const runtimeIsDedicated = !!runtimePath
    && !SHARED_RUNTIME_DIRS.has(runtimePath)
    && fileExists(runtimePath);
  const orphan = !unitOk && !exeOk && !portOk && !runtimeIsDedicated;
  return {
    orphan,
    evidence: { unit: unitOk, exe: exeOk, port: portOk, dedicatedDir: runtimeIsDedicated }
  };
}

function getConfigPathForItem(item) {
  if (!item) return null;
  if (item.configPath) return item.configPath;
  const base = item.configDir || item.path;
  return base ? path.join(base, 'config.json') : null;
}

function getServiceWorkDirForItem(item, config) {
  return config?.runtimePath || config?.path || item?.path || item?.configDir || null;
}

function parseSystemdEnvironment(content) {
  const env = {};
  const lines = content.match(/^Environment=(.*)$/gm) || [];
  for (const line of lines) {
    const raw = line.replace(/^Environment=/, '').trim();
    const cleaned = raw.replace(/^['"]|['"]$/g, '');
    const pairs = cleaned.split(/\s+/).filter(Boolean);
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        env[key] = value;
      }
    }
  }
  return env;
}

function normalizePort(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function parsePortFromExecStart(execStart) {
  if (!execStart) return null;
  const match = execStart.match(/(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/i);
  if (!match) return null;
  return normalizePort(match[1]);
}

function parsePortFromDotEnv(dir) {
  if (!dir) return null;
  const envPath = path.join(dir, '.env');
  if (!fileExists(envPath)) return null;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const direct = content.match(/^\s*PORT\s*=\s*(\d{2,5})\s*$/m);
    if (direct) return normalizePort(direct[1]);
    const daemonPort = content.match(/^\s*OPENCLI_DAEMON_PORT\s*=\s*(\d{2,5})\s*$/m);
    if (daemonPort) return normalizePort(daemonPort[1]);
  } catch {}
  return null;
}

// 注意：execSync 的 timeout 就是"整个 Shell 最长卡死多久"的上限——applist 是
// in-process native 模块，跟 Shell 共用同一个事件循环，同步子进程会把 Shell 的
// 所有请求（含模块 iframe 自己的页面）一起卡住。这里被调用的都是 which / ss /
// crontab / df / systemctl list-* 这类正常 5~210ms 的命令，默认压到 3s；
// 只有确实可能慢的动作（daemon-reload）才显式传长超时。
function execQuiet(cmd, timeoutMs = 3000) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { return ''; }
}

const _whichPaths = {};
function cachedWhich(cmd) {
  if (_whichPaths[cmd] !== undefined) return _whichPaths[cmd];
  const result = execQuiet(`which ${cmd} 2>/dev/null`) || '';
  _whichPaths[cmd] = result;
  return result;
}

function isDevWatchCommand(command) {
  return !!(command && /\b(tsx\s+watch|vite\s+dev|nodemon|npm\s+run\s+dev)\b/i.test(command));
}

function getRebootCronEntries() {
  const output = execQuiet('crontab -l 2>/dev/null');
  if (!output) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.startsWith('@reboot'));
}

function getAutostartNeedles(item) {
  const values = [
    item.id,
    item.service,
    item.serviceName,
    item.path,
    item.configDir,
    item.startCommand
  ];
  return values
    .filter(value => typeof value === 'string' && value.trim().length >= 4)
    .map(value => value.trim().toLowerCase());
}

function findDuplicateAutostartSources(item, rebootCronEntries) {
  if (!item?.hasServiceFile || !item.autoStart || !Array.isArray(rebootCronEntries)) return [];
  const needles = getAutostartNeedles(item);
  if (needles.length === 0) return [];

  return rebootCronEntries
    .filter(line => {
      const normalized = line.toLowerCase();
      return needles.some(needle => normalized.includes(needle));
    })
    .map(line => ({ type: 'crontab@reboot', line }));
}

// GPU 探测只做一次：这台机器没有 nvidia-smi，原来每次 /api/system-resources
// 都 fork 一个不存在的命令（实测 2.09ms + 一次 fork），纯浪费。
let _nvidiaSmiAvailable = null;
function hasNvidiaSmi() {
  if (_nvidiaSmiAvailable !== null) return _nvidiaSmiAvailable;
  try {
    execFileSync('nvidia-smi', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    _nvidiaSmiAvailable = true;
  } catch { _nvidiaSmiAvailable = false; }
  return _nvidiaSmiAvailable;
}

function getSystemResources() {
  const cpuCount = os.cpus().length;
  const loadAvg = os.loadavg();
  const cpuPercent = Math.min(Math.round((loadAvg[0] / cpuCount) * 100), 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  // 磁盘用量改用 fs.statfsSync 直读 —— 不再 fork `df -h /`。
  // 取整方式与 df 一致（向上取整），实测与 `df -P /` 的百分比完全相同。
  let diskPercent = null;
  try {
    const st = fs.statfsSync('/');
    const used = st.blocks - st.bfree;
    const avail = st.bavail;
    if (used + avail > 0) diskPercent = Math.min(Math.ceil((used / (used + avail)) * 100), 100);
  } catch {}

  let gpu = null;
  if (hasNvidiaSmi()) {
    try {
      const out = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const parts = out.split(',').map(s => s.trim());
      if (parts.length >= 3) {
        gpu = { utilization: parseInt(parts[0]) || 0, memUsed: parts[1] + ' MiB', memTotal: parts[2] + ' MiB' };
      }
    } catch {}
  }

  return {
    cpu: { percent: cpuPercent, load: loadAvg[0].toFixed(2), cores: cpuCount },
    memory: { percent: memPercent, used: usedMem, total: totalMem, free: freeMem },
    disk: { percent: diskPercent },
    gpu
  };
}

function execSystemctl(action, service, timeoutMs) {
  const effectiveTimeout = timeoutMs || parseInt(process.env.APPLIST_SYSTEMCTL_TIMEOUT_MS || '120000', 10);
  try {
    const result = execSync(`systemctl --user ${action} ${service}`, {
      encoding: 'utf8', timeout: effectiveTimeout, stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, output: result.trim() };
  } catch (e) {
    const stderr = (e.stderr || '').trim();
    const msg = stderr || e.message || '未知错误';
    if (msg.includes('Failed to connect to bus') || msg.includes('No such file or directory') || msg.includes('Cannot find')) {
      return { ok: false, error: 'systemd 用户服务总线不可用，请确认已登录桌面会话' };
    }
    if (msg.includes('Access denied') || msg.includes('Permission')) {
      return { ok: false, error: '权限不足: ' + msg };
    }
    if (msg.includes('not loaded') || msg.includes('not found') || msg.includes('not exist')) {
      return { ok: false, error: '服务文件不存在: ' + service };
    }
    return { ok: false, error: msg };
  }
}

function getLLMConfig() {
  try {
    const configFile = path.join(os.homedir(), '.openclaw/openclaw.json');
    if (!fs.existsSync(configFile)) return null;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const providers = config.models?.providers || {};
    const models = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      if (provider.apiKey && provider.models && provider.models.length > 0) {
        for (const m of provider.models) {
          models.push({
            id: typeof m === 'string' ? m : m.id,
            name: typeof m === 'string' ? m : (m.name || m.id),
            providerId,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            api: provider.api || 'openai-completions'
          });
        }
      }
    }
    if (models.length === 0) return null;
    return { default: models[0], models };
  } catch { return null; }
}

function callLLM(prompt, systemPrompt, modelId) {
  return new Promise((resolve, reject) => {
    const llmConfig = getLLMConfig();
    if (!llmConfig) return reject(new Error('未找到 AI 模型配置，请在 ~/.openclaw/openclaw.json 中配置 models.providers'));

    const target = modelId
      ? llmConfig.models.find(m => m.id === modelId) || llmConfig.default
      : llmConfig.default;

    let baseUrl = target.baseUrl;
    if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3);
    const fullUrl = baseUrl + '/v1/chat/completions';

    const payload = {
      model: target.id,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000,
      temperature: 0.3
    };

    const urlObj = new URL(fullUrl);
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + target.apiKey
      },
      timeout: 60000
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content) resolve(content);
          else reject(new Error('AI 返回内容为空: ' + data.substring(0, 200)));
        } catch (e) {
          reject(new Error('AI 响应解析失败: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', e => reject(new Error('AI 请求失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('AI 请求超时 (60s)')); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// ============ 缓存层 ============

let _systemdStateCache = null;
let _systemdStateCacheTime = 0;
let _portsCache = null;
let _portsCacheTime = 0;
let _portProcessMapCache = null;
let _portProcessMapCacheTime = 0;
let _inventoryCache = null;
let _inventoryCacheTime = 0;
const INVENTORY_CACHE_TTL = parseInt(process.env.APPLIST_INVENTORY_CACHE_TTL_MS || '15000', 10);

let _entryInfoCache = new Map();
let _entryInfoCacheTime = new Map();
const ENTRY_CACHE_TTL = 10000;

function getAllSystemdStates() {
  const now = Date.now();
  if (_systemdStateCache && (now - _systemdStateCacheTime) < 10000) return _systemdStateCache;

  const states = { active: {}, enabled: {}, activeState: {}, subState: {}, enabledState: {}, wantedBy: {}, enabledTargets: new Set(), nRestarts: {} };

  try {
    const listUnits = execQuiet('systemctl --user list-units --type=service --all --no-legend --state=loaded 2>/dev/null');
    listUnits.split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 4) return;
      // v2.8.0：list-units 会在「需要关注」的单元行首打一个 `●`（U+25CF）标记，
      // 整行字段因此右移一列。原实现认死 parts[0] 当单元名 —— 这些单元**完全没有被记录**，
      // 还往 map 里塞了一个垃圾键 `●`。实测后果：所有 failed 单元一律退化成 inactive/unknown，
      // 面板上「启动失败」与「手动停掉」变得无法区分；dormant 判定也会把「整组启动失败」
      // 错标成「已停用」。改为按后缀定位单元名列（单元名是唯一以 .service/.target 等结尾的字段）。
      const unitIdx = parts.findIndex(p => /\.(service|socket|target|timer|mount|path)$/.test(p));
      if (unitIdx < 0) return;
      const unit = parts[unitIdx];
      states.active[unit] = parts[unitIdx + 2] === 'active';
      states.activeState[unit] = parts[unitIdx + 2] || 'unknown';
      states.subState[unit] = parts[unitIdx + 3] || 'unknown';
    });
  } catch {}

  try {
    const listFiles = execQuiet('systemctl --user list-unit-files --type=service --no-legend 2>/dev/null');
    listFiles.split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        states.enabled[parts[0]] = parts[1] === 'enabled';
        states.enabledState[parts[0]] = parts[1] || 'unknown';
      }
    });
  } catch {}

  // v2.6.0：采集 enabled 的 target —— 用于识别「服务自身 disabled，但会被开机启用的 target 拉起」的项目。
  try {
    const listTargets = execQuiet('systemctl --user list-unit-files --type=target --no-legend 2>/dev/null');
    listTargets.split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[0].endsWith('.target')) {
        if (parts[1] === 'enabled') states.enabledTargets.add(parts[0]);
        states.enabled[parts[0]] = parts[1] === 'enabled';
        states.enabledState[parts[0]] = parts[1] || 'unknown';
      }
    });
  } catch {}

  // v2.6.0：批量取反向依赖（谁 Wants 了我）。一次 show 传多个单元，避免逐单元 exec。
  // v2.8.0：同一批 show 顺带取 ActiveState / SubState / NRestarts ——
  //   ① `systemctl show` 是机器可读输出，没有 list-units 那种行首 `●` 标记问题，权威性更高，
  //      因此用它**覆盖**上一步的解析结果（failed / activating 从此能被正确表达）；
  //   ② NRestarts 供健康检查识别「启动即失败、靠 Restart=always 反复重启」的死循环。
  // 注意：show 的属性**顺序不固定**（实测 `NRestarts=` 排在 `Id=` 之前），
  // 绝不能按「先抓到 Id 再读后续属性」解析；这里按空行切块 + 按 `Id=` 兜底切块，逐块取键值。
  try {
    const allUnits = Array.from(new Set(
      Object.keys(states.active).concat(Object.keys(states.enabled))
    )).filter(u => u.endsWith('.service') || u.endsWith('.target'));
    const CHUNK = 40;
    for (let i = 0; i < allUnits.length; i += CHUNK) {
      const batch = allUnits.slice(i, i + CHUNK).join(' ');
      const out = execQuiet('systemctl --user show -p Id -p WantedBy -p ActiveState -p SubState -p NRestarts ' + batch + ' 2>/dev/null');

      const blocks = [];
      let curBlock = [];
      const closeBlock = () => { if (curBlock.length) { blocks.push(curBlock); curBlock = []; } };
      out.split('\n').forEach(raw => {
        const line = raw.trim();
        if (!line) { closeBlock(); return; }
        const eq = line.indexOf('=');
        if (eq < 0) return;
        const key = line.slice(0, eq);
        // 没有空行分隔时的兜底：同一单元不会出现两个 Id=
        if (key === 'Id' && curBlock.some(([k]) => k === 'Id')) closeBlock();
        curBlock.push([key, line.slice(eq + 1).trim()]);
      });
      closeBlock();

      for (const block of blocks) {
        const prop = (k) => {
          const hit = block.find(([bk]) => bk === k);
          return hit ? hit[1] : undefined;
        };
        const unit = prop('Id');
        if (!unit) continue;

        const activeState = prop('ActiveState');
        if (activeState !== undefined) {
          states.activeState[unit] = activeState;
          states.active[unit] = activeState === 'active';
          states.subState[unit] = prop('SubState') || 'unknown';
        }
        const nRestarts = prop('NRestarts');
        if (nRestarts !== undefined) states.nRestarts[unit] = parseInt(nRestarts, 10) || 0;

        const parents = (prop('WantedBy') || '').split(/\s+/).filter(Boolean);
        if (parents.length) states.wantedBy[unit] = parents;
      }
    }
  } catch {}

  _systemdStateCache = states;
  _systemdStateCacheTime = now;
  return states;
}

function getAllListeningPorts() {
  const now = Date.now();
  if (_portsCache && (now - _portsCacheTime) < 3000) return _portsCache;

  const ports = new Set();
  try {
    const output = execQuiet('ss -tln 2>/dev/null');
    output.split('\n').forEach(line => {
      const match = line.match(/:(\d+)\s/);
      if (match) ports.add(parseInt(match[1]));
    });
  } catch {}

  _portsCache = ports;
  _portsCacheTime = now;
  return ports;
}

function getPortProcessMap() {
  const now = Date.now();
  if (_portProcessMapCache && (now - _portProcessMapCacheTime) < 3000) return _portProcessMapCache;

  const map = {};
  try {
    const output = execQuiet('ss -tlnp 2>/dev/null');
    output.split('\n').forEach(line => {
      const portMatch = line.match(/:(\d+)\s/);
      const pidMatch = line.match(/pid=(\d+)/);
      if (portMatch && pidMatch) {
        const port = parseInt(portMatch[1]);
        const pid = parseInt(pidMatch[1]);
        let command = '';
        let cwd = '';
        try {
          const cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim();
          command = cmdline.split(' ').slice(0, 3).join(' ');
          if (command.length > 60) command = command.substring(0, 57) + '...';
        } catch {}
        try {
          cwd = fs.readlinkSync('/proc/' + pid + '/cwd');
        } catch {}
        map[port] = { pid, command, cwd };
      }
    });
  } catch {}

  _portProcessMapCache = map;
  _portProcessMapCacheTime = now;
  return map;
}

function isPortListening(port) {
  if (!port) return false;
  return getAllListeningPorts().has(port);
}

function isLikelyOwnedBySoftwareProcess(procInfo, expectedPath, startCommand) {
  if (!procInfo) return false;

  const command = (procInfo.command || '').toLowerCase();
  const cwd = procInfo.cwd || '';
  const expected = expectedPath ? path.resolve(expectedPath) : '';
  const procCwd = cwd ? path.resolve(cwd) : '';

  if (expected && procCwd) {
    if (procCwd === expected) return true;
    if (procCwd.startsWith(expected + path.sep)) return true;
    if (expected.startsWith(procCwd + path.sep)) return true;
  }

  if (expected) {
    const dirName = path.basename(expected).toLowerCase();
    if (dirName && command.includes(dirName)) return true;
  }

  if (startCommand) {
    const genericBins = new Set(['node', 'npm', 'python', 'python3', 'bash', 'sh', 'env']);
    const tokens = startCommand
      .split(/\s+/)
      .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .map(t => path.basename(t.toLowerCase()));

    for (const token of tokens) {
      if (!token || genericBins.has(token)) continue;
      const stem = token.replace(/\.(mjs|cjs|js|ts|py)$/i, '');
      if (token.length >= 4 && command.includes(token)) return true;
      if (stem && stem.length >= 4 && command.includes(stem)) return true;
    }
  }

  return false;
}

// v2.1.1: 端口归属的权威判据 —— 若监听该端口的进程正是此 systemd 单元的 MainPID，
// 那端口当然归它自己，绝不能判成「端口冲突」。只在疑似冲突时才查（结果缓存），
// 常态零额外开销。缓存随 clearCache() 一起失效。
const _unitMainPidCache = new Map();
function isPortHeldByOwnUnit(serviceName, pid) {
  if (!serviceName || !pid) return false;
  if (_unitMainPidCache.has(serviceName)) return _unitMainPidCache.get(serviceName) === pid;
  let mainPid = 0;
  try {
    const out = execQuiet(`systemctl --user show -p MainPID --value ${serviceName} 2>/dev/null`, 1500);
    mainPid = parseInt(String(out).trim(), 10) || 0;
  } catch {}
  _unitMainPidCache.set(serviceName, mainPid);
  return mainPid === pid;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function waitForPortRelease(port, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    clearCache();
    if (!getAllListeningPorts().has(port)) return true;
    sleepSync(150);
  }
  clearCache();
  return !getAllListeningPorts().has(port);
}

function terminateOwnedPortProcess(info, signal = 'SIGTERM') {
  if (!info?.port) return { found: false };
  clearCache();
  const pinfo = getPortProcessMap()[info.port];
  if (!pinfo) return { found: false };
  if (!isLikelyOwnedBySoftwareProcess(pinfo, info.path, info.startCommand)) {
    return { found: true, owned: false, pid: pinfo.pid, command: pinfo.command, cwd: pinfo.cwd };
  }
  try {
    process.kill(pinfo.pid, signal);
    const released = waitForPortRelease(info.port);
    return { found: true, owned: true, terminated: true, pid: pinfo.pid, signal, released };
  } catch (e) {
    clearCache();
    return { found: true, owned: true, terminated: false, pid: pinfo.pid, error: e.message };
  }
}

function clearCache() {
  _systemdStateCache = null;
  _systemdStateCacheTime = 0;
  _portsCache = null;
  _portsCacheTime = 0;
  _portProcessMapCache = null;
  _portProcessMapCacheTime = 0;
  _inventoryCache = null;
  _inventoryCacheTime = 0;
  _softwareInventoryCache = null;
  _softwareInventoryCacheTime = 0;
  _systemSoftwareCache = null;
  _systemSoftwareCacheTime = 0;
  _entryInfoCache.clear();
  _entryInfoCacheTime.clear();
  _unitMainPidCache.clear();
}

// ============ 第一层：systemd 服务发现 ============

/**
 * 解析一个单元文件 → 内部服务记录。
 * unitSource: 'persistent'（~/.config/systemd/user 下的单元文件）| 'transient'（systemd-run 瞬时单元）
 */
function parseUnitFile(content, filePath, file, unitSource) {
  const serviceName = file;
  const execStart = (content.match(/ExecStart=(.*)/) || [])[1]?.trim() || '';
  const workDir = ((content.match(/WorkingDirectory=(.*)/) || [])[1]?.trim() || '').replace(/%h/g, os.homedir());
  const desc = (content.match(/Description=(.*)/) || [])[1]?.trim() || '';
  const serviceType = (content.match(/^Type=(.*)/m) || [])[1]?.trim() || 'simple';
  const env = parseSystemdEnvironment(content);
  const baseName = file.replace(/\.service$/, '');

  // v2.3.0：解析「本单元操作着哪些其他单元」——只认 ExecStart 里显式的
  //   systemctl [--user] <verb> <unit>.service
  // 这类调用（典型：openclaw-gateway-daily-restart 的
  //   ExecStart=/usr/bin/systemctl --user restart openclaw-gateway.service）。
  // 刻意不看 After=/Requires=：那些只表达启动顺序，不表达从属关系，
  // 用了会把 autoedit-studio（Requires=compute-hub.service 的独立项目）误并进 compute-hub。
  const managedRefs = [];
  {
    const refRe = /\bsystemctl\s+(?:--user\s+)?(?:start|stop|restart|try-restart|reload|reload-or-restart|reload-or-try-restart|enable|disable|reset-failed|is-active|is-enabled|show|status)\s+([\w@.:-]+?)(?:\.service)?(?=\s|$)/g;
    let refM;
    while ((refM = refRe.exec(execStart)) !== null) {
      const target = String(refM[1] || '').replace(/\.service$/, '');
      if (target && target !== baseName && !managedRefs.includes(target)) managedRefs.push(target);
    }
  }

  let softwareDir = null;
  let softwareId = null;

  if (workDir && workDir.startsWith(SOFTWARE_DIR)) {
    const rel = path.relative(SOFTWARE_DIR, workDir);
    softwareId = rel.split(path.sep)[0];
    softwareDir = path.join(SOFTWARE_DIR, softwareId);
  }

  return {
    baseName,
    serviceName,
    serviceFile: filePath,
    execStart,
    workDir,
    description: desc,
    serviceType,
    env,
    softwareId,
    softwareDir,
    managedRefs,
    unitSource
  };
}

function discoverSystemdServices() {
  const services = new Map();

  if (fileExists(SYSTEMD_USER_DIR)) {
    const files = fs.readdirSync(SYSTEMD_USER_DIR).filter(f => f.endsWith('.service'));
    for (const file of files) {
      const filePath = path.join(SYSTEMD_USER_DIR, file);
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const rec = parseUnitFile(content, filePath, file, 'persistent');
      services.set(rec.baseName, rec);
    }
  }

  // v2.4.0：补扫「瞬时单元」。这类单元由 systemd-run 创建，文件在 /run/user/<uid>/systemd/transient/，
  // 不在这里扫就永远发现不了 —— 本机 book-money-v6-live 就属于这种「跑着却看不见」的服务。
  // 同名时以持久单元为准（持久单元才是可 enable/disable 的那个）。
  try {
    if (fileExists(SYSTEMD_TRANSIENT_DIR)) {
      const tFiles = fs.readdirSync(SYSTEMD_TRANSIENT_DIR).filter(f => f.endsWith('.service'));
      for (const file of tFiles) {
        const baseName = file.replace(/\.service$/, '');
        if (services.has(baseName)) continue;
        if (MERGED_INTO_SHELL.has(baseName)) continue;
        const filePath = path.join(SYSTEMD_TRANSIENT_DIR, file);
        let content = '';
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
        const rec = parseUnitFile(content, filePath, file, 'transient');
        services.set(rec.baseName, rec);
      }
    }
  } catch {}

  return services;
}

// ============ 第二层：config.json 读取 ============

function readSoftwareConfig(dir) {
  const configPath = path.join(dir, 'config.json');
  if (!fileExists(configPath)) return null;
  return readJsonSafe(configPath);
}

// ============ 第三层：入口文件探测 ============

function detectEntryInfo(dir) {
  const now = Date.now();
  const cached = _entryInfoCache.get(dir);
  const cachedTime = _entryInfoCacheTime.get(dir);
  if (cached && cachedTime && (now - cachedTime) < ENTRY_CACHE_TTL) {
    return cached;
  }

  function scanInDir(scanDir, prefix) {
    const pkgPath = path.join(scanDir, 'package.json');
    const pkg = readJsonSafe(pkgPath);

    const nodeEntries = ['server.js', 'app.js', 'index.js', 'src/server.js', 'src/app.js', 'src/index.js'];
    const pyEntries = ['main.py', 'app.py', 'server.py', 'run.py'];
    const shellEntries = ['start.sh', 'run.sh'];

    const foundNode = nodeEntries.find(f => fileExists(path.join(scanDir, f)));
    const foundPy = pyEntries.find(f => fileExists(path.join(scanDir, f)));
    const foundShell = shellEntries.find(f => fileExists(path.join(scanDir, f)));

    let entryFile = null;
    let entryType = null;
    let startCommand = null;

    if (pkg?.scripts?.start) {
      entryType = 'node';
      startCommand = prefix ? `cd ${prefix} && ${pkg.scripts.start}` : pkg.scripts.start;
      if (foundNode) entryFile = prefix ? `${prefix}/${foundNode}` : foundNode;
    } else if (foundNode) {
      entryType = 'node';
      entryFile = prefix ? `${prefix}/${foundNode}` : foundNode;
      startCommand = prefix ? `node ${prefix}/${foundNode}` : `node ${foundNode}`;
    } else if (foundPy) {
      entryType = 'python';
      entryFile = prefix ? `${prefix}/${foundPy}` : foundPy;
      startCommand = prefix ? `python3 ${prefix}/${foundPy}` : `python3 ${foundPy}`;
    } else if (foundShell) {
      entryType = 'shell';
      entryFile = prefix ? `${prefix}/${foundShell}` : foundShell;
      startCommand = prefix ? `bash ${prefix}/${foundShell}` : `bash ${foundShell}`;
    }

    return {
      hasPackageJson: !!pkg,
      pkg,
      entryFile,
      entryType,
      startCommand,
      hasEntry: !!entryFile || !!startCommand
    };
  }

  const root = scanInDir(dir, '');
  if (root.hasEntry) return root;

  const subDirs = ['backend', 'server', 'src', 'api', 'app'];
  for (const sub of subDirs) {
    const subDir = path.join(dir, sub);
    if (fileExists(subDir)) {
      try {
        if (fs.statSync(subDir).isDirectory()) {
          const subResult = scanInDir(subDir, sub);
          if (subResult.hasEntry) return subResult;
        }
      } catch {}
    }
  }

  _entryInfoCache.set(dir, root);
  _entryInfoCacheTime.set(dir, Date.now());
  return root;
}

// ============ 项目归并 & 命名（v2.2.0） ============
// 一个项目常被拆成多个 systemd 单元（api / worker / beat / migrate / web …），
// 而且这些单元往往分散在项目根的任意子目录（image-studio 在 apps/{api,web,render}）。
// 只按「单元名」或「config.json 里的名字」归并都盖不住后者，界面于是裂出一片同项目卡片。
// 归属键优先级：softwareId > registry/config 标识 > **项目根目录** > 单元名。

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'composer.json', 'pom.xml', 'alembic.ini', 'mix.exs', 'Gemfile'
];
const _isProjectDirCache = new Map();

function isProjectDir(dir) {
  if (!dir) return false;
  if (_isProjectDirCache.has(dir)) return _isProjectDirCache.get(dir);
  let hit = false;
  try {
    hit = PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
  } catch { hit = false; }
  _isProjectDirCache.set(dir, hit);
  return hit;
}

/**
 * 把单元的工作目录回溯成「项目根」。
 * 只接受 $HOME 之下至少两级的绝对路径（形如 ~/workspace/<project>[/...]），
 * 所以 ~/workspace、$HOME、/ 都不会被当成项目 —— 否则 29 个 WorkingDirectory=$HOME
 * 的桌面服务会被并成一张巨卡。返回 null 表示该目录不适合作归属，调用方回落到单元名。
 * 回溯时取「命中最浅」的那层，因此 apps/api 会归到项目根而不是它自己。
 */
function projectRootOf(workDir) {
  let d = String(workDir == null ? '' : workDir).trim();
  if (d.startsWith('!')) d = d.slice(1);          // systemctl 对未设置项会回 "!<dir>"
  if (!d || d[0] !== path.sep) return null;
  let abs;
  try { abs = path.resolve(d); } catch { return null; }
  const home = os.homedir();
  if (abs === home) return null;
  const up = path.relative(abs, home);            // abs 是 home 的祖先 → 命中
  if (up && !up.startsWith('..')) return null;
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..')) return null;
  const segs = rel.split(path.sep).filter(Boolean);
  if (segs.length < 2) return null;               // 最少 ~/x/y
  let root = null;
  for (let i = segs.length; i >= 2; i--) {
    const cand = path.join(home, ...segs.slice(0, i));
    if (isProjectDir(cand)) root = cand;          // 越靠外层越接近真正的项目根
  }
  if (!root) return null;
  // agentport 工作树（~/workspace/.agentport-worktrees/<name>-<hash>）归回主项目
  const wt = root.match(/[\\/]\.agentport-worktrees[\\/](.+)$/);
  if (wt) {
    const name = wt[1].replace(/-[0-9a-f]{6,}$/i, '');
    const main = path.join(path.dirname(path.dirname(root)), name);
    if (name && isProjectDir(main)) return main;
  }
  return root;
}

const NAME_ACRONYMS = {
  api: 'API', ui: 'UI', ux: 'UX', ai: 'AI', db: 'DB', mv: 'MV', cli: 'CLI',
  sdk: 'SDK', sql: 'SQL', oss: 'OSS', http: 'HTTP', https: 'HTTPS', css: 'CSS', html: 'HTML',
  openclaw: 'OpenClaw', opencli: 'OpenCLI', github: 'GitHub', npm: 'npm'
};

/** 目录名/短标识 → 显示名：hot-pic → Hot Pic、all-in-one-video → All In One Video（已含大写者原样保留） */
function prettifyName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return s.split(/[-_\s]+/).filter(Boolean).map((w) => {
    const low = w.toLowerCase();
    if (NAME_ACRONYMS[low]) return NAME_ACRONYMS[low];
    if (/[A-Z]/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

/**
 * v2.4.0：单元名去掉项目名前缀 → 短标签。
 *   stripProjectPrefixFromUnit('book-money-v6-live', 'Book Money') → 'V6 Live'
 * 用于瞬时单元：它们的 Description 是命令行，只能退回单元名，而单元名又带着项目前缀。
 */
function stripProjectPrefixFromUnit(baseName, projectTitle) {
  const bn = String(baseName == null ? '' : baseName);
  if (!bn) return '';
  if (!projectTitle) return prettifyName(bn);
  const pTokens = String(projectTitle).toLowerCase().split(/[\s_\-]+/).filter(Boolean);
  const bTokens = bn.split(/[-_]/).filter(Boolean);
  let i = 0;
  while (i < pTokens.length && i < bTokens.length && bTokens[i].toLowerCase() === pTokens[i]) i++;
  const rest = bTokens.slice(i).join('-');
  return prettifyName(rest || bn);
}

/**
 * 这是「卡片名怎么取」的核心：组内各服务的 Description 往往共享项目名前缀
 * （"Hot Pic development API" / "Hot Pic development Celery beat" → "Hot Pic"），
 * 取公共前缀比拿某一条描述或硬用目录名都更贴近作者自己的叫法。
 * 单选不出（如 "Universal Compute Hub" vs "Compute Hub Linux CLI Agent"）时返回 ''，由调用方回落目录名。
 */
function commonPrefixTitle(labels) {
  const all = (labels || []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  if (all.length < 2) return '';
  // 单 token 的描述（如 "content-analyzer"）会把公共前缀吃成空串，若能凑够 2 条多词描述就先排除它
  const multiWord = all.filter((s) => /\s/.test(s));
  const use = multiWord.length >= 2 ? multiWord : all;
  const words = use.map((s) => s.split(/\s+/).filter(Boolean));
  const out = [];
  for (let i = 0; ; i++) {
    const w = words[0][i];
    if (!w) break;
    if (!words.every((arr) => arr[i] && arr[i].toLowerCase() === w.toLowerCase())) break;
    out.push(w);
  }
  // 尾部若是纯修饰词/分隔符则去掉（"Learn Solo -" → "Learn Solo"、"Hot Pic development" → "Hot Pic"）
  while (out.length && /^(?:and|or|the|of|for|with|on|in|to|-|–|—|\+|·|,|:|development|develop|dev|prod|production|staging|stage|local|service|services|server|app|apps|api|web)$/i.test(out[out.length - 1])) {
    out.pop();
  }
  const title = out.join(' ').replace(/[\s\-–—:·/|,+]+$/, '').trim();
  if (out.length < 2 || title.length < 4 || title.length > 32) return '';
  return title;
}

/**
 * 单行化 + 按长度截断（带省略号），避免卡片标题被超长 Description 撑爆。
 * v2.3.0：英文回退到「词边界」再截，修掉 "…render service (Pla…" 这种半个单词；
 * 中文没有空格，仍按字截断（CJK 无词边界，硬切不影响可读性）。
 */
function capText(raw, max) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[A-Za-z]/.test(cut)) {
    const sp = cut.lastIndexOf(' ');
    if (sp >= Math.floor(max * 0.5)) cut = cut.slice(0, sp);
  }
  cut = cut.replace(/[\s\-–—:·/,(（【]+$/, '');
  return cut + '…';
}

/**
 * v2.3.0：systemd 的 Description 是「给人读的句子」，不是项目名。
 * 直接拿来当卡片标题，就会出现一句话标题：
 *   "AutoEdit Studio real Compute Hub UI"     → "AutoEdit Studio"
 *   "My Clone (OmniBridge project client)"    → "My Clone"
 *   "OpenClaw 网关 - 核心路由服务"             → "OpenClaw 网关"
 *   "即梦图片生成服务"                          → 原样保留（中文名是好名字）
 * 收敛三步：① 剥尾部括号注释；② 剥「 - 中文尾注」；③ 英文且词数 > 3 时改用单元名转写。
 */
function cleanDisplayName(desc, baseName) {
  let s = String(desc == null ? '' : desc).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\s*[（(][^()（）]*[)）]\s*$/, '').trim();
  s = s.replace(/\s+[-–—]\s*[\u4e00-\u9fa5][\s\S]*$/, '').trim();
  if (!s) return '';
  const hasCJK = /[\u4e00-\u9fa5]/.test(s);
  const words = s.split(/\s+/).filter(Boolean);
  const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
  // ① 描述就是单元名本体（全小写 + 连字符，如 "openclaw-cockpit-shell"）→ 转写词首大写。
  //    这类描述没有任何人写的名字，直接把机器名摆到卡片上很扎眼，
  //    转写后是 "OpenClaw Cockpit Shell"。（无连字符的 "toonflow" 不在此列，原样保留。）
  if (!hasCJK && /[-_]/.test(s) && norm(s) === norm(baseName)) {
    const pretty = prettifyName(baseName);
    if (pretty) return pretty;
  }
  // 只收敛「明显是一句话」的描述（英文且 >3 词）。3 词及以内往往本身就是项目名
  // ——"Post2Video Studio V2"、"AgentPort Daemon"、"AI Video Studio"——必须原样保留，
  // 否则会被单元名转写砍成 "Post2Video" / "Agentport" 这种倒退。
  if (hasCJK || words.length <= 3) return s;

  // ② 描述开头逐词对应单元名 → 截取该前缀，且**保留描述自己的大小写**。
  //    这样 "AutoEdit Studio real Compute Hub UI" → "AutoEdit Studio"，
  //    而不是单元名转写出来的 "Autoedit Studio"（autoedit-studio 里没有大写 E 的信息）。
  const unitWords = String(baseName == null ? '' : baseName).split(/[-_\s]+/).filter(Boolean);
  if (unitWords.length && words.length > unitWords.length) {
    const head = words.slice(0, unitWords.length);
    if (head.every((w, i) => norm(w) === norm(unitWords[i]))) return head.join(' ');
  }
  // ② 对不上就用单元名转写兜底，绝不把一句话当标题
  return prettifyName(baseName) || s;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * v2.3.0：子服务短标签的术语映射。
 * 只收「高频 + 语义无歧义」的说法，把 systemd 描述里的英文动作词收敛成短中文；
 * 专有名词（FastAPI / Redis / Celery / Next.js / Vite / Jimeng / Playwright / Outbox）
 * 一律保留不译。长模式在前，避免 "single-port reverse proxy" 被 "reverse proxy" 抢先匹配。
 */
const SUB_LABEL_TERMS = [
  [/^daily restart of .+$/i, '每日自动重启'],
  [/^compatibility wrapper for .+$/i, '兼容包装层'],
  [/\badditive database migration\b/i, '数据库增量迁移'],
  [/\bdatabase migration\b/i, '数据库迁移'],
  [/\bredis readiness gate\b/i, 'Redis 就绪检查'],
  [/\boutbox dispatcher\b/i, 'Outbox 派发'],
  [/\bcelery beat\b/i, 'Celery 定时调度'],
  [/\bcelery worker\b/i, 'Celery 任务进程'],
  [/\bbackground worker\b/i, '后台任务'],
  [/\bnext\.?js web frontend\b/i, 'Next.js 前端'],
  [/\bvite frontend\b/i, 'Vite 前端'],
  [/\bweb frontend\b/i, '前端'],
  [/\bfastapi backend\b/i, 'FastAPI 后端'],
  [/\bbackup service\b/i, '备份服务'],
  [/\bsingle-port reverse proxy\b/i, '单端口反向代理'],
  [/\breverse proxy\b/i, '反向代理'],
  [/\brender service\b/i, '渲染服务'],
  [/\bheadless api case\b/i, '无界面 API 实例'],
  [/\bapi case frontend\b/i, 'API 实例前端'],
];

/**
 * 单元 Description → 卡片内短标签（关键：去掉项目名前缀，否则每行都以项目名开头）。
 *   "Good Writer backend and OmniBridge heartbeat" + "Good Writer" → "backend + OmniBridge heartbeat"
 *   "Hot Pic development Celery beat"             + "Hot Pic"     → "Celery 定时调度"
 *   "Hot Pic development additive database migration"             → "数据库增量迁移"
 */
function shortServiceLabel(desc, projectTitle, fallback) {
  let s = String(desc == null ? '' : desc).trim();
  // v2.4.0：瞬时单元（systemd-run）的 Description 是 "[systemd-run] <整条命令行>"，
  // 直接展示等于把一条命令糊到卡片上。改成用单元名（去掉项目名前缀）转写。
  if (/^\[systemd-run\]/i.test(s)) {
    const rest = stripProjectPrefixFromUnit(fallback, projectTitle);
    if (rest) return capText('临时实例 · ' + rest, 34);
  }
  // 0) 先剥尾部括号注释："detail-module render service (Playwright…)" → "detail-module render service"
  s = s.replace(/\s*[（(][^()（）]*[)）]\s*$/, '').trim();
  if (projectTitle) {
    const prefix = escapeRegExp(projectTitle).replace(/[ _-]+/g, '[ _-]*');
    const stripped = s.replace(new RegExp('^\\s*' + prefix + '\\s*[-–—:·/|]*\\s*', 'i'), '');
    if (stripped && stripped !== s) s = stripped;
  }
  // 1) 术语映射（命中即止，避免二次改写）
  for (const [re, label] of SUB_LABEL_TERMS) {
    if (re.test(s)) { s = s.replace(re, label); break; }
  }
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:development|develop|dev|production|prod|staging|stage|local|testing)\b[\s\-–—:·/|]*/i, '');
  } while (s !== prev);
  s = s.replace(/\s+and\s+/gi, ' + ').replace(/\s+/g, ' ').trim();
  if (!s) s = String(fallback == null ? '' : fallback).trim();
  return capText(s, 34);
}

// ============ 核心：三层自动发现引擎 ============

/**
 * scanPath 下的这个目录，是否「像可托管的软件」？不像就不进候选。
 *
 * 背景：scanPaths 的语义是「可能被托管的软件根」，但真实的根里常常混着别的东西。
 * 本机 `~/.openclaw/shared-skills` 其实是**技能根**，38 个条目里 31 个是技能包，
 * 于是整批被当成「候选软件」列出来，每张还带「升级为托管」和一个 🗑️ 删除按钮 ——
 * 技能没有进程生命周期（无法 start/stop/开机自启），把它当软件管是类别错误，
 * 那张 🗑️ 更是能真把共享技能搬进回收站（因为 scanPaths 也在 deletableRoots 里）。
 *
 * 只对 scanPath 生效；SOFTWARE_DIR 下的目录不受影响 —— 那是用户明确的软件目录，
 * 不该由启发式判据替他筛。
 */
function looksLikeManageableSoftware(dir) {
  // ① 技能包标记：SKILL.md / _meta.json → 技能，不是软件
  if (fileExists(path.join(dir, 'SKILL.md')) || fileExists(path.join(dir, '_meta.json'))) return false;
  // ② 内部 / 共享目录约定：下划线前缀（_shared-mcp、_shared-skill-tools）
  if (path.basename(dir).startsWith('_')) return false;
  // ③ 没有任何运行时迹象的纯容器目录（如把一堆技能装在一起的 skills/）
  const MARKERS = [
    'package.json', 'config.json', 'pyproject.toml', 'requirements.txt',
    'go.mod', 'Cargo.toml', 'Makefile', 'docker-compose.yml', 'docker-compose.yaml',
    'bin', 'src', 'server.js', 'index.js', 'main.py', 'app.py', 'start.sh'
  ];
  return MARKERS.some(f => fileExists(path.join(dir, f)));
}

// ---------------------------------------------------------------------------
// 单元内存采集（2026-10-10 新增）
// 直接读 cgroup v2 的 memory.current —— **一次目录读**，不 spawn 进程。
// 与 `systemctl --user show <unit> -p MemoryCurrent` 的值完全一致
// （实测 openclaw-gateway 两边都是 500719616）。
// 目录：/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/app.slice/
// 单元没在跑时该目录不存在 → 该单元不进 map，前端显示「—」。
// ---------------------------------------------------------------------------
const CGROUP_UID = (typeof process.getuid === 'function') ? process.getuid() : 1000;
const CGROUP_APP_SLICE = '/sys/fs/cgroup/user.slice/user-' + CGROUP_UID
  + '.slice/user@' + CGROUP_UID + '.service/app.slice';
let _unitMemoryCache = null;
let _unitMemoryCacheTime = 0;
const UNIT_MEMORY_CACHE_MS = 5000;

function getAllUnitMemory() {
  const now = Date.now();
  if (_unitMemoryCache && (now - _unitMemoryCacheTime) < UNIT_MEMORY_CACHE_MS) return _unitMemoryCache;
  const map = {};
  try {
    for (const name of fs.readdirSync(CGROUP_APP_SLICE)) {
      if (!name.endsWith('.service')) continue;
      try {
        const n = Number(fs.readFileSync(path.join(CGROUP_APP_SLICE, name, 'memory.current'), 'utf8').trim());
        if (Number.isFinite(n) && n > 0) map[name] = n;
      } catch {}
    }
  } catch {}
  _unitMemoryCache = map;
  _unitMemoryCacheTime = now;
  return map;
}

// 非 systemd 条目（registry / 手工登记）的回退：端口 → PID → /proc/<pid>/status 的 VmRSS
function readProcRssBytes(pid) {
  try {
    const m = fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch {}
  return null;
}

function buildSoftwareInventory() {
  const now = Date.now();
  if (_inventoryCache && (now - _inventoryCacheTime) < INVENTORY_CACHE_TTL) {
    return _inventoryCache;
  }

  const systemdServices = discoverSystemdServices();
  const systemdStates = getAllSystemdStates();

  // v2.4.0：瞬时单元只保留「active」的。本机 /run/user/1000/systemd/transient/ 里长期躺着
  // 一堆跑完即 failed 的一次性验收单元（omnibridge-*-acceptance-*），全量展示只是噪声；
  // 真正值得看见的是「还在跑」的那种（book-money-v6-live）。
  for (const [bn, svc] of Array.from(systemdServices)) {
    if (svc.unitSource !== 'transient') continue;
    if ((systemdStates.activeState[svc.serviceName] || '') !== 'active') systemdServices.delete(bn);
  }
  const portProcessMap = getPortProcessMap();
  const listeningPorts = getAllListeningPorts();

  const dirEntries = loadRegistryEntries();
  const IGNORE_DIRS = new Set(['node_modules', '__pycache__', '.git', '.svn', 'deprecated', 'dist', 'build', '.next', '.cache', 'tmp', 'temp', 'logs', 'data', 'backup', 'registry']);
  if (fileExists(SOFTWARE_DIR)) {
    fs.readdirSync(SOFTWARE_DIR).forEach(name => {
      try {
        if (!fs.statSync(path.join(SOFTWARE_DIR, name)).isDirectory() || name.startsWith('.') || IGNORE_DIRS.has(name.toLowerCase())) return;
        if (MERGED_INTO_SHELL.has(name)) return;
        dirEntries.push({ name, dir: path.join(SOFTWARE_DIR, name), source: 'software-dir' });
      } catch {}
    });
  }

  const scanPaths = loadScanPaths();
  for (const scanPath of scanPaths) {
    try {
      fs.readdirSync(scanPath).forEach(name => {
        const fullPath = path.join(scanPath, name);
        try {
          if (!fs.statSync(fullPath).isDirectory() || name.startsWith('.') || IGNORE_DIRS.has(name.toLowerCase())) return;
          // v2.5.0：scanPath 里的「非软件目录」不进候选（技能包 / 内部共享目录 / 纯容器目录）。
          // 判据见 looksLikeManageableSoftware()：本机 shared-skills 是技能根，此前整批被当候选列出。
          if (!looksLikeManageableSoftware(fullPath)) return;
          if (!dirEntries.find(e => e.dir === fullPath)) {
            dirEntries.push({ name, dir: fullPath, source: 'scan-path' });
          }
        } catch {}
      });
    } catch {}
  }

  const serviceBySoftwareDir = new Map();
  const allServicesBySoftwareDir = new Map();
  for (const [baseName, svc] of systemdServices) {
    if (MERGED_INTO_SHELL.has(baseName)) continue;
    if (svc.softwareId && MERGED_INTO_SHELL.has(svc.softwareId)) continue;
    if (svc.softwareId) {
      if (!allServicesBySoftwareDir.has(svc.softwareId)) {
        allServicesBySoftwareDir.set(svc.softwareId, []);
      }
      allServicesBySoftwareDir.get(svc.softwareId).push(svc);
      if (!serviceBySoftwareDir.has(svc.softwareId) || baseName === svc.softwareId) {
        serviceBySoftwareDir.set(svc.softwareId, svc);
      }
    }
  }

  const items = [];
  const seen = new Set();

  for (const entry of dirEntries) {
    let id = entry.name;
    const dir = entry.dir;
    if (seen.has(id)) {
      id = entry.source === 'scan-path'
        ? path.basename(path.dirname(dir)) + '-' + entry.name
        : entry.name;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const config = entry.config || readSoftwareConfig(dir);
    const detected = detectEntryInfo(dir);
    const linkedService = serviceBySoftwareDir.get(id);
    const allLinkedServices = allServicesBySoftwareDir.get(id) || [];

    let serviceName = null;
    let serviceFile = null;
    let hasService = false;
    let primaryService = null;

    if (config?.service) {
      serviceName = config.service.endsWith('.service') ? config.service : config.service + '.service';
      serviceFile = path.join(SYSTEMD_USER_DIR, serviceName);
      hasService = fileExists(serviceFile);
      primaryService = allLinkedServices.find(s => s.serviceName === serviceName) || null;
    }

    if (!hasService && linkedService) {
      const nonOneshot = allLinkedServices.find(s => s.serviceType !== 'oneshot');
      const chosen = nonOneshot || linkedService;
      serviceName = chosen.serviceName;
      serviceFile = chosen.serviceFile;
      hasService = true;
      primaryService = chosen;
    }

    if (!hasService) {
      const candidateService = id + '.service';
      const candidatePath = path.join(SYSTEMD_USER_DIR, candidateService);
      if (fileExists(candidatePath)) {
        serviceName = candidateService;
        serviceFile = candidatePath;
        hasService = true;
      }
    }

    const startCommand = config?.start || detected.startCommand || primaryService?.execStart || linkedService?.execStart || '';
    const itemPath = config?.runtimePath || config?.path || primaryService?.workDir || linkedService?.workDir || dir;
    const configDir = entry.configDir || dir;
    const configPath = entry.configPath || path.join(configDir, 'config.json');
    const metadataOnly = config?.metadataOnly === true || entry.source === 'registry';

    // v2.2.0: registry 条目做「存活探测」——识别软件已卸载、只剩元数据的残留条目。
    // 仅 registry 来源参与判定（目录/扫描路径来源本就靠文件系统，天然自净）。
    const orphanInfo = entry.source === 'registry'
      ? detectOrphanRegistryEntry(config, systemdStates, listeningPorts)
      : { orphan: false, evidence: null };

    let running = false;
    let autoStart = false;
    let statusSource = 'unknown';
    let systemdUnitState = null;

    if (hasService && serviceName) {
      const isActive = systemdStates.active[serviceName] ?? false;
      const isEnabled = systemdStates.enabled[serviceName] ?? false;
      running = isActive;
      autoStart = isEnabled;
      statusSource = 'systemd';
      systemdUnitState = {
        activeState: systemdStates.activeState[serviceName] || (isActive ? 'active' : 'inactive'),
        subState: systemdStates.subState[serviceName] || 'unknown',
        enabledState: systemdStates.enabledState[serviceName] || (isEnabled ? 'enabled' : 'disabled')
      };
    }

    if (!running && allLinkedServices.length > 0) {
      for (const svc of allLinkedServices) {
        if (svc.serviceType === 'oneshot') continue;
        const svcActive = systemdStates.active[svc.serviceName] ?? false;
        const svcEnabled = systemdStates.enabled[svc.serviceName] ?? false;
        if (svcActive) {
          running = true;
          autoStart = autoStart || svcEnabled;
          statusSource = 'systemd-multi';
          break;
        }
      }
    }

    const port = config?.port || detected.pkg?.port || null;
    const portProcessInfo = port ? (portProcessMap[port] || null) : null;
    const declaredPortListening = port ? listeningPorts.has(port) : false;
    const likelyOwnedBySelf = isLikelyOwnedBySoftwareProcess(portProcessInfo, itemPath, startCommand);
    const canInferOwnership = !!(itemPath || startCommand);
    let portConflict = !!(port && portProcessInfo && canInferOwnership && !likelyOwnedBySelf);
    // 复核：端口正被本单元的 MainPID 持有 → 是「自己监听自己」，不是冲突
    if (portConflict && hasService && serviceName && portProcessInfo && portProcessInfo.pid) {
      if (isPortHeldByOwnUnit(serviceName, portProcessInfo.pid)) portConflict = false;
    }

    // v2.1.1: 有 systemd 单元时，running 只认 systemd 的 ActiveState —— 端口差异只记进
    // statusSource 供 UI 提示，不再翻转状态。旧实现用端口猜测覆盖 systemd，制造了两类误报：
    //   假阴性：核心网关正监听着自己的端口，却被判成 port-conflict → 显示「已停止」
    //   假阳性：父服务已停，但同族子服务（-api / -worker）占着同一端口 → 显示「运行中」
    if (hasService) {
      if (running && port && !declaredPortListening) statusSource = 'systemd-port-missing';
      else if (portConflict) statusSource = 'systemd-port-conflict';
      else if (!running && port && portProcessInfo && likelyOwnedBySelf) statusSource = 'systemd-port-mismatch';
    } else if (!running && port && portProcessInfo && likelyOwnedBySelf) {
      // 没有 systemd 单元时，端口是唯一可用依据，此时才允许据此推断
      running = true;
      statusSource = 'port';
    }

    const description = config?.description || detected.pkg?.description || primaryService?.description || linkedService?.description || '';
    // v2.4.0：目录分支此前完全不参与命名收敛，机器名就这么漏到卡片上
    // （"openclaw-cockpit-shell"、"toonflow"）；systemd 分支在 v2.3.0 已经收敛，两条路径不一致。
    // 只在「没有显式配置名」时才动 —— registry 条目自带 displayName，必须原样尊重。
    const explicitName = config?.displayName || config?.name || null;
    let displayName = explicitName || detected.pkg?.name || id;
    if (!explicitName) {
      const machineish = /^[a-z0-9][a-z0-9._-]*$/.test(displayName)
        && displayName.toLowerCase() === String(id).toLowerCase();
      if (machineish) {
        const fromDesc = cleanDisplayName(description, id);
        // cleanDisplayName 对中文描述会把整句原样返回，那还不如机器名 —— 排除掉
        const usable = fromDesc && fromDesc !== description
          && fromDesc.length <= 40 && !/[。！？；]/.test(fromDesc);
        displayName = usable ? fromDesc : (prettifyName(id) || displayName);
      }
    }
    const isCore = config?.level === 'system' || config?.isCore === true;
    const showInNav = config?.showInNav !== false;
    const allowControl = config?.allowControl === true;
    const canControl = (allowControl || !isCore) && (hasService || !!startCommand);
    const supportsAutostart = hasService || (!!startCommand && !!dir);

    const managed = hasService || !!startCommand || config?.level === 'system';

    if (MERGED_INTO_SHELL.has(id)) continue;

    items.push({
      id,
      name: displayName,
      path: itemPath,
      configDir,
      configPath,
      metadataOnly,
      orphan: orphanInfo.orphan,
      orphanEvidence: orphanInfo.evidence,
      description,
      type: hasService ? 'systemd' : (detected.entryType || 'unknown'),
      port,
      status: running ? 'running' : 'stopped',
      running,
      autoStart,
      canControl,
      allowControl,
      supportsAutostart,
      systemd: hasService,
      systemdUnitState,
      isCore,
      showInNav,
      service: serviceName,
      serviceName: serviceName ? serviceName.replace(/\.service$/, '') : null,
      startupMode: hasService ? 'systemctl --user' : (startCommand ? 'manual' : 'none'),
      startCommand,
      statusSource,
      portConflict,
      portProcess: portProcessInfo,
      hasServiceFile: hasService,
      source: entry.source || 'software-dir',
      hasWhitepaper: [itemPath, configDir].filter(Boolean).some(docDir => fileExists(path.join(docDir, 'WHITEPAPER.md')) || fileExists(path.join(docDir, 'README.md'))),
      managed,
      detection: {
        hasConfig: !!config,
        hasPackageJson: detected.hasPackageJson,
        entryType: detected.entryType,
        entryFile: detected.entryFile,
        linkedServiceName: linkedService?.serviceName || null,
        metadataOnly
      }
    });
  }

  // v2.1.0: 先按「软件归属」把 systemd 单元归组，消除同名重复卡片。
  // 根因：一个软件常拆成多个单元（content-analyzer / -api / -worker、
  // all-in-one-video / -watchdog、别名 toonflow-dev），它们共享同一 workDir，
  // 因而匹配到同一份 config.json、拿到同一个 displayName；但去重集合 seen 用的是
  // baseName，各不相同 → 全部漏网，界面于是出现多张同名卡片。
  // 这里统一算 ownerKey：~/.openclaw/software 下的 softwareId > config.id > 单元名。
  const _cfgCache = new Map();
  const cfgForWorkDir = (dir) => {
    if (!dir) return null;
    if (_cfgCache.has(dir)) return _cfgCache.get(dir);
    const c = readSoftwareConfig(dir) || readSoftwareConfig(path.dirname(dir));
    _cfgCache.set(dir, c);
    return c;
  };

  // v2.2.0 第一遍：算出每个单元的归属候选。
  // 注意：workspace 下的 config.json 常常只有 name、没有 id（registry/*.json 才有 id），
  // 所以两者都要看；并要求它「像注册配置」（有 service/displayName/port/level 之一），
  // 免得把某个项目的普通 config.json 误当成软件标识。
  const ownerCandidate = new Map();   // bn -> { kind: 'id' | 'root' | 'attach' | 'unit', value }
  for (const [bn, s] of systemdServices) {
    if (MERGED_INTO_SHELL.has(bn)) continue;
    if (s.softwareId && MERGED_INTO_SHELL.has(s.softwareId)) continue;
    const cfg = cfgForWorkDir(s.workDir);
    const cfgOwner = (cfg && (cfg.id || cfg.name) && (cfg.service || cfg.displayName || cfg.port || cfg.level))
      ? String(cfg.id || cfg.name).trim()
      : null;
    if (s.softwareId) ownerCandidate.set(bn, { kind: 'id', value: String(s.softwareId) });
    else if (cfgOwner) ownerCandidate.set(bn, { kind: 'id', value: cfgOwner });
    else {
      const root = projectRootOf(s.workDir);
      // v2.3.0 附属单元：既没有工作目录、也回溯不到项目根的单元，往往只是「操作另一个服务」
      // 的运维型 oneshot —— 典型是 openclaw-gateway-daily-restart，
      // ExecStart=/usr/bin/systemctl --user restart openclaw-gateway.service。
      // 它不该自成一张卡。判据取最强证据：ExecStart 里显式调用 systemctl 操作的单元，
      // 且该目标必须是本机已发现的单元（防止拼错或引用不存在的单元）。
      const attachTo = (!s.workDir || !root) && s.managedRefs.length
        ? s.managedRefs.find((t) => t !== bn && systemdServices.has(t))
        : null;
      if (attachTo) ownerCandidate.set(bn, { kind: 'attach', value: attachTo });
      else ownerCandidate.set(bn, root ? { kind: 'root', value: root } : { kind: 'unit', value: bn });
    }
  }

  // v2.2.0 第二遍：给项目根分配稳定且 URL 安全的卡片 id（取目录名，撞车加序号）。
  // 卡片 id 会进 /api/software/<id>/restart 这类路径，绝不能直接塞绝对路径。
  const rootSlug = new Map();     // root -> slug
  const slugRootOf = new Map();   // slug -> root
  const usedSlugLc = new Set();
  for (const c of ownerCandidate.values()) if (c.kind === 'id') usedSlugLc.add(c.value.toLowerCase());
  for (const c of ownerCandidate.values()) {
    if (c.kind !== 'root' || rootSlug.has(c.value)) continue;
    const stem = path.basename(c.value) || 'project';
    let slug = stem;
    let n = 2;
    while (usedSlugLc.has(slug.toLowerCase())) slug = stem + '-' + (n++);
    usedSlugLc.add(slug.toLowerCase());
    rootSlug.set(c.value, slug);
    slugRootOf.set(slug, c.value);
  }

  const ownerKeyOf = new Map();    // bn -> 归属 slug
  const ownerUnits = new Map();    // 归属 slug -> [bn]（项目组的全部单元）
  const ownerPrimary = new Map();  // 归属 slug -> { baseName, score }

  // v2.3.0：attach 型归属要「跟着目标走」，而目标自己也可能 attach → 递归解析。
  // seen 负责断环（A→B→A 或自引用），保证任何输入都有确定结果、绝不无限递归。
  const ownerKeyMemo = new Map();
  const resolveOwnerKey = (bn, seen) => {
    if (ownerKeyMemo.has(bn)) return ownerKeyMemo.get(bn);
    if (seen.has(bn)) return bn;                        // 成环 → 断开，退回自身
    seen.add(bn);
    const c = ownerCandidate.get(bn);
    let ok;
    if (!c) ok = bn;                                    // 已被 MERGED_INTO_SHELL 过滤
    else if (c.kind === 'id') ok = c.value;
    else if (c.kind === 'root') ok = rootSlug.get(c.value) || bn;
    else if (c.kind === 'attach') {
      const target = String(c.value);
      ok = systemdServices.has(target) ? resolveOwnerKey(target, seen) : bn;
    } else ok = bn;
    seen.delete(bn);
    ownerKeyMemo.set(bn, ok);
    return ok;
  };

  for (const [bn, s] of systemdServices) {
    const c = ownerCandidate.get(bn);
    if (!c) continue;                                   // 已被 MERGED_INTO_SHELL 过滤
    const ok = resolveOwnerKey(bn, new Set());
    ownerKeyOf.set(bn, ok);
    if (!ownerUnits.has(ok)) ownerUnits.set(ok, []);
    ownerUnits.get(ok).push(bn);
    // 主单元：与 owner 同名者优先；其次非 oneshot（oneshot 是一次性任务，代表不了项目）；
    // 再次「名字看起来就是主服务」的 -api/-backend/-server/-gateway；
    // 再次「真的对外暴露端口」的那个（卡片上要显示端口，选它才有意义）。
    // 全并列时按单元名升序，保证同一状态下每次都选出同一个 —— 否则卡片 id/端口会随
    // readdir 顺序漂移（实测 music-maker 会随机落到 -vite 或 -api-case）。
    const hasPort = !!(
      (KNOWN_CORE_SERVICES[bn] || {}).port
      || normalizePort(s.env?.PORT)
      || normalizePort(s.env?.OPENCLI_DAEMON_PORT)
      || parsePortFromExecStart(s.execStart)
    );
    const score = (s.unitSource === 'transient' ? 0 : 100)   // v2.4.0：瞬时单元永不抢主单元
      + (bn === ok ? 2 : 0)
      + (s.serviceType !== 'oneshot' ? 1 : 0)
      + (/-(?:api|backend|server|gateway)$/.test(bn) ? 2 : 0)
      + (hasPort ? 1 : 0);
    const cur = ownerPrimary.get(ok);
    if (!cur || score > cur.score || (score === cur.score && bn < cur.baseName)) {
      ownerPrimary.set(ok, { baseName: bn, score });
    }
  }

  const projectTitleOf = (slug) => {
    const root = slugRootOf.get(slug);
    return root ? prettifyName(path.basename(root)) : null;
  };

  // 组卡名：先按各服务描述的公共前缀取，取不到再用项目目录名（registry 归属的组没有目录名则用现有卡名）
  const groupTitleOf = (slug, bns, fallbackName) => {
    // v2.4.0：瞬时单元的 Description 是 "[systemd-run] <整条命令行>"，让它参与公共前缀计算
    // 只会把组名算成空串（再掉回目录名）。先排除这类噪声。
    const named = (bns || []).filter((bn) => (systemdServices.get(bn) || {}).unitSource !== 'transient');
    const fromPrefix = commonPrefixTitle(named.map((bn) => (systemdServices.get(bn) || {}).description));
    if (fromPrefix) return fromPrefix;
    // 组里只剩一个「有名字」的单元时，用它的描述（与单卡走同一套清洗）——
    // 否则给 book-money 补上一个瞬时单元后，卡名会从 "Book Money Workbench" 掉成 "Book Money"。
    if (named.length === 1) {
      const d = cleanDisplayName((systemdServices.get(named[0]) || {}).description, named[0]);
      if (d) return d;
    }
    return fallbackName || projectTitleOf(slug) || null;
  };

  // 组装「服务组成」里的一行：短标签 + 单元名 + 真实状态（oneshot 单独标记）
  const buildSubServiceEntry = (unit, bn, projectTitle) => {
    const svcName = unit.serviceName;
    const active = systemdStates.active[svcName] ?? false;
    const enabled = systemdStates.enabled[svcName] ?? false;
    const knownCore = KNOWN_CORE_SERVICES[bn] || {};
    const port = knownCore.port
      || normalizePort(unit.env?.PORT)
      || normalizePort(unit.env?.OPENCLI_DAEMON_PORT)
      || parsePortFromExecStart(unit.execStart)
      || null;
    return {
      id: bn,
      service: svcName,
      name: shortServiceLabel(unit.description, projectTitle, bn),
      fullDescription: capText(unit.description, 80),
      port,
      portListening: port ? listeningPorts.has(port) : false,
      oneshot: unit.serviceType === 'oneshot',
      // v2.4.0：瞬时单元（systemd-run）没有单元文件，不能 enable/disable/start，UI 要区别对待
      transient: unit.unitSource === 'transient',
      running: active,
      autoStart: enabled,
      activeState: systemdStates.activeState[svcName] || (active ? 'active' : 'inactive'),
      subState: systemdStates.subState[svcName] || 'unknown',
      enabledState: systemdStates.enabledState[svcName] || (enabled ? 'enabled' : 'disabled')
    };
  };

  // 项目组内排序：主单元排最前，其余按短标签字母序，保证界面顺序稳定
  const orderGroupUnits = (bns, primaryBn, projectTitle) => {
    const list = bns.slice();
    list.sort((a, b) => {
      if (a === primaryBn) return -1;
      if (b === primaryBn) return 1;
      const da = systemdServices.get(a);
      const db = systemdServices.get(b);
      return shortServiceLabel(da && da.description, projectTitle, a)
        .localeCompare(shortServiceLabel(db && db.description, projectTitle, b));
    });
    return list;
  };

  for (const [baseName, svc] of systemdServices) {
    if (MERGED_INTO_SHELL.has(baseName)) continue;
    if (svc.softwareId && MERGED_INTO_SHELL.has(svc.softwareId)) continue;

    const isActive = systemdStates.active[svc.serviceName] ?? false;
    const isEnabled = systemdStates.enabled[svc.serviceName] ?? false;
    const known = KNOWN_CORE_SERVICES[baseName] || {};
    const workDirConfig = cfgForWorkDir(svc.workDir);

    const ownerKey = ownerKeyOf.get(baseName) || baseName;
    const primaryOfOwner = ownerPrimary.get(ownerKey);
    const isPrimary = !!primaryOfOwner && primaryOfOwner.baseName === baseName;
    const ownerLc = String(ownerKey).toLowerCase();
    const groupBns = ownerUnits.get(ownerKey) || [baseName];
    const isGroup = groupBns.length > 1;          // 同一项目的多个单元 → 合成一张卡
    const groupTitle = groupTitleOf(ownerKey, groupBns, null);

    // 已有一张卡覆盖了这个软件（同一个 owner，忽略大小写）或这个 systemd 单元本身。
    // 后者出现在「目录名与 config 里的 id 大小写不同」时，例如目录 OpenCLI / 配置 opencli。
    const existing = items.find(it =>
      String(it.id).toLowerCase() === ownerLc ||
      (it.service && it.service === svc.serviceName)
    );

    if (existing) {
      // 该卡已由 registry/目录元数据出好：把项目组的**全部**单元登记成它的「服务组成」，
      // 含主单元 —— 否则用户看到的服务数会比真实少一个。
      if (isGroup) {
        if (!Array.isArray(existing.subServices)) existing.subServices = [];
        const titleForStrip = groupTitleOf(ownerKey, groupBns, existing.name);
        const ordered = orderGroupUnits(groupBns, primaryOfOwner && primaryOfOwner.baseName, titleForStrip);
        for (const bn of ordered) {
          const unit = systemdServices.get(bn);
          if (!unit || existing.subServices.some(x => x.service === unit.serviceName)) continue;
          existing.subServices.push(buildSubServiceEntry(unit, bn, titleForStrip));
        }
      }
      // 主单元已被目录/registry 卡片覆盖 → 不重复出卡
      continue;
    }

    // 非主单元不再单独出卡：它们会被主单元那张卡聚合进 subServices
    if (!isPrimary) continue;

    if (seen.has(ownerKey)) continue;

    const projectRoot = isGroup ? (slugRootOf.get(ownerKey) || null) : null;
    const configDir = (() => {
      if (svc.softwareId) {
        const softwareRoot = path.join(SOFTWARE_DIR, svc.softwareId);
        if (fileExists(path.join(softwareRoot, 'config.json'))) return softwareRoot;
      }
      if (svc.workDir && fileExists(path.join(svc.workDir, 'config.json'))) return svc.workDir;
      if (svc.workDir) {
        const parentDir = path.dirname(svc.workDir);
        if (fileExists(path.join(parentDir, 'config.json'))) return parentDir;
      }
      // 项目组卡片：元数据与文档都落在项目根，而不是某个子目录
      return projectRoot || svc.workDir || null;
    })();

    const configPath = configDir ? path.join(configDir, 'config.json') : null;
    const itemPath = workDirConfig?.runtimePath || workDirConfig?.path || projectRoot || svc.workDir || null;
    const metadataOnly = workDirConfig?.metadataOnly === true;
    let running = isActive;
    let statusSource = 'systemd';
    const systemdUnitState = {
      activeState: systemdStates.activeState[svc.serviceName] || (isActive ? 'active' : 'inactive'),
      subState: systemdStates.subState[svc.serviceName] || 'unknown',
      enabledState: systemdStates.enabledState[svc.serviceName] || (isEnabled ? 'enabled' : 'disabled')
    };
    const port = known.port
      || normalizePort(workDirConfig?.port)
      || normalizePort(svc.env?.PORT)
      || normalizePort(svc.env?.OPENCLI_DAEMON_PORT)
      || parsePortFromDotEnv(svc.workDir)
      || parsePortFromExecStart(svc.execStart)
      || null;
    const portProcessInfo = port ? (portProcessMap[port] || null) : null;
    const declaredPortListening = port ? listeningPorts.has(port) : false;
    const likelyOwnedBySelf = isLikelyOwnedBySoftwareProcess(portProcessInfo, itemPath, svc.execStart);
    const canInferOwnership = !!(itemPath || svc.execStart);
    let portConflict = !!(port && portProcessInfo && canInferOwnership && !likelyOwnedBySelf);
    // 复核：端口正被本单元的 MainPID 持有 → 是「自己监听自己」，不是冲突
    if (portConflict && portProcessInfo && portProcessInfo.pid && isPortHeldByOwnUnit(svc.serviceName, portProcessInfo.pid)) {
      portConflict = false;
    }

    // v2.1.1: systemd 是状态权威，端口信息只作诊断标记（同 registry 分支的说明）
    if (running && port && !declaredPortListening) statusSource = 'systemd-port-missing';
    else if (portConflict) statusSource = 'systemd-port-conflict';
    else if (!running && port && portProcessInfo && likelyOwnedBySelf) statusSource = 'systemd-port-mismatch';

    // v2.2.0 命名收敛：项目组卡片用「组名」（各服务描述的公共前缀，取不到用项目目录名）；
    // 单单元卡片沿用 registry/config > 已知核心服务描述 > systemd Description。两者都设长度上限。
    const configName = workDirConfig?.displayName || workDirConfig?.name || null;
    const NAME_MAX = 44;
    // v2.3.0 命名收敛：单卡不再直接把 systemd Description 当标题，改用 cleanDisplayName
    // （剥尾部括号注释/中文尾注；英文长句改走单元名转写）。这样
    //   "AutoEdit Studio real Compute Hub UI"  → "AutoEdit Studio"
    //   "My Clone (OmniBridge project client)" → "My Clone"
    // 这类一句话标题不会再漏到界面上，中文名（"即梦图片生成服务"）则原样保留。
    const descClean = cleanDisplayName(svc.description, baseName);
    let cardName = configName
      || (isGroup ? groupTitle : null)
      || known.description
      || descClean
      || baseName;
    if (String(cardName).length > NAME_MAX && !configName) {
      // 超长描述直接截断成 "…" 很难看，优先改用单元名转写 → "OpenClaw Gateway Daily Restart"
      const fromUnit = prettifyName(baseName);
      if (fromUnit && fromUnit.length >= 4 && fromUnit.length <= NAME_MAX) cardName = fromUnit;
    }
    cardName = capText(cardName, NAME_MAX);
    const cardDescription = (() => {
      if (workDirConfig?.description) return capText(workDirConfig.description, 90);
      if (isGroup) {
        // 组卡：用主单元描述去掉组名前缀，免得出成「Hot Pic / Hot Pic development API」这种重复
        const label = shortServiceLabel(svc.description, groupTitle, null);
        const d = label ? capText(label, 90) : null;
        // v2.4.0：单卡早有「副标题与主标题相同就不显示」的规则，组卡漏了 ——
        // 于是给 book-money 补上一个瞬时单元、主单元描述恰好等于组名时，
        // 卡片会出现上下两行一模一样的文字。
        return d && d !== cardName ? d : null;
      }
      const d = capText(svc.description || '', 90) || null;
      // v2.3.0：副标题与主标题完全相同就不显示（AutoEdit 原来上下两行一模一样）
      return d && d !== cardName ? d : null;
    })();
    const cardSubServices = isGroup
      ? orderGroupUnits(groupBns, primaryOfOwner && primaryOfOwner.baseName, groupTitle)
        .map((bn) => {
          const unit = systemdServices.get(bn);
          return unit ? buildSubServiceEntry(unit, bn, groupTitle) : null;
        })
        .filter(Boolean)
      : [];

    items.push({
      id: ownerKey,
      name: cardName,
      path: itemPath,
      configDir,
      configPath,
      metadataOnly,
      description: cardDescription,
      type: 'systemd',
      port,
      status: running ? 'running' : 'stopped',
      running,
      autoStart: isEnabled,
      canControl: (workDirConfig?.allowControl === true) || !known.isCore,
      allowControl: workDirConfig?.allowControl === true,
      supportsAutostart: true,
      systemd: true,
      // v2.3.0：整组单元「既没在跑、也没设自启」→ 判为停用项目（dormant）。
      // 用来把 Learn Solo 这类已被新版取代、单元全部 disabled+inactive 的旧项目，
      // 与仍在运行的继任者（Learn Solo Studio）区分开 —— 否则并排摆着很像「同一项目两张卡」。
      // v2.6.0：自启判定改用 unitHasAutostart()，把「被 enabled target 拉起」也算进去，
      // 否则 Eat Good / Hot Pic / Image Studio 这类「target 设了开机自启、只是服务当前没跑」的
      // 项目会被误标「已停用」。
      // v2.9.0：任一单元处于 failed / activating → 整组不是「已停用」，是「坏了」，
      // 不能被灰化 + 排到列表末尾（那会让启动失败的项目看起来像被主动弃用）。
      dormant: isGroup
        ? groupBns.every((gbn) => {
            const gsvcName = (systemdServices.get(gbn) || {}).serviceName;
            if (unitIsBroken(gsvcName, systemdStates)) return false;
            return !(systemdStates.active[gsvcName] ?? false) && !unitHasAutostart(gsvcName, systemdStates);
          })
        : (unitIsBroken(svc.serviceName, systemdStates)
            ? false
            : (!running && !unitHasAutostart(svc.serviceName, systemdStates))),
      // v2.17.0：与 dormant 同源而反义 —— dormant 问「是不是彻底没救了」，本字段问「重启后会不会自己回来」。
      // 必须新增而不能复用 autoStart：autoStart 绑着面板底部那个开关，是**控制面**
      // （点一下就去 enable/disable 这个 service，必须如实反映自身 is-enabled，否则永远关不掉）；
      // 本字段要的是**配置事实** —— 含「自身 disabled、但被 enabled 的 .target 拉起」这一大类。
      // 本机实测：Hot Pic 的 6 个单元全是 static，靠 enabled 的 hot-pic-dev.target 拉起；
      // Image Studio / Eat Good 的单元是 disabled + enabled target，同理。
      // 旧口径下这三个项目在面板上都显示「自启：关」，与开机时的真实行为正好相反 ——
      // 同一个界面里，dormant 判定（用 unitHasAutostart）知道它们有自启，开关却显示没有。
      bootAutostart: isGroup
        ? groupBns.some((gbn) => unitHasAutostart((systemdServices.get(gbn) || {}).serviceName, systemdStates))
        : unitHasAutostart(svc.serviceName, systemdStates),
      systemdUnitState,
      isCore: known.isCore || false,
      showInNav: true,
      service: svc.serviceName,
      serviceName: baseName,
      startupMode: 'systemctl --user',
      startCommand: svc.execStart,
      statusSource,
      portConflict,
      portProcess: portProcessInfo,
      hasServiceFile: true,
      source: 'systemd',
      hasWhitepaper: !!(
        svc.workDir && (
          fileExists(path.join(svc.workDir, 'WHITEPAPER.md'))
          || fileExists(path.join(svc.workDir, 'README.md'))
          || fileExists(path.join(path.dirname(svc.workDir), 'WHITEPAPER.md'))
          || fileExists(path.join(path.dirname(svc.workDir), 'README.md'))
        )
      ),
      managed: true,
      subServices: cardSubServices,
      detection: {
        hasConfig: !!workDirConfig,
        hasPackageJson: !!(svc.workDir && fileExists(path.join(svc.workDir, 'package.json'))),
        entryType: null,
        entryFile: null,
        linkedServiceName: svc.serviceName,
        metadataOnly
      }
    });
    seen.add(ownerKey);
  }

  const knownPorts = new Set(items.filter(i => i.port).map(i => i.port));

  const discoveredPorts = [];
  for (const [portStr, info] of Object.entries(portProcessMap)) {
    const port = parseInt(portStr);
    if (knownPorts.has(port)) continue;
    if (port < 1024 || port === 17149) continue;
    discoveredPorts.push({
      id: 'port-' + port,
      name: info.command || ('端口 ' + port),
      path: info.cwd || null,
      description: '发现的监听服务 - 端口 ' + port,
      type: 'discovered',
      port,
      status: 'running',
      running: true,
      autoStart: false,
      canControl: false,
      supportsAutostart: false,
      systemd: false,
      isCore: false,
      showInNav: false,
      service: null,
      serviceName: null,
      startupMode: 'none',
      startCommand: null,
      statusSource: 'port',
      portProcess: info,
      hasServiceFile: false,
      source: 'port-discovery',
      hasWhitepaper: false,
      managed: false,
      detection: {
        hasConfig: false,
        hasPackageJson: false,
        entryType: null,
        entryFile: null,
        linkedServiceName: null
      }
    });
  }

  // v2.5.0：dormant 统一在清单装配完成后判定，覆盖所有来源（systemd / 目录 / registry）。
  // 原先只在 systemd 分支那一个 push 里算过，于是 registry 来源的卡片漏判 ——
  // 本机 Image Studio 的 4 个单元全是 inactive + disabled，却没被标停用，会和在跑的项目混排，
  // 与 v2.3.0 引入 dormant 的初衷（把已被取代的旧项目排开）正好相悖。
  // v2.6.0：自启判定含「被 enabled target 拉起」的路径（unitHasAutostart），与 systemd 分支保持一致。
  for (const it of items) {
    const units = [];
    if (it.service) units.push(it.service);
    for (const ss of (it.subServices || [])) if (ss && ss.service) units.push(ss.service);
    const uniq = Array.from(new Set(units.map(u => (u.endsWith('.service') ? u : u + '.service'))));
    // v2.17.0：事实面兜底 —— systemd 分支已算过的尊重其结果，其余来源（目录 / registry）在此补算。
    // 判据与 dormant 用的同一个 unitHasAutostart，但语义相反：dormant 是「彻底没救」，本字段是「重启会回来」。
    // 与运行状态、失败状态都无关：这是配置事实，重启后是否真能起来属于另一回事。
    if (it.bootAutostart === undefined) {
      it.bootAutostart = uniq.length ? uniq.some(u => unitHasAutostart(u, systemdStates)) : false;
    }
    if (it.dormant !== undefined) continue;              // systemd 分支已算过，尊重其结果
    if (!uniq.length) continue;                          // 没有任何单元 → 不判定（保持原样，别把"还没接单元"说成"已停用"）
    // v2.9.0：先排除失败/启动中的成员；剩下的全静止且无自启，才算「已停用」。
    it.dormant = uniq.every(u => {
      if (unitIsBroken(u, systemdStates)) return false;
      return !(systemdStates.active[u] ?? false) && !unitHasAutostart(u, systemdStates);
    });
  }

  const managed = items.filter(i => i.managed);
  const candidates = items.filter(i => !i.managed);
  const discovered = discoveredPorts;

  managed.sort((a, b) => {
    if (a.isCore !== b.isCore) return a.isCore ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  candidates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  discovered.sort((a, b) => a.port - b.port);

  // 统一补「内存占用」：整组所有单元的 memory.current 之和；
  // 没有单元的条目回退到「端口 → PID → VmRSS」。取不到就是 null（前端显示「—」）。
  const unitMem = getAllUnitMemory();
  const attachMemory = (item) => {
    const units = [];
    if (item.service) units.push(item.service);
    if (Array.isArray(item.subServices)) {
      for (const ss of item.subServices) if (ss && ss.service) units.push(ss.service);
    }
    let bytes = 0;
    let known = false;
    for (const u of units) {
      if (typeof unitMem[u] === 'number') { bytes += unitMem[u]; known = true; }
    }
    if (!known && item.portProcess && item.portProcess.pid) {
      const rss = readProcRssBytes(item.portProcess.pid);
      if (typeof rss === 'number') { bytes = rss; known = true; }
    }
    item.memoryBytes = known ? bytes : null;
    if (Array.isArray(item.subServices)) {
      for (const ss of item.subServices) {
        if (ss && ss.service) ss.memoryBytes = (typeof unitMem[ss.service] === 'number') ? unitMem[ss.service] : null;
      }
    }
    return item;
  };
  managed.forEach(attachMemory);
  candidates.forEach(attachMemory);

  const result = { managed, candidates, discovered };
  _inventoryCache = result;
  _inventoryCacheTime = Date.now();
  return result;
}

// ============ systemd 服务生成 ============

function generateServiceFile(id, dir, startCommand, description, port) {
  let execStart = startCommand;
  const normalizedPort = normalizePort(port);

  if (execStart.startsWith('node ') || execStart.startsWith('npm ')) {
    const nodePath = cachedWhich('node') || '/usr/bin/node';
    const npmPath = cachedWhich('npm') || '/usr/bin/npm';
    execStart = execStart.replace(/^node /, `${nodePath} `).replace(/^npm /, `${npmPath} `);
  }
  if (execStart.startsWith('python3 ') || execStart.startsWith('python ')) {
    const pyPath = cachedWhich('python3') || '/usr/bin/python3';
    execStart = execStart.replace(/^python3? /, `${pyPath} `);
  }

  if (/[;&|]|\bcd\b/.test(execStart) && !execStart.startsWith('/bin/bash')) {
    execStart = `/bin/bash -c '${execStart.replace(/'/g, "'\\''")}'`;
  }

  const portGuard = normalizedPort
    ? `ExecStartPre=/bin/bash -lc 'if ss -tln | grep -qE "[:.]${normalizedPort}[[:space:]]"; then echo "[PortGuard] Port ${normalizedPort} already in use"; exit 1; fi'\n`
    : '';

  const content = `[Unit]\nDescription=${description || id}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${dir}\n${portGuard}ExecStart=${execStart}\nRestart=on-failure\nRestartSec=5\nEnvironment=PORT=${normalizedPort || ''}\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=default.target\n`;

  return content;
}

function ensureServiceFile(id, dir, startCommand, description, port) {
  const serviceName = id + '.service';
  const servicePath = path.join(SYSTEMD_USER_DIR, serviceName);

  if (fileExists(servicePath)) return { serviceName, servicePath, created: false };

  try {
    if (!fileExists(SYSTEMD_USER_DIR)) {
      fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
    }
    const content = generateServiceFile(id, dir, startCommand, description, port);
    fs.writeFileSync(servicePath, content);
    execQuiet('systemctl --user daemon-reload 2>/dev/null', 15000);
    return { serviceName, servicePath, created: true };
  } catch (e) {
    return { serviceName, servicePath, created: false, error: e.message };
  }
}

function findInventoryItemById(id) {
  clearCache();
  const { managed, candidates } = buildSoftwareInventory();
  return managed.find(item => item.id === id) || candidates.find(item => item.id === id) || null;
}

function publicControlState(item) {
  if (!item) return null;
  return {
    running: item.running,
    autoStart: item.autoStart,
    statusSource: item.statusSource,
    systemdUnitState: item.systemdUnitState || null,
    port: item.port,
    portProcess: item.portProcess || null
  };
}

function waitForInventoryState(id, predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  let item = null;
  while (Date.now() - startedAt < timeoutMs) {
    item = findInventoryItemById(id);
    if (predicate(item)) return { ok: true, item };
    sleepSync(250);
  }
  item = findInventoryItemById(id);
  return { ok: false, item };
}

function isHealthyRunningState(item) {
  return !!(item && item.running && !['systemd-port-conflict', 'systemd-port-missing'].includes(item.statusSource));
}

// ============ 静态文件服务 ============

function serveStaticFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// ============ 请求体解析 ============

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ============ CORS ============

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ============ 系统软件扫描 ============

function categorizeSoftware(name, hasCli) {
  const lower = name.toLowerCase();
  for (const [catId, cat] of Object.entries(SOFTWARE_CATEGORIES)) {
    for (const kw of cat.keywords) {
      if (lower.includes(kw)) return catId;
    }
  }
  if (hasCli) return 'other-cli';
  return 'library';
}

let _npmPrefixCache = null;
function getNpmPrefix() {
  if (_npmPrefixCache !== null) return _npmPrefixCache;
  _npmPrefixCache = execQuiet('npm config get prefix 2>/dev/null') || path.join(os.homedir(), '.npm-global');
  return _npmPrefixCache;
}

function scanNpmGlobal() {
  const items = [];
  const npmPrefix = getNpmPrefix();
  const modulesDir = path.join(npmPrefix, 'lib', 'node_modules');

  if (!fileExists(modulesDir)) return items;

  try {
    const entries = fs.readdirSync(modulesDir);
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const pkgDir = entry.startsWith('@')
        ? path.join(modulesDir, entry)
        : path.join(modulesDir, entry);

      if (entry.startsWith('@')) {
        try {
          const scoped = fs.readdirSync(pkgDir);
          for (const sub of scoped) {
            if (sub.startsWith('.')) continue;
            const subDir = path.join(pkgDir, sub);
            const pkgJson = readJsonSafe(path.join(subDir, 'package.json'));
            if (!pkgJson) continue;
            const fullName = entry + '/' + sub;
            const binName = getBinName(pkgJson, sub);
            const binPath = findBinPath(binName, npmPrefix);
            items.push(buildSoftwareItem({
              name: pkgJson.name || fullName,
              version: pkgJson.version || '?',
              description: pkgJson.description || '',
              bin: binName,
              binPath,
              source: 'npm-global',
              pkgDir: subDir,
              homepage: pkgJson.homepage || null,
              license: pkgJson.license || null
            }));
          }
        } catch {}
      } else {
        const pkgJson = readJsonSafe(path.join(pkgDir, 'package.json'));
        if (!pkgJson) continue;
        const binName = getBinName(pkgJson, entry);
        const binPath = findBinPath(binName, npmPrefix);
        items.push(buildSoftwareItem({
          name: pkgJson.name || entry,
          version: pkgJson.version || '?',
          description: pkgJson.description || '',
          bin: binName,
          binPath,
          source: 'npm-global',
          pkgDir,
          homepage: pkgJson.homepage || null,
          license: pkgJson.license || null
        }));
      }
    }
  } catch {}
  return items;
}

function getBinName(pkgJson, fallback) {
  const bin = pkgJson.bin;
  if (!bin) return fallback;
  if (typeof bin === 'string') return path.basename(bin, '.js');
  if (typeof bin === 'object') {
    const keys = Object.keys(bin);
    return keys[0] || fallback;
  }
  return fallback;
}

function findBinPath(binName, npmPrefix) {
  const candidate = path.join(npmPrefix, 'bin', binName);
  if (fileExists(candidate)) return candidate;
  return null;
}

function scanPipUser() {
  const items = [];
  const pipUserBase = path.join(os.homedir(), '.local');

  try {
    const output = execQuiet('pip list --user --format=json 2>/dev/null');
    if (!output) return items;
    const packages = JSON.parse(output);
    for (const pkg of packages) {
      const name = pkg.name;
      const version = pkg.version;
      const binPath = path.join(pipUserBase, 'bin', name.toLowerCase().replace(/-/g, '_'));
      const binPathAlt = path.join(pipUserBase, 'bin', name.toLowerCase().replace(/_/g, '-'));
      const hasBin = fileExists(binPath) || fileExists(binPathAlt);
      const resolvedBinPath = fileExists(binPath) ? binPath : (fileExists(binPathAlt) ? binPathAlt : null);

      items.push(buildSoftwareItem({
        name,
        version,
        description: '',
        bin: hasBin ? path.basename(resolvedBinPath) : null,
        binPath: resolvedBinPath,
        source: 'pip-user',
        pkgDir: null,
        homepage: null,
        license: null,
        hasCli: hasBin
      }));
    }
  } catch {}
  return items;
}

function scanSystemBinaries() {
  const items = [];
  const knownBinaries = [
    { name: 'node', getVersion: '--version', description: 'Node.js 运行时' },
    { name: 'npm', getVersion: '--version', description: 'Node.js 包管理器' },
    { name: 'python3', getVersion: '--version', description: 'Python 3 解释器' },
    { name: 'git', getVersion: '--version', description: 'Git 版本控制' },
    { name: 'docker', getVersion: '--version', description: 'Docker 容器引擎' },
    { name: 'docker-compose', getVersion: '--version', description: 'Docker Compose 编排工具' },
    { name: 'chromium', getVersion: '--version', description: 'Chromium 浏览器' },
    { name: 'gcc', getVersion: '--version', description: 'GNU C 编译器' },
    { name: 'g++', getVersion: '--version', description: 'GNU C++ 编译器' },
    { name: 'make', getVersion: '--version', description: 'GNU Make 构建工具' },
    { name: 'cmake', getVersion: '--version', description: 'CMake 构建系统' },
    { name: 'curl', getVersion: '--version', description: 'HTTP 客户端' },
    { name: 'ss', getVersion: '-V', description: 'Socket 统计工具' },
  ];

  for (const bin of knownBinaries) {
    const binPath = cachedWhich(bin.name);
    if (!binPath) continue;
    // 版本号只是展示用的附属信息，探测要快：拿不到就算了，绝不能为它卡住 Shell
    const version = execQuiet(`${bin.name} ${bin.getVersion} 2>/dev/null`, 1500).split('\n')[0].trim();
    items.push(buildSoftwareItem({
      name: bin.name,
      version: version.replace(/^[^0-9]*/, '') || '?',
      description: bin.description,
      bin: bin.name,
      binPath,
      source: 'system',
      pkgDir: null,
      homepage: null,
      license: null
    }));
  }
  return items;
}

function buildSoftwareItem({ name, version, description, bin, binPath, source, pkgDir, homepage, license, hasCli }) {
  const cli = hasCli !== undefined ? hasCli : !!bin;
  const category = classifySoftwareCategory(name, cli, source);
  const running = checkProcessRunning(bin, binPath, pkgDir);
  return {
    name,
    version,
    description,
    bin,
    binPath,
    source,
    sourceLabel: { 'npm-global': 'npm 全局', 'pip-user': 'pip 用户', 'system': '系统' }[source] || source,
    pkgDir,
    homepage,
    license,
    category,
    categoryLabel: SOFTWARE_CATEGORIES[category]?.label || '其他',
    categoryIcon: SOFTWARE_CATEGORIES[category]?.icon || '📁',
    hasCli: hasCli !== undefined ? hasCli : !!bin,
    running
  };
}

/**
 * 运行判定用的 pgrep 包装：**模式走 argv 传参，不经 shell**。
 * 历史坑：早先用 execQuiet(`pgrep -x "X" || pgrep -f "X"`) 时，承载命令的 `/bin/sh -c`
 * 包装进程**自己的 cmdline 里就含模式串 X**，`pgrep -f` 于是永远命中它自己 ——
 * 「系统软件」页曾因此 74/74 全绿（`withCli 74 == runningCount 74` 一一对应即铁证）。
 * 当时靠「首字符塞字符类」（`[t]qdm`）绕开；现改为 execFileSync 把模式作为单个 argv
 * 交给 pgrep（pgrep 永远不报告自己的 PID），这条失败模式从根上消失，字符类技巧不再需要。
 */
function pgrepQuiet(args) {
  try {
    return execFileSync('pgrep', args, { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return ''; // 退出码 1 表示没有匹配，属正常
  }
}

/**
 * 路径匹配必须带边界，不能裸子串。`pgrep -f` 是把进程 cmdline 的 argv 用空格连起来后
 * 做**子串**匹配，裸路径会撞进更长的可执行文件路径里（均在线上实测到）：
 *   `/usr/bin/ss`     ⊂ `/usr/bin/ssh-agent`      → ssh-agent 被当成 `ss` 在跑
 *   `/usr/bin/docker` ⊂ `/usr/bin/dockerd` / `docker-proxy`
 *   `.../bin/codex`   ⊂ `.../bin/codex-real`
 * 故要求路径两端都落在「argv 元素边界」上：左侧行首或空格，右侧行尾或空格。
 * `allowSubpath` 额外放行紧随的 `/`：包目录（pkgDir）的真实进程形如
 * `<pkgDir>/dist/index.js`；而 binPath 后跟 `-` 或字母（`codex` vs `codex-real`）不算命中。
 */
function pgrepPathPattern(fullPath, allowSubpath) {
  const literal = String(fullPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!literal) return '';
  const right = allowSubpath ? '($|[/[:space:]])' : '($|[[:space:]])';
  return '(^|[[:space:]])' + literal + right;
}

// 运行判定口径：**进程名精确匹配**（自己起了同名进程），或命令行里**以 argv 元素形式**
// 出现该软件的包目录 / 可执行文件全路径（npm bin shim、pip console script 都以路径出现）。
// 不用 `pgrep -f <短名>`：太松，`uv` 会命中 uvicorn、`openclaw` 会命中无关脚本。
function checkProcessRunning(bin, binPath, pkgDir) {
  const checkName = bin || (binPath ? path.basename(binPath) : '');
  if (!checkName && !binPath && !pkgDir) return false;
  if (checkName && pgrepQuiet(['-x', checkName])) return true;
  for (const [fullPath, allowSubpath] of [[pkgDir, true], [binPath, false]]) {
    if (!fullPath) continue;
    const pattern = pgrepPathPattern(fullPath, allowSubpath);
    if (pattern && pgrepQuiet(['-f', pattern])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Docker 容器扫描（2026-10-03 新增）
// 背景：AppList 原先只扫 systemd 单元 / ~/.openclaw/software 目录 / registry /
// PATH 二进制 / npm·pip 全局包，**完全不看 Docker 容器**。于是 portainer、rsshub、
// freshrss、hot-pic-redis 这类「明明在跑」的服务在软件管理里一条都不出现
// （2026-10-03 用户提问：portainer 没在列表里吗）。
// 这里补一个独立的容器视图；**只读** —— 启停仍归 docker/compose 管。
//
// 实现：`docker ps -a --format '{{json .}}'` 一次拿全量，比逐个 `docker inspect`
// 快一个量级。端口串形如 `127.0.0.1:9000->9000/tcp, 8000/tcp`；其中只有
// `/tcp` 没有 `->` 的是「仅 expose 未发布」，前端不为它生成可点链接。
// ---------------------------------------------------------------------------
const DOCKER_CONTAINERS_CACHE_MS = 5000;
let _dockerContainersCache = null;
let _dockerContainersCacheTime = 0;

// 取本机对外 IPv4（用于拼容器访问链接）。docker 网桥的 172.16/12 段必须跳过，
// 否则可能拼出 Docker 网桥地址 这种只在宿主内可达的地址。
function detectLanIp() {
  const cands = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && ni.family === 'IPv4' && !ni.internal) cands.push(ni.address);
      }
    }
  } catch (e) { /* 拿不到就退回回环 */ }
  const isBridge = a => /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return cands.find(a => !isBridge(a)) || cands[0] || '127.0.0.1';
}

function parseDockerPorts(portStr) {
  const ports = [];
  if (!portStr) return ports;
  const pub = /(?:(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9a-fA-F:]+)\]):)?(\d+)->(\d+)\/(tcp|udp)/g;
  let m;
  while ((m = pub.exec(portStr)) !== null) {
    ports.push({
      hostIp: m[1] || m[2] || '',
      hostPort: Number(m[3]),
      containerPort: Number(m[4]),
      proto: m[5],
      published: true,
    });
  }
  const exp = /(?:^|,\s*)(\d+)\/(tcp|udp)(?=\s*(?:,|$))/g;
  let e;
  while ((e = exp.exec(portStr)) !== null) {
    const cp = Number(e[1]);
    if (ports.some(p => p.containerPort === cp && p.proto === e[2])) continue;
    ports.push({ hostIp: '', hostPort: null, containerPort: cp, proto: e[2], published: false });
  }
  // docker 的 Ports 串把同一个映射打印两遍（`0.0.0.0:18822->3000/tcp` 与
  // `[::]:18822->3000/tcp` 各一次），直接返回会让页面把端口显示两遍。
  // 这里按 containerPort/proto 去重，并优先保留 IPv4 那条（IPv6 的 hostIp 含 ':'，
  // 对拼访问链接没有意义）。
  const dedup = [];
  for (const p of ports) {
    const dup = dedup.find(d => d.containerPort === p.containerPort && d.proto === p.proto);
    if (!dup) { dedup.push(p); continue; }
    if (dup.hostIp.indexOf(':') >= 0 && p.hostIp.indexOf(':') < 0) {
      dup.hostIp = p.hostIp;
      dup.hostPort = p.hostPort;
      dup.published = p.published;
    }
  }
  return dedup;
}

// 容器内存：同样直读 cgroup v2。systemd cgroup driver 下容器 cgroup 是
// /sys/fs/cgroup/system.slice/docker-<完整64位ID>.scope。
// 一次 readdir + N 次 readFile，实测 ~8ms —— 对比 `docker stats --no-stream` 的 2.2s。
// 必须用完整 ID：`docker ps` 默认输出 12 位短 ID，只有 --no-trunc 才给全长。
const DOCKER_CGROUP_SLICE = '/sys/fs/cgroup/system.slice';
function getDockerContainerMemory() {
  const map = {};
  try {
    for (const name of fs.readdirSync(DOCKER_CGROUP_SLICE)) {
      const m = /^docker-([0-9a-f]{64})\.scope$/.exec(name);
      if (!m) continue;
      try {
        const n = Number(fs.readFileSync(path.join(DOCKER_CGROUP_SLICE, name, 'memory.current'), 'utf8').trim());
        if (Number.isFinite(n) && n > 0) map[m[1]] = n;
      } catch {}
    }
  } catch {}
  return map;
}

function scanDockerContainers(force) {
  const now = Date.now();
  if (!force && _dockerContainersCache && (now - _dockerContainersCacheTime) < DOCKER_CONTAINERS_CACHE_MS) {
    return _dockerContainersCache;
  }
  const hostIp = detectLanIp();
  const out = {
    available: false,
    host: hostIp,
    error: null,
    containers: [],
    totals: { total: 0, running: 0, stopped: 0, published: 0, compose: 0 },
  };
  try {
    const raw = execFileSync('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    });
    out.available = true;
    for (const line of String(raw).split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let c;
      try { c = JSON.parse(s); } catch (err) { continue; }
      const labels = {};
      String(c.Labels || '').split(',').forEach(kv => {
        const i = kv.indexOf('=');
        if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1);
      });
      const ports = parseDockerPorts(c.Ports);
      const primary = ports.find(p => p.published && p.hostPort) || null;
      const scheme = (primary && [443, 8443, 9443].indexOf(primary.hostPort) >= 0) ? 'https' : 'http';
      const fullId = String(c.ID || '');
      out.containers.push({
        id: fullId.slice(0, 12),
        fullId,
        memory: null,
        name: String(c.Names || '').split(',')[0],
        image: c.Image || '',
        command: c.Command || '',
        state: String(c.State || '').toLowerCase(),
        status: c.Status || '',
        createdAt: c.CreatedAt || '',
        runningFor: c.RunningFor || '',
        size: c.Size || '',
        networks: c.Networks || '',
        mounts: c.Mounts || '',
        composeProject: labels['com.docker.compose.project'] || '',
        composeService: labels['com.docker.compose.service'] || '',
        composeFile: labels['com.docker.compose.project.config_files'] || '',
        ports,
        url: primary ? (scheme + '://' + hostIp + ':' + primary.hostPort) : '',
      });
    }
    // 挂内存（cgroup 直读，见 getDockerContainerMemory）；挂完就不再需要全长 ID。
    const cgroupMem = getDockerContainerMemory();
    for (const c of out.containers) {
      if (typeof cgroupMem[c.fullId] === 'number') c.memory = cgroupMem[c.fullId];
      delete c.fullId;
    }
    out.containers.sort((a, b) => {
      const ra = a.state === 'running' ? 0 : 1;
      const rb = b.state === 'running' ? 0 : 1;
      return ra - rb || a.name.localeCompare(b.name);
    });
    out.totals = {
      total: out.containers.length,
      running: out.containers.filter(c => c.state === 'running').length,
      stopped: out.containers.filter(c => c.state !== 'running').length,
      published: out.containers.filter(c => c.url).length,
      compose: out.containers.filter(c => c.composeProject).length,
      memTotal: out.containers.reduce((n, c) => n + (typeof c.memory === 'number' ? c.memory : 0), 0),
    };
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  _dockerContainersCache = out;
  _dockerContainersCacheTime = now;
  return out;
}

let _systemSoftwareCache = null;
let _systemSoftwareCacheTime = 0;
const SYSTEM_SOFTWARE_CACHE_TTL_MS = 86400000; // 24 hours

function scanSystemSoftware() {
  const now = Date.now();
  if (_systemSoftwareCache && (now - _systemSoftwareCacheTime) < SYSTEM_SOFTWARE_CACHE_TTL_MS) return _systemSoftwareCache;

  const allItems = [];
  const seenNames = new Set();

  const npmItems = scanNpmGlobal();
  const pipItems = scanPipUser();
  const sysItems = scanSystemBinaries();

  for (const item of [...sysItems, ...npmItems, ...pipItems]) {
    if (seenNames.has(item.name.toLowerCase())) continue;
    seenNames.add(item.name.toLowerCase());
    allItems.push(item);
  }

  // 「库/依赖」不进展示：它们是别的软件的零件，不是软件本身。
  // 只把数量透出给前端（hidden.libraries），列表不再渲染。
  const libraryItems = allItems.filter(i => i.category === 'library');
  const displayItems = allItems.filter(i => i.category !== 'library');

  const bySourceOf = (items, source) => items.filter(i => i.source === source).length;

  const categories = {};
  for (const [catId, cat] of Object.entries(SOFTWARE_CATEGORIES)) {
    if (catId === 'library') continue;
    const catItems = displayItems.filter(i => i.category === catId);
    if (catItems.length > 0) {
      categories[catId] = { ...cat, items: catItems };
    }
  }

  const otherItems = displayItems.filter(i => i.category === 'other-cli');
  if (otherItems.length > 0) {
    categories['other-cli'] = { label: '其他 CLI 工具', icon: '🔧', items: otherItems };
  }

  const result = {
    success: true,
    total: displayItems.length,
    withCli: displayItems.filter(i => i.hasCli).length,
    runningCount: displayItems.filter(i => i.running).length,
    bySource: {
      npm: bySourceOf(displayItems, 'npm-global'),
      pip: bySourceOf(displayItems, 'pip-user'),
      system: bySourceOf(displayItems, 'system')
    },
    hidden: {
      libraries: libraryItems.length,
      bySource: {
        npm: bySourceOf(libraryItems, 'npm-global'),
        pip: bySourceOf(libraryItems, 'pip-user'),
        system: bySourceOf(libraryItems, 'system')
      }
    },
    categories,
    scannedAt: new Date().toISOString()
  };

  _systemSoftwareCache = result;
  _systemSoftwareCacheTime = now;
  return result;
}

// ============ 主服务器 ============

const server = http.createServer(handler);

async function handler(req, res) {
  try {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveStaticFile(res, path.join(FRONTEND_DIR, 'index.html'), 'text/html');
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
    const filePath = path.join(FRONTEND_DIR, url.pathname.replace('/public/', ''));
    const ext = path.extname(filePath);
    const mime = {
      '.js': 'application/javascript', '.css': 'text/css',
      '.html': 'text/html', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
    }[ext] || 'text/plain';
    serveStaticFile(res, filePath, mime);
    return;
  }

  // 软件列表 API
  if (req.method === 'GET' && url.pathname === '/api/software-list') {
    try {
      const { managed, candidates } = getCachedSoftwareInventory();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        software: managed.map(item => ({ ...item, version: item.version || '?', needsToggle: item.canControl })),
        managed, candidates,
        summary: {
          managed: managed.length, candidates: candidates.length,
          running: managed.filter(i => i.running).length,
          stopped: managed.filter(i => !i.running).length,
          systemd: managed.filter(i => i.systemd).length,
          autoStart: managed.filter(i => i.autoStart).length,
          totalMemoryBytes: managed.reduce((n, i) => n + (typeof i.memoryBytes === 'number' ? i.memoryBytes : 0), 0),
          memoryKnown: managed.filter(i => typeof i.memoryBytes === 'number').length
        }
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, software: [], managed: [], candidates: [], summary: { managed: 0, candidates: 0, running: 0, stopped: 0, systemd: 0, autoStart: 0 } }));
    }
    return;
  }

  // Docker 容器列表 API（2026-10-03 新增）
  if (req.method === 'GET' && url.pathname === '/api/docker-containers') {
    try {
      const data = scanDockerContainers(url.searchParams.get('refresh') === '1');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(Object.assign({ success: true }, data)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false, available: false, host: '127.0.0.1', error: e.message,
        containers: [], totals: { total: 0, running: 0, stopped: 0, published: 0, compose: 0 },
      }));
    }
    return;
  }

  // Docker 容器启停 API（2026-10-03 新增）
  // 只放行 start / stop / restart，且目标容器**必须真实存在** —— 先用 `docker ps -a`
  // 校验一次，避免把任意字符串当容器名拼进命令。执行完清掉列表缓存，前端重拉即最新状态。
  if (req.method === 'POST' && /^\/api\/docker-containers\/[^/]+\/(start|stop|restart)$/.test(url.pathname)) {
    const parts = url.pathname.split('/');
    const action = parts[4];
    const name = decodeURIComponent(parts[3] || '');
    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const known = scanDockerContainers(true).containers.some(c => c.name === name);
      if (!known) {
        reply(404, { success: false, error: 'container not found: ' + name });
        return;
      }
      execFileSync('docker', [action, name], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      _dockerContainersCache = null;
      const data = scanDockerContainers(true);
      reply(200, { success: true, action, name, container: data.containers.find(c => c.name === name) || null });
    } catch (e) {
      _dockerContainersCache = null;
      reply(500, { success: false, error: (e && e.message) ? e.message : String(e) });
    }
    return;
  }

  // 软件状态 API
  if (req.method === 'GET' && url.pathname === '/api/software-status') {
    try {
      const { managed, candidates } = getCachedSoftwareInventory();
      const software = managed.map(item => ({
        name: item.id, label: item.name, description: item.description,
        type: item.type, port: item.port, running: item.running,
        autoStart: item.autoStart, canControl: item.canControl,
        systemd: item.systemd, isCore: item.isCore,
        startCommand: item.startCommand, startupMode: item.startupMode,
        statusSource: item.statusSource, supportsAutostart: item.supportsAutostart
      }));
      const stats = {
        total: software.length, running: software.filter(s => s.running).length,
        autoStart: software.filter(s => s.autoStart).length,
        managed: managed.length, candidates: candidates.length
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ software, managed, candidates, stats }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ software: [], managed: [], candidates: [], stats: { total: 0, running: 0, autoStart: 0, managed: 0, candidates: 0 }, error: e.message }));
    }
    return;
  }

  // 软件配置保存 API
  if (req.method === 'POST' && url.pathname === '/api/software-config') {
    const data = await parseBody(req);
    const { name, port, description, start, level, navSection, showInNav } = data;

    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing software name' }));
      return;
    }

    const inventory = buildSoftwareInventory();
    const allItems = [...inventory.managed, ...inventory.candidates];
    const existingItem = allItems.find(item => item.id === name);
    const fallbackDir = path.join(SOFTWARE_DIR, name);
    const configPath = existingItem ? getConfigPathForItem(existingItem) : path.join(fallbackDir, 'config.json');
    const configDir = configPath ? path.dirname(configPath) : fallbackDir;
    const serviceWorkDir = existingItem ? getServiceWorkDirForItem(existingItem, existingItem.detection?.config || null) : fallbackDir;

    if (!configPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Software config path not found' }));
      return;
    }
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    if (existingItem?.metadataOnly && existingItem?.isCore) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '核心外部服务由 registry 只读托管，禁止通过旧配置接口改写' }));
      return;
    }

    let config = readJsonSafe(configPath) || {};

    if (port !== undefined) config.port = port || null;
    if (description !== undefined) config.description = description;
    if (start !== undefined) config.start = start;
    if (level !== undefined) config.level = level;
    if (navSection === '__hidden__') { config.navSection = ''; config.showInNav = false; }
    else { if (showInNav !== undefined) config.showInNav = showInNav; if (navSection !== undefined) config.navSection = navSection; }
    config.name = name;
    config.updatedAt = new Date().toISOString();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const changes = [];

    if (start && config.port) {
      const result = ensureServiceFile(name, getServiceWorkDirForItem(existingItem, config) || serviceWorkDir, start, description || name, config.port);
      if (result.created) changes.push('已自动生成 systemd 服务文件');
    }

    if (start && fileExists(path.join(SYSTEMD_USER_DIR, name + '.service'))) {
      try {
        let serviceContent = fs.readFileSync(path.join(SYSTEMD_USER_DIR, name + '.service'), 'utf8');
        const newContent = generateServiceFile(name, getServiceWorkDirForItem(existingItem, config) || serviceWorkDir, start, description || name, config.port);
        if (serviceContent !== newContent) {
          fs.writeFileSync(path.join(SYSTEMD_USER_DIR, name + '.service'), newContent);
          execQuiet('systemctl --user daemon-reload 2>/dev/null', 15000);
          changes.push('已更新 systemd 服务文件');
        }
      } catch {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, config, changes: changes.length > 0 ? changes : undefined }));
    return;
  }

  // 软件服务控制 API
  if (req.method === 'POST' && url.pathname.match(/^\/api\/software\/[^\/]+\/(start|stop|restart|enable|disable)$/)) {
    const parts = url.pathname.split('/');
    const softwareId = parts[3];
    const action = parts[4];

    try {
      const { managed, candidates } = buildSoftwareInventory();
      const info = managed.find(item => item.id === softwareId) || candidates.find(item => item.id === softwareId && item.canControl);

      if (!info) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '未找到软件: ' + softwareId }));
        return;
      }

      // v2.2.0: 项目级卡片会把同项目的多个 systemd 单元聚合进 subServices。
      // 控制动作必须作用到整组 —— 否则卡片上按「重启」只重启了主单元，兄弟服务仍在跑旧代码，
      // 界面显示「运行中」但其实只对了 1/N。这里返回「主单元 + 全部子单元」的去重列表。
      const groupServiceNames = (action) => {
        const list = info.service ? [info.service] : [];
        if (Array.isArray(info.subServices)) {
          for (const ss of info.subServices) {
            if (!ss || !ss.service || list.includes(ss.service)) continue;
            // v2.4.0：瞬时单元（systemd-run）没有单元文件，enable/disable/start 必然报错；
            // stop / restart 对它是有效的（能把它停掉、能重启它的进程组），所以只在持久化类动作里剔除。
            if (ss.transient && (action === 'enable' || action === 'disable' || action === 'start')) continue;
            list.push(ss.service);
          }
        }
        return list;
      };

      if (info.metadataOnly && info.isCore && !info.canControl) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '核心外部服务未开启 allowControl，禁止通过普通 AppList 控制入口操作' }));
        return;
      }

      if (info.isCore && !info.canControl && (action === 'stop' || action === 'disable')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '核心服务不允许停止/禁用' }));
        return;
      }

      if (action === 'enable' || action === 'disable') {
        let svcName = info.service || (softwareId + '.service');

        if (!info.hasServiceFile && info.startCommand) {
          const result = ensureServiceFile(softwareId, info.path, info.startCommand, info.description, info.port);
          if (result.error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '创建服务文件失败: ' + result.error }));
            return;
          }
          if (result.serviceName) {
            svcName = result.serviceName;
          }
          execQuiet('systemctl --user daemon-reload 2>/dev/null', 15000);
          clearCache();
        }

        if (svcName) {
          const targets = groupServiceNames('enable');
          if (!targets.includes(svcName)) targets.unshift(svcName);
          const results = targets.map((svc) => {
            const r = execSystemctl(action, svc);
            return { service: svc, ok: !!r.ok, error: r.ok ? null : (r.error || 'unknown') };
          });
          const failed = results.filter((x) => !x.ok);
          clearCache();
          if (!failed.length) {
            const expectedAutoStart = action === 'enable';
            const verified = waitForInventoryState(softwareId, item => !!item && item.autoStart === expectedAutoStart, 3000);
            if (!verified.ok) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, action, service: svcName, services: results, error: '自启动命令已返回成功，但复核状态仍未变更', state: publicControlState(verified.item) }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, action, service: svcName, services: results, created: !info.hasServiceFile, state: publicControlState(verified.item) }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false, action, service: svcName, services: results,
              error: '自启动' + (action === 'enable' ? '开启' : '关闭') + '失败: '
                + failed.map(f => f.service + ' (' + f.error + ')').join('; ')
            }));
          }
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '无法管理自启动：缺少服务文件和启动命令' }));
        return;
      }

      if (action === 'start' || action === 'stop' || action === 'restart') {
        if (info.hasServiceFile && info.service) {
          const targets = groupServiceNames(action);
          let preCleanup = null;
          if (action === 'restart' && info.statusSource === 'systemd-port-mismatch') {
            preCleanup = terminateOwnedPortProcess(info);
          }
          const results = targets.map((svc) => {
            const r = execSystemctl(action, svc);
            return { service: svc, ok: !!r.ok, error: r.ok ? null : (r.error || 'unknown') };
          });
          const failed = results.filter((x) => !x.ok);
          const grouped = targets.length > 1;
          if (!failed.length) {
            let cleanup = null;
            let method = preCleanup?.terminated ? 'owned-port-terminate+systemd' : 'systemd';
            if (grouped) method = 'systemd-group(' + targets.length + ')';
            if (action === 'stop') {
              cleanup = terminateOwnedPortProcess(info);
              if (cleanup.terminated) {
                method = grouped
                  ? 'systemd-group+owned-port-terminate' + (cleanup.released ? '' : '-pending')
                  : (cleanup.released ? 'systemd+owned-port-terminate' : 'systemd+owned-port-terminate-pending');
              }
              if (cleanup.found && cleanup.owned === false) {
                clearCache();
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, action, service: info.service, services: results, error: '服务已停止，但端口 ' + info.port + ' 被非本软件进程占用', portProcess: cleanup }));
                return;
              }
            }
            clearCache();
            const verified = waitForInventoryState(
              softwareId,
              item => action === 'stop' ? !!item && !item.running : isHealthyRunningState(item),
              action === 'stop' ? 4000 : 7000
            );
            if (!verified.ok) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, action, service: info.service, services: results, error: 'systemd 命令已返回成功，但真实运行状态复核失败', method, cleanup, preCleanup, state: publicControlState(verified.item) }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, action, service: info.service, services: results, method, cleanup, preCleanup, state: publicControlState(verified.item) }));
          } else {
            clearCache();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false, action, service: info.service, services: results,
              error: '服务' + ({ start: '启动', stop: '停止', restart: '重启' }[action]) + '失败: '
                + failed.map(f => f.service + ' (' + f.error + ')').join('; ')
            }));
          }
          return;
        }

        if (info.startCommand && info.path) {
          if (action === 'start') {
            const result = ensureServiceFile(softwareId, info.path, info.startCommand, info.description, info.port);
            if (result.serviceName) {
              const r = execSystemctl('start', result.serviceName);
              clearCache();
              if (r.ok) {
                const verified = waitForInventoryState(softwareId, item => isHealthyRunningState(item), 7000);
                if (!verified.ok) {
                  res.writeHead(409, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: false, action, service: result.serviceName, error: '服务启动命令已返回成功，但真实运行状态复核失败', state: publicControlState(verified.item) }));
                  return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, action, service: result.serviceName, method: 'auto-created-systemd', created: result.created, state: publicControlState(verified.item) }));
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '服务启动失败: ' + r.error }));
              }
              return;
            }

            const proc = spawn(info.startCommand, [], {
              cwd: info.path, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
              shell: true, env: { ...process.env, PORT: String(info.port || '') }
            });
            proc.unref();
            clearCache();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, action, method: 'spawn', pid: proc.pid }));
            return;
          }

          if (action === 'stop') {
            if (info.port) {
              const cleanup = terminateOwnedPortProcess(info);
              if (cleanup.terminated) {
                clearCache();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, action, method: 'owned-port-terminate', cleanup }));
                return;
              }
              if (cleanup.found && cleanup.owned === false) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '端口 ' + info.port + ' 被非本软件进程占用，已拒绝终止', portProcess: cleanup }));
                return;
              }
            }

            try {
              const pids = execQuiet(`pgrep -f "${info.path}"`);
              if (pids) {
                pids.split('\n').forEach(pid => {
                  try { process.kill(parseInt(pid.trim()), 'SIGTERM'); } catch {}
                });
                clearCache();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, action, method: 'kill-by-path' }));
                return;
              }
            } catch {}

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '未找到运行中的进程' }));
            return;
          }

          if (action === 'restart') {
            if (info.port) {
              terminateOwnedPortProcess(info);
            }
            setTimeout(() => {
              const proc = spawn(info.startCommand, [], {
                cwd: info.path, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
                shell: true, env: { ...process.env, PORT: String(info.port || '') }
              });
              proc.unref();
            }, 1000);
            clearCache();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, action, method: 'kill-and-spawn' }));
            return;
          }
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '无可用的控制方式' }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '未知操作: ' + action }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 升级候选为托管
  if (req.method === 'POST' && url.pathname.match(/^\/api\/software\/[^\/]+\/promote$/)) {
    const parts = url.pathname.split('/');
    const id = parts[3];
    try {
      const { candidates } = buildSoftwareInventory();
      const candidate = candidates.find(c => c.id === id);
      if (!candidate) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '未找到候选软件' }));
        return;
      }

      const configPath = path.join(candidate.path, 'config.json');
      let config = readJsonSafe(configPath) || {};
      config.name = id;
      config.level = config.level || 'normal';
      let startCommand = config.start || candidate.startCommand || '';
      if (!startCommand && candidate.path) {
        const detected = detectEntryInfo(candidate.path);
        startCommand = detected.startCommand || '';
      }
      config.start = startCommand;
      config.port = config.port || candidate.port || null;
      config.description = config.description || candidate.description || '';
      config.updatedAt = new Date().toISOString();
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      if (config.start && candidate.path) {
        ensureServiceFile(id, candidate.path, config.start, config.description, config.port);
      }

      clearCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id, config }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 更新软件信息
  if (req.method === 'PUT' && url.pathname.match(/^\/api\/software\/[^\/]+$/)) {
    const parts = url.pathname.split('/');
    const id = parts[3];
    const data = await parseBody(req);
    try {
      const inventory = buildSoftwareInventory();
      const allItems = [...inventory.managed, ...inventory.candidates, ...inventory.discovered];
      const item = allItems.find(i => i.id === id);
      if (!item || (!item.configDir && !item.path)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '软件未找到' }));
        return;
      }

      const configPath = getConfigPathForItem(item);
      if (!configPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '找不到可写配置文件路径' }));
        return;
      }

      const configDir = path.dirname(configPath);
      if (!fileExists(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      let config = readJsonSafe(configPath) || {};
      const protectRuntimeConfig = item.metadataOnly && item.isCore;
      if (data.displayName !== undefined) config.displayName = data.displayName;
      if (data.name !== undefined) config.name = data.name;
      if (data.description !== undefined) config.description = data.description;
      if (!protectRuntimeConfig && data.port !== undefined) config.port = data.port || null;
      if (!protectRuntimeConfig && data.start !== undefined) config.start = data.start || '';
      if (!protectRuntimeConfig && data.level !== undefined) config.level = data.level;
      if (!protectRuntimeConfig && data.isCore !== undefined) config.isCore = data.isCore;
      if (data.showInNav !== undefined) config.showInNav = data.showInNav;
      if (!protectRuntimeConfig && data.service !== undefined) config.service = data.service;
      config.updatedAt = new Date().toISOString();
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const serviceWorkDir = getServiceWorkDirForItem(item, config);
      if (!protectRuntimeConfig && config.start && serviceWorkDir) {
        const result = ensureServiceFile(id, serviceWorkDir, config.start, config.description || id, config.port);
        if (result.created) {
          execQuiet('systemctl --user daemon-reload 2>/dev/null', 15000);
        }
      }

      clearCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, config }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 删除软件（仅限候选或未托管目录）
  // 清理孤儿元数据：删除 registry/<id>.json。
  // 安全要点：只删注册表条目本身，**绝不触碰 runtimePath** —— registry 条目的
  // runtimePath 常常是共享目录（如 ~/.local/bin），对它 rmSync 会连带删掉无关文件。
  // 另加路径护栏：目标必须落在 REGISTRY_DIR 内且是 .json。
  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/registry-metadata\/[^\/]+$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    try {
      const files = fileExists(REGISTRY_DIR) ? fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')) : [];
      let target = null;
      for (const f of files) {
        const cfg = readJsonSafe(path.join(REGISTRY_DIR, f));
        const cid = String((cfg && (cfg.id || cfg.name)) || path.basename(f, '.json')).trim();
        if (cid === id) { target = path.join(REGISTRY_DIR, f); break; }
      }
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '未找到该注册表条目' }));
        return;
      }
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(REGISTRY_DIR) + path.sep) || !resolved.endsWith('.json')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '目标路径非法，已拒绝' }));
        return;
      }
      fs.unlinkSync(resolved);
      clearCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '已清理元数据 ' + id, removed: path.basename(resolved) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/software\/[^\/]+$/)) {
    const parts = url.pathname.split('/');
    const id = decodeURIComponent(parts[3] || '');
    try {
      const inventory = buildSoftwareInventory();
      const item = inventory.candidates.find(i => i.id === id);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '只能删除候选项目，托管软件请手动移除' }));
        return;
      }
      // 这个接口会改文件系统，不能靠一个裸 DELETE 触发：必须显式带 ?confirm=1
      if (url.searchParams.get('confirm') !== '1') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '缺少确认参数，请带 ?confirm=1 调用' }));
        return;
      }
      if (!item.path || !fileExists(item.path)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '软件目录不存在' }));
        return;
      }
      // v2.4.0 安全护栏：原实现是 rmSync(item.path, { recursive:true, force:true })，
      // 而候选路径来自 scanPaths —— 本机就包含 ~/.openclaw/shared-skills，
      // 于是共享技能卡上的 🗑️ 会真的把共享技能目录递归删掉。
      const guard = assertDeletableTarget(item.path);
      if (!guard.ok) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '拒绝删除：' + guard.reason, path: item.path }));
        return;
      }
      // 不硬删：移入回收站（TRASH_DIR），可人工恢复
      let trashedTo;
      try {
        trashedTo = softDeleteToTrash(guard.real);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '移入回收站失败（未做任何删除）: ' + e.message }));
        return;
      }
      clearCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '已移入回收站 ' + id, trashedTo }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 获取单个软件详情
  if (req.method === 'GET' && url.pathname.match(/^\/api\/software\/[^\/]+$/)) {
    const parts = url.pathname.split('/');
    const id = parts[3];
    try {
      const { managed, candidates, discovered } = buildSoftwareInventory();
      const item = managed.find(i => i.id === id) || candidates.find(i => i.id === id) || discovered.find(i => i.id === id);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '未找到软件' }));
        return;
      }

      const config = readJsonSafe(getConfigPathForItem(item)) || readSoftwareConfig(item.configDir || item.path);
      let serviceContent = null;
      if (item.hasServiceFile && item.service) {
        try { serviceContent = fs.readFileSync(path.join(SYSTEMD_USER_DIR, item.service), 'utf8'); } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, item, config, serviceContent }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 读取软件文档
  if (req.method === 'GET' && url.pathname.match(/^\/api\/software\/[^\/]+\/doc$/)) {
    const parts = url.pathname.split('/');
    const id = parts[3];
    try {
      const inventory = buildSoftwareInventory();
      const allItems = [...inventory.managed, ...inventory.candidates, ...inventory.discovered];
      const item = allItems.find(i => i.id === id);
      if (!item || !item.path) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '软件未找到' }));
        return;
      }
      const docDirs = Array.from(new Set([item.path, item.configDir].filter(Boolean)));
      let content = null;
      let filename = null;
      for (const dir of docDirs) {
        for (const name of ['WHITEPAPER.md', 'README.md', 'README', 'WHITEPAPER']) {
          const p = path.join(dir, name);
          if (fileExists(p)) {
            try { content = fs.readFileSync(p, 'utf8'); filename = name; } catch {}
            break;
          }
        }
        if (content !== null) break;
      }
      if (content === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '未找到文档文件' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, filename, content }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 一键健康检查
  if (req.method === 'GET' && url.pathname === '/api/health-check') {
    try {
      const { managed, discovered } = buildSoftwareInventory();
      const systemdStates = getAllSystemdStates();
      const scope = (url.searchParams.get('scope') || 'all').toLowerCase();
      const coreOnly = scope === 'core' || scope === 'core-only' || scope === 'core_only';
      const managedTargets = coreOnly ? managed.filter(item => item.isCore) : managed;
      const listeningPorts = getAllListeningPorts();
      const results = [];
      let totalIssues = 0;
      const severityCounts = { error: 0, warning: 0, info: 0 };
      const portClaims = new Map();
      const rebootCronEntries = getRebootCronEntries();

      for (const item of managedTargets) {
        if (!item.port) continue;
        if (!portClaims.has(item.port)) portClaims.set(item.port, []);
        portClaims.get(item.port).push(item);
      }

      const addCheck = (checks, key, level, message, meta) => {
        checks.push({ key, level, message, ...(meta ? { meta } : {}) });
        if (severityCounts[level] !== undefined) severityCounts[level] += 1;
      };

      for (const item of managedTargets) {
        const checks = [];
        const duplicatePortClaims = item.port ? (portClaims.get(item.port) || []) : [];
        const duplicateAutostartSources = findDuplicateAutostartSources(item, rebootCronEntries);

        if (duplicatePortClaims.length > 1) {
          addCheck(
            checks,
            'duplicate-port-claim',
            'error',
            '端口 ' + item.port + ' 被多个托管软件声明: ' + duplicatePortClaims.map(i => i.id).join(', ')
          );
        }

        if (item.portConflict) {
          addCheck(
            checks,
            'port-conflict',
            'error',
            '端口 ' + item.port + ' 被非本软件进程占用',
            item.portProcess || undefined
          );
        }

        if (item.statusSource === 'systemd-port-mismatch') {
          addCheck(
            checks,
            'systemd-port-mismatch',
            'warning',
            '端口进程归属本软件，但 systemd 未处于 active，可能存在手动/遗留进程或服务重启失败',
            { systemdUnitState: item.systemdUnitState || null, portProcess: item.portProcess || null }
          );
        }

        if (item.statusSource === 'systemd-port-missing') {
          addCheck(
            checks,
            'systemd-port-missing',
            'error',
            'systemd 显示 active，但声明端口 ' + item.port + ' 未监听，面板不会再将其显示为正常运行',
            { systemdUnitState: item.systemdUnitState || null }
          );
        }

        if (item.hasServiceFile && item.service) {
          if (!item.running && item.isCore) {
            addCheck(checks, 'service-stopped', 'error', '核心服务已停止');
          } else if (!item.running && item.autoStart) {
            addCheck(checks, 'service-stopped', 'warning', '已启用自启但服务未运行');
          } else if (!item.running) {
            addCheck(checks, 'service-stopped', 'info', '服务已停止');
          }

          if (item.systemdUnitState && item.systemdUnitState.activeState && item.systemdUnitState.activeState !== 'active' && item.running) {
            addCheck(
              checks,
              'systemd-state-not-active',
              'warning',
              'AppList 通过端口判断运行中，但 systemd 状态为 ' + item.systemdUnitState.activeState + '/' + item.systemdUnitState.subState,
              item.systemdUnitState
            );
          }

          // v2.8.0：单元「起不来」的三种明确形态。
          // 背景（Content Analyzer 事故）：注册表绑到了一个项目拆分前遗留的单元，它自带 ExecStartPre
          // 死等一个已被新单元占用的端口 → 永久卡在 `activating (start-pre)`，Restart=always 下每 5 秒
          // 重启一次、累计 49 次；而面板上只显示「已停止」，点启动毫无反馈。
          // 更糟的是 `●` 解析错位让 failed 全部退化成 inactive，健康检查也无从分辨。
          // 现在按 ActiveState/SubState + NRestarts 给出可定性、可定位的诊断。
          const unitState = item.systemdUnitState;
          const unitRestarts = (systemdStates.nRestarts && systemdStates.nRestarts[item.service]) || 0;

          if (unitState && unitState.activeState === 'failed') {
            addCheck(
              checks,
              'systemd-unit-failed',
              'error',
              '单元处于 failed：启动失败且未进入重试（累计自动重启 ' + unitRestarts + ' 次）。用 systemctl --user status ' + item.service + ' 查看原因',
              { ...unitState, nRestarts: unitRestarts }
            );
          } else if (unitState && unitState.activeState === 'activating') {
            const sub = unitState.subState || 'unknown';
            const loopLike = unitRestarts >= 3 || sub === 'auto-restart';
            addCheck(
              checks,
              'systemd-stuck-activating',
              loopLike ? 'error' : 'warning',
              loopLike
                ? '单元卡在 activating/' + sub + ' 且已累计自动重启 ' + unitRestarts + ' 次：启动即失败的死循环（常见于 ExecStartPre 死等一个已被其它进程占用的端口）'
                : '单元处于 activating/' + sub + '：可能正在启动；若长时间不变，用 systemctl --user status ' + item.service + ' 查看',
              { ...unitState, nRestarts: unitRestarts }
            );
          } else if (unitState && unitState.activeState === 'active' && unitRestarts >= 10) {
            addCheck(
              checks,
              'systemd-restart-storm',
              'warning',
              '单元虽为 active，但累计自动重启 ' + unitRestarts + ' 次：靠 Restart=always 反复自愈，服务实际不稳定',
              { ...unitState, nRestarts: unitRestarts }
            );
          }

          // v2.8.0：项目组成员单元逐个查 —— 组卡的 systemdUnitState 只反映「主单元」，
          // 某个成员起不来（例如前端）会被整组的「已停止」掩盖，面板上完全看不见。
          // 分级有意保守：只有在「同组还有东西在跑」或「该成员设了开机自启」时才升为 error
          // （这两种情况下它是真的坏了）；整组本来就没在跑、成员也没设自启 → 仅 info，
          // 只做陈述、不计入 issues，避免对已停用的项目反复报错。
          const subServices = Array.isArray(item.subServices) ? item.subServices : [];
          for (const sub of subServices) {
            if (!sub || !sub.service || sub.oneshot || sub.service === item.service) continue;
            if (sub.activeState !== 'failed' && sub.activeState !== 'activating') continue;

            const isFailed = sub.activeState === 'failed';
            const groupRunning = !!item.running;
            const willAutostart = !!sub.autoStart;
            const subRestarts = (systemdStates.nRestarts && systemdStates.nRestarts[sub.service]) || 0;
            const level = (groupRunning || willAutostart) ? 'error' : 'info';
            const why = groupRunning
              ? '；同组其它单元正在运行，说明这一环是坏的'
              : (willAutostart ? '；该单元已设开机自启，开机会起来又倒下' : '；整组当前均未运行');

            addCheck(
              checks,
              isFailed ? 'subservice-unit-failed' : 'subservice-stuck-activating',
              level,
              '项目组成员 ' + sub.service + '（' + (sub.name || '未命名') + '）处于 ' + sub.activeState + '/' + (sub.subState || 'unknown') +
                (isFailed ? '：该组件已起不来' : '：疑似启动死循环') +
                (subRestarts > 0 ? '，累计自动重启 ' + subRestarts + ' 次' : '') + why,
              { service: sub.service, activeState: sub.activeState, subState: sub.subState, nRestarts: subRestarts, groupRunning, willAutostart }
            );
          }

          if (!item.autoStart && item.hasServiceFile) {
            addCheck(checks, 'autostart-off', 'warning', '自启动未开启');
          }

          if (duplicateAutostartSources.length > 0) {
            addCheck(
              checks,
              'duplicate-autostart-source',
              'warning',
              'systemd 已启用自启动，但还存在 crontab @reboot 启动入口，可能重复拉起或互相抢端口',
              { sources: duplicateAutostartSources }
            );
          }

          try {
            const svcPath = path.join(SYSTEMD_USER_DIR, item.service);
            const svcContent = fs.readFileSync(svcPath, 'utf8').replace(/%h/g, os.homedir());
            const serviceType = (svcContent.match(/^Type=(.*)$/m) || [])[1]?.trim() || 'simple';
            const isOneshot = serviceType === 'oneshot';
            const execMatch = svcContent.match(/ExecStart=(.*)/);
            if (execMatch) {
              const execCmd = execMatch[1].trim();
              const cmdParts = execCmd.split(/\s+/);
              const exePath = cmdParts[0];
              if (exePath.startsWith('/') && !fileExists(exePath)) {
                addCheck(checks, 'exec-not-found', 'error', 'ExecStart 路径不存在: ' + exePath);
              }
              if (isDevWatchCommand(execCmd)) {
                addCheck(checks, 'dev-watch-service', 'warning', 'systemd 托管不应使用 dev/watch 启动命令: ' + execCmd);
              }
            }

            if (item.startCommand && isDevWatchCommand(item.startCommand)) {
              addCheck(checks, 'dev-watch-config', 'warning', 'config.json start 不应使用 dev/watch 启动命令: ' + item.startCommand);
            }

            if (item.port && !isOneshot) {
              const hasFixedPortEnv = new RegExp('^Environment=.*\\bPORT=' + item.port + '\\b', 'm').test(svcContent)
                || new RegExp('^Environment=.*\\bOPENCLI_DAEMON_PORT=' + item.port + '\\b', 'm').test(svcContent);
              const hasPortGuard = svcContent.includes('ExecStartPre=') && svcContent.includes(String(item.port));
              if (!hasFixedPortEnv) {
                addCheck(checks, 'missing-fixed-port-env', 'warning', 'systemd 未显式声明固定端口 Environment=PORT=' + item.port);
              }
              if (!hasPortGuard) {
                addCheck(checks, 'missing-port-guard', 'warning', 'systemd 缺少端口守卫 ExecStartPre，端口被占用时可能反复失败或误判');
              }
            }
            const workDirMatch = svcContent.match(/WorkingDirectory=(.*)/);
            if (workDirMatch) {
              const wd = workDirMatch[1].trim();
              if (!fileExists(wd)) {
                addCheck(checks, 'workdir-missing', 'error', 'WorkingDirectory 不存在: ' + wd);
              }
            }
          } catch {}
        } else if (!item.hasServiceFile && item.startCommand) {
          addCheck(checks, 'no-service-file', 'warning', '有启动命令但无 systemd 服务文件');
        }

        const configPath = getConfigPathForItem(item);
        const configBase = configPath ? path.dirname(configPath) : (item.configDir || item.path);
        if (configBase || configPath) {
          if (configBase && !fileExists(configBase)) {
            addCheck(checks, 'dir-missing', 'error', '软件目录不存在');
          } else {
            if (configPath && fileExists(configPath)) {
              const config = readJsonSafe(configPath);
              if (!config) {
                addCheck(checks, 'config-invalid', 'error', 'config.json 解析失败');
              } else {
                if (config.port && typeof config.port !== 'number') {
                  addCheck(checks, 'config-port-type', 'warning', 'config.json port 不是数字');
                }
                if (item.port && config.port && Number(config.port) !== Number(item.port)) {
                  addCheck(checks, 'config-port-mismatch', 'warning', '运行端口与 config.json port 不一致');
                }
                if (config.start && !config.start.trim()) {
                  addCheck(checks, 'config-start-empty', 'warning', 'config.json start 命令为空');
                }
                if (config.metadataOnly === true) {
                  if (typeof config.runtimePath !== 'string' || !config.runtimePath.trim()) {
                    addCheck(checks, 'metadata-runtime-missing', 'warning', 'metadataOnly=true 需要声明 runtimePath，避免把元数据目录误认为运行目录');
                  } else if (!fileExists(config.runtimePath)) {
                    addCheck(checks, 'metadata-runtime-not-found', 'error', 'metadataOnly 声明的 runtimePath 不存在: ' + config.runtimePath);
                  }
                }
                // v2.8.0：config 声明了 service，但对应单元文件不存在 —— 卡片会静默失去启停能力，
                // 只剩下一个「只能看不能控」的元数据外观。这是 Content Analyzer 事故的镜像情形
                // （那次是声明指向了一个早该删掉的遗留单元），两个方向都要能查出来。
                if (typeof config.service === 'string' && config.service.trim()) {
                  const declaredService = config.service.trim();
                  const declaredUnit = declaredService.endsWith('.service') ? declaredService : declaredService + '.service';
                  if (!fileExists(path.join(SYSTEMD_USER_DIR, declaredUnit))) {
                    addCheck(
                      checks,
                      'service-unit-missing',
                      'error',
                      'config 声明 service="' + declaredService + '"，但单元文件 ' + declaredUnit + ' 不存在：卡片会失去启停能力'
                    );
                  }
                }
              }
            } else if (item.systemd) {
              addCheck(checks, 'no-config', 'info', '无 config.json（systemd 托管）');
            }
          }
        }

        if (item.port && !item.running) {
          if (listeningPorts.has(item.port)) {
            if (item.statusSource === 'systemd') {
              addCheck(checks, 'systemd-miss-running', 'warning', 'systemd 未检测到运行，但端口 ' + item.port + ' 正在监听（可能通过其他方式启动）');
            } else {
              addCheck(checks, 'port-conflict', 'warning', '端口 ' + item.port + ' 被其他进程占用');
            }
          }
        }

        if (item.running && item.port && !listeningPorts.has(item.port)) {
          addCheck(checks, 'port-not-listening', 'error', '服务标记为运行中但端口 ' + item.port + ' 未监听');
        }

        const issues = checks.filter(c => c.level === 'error' || c.level === 'warning');
        totalIssues += issues.length;

        results.push({
          id: item.id,
          name: item.name,
          isCore: item.isCore,
          running: item.running,
          autoStart: item.autoStart,
          hasService: item.hasServiceFile,
          service: item.service,
          statusSource: item.statusSource,
          systemdUnitState: item.systemdUnitState || null,
          port: item.port,
          portProcess: item.portProcess || null,
          metadataOnly: item.metadataOnly || false,
          duplicateAutostartSources,
          checks
        });
      }

      const unmanagedPorts = discovered
        .filter(item => item.portProcess?.pid)
        .map(item => ({
          port: item.port,
          pid: item.portProcess.pid,
          command: item.portProcess.command,
          cwd: item.portProcess.cwd
        }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        results,
        totalIssues,
        severityCounts,
        unmanagedPorts,
        summary: {
          scope: coreOnly ? 'core' : 'all',
          managed: managedTargets.length,
          managedTotal: managed.length,
          checked: managedTargets.length,
          running: managedTargets.filter(i => i.running).length,
          stopped: managedTargets.filter(i => !i.running).length,
          portConflicts: managedTargets.filter(i => i.portConflict).length,
          systemdPortMismatches: managedTargets.filter(i => i.statusSource === 'systemd-port-mismatch').length,
          systemdPortMissing: managedTargets.filter(i => i.statusSource === 'systemd-port-missing').length,
          systemdUnitFailed: results.filter(r => r.checks.some(c => c.key === 'systemd-unit-failed')).length,
          systemdStuckActivating: results.filter(r => r.checks.some(c => c.key === 'systemd-stuck-activating')).length,
          systemdRestartStorm: results.filter(r => r.checks.some(c => c.key === 'systemd-restart-storm')).length,
          serviceUnitMissing: results.filter(r => r.checks.some(c => c.key === 'service-unit-missing')).length,
          subserviceUnitFailed: results.filter(r => r.checks.some(c => c.key === 'subservice-unit-failed')).length,
          subserviceStuck: results.filter(r => r.checks.some(c => c.key === 'subservice-stuck-activating')).length,
          duplicateAutostartSources: results.filter(r => r.checks.some(c => c.key === 'duplicate-autostart-source')).length,
          metadataOnly: managedTargets.filter(i => i.metadataOnly).length,
          devWatchManaged: results.filter(r => r.checks.some(c => c.key === 'dev-watch-service' || c.key === 'dev-watch-config')).length
        },
        checkedAt: new Date().toISOString()
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // AI 分析健康检查结果
  if (req.method === 'POST' && url.pathname === '/api/health-check/ai-analyze') {
    try {
      const llmConfig = getLLMConfig();
      if (!llmConfig) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '未找到 AI 模型配置，请在 ~/.openclaw/openclaw.json 中配置 models.providers' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const params = body ? JSON.parse(body) : {};
          const modelId = params.model || null;

          const { managed } = buildSoftwareInventory();
          const summaryData = managed.map(item => ({
            name: item.name,
            id: item.id,
            isCore: item.isCore,
            running: item.running,
            autoStart: item.autoStart,
            port: item.port,
            statusSource: item.statusSource,
            hasServiceFile: item.hasServiceFile,
            startCommand: item.startCommand
          }));

          const systemPrompt = `你是 OpenClaw 平台的运维诊断专家。用户会给你一份软件服务的健康检查报告，你需要：
1. 分析每个异常的根本原因
2. 给出具体的修复建议（命令级别）
3. 识别潜在风险（如核心服务未自启、端口冲突等）
4. 按优先级排序建议

输出格式要求：
- 使用中文
- 用 Markdown 格式
- 每个问题用 ### 标题
- 修复建议用代码块包裹命令
- 最后给出一个"整体健康评分"（0-100分）`;

          const userPrompt = `以下是 OpenClaw 平台所有软件服务的健康检查报告：

${JSON.stringify(summaryData, null, 2)}

请分析以上数据，给出诊断和修复建议。`;

          const aiResult = await callLLM(userPrompt, systemPrompt, modelId);
          const usedModel = modelId
            ? (llmConfig.models.find(m => m.id === modelId)?.name || modelId)
            : llmConfig.default.name;

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, analysis: aiResult, model: usedModel, analyzedAt: new Date().toISOString() }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  // 获取可用 AI 模型列表
  if (req.method === 'GET' && url.pathname === '/api/ai-models') {
    const llmConfig = getLLMConfig();
    if (!llmConfig) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, models: [], default: null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      models: llmConfig.models.map(m => ({ id: m.id, name: m.name, provider: m.providerId })),
      default: llmConfig.default.id
    }));
    return;
  }

  // AI 一键修复
  if (req.method === 'POST' && url.pathname === '/api/health-check/ai-fix') {
    try {
      const llmConfig = getLLMConfig();
      if (!llmConfig) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '未找到 AI 模型配置' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const params = body ? JSON.parse(body) : {};
          const categories = params.categories || [];
          const commands = params.commands || [];

          if (commands.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, results: [], output: '没有需要执行的修复命令' }));
            return;
          }

          const systemPrompt = `你是 OpenClaw 平台的运维修复专家。用户会给你一组需要修复的命令，你需要：
1. 检查每条命令是否安全合理
2. 生成一个完整的修复 shell 脚本
3. 对不安全的命令给出替代方案
4. 脚本开头加上 #!/bin/bash 和 set -e

输出格式：直接输出可执行的 shell 脚本内容，不要多余解释。`;

          const userPrompt = `以下分类需要修复: ${categories.join(', ')}

需要执行的修复命令:
${commands.map((c, i) => (i + 1) + '. ' + c).join('\n')}

请生成一个完整的修复脚本。`;

          const aiResult = await callLLM(userPrompt, systemPrompt, null);

          const scriptPath = path.join(os.homedir(), '.openclaw', 'tmp', 'ai-fix-' + Date.now() + '.sh');
          try {
            if (!fileExists(path.dirname(scriptPath))) {
              fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
            }
            let scriptContent = aiResult;
            if (!scriptContent.startsWith('#!')) {
              scriptContent = '#!/bin/bash\nset -e\n\n' + scriptContent;
            }
            fs.writeFileSync(scriptPath, scriptContent);
            execQuiet(`chmod +x ${scriptPath}`);
          } catch {}

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            output: aiResult,
            scriptPath,
            results: [{ success: true, command: 'ai-generated-script' }],
            fixedAt: new Date().toISOString()
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  // 手动刷新缓存 API
  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    clearCache();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: '缓存已清除' }));
    return;
  }

  // 系统软件扫描 API
  if (req.method === 'GET' && url.pathname === '/api/system-software') {
    try {
      const result = scanSystemSoftware();
      const cacheAgeSeconds = _systemSoftwareCacheTime ? Math.max(0, Math.floor((Date.now() - _systemSoftwareCacheTime) / 1000)) : 0;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ...result,
        cacheTtlSeconds: Math.floor(SYSTEM_SOFTWARE_CACHE_TTL_MS / 1000),
        cacheAgeSeconds,
        cacheHit: cacheAgeSeconds > 0
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message, categories: {} }));
    }
    return;
  }

  // 系统资源
  if (req.method === 'GET' && url.pathname === '/api/system-resources') {
    try {
      const resources = getSystemResources();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...resources }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 健康检查
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.0.0', port: PORT, engine: 'auto-discovery' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not_found', path: req.url }));
  } catch (err) {
    console.error('[applist] Uncaught error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    }
  }
}

function healthFn() {
  return true;
}

process.on('unhandledRejection', (reason) => {
  console.error('[applist] Unhandled rejection:', reason);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[applist] v2.0 auto-discovery engine listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  handler,
  healthFn,
  capabilities: [],
};
