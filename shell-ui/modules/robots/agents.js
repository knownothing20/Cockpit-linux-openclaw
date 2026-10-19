
function ocSetDisplay(el, mode) {
  if (!el) return;
  const value = mode || '';
  el.hidden = value === 'none';
  el.classList.remove('oc-js-display-block', 'oc-js-display-flex', 'oc-js-display-inline', 'oc-js-display-inline-block');
  if (value && value !== 'none') el.classList.add('oc-js-display-' + value.replace(/[^a-z-]/g, ''));
  // 覆盖旧模板中可能存在的内联 display，否则 hidden=false / oc-js-display-block 会被盖掉。
  el.style.display = value;
}
function ocIsHidden(el) {
  return !el || el.hidden;
}

(() => {

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
  }

  window.copyAnalysis = function(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.textContent || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        showToast(window.t('copySuccess'), 'success');
      }).catch(function() {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
    function fallbackCopy(txt) {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.className = 'oc-js-copy-buffer';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(window.t('copySuccess'), 'success');
      } catch (e) {
        showToast(window.t('copyFail'), 'error');
      }
      document.body.removeChild(ta);
    }
  };

  function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  }

  function formatMs(ms) {
    if (!ms || ms <= 0) return '-';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  // ===== 数字动画 =====
  function animateNumber(el, target, duration) {
    if (!el) return;
    const start = parseInt(el.textContent.replace(/[^0-9]/g, '')) || 0;
    if (start === target) return;
    const startTime = performance.now();
    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / (duration || 600), 1);
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (target - start) * easeProgress);
      el.textContent = current;
      if (progress < 1) requestAnimationFrame(update);
      else {
        el.textContent = target;
        el.classList.add('count-up');
        setTimeout(() => el.classList.remove('count-up'), 300);
      }
    }
    requestAnimationFrame(update);
  }

  // ===== Toast 通知（带图标） =====
  function showToast(msg, type) {
    const existing = document.querySelectorAll('.toast');
    existing.forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = 'toast oc-toast oc-toast-' + (type || 'success');
    const icons = { error: '✕', success: '✓', warning: '⚠', info: 'ⓘ' };
    toast.innerHTML = '<span class="oc-toast-icon robots-toast-icon">' + (icons[type] || icons.info) + '</span><span>' + escapeHtml(msg) + '</span>';
    document.body.appendChild(toast);
    setTimeout(() => { toast.classList.add('oc-toast-exit'); setTimeout(() => toast.remove(), 300); }, 3000);
  }

  function showConfirm(msg, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = '<div class="modal-content"><div class="modal-header"><h3 class="modal-title">' + window.t('confirm') + '</h3><button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">×</button></div><div class="robots-confirm-message">' + escapeHtml(msg) + '</div><div class="oc-flex-gap-8 robots-confirm-actions"><button id="confirmCancel" class="oc-btn">' + window.t('cancel') + '</button><button id="confirmOk" class="oc-btn oc-btn-primary">' + window.t('ok') + '</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#confirmCancel').onclick = () => overlay.remove();
    overlay.querySelector('#confirmOk').onclick = () => { overlay.remove(); onConfirm(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  let availableModels = [];
  let pendingModelChanges = {};
  let pendingGlobalFallbacks = null;
  let currentAgentsData = {};
  let globalAgentActivity = [];
  let agentsTestData = {};
  let agentsRefreshTimer = null;
  let currentSearchFilter = '';
  let wfAgentId = null;
  let wfTimer = null;

  function filterAgents(query) {
    currentSearchFilter = query.toLowerCase().trim();
    if (currentAgentsData.agents) renderAgents(currentAgentsData);
  }

  // ===== 骨架屏加载 =====
  function renderSkeletonGrid() {
    const container = document.getElementById('agentsList');
    if (!container) return;
    let html = '';
    for (let i = 0; i < 6; i++) {
      html += '<div class="oc-card robots-skeleton-card">'
        + '<div class="oc-flex-gap-16 robots-skeleton-header">'
          + '<div class="skeleton robots-skeleton-avatar"></div>'
          + '<div class="robots-skeleton-main">'
            + '<div class="skeleton robots-skeleton-title"></div>'
            + '<div class="skeleton robots-skeleton-subtitle"></div>'
          + '</div>'
        + '</div>'
        + '<div class="skeleton robots-skeleton-strip"></div>'
        + '<div class="robots-skeleton-stats">'
          + '<div class="skeleton robots-skeleton-stat"></div>'
          + '<div class="skeleton robots-skeleton-stat"></div>'
          + '<div class="skeleton robots-skeleton-stat"></div>'
          + '<div class="skeleton robots-skeleton-stat"></div>'
        + '</div>'
        + '<div class="oc-flex-gap-8">'
          + '<div class="skeleton robots-skeleton-action"></div>'
          + '<div class="skeleton robots-skeleton-action"></div>'
          + '<div class="skeleton robots-skeleton-action"></div>'
          + '<div class="skeleton robots-skeleton-action"></div>'
        + '</div>'
      + '</div>';
    }
    container.innerHTML = html;
  }

  async function loadAgentsData() {
    const container = document.getElementById('agentsList');
    if (!container) return;
    const refreshBtn = document.querySelector('.toolbar-card .toolbar-btn-refresh');
    if (refreshBtn) refreshBtn.classList.add('is-loading');
    renderSkeletonGrid();

    try {
      const [agentsRes, modelsRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/models-list')
      ]);

      if (!agentsRes.ok) throw new Error('API Error: ' + agentsRes.status);
      const data = await agentsRes.json();
      if (data.error) throw new Error(data.error);

      globalAgentActivity = (data.agents || []).map(a => ({
        agentId: a.id, name: a.name, emoji: a.emoji, state: a.state || 'offline',
        lastActive: a.session?.lastActive || null, currentActivity: a.currentActivity || null,
        currentModel: null, isFallback: false, subagents: a.subagents || [], recentSubagents: a.recentSubagents || [],
        cronJobs: a.cronJobs || [], health: a.health || null,
      }));

      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        availableModels = [];
        (modelsData.providers || []).forEach(p => {
          (p.models || []).forEach(m => {
            availableModels.push({ id: p.id + '/' + m.id, name: m.name || m.id, provider: p.id });
          });
        });
      }

      renderAgents(data);
      loadHealthBar();
    } catch (e) {
      console.error('Load agents error:', e);
      container.innerHTML = '<div class="oc-empty robots-empty-error">'
        + '<div class="oc-empty-icon">⚠</div>'
        + '<h4>' + window.t('loadFailed') + '</h4>'
        + '<p>' + escapeHtml(e.message) + '</p>'
        + '<button onclick="loadAgentsData()" class="oc-btn oc-btn-sm robots-retry-btn">' + window.t('retry') + '</button>'
        + '</div>';
    } finally {
      const refreshBtn = document.querySelector('.toolbar-card .toolbar-btn-refresh');
      if (refreshBtn) refreshBtn.classList.remove('is-loading');
    }
  }

  async function loadHealthBar() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return;
      const data = await res.json();

      const healthyEl = document.getElementById('healthHealthy');
      const warningEl = document.getElementById('healthWarning');
      const criticalEl = document.getElementById('healthCritical');

      animateNumber(healthyEl, data.healthy || 0, 800);
      animateNumber(warningEl, data.warning || 0, 800);
      animateNumber(criticalEl, data.critical || 0, 800);

      const gwEl = document.getElementById('healthGateway');
      if (data.gateway) {
        gwEl.textContent = data.gateway.status === 'healthy' ? window.t('gatewayNormal') : data.gateway.status === 'degraded' ? window.t('gatewayDegraded') : window.t('gatewayOffline');
        gwEl.className = 'health-value ' + (data.gateway.status === 'healthy' ? 'green' : data.gateway.status === 'degraded' ? 'yellow' : 'red');
      }

      const alertsEl = document.getElementById('healthAlerts');
      if (data.alerts && data.alerts.length > 0) {
        const criticalCount = data.alerts.filter(a => a.level === 'critical').length;
        const warningCount = data.alerts.filter(a => a.level === 'warning').length;
        const summary = criticalCount > 0
          ? window.t('alertSummaryWithCritical', { critical: criticalCount, warning: warningCount })
          : window.t('alertSummaryWarningOnly', { warning: warningCount });
        alertsEl.innerHTML = '<span class="robots-alert-icon">' + (criticalCount > 0 ? '⚠' : 'ⓘ') + '</span> ' + summary;
        alertsEl.classList.add('has-alerts');
        alertsEl.dataset.alerts = JSON.stringify(data.alerts);
      } else {
        alertsEl.classList.remove('has-alerts');
        alertsEl.innerHTML = '';
        alertsEl.dataset.alerts = '';
      }
    } catch (e) {
      console.error('Health bar error:', e);
    } finally {
      const refreshBtn = document.querySelector('.toolbar-card .toolbar-btn-refresh');
      if (refreshBtn) refreshBtn.classList.remove('is-loading');
    }
  }

  function setRefreshInterval(seconds) {
    if (agentsRefreshTimer) clearInterval(agentsRefreshTimer);
    if (seconds > 0) agentsRefreshTimer = setInterval(loadAgentsData, seconds * 1000);
  }

  async function testAllPlatforms() {
    const btn = document.getElementById('btnTestPlatforms');
    btn.innerHTML = '<span class="skeleton robots-btn-loading-skeleton"></span>'; btn.disabled = true;
    try {
      const res = await fetch('/api/test-platforms');
      const data = await res.json();
      if (data.results) {
        const msg = data.results.map(r => r.name + ': ' + (r.ok ? 'OK' : 'FAIL')).join(' ');
        showToast(msg, 'info');
      }
      btn.textContent = window.t('testComplete');
      setTimeout(() => { btn.textContent = window.t('testPlatform'); btn.disabled = false; }, 2000);
    } catch (e) {
      showToast(window.t('testFailed'), 'error');
      btn.textContent = window.t('testPlatform'); btn.disabled = false;
    }
  }

  async function restartGateway() {
    showConfirm(window.t('confirmRestart'), async () => {
      const btn = document.getElementById('btnRestartGateway');
      btn.textContent = window.t('restarting'); btn.disabled = true;
      try {
        const res = await fetch('/api/gateway/restart', { method: 'POST' });
        const data = await res.json();
        if (data.success) { showToast(window.t('gatewayRestarted'), 'success'); btn.textContent = window.t('saved'); }
        else { showToast(window.t('restartFailedReason', { reason: data.error || window.t('unknownError') }), 'error'); btn.textContent = window.t('restartGateway'); btn.disabled = false; }
        setTimeout(() => { btn.textContent = window.t('restartGateway'); btn.disabled = false; }, 2000);
      } catch (e) {
        showToast(window.t('restartFailedReason', { reason: e.message }), 'error'); btn.textContent = window.t('restartGateway'); btn.disabled = false;
      }
    });
  }

  // ===== 健康评分圆环 SVG =====
  function renderHealthRing(score, level) {
    const radius = 18;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;
    const color = level === 'critical' ? 'var(--red)' : level === 'warning' ? 'var(--yellow)' : 'var(--green)';
    const levelClass = level === 'critical' ? 'critical' : level === 'warning' ? 'warning' : 'healthy';
    return '<div class="health-ring">'
      + '<svg width="44" height="44" viewBox="0 0 44 44">'
        + '<circle class="health-ring-bg" cx="22" cy="22" r="' + radius + '"/>'
        + '<circle class="health-ring-fill" cx="22" cy="22" r="' + radius + '" stroke="' + color + '" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"/>'
      + '</svg>'
      + '<div class="health-ring-text ' + levelClass + '">' + score + '</div>'
    + '</div>';
  }

  function renderTaskTracking(agent, act) {
    const isActive = act && (act.state === 'working' || act.state === 'waiting');
    const hasSubagents = act && act.subagents && act.subagents.length > 0;
    const hasRecentSubagents = act && act.recentSubagents && act.recentSubagents.length > 0;
    const hasCronJobs = agent.cronJobs && agent.cronJobs.length > 0;
    const hasActivity = act && act.currentActivity;
    const failedCrons = hasCronJobs ? agent.cronJobs.filter(j => j.consecutiveFailures > 0) : [];

    if (!isActive && !hasSubagents && !hasRecentSubagents && failedCrons.length === 0 && !hasActivity) return '';

    let html = '<div class="task-tracker">';

    if (isActive && hasActivity) {
      const activity = act.currentActivity.length > 80 ? act.currentActivity.substring(0, 80) + '...' : act.currentActivity;
      html += '<div class="task-item">'
        + '<span class="task-indicator"></span>'
        + '<div class="task-content">'
          + '<div class="task-label">' + window.t('liveWork') + '</div>'
          + '<div class="task-text">' + escapeHtml(activity) + '</div>'
        + '</div>'
      + '</div>';
    } else if (hasActivity) {
      const activity = act.currentActivity.length > 80 ? act.currentActivity.substring(0, 80) + '...' : act.currentActivity;
      html += '<div class="task-item task-item-muted">'
        + '<span class="robots-task-muted-marker"></span>'
        + '<div class="task-content">'
          + '<div class="task-text">' + escapeHtml(activity) + '</div>'
        + '</div>'
      + '</div>';
    }

    if (failedCrons.length > 0) {
      const cronId = 'cron-' + agent.id;
      html += '<div class="robots-cron-block">'
        + '<div class="oc-flex-gap-4 robots-cron-toggle" onclick="toggleCronDetail(\'' + cronId + '\')">'
          + '<span id="' + cronId + '-icon">+</span>'
          + '<span>' + window.t('cronAlert') + ' (' + failedCrons.length + ')</span>'
        + '</div>'
        + '<div id="' + cronId + '" hidden>';
      failedCrons.forEach(job => {
        const safeLabel = escapeHtml(job.label || '').replace(/'/g, "\\'");
        const safeLastStatus = escapeHtml(job.lastStatus || '').replace(/'/g, "\\'");
        const safeNextRun = escapeHtml(job.nextRun || '').replace(/'/g, "\\'");
        html += '<div class="oc-flex-gap-6 robots-cron-row" onclick="showCronDetailModal(\'' + safeLabel + '\',' + job.consecutiveFailures + ',\'' + safeLastStatus + '\',\'' + safeNextRun + '\')">'
          + '<span class="robots-cron-x">✕</span>'
          + '<span class="robots-cron-label">' + escapeHtml(job.label) + ' x' + job.consecutiveFailures + '</span>'
          + '<span class="robots-cron-detail">' + window.t('detail') + '</span>'
        + '</div>';
      });
      html += '</div></div>';
    }

    html += '</div>';
    return html;
  }

  function renderAgents(data) {
    currentAgentsData = data;
    const { agents, defaults, gateway } = data;

    const totalTokens = agents.reduce((sum, a) => sum + (a.session?.totalTokens || 0), 0);
    const totalMessages = agents.reduce((sum, a) => sum + (a.session?.messageCount || 0), 0);
    const agentsWithResponse = agents.filter(a => (a.session?.todayAvgResponseMs || 0) > 0);
    const avgResponse = agentsWithResponse.length > 0 ? agentsWithResponse.reduce((sum, a) => sum + (a.session?.todayAvgResponseMs || 0), 0) / agentsWithResponse.length : 0;
    const activityStateMap = new Map((globalAgentActivity || []).map(a => [a.agentId, a]));
    const activeCount = agents.filter(a => { const st = activityStateMap.get(a.id)?.state; return st === 'working' || st === 'waiting'; }).length;

    document.getElementById('agentsCount').textContent = agents.length;

    const activeEl = document.getElementById('agentsActive');
    const tokensEl = document.getElementById('agentsTotalTokens');
    const messagesEl = document.getElementById('agentsTotalMessages');
    const responseEl = document.getElementById('agentsAvgResponse');

    animateNumber(activeEl, activeCount, 600);
    tokensEl.textContent = formatNum(totalTokens);
    messagesEl.textContent = formatNum(totalMessages);
    responseEl.textContent = avgResponse > 0 ? Math.round(avgResponse / 1000) + 's' : '-';

    const gwPort = gateway?.port || 18789;
    const container = document.getElementById('agentsList');
    const activityMap = new Map((globalAgentActivity || []).map(a => [a.agentId, a]));

    const filteredAgents = currentSearchFilter
      ? agents.filter(a => {
          const q = currentSearchFilter;
          return a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) ||
            (a.fullModel || '').toLowerCase().includes(q) ||
            (a.state || '').toLowerCase().includes(q);
        })
      : agents;

    let html = filteredAgents.map(agent => {
      const act = activityMap.get(agent.id) || null;
      const agentState = agent.state || act?.state || 'offline';
      const health = agent.health || act?.health || null;

      const stateConfig = {
        working: { ocCls: 'oc-badge-success', text: window.t('working'), pulse: true },
        waiting: { ocCls: 'oc-badge-warning', text: window.t('waiting'), pulse: true },
        idle: { ocCls: 'oc-badge-warning', text: window.t('slacking'), pulse: false },
        offline: { ocCls: 'oc-badge-default', text: window.t('offDuty'), pulse: false }
      };
      const state = stateConfig[agentState] || stateConfig.idle;

      const currentHost = window.location.hostname || '127.0.0.1';
      const sessionKey = 'agent:' + agent.id + ':main';
      const sessionUrl = 'http://' + currentHost + ':' + gwPort + '/chat?session=' + sessionKey;

      const currentPrimary = pendingModelChanges[agent.id]?.primary || agent.fullModel;

      const taskTrackingHtml = renderTaskTracking(agent, act);

      let healthBadge = '';
      let healthRing = '';
      if (health) {
        healthRing = renderHealthRing(health.score, health.level);
        if (health.level !== 'healthy') {
          const issuesText = (health.issues || []).map(i => i.message).join('\n');
          healthBadge = '<span title="' + escapeHtml(window.t('healthScoreTitle', { score: health.score, issues: issuesText })) + '" class="oc-badge robots-health-badge ' + (health.level === 'critical' ? 'oc-badge-danger' : 'oc-badge-warning') + '">' + health.score + '</span>';
        }
      }

      const stateIndicator = state.pulse
        ? '<span class="pulse-dot' + (agentState === 'waiting' ? ' yellow' : '') + '"></span>'
        : '';

      // 健康状态映射到 oc-card 语义化变体（左边 3px 彩色边框 + 配色）
      const healthCardCls = health && health.level === 'critical' ? ' oc-card-danger'
                          : health && health.level === 'warning'  ? ' oc-card-warning'
                          : '';
      return '<div class="oc-card robots-agent-card' + healthCardCls + '">'
        + '<div class="oc-card-header">'
          + '<div class="agent-avatar">' + escapeHtml(agent.emoji) + '</div>'
          + '<div class="agent-meta">'
            + '<div class="agent-name-row">'
              + '<span class="agent-name">' + escapeHtml(agent.name) + '</span>'
              + stateIndicator
              + '<span class="oc-badge ' + state.ocCls + '">' + state.text + '</span>'
              + healthBadge
            + '</div>'
            + '<div class="agent-id">' + escapeHtml(agent.id) + '</div>'
          + '</div>'
          + (healthRing ? '<div class="robots-health-ring-slot">' + healthRing + '</div>' : '')
        + '</div>'
        + '<div class="oc-card-body agent-card-body">'
          + '<div class="oc-form-group agent-model-section">'
            + '<label>' + window.t('primaryModel') + '</label>'
            + '<select id="primary-model-select-' + agent.id + '" onchange="onPrimaryModelSelect(\'' + agent.id + '\', this.value)" class="oc-select full-width">'
              + availableModels.map(m => '<option value="' + escapeHtml(m.id) + '" ' + (m.id === currentPrimary ? 'selected' : '') + '>' + escapeHtml(m.id.split('/').pop()) + '</option>').join('')
            + '</select>'
          + '</div>'
          + '<div class="oc-stat-grid agent-stats-grid">'
            + '<div class="oc-stat-item"><div class="oc-stat-value oc-stat-value-color-accent">' + formatNum(agent.session?.totalTokens || 0) + '</div><div class="oc-stat-label">' + window.t('tokens') + '</div></div>'
            + '<div class="oc-stat-item"><div class="oc-stat-value oc-stat-value-color-info">' + formatNum(agent.session?.messageCount || 0) + '</div><div class="oc-stat-label">' + window.t('messages') + '</div></div>'
            + '<div class="oc-stat-item"><div class="oc-stat-value robots-stat-purple">' + (agent.session?.sessionCount || 0) + '</div><div class="oc-stat-label">' + window.t('sessions') + '</div></div>'
            + '<div class="oc-stat-item"><div class="oc-stat-value oc-stat-value-color-warning">' + (agent.session?.todayAvgResponseMs ? formatMs(agent.session.todayAvgResponseMs) : '-') + '</div><div class="oc-stat-label">' + window.t('response') + '</div></div>'
          + '</div>'
          + '<div class="agent-actions">'
          + '<button onclick="showModelTestModal(\'' + agent.id + '\')" class="oc-btn oc-btn-secondary oc-btn-sm">' + window.t('test') + '</button>'
          + '<button onclick="saveAgentModelConfig(\'' + agent.id + '\')" id="save-btn-' + agent.id + '" class="oc-btn oc-btn-sm oc-btn-green"' + (pendingModelChanges[agent.id] || pendingGlobalFallbacks !== null ? '' : ' disabled') + '>' + window.t('save') + '</button>'
          + '<button onclick="openWorkflow(\'' + agent.id + '\')" class="oc-btn oc-btn-secondary oc-btn-sm" title="' + window.t('workflow') + '">' + window.t('workflow') + '</button>'
          + '<a href="' + sessionUrl + '" target="_blank" onclick="event.stopPropagation()" class="oc-btn oc-btn-sm oc-btn-accent no-underline" title="' + window.t('openSession') + '">' + window.t('chatSession') + '</a>'
        + '</div>'
        + '</div>'
        + taskTrackingHtml
      + '</div>';
    }).join('');

    const activeAgents = globalAgentActivity.filter(a => {
      if (a.state === 'working' || a.state === 'waiting') return true;
      if (a.subagents && a.subagents.length > 0) return true;
      if (a.recentSubagents && a.recentSubagents.length > 0) return true;
      return false;
    });

    if (activeAgents.length > 0) {
      const stateColors = { working: { cls: 'oc-badge-success', label: window.t('working') }, waiting: { cls: 'oc-badge-warning', label: window.t('waiting') }, idle: { cls: '', label: window.t('idle') } };
      let globalTracking = '<div class="oc-card tracker-panel">';
      globalTracking += '<div class="oc-card-header">';
      globalTracking += '<h3 class="oc-section-title">' + window.t('agentTaskTracking') + '</h3>';
      globalTracking += '</div>';
      globalTracking += '<div class="oc-card-body">';
      globalTracking += '<div class="tracker-list">';
      activeAgents.forEach(act => {
        const stateStyle = stateColors[act.state] || stateColors.idle;
        const agentData = (currentAgentsData?.agents || []).find(a => a.id === act.agentId);
        const primaryModel = agentData?.fullModel || '';
        const primaryShort = primaryModel ? primaryModel.split('/').pop() : '-';
        const pulse = act.state === 'working' || act.state === 'waiting' ? '<span class="pulse-dot robots-pulse-inline"></span>' : '';
        globalTracking += '<div class="tracker-item">';
        globalTracking += '<div class="tracker-item-header">';
        globalTracking += '<span class="tracker-item-avatar">' + escapeHtml(act.emoji || '') + '</span>';
        globalTracking += '<span class="tracker-item-name">' + escapeHtml(act.name || act.agentId) + '</span>';
        globalTracking += pulse;
        globalTracking += '<span class="oc-badge ' + stateStyle.cls + '">' + stateStyle.label + '</span>';
        globalTracking += '</div>';
        globalTracking += '<div class="tracker-item-model">';
        globalTracking += '<span>' + window.t('primaryModelLabel') + '</span><span class="robots-tracker-primary">' + escapeHtml(primaryShort) + '</span>';
        globalTracking += '</div>';
        if (act.currentActivity) {
          const activity = act.currentActivity.length > 60 ? act.currentActivity.substring(0, 60) + '...' : act.currentActivity;
          globalTracking += '<div class="tracker-item-activity">' + escapeHtml(activity) + '</div>';
        }
        globalTracking += '</div>';
      });
      globalTracking += '</div>'; // .tracker-list
      globalTracking += '</div>'; // .oc-card-body
      globalTracking += '</div>'; // .oc-card.tracker-panel
      document.getElementById('agentTaskTracking').innerHTML = globalTracking;
    } else {
      // 没有活跃 agent 时也保留面板，提示当前状态
      document.getElementById('agentTaskTracking').innerHTML =
        '<div class="oc-card tracker-panel">'
        + '<div class="oc-card-header">'
          + '<h3 class="oc-section-title">' + window.t('agentTaskTracking') + '</h3>'
        + '</div>'
        + '<div class="oc-card-body tracker-empty">'
          + '<span class="oc-text-muted">' + window.t('noActiveAgents') + '</span>'
        + '</div>'
      + '</div>';
    }

    container.innerHTML = html;
  }

  // ===== 工作流面板 =====
  function openWorkflow(agentId) {
    wfAgentId = agentId;
    const overlay = document.getElementById('wfOverlay');
    const title = document.getElementById('wfTitle');
    const agent = (currentAgentsData.agents || []).find(a => a.id === agentId);
    title.textContent = window.t('workflow') + ' - ' + (agent ? agent.emoji + ' ' + agent.name : agentId);
    overlay.classList.add('active');
    refreshWorkflow();
    if (wfTimer) clearInterval(wfTimer);
    wfTimer = setInterval(refreshWorkflow, 10000);
  }

  function closeWorkflow() {
    const overlay = document.getElementById('wfOverlay');
    overlay.classList.remove('active');
    if (wfTimer) { clearInterval(wfTimer); wfTimer = null; }
    wfAgentId = null;
  }

  async function refreshWorkflow() {
    if (!wfAgentId) return;
    const stepsEl = document.getElementById('wfSteps');
    stepsEl.innerHTML = '<div class="robots-workflow-state"><div class="skeleton robots-workflow-skeleton"></div></div>';

    try {
      const res = await fetch('/api/agent/' + wfAgentId + '/workflow');
      if (!res.ok) throw new Error('API Error');
      const data = await res.json();

      if (!data.steps || data.steps.length === 0) {
        stepsEl.innerHTML = '<div class="robots-workflow-state">' + window.t('noWorkflowData') + '</div>';
        return;
      }

      const typeLabels = { user: window.t('user'), text: window.t('reply'), toolCall: window.t('tool'), subagent: window.t('subagent'), toolResult: window.t('result') };
      let html = '';
      data.steps.forEach(step => {
        const cls = step.type === 'toolResult' && step.isError ? 'wf-step toolResult error' : 'wf-step ' + step.type;
        let content = '';

        if (step.type === 'user') {
          content = escapeHtml(step.text);
        } else if (step.type === 'text') {
          content = escapeHtml(step.text);
        } else if (step.type === 'toolCall') {
          content = '<b>' + escapeHtml(step.name) + '</b>';
          if (step.params) {
            const params = Object.entries(step.params).map(([k, v]) => k + ': ' + escapeHtml(String(v).substring(0, 60))).join(' · ');
            if (params) content += ' <span class="robots-workflow-note">' + params + '</span>';
          }
        } else if (step.type === 'subagent') {
          content = '<b>→ ' + escapeHtml(step.params?.agentId || '') + '</b>';
          if (step.params?.message) content += ' <span class="robots-workflow-note">' + escapeHtml(step.params.message.substring(0, 60)) + '</span>';
        } else if (step.type === 'toolResult') {
          const icon = step.isError ? '✕' : '✓';
          content = icon + ' ' + (step.name ? '<b>' + escapeHtml(step.name) + '</b> ' : '') + escapeHtml((step.text || '').substring(0, 120));
        }

        const ts = step.ts ? new Date(step.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

        html += '<div class="' + cls + '">'
          + '<div class="wf-step-type ' + step.type + '">' + (typeLabels[step.type] || step.type) + (ts ? ' · ' + ts : '') + (step.tokens ? ' · ' + step.tokens + ' tokens' : '') + '</div>'
          + '<div class="wf-step-text">' + content + '</div>'
        + '</div>';
      });

      stepsEl.innerHTML = html;
      stepsEl.scrollTop = stepsEl.scrollHeight;
    } catch (e) {
      stepsEl.innerHTML = '<div class="robots-workflow-error">' + window.t('loadFailedMsg') + ': ' + escapeHtml(e.message) + '</div>';
    }
  }

  // ===== 通信拓扑 =====
  async function loadTopology() {
    try {
      const res = await fetch('/api/topology');
      if (!res.ok) throw new Error('API Error');
      const data = await res.json();
      drawTopology(data);
      renderTopologyStats(data);
    } catch (e) {
      console.error('Topology error:', e);
    }
  }

  function drawTopology(data) {
    const canvas = document.getElementById('topoCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-body').trim() || getComputedStyle(document.documentElement).getPropertyValue('--oc-bg-canvas').trim() || 'Canvas';
    ctx.fillRect(0, 0, W, H);

    const nodes = data.nodes || [];
    const edges = data.edges || [];
    if (nodes.length === 0) return;

    const nodeMap = {};
    nodes.forEach((n, i) => { nodeMap[n.id] = i; });

    const positions = [];
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.min(W, H) * 0.35;

    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i / nodes.length) - Math.PI / 2;
      positions.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), node: n });
    });

    // 绘制连线（带流动效果）
    edges.forEach(edge => {
      const fromIdx = nodeMap[edge.from];
      const toIdx = nodeMap[edge.to];
      if (fromIdx === undefined || toIdx === undefined) return;
      const from = positions[fromIdx];
      const to = positions[toIdx];

      const count = edge.count || 0;
      let lineWidth, color, dash;

      if (count >= 5) {
        lineWidth = 3; color = 'var(--accent-subtle)'; dash = [];
      } else if (count > 0) {
        lineWidth = 1.5; color = 'var(--accent-subtle)'; dash = [];
      } else {
        lineWidth = 1; color = 'var(--accent-subtle)'; dash = [4, 4];
      }

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const nodeRadius = 28;
      const startX = from.x + (dx / dist) * nodeRadius;
      const startY = from.y + (dy / dist) * nodeRadius;
      const endX = to.x - (dx / dist) * (nodeRadius + 8);
      const endY = to.y - (dy / dist) * (nodeRadius + 8);

      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      // 流动粒子效果（高频调用）
      if (count >= 5) {
        const time = Date.now() / 1000;
        const particlePos = (time % 1);
        const px = startX + (endX - startX) * particlePos;
        const py = startY + (endY - startY) * particlePos;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'var(--accent-subtle)';
        ctx.fill();
      }

      const arrowAngle = Math.atan2(dy, dx);
      const arrowSize = 6;
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - arrowSize * Math.cos(arrowAngle - 0.4), endY - arrowSize * Math.sin(arrowAngle - 0.4));
      ctx.lineTo(endX - arrowSize * Math.cos(arrowAngle + 0.4), endY - arrowSize * Math.sin(arrowAngle + 0.4));
      ctx.closePath();
      ctx.fill();

      if (count > 0) {
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        ctx.fillStyle = 'var(--accent-subtle)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(count + '', midX, midY - 4);
      }
    });

    // 绘制节点（带发光效果）
    positions.forEach((pos, i) => {
      const n = pos.node;
      const hasEdges = edges.some(e => e.from === n.id || e.to === n.id);
      const circleColor = hasEdges ? 'var(--accent-subtle)' : 'var(--accent-subtle)';
      const borderColor = hasEdges ? 'var(--accent-subtle)' : 'var(--accent-subtle)';
      const glowColor = hasEdges ? 'var(--accent-subtle)' : 'var(--accent-subtle)';

      // 发光层
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 32, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 28, 0, Math.PI * 2);
      ctx.fillStyle = circleColor;
      ctx.fill();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();

      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.emoji || '', pos.x, pos.y - 2);

      ctx.font = '11px sans-serif';
      ctx.fillStyle = 'var(--bg-elevated)';
      ctx.textBaseline = 'top';
      const name = n.name.length > 8 ? n.name.substring(0, 8) + '..' : n.name;
      ctx.fillText(name, pos.x, pos.y + 22);

      ctx.font = '9px sans-serif';
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || 'GrayText';
      ctx.fillText(n.id, pos.x, pos.y + 36);
    });

    // 持续动画
    if (document.getElementById('tab-topology').classList.contains('active')) {
      requestAnimationFrame(() => drawTopology(data));
    }
  }

  function renderTopologyStats(data) {
    const statsEl = document.getElementById('topoStats');
    if (!statsEl) return;

    const edges = data.edges || [];
    const nodes = data.nodes || [];
    const bindings = data.bindings || [];

    const activeEdges = edges.filter(e => e.count > 0).sort((a, b) => b.count - a.count);
    const configOnlyEdges = edges.filter(e => e.count === 0);

    let html = '<div class="oc-stat-grid">'
      + '<div class="oc-stat-item"><span class="oc-stat-value robots-stat-accent">' + nodes.length + '</span><span class="oc-stat-label">' + window.t('agentNodes') + '</span></div>'
      + '<div class="oc-stat-item"><span class="oc-stat-value robots-stat-success">' + activeEdges.length + '</span><span class="oc-stat-label">' + window.t('activeCallChains') + '</span></div>'
      + '<div class="oc-stat-item"><span class="oc-stat-value robots-topo-stat-muted">' + configOnlyEdges.length + '</span><span class="oc-stat-label">' + window.t('unusedConfig') + '</span></div>'
    + '</div>';

    if (activeEdges.length > 0) {
      html += '<div class="oc-card robots-topo-card"><h3 class="robots-topo-title-accent">' + window.t('callFrequencyRank') + '</h3>';
      activeEdges.slice(0, 10).forEach(edge => {
        const fromNode = nodes.find(n => n.id === edge.from);
        const toNode = nodes.find(n => n.id === edge.to);
        const pct = Math.min(100, (edge.count / (activeEdges[0]?.count || 1)) * 100);
        html += '<div class="oc-flex-gap-8 robots-topo-row">'
          + '<span>' + (fromNode?.emoji || '') + ' ' + escapeHtml(edge.from) + '</span>'
          + '<span class="robots-topo-arrow">→</span>'
          + '<span>' + (toNode?.emoji || '') + ' ' + escapeHtml(edge.to) + '</span>'
          + '<progress class="robots-topo-bar" max="100" value="' + pct.toFixed(1) + '" aria-label="' + window.t('callFrequencyRank') + '"></progress>'
          + '<span class="robots-topo-count">' + edge.count + '</span>'
        + '</div>';
      });
      html += '</div>';
    }

    if (bindings.length > 0) {
      html += '<div class="oc-card robots-topo-card spaced"><h3 class="robots-topo-title-info">' + window.t('feishuGroupBinding') + '</h3>';
      bindings.forEach(b => {
        const node = nodes.find(n => n.id === b.agentId);
        html += '<div class="oc-flex-gap-8 robots-topo-binding-row">'
          + '<span>' + (node?.emoji || '') + '</span>'
          + '<span class="robots-topo-primary">' + escapeHtml(b.agentId) + '</span>'
          + '<span class="robots-topo-muted-arrow">→</span>'
          + '<span class="robots-topo-info">' + window.t('feishuGroup') + '</span>'
        + '</div>';
      });
      html += '</div>';
    }

    statsEl.innerHTML = html;
  }

  // ===== 模型管理 =====
  function refreshGlobalFallbackPanel() {
    const panel = document.getElementById('globalFallbackPanel');
    if (!panel || ocIsHidden(panel)) return;
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const currentFallbacks = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : globalFallbacks;
    const selectedModels = currentFallbacks.map(id => availableModels.find(m => m.id === id)).filter(Boolean);
    const unselectedModels = availableModels.filter(m => !currentFallbacks.includes(m.id));

    panel.innerHTML = '<div class="robots-fallback-head">'
      + '<span class="robots-fallback-title">' + window.t('globalFallbackModels') + '</span>'
      + '<div class="oc-flex-gap-8">'
        + (pendingGlobalFallbacks !== null ? '<span class="robots-unsaved">' + window.t('unsavedChanges') + '</span>' : '')
        + '<button onclick="saveGlobalFallbacks()" class="oc-btn oc-btn-sm robots-fallback-save ' + (pendingGlobalFallbacks !== null ? '' : 'is-disabled') + '">' + window.t('save') + '</button>'
      + '</div></div>'
      + '<div class="oc-flex-gap-8 robots-fallback-selected">'
        + selectedModels.map((m, idx) => '<div class="robots-fallback-pill"><span class="robots-fallback-index">' + (idx + 1) + '</span><span>' + escapeHtml(m.id.split('/').pop()) + '</span><button onclick="removeFallbackFromPanel(\'' + escapeHtml(m.id) + '\')" class="robots-fallback-remove">×</button></div>').join('')
        + (selectedModels.length === 0 ? '<span class="robots-fallback-empty">' + window.t('noFallbackModels') + '</span>' : '')
      + '</div>'
      + '<div class="oc-flex-gap-6 robots-fallback-options">'
        + unselectedModels.map(m => '<div onclick="addFallbackToPanel(\'' + escapeHtml(m.id) + '\')" class="robots-fallback-chip"><span class="robots-fallback-add-icon">+</span><span>' + escapeHtml(m.id.split('/').pop()) + '</span></div>').join('')
      + '</div>';
  }

  function toggleGlobalFallbackPanel() {
    const panel = document.getElementById('globalFallbackPanel');
    if (!panel) return;
    if (!ocIsHidden(panel)) { ocSetDisplay(panel, 'none'); return; }
    ocSetDisplay(panel, 'block');
    refreshGlobalFallbackPanel();
  }

  function addFallbackToPanel(modelId) {
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const currentList = pendingGlobalFallbacks !== null ? [...pendingGlobalFallbacks] : [...globalFallbacks];
    if (!currentList.includes(modelId)) currentList.unshift(modelId);
    pendingGlobalFallbacks = currentList;
    refreshGlobalFallbackPanel();
  }

  function removeFallbackFromPanel(modelId) {
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const currentList = pendingGlobalFallbacks !== null ? [...pendingGlobalFallbacks] : [...globalFallbacks];
    pendingGlobalFallbacks = currentList.filter(m => m !== modelId);
    refreshGlobalFallbackPanel();
  }

  async function saveGlobalFallbacks() {
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const fallbacksToSave = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : globalFallbacks;
    if (pendingGlobalFallbacks === null) { showToast(window.t('noChangesToSave'), 'warning'); return; }
    try {
      const agents = currentAgentsData.agents || [];
      const savePromises = agents.map(agent => {
        const primary = pendingModelChanges[agent.id]?.primary || agent.fullModel || '';
        return fetch('/api/agent/' + agent.id + '/model', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primary, fallbacks: fallbacksToSave })
        });
      });
      await Promise.allSettled(savePromises);
      pendingGlobalFallbacks = null;
      pendingModelChanges = {};
      try { await loadAgentsData(); } catch (refreshErr) { /* ignore */ }
      showToast(window.t('fallbackSaved'), 'success');
      refreshGlobalFallbackPanel();
    } catch (e) { showToast(window.t('saveFailedReason', { reason: e.message }), 'error'); }
  }

  function openBatchModelConfigModal() {
    const modal = document.getElementById('batchModelConfigModal');
    if (!modal) return;
    const primarySelect = document.getElementById('batchPrimaryModelSelect');
    if (primarySelect) {
      const globalDefaultPrimary = currentAgentsData.defaults?.model?.primary || '';
      const models = availableModels || [];
      primarySelect.innerHTML = '<option value="">' + window.t('keepCurrentPrimary') + '</option>' + models.map(m => '<option value="' + escapeHtml(m.id) + '"' + (m.id === globalDefaultPrimary ? ' selected' : '') + '>' + escapeHtml(m.id) + '</option>').join('');
      primarySelect.onchange = function() { updateBatchModelConfigSummary(); };
    }
    refreshBatchFallbackPanel();
    updateBatchModelConfigSummary();
    ocSetDisplay(modal, 'flex');
    modal.classList.add('active');
  }

  function closeBatchModelConfigModal() {
    const modal = document.getElementById('batchModelConfigModal');
    if (modal) {
      ocSetDisplay(modal, 'none');
      modal.classList.remove('active');
    }
  }

  function refreshBatchFallbackPanel() {
    const panel = document.getElementById('batchFallbackPanel');
    if (!panel) return;
    const models = availableModels || [];
    const selectedModels = (pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : (currentAgentsData.defaults?.model?.fallbacks || [])).map(id => ({ id }));
    const unselectedModels = models.filter(m => !selectedModels.some(s => s.id === m.id));
    panel.innerHTML = '<div class="oc-flex-gap-8 robots-fallback-selected">'
      + selectedModels.map((m, idx) => '<div class="robots-fallback-pill"><span class="robots-fallback-index">' + (idx + 1) + '</span><span>' + escapeHtml(m.id.split('/').pop()) + '</span><button onclick="removeBatchFallback(\'' + escapeHtml(m.id) + '\')" class="robots-fallback-remove">×</button></div>').join('')
      + (selectedModels.length === 0 ? '<span class="robots-fallback-empty">' + window.t('noFallbackModels') + '</span>' : '')
      + '</div>'
      + '<div class="oc-flex-gap-6 robots-fallback-options">'
      + unselectedModels.map(m => '<div onclick="addBatchFallback(\'' + escapeHtml(m.id) + '\')" class="robots-fallback-chip"><span class="robots-fallback-add-icon">+</span><span>' + escapeHtml(m.id.split('/').pop()) + '</span></div>').join('')
      + '</div>';
  }

  function addBatchFallback(modelId) {
    const currentList = pendingGlobalFallbacks !== null ? [...pendingGlobalFallbacks] : [...(currentAgentsData.defaults?.model?.fallbacks || [])];
    if (!currentList.includes(modelId)) currentList.unshift(modelId);
    pendingGlobalFallbacks = currentList;
    refreshBatchFallbackPanel();
    updateBatchModelConfigSummary();
  }

  function removeBatchFallback(modelId) {
    const currentList = pendingGlobalFallbacks !== null ? [...pendingGlobalFallbacks] : [...(currentAgentsData.defaults?.model?.fallbacks || [])];
    pendingGlobalFallbacks = currentList.filter(m => m !== modelId);
    refreshBatchFallbackPanel();
    updateBatchModelConfigSummary();
  }

  function updateBatchModelConfigSummary() {
    const summary = document.getElementById('batchModelConfigSummary');
    const primarySelect = document.getElementById('batchPrimaryModelSelect');
    const primary = primarySelect ? primarySelect.value : '';
    const agents = currentAgentsData.agents || [];
    const fallbacks = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : (currentAgentsData.defaults?.model?.fallbacks || []);
    if (!summary) return;
    summary.innerHTML = '<div><b>' + agents.length + '</b> ' + window.t('agentsWillBeUpdated') + '</div>'
      + '<div>' + window.t('primaryModel') + ': <b>' + (primary ? escapeHtml(primary) : window.t('keepCurrent')) + '</b></div>'
      + '<div>' + window.t('fallbackModels') + ': <b>' + (fallbacks.length ? fallbacks.map(m => escapeHtml(m.split('/').pop())).join(', ') : window.t('none')) + '</b></div>';
  }

  async function saveBatchModelConfig() {
    const primarySelect = document.getElementById('batchPrimaryModelSelect');
    const primary = primarySelect ? primarySelect.value : '';
    const agents = currentAgentsData.agents || [];
    if (!agents.length) { showToast(window.t('noAgents'), 'warning'); return; }
    const fallbacksToSave = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : (currentAgentsData.defaults?.model?.fallbacks || []);
    const saveBtn = document.getElementById('batchModelConfigSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = window.t('saving'); }
    try {
      const savePromises = agents.map(agent => {
        const agentPrimary = primary || agent.fullModel || '';
        return fetch('/api/agent/' + agent.id + '/model', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primary: agentPrimary, fallbacks: fallbacksToSave })
        }).then(async res => {
          const data = await res.json();
          if (!data.success) throw new Error(data.error || window.t('saveFailed'));
          return data;
        });
      });
      await Promise.all(savePromises);
      pendingGlobalFallbacks = null;
      pendingModelChanges = {};
      closeBatchModelConfigModal();
      try { await loadAgentsData(); } catch (refreshErr) { /* ignore */ }
      showToast(window.t('batchModelSaved'), 'success');
    } catch (e) {
      showToast(window.t('saveFailedReason', { reason: e.message }), 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = window.t('batchModelConfigSave'); }
    }
  }

  function onPrimaryModelSelect(agentId, newModel) {
    if (!pendingModelChanges[agentId]) pendingModelChanges[agentId] = { primary: newModel };
    else pendingModelChanges[agentId].primary = newModel;
    if (pendingGlobalFallbacks !== null) pendingGlobalFallbacks = pendingGlobalFallbacks.filter(m => m !== newModel);
    else { const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || []; pendingGlobalFallbacks = globalFallbacks.filter(m => m !== newModel); }
    renderAgents(currentAgentsData);
  }

  function showModelTestModal(agentId) {
    const agent = currentAgentsData.agents?.find(a => a.id === agentId);
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const currentFallbacks = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : globalFallbacks;
    const config = { primary: pendingModelChanges[agentId]?.primary || agent?.fullModel || '', fallbacks: currentFallbacks };
    const modelsToTest = [config.primary, ...config.fallbacks].filter(Boolean);
    const modal = document.createElement('div');
    modal.id = 'modelTestModal';
    modal.className = 'modal-overlay active';
    modal.innerHTML = '<div class="modal-content"><div class="modal-header"><h3 class="modal-title">' + window.t('modelTestTitle', { name: agent?.name || agentId }) + '</h3><button class="modal-close" onclick="closeModelTestModal()">×</button></div><div class="robots-test-model-block"><div class="robots-test-label">' + window.t('modelsToTest') + '</div><div class="oc-flex-gap-4">' + modelsToTest.map(m => '<span class="robots-model-pill">' + escapeHtml(m) + '</span>').join('') + '</div></div><div id="testResults" class="robots-test-results"><div class="robots-test-muted">' + window.t('clickToTest') + '</div></div><div class="oc-flex-gap-8 robots-test-actions"><button onclick="runModelTests(\'' + agentId + '\')" id="runTestBtn" class="oc-btn oc-btn-primary robots-test-run">' + window.t('startTest') + '</button><button onclick="closeModelTestModal()" class="oc-btn">' + window.t('close') + '</button></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModelTestModal(); });
  }

  function closeModelTestModal() { const modal = document.getElementById('modelTestModal'); if (modal) modal.remove(); }

  async function runModelTests(agentId) {
    const agent = currentAgentsData.agents?.find(a => a.id === agentId);
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const currentFallbacks = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : globalFallbacks;
    const config = { primary: pendingModelChanges[agentId]?.primary || agent?.fullModel || '', fallbacks: currentFallbacks };
    const modelsToTest = [config.primary, ...config.fallbacks].filter(Boolean);
    const resultsDiv = document.getElementById('testResults');
    const runBtn = document.getElementById('runTestBtn');
    runBtn.disabled = true; runBtn.textContent = window.t('testing');
    resultsDiv.innerHTML = modelsToTest.map(m => '<div id="result-' + m.replace(/\//g, '_') + '" class="oc-flex-gap-8 robots-test-row"><span class="robots-test-pulse">●</span><span class="robots-test-model">' + escapeHtml(m) + '</span><span class="robots-test-status">' + window.t('testing') + '</span></div>').join('');

    for (const model of modelsToTest) {
      const resultId = 'result-' + model.replace(/\//g, '_');
      const resultEl = document.getElementById(resultId);
      try {
        const res = await fetch('/api/test-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, model }) });
        const data = await res.json();
        const result = data.results?.[0];
        if (result?.ok) { resultEl.innerHTML = '<span class="robots-result-mark ok">✓</span><span class="robots-test-model">' + escapeHtml(model) + '</span><span class="robots-test-status ok">' + (result.message || 'OK') + '</span>'; }
        else { resultEl.innerHTML = '<span class="robots-result-mark fail">✕</span><span class="robots-test-model">' + escapeHtml(model) + '</span><span class="robots-test-status fail">' + escapeHtml(result?.error || result?.message || window.t('failed')) + '</span>'; }
      } catch (e) { resultEl.innerHTML = '<span class="robots-result-mark fail">✕</span><span class="robots-test-model">' + escapeHtml(model) + '</span><span class="robots-test-status fail">' + window.t('requestFailedReason', { reason: e.message }) + '</span>'; }
    }
    runBtn.disabled = false; runBtn.textContent = window.t('retest');
  }

  async function saveAgentModelConfig(agentId) {
    const config = pendingModelChanges[agentId];
    const globalFallbacks = currentAgentsData.defaults?.model?.fallbacks || [];
    const fallbacksToSave = pendingGlobalFallbacks !== null ? pendingGlobalFallbacks : globalFallbacks;
    if (!config && pendingGlobalFallbacks === null) { showToast(window.t('noChangesToSave'), 'warning'); return; }
    const btn = document.getElementById('save-btn-' + agentId);
    btn.textContent = window.t('saving'); btn.disabled = true;
    try {
      const body = JSON.stringify({ primary: config?.primary, fallbacks: fallbacksToSave });
      const res = await fetch('/api/agent/' + agentId + '/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      const data = await res.json();
      if (data.success) {
        if (config) delete pendingModelChanges[agentId];
        pendingGlobalFallbacks = null;
        try { await loadAgentsData(); } catch (refreshErr) { /* ignore, still show success */ }
        showToast(window.t('configSaved'), 'success');
        btn.textContent = window.t('save'); btn.disabled = false;
      } else { showToast(window.t('saveFailedReason', { reason: data.error || window.t('unknownError') }), 'error'); btn.textContent = window.t('failed'); setTimeout(() => { btn.textContent = window.t('save'); btn.disabled = false; }, 2000); }
    } catch (e) { showToast(window.t('saveFailedReason', { reason: e.message }), 'error'); btn.textContent = window.t('error'); setTimeout(() => { btn.textContent = window.t('save'); btn.disabled = false; }, 2000); }
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'navigate') {
      if (event.data.page === 'agents') window.location.href = '/';
    }
  });

  window.loadAgentsData = loadAgentsData;
  window.setRefreshInterval = setRefreshInterval;
  window.testAllPlatforms = testAllPlatforms;
  window.restartGateway = restartGateway;
  window.renderAgents = renderAgents;
  window.toggleGlobalFallbackPanel = toggleGlobalFallbackPanel;
  window.addFallbackToPanel = addFallbackToPanel;
  window.removeFallbackFromPanel = removeFallbackFromPanel;
  window.saveGlobalFallbacks = saveGlobalFallbacks;
  window.onPrimaryModelSelect = onPrimaryModelSelect;
  window.showModelTestModal = showModelTestModal;
  window.closeModelTestModal = closeModelTestModal;
  window.runModelTests = runModelTests;
  window.saveAgentModelConfig = saveAgentModelConfig;
  window.openBatchModelConfigModal = openBatchModelConfigModal;
  window.closeBatchModelConfigModal = closeBatchModelConfigModal;
  window.saveBatchModelConfig = saveBatchModelConfig;
  window.addBatchFallback = addBatchFallback;
  window.removeBatchFallback = removeBatchFallback;
  window.filterAgents = filterAgents;
  window.openWorkflow = openWorkflow;
  window.closeWorkflow = closeWorkflow;
  window.refreshWorkflow = refreshWorkflow;
  window.loadTopology = loadTopology;
  window.toggleHealthAlerts = function() {
    const alertsEl = document.getElementById('healthAlerts');
    const raw = alertsEl.dataset.alerts;
    if (!raw) return;
    const alerts = JSON.parse(raw);

    document.querySelectorAll('.health-alert-modal').forEach(function(m) { m.remove(); });

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay health-alert-modal';

    const closeModal = function() { overlay.remove(); };

    let html = '<div class="modal-content">';
    html += '<div class="modal-header"><h3 class="modal-title">' + window.t('healthAlertDetail') + '</h3><button class="modal-close" id="ha-close-btn">×</button></div>';

    alerts.forEach(function(a, idx) {
      const levelClass = a.level === 'critical' ? 'critical' : 'warning';
      let fixGuide = '';
      if (a.type === 'cron_critical' || a.type === 'cron_warning') {
        fixGuide = window.t('fixGuideCron');
      } else if (a.type === 'auth_error') {
        fixGuide = window.t('fixGuideAuth');
      } else if (a.type === 'slow_response') {
        fixGuide = window.t('fixGuideSlow');
      } else if (a.type === 'cron_offline') {
        fixGuide = window.t('fixGuideOffline');
      }
      html += '<div id="ha-item-' + idx + '" class="robots-health-alert-item ' + levelClass + '">';
      html += '<div class="robots-health-alert-title ' + levelClass + '">' + (a.level === 'critical' ? '⚠ ' + window.t('criticalLabel') : 'ⓘ ' + window.t('warningLabel')) + ' ' + escapeHtml(a.agentId || 'system') + '</div>';
      html += '<div class="robots-health-alert-message">' + escapeHtml(a.message) + '</div>';
      if (a.detail) html += '<div class="robots-health-alert-detail">' + escapeHtml(a.detail).substring(0, 200) + '</div>';
      html += '<div id="ha-fix-' + idx + '" class="robots-health-fix">' + fixGuide + '</div>';
      html += '<button id="ha-fix-btn-' + idx + '" class="oc-btn oc-btn-sm oc-btn-primary robots-health-ai-btn">🤖 ' + window.t('aiAnalysis') + '</button>';
      html += '</div>';
    });

    html += '<div class="robots-modal-close-row"><button id="ha-close-btn2" class="oc-btn">' + window.t('close') + '</button></div>';
    html += '</div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    const btn1 = overlay.querySelector('#ha-close-btn');
    const btn2 = overlay.querySelector('#ha-close-btn2');
    if (btn1) btn1.addEventListener('click', closeModal);
    if (btn2) btn2.addEventListener('click', closeModal);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeModal();
    });

    alerts.forEach(function(a, idx) {
      const fixBtn = overlay.querySelector('#ha-fix-btn-' + idx);
      if (fixBtn) {
        fixBtn.addEventListener('click', function() {
          const fixDiv = overlay.querySelector('#ha-fix-' + idx);
          fixBtn.disabled = true;
          fixBtn.innerHTML = '<span class="robots-inline-loading">●</span> ' + window.t('aiAnalyzing');
          fetch('/api/ai-fix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: a.agentId || 'system', issueType: a.type, issueMessage: a.message, issueDetail: a.detail || '', context: a.level })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
              const analysisId = 'ha-analysis-' + idx;
              fixDiv.innerHTML = '<div class="robots-ai-result-head"><div class="robots-ai-title">🤖 ' + window.t('aiAnalysisResult') + '</div><button class="oc-btn oc-btn-sm robots-copy-btn" onclick="copyAnalysis(\'' + analysisId + '\')">📋 ' + window.t('copyBtn') + '</button></div><div id="' + analysisId + '" class="robots-ai-text">' + escapeHtml(data.fix) + '</div>';
              ocSetDisplay(fixBtn, 'none');
            } else {
              fixBtn.innerHTML = '🤖 ' + window.t('aiAnalysisFailed');
              fixBtn.disabled = false;
              showToast(data.error || window.t('aiAnalysisRequestFailed'), 'error');
            }
          }).catch(function(e) {
            fixBtn.innerHTML = '🤖 ' + window.t('aiAnalysisFailed');
            fixBtn.disabled = false;
            showToast(window.t('aiAnalysisRequestFailedReason', { reason: e.message }), 'error');
          });
        });
      }
    });
  };
  window.toggleCronDetail = function(cronId) {
    const el = document.getElementById(cronId);
    const icon = document.getElementById(cronId + '-icon');
    if (!el) return;
    if (ocIsHidden(el)) {
      ocSetDisplay(el, 'block');
      if (icon) icon.textContent = '-';
    } else {
      ocSetDisplay(el, 'none');
      if (icon) icon.textContent = '+';
    }
  };

  window.showCronDetailModal = function(label, failures, lastStatus, nextRun) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const statusClass = lastStatus === 'success' ? 'ok' : 'fail';
    overlay.innerHTML = '<div class="modal-content">'
      + '<div class="modal-header"><h3 class="modal-title">' + window.t('cronTaskDetail') + '</h3><button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">×</button></div>'
      + '<div class="robots-cron-modal-block">'
        + '<div class="oc-flex-gap-8 robots-cron-modal-title-row"><span class="robots-cron-modal-title">' + escapeHtml(label) + '</span><span class="oc-badge oc-badge-danger">' + window.t('failCount', { count: failures }) + '</span></div>'
        + '<div class="robots-cron-meta-grid">'
          + '<div class="robots-cron-meta-card"><div class="robots-cron-meta-label">' + window.t('lastStatus') + '</div><div class="robots-cron-meta-value ' + statusClass + '">' + (lastStatus || window.t('unknown')) + '</div></div>'
          + '<div class="robots-cron-meta-card"><div class="robots-cron-meta-label">' + window.t('nextRun') + '</div><div class="robots-cron-meta-value">' + (nextRun || '-') + '</div></div>'
        + '</div>'
        + '<div id="cron-fix-guide" class="robots-cron-fix-guide">'
          + '<div class="robots-cron-fix-title">' + window.t('fixSuggestion') + '</div>'
          + '<div class="robots-cron-fix-text">'
            + window.t('fixSuggestionSteps')
          + '</div>'
        + '</div>'
        + '<button id="cron-fix-btn" class="oc-btn oc-btn-primary robots-cron-ai-btn">🤖 ' + window.t('aiAnalysis') + '</button>'
      + '</div>'
      + '<div class="oc-flex-gap-8 robots-modal-actions-end">'
        + '<button onclick="this.closest(\'.modal-overlay\').remove()" class="oc-btn">' + window.t('close') + '</button>'
      + '</div>'
    + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const fixBtn = overlay.querySelector('#cron-fix-btn');
    const fixGuide = overlay.querySelector('#cron-fix-guide');
    if (fixBtn) {
      fixBtn.addEventListener('click', function() {
        fixBtn.disabled = true;
        fixBtn.innerHTML = '<span class="robots-inline-loading">●</span> ' + window.t('aiAnalyzing');
        fetch('/api/ai-fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: 'system', issueType: 'cron_critical', issueMessage: 'Cron "' + label + '" consecutive failures: ' + failures, issueDetail: window.t('lastStatus') + ': ' + (lastStatus || window.t('unknown')), context: 'cron_task' })
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data.success) {
            fixGuide.innerHTML = '<div class="robots-ai-result-head spaced"><div class="robots-ai-title">🤖 ' + window.t('aiAnalysisResult') + '</div><button class="oc-btn oc-btn-sm robots-copy-btn" onclick="copyAnalysis(\'cron-analysis-result\')">📋 ' + window.t('copyBtn') + '</button></div><div id="cron-analysis-result" class="robots-ai-text-md">' + escapeHtml(data.fix) + '</div>';
            ocSetDisplay(fixBtn, 'none');
          } else {
            fixBtn.innerHTML = '🤖 ' + window.t('aiAnalysisFailed');
            fixBtn.disabled = false;
            showToast(data.error || window.t('aiAnalysisRequestFailed'), 'error');
          }
        }).catch(function(e) {
          fixBtn.innerHTML = '🤖 ' + window.t('aiAnalysisFailed');
          fixBtn.disabled = false;
          showToast(window.t('aiAnalysisRequestFailedReason', { reason: e.message }), 'error');
        });
      });
    }
  };

  window.switchTab = function(tab) {
    document.querySelectorAll('.oc-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.oc-tab-content').forEach(c => c.classList.remove('active'));
    var tabEl = document.querySelector('.oc-tab[data-tab="' + tab + '"]');
    var contentEl = document.getElementById('tab-' + tab);
    if (tabEl) tabEl.classList.add('active');
    if (contentEl) contentEl.classList.add('active');
    if (tab === 'topology') loadTopology();
  };




  function initAgents() {
    loadAgentsData();
    setRefreshInterval(0);
  }
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    initAgents();
  } else {
    document.addEventListener('DOMContentLoaded', initAgents);
  }
})();
