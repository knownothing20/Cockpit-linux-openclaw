
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

'use strict';

var translations = {
  zh: {
    'pageTitle': '模型管理',
    'pageSubtitle': '统一管理系统与 Agent 可用的大模型配置、默认模型、备用链路和能力标签。',
    'providers': 'Providers',
    'models': 'Models',
    'source': '来源',
    'systemConfig': '🖥️ 系统配置',
    'systemConfigFull': '🖥️ 系统配置 (openclaw.json)',
    'default': '默认',
    'fallback': 'Fallback',
    'batchTestAll': '🚀 批量测试全部模型',
    'batchTestAllText': '批量测试全部模型',
    'fetchModels': '📡 拉取模型',
    'fetchModelsBtn': '📡 拉取模型',
    'clearResults': '🗑️ 清空结果',
    'add': '➕ 添加',
    'legend': '图例',
    'legendDefault': '🌟 默认',
    'systemDefault': '系统默认',
    'legendFallback': '🔗 Fallback',
    'fallbackAlt': '备用',
    'legendAgent': '🤖 Agent',
    'user': '使用者',
    'configuredCtx': '已配置CTX',
    'defaultCtx': '默认CTX',
    'supportsImage': '支持图片',
    'cliproxyComparison': '📡 远端模型对比',
    'configured': '已配置',
    'new': '新增',
    'expired': '过期',
    'addAllNew': '➕ 添加全部新增',
    'removeAllExpired': '🗑️ 删除全部过期',
    'batchTestResults': '⚡ 批量模型测试结果',
    'preparingTest': '准备测试...',
    'thModel': '🤖 模型',
    'thLatency': '⏱️ 延迟',
    'thInput': '📥 输入',
    'thOutput': '📤 输出',
    'thTime': '🕐 时间',
    'thStatus': '📊 状态',
    'addModelTitle': '➕ 添加模型',
    'labelProvider': 'Provider *',
    'selectProvider': '选择 Provider',
    'labelModelId': '模型 ID *',
    'labelDisplayName': '显示名称',
    'labelContextWindow': '上下文窗口',
    'cancel': '取消',
    'addBtn': '添加',
    'editModelTitle': '✏️ 编辑模型',
    'labelModelIdReadonly': '模型 ID',
    'save': '保存',
    'loading': '加载中...',
    'loadFailed': '加载失败: ',
    'noModelsConfig': '暂无模型配置',
    'noModels': '暂无模型',
    'thModelCol': '模型',
    'thLatencyCol': '延迟',
    'thActions': '操作',
    'usedBy': '使用者:',
    'defaultBadge': '🌟 默认',
    'fallbackBadge': '🔗 Fallback',
    'apiKey': '🔑 API Key',
    'auth': '🔐 Auth',
    'configuredCtxTooltip': '已配置上下文窗口',
    'defaultCtxTooltip': '默认上下文窗口 (未显式配置)',
    'supportsImageTooltip': '支持图片输入 (Vision)',
    'textOnlyTooltip': '仅支持文本输入',
    'fillProviderAndModelId': '请填写 Provider 和模型 ID',
    'addFailed': '添加失败: ',
    'saveFailed': '保存失败: ',
    'confirmDelete': '确定要删除模型 {provider}/{modelId} 吗?',
    'deleteFailed': '删除失败: ',
    'testing': '⏳ 测试中...',
    'testingInProgress': '测试中...',
    'testBtn': '🧪 测试',
    'testSuccess': '✅ {provider}/{modelId}\n延迟: {latency}ms\n输入: {input}\n输出: {output}',
    'testFailed': '❌ {provider}/{modelId}\n错误: {error}',
    'testFailedGeneral': '测试失败: ',
    'testFailedLabel': '测试失败',
    'noModelsToTest': '没有可测试的模型',
    'testingProgress': '正在测试 {current} / {total}',
    'testComplete': '测试完成',
    'pass': '✅ 通过',
    'fail': '❌ 失败',
    'batchTestFailed': '批量测试失败: ',
    'fetching': '⏳ 拉取中...',
    'errorLabel': '错误: ',
    'fetchFailed': '拉取失败: ',
    'noRemoteModels': '暂无远程模型',
    'remove': '🗑️ 移除',
    'addCliproxy': '➕ 添加',
    'removedFromRemote': '已从远程下架',
    'deleteBtn': '🗑️ 删除',
    'noNewModels': '没有新增模型',
    'addedModels': '已添加 {added}/{total} 个新模型',
    'noExpiredModels': '没有过期模型',
    'confirmDeleteExpired': '确定删除 {count} 个过期模型?',
    'removedExpiredModels': '已删除 {removed}/{total} 个过期模型',
    'ctxHeader': 'CTX',
    'reasonHeader': 'REASON',
    'agentOption': '🤖 {id}',
    'phModelId': '例如: gpt-4o',
    'phDisplayName': '例如: GPT-4o',
    'addModelPickerTitle': '📡 从 Cliproxy 拉取后选择',
    'addModelPickerFetch': '🔄 拉取',
    'addModelPickerHint': '点击 拉取 加载远程模型列表',
    'manageProviders': '🏷️ 管理提供方',
    'newProviderTitle': '➕ 新建提供方',
    'labelProviderId': '提供方 ID *',
    'labelProviderApi': 'API 类型 *',
    'labelProviderBaseUrl': 'Base URL',
    'labelProviderApiKey': 'API Key',
    'createProviderBtn': '➕ 新建',
    'close': '关闭',
    'providerModels': '{count} 个模型',
    'providerEmpty': '无模型',
    'providerRefs': '⚠ 被 {count} 处引用',
    'providerNoBaseUrl': '未设 baseUrl',
    'providerHasKey': '已配 Key',
    'noProviders': '暂无提供方',
    'providerIdApiRequired': '提供方 ID 与 API 类型必填',
    'providerIdInvalid': '提供方 ID 只能用小写字母/数字/连字符/下划线，且以字母或数字开头（2-32 位）',
    'confirmCreateProvider': '确定新建提供方「{id}」？（会先备份 openclaw.json）',
    'providerCreated': '已新建提供方「{id}」',
    'createFailed': '新建失败: ',
    'confirmDeleteProvider': '确定删除提供方「{id}」？（会先备份 openclaw.json）',
    'providerForceHint': '该提供方仍被使用，强制删除会让引用它的模型不可用。',
    'providerDeleted': '已删除提供方「{id}」',
    'deleteFailed': '删除失败: ',
    'proxyProviderLabel': '提供方',
    'noPullableProvider': '没有可拉取的提供方 —— 请先新建一个配了 Base URL 的 provider',
    'noPullableProviderShort': '无可拉取提供方',
    'modelBindings': '🎯 模型绑定',
    'defaultModelSection': '默认模型',
    'agentModelSection': '各 Agent 模型',
    'remapSection': '批量改指',
    'remapFrom': '从提供方',
    'remapTo': '改指到',
    'remapHint': '只对「目标提供方下存在同名模型」的绑定生效，改不了的会列出来让你手动选。',
    'remapRun': '执行批量改指',
    'addFallback': '➕ 添加 Fallback',
    'bindingPrimary': '默认',
    'bindingFallback': 'Fallback',
    'bindingDangling': '⚠ 失效（provider 或模型不存在）',
    'selectModel': '选择模型',
    'noAgents': '无 Agent',
    'confirmSaveBindings': '确定保存模型绑定？（会先备份 openclaw.json）',
    'bindingsSaved': '模型绑定已保存',
    'saveBindingsFailed': '保存失败: ',
    'remapNeedBoth': '「从提供方」和「改指到」都要选',
    'remapSameProvider': '两边不能是同一个提供方',
    'confirmRemap': '把指向「{from}」的绑定改指到「{to}」？（会先备份 openclaw.json）',
    'remapDone': '已改指 {count} 处绑定',
    'remapSkipped': '以下绑定没改（目标提供方下没有同名模型），请手动选：',
    'saveBindings': '保存'
  },
  en: {
    'pageTitle': 'Models Manager',
    'pageSubtitle': 'Manage system and Agent model configurations, defaults, fallback routes, and capability tags.',
    'providers': 'Providers',
    'models': 'Models',
    'source': 'Source',
    'systemConfig': '🖥️ System Config',
    'systemConfigFull': '🖥️ System Config (openclaw.json)',
    'default': 'Default',
    'fallback': 'Fallback',
    'batchTestAll': '🚀 Batch Test All',
    'batchTestAllText': 'Batch Test All',
    'fetchModels': '📡 Fetch Models',
    'fetchModelsBtn': '📡 Fetch Models',
    'clearResults': '🗑️ Clear Results',
    'add': '➕ Add',
    'legend': 'Legend',
    'legendDefault': '🌟 Default',
    'systemDefault': 'System default',
    'legendFallback': '🔗 Fallback',
    'fallbackAlt': 'Fallback',
    'legendAgent': '🤖 Agent',
    'user': 'Used by',
    'configuredCtx': 'Configured CTX',
    'defaultCtx': 'Default CTX',
    'supportsImage': 'Image support',
    'cliproxyComparison': '📡 Remote Model Comparison',
    'configured': 'Configured',
    'new': 'New',
    'expired': 'Expired',
    'addAllNew': '➕ Add All New',
    'removeAllExpired': '🗑️ Remove All Expired',
    'batchTestResults': '⚡ Batch Test Results',
    'preparingTest': 'Preparing...',
    'thModel': '🤖 Model',
    'thLatency': '⏱️ Latency',
    'thInput': '📥 Input',
    'thOutput': '📤 Output',
    'thTime': '🕐 Time',
    'thStatus': '📊 Status',
    'addModelTitle': '➕ Add Model',
    'labelProvider': 'Provider *',
    'selectProvider': 'Select Provider',
    'labelModelId': 'Model ID *',
    'labelDisplayName': 'Display Name',
    'labelContextWindow': 'Context Window',
    'cancel': 'Cancel',
    'addBtn': 'Add',
    'editModelTitle': '✏️ Edit Model',
    'labelModelIdReadonly': 'Model ID',
    'save': 'Save',
    'loading': 'Loading...',
    'loadFailed': 'Load failed: ',
    'noModelsConfig': 'No model configurations',
    'noModels': 'No models',
    'thModelCol': 'Model',
    'thLatencyCol': 'Latency',
    'thActions': 'Actions',
    'usedBy': 'Used by:',
    'defaultBadge': '🌟 Default',
    'fallbackBadge': '🔗 Fallback',
    'apiKey': '🔑 API Key',
    'auth': '🔐 Auth',
    'configuredCtxTooltip': 'Configured context window',
    'defaultCtxTooltip': 'Default context window (not explicitly configured)',
    'supportsImageTooltip': 'Supports image input (Vision)',
    'textOnlyTooltip': 'Text input only',
    'fillProviderAndModelId': 'Please fill in Provider and Model ID',
    'addFailed': 'Add failed: ',
    'saveFailed': 'Save failed: ',
    'confirmDelete': 'Are you sure you want to delete model {provider}/{modelId}?',
    'deleteFailed': 'Delete failed: ',
    'testing': '⏳ Testing...',
    'testingInProgress': 'Testing...',
    'testBtn': '🧪 Test',
    'testSuccess': '✅ {provider}/{modelId}\nLatency: {latency}ms\nInput: {input}\nOutput: {output}',
    'testFailed': '❌ {provider}/{modelId}\nError: {error}',
    'testFailedGeneral': 'Test failed: ',
    'testFailedLabel': 'Test failed',
    'noModelsToTest': 'No models to test',
    'testingProgress': 'Testing {current} / {total}',
    'testComplete': 'Test complete',
    'pass': '✅ Pass',
    'fail': '❌ Fail',
    'batchTestFailed': 'Batch test failed: ',
    'fetching': '⏳ Fetching...',
    'errorLabel': 'Error: ',
    'fetchFailed': 'Fetch failed: ',
    'noRemoteModels': 'No remote models',
    'remove': '🗑️ Remove',
    'addCliproxy': '➕ Add',
    'removedFromRemote': 'Removed from remote',
    'deleteBtn': '🗑️ Delete',
    'noNewModels': 'No new models',
    'addedModels': 'Added {added}/{total} new models',
    'noExpiredModels': 'No expired models',
    'confirmDeleteExpired': 'Delete {count} expired models?',
    'removedExpiredModels': 'Removed {removed}/{total} expired models',
    'ctxHeader': 'CTX',
    'reasonHeader': 'REASON',
    'agentOption': '🤖 {id}',
    'phModelId': 'e.g. gpt-4o',
    'phDisplayName': 'e.g. GPT-4o',
    'addModelPickerTitle': '📡 Pull from Cliproxy and select',
    'addModelPickerFetch': '🔄 Pull',
    'addModelPickerHint': 'Click Pull to load remote models',
    'manageProviders': '🏷️ Manage Providers',
    'newProviderTitle': '➕ New Provider',
    'labelProviderId': 'Provider ID *',
    'labelProviderApi': 'API type *',
    'labelProviderBaseUrl': 'Base URL',
    'labelProviderApiKey': 'API Key',
    'createProviderBtn': '➕ Create',
    'close': 'Close',
    'providerModels': '{count} models',
    'providerEmpty': 'no models',
    'providerRefs': '⚠ referenced {count}×',
    'providerNoBaseUrl': 'no baseUrl',
    'providerHasKey': 'key set',
    'noProviders': 'No providers',
    'providerIdApiRequired': 'Provider ID and API type are required',
    'providerIdInvalid': 'Provider ID must be lowercase letters/digits/hyphen/underscore, starting with a letter or digit (2-32 chars)',
    'confirmCreateProvider': 'Create provider "{id}"? (openclaw.json will be backed up first)',
    'providerCreated': 'Provider "{id}" created',
    'createFailed': 'Create failed: ',
    'confirmDeleteProvider': 'Delete provider "{id}"? (openclaw.json will be backed up first)',
    'providerForceHint': 'This provider is still in use — force-deleting will break the models that reference it.',
    'providerDeleted': 'Provider "{id}" deleted',
    'deleteFailed': 'Delete failed: ',
    'proxyProviderLabel': 'Provider',
    'noPullableProvider': 'No pullable provider — create one with a Base URL first',
    'noPullableProviderShort': 'No provider',
    'modelBindings': '🎯 Model Bindings',
    'defaultModelSection': 'Default model',
    'agentModelSection': 'Per-agent models',
    'remapSection': 'Bulk re-point',
    'remapFrom': 'From provider',
    'remapTo': 'Re-point to',
    'remapHint': 'Only bindings whose model id also exists under the target provider are re-pointed; the rest are listed for you to pick manually.',
    'remapRun': 'Run bulk re-point',
    'addFallback': '➕ Add fallback',
    'bindingPrimary': 'Default',
    'bindingFallback': 'Fallback',
    'bindingDangling': '⚠ broken (provider or model missing)',
    'selectModel': 'Select model',
    'noAgents': 'No agents',
    'confirmSaveBindings': 'Save model bindings? (openclaw.json will be backed up first)',
    'bindingsSaved': 'Model bindings saved',
    'saveBindingsFailed': 'Save failed: ',
    'remapNeedBoth': 'Pick both "From provider" and "Re-point to"',
    'remapSameProvider': 'The two providers must differ',
    'confirmRemap': 'Re-point bindings from "{from}" to "{to}"? (openclaw.json will be backed up first)',
    'remapDone': 'Re-pointed {count} binding(s)',
    'remapSkipped': 'These bindings were NOT changed (no same-named model under the target provider) — pick manually:',
    'saveBindings': 'Save'
  }
};

