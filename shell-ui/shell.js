let modules = [];
let health = {};
let dashboardData = null;
// v2.3.126: 仪表盘加载状态机 —— 修掉"永久卡在正在加载"。
// 旧实现 showDashboard() 只肯用缓存, 若首次加载从未成功(例如初始落在模块路由,
// loadDashboard 里的 `if (currentModule) return` 直接短路), 就永远只剩 loading 文案,
// 既不重试也不报错。现在改为显式状态 + 主动补拉 + 失败可重试。
let _dashState = 'idle'; // idle | loading | ready | error
let _dashReqId = 0;      // 单调递增请求号, 丢弃过期响应, 防并发覆盖
let _dashError = null;
let currentModule = null;
let currentTheme = 'dark';
let currentSkin = 'ops';
let currentDensity = 'comfortable';
let currentMotion = 'standard';
const SHELL_POLISH_VERSION = '20261010-fm-docs-real-pct';
// 仪表盘首次全量刷新实测约 2.6s, 留足余量; 超时后进入可重试的 error 态, 不再无限转圈
const DASHBOARD_TIMEOUT_MS = 20000;
// 模块页面实测 2~10ms 就返回；给 12s 只是兜住"服务端无响应/导航被丢弃"这类异常，
// 超时后渲染可重试的错误面板，而不是让用户盯着一片白。
const MODULE_LOAD_TIMEOUT_MS = 12000;

const DESIGN_STORAGE_KEYS = {
  skin: 'openclaw-cockpit-skin',
  density: 'openclaw-cockpit-density',
  motion: 'openclaw-cockpit-motion',
};

const DESIGN_OPTIONS = {
  skin: new Set(['ops', 'glass']),
  density: new Set(['comfortable', 'compact']),
  motion: new Set(['standard', 'reduced']),
};

const PROFILE_STORAGE_KEY = 'openclaw-profile';
const LEGACY_THEME_STORAGE_KEY = 'openclaw-theme';
const VALID_PROFILES = new Set(['openclaw', 'hermes']);

function getActiveProfile() {
  try {
    const profile = window.ProfileSwitcher && typeof ProfileSwitcher.getProfile === 'function'
      ? ProfileSwitcher.getProfile()
      : localStorage.getItem(PROFILE_STORAGE_KEY);
    return VALID_PROFILES.has(profile) ? profile : 'openclaw';
  } catch (e) {
    return 'openclaw';
  }
}

function getThemeStorageKey(profile = getActiveProfile()) {
  return `${LEGACY_THEME_STORAGE_KEY}:${VALID_PROFILES.has(profile) ? profile : 'openclaw'}`;
}

function getStoredTheme(profile = getActiveProfile()) {
  const saved = localStorage.getItem(getThemeStorageKey(profile)) || localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : null;
}

function persistTheme(theme, profile = getActiveProfile()) {
  if (theme !== 'light' && theme !== 'dark') return;
  localStorage.setItem(getThemeStorageKey(profile), theme);
  localStorage.setItem(LEGACY_THEME_STORAGE_KEY, theme);
}


function setShellModuleView(isModuleView) {
  document.body.classList.toggle('shell-module-view', !!isModuleView);
  const moduleTitle = document.getElementById('module-title');
  if (!moduleTitle) return;
  if (isModuleView) {
    moduleTitle.setAttribute('aria-hidden', 'true');
    moduleTitle.style.setProperty('display', 'none', 'important');
    moduleTitle.style.setProperty('visibility', 'hidden', 'important');
    moduleTitle.style.setProperty('width', '0', 'important');
    moduleTitle.style.setProperty('margin', '0', 'important');
    moduleTitle.style.setProperty('padding', '0', 'important');
    return;
  }
  moduleTitle.removeAttribute('aria-hidden');
  moduleTitle.style.removeProperty('display');
  moduleTitle.style.removeProperty('visibility');
  moduleTitle.style.removeProperty('width');
  moduleTitle.style.removeProperty('margin');
  moduleTitle.style.removeProperty('padding');
}

function isNestedShell() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

function initTheme() {
  const saved = getStoredTheme();
  if (saved) {
    currentTheme = saved;
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    currentTheme = 'light';
  }
  applyTheme(currentTheme);

  document.getElementById('theme-toggle').addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    persistTheme(currentTheme);
    broadcastTheme(currentTheme);
    broadcastDesignSystem();
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  applyDesignSystemAttributes();
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? '&#9790;' : '&#9788;';
    btn.title = theme === 'dark' ? I18n.t('theme.switchLight') : I18n.t('theme.switchDark');
  }
}

function getStoredOption(key, fallback) {
  const value = localStorage.getItem(DESIGN_STORAGE_KEYS[key]);
  return DESIGN_OPTIONS[key].has(value) ? value : fallback;
}

function initDesignSystem() {
  currentSkin = getStoredOption('skin', 'ops');
  currentDensity = getStoredOption('density', 'comfortable');
  currentMotion = getStoredOption('motion', 'standard');
  applyDesignSystemAttributes();
  broadcastDesignSystem();
}

function applyDesignSystemAttributes() {
  const root = document.documentElement;
  root.classList.add('cockpit-shell');
  root.setAttribute('data-oc-skin', currentSkin);
  root.setAttribute('data-oc-density', currentDensity);
  root.setAttribute('data-oc-motion', currentMotion);
}

