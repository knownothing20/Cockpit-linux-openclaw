
/* Memory Monitor - app.js */

var inShell = window.location.pathname.startsWith('/apps/');
var API_BASE = inShell ? '/apps/memory' : (window._apiBase || '');

var _killTarget = null; // { pid, name }

// ── Helpers ──

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  var val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Theme ──

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

// ── Render: Memory Bars ──

function renderBars(mem) {
  var el = document.getElementById('memBars');
  if (!mem) { el.innerHTML = '<div class="oc-empty-hint">暂无数据</div>'; return; }
  var total = mem.total || 1;
  var bars = [
    { label: '已用', value: mem.used, className: 'oc-meter--danger' },
    { label: '缓存', value: mem.cached, className: 'oc-meter--accent' },
    { label: '缓冲', value: mem.buffers, className: 'oc-meter--warning' }
  ];
  var html = '';
  bars.forEach(function(b) {
    var pct = Math.min((b.value / total) * 100, 100).toFixed(1);
    html += '<div class="oc-meter-row">' +
      '<span class="oc-meter-label">' + b.label + '</span>' +
      '<progress class="oc-meter-track ' + b.className + '" max="100" value="' + pct + '" aria-label="' + b.label + '"></progress>' +
      '<span class="oc-meter-value">' + formatBytes(b.value) + ' (' + pct + '%)</span>' +
      '</div>';
  });
  el.innerHTML = html;
}

// ── Render: Memory Stats ──

function renderStats(mem) {
  var el = document.getElementById('memStats');
  if (!mem) { el.innerHTML = ''; return; }
  var items = [
    { label: '总计', value: formatBytes(mem.total) },
    { label: '已用', value: formatBytes(mem.used) },
    { label: '空闲', value: formatBytes(mem.free) },
    { label: '缓存', value: formatBytes(mem.cached) },
    { label: '缓冲', value: formatBytes(mem.buffers) },
    { label: '可用', value: formatBytes(mem.available) }
  ];
  var html = '';
  items.forEach(function(s) {
    html += '<div class="oc-stat-item"><span class="oc-stat-label">' + s.label + '</span><span class="oc-stat-value">' + s.value + '</span></div>';
  });
  el.innerHTML = html;
}

// ── Render: Process Table ──

