
function ocSetDisplay(el, mode) {
  if (!el) return;
  const value = mode || '';
  el.hidden = value === 'none';
  el.classList.remove('oc-js-display-block', 'oc-js-display-flex', 'oc-js-display-inline', 'oc-js-display-inline-block');
  if (value && value !== 'none') el.classList.add('oc-js-display-' + value.replace(/[^a-z-]/g, ''));
  // 兼容旧模板中残留的内联 display 规则。
  // 否则 hidden=false / oc-js-display-block 类会被更高特异性的 DOM 样式盖掉。
  el.style.display = value;
}
function ocIsHidden(el) {
  return !el || el.hidden;
}

var inShell = window.location.pathname.startsWith('/apps/');
var API_BASE = inShell ? '/apps/file-manager' : (window._apiBase || '');
var SHARE_API_BASE = inShell ? '/apps/file-manager' : (window._shareApiBase || '');
var OPENCLAW_DIR = window.OPENCLAW_DIR || '';



// ── SVG Icon Helpers ──
function svgIcon(name, cls, size) {
  var s = size || 16;
  var c = cls ? ' class="fm-icon ' + cls + '"' : ' class="fm-icon"';
  return '<svg' + c + ' width="' + s + '" height="' + s + '"><use href="#icon-' + name + '"/></svg>';
}
function fmEmpty(icon, text, extraAttrs) {
  var iconHtml = icon ? '<div class="oc-empty-icon">' + icon + '</div>' : '';
  var attrs = extraAttrs ? ' ' + extraAttrs : '';
  return '<div class="oc-empty"' + attrs + '>' + iconHtml + '<h4>' + text + '</h4></div>';
}
function fileIcon(name, isDirectory) {
  if (isDirectory) return svgIcon('folder', 'icon-folder', 16);
  var ext = name.lastIndexOf('.') >= 0 ? name.substring(name.lastIndexOf('.')).toLowerCase() : '';
  var codeExts = ['.js','.ts','.jsx','.tsx','.py','.rb','.go','.rs','.java','.c','.cpp','.h','.sh','.bash','.zsh','.fish','.vue','.svelte','.css','.scss','.less','.html','.xml','.json','.yaml','.yml','.toml','.ini','.conf','.cfg','.env'];
  var textExts = ['.md','.txt','.log','.csv','.tsv','.rtf'];
  if (codeExts.indexOf(ext) >= 0) return svgIcon('file-code', 'icon-file-code', 16);
  if (textExts.indexOf(ext) >= 0) return svgIcon('file-text', 'icon-file-text', 16);
  return svgIcon('file', 'icon-file', 16);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'openclaw-theme') applyTheme(e.data.theme);
});
(function() {
  var s = localStorage.getItem('openclaw-theme');
  applyTheme(s || 'dark');
})();

document.querySelectorAll('.oc-tab').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var tab = btn.dataset.tab;
    document.querySelectorAll('.oc-tab').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById(tab + 'Panel').classList.add('active');
    if (tab === 'docs') loadDocsStats();
    if (tab === 'share') loadShares();
  });
});

function showToast(message, isError) {
  var toast = document.createElement('div');
  toast.className = 'toast oc-toast oc-toast-' + (isError ? 'error' : 'success');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.classList.add('oc-toast-exit');
    setTimeout(function() { toast.remove(); }, 300);
  }, 2700);
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
  } else {
    var input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
  }
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (!bytes) return '';
  var units = ['B', 'KB', 'MB', 'GB'];
  var i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(1) + ' ' + units[i];
}

function getRemainingTime(expiresAt) {
  var diff = new Date(expiresAt) - new Date();
  if (diff <= 0) return t('expired');
  var minutes = Math.floor(diff / 60000);
  if (minutes < 60) return t('minutesLater', { n: minutes });
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursLater', { n: hours });
  return t('daysLater', { n: Math.floor(hours / 24) });
}

var BINARY_EXTS = ['.png','.jpg','.jpeg','.gif','.svg','.pdf','.zip','.gz','.tar','.mp4','.mp3','.wav','.avi','.mov','.woff','.woff2','.ttf','.eot','.ico','.webp','.bmp','.exe','.dll','.so','.dylib','.o','.pyc','.class','.jar','.wasm'];

function isBinaryFile(name) {
  var ext = name.lastIndexOf('.') >= 0 ? name.substring(name.lastIndexOf('.')).toLowerCase() : '';
  return BINARY_EXTS.indexOf(ext) >= 0;
}

function parseOpenClawPath(absPath) {
  var root = OPENCLAW_DIR;
  if (!root) {
    var marker = '/.openclaw/';
    var offset = absPath.indexOf(marker);
    if (offset < 0) return null;
    root = absPath.substring(0, offset + marker.length - 1);
  }
  if (!absPath.startsWith(root + '/')) return null;
  var rel = absPath.substring(root.length + 1);
  var parts = rel.split('/');
  if (parts.length < 1) return null;
  var result = { category: 'root', subfolder: '', folder: '', file: '' };
  if (parts.length === 1) {
    result.category = 'root';
    result.file = parts[0];
  } else if (parts.length === 2) {
    result.category = parts[0];
    result.file = parts[1];
  } else if (parts.length === 3) {
    result.category = parts[0];
    result.subfolder = parts[1];
    result.file = parts[2];
  } else {
    result.category = parts[0];
    result.subfolder = parts[1];
    result.folder = parts.slice(2, -1).join('/');
    result.file = parts[parts.length - 1];
  }
  return result;
}

// ═══════════════════════════════════════════════════════
//  FILES BROWSER (HTTP Share APIs + File Editor)
// ═══════════════════════════════════════════════════════