function getDesignPayload() {
  return {
    type: 'openclaw-design',
    theme: currentTheme,
    skin: currentSkin,
    density: currentDensity,
    motion: currentMotion,
    profile: getActiveProfile(),
  };
}

function applyDesignPayload(payload = {}, persist = false) {
  if (payload.theme === 'dark' || payload.theme === 'light') currentTheme = payload.theme;
  if (DESIGN_OPTIONS.skin.has(payload.skin)) currentSkin = payload.skin;
  if (DESIGN_OPTIONS.density.has(payload.density)) currentDensity = payload.density;
  if (DESIGN_OPTIONS.motion.has(payload.motion)) currentMotion = payload.motion;
  applyTheme(currentTheme);
  applyDesignSystemAttributes();
  if (persist) {
    persistTheme(currentTheme, payload.profile);
    localStorage.setItem(DESIGN_STORAGE_KEYS.skin, currentSkin);
    localStorage.setItem(DESIGN_STORAGE_KEYS.density, currentDensity);
    localStorage.setItem(DESIGN_STORAGE_KEYS.motion, currentMotion);
  }
}

function broadcastTheme(theme, profile = getActiveProfile()) {
  const msg = { type: 'openclaw-theme', theme: theme, profile: profile };
  const origin = window.location.origin;
  const frames = document.querySelectorAll('.module-frame');
  frames.forEach(f => {
    try { f.contentWindow.postMessage(msg, origin); } catch(e) {}
  });
}

function broadcastDesignSystem() {
  const msg = getDesignPayload();
  const origin = window.location.origin;
  const frames = document.querySelectorAll('.module-frame');
  frames.forEach(f => {
    try {
      f.contentWindow.postMessage(msg, origin);
      if (f.contentDocument && f.contentDocument.documentElement) {
        const root = f.contentDocument.documentElement;
        root.classList.add('cockpit-embedded-module');
        root.setAttribute('data-theme', msg.theme);
        root.setAttribute('data-oc-skin', msg.skin);
        root.setAttribute('data-oc-density', msg.density);
        root.setAttribute('data-oc-motion', msg.motion);
      }
    } catch(e) {}
  });
}

function broadcastProfile(profile) {
  const msg = { type: 'openclaw-profile', profile: profile };
  const origin = window.location.origin;
  const frames = document.querySelectorAll('.module-frame');
  frames.forEach(f => {
    try { f.contentWindow.postMessage(msg, origin); } catch(e) {}
  });
}

function respondToThemeRequest(targetWindow, origin) {
  if (!targetWindow) return;
  const targetOrigin = origin && origin !== 'null' ? origin : window.location.origin;
  try {
    targetWindow.postMessage({ type: 'openclaw-theme', theme: currentTheme, profile: getActiveProfile() }, targetOrigin);
    targetWindow.postMessage(getDesignPayload(), targetOrigin);
  } catch (e) {}
}

function listenForThemeSync() {
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'openclaw-theme-request') {
      respondToThemeRequest(e.source, e.origin);
      return;
    }
    if (e.data && e.data.type === 'openclaw-theme') {
      const theme = e.data.theme;
      if (theme === 'dark' || theme === 'light') {
        currentTheme = theme;
        applyTheme(theme);
        persistTheme(theme, e.data.profile);
        broadcastTheme(theme, e.data.profile);
        broadcastDesignSystem();
      }
    }
    if (e.data && e.data.type === 'openclaw-design') {
      applyDesignPayload(e.data, true);
      broadcastDesignSystem();
    }
    if (e.data && e.data.type === 'openclaw-memory-lang-toggle') {
      const btn = document.getElementById('lang-toggle');
      if (btn) btn.click();
    }
  });
}

function initProfileThemeSync() {
  document.addEventListener('profile-change', (event) => {
    const profile = event.detail && event.detail.profile;
    if (!VALID_PROFILES.has(profile)) return;
    currentTheme = getStoredTheme(profile) || currentTheme;
    applyTheme(currentTheme);
    persistTheme(currentTheme, profile);
    broadcastTheme(currentTheme, profile);
    broadcastDesignSystem();
  });
}

function initLangToggle() {
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  updateLangToggleLabel();
  btn.addEventListener('click', () => {
    I18n.toggleLang();
    updateLangToggleLabel();
    refreshAllUI();
  });
}

let _refreshBtn = null;
let _isRefreshing = false;

function setRefreshSpinning(spinning) {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  btn.classList.toggle('spinning', spinning);
  btn.disabled = spinning;
  btn.title = spinning
    ? (I18n.t('action.refreshing') || '刷新中...')
    : (I18n.t('action.refresh') || '刷新数据');
}

async function refreshShellData() {
  if (_isRefreshing) return;
  _isRefreshing = true;
  setRefreshSpinning(true);
  try {
    await loadHealth();
    if (!currentModule) {
      await loadDashboard(true);
    }
  } catch (e) {
    console.error('Manual refresh failed:', e);
  } finally {
    _isRefreshing = false;
    setRefreshSpinning(false);
  }
}

function initRefreshButton() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  _refreshBtn = btn;
  btn.title = I18n.t('action.refresh') || '刷新数据';
  btn.addEventListener('click', refreshShellData);
}

