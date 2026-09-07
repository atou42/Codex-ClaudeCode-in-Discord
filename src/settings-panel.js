import { randomBytes } from 'node:crypto';

import {
  formatBusyPromptModeLabel,
  formatCodexProfileLabel,
  formatCompactThresholdValue,
  formatReplyDeliveryModeLabel,
  parseCompactConfigAction,
} from './session-settings.js';

const SETTINGS_COMPONENT_PREFIX = 'stg';
const SETTINGS_MODAL_PREFIX = 'stgm';
const MODEL_INPUT_ID = 'model_name';
const MODEL_SEARCH_INPUT_ID = 'model_search_query';
const CODEX_PROFILE_INPUT_ID = 'codex_profile_name';
const COMPACT_THRESHOLD_INPUT_ID = 'compact_threshold_tokens';

const ALL_SECTIONS = Object.freeze([
  'overview',
  'defaults',
  'provider',
  'profile',
  'model',
  'fast',
  'runtime',
  'effort',
  'compact',
  'reply',
  'language',
  'mode',
  'workspace',
]);

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

function normalizeSection(value) {
  const section = String(value || '').trim().toLowerCase();
  return ALL_SECTIONS.includes(section) ? section : 'overview';
}

function formatSettingSourceLabel(source, language) {
  const value = String(source || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'session override') return 'this channel';
    if (value === 'parent channel') return 'parent channel';
    if (value === 'config.toml') return 'global config';
    if (value === 'settings.json') return 'Antigravity settings';
    if (value === 'built-in default') return 'built-in default';
    if (value === 'env default') return 'env default';
    if (value === 'provider env') return 'provider env';
    if (value === 'provider') return 'provider default';
    if (value === 'provider unsupported') return 'not supported';
    if (value === 'thread override') return 'this channel';
    if (value === 'provider default') return 'provider default';
    if (value === 'legacy env') return 'legacy env';
    if (value === 'legacy fallback') return 'legacy fallback';
    if (value === 'unset') return 'unset';
    return value || 'unknown';
  }

  if (value === 'session override') return '当前频道';
  if (value === 'parent channel') return '父频道默认';
  if (value === 'config.toml') return '全局配置';
  if (value === 'settings.json') return 'Antigravity 设置';
  if (value === 'built-in default') return '内建默认';
  if (value === 'env default') return '环境默认';
  if (value === 'provider env') return 'provider 环境配置';
  if (value === 'provider') return 'provider 默认';
  if (value === 'provider unsupported') return '当前 provider 不支持';
  if (value === 'thread override') return '当前频道';
  if (value === 'provider default') return 'provider 默认';
  if (value === 'legacy env') return '旧版环境配置';
  if (value === 'legacy fallback') return 'legacy 回退';
  if (value === 'unset') return '未设置';
  return value || '未知';
}

function formatFastModeLabel(enabled, language) {
  return enabled
    ? (language === 'en' ? 'on' : '开启')
    : (language === 'en' ? 'off' : '关闭');
}

function formatRuntimeModeLabel(mode, language) {
  return mode === 'long'
    ? (language === 'en' ? 'long (hot session)' : 'long（热会话）')
    : (language === 'en' ? 'exec (per request)' : 'exec（每轮启动）');
}

function formatWorkspaceLabel(binding, language) {
  const workspaceDir = String(binding?.workspaceDir || '').trim();
  const source = formatSettingSourceLabel(binding?.source, language);
  if (!workspaceDir) {
    return language === 'en'
      ? `(unset) (${source})`
      : `（未设置）（${source}）`;
  }
  return language === 'en'
    ? `\`${workspaceDir}\` (${source})`
    : `\`${workspaceDir}\`（${source}）`;
}

function formatValueLabel(value, fallback, language) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (text.startsWith('(') && text.endsWith(')')) return text;
  return `\`${text}\``;
}

function formatNativeCompactLimit(setting, language) {
  const value = setting?.tokens === null || setting?.tokens === undefined
    ? 'auto'
    : String(setting.tokens);
  const source = formatSettingSourceLabel(setting?.source, language);
  return language === 'en' ? `${value} (${source})` : `${value}（${source}）`;
}

function formatModelPlaceholder(provider, language) {
  if (provider === 'antigravity') {
    return language === 'en'
      ? 'e.g. Claude Opus 4.6 (Thinking), Gemini 3.5 Flash (High), default'
      : '例如 Claude Opus 4.6 (Thinking)、Gemini 3.5 Flash (High)、default';
  }
  if (provider === 'claude') {
    return language === 'en'
      ? 'e.g. sonnet, opus, claude-sonnet-4-6, default'
      : '例如 sonnet、opus、claude-sonnet-4-6、default';
  }
  return language === 'en'
    ? 'e.g. gpt-5.4, o3, default'
    : '例如 gpt-5.4、o3、default';
}

function hasConfiguredCodexDefault(value, configured) {
  const text = String(value || '').trim();
  return Boolean(configured && text && text !== '(unknown)');
}

function formatCodexGlobalStringDefault(value, configured, language) {
  return hasConfiguredCodexDefault(value, configured)
    ? formatValueLabel(value, '', language)
    : (language === 'en' ? '(provider default)' : '（provider 默认）');
}

function formatSectionButtonLabel(section, language) {
  const labels = {
    overview: { en: 'overview', zh: '总览' },
    defaults: { en: 'defaults', zh: '默认' },
    provider: { en: 'provider', zh: '后端' },
    profile: { en: 'profile', zh: '配置' },
    model: { en: 'model', zh: '模型' },
    fast: { en: 'fast', zh: 'fast' },
    runtime: { en: 'runtime', zh: '运行时' },
    effort: { en: 'effort', zh: '推理' },
    compact: { en: 'compact', zh: '压缩' },
    reply: { en: 'reply', zh: '回复' },
    language: { en: 'language', zh: '语言' },
    mode: { en: 'mode', zh: '执行' },
    workspace: { en: 'workspace', zh: '目录' },
    close: { en: 'close', zh: '关闭' },
  };
  return labels[section]?.[language] || section;
}

function formatSectionTitleLabel(section, language) {
  const labels = {
    overview: { en: 'Overview', zh: '总览' },
    defaults: { en: 'Codex Defaults', zh: 'Codex 默认' },
    provider: { en: 'Provider', zh: 'Provider' },
    profile: { en: 'Codex Profile', zh: 'Codex Profile' },
    model: { en: 'Model', zh: '模型' },
    fast: { en: 'Fast Mode', zh: 'Fast Mode' },
    runtime: { en: 'Runtime', zh: '运行时' },
    effort: { en: 'Reasoning Effort', zh: '推理力度' },
    compact: { en: 'Context Compaction', zh: '上下文压缩' },
    reply: { en: 'Reply Delivery', zh: '回复方式' },
    language: { en: 'Language', zh: '语言' },
    mode: { en: 'Execution Mode', zh: '执行模式' },
    workspace: { en: 'Workspace', zh: '工作目录' },
  };
  return labels[section]?.[language] || section;
}

function formatReplyDeliveryButtonLabel(mode, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  if (mode === 'card_mention') return lang === 'en' ? 'Card + @' : '进度卡 + @';
  if (mode === 'stream_mention') return lang === 'en' ? 'Stream + @' : '过程消息 + @';
  if (mode === 'card_only') return lang === 'en' ? 'Card only' : '仅进度卡';
  if (mode === 'stream_only') return lang === 'en' ? 'Stream only' : '仅过程消息';
  return mode;
}

function buildSettingsComponentId(kind, target, value, userId, generation = '') {
  const base = `${SETTINGS_COMPONENT_PREFIX}:${kind}:${target}:${value}:${String(userId || '').trim()}`;
  const token = String(generation || '').trim().toLowerCase();
  return token ? `${base}:${token}` : base;
}

function buildSettingsModalId(target, userId, generation = '') {
  const base = `${SETTINGS_MODAL_PREFIX}:${target}:${String(userId || '').trim()}`;
  const token = String(generation || '').trim().toLowerCase();
  return token ? `${base}:${token}` : base;
}

function parseSettingsComponentId(customId) {
  const match = /^stg:(nav|set|act):([a-z_]+):([a-z0-9_-]+):([0-9]{5,32})(?::([a-z0-9_-]{1,16}))?$/i.exec(String(customId || '').trim());
  if (!match) return null;
  return {
    kind: String(match[1] || '').trim().toLowerCase(),
    target: String(match[2] || '').trim().toLowerCase(),
    value: String(match[3] || '').trim().toLowerCase(),
    userId: String(match[4] || '').trim(),
    generation: String(match[5] || '').trim().toLowerCase() || null,
  };
}

function parseSettingsModalId(customId) {
  const match = /^stgm:([a-z_]+):([0-9]{5,32})(?::([a-z0-9_-]{1,16}))?$/i.exec(String(customId || '').trim());
  if (!match) return null;
  return {
    target: String(match[1] || '').trim().toLowerCase(),
    userId: String(match[2] || '').trim(),
    generation: String(match[3] || '').trim().toLowerCase() || null,
  };
}

function isSettingsPanelComponentId(customId) {
  return Boolean(parseSettingsComponentId(customId));
}

function isSettingsPanelModalId(customId) {
  return Boolean(parseSettingsModalId(customId));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function truncateOptionText(value, maxLength = 100) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1);
}

function normalizeModelCatalog(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    models: models.map((model) => {
      const slug = String(model?.slug || '').trim();
      const displayName = String(model?.displayName || model?.display_name || slug).trim();
      const levels = Array.isArray(model?.supportedReasoningLevels)
        ? model.supportedReasoningLevels
        : model?.supported_reasoning_levels;
      const supportedReasoningLevels = Array.isArray(levels)
        ? levels.map((level) => String(level?.effort || level || '').trim()).filter(Boolean)
        : [];
      return {
        slug,
        displayName: displayName || slug,
        description: String(model?.description || '').trim(),
        defaultReasoningLevel: String(model?.defaultReasoningLevel || model?.default_reasoning_level || '').trim(),
        supportedReasoningLevels,
        visibility: String(model?.visibility || '').trim().toLowerCase(),
      };
    }).filter((model) => model.slug),
    error: catalog?.error ? String(catalog.error) : null,
  };
}