var browserCurrentPath = '/';
var browserSelected = new Set();
var browserSelectedDirs = {};
// v2.3.106: 去掉左边的 file-tree 目录树面板, tree 状态不再需要.
// var treeExpanded = new Set(['/']);
// var treeCache = {};
var fCurrentFilePath = '';
var fContentCache = '';
var fEditing = false;
var fCanEdit = false;
var SERVER_IP = '';
var SERVER_PORT = '';

function initFiles() {
  loadBrowser('/');
  fetchShareServerInfo();
}

function fetchShareServerInfo() {
  fetch(SHARE_API_BASE + '/health')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ip) SERVER_IP = data.ip;
      if (data.port) SERVER_PORT = String(data.port);
    })
    .catch(function() {});
}

function loadBrowser(p) {
  try { p = decodeURIComponent(p); } catch(e) {}
  browserCurrentPath = p;
  browserSelected.clear();
  browserSelectedDirs = {};
  updateBatchToolbar();
  var list = document.getElementById('browserList');
  list.innerHTML = fmEmpty('⏳', t('loading'));
  renderBreadcrumb(p);
  // v2.3.106: 去掉左边的 file-tree, expandPathInTree 不再需要.

  fetch(SHARE_API_BASE + '/browse?path=' + encodeURIComponent(p))
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || t('requestFailed')); });
      return r.json();
    })
    .then(function(data) {
      browserCurrentPath = data.path;
      renderBreadcrumb(data.path);
      // v2.3.106: 后端如果返回 error 字段 (e.g. 整目录 EACCES 降级), 显示提示, 不要再走 items 渲染.
      if (data.error) {
        list.innerHTML = fmEmpty('🔒', esc(data.error));
        return;
      }
      if (data.items.length === 0) {
        list.innerHTML = fmEmpty(svgIcon('folder', 'icon-folder', 32), t('emptyDir'));
        return;
      }
      var locale = currentLang === 'zh' ? 'zh-CN' : 'en-US';
      list.innerHTML = data.items.map(function(item) {
        var icon = fileIcon(item.name, item.isDirectory);
        var sizeText = item.isDirectory ? '' : formatSize(item.size);
        var mtimeText = new Date(item.mtime).toLocaleString(locale);
        var safePath = encodeURIComponent(item.path).replace(/'/g, '%27');
        var onClickDir = item.isDirectory ? ' onclick="loadBrowser(\'' + safePath + '\')"' : '';
        var downloadBtn = !item.isDirectory ? '<button class="oc-btn oc-btn-sm oc-btn-secondary" onclick="event.stopPropagation();downloadFromBrowser(\'' + safePath + '\')">' + t('download') + '</button>' : '';
        var checked = browserSelected.has(item.path) ? ' checked' : '';
        return '<div class="browser-item"' + onClickDir + '>' +
          '<input type="checkbox" class="browser-checkbox" onclick="event.stopPropagation();toggleSelect(\'' + safePath + '\',' + item.isDirectory + ',this.checked)"' + checked + '>' +
          '<div class="fm-item-main">' +
            '<div class="browser-item-info">' +
              '<span class="browser-item-icon">' + icon + '</span>' +
              '<span class="browser-item-name" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
            '</div>' +
            '<div class="browser-item-meta">' + sizeText + (sizeText ? ' | ' : '') + mtimeText + '</div>' +
          '</div>' +
          '<div class="browser-item-actions" onclick="event.stopPropagation()">' +
            '<button class="oc-btn oc-btn-sm oc-btn-secondary" onclick="copyItemPath(\'' + safePath + '\')">' + t('copyPath') + '</button>' +
            '<button class="oc-btn oc-btn-sm oc-btn-secondary" onclick="shareFromBrowser(\'' + safePath + '\',' + item.isDirectory + ')">' + svgIcon('link', '', 12) + ' ' + t('share') + '</button>' +
            downloadBtn +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function(err) {
      list.innerHTML = fmEmpty('⚠️', t('loadFailedMsg', { msg: esc(err.message) }));
    });
}

function renderBreadcrumb(p) {
  var el = document.getElementById('browserBreadcrumb');
  var parts = p === '/' ? [''] : p.split('/');
  var html = '';
  var accum = '';
  for (var i = 0; i < parts.length; i++) {
    accum += (i === 0 ? '' : '/') + parts[i];
    var pathSoFar = accum || '/';
    var safePath = encodeURIComponent(pathSoFar).replace(/'/g, '%27');
    var label = i === 0 ? t('thisComputer') : esc(parts[i]);
    html += '<span class="breadcrumb-item" onclick="loadBrowser(\'' + safePath + '\')">' + label + '</span>';
    if (i < parts.length - 1) html += '<span class="breadcrumb-sep">›</span>';
  }
  el.innerHTML = html;
}

// v2.3.106: 去掉左边的 file-tree 目录树面板, renderTree / renderTreeNode / toggleTree / expandPathInTree 不再需要, 注释保留供以后恢复.
/*
function renderTree() {
  var el = document.getElementById('fileTreeContent');
  el.innerHTML = renderTreeNode('/', 0);
}

function renderTreeNode(nodePath, depth) {
  var name = nodePath === '/' ? t('thisComputer') : nodePath.split('/').pop();
  var isExpanded = treeExpanded.has(nodePath);
  var isActive = browserCurrentPath === nodePath || browserCurrentPath.startsWith(nodePath + '/');
  var html = '';
  var safePath = encodeURIComponent(nodePath).replace(/'/g, '%27');
  var toggle = nodePath === '/' ? '' : '<span class="tree-toggle" onclick="event.stopPropagation();toggleTree(\'' + safePath + '\')">' + (isExpanded ? '▼' : '▶') + '</span>';
  html += '<div class="tree-node">' +
    '<div class="tree-item' + (isActive ? ' active' : '') + '" onclick="loadBrowser(\'' + safePath + '\')" data-depth="' + depth + '">' +
    toggle +
    '<span class="tree-icon">' + svgIcon('folder', 'icon-folder', 15) + '</span>' +
    '<span class="tree-label">' + esc(name) + '</span>' +
    '</div>';
  if (isExpanded && treeCache[nodePath]) {
    html += '<div class="tree-children">';
    for (var i = 0; i < treeCache[nodePath].length; i++) {
      html += renderTreeNode(treeCache[nodePath][i].path, depth + 1);
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function toggleTree(safePath) {
  var p = decodeURIComponent(safePath);
  if (treeExpanded.has(p)) {
    treeExpanded.delete(p);
    renderTree();
    return;
  }
  treeExpanded.add(p);
  if (treeCache[p]) {
    renderTree();
    return;
  }
  fetch(SHARE_API_BASE + '/tree?path=' + encodeURIComponent(p))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      treeCache[p] = data.items;
      renderTree();
    })
    .catch(function() { treeExpanded.delete(p); renderTree(); });
}

function expandPathInTree(targetPath) {
  if (targetPath === '/') { renderTree(); return; }
  var parts = targetPath.split('/');
  var toExpand = [];
  var accum = '';
  for (var i = 0; i < parts.length; i++) {
    accum += (i === 0 ? '' : '/') + parts[i];
    var p = accum || '/';
    treeExpanded.add(p);
    toExpand.push(p);
  }
  var idx = 0;
  function loadNext() {
    if (idx >= toExpand.length) { renderTree(); return; }
    var p = toExpand[idx];
    if (treeCache[p]) { idx++; loadNext(); return; }
    fetch(SHARE_API_BASE + '/tree?path=' + encodeURIComponent(p))
      .then(function(r) { return r.json(); })
      .then(function(data) { treeCache[p] = data.items; idx++; loadNext(); })
      .catch(function() { idx++; loadNext(); });
  }
  loadNext();
}
*/

function toggleSelect(safePath, isDir, checked) {
  var p = decodeURIComponent(safePath);
  if (checked) { browserSelected.add(p); browserSelectedDirs[p] = isDir; }
  else { browserSelected.delete(p); delete browserSelectedDirs[p]; }
  updateBatchToolbar();
}

function updateBatchToolbar() {
  var toolbar = document.getElementById('batchToolbar');
  var count = document.getElementById('batchCount');
  if (browserSelected.size > 0) {
    toolbar.classList.remove('hidden');
    count.textContent = t('selectedCount', { count: browserSelected.size });
  } else {
    toolbar.classList.add('hidden');
  }
}

function clearSelection() {
  browserSelected.clear();
  browserSelectedDirs = {};
  updateBatchToolbar();
  loadBrowser(browserCurrentPath);
}

function batchShare() {
  var paths = Array.from(browserSelected);
  if (paths.length === 0) return;
  var done = 0;
  var urls = [];
  paths.forEach(function(p) {
    var isDir = browserSelectedDirs[p];
    fetch(SHARE_API_BASE + '/share?path=' + encodeURIComponent(p) + '&expiry=' + (isDir ? 1440 : 60))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) urls.push(data.url);
        done++;
        if (done === paths.length) {
          showToast(t('generatedLinks', { count: urls.length }));
          if (urls.length === 1) copyToClipboard(urls[0]);
          else copyToClipboard(urls.join('\n'));
        }
      })
      .catch(function() { done++; });
  });
}

function batchCompress() {
  var paths = Array.from(browserSelected);
  if (paths.length === 0) return;
  showToast(t('compressing'));
  fetch(SHARE_API_BASE + '/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: paths })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        showToast(t('compressDone'));
        copyToClipboard(data.url);
      } else {
        showToast(data.error || t('compressFailed'), true);
      }
    })
    .catch(function() { showToast(t('compressFailed'), true); });
}