function updateLangToggleLabel() {
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  const lang = I18n.getLang();
  btn.textContent = lang === 'zh' ? '中/En' : '中/En';
  btn.title = I18n.t('lang.switch');
}

function onLangChange(lang) {
  updateLangToggleLabel();
  refreshAllUI();
}

function refreshAllUI() {
  renderNav();
  updateStatusBar();
  if (currentModule) {
    updateModuleStatus(currentModule);
    const m = modules.find(x => x.id === currentModule);
    if (m) {
      document.getElementById('module-title').textContent = getModuleDisplayName(m);
    }
  } else {
    document.getElementById('module-title').textContent = I18n.t('nav.dashboard');
    renderDashboard();
  }
}

async function init() {
  if (isNestedShell()) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#94a3b8;background:#0f172a;">
        <div style="text-align:center;">
          <h2 style="color:#e2e8f0;margin-bottom:8px;">${I18n.t('module.failedLoad')}</h2>
          <p>${I18n.t('module.failedLoadDesc')}</p>
        </div>
      </div>
    `;
    return;
  }
  initTheme();
  initDesignSystem();
  initLangToggle();
  initRefreshButton();
  listenForThemeSync();
  initProfileThemeSync();

  const initialPath = window.location.pathname;
  const isModuleRoute = /^\/apps\/[^/]+/.test(initialPath);
  setShellModuleView(isModuleRoute);

  // v2.3.125: popstate 监听器必须在两种初始路径下都注册 ——
  // 否则从首页进入的用户用浏览器后退键从模块回到 / 时,
  // body.shell-module-view 不会被清除, 仪表盘会残留模块视图的细条 topbar.
  window.addEventListener('popstate', handleRoute);

  await loadModules();
  renderNav();
  updateStatusBar();

  if (isModuleRoute) {
    handleRoute();
  } else {
    if (!currentModule) showDashboard(false);
    handleRoute();
  }

  // v2.3.127: 首屏只读缓存快照，不再强制 refresh。
  // `/api/dashboard?refresh=true` 会在服务端同步调用 11 个模块的 handler，
  // 而模块是以 in-process 中间件跑的、handler 本身是同步的，服务端那个 1s
  // 超时根本抢不动它 —— 实测这一批能在事件循环上独占约 25s。而每次打开页面都会
  // 触发它：用户这时候点任意模块，模块 iframe 的 HTML 请求就排在后面，表现就是
  // "点开是白屏"。服务端本来就有 25ms 延迟的后台刷新 + 60s 端点缓存，
  // 首屏用缓存完全够；需要立刻刷新时用户点右上角的刷新按钮即可。
  loadHealth();
  loadDashboard(false).catch(() => {});
}

function handleRoute() {
  const path = window.location.pathname;
  const match = path.match(/^\/apps\/([^\/]+)/);
  if (match) {
    const moduleId = match[1];
    const m = modules.find(x => x.id === moduleId);
    if (m) {
      loadModule(moduleId, false);
    }
    return;
  }

  showDashboard(false);
}


async function loadModules() {
  try {
    const res = await fetch('/api/apps');
    modules = await res.json();
  } catch (e) {
    console.error('Failed to load modules:', e);
    modules = [];
  }
}

async function loadHealth() {
  try {
    const res = await fetch('/api/apps/health');
    const data = await res.json();
    health = {};
    for (const m of data.modules || []) {
      health[m.id] = m;
    }
    renderNav();
    updateStatusBar();
    if (currentModule) {
      updateModuleStatus(currentModule);
    }
  } catch (e) {
    console.error('Failed to load health:', e);
  }
}

async function loadDashboard(force = false) {
  // 注意: 这里不能再 `if (currentModule) return`。
  // 旧代码在「初始落在模块路由」时会让本函数直接短路, dashboardData 永远为 null,
  // 之后回到仪表盘就永久卡在 loading。现在改为照常拉取, 只在渲染阶段判断是否在前台。
  const reqId = ++_dashReqId;
  _dashState = 'loading';
  if (!dashboardData && !currentModule) renderDashboard();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DASHBOARD_TIMEOUT_MS);
  try {
    const url = force ? '/api/dashboard?refresh=true' : '/api/dashboard';
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (reqId !== _dashReqId) return; // 已有更新的请求在途, 丢弃本次结果
    dashboardData = data;
    _dashError = null;
    _dashState = 'ready';
  } catch (e) {
    if (reqId !== _dashReqId) return;
    _dashError = (e && e.name === 'AbortError')
      ? 'timeout'
      : ((e && e.message) ? e.message : 'unknown');
    _dashState = 'error';
    console.error('Failed to load dashboard:', e);
  } finally {
    clearTimeout(timer);
  }
  if (!currentModule) renderDashboard();
}

function retryDashboard() {
  _dashState = 'idle';
  _dashError = null;
  loadDashboard(true).catch(() => {});
}

function getNavSectionLabel(section) {
  return I18n.t('navSection.' + section);
}

function getModuleDisplayName(m) {
  const key = 'module.' + m.id;
  const translated = I18n.t(key);
  return translated !== key ? translated : m.displayName;
}

function showDashboard(pushState = true) {
  currentModule = null;
  setShellModuleView(false);

  if (pushState && window.location.pathname !== '/') {
    window.history.pushState({}, '', '/');
  }

  document.getElementById('module-title').textContent = I18n.t('nav.dashboard');
  // v2.3.123: topbar 不再渲染 module-status / system-status (信息已迁到 sidebar status-bar),
  // 保留对老版 DOM 的兼容, 元素不存在时直接跳过.
  const statusEl = document.getElementById('module-status');
  if (statusEl) {
    statusEl.className = 'module-status';
    const onlineCount = Object.values(health).filter(h => h.healthy === true).length;
    const totalCount = Object.keys(health).length;
    if (onlineCount === totalCount && totalCount > 0) {
      statusEl.classList.add('healthy');
      statusEl.textContent = I18n.t('status.online');
    } else {
      statusEl.textContent = onlineCount + ' ' + I18n.t('status.online');
    }
  }
  renderNav();
  // v2.3.126: 有缓存直接用缓存; 没缓存且没有在途请求就主动补拉一次。
  // 旧实现只肯用缓存, 一旦首次加载失败/被短路, 这里就永久停在 loading 文案上。
  if (dashboardData) {
    _dashState = 'ready';
    renderDashboard();
  } else {
    renderDashboard(); // 先绘制 loading 或 error 态
    if (_dashState !== 'loading') {
      loadDashboard(false).catch(() => {});
    }
  }
}


function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(n) {
  if (n === undefined || n === null) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function renderDashboard() {
  const content = document.getElementById('content');
  if (!dashboardData) {
    // v2.3.126: loading 与 error 分开渲染, 失败时给出可点击的重试入口, 不再无限转圈
    if (_dashState === 'error') {
      content.innerHTML =
        '<div class="dashboard"><div class="dashboard-error">' +
          '<div class="dashboard-error-title">' + I18n.t('dashboard.loadFailed') + '</div>' +
          '<div class="dashboard-error-desc">' + escapeHtmlText(_dashError || 'unknown') + '</div>' +
          '<button type="button" class="oc-btn oc-btn-md oc-btn-primary" id="dash-retry">' +
            I18n.t('dashboard.retry') +
          '</button>' +
        '</div></div>';
      const btn = document.getElementById('dash-retry');
      if (btn) btn.addEventListener('click', retryDashboard);
      return;
    }
    content.innerHTML = '<div class="dashboard"><div class="dashboard-loading">' + I18n.t('dashboard.loading') + '</div></div>';
    return;
  }

  const d = dashboardData;
  const healthData = d.health?.data || {};
  const aiStats = d.aiStats?.data || {};
  const modelsData = d.models?.data || {};
  const docsData = d.docs?.data || {};
  const rulesData = d.rules?.data || {};
  const sharesData = d.shares?.data || [];
  const skillsData = d.skills?.data || {};
  const configCenterData = d.configCenter?.data || {};
  const robotsData = d.robots?.data?.agents || [];

  const healthModules = healthData.modules || [];
  const onlineCount = healthModules.filter(m => m.healthy).length;
  const totalModules = healthModules.length;
  const offlineModules = healthModules.filter(m => !m.healthy);

  const summary = aiStats.summary || {};
  const providers = modelsData.providers || [];
  const totalModels = providers.reduce((sum, p) => sum + (p.models || []).length, 0);

  const docsTotal = docsData.total || 0;
  const softwareProjects = (docsData.software || []).length;

  const checks = rulesData.checks || [];
  const passCount = checks.filter(c => c.ok).length;
  const totalChecks = checks.length;
  const projectsMissingRules = (rulesData.summary || {}).projectsMissingRules || 0;

  const activeShares = Array.isArray(sharesData) ? sharesData.length : 0;
  const skillTotal = skillsData.total || 0;
  const cfgHealth = configCenterData.health_pct || 0;
  const agentCount = Array.isArray(robotsData) ? robotsData.length : 0;

  const overallStatus = onlineCount === totalModules ? 'healthy' : onlineCount > 0 ? 'degraded' : 'unhealthy';

  const sys = d.system?.data || {};
  const cpuPct = sys.cpu?.percent || 0;
  const memPct = sys.memory?.percent || 0;
  const diskPct = sys.disk?.percent || 0;

  function resourceStatusClass(pct) {
    return pct > 80 ? 'unhealthy' : pct > 50 ? 'degraded' : 'healthy';
  }

  const systemBar = `<div class="system-resources">
    <div class="resource-item">
      <span class="resource-icon">&#128187;</span>
      <div class="resource-info">
        <span class="resource-label">${I18n.t('dashboard.cpu')}</span>
        <span class="resource-value">${cpuPct}%</span>
      </div>
      <div class="resource-bar"><div class="resource-fill ${resourceStatusClass(cpuPct)}" style="width:${cpuPct}%"></div></div>
    </div>
    <div class="resource-item">
      <span class="resource-icon">&#128444;</span>
      <div class="resource-info">
        <span class="resource-label">${I18n.t('dashboard.memory')}</span>
        <span class="resource-value">${memPct}%</span>
      </div>
      <div class="resource-bar"><div class="resource-fill ${resourceStatusClass(memPct)}" style="width:${memPct}%"></div></div>
    </div>
    <div class="resource-item">
      <span class="resource-icon">&#128190;</span>
      <div class="resource-info">
        <span class="resource-label">${I18n.t('dashboard.disk')}</span>
        <span class="resource-value">${diskPct}%</span>
      </div>
      <div class="resource-bar"><div class="resource-fill ${resourceStatusClass(diskPct)}" style="width:${diskPct}%"></div></div>
    </div>
  </div>`;

  const summaryBar = `<div class="dashboard-summary">
    <div class="summary-item">
      <span class="summary-value status-${overallStatus}">${onlineCount}/${totalModules}</span>
      <span class="summary-label">${I18n.t('dashboard.modulesOnline')}</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${formatNumber(summary.todayTokens || 0)}</span>
      <span class="summary-label">${I18n.t('dashboard.tokensToday')}</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${skillTotal}</span>
      <span class="summary-label">${I18n.t('dashboard.skills')}</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${docsTotal}</span>
      <span class="summary-label">${I18n.t('dashboard.documents')}</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${agentCount}</span>
      <span class="summary-label">${I18n.t('dashboard.agents')}</span>
    </div>
  </div>`;

  function makeGroup(title, cards) {
    return `<div class="dashboard-group">
      <div class="group-title">${title}</div>
      <div class="dashboard-cards">${cards}</div>
    </div>`;
  }

  const cfgStatus = cfgHealth >= 90 ? 'healthy' : cfgHealth >= 60 ? 'degraded' : 'unhealthy';
  const cfgBarPct = Math.max(0, Math.min(100, cfgHealth));
  const cfgBarClass = cfgStatus;
  const systemCards =
    renderCard(I18n.t('card.services'), '&#9889;',
      I18n.t('card.servicesOnline', { online: onlineCount, total: totalModules }),
      overallStatus,
      healthModules.slice(0, 5).map(m =>
        `<div class="card-detail-row">
          <span>${m.id}</span>
          <span class="card-detail-actions">
            <span class="card-badge ${m.healthy ? 'badge-ok' : 'badge-fail'}">${m.healthy ? I18n.t('status.online') : I18n.t('status.offline')}</span>
            <button class="oc-btn oc-btn-sm oc-btn-secondary" onclick="event.stopPropagation();restartModule('${m.id}')">重启</button>
          </span>
        </div>`
      ).join('') + (totalModules > 5 ? `<div class="card-detail-row more" onclick="loadModule('applist')">${I18n.t('section.more', { count: totalModules - 5 })}</div>` : ''),
      'applist'
    ) +
    renderCard(I18n.t('card.config'), '&#128295;',
      I18n.t('card.configHealth', { pct: cfgHealth }),
      d.configCenter?.status === 'ok' ? cfgStatus : 'unavailable',
      `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:var(--oc-text-sm);color:var(--text-secondary);margin-bottom:4px"><span>${I18n.t('card.healthScore')}</span><span>${cfgHealth}%</span></div><div class="mini-progress"><div class="mini-progress-fill ${cfgBarClass}" style="width:${cfgBarPct}%"></div></div></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.backups')}</span><span>${configCenterData.backup_count || 0}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.todayChanges')}</span><span>${configCenterData.today_changes || 0}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.autoBackup')}</span><span class="card-badge ${configCenterData.auto_backup_enabled ? 'badge-ok' : 'badge-fail'}">${configCenterData.auto_backup_enabled ? I18n.t('card.on') : I18n.t('card.off')}</span></div>`,
      'config-recovery'
    ) +
    renderCard(I18n.t('card.rules'), '&#128737;',
      I18n.t('card.rulesPass', { pass: passCount, total: totalChecks }),
      passCount === totalChecks ? 'healthy' : passCount > 0 ? 'degraded' : 'unhealthy',
      `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:var(--oc-text-sm);color:var(--text-secondary);margin-bottom:4px"><span>${I18n.t('card.passRate')}</span><span>${totalChecks > 0 ? Math.round(passCount/totalChecks*100) : 0}%</span></div><div class="mini-progress"><div class="mini-progress-fill ${passCount === totalChecks ? 'healthy' : passCount > 0 ? 'degraded' : 'unhealthy'}" style="width:${totalChecks > 0 ? Math.round(passCount/totalChecks*100) : 0}%"></div></div></div>` +
      checks.slice(0, 3).map(c =>
        `<div class="card-detail-row"><span>${c.name}</span><span class="card-badge ${c.ok ? 'badge-ok' : 'badge-fail'}">${c.ok ? I18n.t('card.pass') : I18n.t('card.fail')}</span></div>`
      ).join('') +
      (projectsMissingRules > 0 ? `<div class="card-detail-row"><span>${I18n.t('card.missingRules', { count: projectsMissingRules })}</span><span class="card-badge badge-fail">${projectsMissingRules}</span></div>` : ''),
      'workspace-rule-panel'
    );

  const skillCategories = skillsData.categories || {};
  const topCats = Object.entries(skillCategories).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const intelCards =
    renderCard(I18n.t('card.aiModels'), '&#129302;',
      I18n.t('card.tokensTodayCount', { count: formatNumber(summary.todayTokens || 0) }),
      d.aiStats?.status === 'ok' ? 'healthy' : 'unavailable',
      `<div class="card-detail-row"><span>${I18n.t('card.messagesToday')}</span><span>${formatNumber(summary.todayMessages || 0)}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.weekTokens')}</span><span>${formatNumber(summary.weekTokens || 0)}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.avgResponse')}</span><span>${summary.avgResponseMs || 0}ms</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.providersModels')}</span><span>${providers.length} / ${totalModels}</span></div>`,
      'models-manager'
    ) +
    renderCard(I18n.t('card.skillsCard'), '&#129504;',
      I18n.t('card.skillsCount', { count: skillTotal }),
      d.skills?.status === 'ok' ? 'healthy' : 'unavailable',
      topCats.length > 0
        ? topCats.map(([cat, count]) => `<div class="card-detail-row"><span>${cat}</span><span>${count}</span></div>`).join('') +
          `<div class="card-detail-row"><span>${I18n.t('card.withMeta')}</span><span>${skillsData.withMeta || 0}</span></div>`
        : `<div class="card-detail-row"><span>${I18n.t('card.noSkillData')}</span></div>`,
      'skill-manager'
    );

  const toolsCards =
    renderCard(I18n.t('card.documents'), '&#128193;',
      I18n.t('card.docsProjects', { docs: docsTotal, projects: softwareProjects }),
      d.docs?.status === 'ok' ? 'healthy' : 'unavailable',
      `<div class="card-detail-row"><span>${I18n.t('card.mainDocs')}</span><span>${(docsData.mainDocs || {}).count || 0}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.memoryFiles')}</span><span>${(docsData.memory || {}).count || 0}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.sharedRules')}</span><span>${(docsData.sharedRules || {}).count || 0}</span></div>` +
      `<div class="card-detail-row"><span>${I18n.t('card.workspaces')}</span><span>${(docsData.workspaces || []).length}</span></div>`,
      'file-manager'
    ) +
    renderCard(I18n.t('card.shares'), '&#128279;',
      I18n.t('card.activeShares', { count: activeShares }),
      d.shares?.status === 'ok' ? 'healthy' : 'unavailable',
      Array.isArray(sharesData) && sharesData.length > 0
        ? sharesData.slice(0, 3).map(s => {
            const name = (s.path || '').split('/').pop();
            return `<div class="card-detail-row"><span>${name}</span><span class="card-badge badge-ok">${I18n.t('card.active')}</span></div>`;
          }).join('')
        : `<div class="card-detail-row"><span>${I18n.t('card.noActiveShares')}</span></div>`,
    ) +
    renderCard(I18n.t('card.robots'), '&#129302;',
      I18n.t('card.agentsCount', { count: agentCount }),
      d.robots?.status === 'ok' ? 'healthy' : 'unavailable',
      Array.isArray(robotsData) && robotsData.length > 0
        ? robotsData.slice(0, 4).map(a => {
            const name = (a.name || a.id || 'agent');
            const model = (a.model || '').split('/').pop();
            return `<div class="card-detail-row"><span>${name.substring(0, 18)}</span><span class="card-badge badge-ok">${model.substring(0, 12)}</span></div>`;
          }).join('')
        : `<div class="card-detail-row"><span>${I18n.t('card.noAgentData')}</span></div>`,
      'robots'
    );

  const topModels = (aiStats.models || []).slice(0, 5);
  let modelsBarHtml = '';
  if (topModels.length > 0) {
    const maxTokens = topModels[0]?.totalTokens || 1;
    modelsBarHtml = '<div class="dashboard-section"><h3>' + I18n.t('section.topModels') + '</h3><div class="models-bars">' +
      topModels.map(m => {
        const pct = Math.round((m.totalTokens / maxTokens) * 100);
        const label = (m.modelId || '').length > 24 ? (m.modelId || '').substring(0, 22) + '...' : m.modelId;
        return `<div class="model-bar-row">
          <span class="model-bar-label">${label}</span>
          <div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>
          <span class="model-bar-value">${formatNumber(m.totalTokens)}</span>
        </div>`;
      }).join('') +
      '</div></div>';
  }

  let offlineHtml = '';
  if (offlineModules.length > 0) {
    offlineHtml = '<div class="compact-offline"><h4>&#9888; ' + I18n.t('section.offlineModules') + '</h4>' +
      offlineModules.map(m => {
        const mod = modules.find(x => x.id === m.id);
        const port = mod ? extractPort(mod) : '-';
        return `<div class="compact-offline-row">
          <span>${m.id}</span>
          <span class="card-badge badge-fail">${I18n.t('status.offline')}</span>
          <span class="action-link" onclick="loadModule('${m.id}')">Open &rarr;</span>
        </div>`;
      }).join('') +
      '</div>';
  }

  content.innerHTML = `<div class="dashboard">
    ${systemBar}
    ${summaryBar}
    ${makeGroup(I18n.t('dashboard.groupSystem'), systemCards)}
    ${makeGroup(I18n.t('dashboard.groupIntelligence'), intelCards)}
    ${makeGroup(I18n.t('dashboard.groupTools'), toolsCards)}
    <div class="dashboard-bottom">${modelsBarHtml}${offlineHtml}</div>
    <div class="dashboard-footer">${I18n.t('dashboard.lastUpdated')}${d.cachedAt ? new Date(d.cachedAt).toLocaleString() : 'N/A'}</div>
  </div>`;
}

