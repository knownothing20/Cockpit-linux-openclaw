(() => {
  const VERSION = '20261010-fm-docs-real-pct';
  const CSS_HREF = `/cockpit-ui-polish.css?v=${VERSION}`;
  const LINK_SELECTOR = 'link[data-cockpit-ui-polish="true"]';
  const STATIC_MODULE_EMBEDS = new Map();
  const TEXT_ARTIFACTS = [
    [/['"]?\s*\+\s*t\(['"]status\.candidate['"]\)\s*\+\s*['"]?\s*摘要/g, '候选摘要'],
    [/['"]?\s*\+\s*t\(['"]status\.promoted['"]\)\s*\+\s*['"]?/g, '已晋升'],
    [/['"]?\s*\+\s*t\(['"]status\.dismissed['"]\)\s*\+\s*['"]?/g, '已忽略'],
    [/最新备份:\s*undefined/g, '最新备份: -'],
    [/\bundefined\b/g, '-'],
  ];
  const STORAGE_KEYS = {
    theme: 'openclaw-theme',
    skin: 'openclaw-cockpit-skin',
    density: 'openclaw-cockpit-density',
    motion: 'openclaw-cockpit-motion',
  };
  const VALID = {
    theme: new Set(['light', 'dark']),
    skin: new Set(['ops', 'glass']),
    density: new Set(['comfortable', 'compact']),
    motion: new Set(['standard', 'reduced']),
  };

  const PROFILE_STORAGE_KEY = 'openclaw-profile';
  const VALID_PROFILES = new Set(['openclaw', 'hermes']);

  function getActiveProfile() {
    try {
      const profile = localStorage.getItem(PROFILE_STORAGE_KEY) || 'openclaw';
      return VALID_PROFILES.has(profile) ? profile : 'openclaw';
    } catch (error) {
      return 'openclaw';
    }
  }

  function getThemeStorageKey(profile = getActiveProfile()) {
    return `${STORAGE_KEYS.theme}:${VALID_PROFILES.has(profile) ? profile : 'openclaw'}`;
  }

  function getStoredTheme(profile = getActiveProfile()) {
    const scoped = localStorage.getItem(getThemeStorageKey(profile));
    if (VALID.theme.has(scoped)) return scoped;
    const legacy = localStorage.getItem(STORAGE_KEYS.theme);
    return VALID.theme.has(legacy) ? legacy : null;
  }

  const HEADER_SELECTORS = [
    '.page-header', '.standalone-header', '.main-header', '.header', '.topbar', '.hero-card', '.models-hero-v2'
  ];
  const TITLE_SELECTORS = [
    'h1', '.page-title', '.header-title', '.hero-title', '.main-title', '.models-hero-v2 h1'
  ];
  const SUBTITLE_SELECTORS = [
    '.page-subtitle', '.subtitle', '.header-subtitle', '.hero-subtitle', '.topbar-subtitle', '.models-hero-v2 p', '.header p'
  ];
  const INLINE_TITLE_PROPS = [
    'font-size', 'line-height', 'font-weight', 'letter-spacing', 'color', '-webkit-text-fill-color',
    'background', 'background-image', 'margin', 'margin-bottom', 'min-height', 'display', 'text-shadow',
    'opacity', 'visibility', 'transform', 'filter'
  ];
  const INLINE_SUBTITLE_PROPS = [
    'font-size', 'line-height', 'font-weight', 'letter-spacing', 'color', 'margin', 'margin-bottom', 'text-shadow'
  ];
  const LEADING_ICON_RE = /^[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]+\s*/u;

  function getStoredDesign() {
    const preferredLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const design = {
      theme: getStoredTheme() || (preferredLight ? 'light' : 'dark'),
      skin: localStorage.getItem(STORAGE_KEYS.skin) || 'ops',
      density: localStorage.getItem(STORAGE_KEYS.density) || 'comfortable',
      motion: localStorage.getItem(STORAGE_KEYS.motion) || 'standard',
    };
    for (const [key, values] of Object.entries(VALID)) {
      if (!values.has(design[key])) design[key] = values.values().next().value;
    }
    return design;
  }

  function normalizeDesign(payload = {}) {
    const base = getStoredDesign();
    const design = { ...base, ...payload };
    for (const [key, values] of Object.entries(VALID)) {
      if (!values.has(design[key])) design[key] = base[key];
    }
    return design;
  }

  function applyDesign(doc, payload = {}) {
    if (!doc || !doc.documentElement) return;
    const design = normalizeDesign(payload);
    const root = doc.documentElement;
    root.setAttribute('data-theme', design.theme);
    root.setAttribute('data-oc-skin', design.skin);
    root.setAttribute('data-oc-density', design.density);
    root.setAttribute('data-oc-motion', design.motion);
  }

  function applyFrameSize(doc, width) {
    if (!doc || !doc.documentElement) return;
    const actualWidth = Number(width) || (doc.defaultView && doc.defaultView.innerWidth) || window.innerWidth;
    doc.documentElement.setAttribute('data-oc-frame', actualWidth < 720 ? 'narrow' : 'regular');
  }

  function persistDesign(payload = {}) {
    const design = normalizeDesign(payload);
    localStorage.setItem(getThemeStorageKey(design.profile), design.theme);
    localStorage.setItem(STORAGE_KEYS.theme, design.theme);
    localStorage.setItem(STORAGE_KEYS.skin, design.skin);
    localStorage.setItem(STORAGE_KEYS.density, design.density);
    localStorage.setItem(STORAGE_KEYS.motion, design.motion);
    return design;
  }

  function ensurePolishLink(doc) {
    if (!doc || !doc.head) return;
    const existing = doc.querySelector(LINK_SELECTOR) ||
      Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).find((link) => link.href.includes('cockpit-ui-polish.css'));
    if (existing) {
      existing.dataset.cockpitUiPolish = 'true';
      if (!existing.href.includes(VERSION)) existing.href = CSS_HREF;
      // Keep polish stylesheet at the end of <head> so module-local styles cannot override it.
      if (existing.parentNode === doc.head) {
        doc.head.appendChild(existing);
      }
      return;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.dataset.cockpitUiPolish = 'true';
    doc.head.appendChild(link);
  }

  function removeBlockingExternalFonts(doc) {
    if (!doc || !doc.head) return;
    doc.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').forEach((link) => {
      link.dataset.cockpitRemovedExternalFont = 'true';
      link.remove();
    });
  }

  function normalizeTextArtifacts(doc) {
    if (!doc || !doc.body) return;
    // v2.3.128: 必须跳过「文本即代码」的节点。
    // 旧实现只看内容不看宿主，而 TreeWalker(SHOW_TEXT) 会把 <script> 里的 JS 源码
    // 当成普通文本节点，于是 `x !== undefined` 被清洗成 `x !== -`（每处少 8 字节），
    // 整个模块脚本随即语法错误 → 页面白屏。凡是源码里出现 undefined 字面量的模块都会中招。
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent && SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.includes("t('status.") || node.nodeValue.includes('最新备份: undefined') || node.nodeValue.includes('undefined')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      let text = node.nodeValue;
      TEXT_ARTIFACTS.forEach(([pattern, replacement]) => {
        text = text.replace(pattern, replacement);
      });
      node.nodeValue = text;
    });
  }

  function firstMatch(doc, selectors) {
    for (const selector of selectors) {
      const found = doc.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function removeInlineProps(element, props) {
    if (!element || !element.style) return;
    props.forEach((prop) => element.style.removeProperty(prop));
  }

  function cleanLeadingTextNode(container) {
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === 3) {
        const cleaned = node.textContent.replace(LEADING_ICON_RE, '');
        if (cleaned !== node.textContent) node.textContent = cleaned;
        return cleaned.trim().length > 0;
      }
      if (node.nodeType === 1) {
        const tag = node.tagName && node.tagName.toLowerCase();
        if (tag === 'svg' || tag === 'img') {
          node.classList.add('oc-local-title-icon');
          continue;
        }
        if (cleanLeadingTextNode(node)) return true;
      }
    }
    return false;
  }

  function cleanLeadingTitleIcon(title) {
    if (!title) return;
    cleanLeadingTextNode(title);
    title.dataset.ocTitleNormalized = 'true';
  }

  const SURFACE_CARD_SELECTOR = [
    '.oc-card', '.oc-stat',
    '.stat-card', '.metric-card', '.summary-card', '.overview-card', '.health-card', '.kpi-card', '.status-card', '.stats-card',
    '.panel', '.section-card', '.domain-card', '.agent-card', '.skill-card', '.model-card', '.training-card', '.record-card',
    '.backup-card', '.config-card', '.file-card', '.app-card', '.table-card', '.list-card', '.detail-card'
  ].join(', ');

  function enforceUnifiedInlineStyles(doc, title) {
    return; // A.1: mute runtime inline style enforcement
  }


  function applyRuntimeHardLocks(doc) {
    return; // A.1: mute runtime inline style hard locks
  }

  function normalizeModuleUi(doc) {
    if (!doc || !doc.documentElement || !doc.body) return;
    normalizeTextArtifacts(doc);
    const root = doc.documentElement;
    const moduleClass = Array.from(doc.body.classList).find((name) => !['embed-mode'].includes(name));
    if (moduleClass) root.setAttribute('data-oc-module', moduleClass);

    const header = firstMatch(doc, HEADER_SELECTORS);
    if (header) header.classList.add('oc-module-chrome');

    const title = firstMatch(doc, TITLE_SELECTORS);
    if (title) {
      title.classList.add('oc-module-title');
      removeInlineProps(title, INLINE_TITLE_PROPS);
      cleanLeadingTitleIcon(title);
    }

    const subtitle = firstMatch(doc, SUBTITLE_SELECTORS);
    if (subtitle) {
      subtitle.classList.add('oc-module-subtitle');
      removeInlineProps(subtitle, INLINE_SUBTITLE_PROPS);
    }
    enforceUnifiedInlineStyles(doc, title);
    applyRuntimeHardLocks(doc);
  }

  function markDocument(doc, className, width) {
    if (!doc || !doc.documentElement) return;
    doc.documentElement.classList.add(className);
    applyDesign(doc);
    applyFrameSize(doc, width);
    if (className === 'cockpit-embedded-module') normalizeModuleUi(doc);
  }

  function currentPayload() {
    const root = document.documentElement;
    return normalizeDesign({
      theme: root.getAttribute('data-theme'),
      skin: root.getAttribute('data-oc-skin'),
      density: root.getAttribute('data-oc-density'),
      motion: root.getAttribute('data-oc-motion'),
      profile: getActiveProfile(),
    });
  }

  function detectModuleIdFromFrame(frame) {
    try {
      const raw = frame.getAttribute('src') || frame.src || '';
      const url = new URL(raw, window.location.origin);
      const m = url.pathname.match(/^\/apps\/([^\/]+)/);
      return m ? m[1] : '';
    } catch (error) {
      return '';
    }
  }

  function getStaticModuleEmbed(frame) {
    try {
      const raw = frame.getAttribute('src') || frame.src || '';
      const url = new URL(raw, window.location.origin);
      return STATIC_MODULE_EMBEDS.get(url.pathname) || null;
    } catch (error) {
      return null;
    }
  }

  function isNestedShellDocument(doc) {
    if (!doc || !doc.body) return false;
    return doc.title === 'OpenClaw Cockpit' || Boolean(doc.querySelector('.layout .sidebar, #content, #nav'));
  }

  function maybeRedirectStaticModuleFrame(frame, doc) {
    const target = getStaticModuleEmbed(frame);
    if (!target || frame.dataset.cockpitStaticEmbedResolved === 'true') return false;
    if (!isNestedShellDocument(doc)) return false;
    frame.dataset.cockpitStaticEmbedResolved = 'true';
    frame.src = `${target}?v=${VERSION}`;
    return true;
  }

  function polishFrame(frame) {
    try {
      const doc = frame.contentDocument;
      removeBlockingExternalFonts(doc);
      if (maybeRedirectStaticModuleFrame(frame, doc)) return;
      const width = frame.getBoundingClientRect().width;
      const moduleId = detectModuleIdFromFrame(frame);
      markDocument(doc, 'cockpit-embedded-module', width);
      if (moduleId) doc.documentElement.setAttribute('data-oc-module', moduleId);
      ensurePolishLink(doc);
      applyDesign(doc, currentPayload());
      applyFrameSize(doc, width);
      normalizeModuleUi(doc);
    } catch (error) {
      // Same-origin module frames are expected; cross-origin frames are ignored safely.
    }
  }

  function bindFrame(frame) {
    if (!frame) return;
    if (frame.dataset.cockpitUiPolishBound === 'true') {
      polishFrame(frame);
      return;
    }
    frame.dataset.cockpitUiPolishBound = 'true';
    frame.addEventListener('load', () => {
      polishFrame(frame);
      window.setTimeout(() => polishFrame(frame), 120);
    });
    polishFrame(frame);
  }

  function polishAllFrames() {
    document.querySelectorAll('iframe.module-frame').forEach(bindFrame);
  }

  function broadcastDesign(payload = currentPayload()) {
    const msg = { type: 'openclaw-design', ...normalizeDesign(payload) };
    const origin = window.location.origin;
    document.querySelectorAll('iframe.module-frame').forEach((frame) => {
      try {
        frame.contentWindow.postMessage(msg, origin);
        applyDesign(frame.contentDocument, msg);
        applyFrameSize(frame.contentDocument, frame.getBoundingClientRect().width);
        normalizeModuleUi(frame.contentDocument);
      } catch (error) {}
    });
  }

  function boot() {
    ensurePolishLink(document);
    markDocument(document, window.self === window.top ? 'cockpit-shell' : 'cockpit-embedded-module');
    if (window.self !== window.top) normalizeModuleUi(document);
    polishAllFrames();

    window.OpenClawDesignSystem = {
      get: currentPayload,
      set(payload = {}) {
        const design = persistDesign(payload);
        applyDesign(document, design);
        broadcastDesign(design);
        return design;
      },
      broadcast: broadcastDesign,
      applyToDocument: applyDesign,
    };

    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'openclaw-theme-request') {
        const design = currentPayload();
        const targetOrigin = event.origin && event.origin !== 'null' ? event.origin : window.location.origin;
        try { event.source && event.source.postMessage({ type: 'openclaw-theme', theme: design.theme, profile: design.profile }, targetOrigin); } catch (error) {}
        try { event.source && event.source.postMessage({ type: 'openclaw-design', ...design }, targetOrigin); } catch (error) {}
        broadcastDesign(design);
      }
      if (data.type === 'openclaw-theme' && VALID.theme.has(data.theme)) {
        const design = normalizeDesign({ theme: data.theme, profile: data.profile });
        applyDesign(document, design);
        persistDesign(design);
        normalizeModuleUi(document);
      }
      if (data.type === 'openclaw-design') {
        const design = normalizeDesign(data);
        applyDesign(document, design);
        persistDesign(design);
        normalizeModuleUi(document);
        broadcastDesign(design);
      }
    });

    let polishScheduled = false;
    let polishTimer = null;
    const schedulePolish = () => {
      if (polishTimer) return;
      polishTimer = window.setTimeout(() => {
        polishTimer = null;
        if (polishScheduled) return;
        polishScheduled = true;
        window.requestAnimationFrame(() => {
          polishScheduled = false;
          normalizeModuleUi(document);
          polishAllFrames();
        });
      }, 120);
    };

    const observer = new MutationObserver((mutations) => {
      const hasFrameMutation = mutations.some((mutation) =>
        Array.from(mutation.addedNodes || []).some((node) =>
          node && node.nodeType === 1 && (
            (node.matches && node.matches('iframe.module-frame')) ||
            (node.querySelector && node.querySelector('iframe.module-frame'))
          )
        )
      );
      if (hasFrameMutation) schedulePolish();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('resize', schedulePolish);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
