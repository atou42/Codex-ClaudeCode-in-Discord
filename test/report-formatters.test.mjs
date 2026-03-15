import test from 'node:test';
import assert from 'node:assert/strict';

import { createReportFormatters } from '../src/report-formatters.js';

function createFormatters(overrides = {}) {
  const base = {
    botProvider: null,
    allowedChannelIds: new Set(['channel-1', 'channel-2']),
    allowedUserIds: new Set(['user-1']),
    progressProcessLines: 3,
    progressPlanMaxLines: 3,
    progressDoneStepsMax: 3,
    slashRef: (name) => `/bot-${name}`,
    getSessionLanguage: (session) => session?.language || 'zh',
    normalizeUiLanguage: (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
    getSessionProvider: (session) => session?.provider || 'codex',
    getProviderDisplayName: (provider) => {
      if (provider === 'gemini') return 'Gemini CLI';
      if (provider === 'claude') return 'Claude Code';
      return 'Codex CLI';
    },
    getProviderShortName: (provider) => {
      if (provider === 'gemini') return 'Gemini';
      if (provider === 'claude') return 'Claude';
      return 'Codex';
    },
    getProviderCompactCapabilities: (provider) => ({
      strategies: ['hard', 'native', 'off'],
      supportsNativeStrategy: true,
      supportsNativeLimit: provider === 'codex',
    }),
    providerSupportsRawConfigOverrides: (provider) => provider === 'codex',
    formatProviderSessionTerm: (provider) => {
      if (provider === 'claude') return 'project session';
      if (provider === 'gemini') return 'chat session';
      return 'rollout session';
    },
    formatProviderRuntimeSummary: (provider) => `runtime:${provider}`,
    formatProviderSessionStoreSurface: (provider) => `store:${provider}`,
    formatProviderResumeSurface: (provider) => `resume:${provider}`,
    formatProviderNativeCompactSurface: (provider) => `compact:${provider}`,
    formatProviderRawConfigSurface: (provider) => `config:${provider}`,
    formatProviderReasoningSurface: (provider) => `reasoning:${provider}`,
    getSupportedReasoningEffortLevels: (provider) => {
      if (provider === 'gemini') return [];
      if (provider === 'claude') return ['low', 'medium', 'high'];
      return ['low', 'medium', 'high', 'xhigh'];
    },
    getProviderDefaults: () => ({ model: 'gpt-5-codex', effort: 'high', source: 'config.toml' }),
    getCliHealth: (provider) => ({ ok: true, version: '1.2.3', bin: `/usr/local/bin/${provider}` }),
    getRuntimeSnapshot: () => ({
      running: false,
      queued: 2,
      progressPlan: null,
      completedSteps: [],
      recentActivities: [],
      progressText: 'building',
      progressAgoMs: 1_234,
      messageId: 'msg-1',
      progressMessageId: 'progress-1',
      progressEvents: 4,
      activeSinceMs: 3_000,
      pid: 1234,
      phase: 'exec',
    }),
    resolveSecurityContext: () => ({ mentionOnly: false, maxQueuePerChannel: 20, profile: 'team' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 60_000, source: 'session override' }),
    getEffectiveSecurityProfile: () => ({ profile: 'public', source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native', source: 'session override' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 272_000, source: 'session override' }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 320_000, source: 'session threshold fallback' }),
    getWorkspaceBinding: (session, key) => ({
      workspaceDir: session?.workspaceDir || `/repo/${key}`,
      source: session?.workspaceDir ? 'thread override' : 'provider default',
      defaultWorkspaceDir: '/repo/default',
      defaultSource: 'provider-scoped env',
      defaultEnvKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
    readWorkspaceLock: () => ({ owner: { key: 'thread-9' } }),
    formatCliHealth: (health) => `ok ${health.version}`,
    formatPermissionsLabel: (_session, language) => (language === 'en' ? 'sandboxed' : '沙盒模式'),
    formatLanguageLabel: (language) => (language === 'en' ? 'en (English)' : 'zh (中文)'),
    formatSecurityProfileDisplay: (security) => `${security.profile || 'team'} profile`,
    formatSecurityProfileLabel: (profile) => String(profile || 'team'),
    formatQueueLimit: (limit) => String(limit),
    formatRuntimeLabel: (runtime, language = 'en') => {
      if (!runtime.running) return language === 'en' ? 'idle' : '空闲';
      return language === 'en' ? 'running' : '运行中';
    },
    formatTimeoutLabel: (timeoutMs) => `${timeoutMs}ms`,
    describeCompactStrategy: (strategy, language = 'en') => (
      language === 'en' ? `strategy:${strategy}` : `策略:${strategy}`
    ),
    formatWorkspaceSessionPolicy: (provider, language = 'en') => (
      language === 'en'
        ? `${provider} sessions are treated as workspace-scoped`
        : `${provider} session 按 workspace 绑定处理`
    ),
    formatWorkspaceSessionResetReason: (provider, language = 'en') => (
      language === 'en'
        ? `reset because ${provider} sessions are treated as workspace-scoped`
        : `已重置（${provider} session 按 workspace 绑定处理）`
    ),
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
    formatTokenValue: (value) => (value === null || value === undefined ? '-' : String(value)),
    formatConfigCommandStatus: () => 'enabled',
    describeConfigPolicy: () => 'personality,model_reasoning_effort',
    formatSessionStatusLabel: (session) => (session?.name ? `**${session.name}** (\`sess-1\`)` : '`sess-1`'),
    formatProgressPlanSummary: () => '1/3 completed',
    formatCompletedStepsSummary: () => 'bootstrap',
    renderProcessContentLines: () => ['• process content:', '  · compiling'],
    localizeProgressLines: (lines, language = 'en') => (
      language === 'en' ? lines : lines.map((line) => line.replace(/^• plan:/, '• 计划：'))
    ),
    renderProgressPlanLines: () => ['• plan: 1/3 completed'],
    renderCompletedStepsLines: () => ['• completed steps: bootstrap'],
  };

  return createReportFormatters({ ...base, ...overrides });
}

test('createReportFormatters.formatStatusReport uses provider defaults for model and effort', () => {
  const formatters = createFormatters();
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    lastInputTokens: 321,
    name: 'alpha',
  };

  const report = formatters.formatStatusReport('thread-1', session, { id: 'channel-1' });

  assert.match(report, /model: gpt-5-codex _\(config\.toml\)_/);
  assert.match(report, /effort: high _\(config\.toml\)_/);
  assert.match(report, /workspace: `\/repo\/thread-1` \(provider default\)/);
  assert.match(report, /runtime profile: runtime:codex/);
  assert.match(report, /rollout session: \*\*alpha\*\* \(`sess-1`\)/);
  assert.doesNotMatch(report, /\(unknown\)/);
});

test('createReportFormatters.formatProgressReport returns localized idle hint', () => {
  const formatters = createFormatters({
    resolveSecurityContext: () => ({ mentionOnly: true, maxQueuePerChannel: 5, profile: 'public' }),
  });

  const report = formatters.formatProgressReport('thread-1', { language: 'zh' }, { id: 'channel-1' });

  assert.match(report, /当前没有运行中的任务/);
  assert.match(report, /队列上限: 5/);
  assert.match(report, /`\/bot-progress`/);
});

test('createReportFormatters.formatDoctorReport includes allowlist and workspace lock diagnostics', () => {
  const formatters = createFormatters({ botProvider: 'gemini' });
  const session = { provider: 'gemini', language: 'en', workspaceDir: '/repo/live' };

  const report = formatters.formatDoctorReport('thread-1', session, { id: 'channel-1' });

  assert.match(report, /bot mode: locked to `gemini` \(Gemini CLI\)/);
  assert.match(report, /workspace serialization: busy/);
  assert.match(report, /runtime session store: store:gemini/);
  assert.match(report, /runtime resume surface: resume:gemini/);
  assert.match(report, /runtime native compact: compact:gemini/);
  assert.match(report, /runtime raw config: config:gemini/);
  assert.match(report, /runtime reasoning: reasoning:gemini/);
  assert.match(report, /ALLOWED_CHANNEL_IDS: 2 configured/);
  assert.match(report, /ALLOWED_USER_IDS: 1 configured/);
});

test('createReportFormatters.formatHelpReport documents browse actions and provider switching', () => {
  const sharedFormatters = createFormatters();
  const lockedFormatters = createFormatters({ botProvider: 'codex' });
  const geminiHelp = sharedFormatters.formatHelpReport({ language: 'en', provider: 'gemini' });

  const sharedHelp = sharedFormatters.formatHelpReport({ language: 'en' });
  const lockedHelp = lockedFormatters.formatHelpReport({ language: 'en' });

  assert.match(sharedHelp, /!provider <codex\|claude\|gemini\|status>/);
  assert.match(sharedHelp, /!setdir <path\|browse\|default\|status>/);
  assert.match(sharedHelp, /!setdefaultdir <path\|browse\|clear\|status>/);
  assert.match(sharedHelp, /native runtime store/);
  assert.match(sharedHelp, /!rollout_resume/);
  assert.match(sharedHelp, /!rollout_sessions/);
  assert.match(geminiHelp, /!chat_resume/);
  assert.match(geminiHelp, /!chat_sessions/);
  assert.doesNotMatch(geminiHelp, /!config <key=value>/);
  assert.doesNotMatch(geminiHelp, /!effort </);
  assert.match(geminiHelp, /raw config passthrough/);
  assert.doesNotMatch(lockedHelp, /!provider <codex\|claude\|gemini\|status>/);
});

test('createReportFormatters.workspace reports explain session reset and lock owner', () => {
  const formatters = createFormatters();

  const updateReport = formatters.formatWorkspaceUpdateReport(
    'thread-1',
    { provider: 'gemini', language: 'en', workspaceDir: '/repo/next' },
    { sessionReset: true, clearedOverride: false },
  );
  const busyReport = formatters.formatWorkspaceBusyReport(
    { language: 'zh' },
    '/repo/next',
    { provider: 'gemini', key: 'thread-9', acquiredAt: '2026-03-13T08:00:00.000Z' },
  );

  assert.match(updateReport, /reset because gemini sessions are treated as workspace-scoped/);
  assert.match(busyReport, /workspace 正忙/);
  assert.match(busyReport, /当前持有 provider: `gemini`/);
  assert.match(busyReport, /当前持有频道: `thread-9`/);
});

test('createReportFormatters config helpers and reports remain available from one factory', () => {
  const formatters = createFormatters();

  const compactHelp = formatters.formatCompactStrategyConfigHelp('en');
  const geminiCompactHelp = formatters.formatCompactStrategyConfigHelp('en', 'gemini');
  const compactReport = formatters.formatCompactConfigReport('zh', {}, true);
  const geminiCompactReport = formatters.formatCompactConfigReport('en', { provider: 'gemini', language: 'en' }, false);
  const timeoutHelp = formatters.formatTimeoutConfigHelp('en');
  const languageReport = formatters.formatLanguageConfigReport('en', true);
  const profileReport = formatters.formatProfileConfigReport('zh', 'team', false);
  const effortHelp = formatters.formatReasoningEffortHelp('zh', 'claude');
  const geminiEffortHelp = formatters.formatReasoningEffortHelp('en', 'gemini');

  assert.match(compactHelp, /\/bot-compact key:<\.\.\.> value:<\.\.\.>/);
  assert.match(compactHelp, /native_limit/);
  assert.match(geminiCompactHelp, /!compact <status\|strategy\|token_limit\|enabled\|reset>/);
  assert.match(compactReport, /compact 配置已更新/);
  assert.match(compactReport, /策略:native（频道覆盖）/);
  assert.match(geminiCompactReport, /native compact: provider default behavior/);
  assert.doesNotMatch(geminiCompactReport, /native compact limit:/);
  assert.match(timeoutHelp, /\/bot-timeout <ms\|off\|status>/);
  assert.equal(languageReport, '✅ Message language set to en (English)');
  assert.equal(profileReport, 'ℹ️ 当前安全策略 profile 为 team');
  assert.equal(effortHelp, '用法：`!effort <high|medium|low|default>`');
  assert.match(geminiEffortHelp, /does not expose reasoning effort/);
});
