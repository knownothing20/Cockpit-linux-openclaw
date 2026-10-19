#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');
const { URL } = require('url');

const ROOT_DIR = process.env.OPENCLAW_ROOT || path.join(os.homedir(), '.openclaw');
const PROJECT_DIR = __dirname;
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const SOFTWARE_DIR = path.join(ROOT_DIR, 'software');
const SHARED_SKILLS_DIR = path.join(ROOT_DIR, 'shared-skills');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');
const SYNC_SCRIPT = path.join(ROOT_DIR, 'scripts', 'sync-ai-rules.sh');
const WATCH_SCRIPT = path.join(ROOT_DIR, 'scripts', 'watch-ai-rules.sh');
const SYSTEMD_SERVICE = 'openclaw-ai-rules-watcher.service';
const PORT = Number.parseInt(process.env.RULE_PANEL_PORT || process.env.WORKSPACE_RULE_PANEL_PORT || '7091', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function sendJson(res, data, statusCode = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function checkRootRuleFiles() {
  const ruleFiles = [
    'AI_INSTRUCTIONS.md',
    '.clinerules',
    'CLAUDE.md',
    '.cursorrules',
    '.windsurfrules',
    '.codex',
  ];

  return ruleFiles.map((name) => {
    const fullPath = path.join(ROOT_DIR, name);
    const st = statSafe(fullPath);
    return {
      name,
      path: fullPath,
      exists: Boolean(st && st.isFile()),
      size: st ? st.size : 0,
      mtime: st ? st.mtime.toISOString() : null,
    };
  });
}

function checkWorkspaceStructure() {
  const checks = [
    { key: 'policy', path: 'docs/WORKSPACE_FILE_POLICY.md', required: true },
    { key: 'scratchReadme', path: '_scratch/README.md', required: true },
    { key: 'trashReadme', path: '_trash/README.md', required: true },
    { key: 'hookScript', path: '.githooks/pre-commit', required: true },
    { key: 'hookReadme', path: '.githooks/README.md', required: true },
    { key: 'hookSetupScript', path: 'scripts/setup-git-hooks.sh', required: true },
    { key: 'docsDir', path: 'docs', required: true, dir: true },
    { key: 'scriptsDir', path: 'scripts', required: true, dir: true },
    { key: 'runtimeDir', path: 'runtime', required: true, dir: true },
    { key: 'softwareDir', path: 'software', required: true, dir: true },
  ];

  return checks.map((item) => {
    const fullPath = path.join(ROOT_DIR, item.path);
    const st = statSafe(fullPath);
    const ok = item.dir ? Boolean(st && st.isDirectory()) : Boolean(st && st.isFile());
    return {
      ...item,
      fullPath,
      ok,
      mtime: st ? st.mtime.toISOString() : null,
    };
  });
}

function checkHookQuick() {
  let hookPath = '';
  let hookPathError = null;
  try {
    hookPath = execFileSync('git', ['-C', ROOT_DIR, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    hookPathError = err.message;
  }

  const hookFile = path.join(ROOT_DIR, '.githooks', 'pre-commit');
  const hookSt = statSafe(hookFile);
  const executable = Boolean(hookSt && (hookSt.mode & 0o111));

  let syntaxOk = false;
  let syntaxError = null;
  try {
    execFileSync('bash', ['-n', hookFile], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    syntaxOk = true;
  } catch (err) {
    syntaxError = err.stderr || err.message;
  }

  return {
    hookPath,
    hookPathConfigured: hookPath === '.githooks',
    hookPathError,
    scriptExists: Boolean(hookSt && hookSt.isFile()),
    scriptExecutable: executable,
    syntaxOk,
    syntaxError,
  };
}

function runHookDeepProbe() {
  const probeName = `rule-panel-probe-${Date.now()}.txt`;
  const probePath = path.join(ROOT_DIR, probeName);
  const hookPath = path.join(ROOT_DIR, '.githooks', 'pre-commit');
  let blocked = false;
  let output = '';
  let pass = false;
  let error = null;

  try {
    fs.writeFileSync(probePath, 'probe\n', 'utf8');
    execFileSync('git', ['-C', ROOT_DIR, 'add', probeName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    try {
      execFileSync(hookPath, {
        cwd: ROOT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      blocked = false;
      output = 'Hook allowed commit unexpectedly.';
    } catch (err) {
      blocked = true;
      output = `${err.stdout || ''}${err.stderr || ''}`.trim();
    }

    pass = blocked && output.includes('[ROOT]') && output.includes(probeName);
  } catch (err) {
    error = err.message;
  } finally {
    try {
      execFileSync('git', ['-C', ROOT_DIR, 'restore', '--staged', probeName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch {
      // noop
    }
    try {
      fs.unlinkSync(probePath);
    } catch {
      // noop
    }
  }

  return {
    ran: true,
    blocked,
    pass,
    error,
    outputPreview: output.slice(0, 600),
  };
}

function listSoftwareProjects() {
  const entries = fs.readdirSync(SOFTWARE_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

const LEGACY_HASHES_FILE = path.join(ROOT_DIR, 'scripts', 'sync-ai-rules.legacy-sha256');
let legacyManagedHashesCache = null;
function legacyManagedHashes() {
  // 「上一代无标记管理副本」的内容指纹清单 —— 与 sync-ai-rules.sh 共用同一文件（单一事实源）。
  if (legacyManagedHashesCache) return legacyManagedHashesCache;
  legacyManagedHashesCache = new Set(
    readFileSafe(LEGACY_HASHES_FILE)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{64}$/.test(l)),
  );
  return legacyManagedHashesCache;
}

function checkRuleFilesInDir(dirPath, rootRulesReady) {
  // 子目录里的 5 个「入口副本」（不含 AI_INSTRUCTIONS.md —— 它是只存在于根的权威源，
  // 不参与同步；根规则文件共 6 个 = 权威源 + 5 入口副本，两处计数口径因此不同，属预期）。
  const ruleEntryFiles = ['.clinerules', '.cursorrules', '.windsurfrules', 'CLAUDE.md', '.codex'];
  const present = ruleEntryFiles.filter((f) => exists(path.join(dirPath, f)));
  const allPresent = present.length === ruleEntryFiles.length;
  // 入口状态三态，全部按**内容**判定（mtime 判据已废弃 —— cp -f 会让副本 mtime 恒新于根，
  // 旧判据 40/40 恒 true、零信息量）：
  // - in-sync：与根规则源一致；
  // - stale  ：与根不同，但属于「管理副本」（含 managed-by 标记，或命中上一代副本指纹）
  //           → 待下次 sync 收敛，sync 会覆盖它；
  // - custom ：与根不同，且不是管理副本 → 刻意的项目级定制（sync 永不覆盖）。
  // hasLocalOverride 只表达 custom；stale 走 hasStaleEntries。
  let hasCustomOverride = false;
  let hasStaleEntries = false;
  for (const f of ruleEntryFiles) {
    const fp = path.join(dirPath, f);
    const st = statSafe(fp);
    if (!st || !st.isFile()) continue;
    const rootFp = path.join(ROOT_DIR, f);
    const rootSt = statSafe(rootFp);
    if (!rootSt || !rootSt.isFile()) continue;
    const content = readFileSafe(fp);
    if (st.size === rootSt.size && content === readFileSafe(rootFp)) continue;
    const managed = content.includes('managed-by: sync-ai-rules')
      || legacyManagedHashes().has(crypto.createHash('sha256').update(content).digest('hex'));
    if (managed) hasStaleEntries = true;
    else hasCustomOverride = true;
  }
  return {
    path: dirPath,
    ruleEntriesPresent: present.length,
    ruleEntriesTotal: ruleEntryFiles.length,
    allRuleEntriesPresent: allPresent,
    hasLocalOverride: hasCustomOverride,
    hasStaleEntries,
    inheritsRootRules: rootRulesReady,
    effectiveRules: allPresent || hasCustomOverride,
  };
}

// 被 git ignore 的子目录（如 software/data/ 这类运行期数据目录）不是项目：
// 它们不参与版本管理，也不该被要求交 README/WHITEPAPER/CHANGELOG 三件套。
// 用 `git check-ignore --stdin` 一次批量判定；无 git / 非仓库时安全降级为「不排除任何目录」。
function findIgnoredDirs(parentDir, names) {
  if (names.length === 0) return new Set();
  const rel = names.map((n) => path.relative(ROOT_DIR, path.join(parentDir, n)));
  let out = '';
  try {
    out = execFileSync('git', ['-C', ROOT_DIR, 'check-ignore', '--stdin'], {
      input: rel.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch (err) {
    // 「一条都没被忽略」时 git 以退出码 1 结束（输出为空），属正常情况而非错误。
    out = err && typeof err.stdout === 'string' ? err.stdout : '';
  }
  const ignored = new Set(
    String(out).split('\n').map((s) => s.trim()).filter(Boolean).map((p) => p.replace(/^\.\//, ''))
  );
  return new Set(names.filter((n, i) => ignored.has(rel[i]) || ignored.has(n)));
}

function scanSubProjects(dir, label, rootRulesReady) {
  if (!exists(dir)) return { projects: [], excluded: [] };
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // 先收齐候选目录名，才能把 gitignore 判定压成一次调用。
  const candidates = [];
  for (const entry of entries) {
    // `_` / `.` 前缀目录（__pycache__、_shared-mcp 等）是内部/缓存目录，不是项目。
    // 旧判据只排 `.` 前缀，导致 shared-skills/__pycache__ 被当成「缺文档的项目」列出。
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const base = path.join(dir, entry.name);
    // 符号链接指向的目录也算项目：skills/ 下全是 symlink（如 agently-mail -> ../../.agents/...），
    // 旧判据 entry.isDirectory() 对 symlink 恒 false，导致 skills 分类永远为空且静默不报。
    const linkStat = entry.isSymbolicLink() ? statSafe(base) : null;
    if (entry.isDirectory() || Boolean(linkStat && linkStat.isDirectory())) candidates.push(entry.name);
  }
  const ignored = findIgnoredDirs(dir, candidates);

  const result = [];
  const excluded = [];
  for (const name of candidates) {
    const base = path.join(dir, name);
    if (ignored.has(name)) {
      // 运行期数据目录（如 software/data：含 app.sqlite/credentials.json，被 software/.gitignore
      // 的 `data/` 排除）不参与文档检查 —— 往里塞 README 反而会污染不受版本管理的目录。
      excluded.push({ project: name, label, path: base, reason: 'gitignored' });
      continue;
    }
    const ruleCheck = checkRuleFilesInDir(base, rootRulesReady);
    const hasReadme = exists(path.join(base, 'README.md'));
    const hasWhitepaper = exists(path.join(base, 'WHITEPAPER.md'));
    const hasChangelog = exists(path.join(base, 'changelog.md')) || exists(path.join(base, 'CHANGELOG.md'));
    const hasDocs = exists(path.join(base, 'docs'));
    const hasSkillMd = exists(path.join(base, 'SKILL.md'));
    const localRuleFiles = ['.clinerules', 'CLAUDE.md', 'AGENTS.md', 'AI_INSTRUCTIONS.md'];
    const localRules = localRuleFiles.filter((f) => exists(path.join(base, f)));
    // 缺文档口径按目标类型分级（与 AI_INSTRUCTIONS.md §2 的语义分层一致）：
    // - software       = 软件项目 → 要求 README / WHITEPAPER / CHANGELOG 三件套；
    // - shared-skills  = Skill 包 → 规范文档是 SKILL.md（非技能目录至少要有 README），
    // - skills            不再要求白皮书三件套。旧口径对 36 个技能目录也要三件套，
    //   制造 39/40（97.5%）的纯噪音，且不进 checks，健康度信号因此失效。
    const missing = [];
    if (label === 'software') {
      if (!hasChangelog) missing.push('changelog');
      if (!hasWhitepaper) missing.push('WHITEPAPER');
      if (!hasReadme) missing.push('README');
    } else if (!hasSkillMd && !hasReadme) {
      missing.push('SKILL.md');
    }
    result.push({
      project: name,
      label,
      path: base,
      ...ruleCheck,
      localRules,
      localRuleConfigured: localRules.length > 0,
      hasDocs,
      hasReadme,
      hasWhitepaper,
      hasChangelog,
      hasSkillMd,
      missing,
    });
  }
  return {
    projects: result.sort((a, b) => a.project.localeCompare(b.project)),
    excluded: excluded.sort((a, b) => a.project.localeCompare(b.project)),
  };
}

function checkProjects(rootRulesReady) {
  const projects = [];
  const excluded = [];
  for (const [dir, label] of [[SOFTWARE_DIR, 'software'], [SHARED_SKILLS_DIR, 'shared-skills'], [SKILLS_DIR, 'skills']]) {
    const scanned = scanSubProjects(dir, label, rootRulesReady);
    projects.push(...scanned.projects);
    excluded.push(...scanned.excluded);
  }
  return { projects, excluded };
}

function checkRequiredReading() {
  // AI_INSTRUCTIONS.md §1 声明的「进入 OpenClaw 任务前必须读取」清单。
  // 面板此前只检查其中 1 个（AI_INSTRUCTIONS.md 自己），其余 4 个缺了也看不见。
  const userRoot = path.dirname(ROOT_DIR);
  const files = [
    path.join(userRoot, 'AGENTS.md'),
    path.join(userRoot, 'ENVIRONMENT.md'),
    path.join(ROOT_DIR, 'AGENTS.md'),
    path.join(ROOT_DIR, 'AI_INSTRUCTIONS.md'),
    path.join(ROOT_DIR, 'docs', 'SHARED-RULES.md'),
  ];
  return files.map((f) => {
    const st = statSafe(f);
    return {
      path: f,
      exists: Boolean(st && st.isFile()),
      size: st ? st.size : 0,
      mtime: st ? st.mtime.toISOString() : null,
    };
  });
}

function checkSyncStatus() {
  const syncScriptExists = exists(SYNC_SCRIPT);
  const watchScriptExists = exists(WATCH_SCRIPT);

  let systemdActive = false;
  let systemdEnabled = false;
  let systemdError = null;
  try {
    const statusOut = execFileSync('systemctl', ['is-active', SYSTEMD_SERVICE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    systemdActive = statusOut === 'active';
  } catch (err) {
    systemdError = (err.stderr || err.stdout || err.message || '').toString().trim();
  }
  try {
    const enabledOut = execFileSync('systemctl', ['is-enabled', SYSTEMD_SERVICE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    systemdEnabled = enabledOut === 'enabled';
  } catch {
    // ignore
  }

  let inotifyRunning = false;
  let inotifyPid = null;
  try {
    const pgrepOut = execFileSync('pgrep', ['-f', 'inotifywait.*openclaw.*software'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    inotifyRunning = Boolean(pgrepOut);
    inotifyPid = pgrepOut ? parseInt(pgrepOut.split('\n')[0], 10) : null;
  } catch {
    // ignore
  }

  let lastSyncLog = '';
  try {
    lastSyncLog = execFileSync('tail', ['-n', '20', '/tmp/sync-ai-rules.log'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    // ignore
  }

  const rootDirs = [
    { name: 'software', path: SOFTWARE_DIR },
    { name: 'shared-skills', path: SHARED_SKILLS_DIR },
    { name: 'skills', path: SKILLS_DIR },
  ];
  const rootDirRules = rootDirs.map((d) => {
    const rc = checkRuleFilesInDir(d.path, true);
    return { name: d.name, path: d.path, ...rc };
  });

  return {
    syncScriptExists,
    watchScriptExists,
    systemdActive,
    systemdEnabled,
    systemdError,
    inotifyRunning,
    inotifyPid,
    lastSyncLog,
    rootDirRules,
  };
}

function triggerSync() {
  let output = '';
  let error = null;
  let exitCode = 0;
  try {
    output = execSync(`bash "${SYNC_SCRIPT}"`, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    error = (err.stderr || err.stdout || err.message || '').toString().trim();
    exitCode = err.status || 1;
  }
  return { output: output.trim(), error, exitCode, triggeredAt: new Date().toISOString() };
}

// --- Project bootstrap & AI prompt helpers ---

function inferProjectInfo(projectPath) {
  const name = path.basename(projectPath);
  let displayName = name;
  let description = '';
  let techStack = [];
  let installCmd = '';
  let startCmd = '';

  // Try package.json
  const pkgPath = path.join(projectPath, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      displayName = pkg.name || name;
      description = pkg.description || '';
      const deps = Object.keys(pkg.dependencies || {});
      if (deps.length) techStack.push(`npm: ${deps.slice(0, 5).join(', ')}`);
      if (pkg.scripts?.install || pkg.scripts?.postinstall) installCmd = 'npm install';
      if (pkg.scripts?.start) startCmd = 'npm run start';
    } catch { /* ignore */ }
  }

  // Try Python requirements or main py file
  const pyFiles = fs.readdirSync(projectPath, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.py'))
    .map((e) => e.name);
  if (pyFiles.length) {
    techStack.push(`Python`);
    if (!installCmd) installCmd = 'pip install -r requirements.txt (if exists)';
    if (!startCmd) startCmd = `python3 ${pyFiles[0]}`;
  }

  // Try config.json for display name
  const cfgPath = path.join(projectPath, 'config.json');
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      displayName = cfg.displayName || cfg.name || displayName;
      description = cfg.description || description;
    } catch { /* ignore */ }
  }

  // Directory tree (max depth 2)
  let tree = '';
  try {
    tree = execFileSync('find', [projectPath, '-maxdepth', '2', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/__pycache__/*', '-printf', '%P\n'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).trim().split('\n').filter((l) => l).slice(0, 30).join('\n');
  } catch {
    tree = '(unable to list)';
  }

  // List files
  let files = '';
  try {
    files = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .join(', ');
  } catch { files = ''; }

  return { name, displayName, description, techStack, installCmd, startCmd, tree, files };
}

function bootstrapProject(projectPath, types) {
  const info = inferProjectInfo(projectPath);
  const results = [];
  const now = new Date().toISOString().split('T')[0];

  for (const type of types) {
    const target = path.join(projectPath, type === 'CHANGELOG' ? 'CHANGELOG.md' : `${type}.md`);
    if (exists(target)) {
      results.push({ type, path: target, created: false, reason: 'already exists' });
      continue;
    }

    let content = '';
    if (type === 'README') {
      content = `# ${info.displayName}\n\n> ${info.description || '项目说明待补充'}\n\n## 项目路径\n\n\`${projectPath}\`\n\n## 目录结构\n\n\`\`\`\n${info.tree}\n\`\`\`\n\n## 技术栈\n\n${info.techStack.length ? info.techStack.join('\\n') : '待补充'}\n\n## 安装与运行\n\n\`\`\`bash\n${info.installCmd || '# 安装命令待补充'}\n${info.startCmd || '# 启动命令待补充'}\n\`\`\`\n\n## 说明\n\n本文件由 workspace-rule-panel 自动补齐生成。请根据实际情况补充详细内容。\n`;
    } else if (type === 'WHITEPAPER') {
      content = `# ${info.displayName} 白皮书\n\n## 概述\n\n${info.description || `${info.displayName} 的架构与功能说明。`}\n\n## 架构\n\n${info.displayName} 的主要模块与职责如下：\n\n\`\`\`\n${info.tree}\n\`\`\`\n\n## 接口 / 配置\n\n待补充：主要 API、配置项、环境变量。\n\n## 状态机 / 数据流\n\n待补充：核心业务流程、状态转换、数据流向。\n\n## 说明\n\n本文件由 workspace-rule-panel 自动补齐生成。请根据实际情况补充详细内容。\n`;
    } else if (type === 'CHANGELOG') {
      content = `# Changelog\n\n所有 notable changes 将记录在此文件中。\n\n格式基于 [Keep a Changelog](https://keepachangelog.com/)，\n版本号遵循 [Semantic Versioning](https://semver.org/)。\n\n## [Unreleased]\n\n### Added\n- 项目初始化\n- 自动生成 CHANGELOG（${now}）\n\n## 说明\n\n本文件由 workspace-rule-panel 自动补齐生成。请根据实际变更记录补充内容。\n`;
    }

    try {
      fs.writeFileSync(target, content, 'utf8');
      results.push({ type, path: target, created: true, reason: 'bootstrapped' });
    } catch (err) {
      results.push({ type, path: target, created: false, reason: err.message });
    }
  }

  return { projectPath, results, generatedAt: new Date().toISOString() };
}

function generatePrompt(projectName, label, projectPath, types) {
  const info = inferProjectInfo(projectPath);
  const rootRulesHint = exists(path.join(ROOT_DIR, 'AI_INSTRUCTIONS.md'))
    ? `远程开发必须遵循 ${ROOT_DIR}/AI_INSTRUCTIONS.md 的 Pure Remote Mode 规则。`
    : '';

  const prompt = `你是 AI 开发助手，正在协助远程开发环境 ${ROOT_DIR} 下的项目。

## 任务
请为以下项目生成缺失的文档文件。
${rootRulesHint}

## 项目信息
- 名称：${info.displayName}
- 路径：${projectPath}
- 来源分类：${label}
- 现有文件：${info.files || '(空)'}
- 目录结构（maxdepth 2）：

\`\`\`
${info.tree}
\`\`\`

- 技术栈推断：${info.techStack.length ? info.techStack.join('；') : '未知'}

## 需要生成的文档类型
${types.map((t) => `- ${t}.md`).join('\n')}

## 各文档要求

### README.md
1. 项目一句话简介（基于现有代码推断，不要编造）
2. 项目路径与技术栈
3. 目录结构说明
4. 安装与运行命令（如 package.json 中有 scripts，直接引用）
5. 如有 API 服务，列出主要端点

### WHITEPAPER.md
1. 项目概述与目标
2. 架构图或模块说明（基于现有文件推断）
3. 核心接口 / 配置项
4. 状态机或数据流（如适用）
5. 与其他模块的依赖关系

### CHANGELOG.md
1. Keep a Changelog 格式
2. 初始版本记录，包含项目创建日期
3. 列出目前已有的主要功能（基于代码推断）

## 重要约束
1. 不要编造不存在的功能、接口或 API
2. 内容基于现有代码和文件结构进行合理推断
3. 使用 remote_write 工具写入远程文件
4. 写入路径：${projectPath}/<文档名>.md
5. 写入后使用 remote_bash 执行 git status 检查变更
6. 遵循 AI_INSTRUCTIONS.md 的安全规则（只读分析 -> 用户确认 -> 写入）

## 输出格式
请先以 Markdown 代码块形式展示每个要生成的文档内容，供我确认。
确认后，再执行 remote_write 写入远程。
`;

  return prompt;
}

function buildReport(mode = 'quick') {
  const rootRules = checkRootRuleFiles();
  const rootRulesReady = rootRules.every((item) => item.exists);
  const structure = checkWorkspaceStructure();
  const hookQuick = checkHookQuick();
  const { projects, excluded } = checkProjects(rootRulesReady);
  const syncStatus = checkSyncStatus();
  const requiredReading = checkRequiredReading();
  const deepHook = mode === 'deep' ? runHookDeepProbe() : { ran: false };

  const projectsMissingDocs = projects.filter((p) => p.missing.length > 0).length;
  const projectsMissingRules = projects.filter((p) => !p.allRuleEntriesPresent).length;

  const checks = [];
  checks.push({ name: 'root_rules_files', ok: rootRulesReady });
  checks.push({ name: 'required_reading', ok: requiredReading.every((f) => f.exists) });
  checks.push({ name: 'workspace_structure', ok: structure.every((i) => i.ok || !i.required) });
  checks.push({ name: 'hook_path', ok: hookQuick.hookPathConfigured });
  checks.push({ name: 'hook_script', ok: hookQuick.scriptExists && hookQuick.scriptExecutable && hookQuick.syntaxOk });
  checks.push({ name: 'sync_script', ok: syncStatus.syncScriptExists });
  checks.push({ name: 'watch_script', ok: syncStatus.watchScriptExists });
  checks.push({ name: 'systemd_service', ok: syncStatus.systemdActive });
  checks.push({ name: 'inotify_watcher', ok: syncStatus.inotifyRunning });
  // 项目级汇总也纳入 overall：旧实现里「39/40 缺文档」不进 checks，
  // 面板在 97.5% 目标缺文档时仍显示总体 PASS —— 健康度信号失效。
  checks.push({ name: 'projects_rules_coverage', ok: projectsMissingRules === 0 });
  checks.push({ name: 'projects_documentation', ok: projectsMissingDocs === 0 });
  if (mode === 'deep') {
    checks.push({ name: 'hook_runtime_probe', ok: deepHook.pass === true });
  }

  const passCount = checks.filter((c) => c.ok).length;
  const failCount = checks.filter((c) => !c.ok).length;

  return {
    generatedAt: new Date().toISOString(),
    mode,
    summary: {
      overall: failCount === 0 ? 'pass' : 'fail',
      passCount,
      failCount,
      totalChecks: checks.length,
      projectCount: projects.length,
      projectsMissingDocs,
      projectsMissingRules,
    },
    checks,
    rootRules,
    requiredReading,
    structure,
    hooks: {
      quick: hookQuick,
      deep: deepHook,
    },
    projects,
    excluded,
    syncStatus,
  };
}

function serveStatic(reqPath, res) {
  const filePath = reqPath === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, reqPath.replace(/^\//, ''));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    sendJson(res, { error: 'Invalid path' }, 400);
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendJson(res, { error: 'Not found' }, 404);
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({ raw: body });
      }
    });
    req.on('error', (err) => reject(err));
  });
}

const server = http.createServer(async (req, res) => {
  handler(req, res);
});

async function handler(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname === '/health') {
    sendJson(res, { status: 'ok', service: 'workspace-rule-panel' });
    return;
  }

  if (urlObj.pathname === '/api/check') {
    const mode = urlObj.searchParams.get('mode') === 'deep' ? 'deep' : 'quick';
    try {
      const report = buildReport(mode);
      sendJson(res, report);
    } catch (err) {
      sendJson(res, { error: err.message, stack: err.stack }, 500);
    }
    return;
  }

  if (urlObj.pathname === '/api/sync/status') {
    try {
      sendJson(res, checkSyncStatus());
    } catch (err) {
      sendJson(res, { error: err.message, stack: err.stack }, 500);
    }
    return;
  }

  if (urlObj.pathname === '/api/sync/trigger' && req.method === 'POST') {
    try {
      const result = triggerSync();
      sendJson(res, result);
    } catch (err) {
      sendJson(res, { error: err.message, stack: err.stack }, 500);
    }
    return;
  }

  if (urlObj.pathname === '/api/projects/bootstrap' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const { project, label, types } = body || {};
      if (!project || !label || !Array.isArray(types) || types.length === 0) {
        sendJson(res, { error: 'Missing project, label or types' }, 400);
        return;
      }
      // 只放行有模板的三类文档 —— 其他 type（如 SKILL.md）会被 bootstrapProject
      // 以空内容写成空文件，属于静默破坏。
      const ALLOWED_TYPES = ['README', 'WHITEPAPER', 'CHANGELOG'];
      const safeTypes = types.filter((t) => ALLOWED_TYPES.includes(t));
      if (safeTypes.length === 0) {
        sendJson(res, { error: `No supported doc types (allowed: ${ALLOWED_TYPES.join(', ')})` }, 400);
        return;
      }
      const dirMap = { software: SOFTWARE_DIR, 'shared-skills': SHARED_SKILLS_DIR, skills: SKILLS_DIR };
      const baseDir = dirMap[label];
      if (!baseDir) {
        sendJson(res, { error: `Unknown label: ${label}` }, 400);
        return;
      }
      const projectPath = path.join(baseDir, project);
      if (!exists(projectPath)) {
        sendJson(res, { error: 'Project not found' }, 404);
        return;
      }
      const result = bootstrapProject(projectPath, safeTypes);
      sendJson(res, result);
    } catch (err) {
      sendJson(res, { error: err.message, stack: err.stack }, 500);
    }
    return;
  }

  const promptMatch = urlObj.pathname.match(/^\/api\/projects\/([^/]+)\/([^/]+)\/prompt$/);
  if (promptMatch && req.method === 'GET') {
    try {
      const project = decodeURIComponent(promptMatch[1]);
      const label = decodeURIComponent(promptMatch[2]);
      const dirMap = { software: SOFTWARE_DIR, 'shared-skills': SHARED_SKILLS_DIR, skills: SKILLS_DIR };
      const baseDir = dirMap[label];
      if (!baseDir) {
        sendJson(res, { error: `Unknown label: ${label}` }, 400);
        return;
      }
      const projectPath = path.join(baseDir, project);
      if (!exists(projectPath)) {
        sendJson(res, { error: 'Project not found' }, 404);
        return;
      }
      const types = urlObj.searchParams.get('types')?.split(',')?.filter(Boolean) || ['README', 'WHITEPAPER', 'CHANGELOG'];
      const prompt = generatePrompt(project, label, projectPath, types);
      sendJson(res, { project, label, types, prompt });
    } catch (err) {
      sendJson(res, { error: err.message, stack: err.stack }, 500);
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(urlObj.pathname, res);
    return;
  }

  sendJson(res, { error: 'Method not allowed' }, 405);
}

function healthFn() {
  return true;
}

process.on('unhandledRejection', (reason) => {
  console.error('[workspace-rule-panel] Unhandled rejection:', reason);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`workspace-rule-panel listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  handler,
  healthFn,
  capabilities: [],
  // 保留既有工具函数导出（向后兼容）
  buildReport,
  runHookDeepProbe,
  bootstrapProject,
  generatePrompt,
};