function batchDownload() {
  var paths = Array.from(browserSelected);
  if (paths.length === 0) return;
  if (paths.length === 1 && !browserSelectedDirs[paths[0]]) {
    downloadFromBrowser(encodeURIComponent(paths[0]));
    return;
  }
  showToast(t('packaging'));
  fetch(SHARE_API_BASE + '/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: paths })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        window.open(data.url, '_blank');
      } else {
        showToast(data.error || t('packageFailed'), true);
      }
    })
    .catch(function() { showToast(t('packageFailed'), true); });
}

function shareFromBrowser(p, isDir) {
  fetch(SHARE_API_BASE + '/share?path=' + encodeURIComponent(decodeURIComponent(p)) + '&expiry=' + (isDir ? 1440 : 60))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        showToast(t('shareLinkCopied'));
        copyToClipboard(data.url);
      } else {
        showToast(data.error || t('shareFailed'), true);
      }
    })
    .catch(function() { showToast(t('shareFailed'), true); });
}

function downloadFromBrowser(p) {
  var a = document.createElement('a');
  a.href = SHARE_API_BASE + '/download?path=' + encodeURIComponent(decodeURIComponent(p));
  a.target = '_blank';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { document.body.removeChild(a); }, 100);
}

function copyItemPath(p) {
  copyToClipboard(decodeURIComponent(p));
  showToast(t('pathCopied'));
}

function browserHandleFileSelect(e) {
  var files = e.target.files;
  if (files.length > 0) browserUploadFile(files[0]);
  e.target.value = '';
}

function browserHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  var files = e.dataTransfer.files;
  if (files.length > 0) browserUploadFile(files[0]);
}

function browserHandleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}

