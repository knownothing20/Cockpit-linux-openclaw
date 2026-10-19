(function() {
  var STORAGE_KEY = 'openclaw-profile';

  function getProfile() {
    return localStorage.getItem(STORAGE_KEY) || 'openclaw';
  }

  function setProfile(profile) {
    localStorage.setItem(STORAGE_KEY, profile);
    document.querySelectorAll('.profile-switcher').forEach(function(el) {
      el.querySelectorAll('.ps-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.profile === profile);
      });
    });
    var evt = new CustomEvent('profile-change', { detail: { profile: profile } });
    document.dispatchEvent(evt);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'openclaw-profile', profile: profile }, '*');
    }
  }

  function apiPrefix() {
    return getProfile() === 'hermes' ? '/api/hermes' : '';
  }

  function remapApi(path) {
    if (getProfile() === 'hermes') {
      return path.replace(/^\/api\//, '/api/hermes/');
    }
    return path;
  }

  function createSwitcher(container, opts) {
    opts = opts || {};
    var current = getProfile();
    var wrapper = document.createElement('div');
    wrapper.className = 'profile-switcher';
    wrapper.innerHTML =
      '<button class="ps-btn ps-oc' + (current === 'openclaw' ? ' active' : '') + '" data-profile="openclaw" title="OpenClaw">' +
        '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M10 16c-1.2-1.6-4-3.6-4-6.4A4 4 0 0 1 10 6a4 4 0 0 1 4 3.6c0 2.8-2.8 4.8-4 6.4z"/><circle cx="10" cy="9" r="1.2"/></svg>' +
        '<span>OpenClaw</span>' +
      '</button>' +
      '<button class="ps-btn ps-hm' + (current === 'hermes' ? ' active' : '') + '" data-profile="hermes" title="Hermes">' +
        '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M10 2v3M8 3.5h4M10 5C8.4 6.5 7 9 7 11.5 7 14 8 15.5 10 18c2-2.5 3-4 3-6.5C13 9 11.6 6.5 10 5z"/><circle cx="10" cy="10" r="1.2"/></svg>' +
        '<span>Hermes</span>' +
      '</button>';

    wrapper.querySelectorAll('.ps-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var p = btn.dataset.profile;
        if (p !== getProfile()) {
          setProfile(p);
          if (opts.onChange) opts.onChange(p);
        }
      });
    });

    if (typeof container === 'string') {
      container = document.querySelector(container);
    }
    if (container) {
      container.prepend(wrapper);
    }
    return wrapper;
  }

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'openclaw-profile') {
      var p = e.data.profile;
      if (p && p !== getProfile()) {
        setProfile(p);
      }
    }
  });

  window.ProfileSwitcher = {
    getProfile: getProfile,
    setProfile: setProfile,
    apiPrefix: apiPrefix,
    remapApi: remapApi,
    create: createSwitcher,
  };
})();