function normalizeModelSearchQuery(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function rankModelSearchMatch(model, query) {
  const fields = [model.slug, model.displayName, model.description]
    .map((value) => String(value || '').trim().toLowerCase());
  if (fields.some((value) => value === query)) return 0;
  if (fields.some((value) => value.startsWith(query))) return 1;
  if (fields.some((value) => value.includes(query))) return 2;
  return null;
}

function searchModelCatalog(models, query) {
  const normalizedQuery = normalizeModelSearchQuery(query);
  if (!normalizedQuery) return [...models];
  return models
    .map((model, index) => ({ model, index, score: rankModelSearchMatch(model, normalizedQuery) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.model);
}

function buildModelSelectOptions(snapshot, session, {
  currentOverride: overrideValue = session?.model,
  effectiveModel: effectiveValue = snapshot.modelValue,
  query = '',
} = {}) {
  const currentOverride = String(overrideValue || '').trim();
  const effectiveModel = String(effectiveValue || '').trim();
  const providerDefaultModel = String(snapshot.defaults?.model || '').trim();
  const normalizedQuery = normalizeModelSearchQuery(query);
  const options = [{
    label: snapshot.language === 'en' ? 'Use provider default' : '使用 provider 默认',
    value: 'default',
    description: truncateOptionText(snapshot.language === 'en'
      ? `Effective: ${effectiveModel || '(provider default)'}`
      : `当前生效：${effectiveModel || 'provider 默认'}`),
    default: !currentOverride,
  }];
  const seen = new Set(['default']);
  let hasCurrentOverride = !currentOverride;

  const addModelOption = (model, { effective = false, providerDefault = false } = {}) => {
    if (!model || seen.has(model.slug) || options.length >= 25) return;
    seen.add(model.slug);
    if (model.visibility === 'hide' || model.visibility === 'hidden') {
      if (currentOverride === model.slug) hasCurrentOverride = true;
      return;
    }
    const isCurrent = currentOverride === model.slug;
    if (isCurrent) hasCurrentOverride = true;
    options.push({
      label: truncateOptionText(model.displayName || model.slug),
      value: model.slug,
      description: truncateOptionText(providerDefault && !isCurrent
        ? (snapshot.language === 'en'
          ? 'Provider default model'
          : 'provider 默认模型')
        : (effective && !isCurrent
          ? (snapshot.language === 'en' ? 'Current effective model' : '当前生效模型')
          : (model.defaultReasoningLevel
            ? `default effort: ${model.defaultReasoningLevel}`
            : (model.description || model.slug)))),
      default: isCurrent,
    });
  };

  if (!normalizedQuery) {
    const initiallyVisible = new Set(snapshot.modelCatalog.models
      .filter((model) => model.visibility !== 'hide' && model.visibility !== 'hidden')
      .slice(0, 24)
      .map((model) => model.slug));
    for (const { slug, effective, providerDefault } of [
      { slug: currentOverride, effective: currentOverride === effectiveModel, providerDefault: false },
      { slug: providerDefaultModel, effective: providerDefaultModel === effectiveModel, providerDefault: true },
      { slug: effectiveModel, effective: true, providerDefault: false },
    ]) {
      if (!slug) continue;
      const model = snapshot.modelCatalog.models.find((entry) => entry.slug === slug);
      if (model && !initiallyVisible.has(slug)) {
        addModelOption(model, { effective, providerDefault });
      }
    }
    if (currentOverride && !snapshot.modelCatalog.models.some((model) => model.slug === currentOverride)) {
      seen.add(currentOverride);
      hasCurrentOverride = true;
      options.push({
        label: truncateOptionText(currentOverride),
        value: currentOverride,
        description: snapshot.language === 'en' ? 'Current custom model' : '当前手写模型',
        default: true,
      });
    }
  }

  for (const model of searchModelCatalog(snapshot.modelCatalog.models, normalizedQuery)) {
    addModelOption(model);
    if (options.length >= 25) break;
  }

  if (!hasCurrentOverride && currentOverride && options.length < 25) {
    options.push({
      label: truncateOptionText(currentOverride),
      value: currentOverride,
      description: snapshot.language === 'en' ? 'Current custom model' : '当前手写模型',
      default: true,
    });
  }

  return options;
}

function findCatalogModel(modelCatalog, modelName) {
  const slug = String(modelName || '').trim();
  if (!slug) return null;
  return modelCatalog.models.find((model) => model.slug === slug) || null;
}

function resolveModelEffortLevels(snapshot, session, modelName = '') {
  const effectiveModel = String(modelName || session?.model || snapshot.modelValue || '').trim();
  const catalogModel = findCatalogModel(snapshot.modelCatalog, effectiveModel);
  return catalogModel?.supportedReasoningLevels.length
    ? [...catalogModel.supportedReasoningLevels]
    : [...snapshot.effortLevels];
}

function resolveGlobalModelEffortLevels(snapshot) {
  const configuredModel = snapshot.codexDefaults?.modelConfigured
    ? String(snapshot.codexDefaults.model || '').trim()
    : '';
  const catalogModel = findCatalogModel(snapshot.modelCatalog, configuredModel);
  return catalogModel?.supportedReasoningLevels.length
    ? [...catalogModel.supportedReasoningLevels]
    : [...snapshot.effortLevels];
}

function formatUnsupportedModelEffort(model, effort, language, { current = false } = {}) {
  if (language === 'en') {
    return current
      ? `❌ Model \`${model}\` does not support the current effort \`${effort}\`.`
      : `❌ Model \`${model}\` does not support \`${effort}\`.`;
  }
  return current
    ? `❌ 模型 \`${model}\` 不支持当前的 effort \`${effort}\`。`
    : `❌ 模型 \`${model}\` 不支持 effort \`${effort}\`。`;
}

function normalizeResolvedEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort || effort.includes('default') || effort.startsWith('(') || effort.startsWith('（')) return '';
  return effort;
}

export function createSettingsPanel({
  botProvider = null,
  defaultUiLanguage = 'zh',
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  getSession = () => null,
  getSessionLanguage = () => defaultUiLanguage,
  getSessionProvider = () => 'codex',
  getWorkspaceBinding = () => ({ workspaceDir: null, source: 'unset' }),
  getProviderDefaults = () => ({ model: '(provider default)', effort: '(provider default)', source: 'provider' }),
  resolveCodexProfileSetting = () => ({ value: null, source: 'provider default', supported: false, valid: true, isExplicit: false }),
  getDefaultCodexProfile = () => ({ profile: null, source: 'env default' }),
  getProviderDisplayName = (provider) => String(provider || ''),
  getSupportedReasoningEffortLevels = () => [],
  getModelCatalog = () => ({ models: [], error: null }),
  getProviderCompactCapabilities = () => ({ strategies: ['hard', 'native', 'off'] }),
  normalizeUiLanguage = normalizeLanguage,
  resolveModelSetting = (session) => ({ value: session?.model || '(provider default)', source: session?.model ? 'session override' : 'provider' }),
  resolveReasoningEffortSetting = (session) => ({ value: session?.effort || '(provider default)', source: session?.effort ? 'session override' : 'provider' }),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  resolveRuntimeModeSetting = () => ({ mode: 'normal', supported: false, source: 'provider unsupported' }),
  resolveBusyPromptModeSetting = () => ({ mode: 'queue', requestedMode: 'queue', canSteer: false, supported: true, source: 'built-in default', reason: null }),
  resolveCompactStrategySetting = () => ({ strategy: 'native', source: 'env default' }),
  resolveCompactThresholdSetting = () => ({ tokens: 0, source: 'env default' }),
  resolveNativeCompactTokenLimitSetting = () => ({ tokens: null, source: 'provider default' }),
  resolveReplyDeliverySetting = () => ({ mode: 'card_mention', source: 'env default' }),
  getReplyDeliveryDefault = () => ({ mode: 'card_mention', source: 'env default' }),
  getChannelState = () => null,
  safeChannelSend = async (target, payload) => target?.channel?.send?.(payload),
  commandActions = {},
  closeRuntimeSession = () => false,
  openWorkspaceBrowser,
  slashRef = (name) => `/${name}`,
} = {}) {
  const closeRuntimeForKey = (key, reason = 'runtime config changed') => {
    try {
      closeRuntimeSession(key, reason);
    } catch {
    }
  };
  const modelPanelGenerations = new Map();
  const modelPanelScope = (key, userId) => `${String(key || '').trim()}:${String(userId || '').trim()}`;
  const issueModelPanelGeneration = (key, userId) => {
    const generation = randomBytes(6).toString('hex');
    modelPanelGenerations.set(modelPanelScope(key, userId), generation);
    return generation;
  };
  const isCurrentModelPanelGeneration = (key, userId, generation) => (
    Boolean(generation)
    && modelPanelGenerations.get(modelPanelScope(key, userId)) === generation
  );
  const isModelPanelTarget = (target) => [
    'model',
    'model_effort',
    'quick_model',
    'quick_model_effort',
    'model_search',
    'quick_model_search',
    'default_model',
    'default_effort',
  ].includes(target);
  const resolveRequestedModel = (key, session, requestedModel) => {
    const normalized = String(requestedModel || '').trim();
    if (normalized.toLowerCase() !== 'default') return normalized;
    return String(buildSnapshot(key, { ...session, model: null }).modelValue || '').trim();
  };
  const findModelEffortConflict = (key, session, requestedModel) => {
    const snapshot = buildSnapshot(key, session);
    const model = resolveRequestedModel(key, session, requestedModel);
    const catalogModel = findCatalogModel(snapshot.modelCatalog, model);
    const effort = normalizeResolvedEffort(snapshot.effortValue);
    if (!catalogModel || !effort || catalogModel.supportedReasoningLevels.includes(effort)) return null;
    return { model, effort };
  };
  const findEffortConflict = (key, session, requestedEffort) => {
    const candidate = {
      ...session,
      effort: requestedEffort === 'default' ? null : requestedEffort,
    };
    const snapshot = buildSnapshot(key, candidate);
    const model = String(snapshot.modelValue || candidate.model || '').trim();
    const catalogModel = findCatalogModel(snapshot.modelCatalog, model);
    const effort = normalizeResolvedEffort(snapshot.effortValue);
    if (!catalogModel || !effort || catalogModel.supportedReasoningLevels.includes(effort)) return null;
    return { model, effort };
  };
  const findGlobalModelEffortConflict = (key, session, requestedModel) => {
    const snapshot = buildSnapshot(key, session);
    const model = String(requestedModel || '').trim();
    const effort = snapshot.codexDefaults?.effortConfigured
      ? normalizeResolvedEffort(snapshot.codexDefaults.effort)
      : '';
    if (!model || model.toLowerCase() === 'default' || !effort) return null;
    const catalogModel = findCatalogModel(snapshot.modelCatalog, model);
    if (!catalogModel?.supportedReasoningLevels.length || catalogModel.supportedReasoningLevels.includes(effort)) return null;
    return { model, effort };
  };
  const findGlobalEffortConflict = (key, session, requestedEffort) => {
    const snapshot = buildSnapshot(key, session);
    const model = snapshot.codexDefaults?.modelConfigured
      ? String(snapshot.codexDefaults.model || '').trim()
      : '';
    const effort = normalizeResolvedEffort(requestedEffort);
    if (!model || !effort || String(requestedEffort || '').trim().toLowerCase() === 'default') return null;
    const catalogModel = findCatalogModel(snapshot.modelCatalog, model);
    if (!catalogModel?.supportedReasoningLevels.length || catalogModel.supportedReasoningLevels.includes(effort)) return null;
    return { model, effort };
  };

  const shouldStreamProcessMessages = (mode) => mode === 'stream_mention' || mode === 'stream_only';
  const normalizeProcessActivityKey = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

  async function flushActiveRunProcessMessages(interaction, key, session, { beforeMode } = {}) {
    const afterMode = resolveReplyDeliverySetting(session).mode;
    if (shouldStreamProcessMessages(beforeMode) || !shouldStreamProcessMessages(afterMode)) return;
    const activeRun = getChannelState(key)?.activeRun;
    const activities = Array.isArray(activeRun?.recentActivities) ? activeRun.recentActivities : [];
    if (!activeRun || activities.length === 0) return;

    if (!activeRun.streamedProcessActivityKeys || !Array.isArray(activeRun.streamedProcessActivityKeys)) {
      activeRun.streamedProcessActivityKeys = [];
    }
    const sentKeys = new Set(activeRun.streamedProcessActivityKeys.map(normalizeProcessActivityKey));
    for (const activity of activities) {
      const keyName = normalizeProcessActivityKey(activity);
      if (!keyName || sentKeys.has(keyName)) continue;
      sentKeys.add(keyName);
      activeRun.streamedProcessActivityKeys.push(activity);
      await safeChannelSend(interaction, activity);
    }
  }

  function getAvailableSections(session) {
    const provider = getSessionProvider(session);
    const sections = ['overview'];
    if (provider === 'codex') sections.push('defaults');
    if (!botProvider) sections.push('provider');
    if (provider === 'codex') sections.push('profile');
    sections.push('model');
    if (provider === 'codex' || provider === 'omp') sections.push('fast');
    if (provider === 'codex' || provider === 'claude') sections.push('runtime');
    if (getSupportedReasoningEffortLevels(provider).length) sections.push('effort');
    if (getProviderCompactCapabilities(provider).strategies.length > 0) sections.push('compact');
    sections.push('reply', 'language', 'mode', 'workspace');
    return sections;
  }

  function resolveActiveSection(session, requested) {
    const normalized = normalizeSection(requested);
    return getAvailableSections(session).includes(normalized) ? normalized : 'overview';
  }

  function resolveDefaultSection(session) {
    return getSessionProvider(session) === 'codex' ? 'defaults' : 'overview';
  }

  function buildSnapshot(key, session) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const provider = getSessionProvider(session);
    const defaults = getProviderDefaults(provider);
    const codexDefaults = provider === 'codex'
      ? (getProviderDefaults('codex') || {})
      : null;
    const codexProfile = resolveCodexProfileSetting(session);
    const codexProfileDefault = getDefaultCodexProfile(session);
    const modelSetting = resolveModelSetting(session);
    const effortSetting = resolveReasoningEffortSetting(session);
    const fastMode = resolveFastModeSetting(session);
    const runtimeMode = resolveRuntimeModeSetting(session);
    const busyPromptMode = resolveBusyPromptModeSetting(session);
    const compact = resolveCompactStrategySetting(session);
    const compactThreshold = resolveCompactThresholdSetting(session);
    const nativeCompactLimit = resolveNativeCompactTokenLimitSetting(session);
    const replyDelivery = resolveReplyDeliverySetting(session);
    const replyDefault = getReplyDeliveryDefault(session);
    const workspace = getWorkspaceBinding(session, key) || { workspaceDir: null, source: 'unset' };
    const effortLevels = getSupportedReasoningEffortLevels(provider);
    const modelCatalog = normalizeModelCatalog(getModelCatalog(provider));
    const snapshot = {
      language,
      isThread: Boolean(session?.parentChannelId),
      provider,
      providerLabel: getProviderDisplayName(provider),
      defaults,
      codexDefaults,
      codexProfile,
      codexProfileDefault,
      fastMode,
      runtimeMode,
      busyPromptMode,
      compact,
      compactThreshold,
      nativeCompactLimit,
      replyDelivery,
      replyDefault,
      workspace,
      effortLevels,
      modelCatalog,
      modelValue: modelSetting?.value || defaults.model,
      modelSource: modelSetting?.source || defaults.source,
      effortValue: effortLevels.length ? (effortSetting?.value || defaults.effort) : null,
      effortSource: effortLevels.length ? (effortSetting?.source || defaults.source) : defaults.source,
    };
    snapshot.modelEffortLevels = resolveModelEffortLevels(snapshot, session);
    return snapshot;
  }

  function buildSectionNavigation(session, userId, activeSection) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const available = getAvailableSections(session);
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildSettingsComponentId('nav', 'section', 'picker', userId))
          .setPlaceholder(language === 'en' ? 'Choose a settings section' : '选择设置分区')
          .addOptions(
            available.map((section) => ({
              label: formatSectionTitleLabel(section, language),
              value: section,
              default: activeSection === section,
            })),
          ),
      ),
    ];
  }

  function buildCloseRow(session, userId) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildSettingsComponentId('act', 'panel', 'close', userId))
        .setLabel(formatSectionButtonLabel('close', language))
        .setStyle(ButtonStyle.Danger),
    );
  }

  function buildModelControlRows(session, userId, snapshot, { quick = false, generation = '', modelQuery = '' } = {}) {
    const modelTarget = quick ? 'quick_model' : 'model';
    const effortTarget = quick ? 'quick_model_effort' : 'model_effort';
    const modelOptions = buildModelSelectOptions(snapshot, session, { query: modelQuery });
    const rows = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildSettingsComponentId('set', modelTarget, 'preset', userId, generation))
          .setPlaceholder(snapshot.language === 'en'
            ? `Current model: ${snapshot.modelValue || '(provider default)'}`
            : `当前模型：${snapshot.modelValue || 'provider 默认'}`)
          .addOptions(modelOptions),
      ),
    ];
    const modelActionButtons = [
      new ButtonBuilder()
        .setCustomId(buildSettingsComponentId('act', modelTarget, 'search', userId, generation))
        .setLabel(snapshot.language === 'en' ? 'Search models' : '搜索模型')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildSettingsComponentId('act', modelTarget, 'custom', userId, generation))
        .setLabel(snapshot.language === 'en' ? 'Type custom model' : '手写模型名')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildSettingsComponentId('act', modelTarget, 'default', userId, generation))
        .setLabel(snapshot.language === 'en' ? 'Use provider default' : '使用 provider 默认')
        .setStyle(!session?.model ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ];
    if (snapshot.modelEffortLevels.length) {
      const effortRows = chunk([...snapshot.modelEffortLevels, 'default'], 5).map((rowValues) => new ActionRowBuilder().addComponents(
        ...rowValues.map((value) => {
          const selected = value === 'default'
            ? !session?.effort
            : session?.effort === value;
          return new ButtonBuilder()
            .setCustomId(buildSettingsComponentId('set', effortTarget, value, userId, generation))
            .setLabel(value)
            .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
        }),
      ));
      const lastEffortRow = effortRows.at(-1);
      const lastEffortRowSize = [...snapshot.modelEffortLevels, 'default'].length % 5 || 5;
      if (lastEffortRowSize + modelActionButtons.length <= 5) {
        lastEffortRow.addComponents(...modelActionButtons);
      } else {
        effortRows.push(new ActionRowBuilder().addComponents(...modelActionButtons));
      }
      rows.push(...effortRows);
    } else {
      rows.push(new ActionRowBuilder().addComponents(...modelActionButtons));
    }
    return rows;
  }

  function buildSectionControls(key, session, userId, activeSection, snapshot, modelPanelGeneration = '') {
    switch (activeSection) {
      case 'provider': {
        if (botProvider) return [];
        return chunk(['codex', 'claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp'], 5)
          .map((providers) => new ActionRowBuilder().addComponents(
            ...providers.map((provider) => new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'provider', provider, userId))
              .setLabel(provider)
              .setStyle(snapshot.provider === provider ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ));
      }

      case 'defaults': {
        if (snapshot.provider !== 'codex' || !snapshot.codexDefaults) return [];

        const defaultFastSelected = !snapshot.codexDefaults.fastModeConfigured
          ? 'default'
          : (snapshot.codexDefaults.fastMode ? 'on' : 'off');
        const configuredModel = snapshot.codexDefaults.modelConfigured
          ? String(snapshot.codexDefaults.model || '').trim()
          : '';
        const modelOptions = buildModelSelectOptions(snapshot, session, {
          currentOverride: configuredModel,
          effectiveModel: configuredModel,
        });
        const effortLevels = resolveGlobalModelEffortLevels(snapshot);
        const effortOptions = [...effortLevels, 'default'].map((value) => ({
          label: value,
          value,
          default: value === 'default'
            ? !snapshot.codexDefaults.effortConfigured
            : snapshot.codexDefaults.effortConfigured && snapshot.codexDefaults.effort === value,
        }));
        return [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_model', 'preset', userId, modelPanelGeneration))
              .setPlaceholder(snapshot.language === 'en'
                ? `Global model: ${configuredModel || '(provider default)'}`
                : `全局模型：${configuredModel || 'provider 默认'}`)
              .addOptions(modelOptions),
          ),
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_effort', 'preset', userId, modelPanelGeneration))
              .setPlaceholder(snapshot.language === 'en'
                ? `Global effort: ${snapshot.codexDefaults.effortConfigured ? snapshot.codexDefaults.effort : '(provider default)'}`
                : `全局 effort：${snapshot.codexDefaults.effortConfigured ? snapshot.codexDefaults.effort : 'provider 默认'}`)
              .addOptions(effortOptions),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'default_profile', 'custom', userId))
              .setLabel(snapshot.language === 'en' ? 'Set profile' : '设置 profile')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'default_model', 'custom', userId, modelPanelGeneration))
              .setLabel(snapshot.language === 'en' ? 'Custom model' : '手写 model')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_fast', 'default', userId))
              .setLabel(snapshot.language === 'en' ? 'Use built-in default' : '使用内建默认')
              .setStyle(defaultFastSelected === 'default' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_fast', 'on', userId))
              .setLabel(snapshot.language === 'en' ? 'On' : '开启')
              .setStyle(defaultFastSelected === 'on' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_fast', 'off', userId))
              .setLabel(snapshot.language === 'en' ? 'Off' : '关闭')
              .setStyle(defaultFastSelected === 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'profile': {
        const selected = snapshot.codexProfile.source === 'session override'
          ? snapshot.codexProfile.value
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow global' : '跟随全局');
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'profile', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(selected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'profile', 'custom', userId))
              .setLabel(snapshot.language === 'en' ? 'Set custom profile' : '设置自定义 profile')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'profile', 'clear', userId))
              .setLabel(snapshot.language === 'en' ? 'Use provider default' : '使用 provider 默认')
              .setStyle(!snapshot.codexProfile.isExplicit ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'language':
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'language', 'zh', userId))
              .setLabel('中文')
              .setStyle(snapshot.language === 'zh' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'language', 'en', userId))
              .setLabel('English')
              .setStyle(snapshot.language === 'en' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];

      case 'mode':
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'mode', 'safe', userId))
              .setLabel('safe')
              .setStyle(session?.modeOverride !== null && session?.mode === 'safe' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'mode', 'dangerous', userId))
              .setLabel('dangerous')
              .setStyle(session?.modeOverride !== null && session?.mode === 'dangerous' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'mode', 'default', userId))
              .setLabel(snapshot.isThread
                ? (snapshot.language === 'en' ? 'Follow parent/default' : '跟随父频道/默认')
                : (snapshot.language === 'en' ? 'Follow default' : '跟随默认'))
              .setStyle(session?.modeOverride === null ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];

      case 'fast': {
        const selected = snapshot.fastMode.source === 'session override'
          ? (snapshot.fastMode.enabled ? 'on' : 'off')
          : 'follow';
        const followLabel = snapshot.provider === 'omp'
          ? (snapshot.isThread
            ? (snapshot.language === 'en' ? 'Follow parent/OMP default' : '跟随父频道/OMP 默认')
            : (snapshot.language === 'en' ? 'Follow OMP default' : '跟随 OMP 默认'))
          : (snapshot.isThread
            ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
            : (snapshot.language === 'en' ? 'Follow global' : '跟随全局'));
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'fast', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(selected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'fast', 'on', userId))
              .setLabel(snapshot.language === 'en' ? 'On' : '开启')
              .setStyle(selected === 'on' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'fast', 'off', userId))
              .setLabel(snapshot.language === 'en' ? 'Off' : '关闭')
              .setStyle(selected === 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'runtime': {
        const selected = snapshot.runtimeMode.source === 'session override'
          ? snapshot.runtimeMode.mode
          : 'follow';
        const busySelected = snapshot.busyPromptMode.source === 'session override'
          ? snapshot.busyPromptMode.requestedMode
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow default' : '跟随默认');
        const steerDisabled = !snapshot.busyPromptMode.canSteer;
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'runtime', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(selected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'runtime', 'normal', userId))
              .setLabel('exec')
              .setStyle(selected === 'normal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'runtime', 'long', userId))
              .setLabel('long')
              .setStyle(selected === 'long' ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(!snapshot.runtimeMode.supported),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'busy_prompt', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(busySelected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'busy_prompt', 'queue', userId))
              .setLabel(snapshot.language === 'en' ? 'queue' : '排队')
              .setStyle(busySelected === 'queue' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'busy_prompt', 'steer', userId))
              .setLabel(snapshot.language === 'en' ? 'steer' : 'steer')
              .setStyle(busySelected === 'steer_if_possible' ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(steerDisabled),
          ),
        ];
      }

      case 'effort': {
        const values = [...snapshot.effortLevels, 'default'];
        return chunk(values, 5).map((rowValues) => new ActionRowBuilder().addComponents(
          ...rowValues.map((value) => {
            const selected = value === 'default'
              ? !session?.effort
              : session?.effort === value;
            return new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'effort', value, userId))
              .setLabel(value)
              .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
          }),
        ));
      }

      case 'compact': {
        const compactCapabilities = getProviderCompactCapabilities(snapshot.provider);
        const values = ['follow', ...compactCapabilities.strategies];
        const rows = [
          new ActionRowBuilder().addComponents(
            ...values.map((value) => {
              const selected = value === 'follow'
                ? !session?.compactStrategy
                : session?.compactStrategy === value;
              const label = value === 'follow'
                ? (snapshot.language === 'en' ? 'Follow default' : '跟随默认')
                : value;
              return new ButtonBuilder()
                .setCustomId(buildSettingsComponentId('set', 'compact', value, userId))
                .setLabel(label)
                .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
            }),
          ),
        ];
        if (snapshot.compact.strategy === 'off') return rows;

        const usesNativeLimit = snapshot.compact.strategy === 'native'
          && compactCapabilities.supportsNativeLimit;
        const target = usesNativeLimit ? 'native_compact_limit' : 'compact_threshold';
        const usesDefault = usesNativeLimit
          ? session?.nativeCompactTokenLimit === null || session?.nativeCompactTokenLimit === undefined
          : session?.compactThresholdTokens === null || session?.compactThresholdTokens === undefined;
        rows.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', target, 'custom', userId))
              .setLabel(snapshot.language === 'en'
                ? (usesNativeLimit ? 'Set native limit' : 'Set hard threshold')
                : (usesNativeLimit ? '设置 native 阈值' : '设置 hard 阈值'))
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', target, 'default', userId))
              .setLabel(snapshot.language === 'en'
                ? (usesNativeLimit ? 'Use auto' : 'Follow default threshold')
                : (usesNativeLimit ? '使用 auto' : '跟随默认阈值'))
              .setStyle(usesDefault ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        );
        return rows;
      }

      case 'reply': {
        const currentSelected = snapshot.replyDelivery.source === 'session override'
          ? snapshot.replyDelivery.mode
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow global' : '跟随全局');
        const replyModes = ['card_mention', 'stream_mention', 'card_only', 'stream_only'];
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'reply', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(currentSelected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            ...replyModes.map((mode) => new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'reply', mode, userId))
              .setLabel(formatReplyDeliveryButtonLabel(mode, snapshot.language))
              .setStyle(currentSelected === mode ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ),
          new ActionRowBuilder().addComponents(
            ...replyModes.map((mode) => new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_reply', mode, userId))
              .setLabel(formatReplyDeliveryButtonLabel(mode, snapshot.language))
              .setStyle(snapshot.replyDefault.mode === mode ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ),
        ];
      }

      case 'model':
        return buildModelControlRows(session, userId, snapshot, { generation: modelPanelGeneration });

      case 'workspace':
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'workspace', 'browse', userId))
              .setLabel(snapshot.language === 'en' ? 'Browse workspace' : '浏览 workspace')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'workspace', 'clear', userId))
              .setLabel(snapshot.language === 'en' ? 'Follow provider default' : '跟随 provider 默认')
              .setStyle(!session?.workspaceDir ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(!session?.workspaceDir),
          ),
        ];

      default:
        return [];
    }
  }