function browserHandleDragLeave(e) {
  e.currentTarget.classList.remove('dragover');
}

function browserUploadFile(file) {
  var progressBar = document.getElementById('browserProgressBar');
  var progressFill = document.getElementById('browserProgressFill');
  progressBar.classList.add('active');
  progressFill.style.width = '0%';

  var formData = new FormData();
  formData.append('file', file);

  var xhr = new XMLHttpRequest();
  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable) {
      progressFill.style.width = (e.loaded / e.total * 100) + '%';
    }
  };
  xhr.onload = function() {
    progressBar.classList.remove('active');
    if (xhr.status === 200) {
      showToast(t('uploadSuccessShort'));
      loadBrowser(browserCurrentPath);
    } else {
      // v2.3.108: 优先用后端返回的 error 文本 (e.g. "该目录为只读, 请切换到可写目录"), 不要只回退到通用 uploadFailed.
      var msg = t('uploadFailed');
      try { var r = JSON.parse(xhr.responseText); if (r && r.error) msg = r.error; } catch (e) {}
      showToast(msg, true);
    }
  };
  xhr.onerror = function() {
    progressBar.classList.remove('active');
    showToast(t('uploadFailed'), true);
  };
  xhr.open('POST', SHARE_API_BASE + '/upload-to?dir=' + encodeURIComponent(browserCurrentPath));
  xhr.send(formData);
}

// ── File Content Viewer / Editor ──

window.selectFileFromBrowser = function(filePath) {
  if (isBinaryFile(filePath)) {
    document.getElementById('fileContentTitle').innerHTML = svgIcon('file', 'icon-file', 14) + ' ' + filePath.split('/').pop();
    document.getElementById('fileContentBody').innerHTML = fmEmpty(svgIcon('archive', '', 32), t('noTextContent'));
    ocSetDisplay(document.getElementById('fileContentBody'), 'block');
    ocSetDisplay(document.getElementById('fileEditor'), 'none');
    ocSetDisplay(document.getElementById('fileEditButtons'), 'none');
    fCanEdit = false;
    return;
  }

  fCurrentFilePath = filePath;
  fEditing = false;
  document.getElementById('fileContentTitle').innerHTML = svgIcon('file', 'icon-file', 14) + ' ' + filePath.split('/').pop();
  document.getElementById('fileContentBody').innerHTML = fmEmpty('⏳', t('loading'));
  ocSetDisplay(document.getElementById('fileContentBody'), 'block');
  ocSetDisplay(document.getElementById('fileEditor'), 'none');

  var parsed = parseOpenClawPath(filePath);
  if (parsed) {
    fCanEdit = true;
    var url = API_BASE + '/api/files/read?category=' + encodeURIComponent(parsed.category) +
              '&subfolder=' + encodeURIComponent(parsed.subfolder) +
              '&folder=' + encodeURIComponent(parsed.folder) +
              '&file=' + encodeURIComponent(parsed.file);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        fContentCache = data.content || '';
        renderFileContent(fContentCache);
        ocSetDisplay(document.getElementById('fileEditButtons'), 'inline');
        ocSetDisplay(document.getElementById('saveBtn'), 'none');
        ocSetDisplay(document.getElementById('cancelBtn'), 'none');
      })
      .catch(function(e) {
        document.getElementById('fileContentBody').innerHTML = fmEmpty('⚠️', t('loadFailedMsg', { msg: esc(e.message) }));
      });
  } else {
    fCanEdit = false;
    fetch(SHARE_API_BASE + '/download?path=' + encodeURIComponent(filePath))
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function(text) {
        if (text.length > 2 * 1024 * 1024) {
          fContentCache = '';
          renderFileContent(t('fileTooLarge'));
        } else {
          fContentCache = text;
          renderFileContent(text);
        }
        ocSetDisplay(document.getElementById('fileEditButtons'), 'none');
      })
      .catch(function(e) {
        document.getElementById('fileContentBody').innerHTML = fmEmpty('⚠️', t('loadFailedMsg', { msg: esc(e.message) }));
      });
  }
};

function renderFileContent(text) {
  var el = document.getElementById('fileContentBody');
  ocSetDisplay(el, 'block');
  ocSetDisplay(document.getElementById('fileEditor'), 'none');
  el.innerHTML = esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

window.editFile = function() {
  if (!fCanEdit) return;
  ocSetDisplay(document.getElementById('fileContentBody'), 'none');
  var editor = document.getElementById('fileEditor');
  ocSetDisplay(editor, 'block');
  editor.value = fContentCache;
  ocSetDisplay(document.getElementById('saveBtn'), 'inline-block');
  ocSetDisplay(document.getElementById('cancelBtn'), 'inline-block');
  fEditing = true;
};

window.saveFile = function() {
  if (!fCanEdit || !fEditing) return;
  var newContent = document.getElementById('fileEditor').value;
  var parsed = parseOpenClawPath(fCurrentFilePath);
  if (!parsed) {
    showToast(t('saveFailed'), true);
    return;
  }
  fetch(API_BASE + '/api/files/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: parsed.category,
      subfolder: parsed.subfolder,
      folder: parsed.folder,
      file: parsed.file,
      content: newContent
    })
  })
    .then(function(r) {
      if (r.ok) {
        fContentCache = newContent;
        renderFileContent(newContent);
        ocSetDisplay(document.getElementById('saveBtn'), 'none');
        ocSetDisplay(document.getElementById('cancelBtn'), 'none');
        fEditing = false;
        showToast(t('saved'));
      } else {
        showToast(t('saveFailed'), true);
      }
    })
    .catch(function(e) {
      showToast(t('saveFailedMsg', { msg: e.message }), true);
    });
};