function renderProcesses(processes) {
  var tbody = document.getElementById('processTbody');
  var countEl = document.getElementById('processCount');
  if (!processes || !processes.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="oc-empty-row">暂无进程数据</td></tr>';
    countEl.textContent = '共 0 个进程';
    return;
  }
  countEl.textContent = '共 ' + processes.length + ' 个进程';
  var html = '';
  processes.forEach(function(p) {
    html += '<tr>' +
      '<td>' + esc(p.pid) + '</td>' +
      '<td>' + esc(p.name) + '</td>' +
      '<td>' + formatBytes(p.memory) + '</td>' +
      '<td>' + (p.percent != null ? p.percent.toFixed(1) + '%' : '-') + '</td>' +
      '<td title="' + esc(p.command) + '">' + esc(p.command) + '</td>' +
      '<td><button class="oc-btn oc-btn-sm oc-btn-danger" onclick="initKill(' + p.pid + ',\'' + esc(p.name).replace(/'/g, "\\'") + ')">终止</button></td>' +
      '</tr>';
  });
  tbody.innerHTML = html;
}

// ── Render: Groups ──

function renderGroups(groups) {
  var el = document.getElementById('groupsList');
  if (!groups || !groups.length) {
    el.innerHTML = '<div class="oc-empty-hint">暂无分组数据</div>';
    return;
  }
  var html = '';
  groups.forEach(function(g, idx) {
    html += '<div class="oc-collapse-item" id="groupItem' + idx + '">' +
      '<div class="oc-collapse-header" onclick="toggleGroup(' + idx + ')">' +
      '<span class="oc-collapse-arrow" id="groupArrow' + idx + '">▶</span>' +
      '<span class="oc-collapse-title">' + esc(g.name) + '</span>' +
      '<span class="oc-collapse-meta">' + formatBytes(g.memory) + '</span>' +
      '<span class="oc-collapse-count">' + g.processes.length + ' 进程</span>' +
      '</div>' +
      '<div class="oc-collapse-body" id="groupBody' + idx + '">';
    g.processes.forEach(function(p) {
      html += '<div class="oc-collapse-row">' +
        '<span class="oc-collapse-pid">PID ' + esc(p.pid) + '</span>' +
        '<span class="oc-collapse-cmd">' + esc(p.name) + '</span>' +
        '<span class="oc-collapse-mem">' + formatBytes(p.memory) + '</span>' +
        '</div>';
    });
    html += '</div></div>';
  });
  el.innerHTML = html;
}

function toggleGroup(idx) {
  var item = document.getElementById('groupItem' + idx);
  if (!item) return;
  item.classList.toggle('is-open');
}

// ── Kill Flow ──

function initKill(pid, name) {
  _killTarget = { pid: pid, name: name };
  document.getElementById('killModalBody').innerHTML =
    '<p>确定要终止进程 <strong>' + esc(name) + '</strong> (PID: ' + pid + ') 吗？</p>';
  document.getElementById('killModal').classList.add('active');
}

function closeKillModal() {
  document.getElementById('killModal').classList.remove('active');
  _killTarget = null;
}

function confirmKillStep1() {
  if (!_killTarget) return;
  document.getElementById('killModal').classList.remove('active');
  document.getElementById('killModal2Body').innerHTML =
    '<p>二次确认：即将终止 <strong>' + esc(_killTarget.name) + '</strong> (PID: ' + _killTarget.pid + ')，此操作不可逆。</p>';
  document.getElementById('killModal2').classList.add('active');
}

function closeKillModal2() {
  document.getElementById('killModal2').classList.remove('active');
  _killTarget = null;
}

function confirmKillStep2() {
  if (!_killTarget) return;
  var pid = _killTarget.pid;
  var name = _killTarget.name;
  document.getElementById('killConfirmBtn2').disabled = true;
  document.getElementById('killConfirmBtn2').textContent = '终止中...';

  fetch(API_BASE + '/api/kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: pid })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    document.getElementById('killModal2').classList.remove('active');
    document.getElementById('killConfirmBtn2').disabled = false;
    document.getElementById('killConfirmBtn2').textContent = '确定终止 (不可逆)';
    _killTarget = null;
    refresh();
  })
  .catch(function(err) {
    document.getElementById('killModal2').classList.remove('active');
    document.getElementById('killConfirmBtn2').disabled = false;
    document.getElementById('killConfirmBtn2').textContent = '确定终止 (不可逆)';
    alert('终止失败: ' + err.message);
  });
}

// ── Refresh ──

function refresh() {
  fetch(API_BASE + '/api/processes')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      var mem = data.system || {};
      if (mem.free == null) mem.free = mem.available;
      var processes = (data.processes || []).map(function(p) {
        return { pid: p.pid, name: p.comm, memory: p.rss, percent: p.memPct, command: p.args };
      });
      var groups = (data.groups || []).map(function(g) {
        return {
          name: g.name,
          memory: g.rss,
          processes: (g.processes || []).map(function(p) {
            return { pid: p.pid, name: p.comm, memory: p.rss };
          })
        };
      });
      renderBars(mem);
      renderStats(mem);
      renderProcesses(processes);
      renderGroups(groups);
    })
    .catch(function(err) {
      document.getElementById('memBars').innerHTML = '<div class="oc-empty-hint">加载失败: ' + esc(err.message) + '</div>';
      document.getElementById('memStats').innerHTML = '';
      document.getElementById('processTbody').innerHTML = '<tr><td colspan="6" class="oc-empty-row">加载失败</td></tr>';
      document.getElementById('groupsList').innerHTML = '<div class="oc-empty-hint">加载失败</div>';
    });
}

// ── Init ──

refresh();