function extractPort(mod) {
  if (mod.integration === 'native') return 7001;
  const id = mod.id || '';
  const portMap = {};
  return portMap[id] || '-';
}

function renderCard(title, icon, subtitle, status, details, moduleId) {
  const clickAttr = moduleId ? ` onclick="loadModule('${moduleId}')" style="cursor:pointer;"` : '';
  return `<div class="dash-card" data-status="${status}"${clickAttr}>
    <div class="dash-card-header">
      <span class="dash-card-icon">${icon}</span>
      <div class="dash-card-title">
        <h3>${title}</h3>
        <p>${subtitle}</p>
      </div>
      <span class="dash-card-status status-${status}"></span>
    </div>
    <div class="dash-card-body">${details}</div>
  </div>`;
}

function getNavSections() {
  const sections = {};
  for (const m of modules) {
    if (m.showInNav === false) continue;
    const section = m.navSection || 'default';
    if (!sections[section]) sections[section] = [];
    sections[section].push(m);
  }
  return sections;
}

function renderNav() {
  const nav = document.getElementById('nav');
  const sections = getNavSections();
  nav.innerHTML = '';

  const dashItem = document.createElement('div');
  dashItem.className = 'nav-item' + (!currentModule ? ' active' : '');
  dashItem.onclick = () => {
    showDashboard();
  };
  const dashIcon = document.createElement('span');
  dashIcon.className = 'icon healthy';
  const dashName = document.createElement('span');
  dashName.className = 'name';
  dashName.textContent = I18n.t('nav.dashboard');
  dashItem.appendChild(dashIcon);
  dashItem.appendChild(dashName);
  nav.appendChild(dashItem);

  for (const [sectionName, items] of Object.entries(sections)) {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'nav-section';

    const titleEl = document.createElement('div');
    titleEl.className = 'nav-section-title';
    titleEl.textContent = getNavSectionLabel(sectionName);
    sectionEl.appendChild(titleEl);

    for (const m of items) {
      const h = health[m.id] || {};
      const isHealthy = h.healthy;
      const item = document.createElement('div');
      item.className = 'nav-item' + (m.id === currentModule ? ' active' : '') + (isHealthy === false ? ' offline' : '');
      item.onclick = () => loadModule(m.id, true);

      const icon = document.createElement('span');
      icon.className = 'icon ' + (isHealthy === true ? 'healthy' : isHealthy === false ? 'unhealthy' : 'unknown');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = getModuleDisplayName(m);

      item.appendChild(icon);
      item.appendChild(name);
      sectionEl.appendChild(item);
    }

    nav.appendChild(sectionEl);
  }
}