window.cancelEdit = function() {
  renderFileContent(fContentCache);
  ocSetDisplay(document.getElementById('saveBtn'), 'none');
  ocSetDisplay(document.getElementById('cancelBtn'), 'none');
  fEditing = false;
};

// Override browser item click for files to open in editor
(function() {
  var origLoadBrowser = loadBrowser;
  loadBrowser = function(p) {
    origLoadBrowser(p);
    var list = document.getElementById('browserList');
    var observer = new MutationObserver(function() {
      list.querySelectorAll('.browser-item').forEach(function(item) {
        if (item._fileClickBound) return;
        item._fileClickBound = true;
        var checkbox = item.querySelector('.browser-checkbox');
        var nameEl = item.querySelector('.browser-item-name');
        if (!nameEl) return;
        var iconEl = item.querySelector('.browser-item-icon');
        if (!iconEl) return;
        var isDir = iconEl.querySelector('.icon-folder') !== null;
        if (!isDir) {
          nameEl.classList.add('oc-clickable');
          nameEl.addEventListener('click', function(e) {
            e.stopPropagation();
            var pathEl = item.querySelector('.browser-item-meta');
            var safePath = '';
            var onclickAttr = item.getAttribute('onclick');
            if (onclickAttr && onclickAttr.indexOf("loadBrowser('") >= 0) return;
            var actionsEl = item.querySelector('.browser-item-actions');
            if (actionsEl) {
              var shareBtn = actionsEl.querySelector('.oc-btn');
              if (shareBtn) {
                var oc = shareBtn.getAttribute('onclick') || '';
                var m = oc.match(/shareFromBrowser\('([^']+)'/);
                if (m) safePath = m[1];
              }
            }
            if (safePath) {
              var filePath = decodeURIComponent(safePath);
              selectFileFromBrowser(filePath);
            }
          });
        }
      });
    });
    observer.observe(list, { childList: true });
  };
})();

// ═══════════════════════════════════════════════════════
//  MEMORY BROWSER
// ═══════════════════════════════════════════════════════

var memAgent = '';
var memFolder = '/';
var memItems = [];
var memFileName = '';
var memEditing = false;

function initMemory() {
  loadAgentMemorySelector();
}

function loadAgentMemorySelector() {
  try {
    var sel = document.getElementById('agentMemorySelect');
    fetch(API_BASE + '/api/agent-workspaces')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(agents) {
        // v2.3.112: option 加 title=全名, select 固定 120px 截断时鼠标 hover 还能看到完整 agent 名.
        sel.innerHTML = '<option value="">' + t('selectAgentPlaceholder') + '</option>' +
          agents.map(function(a) { var name = esc(a.displayName || a.agentId); return '<option value="' + esc(a.agentId) + '" title="' + name + '">' + name + '</option>'; }).join('');
      })
      .catch(function(e) { console.error('loadAgentMemorySelector:', e); });
  } catch (e) { console.error('loadAgentMemorySelector:', e); }
}

window.onAgentMemoryChange = function(agentId) {
  if (!agentId) {
    document.getElementById('memoryListBody').innerHTML = fmEmpty(svgIcon('brain', '', 32), t('selectAgentEmpty'));
    resetMemoryContent();
    return;
  }
  memAgent = agentId;
  memFolder = '/';
  loadAgentMemory(agentId, '/');
};

function loadAgentMemory(agentId, folder) {
  memAgent = agentId;
  memFolder = folder;
  resetMemoryContent();
  updateMemoryBreadcrumb();

  fetch(API_BASE + '/api/agent-files?agent=' + encodeURIComponent(agentId) + '&folder=memory' + (folder === '/' ? '' : '/' + folder))
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(items) {
      memItems = items;
      renderMemoryItems();
      document.getElementById('memoryCountLabel').textContent = t('memoryCount', { count: memItems.length });
    })
    .catch(function(e) {
      console.error('loadAgentMemory:', e);
      document.getElementById('memoryListBody').innerHTML = fmEmpty('⚠️', t('loadFailedMsg', { msg: esc(e.message) }));
    });
}

function renderMemoryItems() {
  var listEl = document.getElementById('memoryListBody');
  if (!memItems.length) {
    listEl.innerHTML = fmEmpty(svgIcon('folder', 'icon-folder', 32), t('emptyDir'));
    return;
  }
  listEl.innerHTML = memItems.map(function(item) {
    var isFolder = item.type === 'folder';
    var icon = isFolder ? svgIcon('folder', 'icon-folder', 16) : fileIcon(item.name, false);
    var action = isFolder ? 'switchMemoryFolder(\'' + esc(item.folder || item.name) + '\')' : 'selectMemoryFile(\'' + esc(item.name) + '\')';
    return '<div class="file-item" onclick="' + action + '">' +
      '<span class="icon">' + icon + '</span>' +
      '<div class="info"><div class="name">' + esc(item.name) + '</div></div>' +
    '</div>';
  }).join('');
}

window.switchMemoryFolder = function(folder) {
  if (!memAgent) return;
  var newFolder = memFolder === '/' ? folder : memFolder + '/' + folder;
  loadAgentMemory(memAgent, newFolder);
};