var currentLang = localStorage.getItem('openclaw-lang') || 'zh';

function t(key, params) {
  var text = (translations[currentLang] && translations[currentLang][key]) || (translations['zh'] && translations['zh'][key]) || key;
  if (params) {
    Object.keys(params).forEach(function(k) {
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
    });
  }
  return text;
}

function setLang(lang) {
  if (lang !== 'zh' && lang !== 'en') lang = 'zh';
  currentLang = lang;
  localStorage.setItem('openclaw-lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
  if (typeof window.refreshLangDynamic === 'function') window.refreshLangDynamic();
}

window.onShellLangChange = function(lang) {
  setLang(lang);
};

window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'openclaw-lang') {
    setLang(e.data.lang);
  }
});

/* ================= Models Manager Embed ================= */

(function() {
  const API_BASE = window._apiBase || '';

  let currentModelsData = { providers: [], agents: [], defaults: {} };
  let currentModelSource = 'system';
  let allAgentModels = {};

  function $id(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function dataAttr(value) {
    return escapeHtml(value);
  }

  function api(path) {
    return API_BASE + path;
  }

  function localeStr() {
    return currentLang === 'en' ? 'en-US' : 'zh-CN';
  }

  async function fetchJSON(path, opts) {
    const res = await fetch(api(path), opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }


  function showToast(msg, type) {
    var existing = document.querySelectorAll('body > .toast');
    existing.forEach(function(t) { t.remove(); });
    var toast = document.createElement('div');
    toast.className = 'toast oc-toast oc-toast-' + (type || 'success');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() {
      toast.classList.add('oc-toast-exit');
      setTimeout(function() { toast.remove(); }, 300);
    }, 2200);
  }


  async function loadModels() {
    try {
      $id('modelsList').innerHTML = '<div class="models-empty">' + t('loading') + '</div>';
      const data = await fetchJSON('/api/models-list');
      currentModelsData = data;
      renderModels();
      const totalModels = data.providers.reduce((s, p) => s + (p.models || []).length, 0);
      $id('providersCount').textContent = data.providers.length;
      $id('modelsCount').textContent = totalModels;

      // 默认模型（兼容空字符串和缺失两种情况）
      const defaults = data.defaults || {};
      const rawDefault = (defaults.model || '').trim();
      if (rawDefault) {
        $id('defaultModelName').textContent = rawDefault;
        $id('defaultModelBadge').classList.remove('default-model-empty');
        $id('defaultModelBadge').title = '系统当前使用的默认模型';
      } else {
        $id('defaultModelName').textContent = '未配置';
        $id('defaultModelBadge').classList.add('default-model-empty');
        $id('defaultModelBadge').title = 'openclaw.json 中未配置 agents.defaults.model.primary';
      }

      const fallbacks = defaults.fallbacks || [];
      if (fallbacks.length > 0) {
        ocSetDisplay($id('fallbackModelsSection'), 'flex');
        $id('fallbackModelsList').innerHTML = fallbacks.map(f =>
          `<span class="oc-badge oc-badge-warning">🔗 ${f}</span>`
        ).join('');
      } else {
        ocSetDisplay($id('fallbackModelsSection'), 'none');
      }
    } catch (e) {
      console.error('loadModels error:', e);
      $id('modelsList').innerHTML = `<div class="models-error">${t('loadFailed')}${e.message}</div>`;
    }
  }

  function renderModels() {
    const data = currentModelsData;
    const container = $id('modelsList');
    if (!container) return;
    if (!data.providers || data.providers.length === 0) {
      container.innerHTML = '<div class="models-empty">' + t('noModelsConfig') + '</div>';
      return;
    }

    let html = '';
    data.providers.forEach(provider => {
      html += renderProviderSection(provider, data);
    });
    container.innerHTML = html;
  }

  function renderProviderSection(provider, data) {
    const models = provider.models || [];
    const usedBy = provider.usedBy || [];
    const providerEmoji = getProviderEmoji(provider.api);

    let modelsHtml = '';
    if (models.length === 0) {
      modelsHtml = '<div class="models-empty-sm">' + t('noModels') + '</div>';
    } else {
      const headerRow = `
        <div class="models-table-head">
          <div class="models-col-icon"></div>
          <div class="models-col-main">${t('thModelCol')}</div>
          <div class="models-col-latency">${t('thLatencyCol')}</div>
          <div class="models-col-caps">
            <span class="models-col-ctx">${t('ctxHeader')}</span>
            <span class="models-col-reason">${t('reasonHeader')}</span>
            <span class="models-col-image">🖼️</span>
          </div>
          <div class="models-col-actions">${t('thActions')}</div>
        </div>
      `;
      modelsHtml = `<div class="models-table-shell">` +
        headerRow +
        models.map((m, i) => renderModelRow(m, provider, i === models.length - 1)).join('') +
        `</div>`;
    }

    const usedByHtml = usedBy.length > 0
      ? `<div class="oc-flex-gap-6 models-used-by"><span class="models-used-by-label">${t('usedBy')}</span>` +
        usedBy.map(a => `<span class="oc-badge oc-badge-primary">${a.emoji} ${a.name}</span>`).join('') +
        `</div>`
      : '';

    return `
      <div class="oc-card models-provider-card">
        <div class="models-provider-top">
          <div class="provider-header models-provider-header">
            <div class="provider-icon">${providerEmoji}</div>
            <div class="models-provider-main">
              <div class="models-provider-id">${provider.id}</div>
              <div class="oc-flex-gap-6 models-provider-badges">
                <span class="oc-badge oc-badge-primary">${provider.api}</span>
                <span class="oc-badge ${provider.accessMode === 'api_key' ? 'oc-badge-success' : 'oc-badge-primary'}">
                  ${provider.accessMode === 'api_key' ? t('apiKey') : t('auth')}
                </span>
              </div>
            </div>
          </div>
          ${usedByHtml}
        </div>
        <div class="models-provider-body">
          ${modelsHtml}
        </div>
      </div>
    `;
  }

  function getModelTestHistory(providerId, modelId) {
    try {
      const key = 'modelTestHistory_' + providerId + '_' + modelId;
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function setModelTestHistory(providerId, modelId, data) {
    try {
      const key = 'modelTestHistory_' + providerId + '_' + modelId;
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {}
  }

  function renderModelRow(model, provider, isLast) {
    const providerId = provider.id;
    const modelId = model.id || model;
    const modelName = model.name || modelId;
    const contextWindow = model.contextWindow || 128000;
    const contextConfigured = model.contextConfigured || false;
    const reasoning = model.reasoning || false;
    const hasImageSupport = model.hasImageSupport || false;
    const modelUsedBy = model.usedBy || [];

    const isFallback = (currentModelsData.defaults?.fallbacks || []).includes(`${providerId}/${modelId}`);
    const isDefault = (currentModelsData.defaults?.model || '') === `${providerId}/${modelId}`;

    const badgeClass = isDefault ? 'oc-badge-success' : isFallback ? 'oc-badge-warning' : 'oc-badge-primary';
    const badgeText = isDefault ? t('defaultBadge') : isFallback ? t('fallbackBadge') : '';

    const history = getModelTestHistory(providerId, modelId);
    const historyHtml = history
      ? `<span class="models-history-value ${history.ok ? 'ok' : 'fail'}">${history.elapsed}ms</span><span class="models-history-separator">·</span><span class="models-history-time">${history.time}</span>`
      : '<span class="models-latency-empty">—</span>';

    const modelUsedByHtml = modelUsedBy.length > 0
      ? `<div class="oc-flex-gap-4 models-used-by-mini">` +
        modelUsedBy.map(a => `<span class="oc-badge oc-badge-primary">${escapeHtml(a.emoji)} ${escapeHtml(a.name)}</span>`).join('') +
        `</div>`
      : '';

    const ctxClass = contextConfigured ? 'configured' : 'default';
    const reasonHtml = reasoning
      ? '<span class="models-cap-reason-on">ON</span>'
      : '<span class="models-cap-empty">—</span>';
    const imageHtml = hasImageSupport
      ? '<span class="models-cap-image-on">🖼️</span>'
      : '<span class="models-cap-empty subtle">—</span>';

    return `
      <div class="models-row models-row-hover ${isLast ? 'last' : ''}">
        <div class="models-row-icon">🤖</div>
        <div class="models-col-main">
          <div class="oc-flex-gap-8 models-row-title">
            <span class="models-row-name">${escapeHtml(modelName)}</span>
            ${badgeText ? `<span class="oc-badge ${badgeClass} models-row-badge">${badgeText}</span>` : ''}
          </div>
          <div class="models-row-path">${escapeHtml(providerId)}/${escapeHtml(modelId)}</div>
          ${modelUsedByHtml}
        </div>
        <div class="models-row-latency">
          ${historyHtml}
        </div>
        <div class="models-cap-row">
          <span class="models-cap ctx ${contextConfigured ? '' : 'is-default'}" title="${contextConfigured ? t('configuredCtxTooltip') : t('defaultCtxTooltip')}"><span class="models-cap-value ${ctxClass}">${(contextWindow / 1000).toFixed(0)}k</span></span>
          <span class="models-cap reason">${reasonHtml}</span>
          <span class="models-cap image" title="${hasImageSupport ? t('supportsImageTooltip') : t('textOnlyTooltip')}">${imageHtml}</span>
        </div>
        <div class="oc-flex-gap-6 models-action-row">
          <button class="oc-btn oc-btn-sm oc-btn-icon" data-model-action="test" data-provider="${dataAttr(providerId)}" data-model-id="${dataAttr(modelId)}" title="测试">⚡</button>
          <button class="oc-btn oc-btn-sm oc-btn-icon" data-model-action="edit" data-provider="${dataAttr(providerId)}" data-model-id="${dataAttr(modelId)}" data-model-name="${dataAttr(modelName)}" data-context-window="${dataAttr(contextWindow)}" title="编辑">✏️</button>
          <button class="oc-btn oc-btn-sm oc-btn-icon oc-btn-danger" data-model-action="delete" data-provider="${dataAttr(providerId)}" data-model-id="${dataAttr(modelId)}" title="删除">🗑️</button>
        </div>
      </div>
    `;
  }

  function getProviderEmoji(api) {
    if (api.includes('openai')) return '🤖';
    if (api.includes('claude')) return '🎭';
    if (api.includes('deepseek')) return '🐋';
    if (api.includes('gemini')) return '💎';
    if (api.includes('qianfan')) return '🇨🇳';
    if (api.includes('openrouter')) return '🔄';
    if (api.includes('ollama')) return '🦙';
    return '🔌';
  }

  function switchModelSource(source) {
    currentModelSource = source;
    if (source === 'system') {
      ocSetDisplay($id('systemModelInfo'), 'flex');
      loadModels();
    } else {
      ocSetDisplay($id('systemModelInfo'), 'none');
      loadAgentModels(source);
    }
  }

  async function loadAgentModels(agentId) {
    try {
      $id('modelsList').innerHTML = '<div class="models-empty">' + t('loading') + '</div>';
      const data = await fetchJSON('/api/agent-models/' + encodeURIComponent(agentId));
      currentModelsData = { providers: data.providers || [], agents: [], defaults: {} };
      renderModels();
      $id('providersCount').textContent = data.providers.length;
      const totalModels = data.providers.reduce((s, p) => s + (p.models || []).length, 0);
      $id('modelsCount').textContent = totalModels;
    } catch (e) {
      $id('modelsList').innerHTML = `<div class="models-error">${t('loadFailed')}${e.message}</div>`;
    }
  }

  function showAddModelDialog() {
    const providers = currentModelsData.providers || [];
    const select = $id('addModelProvider');
    select.innerHTML = '<option value="">' + t('selectProvider') + '</option>' + providers.map(p => `<option value="${dataAttr(p.id)}">${escapeHtml(p.id)}</option>`).join('');
    $id('addModelId').value = '';
    $id('addModelName').value = '';
    $id('addModelContext').value = '128000';
    const modal = $id('addModelModal');
    ocSetDisplay(modal, 'flex');
    if (modal) modal.classList.add('active');
  }

  function hideAddModelDialog() {
    const modal = $id('addModelModal');
    if (modal) modal.classList.remove('active');
    ocSetDisplay(modal, 'none');
  }

  // ===== Add Model Picker (拉取 Cliproxy 远程模型后选择) =====
  async function fetchCliproxyModelsForAdd() {
    const list = $id('addModelPickerList');
    const btn = $id('btnFetchCliproxyForAdd');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 拉取中...'; }
    if (list) list.innerHTML = '<div class="models-picker-empty">正在拉取远程模型...</div>';
    try {
      const res = await fetchJSON('/api/cliproxy-models?provider=' + encodeURIComponent(getProxyProvider()));
      const models = (res && res.models) || [];
      const sysIds = getSystemModelIds();
      if (!list) return;
      if (!models.length) {
        list.innerHTML = '<div class="models-picker-empty">未拉取到远程模型</div>';
        return;
      }
      list.innerHTML = models.map(m => {
        const key = `${getProxyProvider()}/${m.id}`;
        const configured = sysIds.has(key);
        const safeId = dataAttr(m.id);
        const rowAction = configured ? '' : ' data-model-action="pick-cliproxy" data-model-id="' + safeId + '"';
        const statusBadge = configured
          ? '<span class="oc-badge oc-badge-success models-picker-badge">已配置</span>'
          : '<span class="oc-badge oc-badge-warning models-picker-badge">新增</span>';
        const action = configured
          ? '<span class="models-picker-dash">—</span>'
          : '<button type="button" class="oc-btn oc-btn-sm oc-btn-primary" data-model-action="pick-cliproxy" data-model-id="' + safeId + '">使用</button>';
        return '<div class="models-picker-row ' + (configured ? 'is-configured' : 'is-new') + '"' + rowAction + '>' +
          '<span class="models-picker-model">' + escapeHtml(m.id) + '</span>' +
          '<span class="models-picker-owner">' + escapeHtml(m.owned_by || 'unknown') + '</span>' +
          statusBadge + action +
          '</div>';
      }).join('');
    } catch (e) {
      if (list) list.innerHTML = '<div class="models-picker-error">拉取失败: ' + e.message + '</div>';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 拉取'; }
    }
  }

  function pickCliproxyModel(modelId) {
    const providers = currentModelsData.providers || [];
    const target = providers.find(p => p.id === getProxyProvider()) || providers.find(p => p.baseUrl) || providers[0];
    if (target) $id('addModelProvider').value = target.id;
    $id('addModelId').value = modelId;
    $id('addModelName').value = modelId;
    $id('addModelContext').value = '128000';
    $id('addModelName').focus();
    $id('addModelName').select();
  }

  async function addModel() {
    const provider = $id('addModelProvider').value;
    const modelId = $id('addModelId').value.trim();
    const name = $id('addModelName').value.trim();
    const contextWindow = parseInt($id('addModelContext').value) || 128000;
    if (!provider || !modelId) { alert(t('fillProviderAndModelId')); return; }
    try {
      const res = await fetchJSON('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId, name, contextWindow })
      });
      if (res.success) {
        hideAddModelDialog();
        loadModels();
      } else {
        alert(t('addFailed') + (res.error || 'Unknown'));
      }
    } catch (e) {
      alert(t('addFailed') + e.message);
    }
  }

  // ===== Provider 管理（写回 openclaw.json；服务端落盘前自动备份到 config-recovery/backups）=====
  function providerRowHtml(p) {
    const refs = p.refs || [];
    const badge = p.modelCount > 0
      ? '<span class="oc-badge oc-badge-warning models-proxy-status">' + t('providerModels', { count: p.modelCount }) + '</span>'
      : '<span class="oc-badge oc-badge-success models-proxy-status">' + t('providerEmpty') + '</span>';
    const refHtml = refs.length
      ? '<div class="models-proxy-owner is-error">' + escapeHtml(t('providerRefs', { count: refs.length })) + '</div>'
      : '';
    return '<div class="models-proxy-row">' +
        '<div class="models-proxy-icon">🏷️</div>' +
        '<div class="models-proxy-main">' +
          '<div class="models-proxy-title">' + escapeHtml(p.id) + '</div>' +
          '<div class="models-proxy-owner">' + escapeHtml((p.api || '-') + ' · ' + (p.baseUrl || t('providerNoBaseUrl')) + (p.hasApiKey ? ' · ' + t('providerHasKey') : '')) + '</div>' +
          refHtml +
        '</div>' +
        badge +
        '<div class="models-proxy-action"><button class="oc-btn oc-btn-sm oc-btn-danger" onclick="deleteProvider(\'' + escapeHtml(p.id) + '\')">' + t('deleteBtn') + '</button></div>' +
      '</div>';
  }

  async function refreshProviderList() {
    const list = $id('providerList');
    if (!list) return;
    list.innerHTML = '<div class="models-list-empty">' + t('loading') + '</div>';
    try {
      const data = await fetchJSON('/api/providers');
      const provs = data.providers || [];
      list.innerHTML = provs.length
        ? provs.map(providerRowHtml).join('')
        : '<div class="models-list-empty">' + t('noProviders') + '</div>';
    } catch (e) {
      list.innerHTML = '<div class="models-list-empty">' + escapeHtml(t('loadFailed') + e.message) + '</div>';
    }
  }

  window.openProviderManager = function() {
    const m = $id('providerManagerModal');
    if (!m) return;
    m.classList.add('active');
    refreshProviderList();
  };

  window.hideProviderManager = function() {
    const m = $id('providerManagerModal');
    if (m) m.classList.remove('active');
  };

  window.createProvider = async function() {
    const val = function(id) { const el = $id(id); return el && el.value ? el.value.trim() : ''; };
    const id = val('newProviderId');
    const api = val('newProviderApi');
    const baseUrl = val('newProviderBaseUrl');
    const apiKey = val('newProviderApiKey');
    if (!id || !api) { alert(t('providerIdApiRequired')); return; }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) { alert(t('providerIdInvalid')); return; }
    if (!confirm(t('confirmCreateProvider', { id: id }))) return;
    try {
      const res = await fetchJSON('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, api: api, baseUrl: baseUrl, apiKey: apiKey })
      });
      if (res.success) {
        showToast(t('providerCreated', { id: id }), 'success');
        ['newProviderId', 'newProviderBaseUrl', 'newProviderApiKey'].forEach(function(x) {
          const el = $id(x); if (el) el.value = '';
        });
        refreshProviderList();
        initProxyProviderSelect();
        loadModels();
      } else {
        alert(t('createFailed') + (res.error || ''));
      }
    } catch (e) { alert(t('createFailed') + e.message); }
  };

  window.deleteProvider = async function(id) {
    if (!confirm(t('confirmDeleteProvider', { id: id }))) return;
    try {
      let res = await fetchJSON('/api/providers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
      });
      if (!res.success && res.needsForce) {
        if (!confirm(t('providerForceHint') + '\n\n' + (res.error || ''))) return;
        res = await fetchJSON('/api/providers', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, force: true })
        });
      }
      if (res.success) {
        showToast(t('providerDeleted', { id: id }), 'success');
        refreshProviderList();
        initProxyProviderSelect();
        loadModels();
      } else {
        alert(t('deleteFailed') + (res.error || ''));
      }
    } catch (e) { alert(t('deleteFailed') + e.message); }
  };

  // ===== 模型绑定（默认模型 + 各 Agent 模型；选项全部来自实际 provider，零硬编码）=====
  let _bindings = null;

  function allModelRefs(providers) {
    const out = [];
    (providers || []).forEach(p => (p.models || []).forEach(m => out.push(p.id + '/' + m)));
    return out;
  }

  function modelRefOptions(providers, selected) {
    if (!providers || !providers.length) return '<option value="">' + t('noProviders') + '</option>';
    return '<option value="">' + t('selectModel') + '</option>' +
      providers.map(p => {
        const models = p.models || [];
        return '<optgroup label="' + escapeHtml(p.id) + (models.length ? '' : ' (' + t('providerEmpty') + ')') + '">' +
          models.map(m => {
            const ref = p.id + '/' + m;
            return '<option value="' + escapeHtml(ref) + '"' + (ref === selected ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
          }).join('') +
          '</optgroup>';
      }).join('');
  }

  function bindingRowHtml(providers, label, ref, kind, idx) {
    const dangling = !!ref && allModelRefs(providers).indexOf(ref) === -1;
    return '<div class="models-binding-row' + (dangling ? ' is-dangling' : '') + '" data-binding-kind="' + escapeHtml(kind) + '"' +
        (idx >= 0 ? ' data-binding-idx="' + idx + '"' : '') + '>' +
        '<span class="models-binding-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>' +
        '<select class="oc-select models-binding-select">' +
          (dangling ? '<option value="' + escapeHtml(ref) + '" selected>' + escapeHtml(ref) + ' — ' + t('bindingDangling') + '</option>' : '') +
          modelRefOptions(providers, ref) +
        '</select>' +
        (kind === 'fallback' ? '<button type="button" class="oc-btn oc-btn-sm oc-btn-danger" onclick="removeBindingRow(this)">✕</button>' : '') +
      '</div>';
  }

  async function refreshModelBindings() {
    const defBox = $id('bindingDefaults');
    const agBox = $id('bindingAgents');
    if (!defBox || !agBox) return;
    defBox.innerHTML = '<div class="models-list-empty">' + t('loading') + '</div>';
    agBox.innerHTML = '';
    try {
      const data = await fetchJSON('/api/model-bindings');
      if (!data.success) {
        defBox.innerHTML = '<div class="models-list-empty">' + escapeHtml(data.error || '') + '</div>';
        return;
      }
      _bindings = data;
      const providers = data.providers || [];
      const d = data.defaults || {};
      let html = bindingRowHtml(providers, t('bindingPrimary'), d.primary, 'primary', -1);
      (d.fallbacks || []).forEach(function(f, i) {
        html += bindingRowHtml(providers, t('bindingFallback') + ' ' + (i + 1), f, 'fallback', i);
      });
      defBox.innerHTML = html;
      const agents = data.agents || [];
      agBox.innerHTML = agents.length
        ? agents.map(function(a) { return bindingRowHtml(providers, a.id, a.model, 'agent:' + a.id, -1); }).join('')
        : '<div class="models-list-empty">' + t('noAgents') + '</div>';
      const providerOpt = function(p) {
        return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.id) + '</option>';
      };
      // 被绑定引用、但已不在 provider 列表里的（通常是刚被删掉的那个）—— 也要能选，否则没法做改指
      const refs = [d.primary].concat(d.fallbacks || []).concat(agents.map(function(a) { return a.model; })).filter(Boolean);
      const usedPids = [...new Set(refs.map(function(r) { return String(r).split('/')[0]; }))];
      const missingPids = usedPids.filter(function(u) {
        return !providers.some(function(p) { return p.id === u; });
      });
      const from = $id('remapFrom');
      const to = $id('remapTo');
      if (from) {
        from.innerHTML = '<option value="">—</option>' + providers.map(providerOpt).join('') +
          missingPids.map(function(u) { return '<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + ' (已失效)</option>'; }).join('');
        if (missingPids.length) from.value = missingPids[0];
      }
      if (to) to.innerHTML = '<option value="">—</option>' + providers.map(providerOpt).join('');
    } catch (e) {
      defBox.innerHTML = '<div class="models-list-empty">' + escapeHtml(t('loadFailed') + e.message) + '</div>';
    }
  }

  window.openModelBindings = async function() {
    const m = $id('modelBindingsModal');
    if (!m) return;
    m.classList.add('active');
    await refreshModelBindings();
  };

  window.hideModelBindings = function() {
    const m = $id('modelBindingsModal');
    if (m) m.classList.remove('active');
  };

  window.addBindingFallback = function() {
    const box = $id('bindingDefaults');
    if (!box || !_bindings) return;
    const idx = box.querySelectorAll('[data-binding-kind="fallback"]').length;
    box.insertAdjacentHTML('beforeend',
      bindingRowHtml(_bindings.providers || [], t('bindingFallback') + ' ' + (idx + 1), '', 'fallback', idx));
  };

  window.removeBindingRow = function(btn) {
    const row = btn && btn.closest ? btn.closest('.models-binding-row') : null;
    if (row) row.remove();
  };

  function collectBindings() {
    const out = { defaults: { primary: '', fallbacks: [] }, agents: {} };
    document.querySelectorAll('#modelBindingsModal .models-binding-row').forEach(function(row) {
      const kind = row.getAttribute('data-binding-kind') || '';
      const sel = row.querySelector('.models-binding-select');
      const v = sel ? sel.value : '';
      if (kind === 'primary') out.defaults.primary = v;
      else if (kind === 'fallback') out.defaults.fallbacks.push(v);
      else if (kind.indexOf('agent:') === 0) out.agents[kind.slice(6)] = v;
    });
    out.defaults.fallbacks = out.defaults.fallbacks.filter(Boolean);
    return out;
  }

  window.saveModelBindings = async function() {
    const payload = collectBindings();
    payload.defaultsSource = (_bindings && _bindings.defaultsSource) || 'agents.defaults.model';
    if (!confirm(t('confirmSaveBindings'))) return;
    try {
      const res = await fetchJSON('/api/model-bindings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (res.success) {
        showToast(t('bindingsSaved'), 'success');
        loadModels();
        refreshModelBindings();
      } else {
        alert(t('saveBindingsFailed') + (res.error || ''));
      }
    } catch (e) { alert(t('saveBindingsFailed') + e.message); }
  };

  window.runModelRemap = async function() {
    const from = ($id('remapFrom') || {}).value || '';
    const to = ($id('remapTo') || {}).value || '';
    if (!from || !to) { alert(t('remapNeedBoth')); return; }
    if (from === to) { alert(t('remapSameProvider')); return; }
    if (!confirm(t('confirmRemap', { from: from, to: to }))) return;
    try {
      const res = await fetchJSON('/api/model-bindings/remap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from, to: to })
      });
      if (res.success) {
        showToast(t('remapDone', { count: (res.changed || []).length }), 'success');
        if ((res.skipped || []).length) alert(t('remapSkipped') + '\n\n' + res.skipped.join('\n'));
        loadModels();
        refreshModelBindings();
      } else {
        alert((res.error || '') + ((res.skipped || []).length ? '\n\n' + res.skipped.join('\n') : ''));
      }
    } catch (e) { alert(t('saveBindingsFailed') + e.message); }
  };

  function showEditModelDialog(provider, modelId, name, contextWindow) {
    $id('editModelProvider').value = provider;
    $id('editModelIdOriginal').value = modelId;
    $id('editModelId').value = modelId;
    $id('editModelName').value = name || modelId;
    $id('editModelContext').value = contextWindow || 128000;
    const modal = $id('editModelModal');
    ocSetDisplay(modal, 'flex');
    if (modal) modal.classList.add('active');
  }

  function hideEditModelDialog() {
    const modal = $id('editModelModal');
    if (modal) modal.classList.remove('active');
    ocSetDisplay(modal, 'none');
  }

  async function editModel() {
    const provider = $id('editModelProvider').value;
    const modelId = $id('editModelId').value;
    const name = $id('editModelName').value.trim();
    const contextWindow = parseInt($id('editModelContext').value) || 128000;
    try {
      const res = await fetchJSON('/api/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId, name, contextWindow })
      });
      if (res.success) {
        hideEditModelDialog();
        loadModels();
      } else {
        alert(t('saveFailed') + (res.error || 'Unknown'));
      }
    } catch (e) {
      alert(t('saveFailed') + e.message);
    }
  }

  async function deleteModel(provider, modelId) {
    if (!confirm(t('confirmDelete', { provider: provider, modelId: modelId }))) return;
    try {
      const res = await fetchJSON('/api/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId })
      });
      if (res.success) loadModels();
      else alert(t('deleteFailed') + (res.error || 'Unknown'));
    } catch (e) {
      alert(t('deleteFailed') + e.message);
    }
  }

  async function testModel(provider, modelId, triggerEl) {
    const btn = triggerEl || null;
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = t('testing'); }
    try {
      const res = await fetchJSON('/api/test-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId })
      });
      const result = res.results?.[0];
      if (result) {
        setModelTestHistory(provider, modelId, {
          ok: result.ok,
          elapsed: result.elapsed,
          prompt_tokens: result.prompt_tokens,
          completion_tokens: result.completion_tokens,
          time: new Date().toLocaleString(localeStr(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          timestamp: Date.now()
        });
        loadModels();
      }
      if (result && result.ok) {
        alert(t('testSuccess', { provider: provider, modelId: modelId, latency: result.elapsed, input: result.prompt_tokens, output: result.completion_tokens }));
      } else {
        alert(t('testFailed', { provider: provider, modelId: modelId, error: result?.error || 'Unknown' }));
      }
    } catch (e) {
      alert(t('testFailedGeneral') + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText || t('testBtn'); }
    }
  }

  async function testAllModels() {
    const btn = $id('btnBatchTestAll2');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span> ' + t('testingInProgress'); }

    const allModels = [];
    (currentModelsData.providers || []).forEach(p => {
      (p.models || []).forEach(m => {
        allModels.push({ provider: p.id, modelId: m.id || m });
      });
    });

    if (allModels.length === 0) {
      alert(t('noModelsToTest'));
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>🚀</span> ' + t('batchTestAllText'); }
      return;
    }

    const results = [];
    const nowStr = new Date().toLocaleString(localeStr(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    ocSetDisplay($id('batchModelTestSection'), 'block');
    const progressText = $id('batchTestProgressText');
    const progressPercent = $id('batchTestProgressPercent');
    const progressBar = $id('batchTestProgressBar');
    const currentModelEl = $id('batchTestCurrentModel');

    try {
      for (let i = 0; i < allModels.length; i++) {
        const item = allModels[i];
        const percent = Math.round(((i) / allModels.length) * 100);

        progressText.textContent = t('testingProgress', { current: i + 1, total: allModels.length });
        progressPercent.textContent = percent + '%';
        progressBar.style.width = percent + '%';
        currentModelEl.textContent = `${item.provider}/${item.modelId}`;

        try {
          const res = await fetchJSON('/api/test-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: item.provider, modelId: item.modelId })
          });
          const r = res.results?.[0];
          if (r) {
            results.push(r);
            if (r.provider && r.model) {
              setModelTestHistory(r.provider, r.model, {
                ok: r.ok, elapsed: r.elapsed, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
                time: nowStr, timestamp: Date.now()
              });
            }
          }
        } catch (e) {
          results.push({
            provider: item.provider, model: item.modelId,
            ok: false, elapsed: 0, prompt_tokens: 0, completion_tokens: 0,
            error: e.message || t('testFailedLabel')
          });
        }
      }

      progressText.textContent = t('testComplete');
      progressPercent.textContent = '100%';
      progressBar.style.width = '100%';
      currentModelEl.textContent = '';

      loadModels();
      const tbody = $id('batchTestResultsBody');
      tbody.innerHTML = results.map(r => `
        <tr>
          <td><span class="models-test-model">${r.provider}/${r.model || '-'}</span></td>
          <td>${r.elapsed ? '<span class="models-test-latency ok">' + r.elapsed + 'ms</span>' : '<span class="models-test-latency">-</span>'}</td>
          <td>${r.prompt_tokens || 0}</td>
          <td>${r.completion_tokens || 0}</td>
          <td class="models-test-time">${nowStr}</td>
          <td>${r.ok ? '<span class="oc-badge oc-badge-success">' + t('pass') + '</span>' : '<span class="oc-badge oc-badge-danger models-danger-badge">' + t('fail') + '</span>'}</td>
        </tr>
      `).join('');
      ocSetDisplay($id('batchTestResults'), 'block');
    } catch (e) {
      alert(t('batchTestFailed') + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>🚀</span> ' + t('batchTestAllText'); }
    }
  }

  function clearBatchTestResults() {
    ocSetDisplay($id('batchModelTestSection'), 'none');
    ocSetDisplay($id('batchTestResults'), 'none');
    $id('batchTestResultsBody').innerHTML = '';
    $id('batchTestProgressText').textContent = t('preparingTest');
    $id('batchTestProgressPercent').textContent = '0%';
    $id('batchTestProgressBar').style.width = '0%';
    $id('batchTestCurrentModel').textContent = '';
  }

  let _lastCliproxyModels = [];
  let _lastSystemModelIds = new Set();
  let _proxyProvider = '';

  // 「拉取模型 / 远端对比」要按**选中的 provider** 工作（2026-10-02 前写死 cliproxy，
  // 用户删掉 cliproxy 后就报 "Cliproxy not configured"）。
  function getProxyProvider() {
    const sel = $id('proxyProviderSelect');
    const v = sel && sel.value ? sel.value : '';
    if (v) { _proxyProvider = v; return v; }
    if (_proxyProvider) return _proxyProvider;
    const provs = (currentModelsData && currentModelsData.providers) || [];
    const first = provs.find(p => p.baseUrl) || provs[0];
    _proxyProvider = first ? first.id : '';
    return _proxyProvider;
  }

  async function initProxyProviderSelect() {
    const sel = $id('proxyProviderSelect');
    if (!sel) return;
    try {
      const data = await fetchJSON('/api/providers');
      const provs = (data.providers || []).filter(p => p.baseUrl);
      const keep = sel.value || _proxyProvider;
      sel.innerHTML = provs.length
        ? provs.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.id) + '</option>').join('')
        : '<option value="">' + t('noPullableProviderShort') + '</option>';
      if (keep && provs.some(p => p.id === keep)) sel.value = keep;
      _proxyProvider = sel.value || '';
    } catch (e) { /* 静默：真正拉取时会再报一次 */ }
  }

  async function fetchCliproxyModels() {
    const btn = $id('btnFetchCliproxy');
    const pid = getProxyProvider();
    const list = $id('cliproxyModelsList');
    if (!pid) {
      if (list) list.innerHTML = `<div class="models-list-error">${t('errorLabel')}${t('noPullableProvider')}</div>`;
      ocSetDisplay($id('cliproxyModelsSection'), 'block');
      return;
    }
    btn.disabled = true; btn.textContent = t('fetching');
    try {
      const res = await fetchJSON('/api/cliproxy-models?provider=' + encodeURIComponent(pid));
      if (res.error) {
        list.innerHTML = `<div class="models-list-error">${t('errorLabel')}${res.error}</div>`;
      } else {
        const models = res.models || [];
        _lastCliproxyModels = models;
        renderCliproxyComparison(models);
      }
      ocSetDisplay($id('cliproxyModelsSection'), 'block');
    } catch (e) {
      alert(t('fetchFailed') + e.message);
    } finally {
      btn.disabled = false; btn.textContent = t('fetchModelsBtn');
    }
  }

  function getSystemModelIds() {
    const ids = new Set();
    const providers = currentModelsData?.providers || [];
    providers.forEach(p => {
      (p.models || []).forEach(m => ids.add(`${p.id}/${m.id}`));
    });
    return ids;
  }

  function renderCliproxyComparison(models) {
    const list = $id('cliproxyModelsList');
    const pid = getProxyProvider();
    if (models.length === 0) {
      list.innerHTML = '<div class="models-list-empty">' + t('noRemoteModels') + '</div>';
      return;
    }

    const sysModelIds = getSystemModelIds();
    _lastSystemModelIds = sysModelIds;

    const rows = models.map(m => {
      const key = `${pid}/${m.id}`;
      const isConfigured = sysModelIds.has(key);
      const statusBadge = isConfigured
        ? '<span class="oc-badge oc-badge-success models-proxy-status">' + t('configured') + '</span>'
        : '<span class="oc-badge oc-badge-warning models-proxy-status">' + t('new') + '</span>';
      const actionBtn = isConfigured
        ? `<button class="oc-btn oc-btn-sm oc-btn-ghost" data-model-action="remove-model" data-provider="${dataAttr(pid)}" data-model-id="${dataAttr(m.id)}">${t('remove')}</button>`
        : `<button class="oc-btn oc-btn-sm oc-btn-primary" data-model-action="add-cliproxy" data-model-id="${dataAttr(m.id)}">${t('addCliproxy')}</button>`;

      return `
        <div class="models-proxy-row models-proxy-row-hover">
          <div class="models-proxy-icon">📡</div>
          <div class="models-proxy-main">
            <div class="models-proxy-title">${escapeHtml(m.id)}</div>
            <div class="models-proxy-owner">${escapeHtml(m.owned_by || 'unknown')}</div>
          </div>
          ${statusBadge}
          <div class="models-proxy-action">${actionBtn}</div>
        </div>
      `;
    }).join('');

    const expiredRows = [];
    sysModelIds.forEach(key => {
      if (!key.startsWith(pid + '/')) return;
      const modelId = key.slice(pid.length + 1);
      const found = models.find(m => m.id === modelId);
      if (!found) {
        expiredRows.push(`
          <div class="models-proxy-row models-proxy-row-error is-expired">
            <div class="models-proxy-icon is-expired">📡</div>
            <div class="models-proxy-main">
              <div class="models-proxy-title is-muted">${escapeHtml(modelId)}</div>
              <div class="models-proxy-owner is-error">${t('removedFromRemote')}</div>
            </div>
            <span class="oc-badge oc-badge-danger models-proxy-status models-expired-badge">${t('expired')}</span>
            <div class="models-proxy-action"><button class="oc-btn oc-btn-sm oc-btn-danger" data-model-action="remove-model" data-provider="${dataAttr(pid)}" data-model-id="${dataAttr(modelId)}">${t('deleteBtn')}</button></div>
          </div>
        `);
      }
    });

    list.innerHTML = rows + expiredRows.join('');
  }

  async function addCliproxyModel(modelId) {
    try {
      const res = await fetchJSON('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: getProxyProvider(), modelId, name: modelId, contextWindow: 128000 })
      });
      if (res.success) {
        loadModels();
        fetchCliproxyModels();
      } else {
        alert(t('addFailed') + (res.error || 'Unknown'));
      }
    } catch (e) {
      alert(t('addFailed') + e.message);
    }
  }

  async function removeModelById(provider, modelId) {
    console.log('[models-manager] removeModelById', provider, modelId);
    if (!confirm(t('confirmDelete', { provider: provider, modelId: modelId }))) return;
    try {
      const res = await fetchJSON('/api/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId })
      });
      if (res.success) {
        loadModels();
        fetchCliproxyModels();
      } else {
        alert(t('deleteFailed') + (res.error || 'Unknown'));
      }
    } catch (e) {
      console.error('[models-manager] removeModelById error', e);
      alert(t('deleteFailed') + e.message);
    }
  }

  async function addAllNewCliproxyModels() {
    const sysIds = getSystemModelIds();
    const pid = getProxyProvider();
    const newModels = _lastCliproxyModels.filter(m => !sysIds.has(`${pid}/${m.id}`));
    if (newModels.length === 0) { alert(t('noNewModels')); return; }
    let added = 0;
    for (const m of newModels) {
      try {
        const res = await fetchJSON('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: pid, modelId: m.id, name: m.id, contextWindow: 128000 })
        });
        if (res.success) added++;
      } catch (e) {}
    }
    alert(t('addedModels', { added: added, total: newModels.length }));
    loadModels();
    fetchCliproxyModels();
  }

  async function removeAllExpiredCliproxyModels() {
    console.log('[models-manager] removeAllExpiredCliproxyModels clicked');
    const sysIds = getSystemModelIds();
    const pid = getProxyProvider();
    const expired = [];
    sysIds.forEach(key => {
      if (key.startsWith(pid + '/')) {
        const modelId = key.slice(pid.length + 1);
        if (!_lastCliproxyModels.find(m => m.id === modelId)) expired.push(modelId);
      }
    });
    if (expired.length === 0) { alert(t('noExpiredModels')); return; }
    if (!confirm(t('confirmDeleteExpired', { count: expired.length }))) return;
    let removed = 0;
    let lastError = '';
    for (const modelId of expired) {
      try {
        const res = await fetchJSON('/api/models', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: pid, modelId })
        });
        if (res.success) { removed++; } else { lastError = res.error || 'Unknown'; }
      } catch (e) {
        lastError = e.message;
        console.error('[models-manager] delete failed for', modelId, e);
      }
    }
    if (removed < expired.length && lastError) {
      alert(t('deleteFailed') + lastError + '\n' + t('removedExpiredModels', { removed: removed, total: expired.length }));
    } else {
      alert(t('removedExpiredModels', { removed: removed, total: expired.length }));
    }
    loadModels();
    fetchCliproxyModels();
  }

  async function initModelSourceSelector() {
    try {
      const data = await fetchJSON('/api/agents-list');
      const agents = data.agents || [];
      const select = $id('modelSource');
      // 片段还没插进 DOM 时（例如外壳的语言广播先到）会取不到 #modelSource —— 直接返回，
      // 不要抛 "Cannot set properties of null"。
      if (!select) return;
      select.innerHTML = '<option value="system">' + t('systemConfigFull') + '</option>' +
        agents.map(a => `<option value="${dataAttr(a.id)}">${escapeHtml(t('agentOption', { id: a.id }))}</option>`).join('');
    } catch (e) {
      console.error('initModelSourceSelector error:', e);
    }
  }

  document.addEventListener('click', function(e) {
    const target = e.target.closest('[data-model-action]');
    if (!target) return;
    const action = target.getAttribute('data-model-action');
    const provider = target.getAttribute('data-provider');
    const modelId = target.getAttribute('data-model-id');
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'test') {
      testModel(provider, modelId, target);
    } else if (action === 'edit') {
      const name = target.getAttribute('data-model-name') || modelId;
      const contextWindow = parseInt(target.getAttribute('data-context-window'), 10) || 128000;
      showEditModelDialog(provider, modelId, name, contextWindow);
    } else if (action === 'delete') {
      deleteModel(provider, modelId);
    } else if (action === 'pick-cliproxy') {
      pickCliproxyModel(modelId);
    } else if (action === 'add-cliproxy') {
      addCliproxyModel(modelId);
    } else if (action === 'remove-model') {
      removeModelById(provider, modelId);
    }
  });

  window.refreshLangDynamic = function() {
    renderModels();
    initModelSourceSelector();
    if (_lastCliproxyModels.length > 0) renderCliproxyComparison(_lastCliproxyModels);
  };

  window.loadModelsManager = function() {
    initModelSourceSelector();
    initProxyProviderSelect();
    loadModels();
    setLang(currentLang);
  };

  window.switchModelSource = switchModelSource;
  window.showAddModelDialog = showAddModelDialog;
  window.hideAddModelDialog = hideAddModelDialog;
  window.addModel = addModel;
  window.fetchCliproxyModelsForAdd = fetchCliproxyModelsForAdd;
  window.pickCliproxyModel = pickCliproxyModel;
  window.showEditModelDialog = showEditModelDialog;
  window.hideEditModelDialog = hideEditModelDialog;
  window.editModel = editModel;
  window.deleteModel = deleteModel;
  window.testModel = testModel;
  window.testAllModels = testAllModels;
  window.clearBatchTestResults = clearBatchTestResults;
  window.fetchCliproxyModels = fetchCliproxyModels;
  window.addCliproxyModel = addCliproxyModel;
  window.removeModelById = removeModelById;
  window.addAllNewCliproxyModels = addAllNewCliproxyModels;
  window.removeAllExpiredCliproxyModels = removeAllExpiredCliproxyModels;
})();