function updateStatusBar() {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');
  // v2.3.123: topbar 的 system-status-dot / system-status-text 已经移除 (信息已迁到 sidebar status-bar),
  // 保留兼容写法, 元素不存在时静默跳过.
  const topDot = document.getElementById('system-status-dot');
  const topText = document.getElementById('system-status-text');
  const allHealthy = Object.values(health).every(h => h.healthy);
  const anyHealthy = Object.values(health).some(h => h.healthy);

  indicator.className = 'status-indicator';
  if (topDot) topDot.className = 'system-status-dot';
  if (allHealthy) {
    indicator.classList.add('healthy');
    text.textContent = I18n.t('status.allHealthy');
    if (topDot) topDot.classList.add('healthy');
    if (topText) topText.textContent = I18n.t('status.allOk');
  } else if (anyHealthy) {
    indicator.classList.add('degraded');
    text.textContent = I18n.t('status.someOffline');
    if (topDot) topDot.classList.add('degraded');
    if (topText) topText.textContent = I18n.t('status.degraded');
  } else {
    text.textContent = I18n.t('status.unavailable');
    if (topText) topText.textContent = I18n.t('status.unavailable');
  }
}

async function restartModule(id) {
  try {
    const res = await fetch('/api/modules/' + id + '/restart', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      // 刷新 Dashboard 健康数据
      // v2.3.126: 原先调用的是从未定义过的 loadDashboardData(), 必然抛 ReferenceError,
      // 被 catch 吞掉后弹"重启请求失败", 实际重启已成功 —— 改为调用真实存在的 loadDashboard()。
      dashboardData = null;
      _dashState = 'idle';
      _dashError = null;
      await loadDashboard(true);
      renderDashboard();
    } else {
      alert('重启失败: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    alert('重启请求失败: ' + e.message);
  }
}

function loadModule(id, pushState = true, routePath = null, title = null) {
  const m = modules.find(x => x.id === id);
  if (!m) return;

  currentModule = id;
  document.body.className = document.body.className.replace(/\bmodule-[a-z0-9-]+\b/g, '').trim();
  setShellModuleView(true);
  document.getElementById('module-title').textContent = title || getModuleDisplayName(m);
  updateModuleStatus(id);
  renderNav();

  const content = document.getElementById('content');
  const h = health[id] || {};

  if (h.healthy === false) {
    content.innerHTML = `
      <div class="module-offline">
        <h3>${I18n.t('module.offline')}</h3>
        <p>${I18n.t('module.offlineDesc', { name: getModuleDisplayName(m) })}</p>
      </div>
    `;
    return;
  }

  const oldFrame = content.querySelector('.module-frame');
  if (oldFrame) {
    try { oldFrame.contentWindow.stop(); } catch(e) {}
    oldFrame.src = 'about:blank';
    oldFrame.remove();
  }

  const embedPath = m.embedPath || '/';
  const rawIFrameSrc = `/apps/${m.id}${embedPath.startsWith('/') ? embedPath : '/' + embedPath}`;
  const iframeSrc = `${rawIFrameSrc}${rawIFrameSrc.includes('?') ? '&' : '?'}__embed=1&v=${SHELL_POLISH_VERSION}`;

  // v2.3.127: 必须先插入 DOM，再设 src。
  // 旧写法（iframe 还游离时先 frame.src = ... 再 appendChild）在 Chrome 上有约
  // 15%~25% 的概率整个导航被丢弃：请求发出、响应也回来了，但 contentWindow 永远
  // 停在 about:blank，模块区就是一片白，且没有任何提示。实测 1437x732 窗口下
  // 旧写法 8 次白 2 次；改成「插入后再设 src」后 20 次全绿。
  const frame = document.createElement('iframe');
  frame.className = 'module-frame';
  frame.loading = 'eager';
  frame.referrerPolicy = 'unsafe-url';
  frame.sandbox = 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals';
  content.innerHTML = '';
  content.appendChild(frame);

  let frameRevealed = false;
  let frameSettled = false; // 是否已经 commit 了真实模块文档
  const revealFrame = () => {
    if (frameRevealed) return;
    frameRevealed = true;
    frame.classList.add('is-ready');
  };

  // 兜底：既没 commit 也没报错（导航被丢弃 / 服务端无响应）时，给出可见的错误面板
  // 与「重试」，不再留一片白。切走模块或 iframe 已被替换时不打扰当前页面。
  const loadWatchdog = window.setTimeout(() => {
    if (frameSettled || currentModule !== m.id || !frame.isConnected) return;
    showModuleLoadError(content, m, 'timeout');
  }, MODULE_LOAD_TIMEOUT_MS);
  const clearWatchdog = () => { window.clearTimeout(loadWatchdog); };

  frame.addEventListener('load', () => {
    // 首次 load 可能是初始 about:blank，必须校验真实文档，否则会把空壳放出来
    let committed = false;
    try {
      const w = frame.contentWindow;
      const href = (w && w.location) ? String(w.location.href) : '';
      committed = !!href && href !== 'about:blank';
    } catch (e) {
      committed = true; // 跨域读不到 location：说明已经是真实文档
    }
    if (!committed) return;
    frameSettled = true;
    clearWatchdog();
    broadcastTheme(currentTheme);
    broadcastDesignSystem();
    I18n.broadcastLang(I18n.getLang());
    broadcastProfile(ProfileSwitcher.getProfile());
    window.setTimeout(() => {
      revealFrame();
    }, 140);
  });

  frame.addEventListener('error', () => {
    if (frameSettled || currentModule !== m.id || !frame.isConnected) return;
    clearWatchdog();
    showModuleLoadError(content, m, 'broken');
  });

  // 先挂监听再出发，避免导航过快时丢事件
  frame.src = iframeSrc;

  window.setTimeout(() => {
    revealFrame();
  }, 1200);

  if (pushState) {
    const targetPath = routePath || m.mountPath;
    window.history.pushState({ moduleId: id }, '', targetPath);
  }
}

// v2.3.127: 模块 iframe 加载失败/超时时的可见反馈 + 重试入口。
// 之前这种情况只会留下一个空的 about:blank iframe —— 也就是用户看到的"白屏"。
function showModuleLoadError(content, m, reason) {
  const name = getModuleDisplayName(m);
  const reasonKey = reason === 'timeout' ? 'module.loadTimeout' : 'module.loadBroken';
  const box = document.createElement('div');
  box.className = 'module-load-error';
  box.innerHTML =
    '<div class="module-load-error-title">' + escapeHtmlText(I18n.t('module.failedLoad')) + '</div>' +
    '<div class="module-load-error-desc">' + escapeHtmlText(I18n.t('module.failedLoadDesc')) + '</div>' +
    '<div class="module-load-error-reason">' + escapeHtmlText(I18n.t(reasonKey, { name: name })) + '</div>' +
    '<button type="button" class="oc-btn oc-btn-md oc-btn-primary" id="module-reload-btn">' +
      escapeHtmlText(I18n.t('module.retry')) +
    '</button>';
  content.innerHTML = '';
  content.appendChild(box);
  const btn = box.querySelector('#module-reload-btn');
  if (btn) {
    // 注意不能用 pushState=false：地址栏已经在这个模块上，重走一次即可
    btn.addEventListener('click', () => loadModule(m.id, true));
  }
}

function updateModuleStatus(id) {
  // v2.3.123: topbar 不再渲染 module-status, 元素不存在时静默跳过.
  const el = document.getElementById('module-status');
  if (!el) return;
  const h = health[id] || {};
  el.className = 'module-status';
  if (h.healthy === true) {
    el.classList.add('healthy');
    el.textContent = I18n.t('status.online');
  } else if (h.healthy === false) {
    el.classList.add('unhealthy');
    el.textContent = I18n.t('status.offline');
  } else {
    el.textContent = I18n.t('status.unknown');
  }
}

init();
