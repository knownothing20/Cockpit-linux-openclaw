(function() {
  const STORAGE_KEY = 'openclaw-lang';
  let _lang = localStorage.getItem(STORAGE_KEY) || 'zh';

  const translations = {
    zh: {
      'app.title': 'OpenClaw Cockpit',
      'app.brand': 'OpenClaw',
      'app.version': 'Cockpit Shell',
      'nav.dashboard': '仪表盘',
      'status.checking': '检查中...',
      'status.allHealthy': '所有系统正常',
      'status.allOk': '全部正常',
      'status.someOffline': '部分模块离线',
      'status.degraded': '性能降级',
      'status.unavailable': '系统不可用',
      'status.online': '在线',
      'status.offline': '离线',
      'status.unknown': '未知',
      'welcome.title': '欢迎使用 OpenClaw Cockpit',
      'welcome.desc': '从侧边栏选择模块开始使用。',
      'theme.switchLight': '切换亮色主题',
      'theme.switchDark': '切换暗色主题',
      'module.offline': '模块离线',
      'module.offlineDesc': '{name} 当前不可用。',
      'module.failedLoad': '模块加载失败',
      'module.failedLoadDesc': '请求的模块不可用或返回了错误。',
      'module.loadTimeout': '等待「{name}」响应超时。',
      'module.loadBroken': '「{name}」的页面没有正常加载。',
      'module.retry': '重试',
      'dashboard.loading': '正在加载系统数据...',
      'dashboard.loadFailed': '系统数据加载失败',
      'dashboard.retry': '重试',
      'dashboard.lastUpdated': '最后更新：',
      'dashboard.cpu': 'CPU',
      'dashboard.memory': '内存',
      'dashboard.disk': '磁盘',
      'dashboard.modulesOnline': '在线模块',
      'dashboard.tokensToday': '今日 Tokens',
      'dashboard.skills': '技能',
      'dashboard.documents': '文档',
      'dashboard.agents': '机器人',
      'dashboard.groupSystem': '系统',
      'dashboard.groupIntelligence': 'OpenClaw',
      'dashboard.groupTools': '工具与数据',
      'dashboard.groupKnowledge': '知识',
      'card.services': '服务',
      'card.servicesOnline': '{online}/{total} 在线',
      'card.config': '配置',
      'card.configHealth': '健康度 {pct}%',
      'card.healthScore': '健康评分',
      'card.backups': '备份',
      'card.todayChanges': '今日变更',
      'card.autoBackup': '自动备份',
      'card.on': '开',
      'card.off': '关',
      'card.rules': '规则',
      'card.rulesPass': '{pass}/{total} 检查通过',
      'card.passRate': '通过率',
      'card.pass': '通过',
      'card.fail': '失败',
      'card.missingRules': '{count} 个项目缺规则',
      'card.aiModels': 'AI 模型',
      'card.tokensTodayCount': '{count} tokens 今日',
      'card.messagesToday': '今日消息',
      'card.weekTokens': '本周 Tokens',
      'card.avgResponse': '平均响应',
      'card.providersModels': '提供商 / 模型',
      'card.skillsCard': '技能',
      'card.skillsCount': '{count} 个技能',
      'card.withMeta': '有元数据',
      'card.noSkillData': '暂无技能数据',
      'card.documents': '文档',
      'card.docsProjects': '{docs} 文档, {projects} 项目',
      'card.mainDocs': '主文档',
      'card.memoryFiles': '记忆文件',
      'card.sharedRules': '共享规则',
      'card.workspaces': '工作区',
      'card.shares': '分享',
      'card.activeShares': '{count} 个活跃分享',
      'card.active': '活跃',
      'card.noActiveShares': '暂无活跃分享',
      'card.robots': '机器人',
      'card.agentsCount': '{count} 个机器人',
      'card.noAgentData': '暂无机器人数据',
      'section.topModels': '热门模型（按 tokens）',
      'section.offlineModules': '离线模块',
      'section.more': '+{count} 更多',
      'lang.switch': '切换语言',
      'lang.zh': '中',
      'lang.en': 'En',
      'action.refresh': '刷新数据',
      'action.refreshing': '刷新中...',
      'navSection.system': '系统',
      'navSection.intelligence': '智能',
      'navSection.openclaw': 'OpenClaw',
      'navSection.tools': '工具与数据',
      'navSection.knowledge': '知识',
      'navSection.default': '其他',
      'module.applist': '软件管理',
      'module.config-recovery': '配置恢复',
      'module.file-manager': '文件管理',
      'module.http-share-service': 'HTTP 分享',
      'module.memory': '内存监控',
      'module.models-manager': '模型管理',
      'module.robots': '机器人',
      'module.skill-manager': '技能管理',
      'module.workspace-rule-panel': '规则面板',
    },
    en: {
      'app.title': 'OpenClaw Cockpit',
      'app.brand': 'OpenClaw',
      'app.version': 'Cockpit Shell',
      'nav.dashboard': 'Dashboard',
      'status.checking': 'Checking...',
      'status.allHealthy': 'All systems healthy',
      'status.allOk': 'All OK',
      'status.someOffline': 'Some modules offline',
      'status.degraded': 'Degraded',
      'status.unavailable': 'Unavailable',
      'status.online': 'Online',
      'status.offline': 'Offline',
      'status.unknown': 'Unknown',
      'welcome.title': 'Welcome to OpenClaw Cockpit',
      'welcome.desc': 'Select a module from the sidebar to get started.',
      'theme.switchLight': 'Switch to light',
      'theme.switchDark': 'Switch to dark',
      'module.offline': 'Module Offline',
      'module.offlineDesc': '{name} is currently unavailable.',
      'module.failedLoad': 'Module failed to load',
      'module.failedLoadDesc': 'The requested module is not available or returned an error.',
      'module.loadTimeout': 'Timed out waiting for "{name}" to respond.',
      'module.loadBroken': 'The page for "{name}" did not load properly.',
      'module.retry': 'Retry',
      'dashboard.loading': 'Loading system data...',
      'dashboard.loadFailed': 'Failed to load system data',
      'dashboard.retry': 'Retry',
      'dashboard.lastUpdated': 'Last updated: ',
      'dashboard.cpu': 'CPU',
      'dashboard.memory': 'Memory',
      'dashboard.disk': 'Disk',
      'dashboard.modulesOnline': 'Modules Online',
      'dashboard.tokensToday': 'Tokens Today',
      'dashboard.skills': 'Skills',
      'dashboard.documents': 'Documents',
      'dashboard.agents': 'Agents',
      'dashboard.groupSystem': 'System',
      'dashboard.groupIntelligence': 'OpenClaw',
      'dashboard.groupTools': 'Tools & Data',
      'dashboard.groupKnowledge': 'Knowledge',
      'card.services': 'Services',
      'card.servicesOnline': '{online}/{total} Online',
      'card.config': 'Config',
      'card.configHealth': '{pct}% health',
      'card.healthScore': 'Health score',
      'card.backups': 'Backups',
      'card.todayChanges': 'Today changes',
      'card.autoBackup': 'Auto backup',
      'card.on': 'On',
      'card.off': 'Off',
      'card.rules': 'Rules',
      'card.rulesPass': '{pass}/{total} checks pass',
      'card.passRate': 'Pass rate',
      'card.pass': 'Pass',
      'card.fail': 'Fail',
      'card.missingRules': '{count} projects missing rules',
      'card.aiModels': 'AI Models',
      'card.tokensTodayCount': '{count} tokens today',
      'card.messagesToday': 'Messages today',
      'card.weekTokens': 'Week tokens',
      'card.avgResponse': 'Avg response',
      'card.providersModels': 'Providers / Models',
      'card.skillsCard': 'Skills',
      'card.skillsCount': '{count} skills',
      'card.withMeta': 'With meta',
      'card.noSkillData': 'No skill data',
      'card.documents': 'Documents',
      'card.docsProjects': '{docs} docs, {projects} projects',
      'card.mainDocs': 'Main docs',
      'card.memoryFiles': 'Memory files',
      'card.sharedRules': 'Shared rules',
      'card.workspaces': 'Workspaces',
      'card.shares': 'Shares',
      'card.activeShares': '{count} active shares',
      'card.active': 'Active',
      'card.noActiveShares': 'No active shares',
      'card.robots': 'Robots',
      'card.agentsCount': '{count} agents',
      'card.noAgentData': 'No agent data',
      'section.topModels': 'Top Models (by tokens)',
      'section.offlineModules': 'Offline Modules',
      'section.more': '+{count} more',
      'lang.switch': 'Switch language',
      'lang.zh': '中',
      'lang.en': 'En',
      'action.refresh': 'Refresh data',
      'action.refreshing': 'Refreshing...',
      'navSection.system': 'System',
      'navSection.intelligence': 'Intelligence',
      'navSection.openclaw': 'OpenClaw',
      'navSection.tools': 'Tools & Data',
      'navSection.knowledge': 'Knowledge',
      'navSection.default': 'Other',
      'module.applist': 'AppList',
      'module.config-recovery': 'Config Recovery',
      'module.file-manager': 'File Manager',
      'module.http-share-service': 'HTTP Share',
      'module.memory': 'Memory Monitor',
      'module.models-manager': 'Models Manager',
      'module.robots': 'Robots',
      'module.skill-manager': 'Skill Manager',
      'module.workspace-rule-panel': 'Rule Panel',
    }
  };

  function t(key, params) {
    let str = (translations[_lang] && translations[_lang][key]) || (translations['en'] && translations['en'][key]) || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
      }
    }
    return str;
  }

  function getLang() {
    return _lang;
  }

  function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    _lang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    applyTranslations();
    broadcastLang(lang);
    if (typeof onLangChange === 'function') onLangChange(lang);
  }

  function toggleLang() {
    setLang(_lang === 'zh' ? 'en' : 'zh');
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = t(key);
    });
    document.title = t('app.title');
  }

  function broadcastLang(lang) {
    const msg = { type: 'openclaw-lang', lang: lang };
    const origin = window.location.origin;
    const frames = document.querySelectorAll('.module-frame');
    frames.forEach(f => {
      try { f.contentWindow.postMessage(msg, origin); } catch(e) {}
    });
  }

  function listenForLangSync() {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'openclaw-lang') {
        const lang = e.data.lang;
        if (lang === 'zh' || lang === 'en') {
          _lang = lang;
          localStorage.setItem(STORAGE_KEY, lang);
          document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
          applyTranslations();
          broadcastLang(lang);
          if (typeof onLangChange === 'function') onLangChange(lang);
        }
      }
    });
  }

  function initI18n() {
    document.documentElement.setAttribute('lang', _lang === 'zh' ? 'zh-CN' : 'en');
    applyTranslations();
    listenForLangSync();
  }

  window.I18n = {
    t: t,
    getLang: getLang,
    setLang: setLang,
    toggleLang: toggleLang,
    applyTranslations: applyTranslations,
    broadcastLang: broadcastLang,
    initI18n: initI18n,
  };

  initI18n();
})();