window.selectMemoryFile = function(name) {
  memFileName = name;
  document.getElementById('memoryContentTitle').innerHTML = svgIcon('file', 'icon-file', 14) + ' ' + name;
  var contentEl = document.getElementById('memoryContentBody');
  contentEl.innerHTML = fmEmpty('⏳', t('loading'));

  var fpath;
  if (name.startsWith('memory/')) fpath = name;
  else fpath = 'memory/' + (memFolder === '/' ? '' : memFolder + '/') + name;

  fetch(API_BASE + '/api/memory-file?agent=' + encodeURIComponent(memAgent) + '&path=' + encodeURIComponent(fpath))
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function(text) {
      contentEl.dataset.original = text;
      renderMemoryContent(text);
      ocSetDisplay(document.getElementById('memoryEditButtons'), 'flex');
      ocSetDisplay(document.getElementById('memoryEditBtn'), 'inline-block');
      ocSetDisplay(document.getElementById('memorySaveBtn'), 'none');
      ocSetDisplay(document.getElementById('memoryCancelBtn'), 'none');
    })
    .catch(function(e) {
      contentEl.innerHTML = '<div class="fm-error-text">' + t('loadFailed') + '</div>';
    });
};

function renderMemoryContent(text) {
  var el = document.getElementById('memoryContentBody');
  ocSetDisplay(el, 'block');
  ocSetDisplay(document.getElementById('memoryEditor'), 'none');
  el.innerHTML = esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

window.editMemoryFile = function() {
  var content = document.getElementById('memoryContentBody').dataset.original || '';
  ocSetDisplay(document.getElementById('memoryContentBody'), 'none');
  var editor = document.getElementById('memoryEditor');
  ocSetDisplay(editor, 'block');
  editor.value = content;
  ocSetDisplay(document.getElementById('memoryEditBtn'), 'none');
  ocSetDisplay(document.getElementById('memorySaveBtn'), 'inline-block');
  ocSetDisplay(document.getElementById('memoryCancelBtn'), 'inline-block');
  memEditing = true;
};

window.saveMemoryFile = function() {
  if (!memFileName || !memAgent || !memEditing) return;
  var editor = document.getElementById('memoryEditor');
  var content = editor.value;
  var saveBtn = document.getElementById('memorySaveBtn');
  saveBtn.textContent = t('saving');
  saveBtn.disabled = true;

  var fpath;
  if (memFileName.startsWith('memory/')) fpath = memFileName;
  else fpath = 'memory/' + (memFolder === '/' ? '' : memFolder + '/') + memFileName;
  fetch(API_BASE + '/api/agent-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: memAgent, path: fpath, content: content })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) throw new Error(data.error || t('saveFailed'));
      saveBtn.textContent = t('saved');
      setTimeout(function() { saveBtn.textContent = t('save'); saveBtn.disabled = false; }, 1200);
      cancelMemoryEdit();
      selectMemoryFile(memFileName);
      loadAgentMemory(memAgent, memFolder);
    })
    .catch(function(e) {
      saveBtn.textContent = t('save');
      saveBtn.disabled = false;
      showToast(t('saveFailedMsg', { msg: e.message }), true);
    });
};

window.cancelMemoryEdit = function() {
  var content = document.getElementById('memoryContentBody').dataset.original || '';
  renderMemoryContent(content);
  ocSetDisplay(document.getElementById('memoryEditBtn'), 'inline-block');
  ocSetDisplay(document.getElementById('memorySaveBtn'), 'none');
  ocSetDisplay(document.getElementById('memoryCancelBtn'), 'none');
  memEditing = false;
};

function resetMemoryContent() {
  document.getElementById('memoryContentTitle').innerHTML = t('selectFile');
  document.getElementById('memoryContentBody').innerHTML = fmEmpty(svgIcon('file', 'icon-file', 32), t('clickToView'));
  ocSetDisplay(document.getElementById('memoryContentBody'), 'block');
  ocSetDisplay(document.getElementById('memoryEditor'), 'none');
  ocSetDisplay(document.getElementById('memoryEditButtons'), 'none');
}

function updateMemoryBreadcrumb() {
  var el = document.getElementById('memoryBreadcrumb');
  el.textContent = memAgent ? 'memory/' + memFolder.replace(/\/$/, '') + '/' : '';
}

window.refreshMemory = function() {
  if (memAgent) loadAgentMemory(memAgent, memFolder);
  else loadAgentMemorySelector();
};

// ═══════════════════════════════════════════════════════
//  DOCS STATS
// ═══════════════════════════════════════════════════════