function formatOverviewSection(snapshot) {
  if (snapshot.language === 'en') {
    return [
      'Choose a section below.',
      snapshot.provider === 'codex' ? 'Defaults edits global Codex settings in `~/.codex/config.toml`.' : null,
      'Compact controls strategy and token limit for automatic context compaction.',
      'Reply controls whether the bot only updates the progress card or also sends process messages.',
      !botProvider ? 'Provider switches this channel to a different CLI lane and restores that provider’s saved channel settings.' : null,
    ].filter(Boolean).join('\n');
  }
  return [
    '请选择下方的设置项。',
    snapshot.provider === 'codex' ? '默认分区会直接修改 `~/.codex/config.toml` 里的全局 Codex 默认值。' : null,
    '压缩分区管理 compact 策略和 token 阈值。',
    '回复分区管理只更新进度卡还是发送过程消息，以及完成时是否触发 @。',
    !botProvider ? '切换 provider 会切到另一条 CLI 运行时，并恢复这个频道里该 provider 自己保存的设置。' : null,
  ].filter(Boolean).join('\n');
}

  function formatActiveSection(activeSection, snapshot) {
    const compactSurface = `${slashRef('compact')} key:<...> value:<...>`;
    switch (activeSection) {
      case 'defaults':
        return snapshot.language === 'en'
          ? 'This section edits global Codex defaults in `~/.codex/config.toml`. Model, effort, and fast are selected here. Custom model and profile names still use the buttons below. Provider default clears the matching global override. Channel and thread overrides still win.'
          : '这个分区会直接修改 `~/.codex/config.toml` 里的全局 Codex 默认值。model、effort 和 fast 直接在这里改。自定义 model 和 profile 仍可用下方按钮手写。provider 默认会清除对应的全局覆盖。频道或 thread 的显式覆盖仍然优先。';
      case 'provider':
        return snapshot.language === 'en'
          ? 'Provider switches the active runtime for this channel. Each provider keeps its own saved session/model/runtime overrides.'
          : 'provider 决定这个频道当前使用哪套 CLI 运行时。每个 provider 会保留自己独立的 session、model 和运行时覆盖。';
      case 'profile':
        return snapshot.language === 'en'
          ? 'Codex profile decides which named profile this channel passes to Codex. Follow keeps inheritance. Provider default means no `--profile` flag is passed.'
          : 'Codex profile 决定当前频道向 Codex 传哪个命名 profile。跟随表示继续继承。provider 默认表示不传 `--profile`。';
      case 'model':
        return snapshot.language === 'en'
          ? 'Choose a model from the CLI catalog, type a custom model, or tune effort here. Provider default clears this channel override.'
          : '可以从 CLI 读取到的模型里选择，也可以手写模型名。推理力度也放在这里一起调，使用 provider 默认会清掉当前频道覆盖。';
      case 'fast':
        if (snapshot.provider === 'omp') {
          return snapshot.language === 'en'
            ? (snapshot.isThread
              ? 'On uses OMP priority service tier; Off uses the normal tier. "Follow parent/OMP default" inherits the parent first and otherwise leaves OMP\'s tier setting unchanged.'
              : 'On uses OMP priority service tier; Off uses the normal tier. "Follow OMP default" removes the channel override and leaves OMP\'s tier setting unchanged.')
            : (snapshot.isThread
              ? '开启会使用 OMP 的 priority service tier，关闭会使用普通等级。跟随父频道/OMP 默认会优先继承父频道，否则不覆盖 OMP 自己的等级设置。'
              : '开启会使用 OMP 的 priority service tier，关闭会使用普通等级。跟随 OMP 默认会清除当前频道覆盖，不改动 OMP 自己的等级设置。');
        }
        return snapshot.language === 'en'
          ? (snapshot.isThread
            ? 'Fast mode only exists on Codex. "Follow parent/global" means this thread stops overriding and inherits the parent channel setting first, then `~/.codex/config.toml` (which stays on unless `[features].fast_mode = false` is set).'
            : 'Fast mode only exists on Codex. "Follow global" means this channel stops overriding and inherits `~/.codex/config.toml` (which stays on unless `[features].fast_mode = false` is set).')
          : (snapshot.isThread
            ? 'Fast mode 仅对 Codex 生效。选择“跟随父频道/全局”表示当前 thread 不再覆盖，优先继承父频道设置，其次继承 `~/.codex/config.toml`；若未显式写 `[features].fast_mode = false`，默认保持开启。'
            : 'Fast mode 仅对 Codex 生效。选择“跟随全局”表示当前频道不再覆盖，改为继承 `~/.codex/config.toml`；若未显式写 `[features].fast_mode = false`，默认保持开启。');
      case 'runtime':
        return snapshot.language === 'en'
          ? 'Runtime chooses exec or long connection. Busy prompt decides what happens when a new message arrives during an active turn. Exec can only queue; steer stays disabled until the provider runner exposes a real active-turn steering path.'
          : '运行时选择 exec 或 long。运行中消息决定任务还在跑时新消息怎么处理。exec 只能排队；steer 只有真正接好运行中插入能力后才会启用。';
      case 'effort':
        return snapshot.language === 'en'
          ? 'Reasoning effort options are provider-specific. "default" clears this channel override.'
          : 'reasoning effort 的可选值由 provider 决定。选择 `default` 会清掉当前频道覆盖。';
      case 'compact':
        return snapshot.language === 'en'
          ? `Native uses Claude Code's own auto-compaction window or a channel override. Hard uses the separate bot-managed threshold. The same controls are available through \`${compactSurface}\`.`
          : `native 使用 Claude Code 自己的 auto 压缩窗口，也可以单独覆盖。hard 使用另一套由 bot 管理的阈值。相同设置也可以通过 \`${compactSurface}\` 调整。`;
      case 'reply':
        return snapshot.language === 'en'
          ? 'Choose whether the channel only updates the progress card or also sends process messages, and whether completion should trigger @.'
          : '在这里决定当前频道只更新进度卡，还是会发送过程消息，以及完成时是否触发 @。';
      case 'language':
        return snapshot.language === 'en'
          ? 'This only changes the bot hint language for the current channel.'
          : '这里只会切换当前频道的 bot 提示语言。';
      case 'mode':
        return snapshot.language === 'en'
          ? 'Threads follow the parent channel unless overridden. Default clears the override. `dangerous` removes sandbox/approval safeguards.'
          : '线程默认跟随父频道；单独选择模式后不再跟随，恢复默认会清除覆盖。`dangerous` 会去掉 sandbox 与审批保护。';
      case 'workspace':
        return snapshot.language === 'en'
          ? 'Browsing opens the existing workspace picker in a separate ephemeral panel. "Follow provider default" clears the thread override only.'
          : '“浏览 workspace” 会在单独的 ephemeral 面板里打开现有路径选择器。“跟随 provider 默认”只会清掉当前 thread 的 workspace 覆盖。';
      default:
        return formatOverviewSection(snapshot);
    }
  }

  function formatSettingsContent(key, session, activeSection, notice = '') {
    const snapshot = buildSnapshot(key, session);
    const isDefaultsSection = activeSection === 'defaults' && snapshot.provider === 'codex';
    const lines = [
      isDefaultsSection
        ? (snapshot.language === 'en' ? '⚙️ **Global Codex Defaults**' : '⚙️ **Codex 默认设置**')
        : (snapshot.language === 'en' ? '⚙️ **Channel Settings**' : '⚙️ **频道设置**'),
      notice || null,
      ...(isDefaultsSection
        ? [
          snapshot.language === 'en'
            ? '• scope: `~/.codex/config.toml`'
            : '• 作用域：`~/.codex/config.toml`',
          snapshot.language === 'en'
            ? `• profile default: ${formatCodexProfileLabel(snapshot.codexProfileDefault.profile, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexProfileDefault.source, snapshot.language)})`
            : `• profile 默认：${formatCodexProfileLabel(snapshot.codexProfileDefault.profile, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexProfileDefault.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• model default: ${formatCodexGlobalStringDefault(snapshot.codexDefaults.model, snapshot.codexDefaults.modelConfigured, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexDefaults.modelConfigured ? 'config.toml' : 'provider default', snapshot.language)})`
            : `• model 默认：${formatCodexGlobalStringDefault(snapshot.codexDefaults.model, snapshot.codexDefaults.modelConfigured, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexDefaults.modelConfigured ? 'config.toml' : 'provider default', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• effort default: ${formatCodexGlobalStringDefault(snapshot.codexDefaults.effort, snapshot.codexDefaults.effortConfigured, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexDefaults.effortConfigured ? 'config.toml' : 'provider default', snapshot.language)})`
            : `• effort 默认：${formatCodexGlobalStringDefault(snapshot.codexDefaults.effort, snapshot.codexDefaults.effortConfigured, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexDefaults.effortConfigured ? 'config.toml' : 'provider default', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• fast default: ${formatFastModeLabel(snapshot.codexDefaults.fastMode, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexDefaults.fastModeConfigured ? 'config.toml' : 'built-in default', snapshot.language)})`
            : `• fast 默认：${formatFastModeLabel(snapshot.codexDefaults.fastMode, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexDefaults.fastModeConfigured ? 'config.toml' : 'built-in default', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• effective in this channel: model ${formatValueLabel(snapshot.modelValue, '(provider default)', snapshot.language)}, fast ${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)}, effort ${formatValueLabel(snapshot.effortValue, '(provider default)', snapshot.language)}`
            : `• 当前频道生效值：model ${formatValueLabel(snapshot.modelValue, '（provider 默认）', snapshot.language)}，fast ${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)}，effort ${formatValueLabel(snapshot.effortValue, '（provider 默认）', snapshot.language)}`,
          snapshot.language === 'en'
            ? `• compact context limit: ${formatCompactThresholdValue(snapshot.compactThreshold, snapshot.language)} (${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)})`
            : `• compact context 长度：${formatCompactThresholdValue(snapshot.compactThreshold, snapshot.language)}（${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)}）`,
        ]
        : [
          snapshot.language === 'en'
            ? `• provider: \`${snapshot.provider}\` (${snapshot.providerLabel})`
            : `• provider：\`${snapshot.provider}\`（${snapshot.providerLabel}）`,
          snapshot.provider === 'codex'
            ? (snapshot.language === 'en'
              ? `• codex profile: ${formatCodexProfileLabel(snapshot.codexProfile.value, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexProfile.source, snapshot.language)}${snapshot.codexProfile.valid ? '' : `, invalid: ${snapshot.codexProfile.error}`})`
              : `• Codex profile：${formatCodexProfileLabel(snapshot.codexProfile.value, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexProfile.source, snapshot.language)}${snapshot.codexProfile.valid ? '' : `，无效：${snapshot.codexProfile.error}` }）`)
            : null,
          snapshot.language === 'en'
            ? `• model: ${formatValueLabel(snapshot.modelValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)})`
            : `• model：${formatValueLabel(snapshot.modelValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)}）`,
          snapshot.modelCatalog.error
            ? (snapshot.language === 'en'
              ? `• model catalog: unavailable (${truncateOptionText(snapshot.modelCatalog.error, 120)})`
              : `• 模型列表：暂不可用（${truncateOptionText(snapshot.modelCatalog.error, 120)}）`)
            : null,
          snapshot.fastMode.supported
            ? (snapshot.language === 'en'
              ? `• fast mode: ${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)} (${formatSettingSourceLabel(snapshot.fastMode.source, snapshot.language)})`
              : `• fast mode：${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)}（${formatSettingSourceLabel(snapshot.fastMode.source, snapshot.language)}）`)
            : (snapshot.language === 'en'
              ? '• fast mode: n/a (Codex and OMP only)'
              : '• fast mode：不适用（仅 Codex 和 OMP）'),
          snapshot.runtimeMode.supported
            ? (snapshot.language === 'en'
              ? `• runtime: ${formatRuntimeModeLabel(snapshot.runtimeMode.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.runtimeMode.source, snapshot.language)})`
              : `• 运行时：${formatRuntimeModeLabel(snapshot.runtimeMode.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.runtimeMode.source, snapshot.language)}）`)
            : (snapshot.language === 'en'
              ? '• runtime: exec (long unavailable for this provider)'
              : '• 运行时：exec（当前 provider 暂未接入 long）'),
          snapshot.language === 'en'
            ? `• busy prompt: ${formatBusyPromptModeLabel(snapshot.busyPromptMode.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.busyPromptMode.source, snapshot.language)}${snapshot.busyPromptMode.reason ? `, ${snapshot.busyPromptMode.reason}` : ''})`
            : `• 运行中消息：${formatBusyPromptModeLabel(snapshot.busyPromptMode.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.busyPromptMode.source, snapshot.language)}${snapshot.busyPromptMode.reason ? `，${snapshot.busyPromptMode.reason}` : ''}）`,
          snapshot.effortLevels.length
            ? (snapshot.language === 'en'
              ? `• effort: ${formatValueLabel(snapshot.effortValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)})`
              : `• effort：${formatValueLabel(snapshot.effortValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)}）`)
            : (snapshot.language === 'en'
              ? `• effort: not exposed on ${snapshot.providerLabel}`
              : `• effort：${snapshot.providerLabel} 当前未暴露`),
          snapshot.language === 'en'
            ? `• compact: \`${snapshot.compact.strategy}\` (${formatSettingSourceLabel(snapshot.compact.source, snapshot.language)})`
            : `• compact：\`${snapshot.compact.strategy}\`（${formatSettingSourceLabel(snapshot.compact.source, snapshot.language)}）`,
          getProviderCompactCapabilities(snapshot.provider).supportsNativeLimit
            ? (snapshot.language === 'en'
              ? `• native compact: ${formatNativeCompactLimit(snapshot.nativeCompactLimit, snapshot.language)}`
              : `• native compact：${formatNativeCompactLimit(snapshot.nativeCompactLimit, snapshot.language)}`)
            : null,
          snapshot.language === 'en'
            ? `• hard compact threshold: ${formatCompactThresholdValue(snapshot.compactThreshold, snapshot.language)} (${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)})`
            : `• hard compact 阈值：${formatCompactThresholdValue(snapshot.compactThreshold, snapshot.language)}（${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• reply delivery: ${formatReplyDeliveryModeLabel(snapshot.replyDelivery.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.replyDelivery.source, snapshot.language)})`
            : `• 回复方式：${formatReplyDeliveryModeLabel(snapshot.replyDelivery.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.replyDelivery.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• default reply delivery: ${formatReplyDeliveryModeLabel(snapshot.replyDefault.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.replyDefault.source, snapshot.language)})`
            : `• 默认回复方式：${formatReplyDeliveryModeLabel(snapshot.replyDefault.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.replyDefault.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• mode: \`${session?.mode || 'safe'}\` (${formatSettingSourceLabel(session?.modeSource || 'session override', snapshot.language)})`
            : `• mode：\`${session?.mode || 'safe'}\`（${formatSettingSourceLabel(session?.modeSource || 'session override', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• language: ${snapshot.language === 'en' ? 'English' : '中文'}`
            : `• language：${snapshot.language === 'en' ? 'English' : '中文'}`,
          snapshot.language === 'en'
            ? `• workspace: ${formatWorkspaceLabel(snapshot.workspace, snapshot.language)}`
            : `• workspace：${formatWorkspaceLabel(snapshot.workspace, snapshot.language)}`,
        ]),
      '',
      snapshot.language === 'en'
        ? `**Active: ${formatSectionTitleLabel(activeSection, snapshot.language)}**`
        : `**当前项：${formatSectionTitleLabel(activeSection, snapshot.language)}**`,
      formatActiveSection(activeSection, snapshot),
    ];
    return lines.filter(Boolean).join('\n');
  }

  function buildSettingsPayload({ key, session, userId, flags = undefined, activeSection = '', activeDefaultsGroup = 'model', notice = '' } = {}) {
    const section = resolveActiveSection(session, activeSection || resolveDefaultSection(session));
    const snapshot = buildSnapshot(key, session);
    const issuedGeneration = issueModelPanelGeneration(key, userId);
    const modelPanelGeneration = (section === 'model' || section === 'defaults')
      ? issuedGeneration
      : '';
    const sectionControls = buildSectionControls(key, session, userId, section, snapshot, modelPanelGeneration);
    const closeRow = buildCloseRow(session, userId);
    if (section === 'model') {
      const lastControlRow = sectionControls.at(-1);
      if (lastControlRow && lastControlRow.components.length < 5) {
        lastControlRow.addComponents(...closeRow.components);
      } else {
        sectionControls.push(closeRow);
      }
    } else {
      sectionControls.push(closeRow);
    }
    const components = [
      ...buildSectionNavigation(session, userId, section),
      ...sectionControls,
    ];
    const payload = {
      content: formatSettingsContent(key, session, section, notice),
      components,
    };
    if (flags !== undefined) payload.flags = flags;
    return payload;
  }

  function formatModelSettingsContent(key, session, notice = '') {
    const snapshot = buildSnapshot(key, session);
    const lines = [
      snapshot.language === 'en' ? '**Model**' : '**模型**',
      notice || null,
      snapshot.language === 'en'
        ? `• model: ${formatValueLabel(snapshot.modelValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)})`
        : `• model：${formatValueLabel(snapshot.modelValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)}）`,
      snapshot.modelCatalog.error
        ? (snapshot.language === 'en'
          ? `• model catalog: unavailable (${truncateOptionText(snapshot.modelCatalog.error, 120)})`
          : `• 模型列表：暂不可用（${truncateOptionText(snapshot.modelCatalog.error, 120)}）`)
        : null,
      snapshot.effortLevels.length
        ? (snapshot.language === 'en'
          ? `• effort: ${formatValueLabel(snapshot.effortValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)})`
          : `• effort：${formatValueLabel(snapshot.effortValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)}）`)
        : (snapshot.language === 'en'
          ? `• effort: not exposed on ${snapshot.providerLabel}`
          : `• effort：${snapshot.providerLabel} 当前未暴露`),
      '',
      snapshot.language === 'en'
        ? 'Choose a model from the CLI catalog, type a custom model, or set effort below.'
        : '从 CLI 读取到的模型里选择，也可以手写模型名；推理力度在下面一起调。',
    ];
    return lines.filter(Boolean).join('\n');
  }

  function buildModelSettingsPayload({ key, session, userId, flags = undefined, notice = '', modelQuery = '' } = {}) {
    const snapshot = buildSnapshot(key, session);
    const generation = issueModelPanelGeneration(key, userId);
    const closeLabel = snapshot.language === 'en' ? 'close' : '关闭';
    const components = [
      ...buildModelControlRows(session, userId, snapshot, { quick: true, generation, modelQuery }),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsComponentId('act', 'quick_model', 'close', userId, generation))
          .setLabel(closeLabel)
          .setStyle(ButtonStyle.Danger),
      ),
    ];
    const payload = {
      content: formatModelSettingsContent(key, session, notice),
      components,
    };
    if (flags !== undefined) payload.flags = flags;
    return payload;
  }

  function buildModelSearchModal(session, userId, { target = 'model_search', generation = '' } = {}) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const input = new TextInputBuilder()
      .setCustomId(MODEL_SEARCH_INPUT_ID)
      .setLabel(language === 'en' ? 'Model name, provider, or keyword' : '模型名、provider 或关键词')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(language === 'en' ? 'e.g. ox alpha or openrouter-ox' : '例如 ox alpha 或 openrouter-ox')
      .setRequired(true)
      .setMaxLength(100);

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId(target, userId, generation))
      .setTitle(language === 'en' ? 'Search model catalog' : '搜索模型目录')
      .addComponents(new ActionRowBuilder().addComponents(input));
  }

  function buildModelModal(session, userId, { useGlobalDefault = false, target = '', generation = '' } = {}) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const defaults = useGlobalDefault ? (getProviderDefaults('codex') || {}) : null;
    const input = new TextInputBuilder()
      .setCustomId(MODEL_INPUT_ID)
      .setLabel(useGlobalDefault
        ? (language === 'en' ? 'Global model name or default' : '全局模型名或 default')
        : (language === 'en' ? 'Model name or default' : '模型名或 default'))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(useGlobalDefault
        ? formatModelPlaceholder('codex', language)
        : formatModelPlaceholder(getSessionProvider(session), language))
      .setRequired(true)
      .setMaxLength(120);
    if (useGlobalDefault) {
      if (hasConfiguredCodexDefault(defaults?.model, defaults?.modelConfigured)) {
        input.setValue(defaults.model);
      }
    } else if (session?.model) {
      input.setValue(session.model);
    }

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId(target || (useGlobalDefault ? 'default_model' : 'model'), userId, generation))
      .setTitle(useGlobalDefault
        ? (language === 'en' ? 'Set global default model' : '设置全局默认 model')
        : (language === 'en' ? 'Set custom model' : '设置自定义模型'))
      .addComponents(
        new ActionRowBuilder().addComponents(input),
      );
  }

  function buildCodexProfileModal(session, userId, { useGlobalDefault = false } = {}) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const defaults = useGlobalDefault ? getDefaultCodexProfile(session) : null;
    const input = new TextInputBuilder()
      .setCustomId(CODEX_PROFILE_INPUT_ID)
      .setLabel(useGlobalDefault
        ? (language === 'en' ? 'Global Codex profile or default' : '全局 Codex profile 或 default')
        : (language === 'en' ? 'Codex profile or default' : 'Codex profile 或 default'))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(useGlobalDefault
        ? (language === 'en' ? 'e.g. work, review, default' : '例如 work、review、default')
        : (language === 'en' ? 'e.g. work, review, default' : '例如 work、review、default'))
      .setRequired(true)
      .setMaxLength(120);
    if (useGlobalDefault) {
      if (defaults?.profile) input.setValue(defaults.profile);
    } else if (session?.codexProfile) {
      input.setValue(session.codexProfile);
    }

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId(useGlobalDefault ? 'default_profile' : 'profile', userId))
      .setTitle(useGlobalDefault
        ? (language === 'en' ? 'Set global Codex profile' : '设置全局 Codex profile')
        : (language === 'en' ? 'Set Codex profile' : '设置 Codex profile'))
      .addComponents(
        new ActionRowBuilder().addComponents(input),
      );
  }

  function buildCompactThresholdModal(session, userId, { native = false } = {}) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const input = new TextInputBuilder()
      .setCustomId(COMPACT_THRESHOLD_INPUT_ID)
      .setLabel(language === 'en' ? 'Compact token limit or default' : 'Compact token 阈值或 default')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(language === 'en' ? 'e.g. 272000 or default' : '例如 272000 或 default')
      .setRequired(true)
      .setMaxLength(20);
    const currentValue = native ? session?.nativeCompactTokenLimit : session?.compactThresholdTokens;
    if (currentValue !== null && currentValue !== undefined) {
      input.setValue(String(currentValue));
    }

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId(native ? 'native_compact_limit' : 'compact_threshold', userId))
      .setTitle(language === 'en'
        ? (native ? 'Set native compact limit' : 'Set hard compact threshold')
        : (native ? '设置 native compact 阈值' : '设置 hard compact 阈值'))
      .addComponents(
        new ActionRowBuilder().addComponents(input),
      );
  }

  async function handleSettingsPanelInteraction(interaction) {
    const parsed = parseSettingsComponentId(interaction.customId);
    if (!parsed) return false;

    const key = String(interaction.channelId || '').trim();
    const session = key ? getSession(key, { channel: interaction.channel || null }) : null;
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);

    if (!key || !session) {
      await interaction.reply({
        content: language === 'en' ? '❌ Unable to load channel settings.' : '❌ 无法读取当前频道设置。',
        flags: 64,
      });
      return true;
    }

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: language === 'en' ? '⛔ This settings panel belongs to another user.' : '⛔ 这个设置面板属于其他用户。',
        flags: 64,
      });
      return true;
    }

    if (isModelPanelTarget(parsed.target) && !isCurrentModelPanelGeneration(key, parsed.userId, parsed.generation)) {
      const isGlobalDefault = parsed.target === 'default_model' || parsed.target === 'default_effort';
      await interaction.reply({
        content: language === 'en'
          ? `❌ This ${isGlobalDefault ? 'settings' : 'model'} panel has expired. Open /${isGlobalDefault ? 'settings' : 'model'} again.`
          : `❌ 这个${isGlobalDefault ? '设置' : '模型'}面板已过期，请重新打开 /${isGlobalDefault ? 'settings' : 'model'}。`,
        flags: 64,
      });
      return true;
    }

    if (parsed.kind === 'nav') {
      const nextSection = parsed.target === 'section'
        ? normalizeSection(interaction.values?.[0] || '')
        : (parsed.target === 'defaults_group' ? 'defaults' : parsed.target);
      await interaction.update(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: nextSection,
      }));
      return true;
    }

    if (parsed.kind === 'act') {
      if (parsed.target === 'panel' && parsed.value === 'close') {
        issueModelPanelGeneration(key, interaction.user.id);
        await interaction.update({
          content: language === 'en' ? '⚙️ Settings panel closed.' : '⚙️ 设置面板已关闭。',
          components: [],
        });
        return true;
      }

      if (parsed.target === 'quick_model' && parsed.value === 'close') {
        issueModelPanelGeneration(key, interaction.user.id);
        await interaction.update({
          content: language === 'en' ? 'Model panel closed.' : '模型面板已关闭。',
          components: [],
        });
        return true;
      }

      if ((parsed.target === 'model' || parsed.target === 'quick_model') && parsed.value === 'search') {
        await interaction.showModal(buildModelSearchModal(session, interaction.user.id, {
          target: `${parsed.target}_search`,
          generation: parsed.generation,
        }));
        return true;
      }

      if (parsed.target === 'model' && parsed.value === 'custom') {
        await interaction.showModal(buildModelModal(session, interaction.user.id, { generation: parsed.generation }));
        return true;
      }

      if (parsed.target === 'quick_model' && parsed.value === 'custom') {
        await interaction.showModal(buildModelModal(session, interaction.user.id, {
          target: 'quick_model',
          generation: parsed.generation,
        }));
        return true;
      }

      if (parsed.target === 'profile' && parsed.value === 'custom') {
        await interaction.showModal(buildCodexProfileModal(session, interaction.user.id));
        return true;
      }

      if (parsed.target === 'default_model' && parsed.value === 'custom') {
        await interaction.showModal(buildModelModal(session, interaction.user.id, {
          useGlobalDefault: true,
          generation: parsed.generation,
        }));
        return true;
      }

      if (parsed.target === 'default_profile' && parsed.value === 'custom') {
        await interaction.showModal(buildCodexProfileModal(session, interaction.user.id, { useGlobalDefault: true }));
        return true;
      }

      if (parsed.target === 'compact_threshold' && parsed.value === 'custom') {
        await interaction.showModal(buildCompactThresholdModal(session, interaction.user.id));
        return true;
      }

      if (parsed.target === 'native_compact_limit' && parsed.value === 'custom') {
        await interaction.showModal(buildCompactThresholdModal(session, interaction.user.id, { native: true }));
        return true;
      }

      if (parsed.target === 'model' && parsed.value === 'default') {
        const conflict = findModelEffortConflict(key, session, 'default');
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
            flags: 64,
          });
          return true;
        }
        commandActions.setModel?.(session, 'default');
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'model',
          notice: language === 'en' ? '✅ Model now follows the provider default.' : '✅ 当前 model 已改为跟随 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'quick_model' && parsed.value === 'default') {
        const conflict = findModelEffortConflict(key, session, 'default');
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
            flags: 64,
          });
          return true;
        }
        commandActions.setModel?.(session, 'default');
        closeRuntimeForKey(key);
        await interaction.update(buildModelSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          notice: language === 'en' ? 'Model now follows the provider default.' : '当前 model 已改为跟随 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'default_model' && parsed.value === 'default') {
        const conflict = findGlobalModelEffortConflict(key, session, 'default');
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
            flags: 64,
          });
          return true;
        }
        commandActions.setGlobalModelDefault?.(session, 'default');
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'defaults',
          activeDefaultsGroup: 'model',
          notice: language === 'en'
            ? '✅ Global default model cleared. Codex now follows the provider default.'
            : '✅ 已清除全局默认 model。Codex 现已回退到 provider 默认模型。',
        }));
        return true;
      }

      if (parsed.target === 'profile' && parsed.value === 'clear') {
        commandActions.setCodexProfile?.(session, 'default');
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'profile',
          notice: language === 'en' ? '✅ Codex profile now follows the provider default.' : '✅ 当前 Codex profile 已改为跟随 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'default_profile' && parsed.value === 'default') {
        commandActions.setGlobalCodexProfileDefault?.(session, 'default');
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'defaults',
          activeDefaultsGroup: 'profile',
          notice: language === 'en'
            ? '✅ Global default Codex profile cleared. Codex now follows the provider default.'
            : '✅ 已清除全局默认 Codex profile。Codex 现已回退到 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'compact_threshold' && parsed.value === 'default') {
        commandActions.applyCompactConfig?.(session, { type: 'set_threshold', tokens: null });
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'compact',
          notice: language === 'en' ? '✅ Compact token limit now follows the default.' : '✅ compact 阈值已改为跟随默认。',
        }));
        return true;
      }

      if (parsed.target === 'native_compact_limit' && parsed.value === 'default') {
        commandActions.applyCompactConfig?.(session, { type: 'set_native_limit', tokens: null });
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'compact',
          notice: language === 'en' ? '✅ Native compact now uses auto.' : '✅ native compact 已改为 auto。',
        }));
        return true;
      }

      if (parsed.target === 'workspace' && parsed.value === 'browse') {
        if (typeof openWorkspaceBrowser !== 'function') {
          await interaction.reply({
            content: language === 'en' ? '❌ Workspace browser is unavailable here.' : '❌ 当前环境没有可用的 workspace 浏览器。',
            flags: 64,
          });
          return true;
        }
        await interaction.reply(openWorkspaceBrowser({
          key,
          session,
          userId: interaction.user.id,
          mode: 'thread',
          flags: 64,
        }));
        return true;
      }

      if (parsed.target === 'workspace' && parsed.value === 'clear') {
        const result = commandActions.clearWorkspaceDir?.(session, key);
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'workspace',
          notice: result
            ? (language === 'en' ? '✅ This channel now follows the provider default workspace.' : '✅ 当前频道已改为跟随 provider 默认 workspace。')
            : '',
        }));
        return true;
      }
    }

    if (parsed.kind === 'set') {
      const replyDeliveryModeBefore = ['reply', 'default_reply'].includes(parsed.target)
        ? resolveReplyDeliverySetting(session).mode
        : null;
      if ((parsed.target === 'model' || parsed.target === 'quick_model') && parsed.value === 'preset') {
        const selectedModel = String(interaction.values?.[0] || '').trim();
        if (!selectedModel) {
          await interaction.reply({
            content: language === 'en' ? '❌ No model selected.' : '❌ 没有选择模型。',
            flags: 64,
          });
          return true;
        }
        const conflict = findModelEffortConflict(key, session, selectedModel);
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
            flags: 64,
          });
          return true;
        }
        commandActions.setModel?.(session, selectedModel);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'default_model' && parsed.value === 'preset') {
        const selectedModel = String(interaction.values?.[0] || '').trim();
        if (!selectedModel) {
          await interaction.reply({
            content: language === 'en' ? '❌ No model selected.' : '❌ 没有选择模型。',
            flags: 64,
          });
          return true;
        }
        const conflict = findGlobalModelEffortConflict(key, session, selectedModel);
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
            flags: 64,
          });
          return true;
        }
        commandActions.setGlobalModelDefault?.(session, selectedModel);
      } else if (parsed.target === 'provider' && !botProvider) {
        commandActions.setProvider?.(session, parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'profile') {
        commandActions.setCodexProfile?.(session, parsed.value === 'follow' ? null : parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'language') {
        commandActions.setLanguage?.(session, parsed.value);
      } else if (parsed.target === 'mode') {
        commandActions.setMode?.(session, parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'default_fast') {
        const next = parsed.value === 'default' ? null : parsed.value === 'on';
        commandActions.setGlobalFastModeDefault?.(session, next);
      } else if (parsed.target === 'fast') {
        const next = parsed.value === 'follow' ? null : parsed.value === 'on';
        commandActions.setFastMode?.(session, next);
      } else if (parsed.target === 'runtime') {
        const next = parsed.value === 'follow' ? null : parsed.value;
        commandActions.setRuntimeMode?.(session, next);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'busy_prompt') {
        const next = parsed.value === 'follow' ? null : parsed.value;
        commandActions.setBusyPromptMode?.(session, next);
      } else if (parsed.target === 'default_effort' && parsed.value === 'preset') {
        const selectedEffort = String(interaction.values?.[0] || '').trim().toLowerCase();
        if (!selectedEffort) {
          await interaction.reply({
            content: language === 'en' ? '❌ No effort selected.' : '❌ 没有选择 effort。',
            flags: 64,
          });
          return true;
        }
        const conflict = findGlobalEffortConflict(key, session, selectedEffort);
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language),
            flags: 64,
          });
          return true;
        }
        commandActions.setGlobalReasoningEffortDefault?.(session, selectedEffort);
      } else if (parsed.target === 'effort' || parsed.target === 'model_effort' || parsed.target === 'quick_model_effort') {
        const conflict = findEffortConflict(key, session, parsed.value);
        if (conflict) {
          await interaction.reply({
            content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language),
            flags: 64,
          });
          return true;
        }
        commandActions.setReasoningEffort?.(session, parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'compact') {
        commandActions.setCompactStrategy?.(session, parsed.value === 'follow' ? null : parsed.value);
      } else if (parsed.target === 'reply') {
        commandActions.setReplyDeliveryMode?.(session, parsed.value === 'follow' ? null : parsed.value);
      } else if (parsed.target === 'default_reply') {
        commandActions.setGlobalReplyDeliveryModeDefault?.(session, parsed.value);
      } else if (parsed.target === 'default_profile') {
        commandActions.setGlobalCodexProfileDefault?.(session, parsed.value);
      }

      if (parsed.target === 'reply' || parsed.target === 'default_reply') {
        await flushActiveRunProcessMessages(interaction, key, session, {
          beforeMode: replyDeliveryModeBefore,
        });
      }

      if (parsed.target === 'quick_model' || parsed.target === 'quick_model_effort') {
        await interaction.update(buildModelSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
        }));
        return true;
      }

      await interaction.update(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: parsed.target === 'default_reply'
          ? 'reply'
          : (parsed.target === 'busy_prompt')
            ? 'runtime'
          : (parsed.target === 'model' && parsed.value === 'preset')
            ? 'model'
            : (parsed.target === 'model_effort')
              ? 'model'
              : (parsed.target.startsWith('default_') ? 'defaults' : parsed.target),
        activeDefaultsGroup: parsed.target === 'default_effort'
          ? 'effort'
          : (parsed.target === 'default_fast'
            ? 'fast'
            : (parsed.target === 'default_profile'
              ? 'profile'
              : 'model')),
      }));
      return true;
    }

    await interaction.reply({
      content: language === 'en' ? '❌ Unsupported settings action.' : '❌ 不支持这个设置操作。',
      flags: 64,
    });
    return true;
  }

  async function handleSettingsPanelModalSubmit(interaction) {
    const parsed = parseSettingsModalId(interaction.customId);
    if (!parsed) return false;

    const key = String(interaction.channelId || '').trim();
    const session = key ? getSession(key, { channel: interaction.channel || null }) : null;
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);

    if (!key || !session) {
      await interaction.reply({
        content: language === 'en' ? '❌ Unable to load channel settings.' : '❌ 无法读取当前频道设置。',
        flags: 64,
      });
      return true;
    }

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: language === 'en' ? '⛔ This settings panel belongs to another user.' : '⛔ 这个设置面板属于其他用户。',
        flags: 64,
      });
      return true;
    }

    if (isModelPanelTarget(parsed.target) && !isCurrentModelPanelGeneration(key, parsed.userId, parsed.generation)) {
      const isGlobalDefault = parsed.target === 'default_model' || parsed.target === 'default_effort';
      await interaction.reply({
        content: language === 'en'
          ? `❌ This ${isGlobalDefault ? 'settings' : 'model'} panel has expired. Open /${isGlobalDefault ? 'settings' : 'model'} again.`
          : `❌ 这个${isGlobalDefault ? '设置' : '模型'}面板已过期，请重新打开 /${isGlobalDefault ? 'settings' : 'model'}。`,
        flags: 64,
      });
      return true;
    }

    if (parsed.target === 'model_search' || parsed.target === 'quick_model_search') {
      const query = String(interaction.fields.getTextInputValue(MODEL_SEARCH_INPUT_ID) || '').trim();
      const snapshot = buildSnapshot(key, session);
      const matches = searchModelCatalog(snapshot.modelCatalog.models, query)
        .filter((model) => model.visibility !== 'hide' && model.visibility !== 'hidden');
      const notice = matches.length
        ? (language === 'en'
          ? `Found ${matches.length} model${matches.length === 1 ? '' : 's'} for \`${query}\`.`
          : `找到 ${matches.length} 个与 \`${query}\` 匹配的模型。`)
        : (language === 'en'
          ? `No catalog models matched \`${query}\`. You can search again or type an exact model name.`
          : `没有找到与 \`${query}\` 匹配的目录模型，可以重新搜索或手写完整模型名。`);
      await interaction.reply(buildModelSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        flags: 64,
        notice,
        modelQuery: query,
      }));
      return true;
    }

    if (parsed.target === 'model') {
      const rawValue = String(interaction.fields.getTextInputValue(MODEL_INPUT_ID) || '').trim();
      const conflict = findModelEffortConflict(key, session, rawValue);
      if (conflict) {
        await interaction.reply({
          content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
          flags: 64,
        });
        return true;
      }
      commandActions.setModel?.(session, rawValue);
      closeRuntimeForKey(key);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'model',
        flags: 64,
        notice: language === 'en' ? '✅ Model updated. This is the latest settings panel.' : '✅ model 已更新。这是最新的设置面板。',
      }));
      return true;
    }

    if (parsed.target === 'quick_model') {
      const rawValue = String(interaction.fields.getTextInputValue(MODEL_INPUT_ID) || '').trim();
      const conflict = findModelEffortConflict(key, session, rawValue);
      if (conflict) {
        await interaction.reply({
          content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
          flags: 64,
        });
        return true;
      }
      commandActions.setModel?.(session, rawValue);
      closeRuntimeForKey(key);
      await interaction.reply(buildModelSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        flags: 64,
        notice: language === 'en' ? 'Model updated.' : 'model 已更新。',
      }));
      return true;
    }

    if (parsed.target === 'default_model') {
      const rawValue = String(interaction.fields.getTextInputValue(MODEL_INPUT_ID) || '').trim();
      const conflict = findGlobalModelEffortConflict(key, session, rawValue);
      if (conflict) {
        await interaction.reply({
          content: formatUnsupportedModelEffort(conflict.model, conflict.effort, language, { current: true }),
          flags: 64,
        });
        return true;
      }
      commandActions.setGlobalModelDefault?.(session, rawValue);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'defaults',
        activeDefaultsGroup: 'model',
        flags: 64,
        notice: language === 'en'
          ? '✅ Global default model updated in `~/.codex/config.toml`.'
          : '✅ 已更新 `~/.codex/config.toml` 里的全局默认 model。',
      }));
      return true;
    }

    if (parsed.target === 'profile') {
      const rawValue = String(interaction.fields.getTextInputValue(CODEX_PROFILE_INPUT_ID) || '').trim();
      commandActions.setCodexProfile?.(session, rawValue);
      closeRuntimeForKey(key);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'profile',
        flags: 64,
        notice: language === 'en' ? '✅ Codex profile updated. This is the latest settings panel.' : '✅ Codex profile 已更新。这是最新的设置面板。',
      }));
      return true;
    }

    if (parsed.target === 'default_profile') {
      const rawValue = String(interaction.fields.getTextInputValue(CODEX_PROFILE_INPUT_ID) || '').trim();
      commandActions.setGlobalCodexProfileDefault?.(session, rawValue);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'defaults',
        activeDefaultsGroup: 'profile',
        flags: 64,
        notice: language === 'en'
          ? '✅ Global default Codex profile updated.'
          : '✅ 已更新全局默认 Codex profile。',
      }));
      return true;
    }

    if (parsed.target === 'compact_threshold' || parsed.target === 'native_compact_limit') {
      const rawValue = String(interaction.fields.getTextInputValue(COMPACT_THRESHOLD_INPUT_ID) || '').trim();
      const isNative = parsed.target === 'native_compact_limit';
      const parsedCompact = parseCompactConfigAction(isNative ? 'native_limit' : 'token_limit', rawValue);
      const expectedType = isNative ? 'set_native_limit' : 'set_threshold';
      if (parsedCompact?.type !== expectedType) {
        await interaction.reply({
          content: language === 'en' ? '❌ Invalid compact token limit. Use a positive integer or `default`.' : '❌ compact 阈值无效。请输入正整数或 `default`。',
          flags: 64,
        });
        return true;
      }
      commandActions.applyCompactConfig?.(session, parsedCompact);
      closeRuntimeForKey(key);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'compact',
        flags: 64,
        notice: language === 'en'
          ? `✅ ${isNative ? 'Native compact limit' : 'Hard compact threshold'} updated. This is the latest settings panel.`
          : `✅ ${isNative ? 'native compact 阈值' : 'hard compact 阈值'}已更新。这是最新的设置面板。`,
      }));
      return true;
    }

    await interaction.reply({
      content: language === 'en' ? '❌ Unsupported settings modal.' : '❌ 不支持这个设置弹窗。',
      flags: 64,
    });
    return true;
  }

  return {
    openSettingsPanel: (options = {}) => buildSettingsPayload(options),
    openModelSettingsPanel: (options = {}) => buildModelSettingsPayload(options),
    handleSettingsPanelInteraction,
    handleSettingsPanelModalSubmit,
    isSettingsPanelComponentId,
    isSettingsPanelModalId,
  };
}
