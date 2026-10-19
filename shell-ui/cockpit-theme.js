/* ================================================================
   OpenClaw Cockpit Theme Utility
   Shared theme toggle logic for embedded modules.
   Auto-wires any .oc-tool-btn.theme button and keeps its icon
   in sync with parent shell theme broadcasts.
   ================================================================ */
(function () {
  var STORAGE_KEY = 'openclaw-theme';
  var ATTR = 'data-theme';
  var VALID = { dark: 1, light: 1 };
  var DEFAULT_THEME = 'dark';
  var SELECTOR = '.oc-tool-btn.theme';

  function readAttribute() {
    var attr = document.documentElement.getAttribute(ATTR);
    return (attr === 'light' || attr === 'dark') ? attr : null;
  }

  function readStorage() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) { return null; }
  }

  function current() {
    return readAttribute() || readStorage() || DEFAULT_THEME;
  }

  function updateIcon(theme) {
    document.querySelectorAll(SELECTOR).forEach(function (btn) {
      btn.textContent = theme === 'dark' ? '☽' : '☼';
      btn.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    });
  }

  function apply(theme, opts) {
    if (!VALID[theme]) return;
    opts = opts || {};
    document.documentElement.setAttribute(ATTR, theme);
    if (!opts.skipStorage) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
    }
    updateIcon(theme);
    if (!opts.skipParent && window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: 'openclaw-theme', theme: theme }, location.origin); } catch (e) {}
    }
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark');
  }

  function wireButtons() {
    document.querySelectorAll(SELECTOR).forEach(function (btn) {
      if (btn.__cockpitThemeWired) return;
      btn.__cockpitThemeWired = true;
      btn.addEventListener('click', toggle);
    });
  }

  function init() {
    var theme = current();
    // Ensure the theme attribute is set on initial load to apply the correct
    // skin. If the page already set it (e.g. via an inline FOUC-prevention
    // script or server-side render), keep that value to avoid a flash.
    if (!readAttribute()) {
      document.documentElement.setAttribute(ATTR, theme);
    }
    updateIcon(theme);
    wireButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Listen for parent shell theme/design broadcasts and sync locally.
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    var type = e.data.type;
    if (type !== 'openclaw-theme' && type !== 'openclaw-design') return;
    var t = e.data.theme;
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute(ATTR, t);
      try { localStorage.setItem(STORAGE_KEY, t); } catch (err) {}
      updateIcon(t);
    } else {
      // No explicit theme value (e.g. openclaw-design with profile only) — keep current icon in sync.
      updateIcon(current());
    }
  });

  window.CockpitTheme = {
    current: current,
    apply: apply,
    toggle: toggle,
  };
})();