function loadDocsStats() {
  var container = document.getElementById('docsStatsPanel');
  container.innerHTML = fmEmpty('⏳', t('loading'));
  fetch(API_BASE + '/api/docs-stats')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var coreConfig = new Set(['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','HEARTBEAT.md','USER.md','BOOTSTRAP.md','ENVIRONMENT.md','DREAMS.md']);
      var memoryNames = new Set(['MEMORY.md']);
      var ruleNames = new Set(['AGENT-RULES.template.md','EVENTS.template.md','PROGRESS.template.md','WORKFLOW.template.md']);
      function classify(n) {
        if (coreConfig.has(n)) return 'core';
        if (memoryNames.has(n)) return 'memory';
        if (ruleNames.has(n)) return 'rule';
        return 'project';
      }

      var agents = [];
      var totC = 0, totP = 0, totM = 0, totR = 0;

      (data.workspaces || []).forEach(function(ws) {
        var c = { core: 0, project: 0, memory: 0, rule: 0 };
        (ws.files || []).forEach(function(f) { c[classify(f)]++; });
        if (ws.name === 'main') {
          c.project += (data.mainDocs && data.mainDocs.count) || 0;
          c.memory += (data.memory && data.memory.count) || 0;
          c.rule += (data.sharedRules && data.sharedRules.count) || 0;
        }
        var total = c.core + c.project + c.memory + c.rule;
        if (total > 0) agents.push({ name: ws.name, core: c.core, project: c.project, memory: c.memory, rule: c.rule, total: total });
        totC += c.core; totP += c.project; totM += c.memory; totR += c.rule;
      });

      var swTotal = (data.software || []).reduce(function(s, p) { return s + (p.docCount || 0); }, 0);
      totP += swTotal;
      agents.sort(function(a, b) { return b.total - a.total; });
      var maxTotal = Math.max.apply(null, agents.map(function(a) { return a.total; }).concat([1]));
      var html = '';
      html += '<div class="oc-stat-grid">';
      var mkCard = function(icon, label, count, className) {
        return '<div class="oc-stat-item"><span class="oc-stat-value ' + className + '">' + count + '</span><span class="oc-stat-label">' + icon + ' ' + label + '</span></div>';
      };
      html += mkCard(svgIcon('brain', '', 14), t('agentConfigFiles'), totC, 'fm-stat-core');
      html += mkCard(svgIcon('file-text', '', 14), t('projectDocs'), totP, 'fm-stat-project');
      html += mkCard(svgIcon('brain', '', 14), t('memoryAndRules'), totM + totR, 'fm-stat-memory');
      html += '</div>';

      // 图例上移到标题行右侧（原来挂在 13 行列表的**最底部**，不滚到底根本看不到颜色含义）。
      html += '<div class="fm-dist-head">' +
        '<div class="fm-dist-label">' + t('agentDocsDist') + '</div>' +
        '<div class="fm-legend">' +
        '<span class="fm-legend-item"><span class="fm-legend-dot core"></span> ' + t('coreConfig') + ' (' + totC + ')</span>' +
        '<span class="fm-legend-item"><span class="fm-legend-dot project"></span> ' + t('projectDocsLegend') + ' (' + totP + ')</span>' +
        '<span class="fm-legend-item"><span class="fm-legend-dot memory"></span> ' + t('memoryFiles') + ' (' + totM + ')</span>' +
        '<span class="fm-legend-item"><span class="fm-legend-dot rule"></span> ' + t('ruleFiles') + ' (' + totR + ')</span>' +
        '</div></div>';

      agents.forEach(function(agent) {
        // 保底由 6% 降到 1%（2026-10-10）：原来保底同时作用于条宽与标题标注，
        // 于是最小那行数字失真 —— coder 2 个文件（2/130 = 1.5%）却标成「(6%)」，差 4 倍。
        // 现在标注与条宽统一用**真实占比**，保底只兜住 round 到 0 的极端情况
        // （否则会出现「标 0% 却仍有一条」的矛盾）；条最短也有 .agent-bar-fill 的 min-width:4px 托底。
        var rowPct = Math.max(1, Math.round(agent.total / maxTotal * 100));
        // 分段改用 flex 比例盒（原来用 SVG + preserveAspectRatio="none"）：
        // 非等比缩放的 SVG 会把段内 <text> **水平拉伸变形**，而且那边 font-size
        // 还误用了图标令牌 --oc-icon-2xl（实测 42px）。flex 下文字是普通 HTML，不参与缩放。
        // 段内数字的显示阈值也一并修正：原来是 `p > 15`，完全没考虑该行自身只占多宽，
        // 于是小行的窄段里也硬塞数字。改为按「占整条轨道宽度的比例」判断（p × rowPct）。
        var segs = '';
        ['core','project','memory','rule'].forEach(function(type) {
          var v = agent[type];
          if (v > 0) {
            var p = agent.total > 0 ? (v / agent.total * 100) : 0;
            segs += '<span class="agent-bar-seg agent-bar-seg-' + type + '" style="flex:' + p.toFixed(3) + '" title="' + type + ': ' + v + '">' +
              (p * rowPct >= 250 ? '<i>' + v + '</i>' : '') + '</span>';
          }
        });
        html += '<div class="agent-bar">' +
          '<div class="agent-bar-header"><span class="fm-bar-name">' + agent.name + '</span><span>' + t('agentFileCount', { count: agent.total }) + ' (' + rowPct + '%)</span></div>' +
          '<div class="agent-bar-track" role="img" aria-label="' + esc(agent.name) + '"><div class="agent-bar-fill" style="width:' + rowPct + '%">' + segs + '</div></div></div>';
      });

      container.innerHTML = html;
    })
    .catch(function(e) {
      console.error('loadDocsStats:', e);
      container.innerHTML = fmEmpty('⚠️', t('loadFailed'));
    });
}

// ═══════════════════════════════════════════════════════
//  SHARE PANEL (merged: upload + local share + records)
// ═══════════════════════════════════════════════════════

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('dragover');
}

function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  var files = e.dataTransfer.files;
  if (files.length > 0) uploadShareFile(files[0]);
}

function handleFileSelect(e) {
  var files = e.target.files;
  if (files.length > 0) uploadShareFile(files[0]);
  e.target.value = '';
}

function uploadShareFile(file) {
  var progressBar = document.getElementById('progressBar');
  var progressFill = document.getElementById('progressFill');
  progressBar.classList.add('active');
  progressFill.style.width = '0%';

  var targetDir = (document.getElementById('shareUploadDir')?.value || '/tmp/http-share-uploads').trim();
  if (!targetDir) targetDir = '/tmp/http-share-uploads';

  var formData = new FormData();
  formData.append('file', file);

  var xhr = new XMLHttpRequest();
  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable) {
      progressFill.style.width = (e.loaded / e.total * 100) + '%';
    }
  };
  xhr.onload = function() {
    progressBar.classList.remove('active');
    if (xhr.status === 200) {
      var result = JSON.parse(xhr.responseText);
      var savedPath = result.path || (targetDir + '/' + result.filename);
      showToast(t('uploadSuccessWithPath', { path: savedPath }));
      copyToClipboard(result.url);
      loadShares();
    } else {
      // v2.3.108: 优先用后端返回的 error 文本, 不要只回退到通用 uploadFailed.
      var msg = t('uploadFailed');
      try { var r = JSON.parse(xhr.responseText); if (r && r.error) msg = r.error; } catch (e) {}
      showToast(msg, true);
    }
  };
  xhr.onerror = function() {
    progressBar.classList.remove('active');
    showToast(t('uploadFailed'), true);
  };
  xhr.open('POST', SHARE_API_BASE + '/upload-to?dir=' + encodeURIComponent(targetDir));
  xhr.send(formData);
}

function shareLocal() {
  var path = document.getElementById('localPath').value.trim();
  var expiry = document.getElementById('localExpiry').value;
  if (!path) {
    showToast(t('enterFilePath'), true);
    return;
  }
  fetch(SHARE_API_BASE + '/share?path=' + encodeURIComponent(path) + '&expiry=' + expiry)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        showToast(t('shareLinkGenerated'));
        copyToClipboard(data.url);
        document.getElementById('localPath').value = '';
        loadShares();
      } else {
        showToast(data.error || t('shareFailed'), true);
      }
    })
    .catch(function() { showToast(t('requestFailed'), true); });
}

function loadShares() {
  fetch(SHARE_API_BASE + '/recent')
    .then(function(r) { return r.json(); })
    .then(function(shares) {
      var list = document.getElementById('shareList');
      if (!shares || shares.length === 0) {
        list.innerHTML = fmEmpty('', t('noShares'));
        return;
      }
      var locale = currentLang === 'zh' ? 'zh-CN' : 'en-US';
      list.innerHTML = '<ul class="share-list">' + shares.slice().reverse().map(function(s) {
        var name = s.path.split('/').pop();
        var icon = s.isDirectory ? svgIcon('folder', 'icon-folder', 16) : svgIcon('file', 'icon-file', 16);
        var linkBase = SERVER_IP && SERVER_PORT ? 'http://' + SERVER_IP + ':' + SERVER_PORT : '';
        var shareUrl = linkBase + '/d/' + s.token;
        return '<li class="share-item">' +
          '<div class="share-info">' +
            '<div class="share-name">' + icon + ' ' + esc(name) + '</div>' +
            '<div class="share-meta">' + t('expiryTime') + ': ' + new Date(s.expiresAt).toLocaleString(locale) + ' | ' + t('remaining') + ': ' + getRemainingTime(s.expiresAt) + '</div>' +
          '</div>' +
          '<div class="share-actions">' +
            '<button class="oc-btn oc-btn-sm" onclick="copyToClipboard(\'' + esc(shareUrl) + '\');showToast(t(\'shareLinkCopied\'))">' + t('copyLink') + '</button>' +
            '<button class="oc-btn oc-btn-sm oc-btn-danger" onclick="deleteShare(\'' + s.token + '\')">' + t('deleteBtn') + '</button>' +
          '</div>' +
        '</li>';
      }).join('') + '</ul>';
    })
    .catch(function() {
      document.getElementById('shareList').innerHTML = fmEmpty('', t('noShares'));
    });
}

function deleteShare(token) {
  fetch(SHARE_API_BASE + '/share/' + token, { method: 'DELETE' })
    .then(function() {
      showToast(t('deleted'));
      loadShares();
    })
    .catch(function() { showToast(t('deleteFailed'), true); });
}

// ═══════════════════════════════════════════════════════
//  AUTO-INIT
// ═══════════════════════════════════════════════════════

initFiles();
initMemory();

// ═══════════════════════════════════════════════════════
//  oc-ph-side 工具按钮 (主题 / 语言 / 刷新) - 跟其他模块一致
// ═══════════════════════════════════════════════════════

// 主题按钮 - 切 data-theme + localStorage + postMessage 给父级
(function() {
  var themeBtn = document.getElementById('fmThemeToggle');
  if (!themeBtn) return;
  function updateFmThemeIcon() {
    var cur = localStorage.getItem('openclaw-theme') || 'dark';
    themeBtn.textContent = cur === 'dark' ? '☽' : '☼';
  }
  updateFmThemeIcon();
  themeBtn.addEventListener('click', function() {
    var cur = localStorage.getItem('openclaw-theme') || 'dark';
    var next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('openclaw-theme', next); } catch (e) {}
    updateFmThemeIcon();
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: 'openclaw-theme', theme: next }, location.origin); } catch (e) {}
    }
  });
  // 父级 shell 切主题时同步图标
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'openclaw-theme') updateFmThemeIcon();
  });
})();

// 语言按钮 - 切 setLang + localStorage + postMessage 给父级
(function() {
  var langBtn = document.getElementById('fmLangToggle');
  if (!langBtn) return;
  langBtn.addEventListener('click', function() {
    var next = currentLang === 'zh' ? 'en' : 'zh';
    setLang(next);
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: 'openclaw-lang', lang: next }, location.origin); } catch (e) {}
    }
  });
})();

function refreshLangDynamic() {
  loadBrowser(browserCurrentPath);
  if (memAgent) loadAgentMemory(memAgent, memFolder);
  var docsPanel = document.getElementById('docsPanel');
  if (docsPanel && docsPanel.classList.contains('active')) loadDocsStats();
  var sharePanel = document.getElementById('sharePanel');
  if (sharePanel && sharePanel.classList.contains('active')) loadShares();
  updateMemoryBreadcrumb();
  if (!fCurrentFilePath) document.getElementById('fileContentTitle').innerHTML = t('selectFile');
  if (!memFileName) document.getElementById('memoryContentTitle').innerHTML = t('selectFile');
  updateBatchToolbar();
  // v2.3.106: file-tree 目录树面板已移除, renderTree() 不再存在, 此处移除避免 setLang 触发 ReferenceError 卡死页面.
}
