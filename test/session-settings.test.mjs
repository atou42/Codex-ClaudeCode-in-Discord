import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionSettings,
  describeCompactStrategy,
  formatBusyPromptModeLabel,
  formatCodexProfileLabel,
  formatLanguageLabel,
  formatReplyDeliveryModeLabel,
  normalizeBusyPromptMode,
  normalizeCodexProfile,
  normalizeCompactStrategy,
  normalizeReplyDeliveryMode,
  normalizeSessionFastMode,
  normalizeSessionRuntimeMode,
  normalizeUiLanguage,
  parseCompactConfigAction,
  parseCompactConfigFromText,
  parseExtraInfoConfigFromText,
  parseBusyPromptModeAction,
  parseFastModeAction,
  parseRuntimeModeAction,
  parseReasoningEffortInput,
  parseWorkspaceCommandAction,
} from '../src/session-settings.js';
import {
  getProviderCompactCapabilities as testGetProviderCompactCapabilities,
  getSupportedCompactStrategies as testGetSupportedCompactStrategies,
  normalizeProvider as testNormalizeProvider,
} from '../src/provider-metadata.js';

test('session-settings normalizes ui language labels and fallbacks', () => {
  const settings = createSessionSettings({ defaultUiLanguage: 'en' });

  assert.equal(normalizeUiLanguage('中文'), 'zh');
  assert.equal(normalizeUiLanguage('EN-us'), 'en');
  assert.equal(settings.getSessionLanguage({ language: 'zh-cn' }), 'zh');
  assert.equal(settings.getSessionLanguage({}), 'en');
  assert.equal(formatLanguageLabel('en'), 'en (English)');
  assert.equal(formatLanguageLabel('zh'), 'zh (中文)');
  assert.equal(normalizeCodexProfile(' work '), 'work');
  assert.equal(formatCodexProfileLabel('work', 'en'), '`work`');
  assert.equal(formatCodexProfileLabel(null, 'zh'), '（provider 默认）');
});

test('session-settings resolves timeout security profile and compact values with overrides', () => {
  const settings = createSessionSettings({
    defaultUiLanguage: 'zh',
    securityProfile: 'team',
    codexTimeoutMs: 60_000,
    taskMaxAttempts: 3,
    taskRetryBaseDelayMs: 1000,
    taskRetryMaxDelayMs: 8000,
    compactStrategy: 'native',
    compactOnThreshold: false,
    maxInputTokensBeforeCompact: 250_000,
    modelAutoCompactTokenLimit: 320_000,
  });

  assert.deepEqual(settings.getEffectiveSecurityProfile({ securityProfile: 'public' }), {
    profile: 'public',
    source: 'session override',
  });
  assert.deepEqual(settings.getEffectiveSecurityProfile({}), {
    profile: 'team',
    source: 'env default',
  });
  assert.deepEqual(settings.resolveTimeoutSetting({ timeoutMs: '45000' }), {
    timeoutMs: 45_000,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveTimeoutSetting({}), {
    timeoutMs: 60_000,
    source: 'env default',
  });
  assert.deepEqual(settings.resolveFastModeSetting({ provider: 'codex', fastMode: 'on' }), {
    enabled: true,
    supported: true,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveFastModeSetting({ provider: 'codex' }), {
    enabled: true,
    supported: true,
    source: 'config.toml',
  });
  assert.deepEqual(settings.resolveFastModeSetting({ provider: 'omp', fastMode: 'on' }), {
    enabled: true,
    supported: true,
    serviceTier: 'priority',
    source: 'session override',
  });
  assert.deepEqual(settings.resolveFastModeSetting({ provider: 'omp' }), {
    enabled: false,
    supported: true,
    serviceTier: 'none',
    source: 'provider default',
  });
  assert.deepEqual(settings.resolveTaskRetrySetting({
    taskMaxAttempts: '4',
    taskRetryBaseDelayMs: '1500',
    taskRetryMaxDelayMs: '9000',
  }), {
    maxAttempts: 4,
    baseDelayMs: 1500,
    maxDelayMs: 9000,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveTaskRetrySetting({}), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    source: 'env default',
  });
  assert.deepEqual(settings.resolveCompactStrategySetting({ compactStrategy: 'hard' }), {
    strategy: 'hard',
    source: 'session override',
  });
  assert.deepEqual(settings.resolveCompactEnabledSetting({ compactEnabled: 'on' }), {
    enabled: true,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveCompactThresholdSetting({ compactThresholdTokens: '123456' }), {
    tokens: 123_456,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({ compactThresholdTokens: '200000' }), {
    tokens: 200_000,
    source: 'session threshold fallback',
  });
  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({}), {
    tokens: 320_000,
    source: 'env default',
  });
});

test('session-settings exposes the effective Codex compact limit for each selected model', () => {
  const settings = createSessionSettings({
    modelCompactTokenLimits: { 'gpt-5.6-sol': 400000, 'gpt-5.6-luna': 40000 },
    readCodexDefaults: () => ({ model: 'gpt-5.6-sol', modelConfigured: true, effort: 'high' }),
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveCompactThresholdSetting({
    provider: 'codex',
    model: 'gpt-5.6-luna',
  }), {
    tokens: 40000,
    source: 'model env default',
  });
  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({
    provider: 'codex',
    model: 'gpt-5.6-luna',
  }), {
    tokens: 40000,
    source: 'model env default',
  });
});

test('session-settings keeps Claude native auto-compact separate from the hard threshold', () => {
  const settings = createSessionSettings({
    normalizeProvider: testNormalizeProvider,
    getSupportedCompactStrategies: testGetSupportedCompactStrategies,
    getProviderCompactCapabilities: testGetProviderCompactCapabilities,
    modelAutoCompactTokenLimit: 400_000,
  });

  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({
    provider: 'claude',
    compactThresholdTokens: 192_000,
    nativeCompactTokenLimit: null,
  }), {
    tokens: null,
    source: 'provider default',
  });
  assert.deepEqual(settings.resolveNativeCompactTokenLimitSetting({
    provider: 'claude',
    compactThresholdTokens: 192_000,
    nativeCompactTokenLimit: 320_000,
  }), {
    tokens: 320_000,
    source: 'session override',
  });
});

test('session-settings isolates compact threshold defaults by provider without losing explicit overrides', () => {
  const settings = createSessionSettings({
    maxInputTokensBeforeCompact: 272_000,
    compactThresholdDefaults: {
      codex: { tokens: 272_000, source: 'provider env' },
      claude: { tokens: null, source: 'provider default' },
      cursor: { tokens: null, source: 'provider default' },
      grok: { tokens: null, source: 'provider default' },
      antigravity: { tokens: null, source: 'provider default' },
      zcode: { tokens: null, source: 'provider default' },
      pi: { tokens: null, source: 'provider default' },
      omp: { tokens: null, source: 'provider default' },
    },
    getParentSession: (session) => session?.parentChannelId ? {
      provider: session.provider,
      compactThresholdTokens: 180_000,
    } : null,
    normalizeProvider: testNormalizeProvider,
    getSupportedCompactStrategies: testGetSupportedCompactStrategies,
  });

  assert.deepEqual(settings.resolveCompactThresholdSetting({ provider: 'codex' }), {
    tokens: 272_000,
    source: 'provider env',
  });
  for (const provider of ['claude', 'grok', 'antigravity', 'zcode', 'pi', 'omp']) {
    assert.deepEqual(settings.resolveCompactThresholdSetting({ provider }), {
      tokens: null,
      source: 'provider default',
    });
  }
  assert.deepEqual(settings.resolveCompactThresholdSetting({ provider: 'cursor' }), {
    tokens: null,
    source: 'provider unsupported',
  });
  for (const provider of ['codex', 'claude', 'grok', 'antigravity', 'zcode', 'pi', 'omp']) {
    assert.deepEqual(settings.resolveCompactThresholdSetting({
      provider,
      compactThresholdTokens: 272_000,
    }), {
      tokens: 272_000,
      source: 'session override',
    });
    assert.deepEqual(settings.resolveCompactThresholdSetting({
      provider,
      parentChannelId: 'parent-1',
    }), {
      tokens: 180_000,
      source: 'parent channel',
    });
  }
  assert.deepEqual(settings.resolveCompactThresholdSetting({
    provider: 'cursor',
    compactThresholdTokens: 272_000,
  }), {
    tokens: null,
    source: 'provider unsupported',
  });
});

test('session-settings rejects malformed provider compact threshold defaults instead of using Codex fallback', () => {
  for (const provider of ['codex', 'claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp']) {
    const settings = createSessionSettings({
      maxInputTokensBeforeCompact: 272_000,
      compactThresholdDefaults: {
        [provider]: { tokens: 'broken', source: 'provider env' },
      },
      normalizeProvider: testNormalizeProvider,
      getSupportedCompactStrategies: testGetSupportedCompactStrategies,
    });

    assert.throws(
      () => settings.resolveCompactThresholdSetting({ provider }),
      new RegExp(`invalid compact threshold default for ${provider}`, 'i'),
    );
  }
  const settings = createSessionSettings({
    compactThresholdDefaults: {
      grok: { tokens: 123.5, source: 'provider env' },
    },
    normalizeProvider: testNormalizeProvider,
    getSupportedCompactStrategies: testGetSupportedCompactStrategies,
  });
  assert.throws(
    () => settings.resolveCompactThresholdSetting({ provider: 'grok' }),
    /invalid compact threshold default for grok/i,
  );
});

test('session-settings lets thread fast mode inherit the parent channel provider-scoped override', () => {
  const parentSession = {
    provider: 'claude',
    providers: {
      claude: {
        runnerSessionId: null,
        codexThreadId: null,
        lastInputTokens: null,
        model: null,
        effort: null,
        fastMode: null,
        compactStrategy: null,
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        configOverrides: [],
      },
      codex: {
        runnerSessionId: null,
        codexThreadId: null,
        lastInputTokens: null,
        model: 'gpt-5.4-turbo',
        codexProfile: 'work',
        effort: 'medium',
        fastMode: true,
        compactStrategy: 'native',
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        configOverrides: [],
      },
      omp: {
        runnerSessionId: null,
        model: 'ccswitch-newapi/gpt-5.6-sol',
        effort: 'high',
        fastMode: true,
        compactStrategy: 'native',
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        configOverrides: [],
      },
    },
  };
  const settings = createSessionSettings({
    getParentSession: () => parentSession,
    readCodexDefaults: () => ({ model: 'gpt-5.4', effort: 'high', fastMode: false }),
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveFastModeSetting({
    provider: 'codex',
    parentChannelId: 'channel-1',
    fastMode: null,
  }), {
    enabled: true,
    supported: true,
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveFastModeSetting({
    provider: 'omp',
    parentChannelId: 'channel-1',
    fastMode: null,
  }), {
    enabled: true,
    supported: true,
    serviceTier: 'priority',
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveModelSetting({
    provider: 'codex',
    parentChannelId: 'channel-1',
    model: null,
  }), {
    value: 'gpt-5.4-turbo',
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveReasoningEffortSetting({
    provider: 'codex',
    parentChannelId: 'channel-1',
    effort: null,
  }), {
    value: 'medium',
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveCompactStrategySetting({
    provider: 'codex',
    parentChannelId: 'channel-1',
    compactStrategy: null,
  }), {
    strategy: 'native',
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveCodexProfileSetting({
    provider: 'codex',
    parentChannelId: 'channel-1',
    codexProfile: null,
  }), {
    value: 'work',
    source: 'parent channel',
    supported: true,
    isExplicit: true,
    valid: false,
    availableProfiles: [],
    configPath: null,
    error: 'missing in ~/.codex/config.toml',
  });
});

test('session-settings resolves codex profile from session global default and provider default', () => {
  const parentSession = {
    provider: 'codex',
    providers: {
      codex: {
        runnerSessionId: null,
        codexThreadId: null,
        lastInputTokens: null,
        model: null,
        codexProfile: 'parent-work',
        effort: null,
        fastMode: null,
        compactStrategy: null,
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        runtimeMode: null,
        configOverrides: [],
      },
    },
  };
  const settings = createSessionSettings({
    getParentSession: () => parentSession,
    readDefaultCodexProfile: () => ({ profile: 'global-work', source: 'env default' }),
    readCodexProfileCatalog: () => ({
      profiles: ['work', 'parent-work', 'global-work'],
      configPath: '/tmp/codex-config.toml',
    }),
  });

  assert.deepEqual(settings.resolveCodexProfileSetting({
    provider: 'codex',
    codexProfile: 'work',
  }), {
    value: 'work',
    source: 'session override',
    supported: true,
    isExplicit: true,
    valid: true,
    availableProfiles: ['work', 'parent-work', 'global-work'],
    configPath: '/tmp/codex-config.toml',
    error: null,
  });

  assert.deepEqual(settings.resolveCodexProfileSetting({
    provider: 'codex',
    parentChannelId: 'channel-1',
    codexProfile: null,
  }), {
    value: 'parent-work',
    source: 'parent channel',
    supported: true,
    isExplicit: true,
    valid: true,
    availableProfiles: ['work', 'parent-work', 'global-work'],
    configPath: '/tmp/codex-config.toml',
    error: null,
  });

  const defaultSettings = createSessionSettings({
    getParentSession: () => null,
    readDefaultCodexProfile: () => ({ profile: 'global-work', source: 'env default' }),
    readCodexProfileCatalog: () => ({
      profiles: ['work', 'parent-work', 'global-work'],
      configPath: '/tmp/codex-config.toml',
    }),
  });

  assert.deepEqual(defaultSettings.resolveCodexProfileSetting({
    provider: 'codex',
    codexProfile: null,
  }), {
    value: 'global-work',
    source: 'env default',
    supported: true,
    isExplicit: true,
    valid: true,
    availableProfiles: ['work', 'parent-work', 'global-work'],
    configPath: '/tmp/codex-config.toml',
    error: null,
  });

  const providerDefaultSettings = createSessionSettings({
    readDefaultCodexProfile: () => ({ profile: null, source: 'env default' }),
    readCodexProfileCatalog: () => ({
      profiles: ['work'],
      configPath: '/tmp/codex-config.toml',
    }),
  });

  assert.deepEqual(providerDefaultSettings.resolveCodexProfileSetting({
    provider: 'codex',
  }), {
    value: null,
    source: 'provider default',
    supported: true,
    isExplicit: false,
    valid: true,
    availableProfiles: ['work'],
    configPath: '/tmp/codex-config.toml',
    error: null,
  });
});

test('session-settings resolves Claude model from ~/.claude/settings.json', () => {
  const settings = createSessionSettings({
    readClaudeDefaults: () => ({
      model: 'fable',
      modelConfigured: true,
      profile: null,
      profileConfigured: false,
      effort: null,
      effortConfigured: false,
      fastMode: false,
      fastModeConfigured: false,
      source: 'settings.json',
      settingsPath: '/tmp/.claude/settings.json',
      error: null,
    }),
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveModelSetting({ provider: 'claude', model: null }), {
    value: 'fable',
    source: 'settings.json',
  });

  assert.deepEqual(settings.getProviderDefaults('claude'), {
    model: 'fable',
    modelConfigured: true,
    profile: null,
    profileConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: false,
    fastModeConfigured: false,
    source: 'settings.json',
    settingsPath: '/tmp/.claude/settings.json',
    error: null,
  });
});

test('session-settings resolves Claude runtime mode from session, parent, and env default', () => {
  const parentSession = {
    provider: 'claude',
    providers: {
      claude: {
        runnerSessionId: null,
        codexThreadId: null,
        lastInputTokens: null,
        model: null,
        effort: null,
        fastMode: null,
        runtimeMode: 'long',
        compactStrategy: null,
        compactEnabled: null,
        compactThresholdTokens: null,
        nativeCompactTokenLimit: null,
        configOverrides: [],
      },
    },
  };
  const settings = createSessionSettings({
    claudeRuntimeMode: 'normal',
    codexRuntimeMode: 'normal',
    getParentSession: () => parentSession,
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveRuntimeModeSetting({ provider: 'claude', runtimeMode: 'normal' }), {
    mode: 'normal',
    supported: true,
    source: 'session override',
  });
  assert.deepEqual(settings.resolveRuntimeModeSetting({ provider: 'claude', runtimeMode: null, parentChannelId: 'channel-1' }), {
    mode: 'long',
    supported: true,
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveRuntimeModeSetting({ provider: 'claude', runtimeMode: null }), {
    mode: 'long',
    supported: true,
    source: 'parent channel',
  });
  assert.deepEqual(createSessionSettings({ claudeRuntimeMode: 'hot' }).resolveRuntimeModeSetting({ provider: 'claude' }), {
    mode: 'long',
    supported: true,
    source: 'env default',
  });
  assert.deepEqual(settings.resolveRuntimeModeSetting({ provider: 'codex', runtimeMode: 'long' }), {
    mode: 'long',
    supported: true,
    source: 'session override',
  });
  assert.deepEqual(createSessionSettings({ codexRuntimeMode: 'long' }).resolveRuntimeModeSetting({ provider: 'codex' }), {
    mode: 'long',
    supported: true,
    source: 'env default',
  });
});

test('session-settings defaults Claude runtime to normal dash-p mode', () => {
  const settings = createSessionSettings({
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveRuntimeModeSetting({ provider: 'claude', runtimeMode: null }), {
    mode: 'normal',
    supported: true,
    source: 'env default',
  });
});

test('session-settings defaults Codex runtime to side-capable long mode', () => {
  const settings = createSessionSettings({
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveRuntimeModeSetting({ provider: 'codex', runtimeMode: null }), {
    mode: 'long',
    supported: true,
    source: 'env default',
  });
});

test('session-settings resolves busy prompt mode with fail-closed steering constraints', () => {
  assert.equal(normalizeBusyPromptMode('queue'), 'queue');
  assert.equal(normalizeBusyPromptMode('steer-if-possible'), 'steer_if_possible');
  assert.deepEqual(parseBusyPromptModeAction('steer'), { type: 'set', mode: 'steer_if_possible' });
  assert.deepEqual(parseBusyPromptModeAction('default'), { type: 'set', mode: null });
  assert.equal(formatBusyPromptModeLabel('queue', 'zh'), '排队');

  const parentSession = {
    provider: 'claude',
    providers: {
      claude: {
        busyPromptMode: 'steer_if_possible',
      },
    },
  };
  const settings = createSessionSettings({
    claudeRuntimeMode: 'long',
    getParentSession: () => parentSession,
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveBusyPromptModeSetting({ provider: 'claude', runtimeMode: 'normal', busyPromptMode: 'steer' }), {
    mode: 'queue',
    requestedMode: 'steer_if_possible',
    canSteer: false,
    supported: true,
    source: 'session override',
    reason: 'requires long runtime',
  });
  assert.deepEqual(settings.resolveBusyPromptModeSetting({ provider: 'claude', runtimeMode: 'long', busyPromptMode: 'steer' }), {
    mode: 'queue',
    requestedMode: 'steer_if_possible',
    canSteer: false,
    supported: true,
    source: 'session override',
    reason: 'steer unavailable',
  });
  assert.deepEqual(settings.resolveBusyPromptModeSetting({ provider: 'claude', runtimeMode: 'long', busyPromptMode: 'queue' }), {
    mode: 'queue',
    requestedMode: 'queue',
    canSteer: false,
    supported: true,
    source: 'session override',
    reason: null,
  });
  assert.deepEqual(settings.resolveBusyPromptModeSetting({ provider: 'codex', runtimeMode: 'long', busyPromptMode: 'steer' }), {
    mode: 'steer_if_possible',
    requestedMode: 'steer_if_possible',
    canSteer: true,
    supported: true,
    source: 'session override',
    reason: null,
  });
  assert.equal(settings.resolveBusyPromptModeSetting({ provider: 'claude', runtimeMode: null }).source, 'parent channel');
});

test('session-settings resolves reply delivery from session, parent channel, and env default', () => {
  const parentSession = {
    replyDeliveryMode: 'stream_mention',
  };
  const settings = createSessionSettings({
    defaultReplyDeliveryMode: 'card_mention',
    getParentSession: () => parentSession,
    normalizeProvider: testNormalizeProvider,
  });

  assert.equal(normalizeReplyDeliveryMode('stream_only'), 'stream_only');
  assert.equal(normalizeReplyDeliveryMode('weird'), null);
  assert.equal(formatReplyDeliveryModeLabel('card_mention', 'zh'), '只更新进度卡，完成时触发 @');
  assert.equal(formatReplyDeliveryModeLabel('stream_only', 'en'), 'Send process messages, do not trigger @ when done');

  assert.deepEqual(settings.resolveReplyDeliverySetting({
    replyDeliveryMode: 'card_only',
    parentChannelId: 'channel-1',
  }), {
    mode: 'card_only',
    source: 'session override',
  });
  assert.deepEqual(settings.resolveReplyDeliverySetting({
    replyDeliveryMode: null,
    parentChannelId: 'channel-1',
  }), {
    mode: 'stream_mention',
    source: 'parent channel',
  });
  assert.deepEqual(settings.resolveReplyDeliverySetting({
    replyDeliveryMode: null,
  }), {
    mode: 'card_mention',
    source: 'env default',
  });
});

test('session-settings resolves and parses extra info config', () => {
  const parent = {
    extraInfoEnabled: false,
    extraInfoText: 'parent {thread}',
  };
  const settings = createSessionSettings({
    defaultExtraInfoEnabled: true,
    defaultExtraInfoText: 'default {thread}',
    getParentSession: (session) => (session?.parentChannelId ? parent : null),
  });

  assert.deepEqual(settings.resolveExtraInfoSetting({}), {
    enabled: true,
    enabledSource: 'env default',
    text: 'default {thread}',
    textSource: 'env default',
  });
  assert.deepEqual(settings.resolveExtraInfoSetting({ parentChannelId: 'parent-1' }), {
    enabled: false,
    enabledSource: 'parent channel',
    text: 'parent {thread}',
    textSource: 'parent channel',
  });
  assert.deepEqual(settings.resolveExtraInfoSetting({
    parentChannelId: 'parent-1',
    extraInfoEnabled: true,
    extraInfoText: 'local {msg}',
  }), {
    enabled: true,
    enabledSource: 'session override',
    text: 'local {msg}',
    textSource: 'session override',
  });
  assert.deepEqual(parseExtraInfoConfigFromText('off'), { type: 'set_enabled', enabled: false });
  assert.deepEqual(parseExtraInfoConfigFromText('text hi {thread}'), { type: 'set_text', text: 'hi {thread}' });
  assert.deepEqual(parseExtraInfoConfigFromText('default'), { type: 'reset' });
});

test('session-settings parses compact, reasoning and workspace command inputs', () => {
  assert.deepEqual(parseCompactConfigAction('strategy', 'native'), {
    type: 'set_strategy',
    strategy: 'native',
  });
  assert.deepEqual(parseCompactConfigAction('enabled', 'off'), {
    type: 'set_enabled',
    enabled: false,
  });
  assert.deepEqual(parseCompactConfigFromText('token_limit 99999'), {
    type: 'set_threshold',
    tokens: 99_999,
  });
  assert.deepEqual(parseCompactConfigFromText('run'), { type: 'run' });
  assert.deepEqual(parseCompactConfigFromText('continue'), { type: 'invalid' });
  assert.deepEqual(parseCompactConfigFromText('reset'), { type: 'reset' });
  assert.deepEqual(parseFastModeAction('on'), { type: 'set', enabled: true });
  assert.deepEqual(parseFastModeAction('default'), { type: 'set', enabled: null });
  assert.deepEqual(parseFastModeAction('status'), { type: 'status' });
  assert.equal(normalizeSessionFastMode('off'), false);
  assert.deepEqual(parseRuntimeModeAction('long'), { type: 'set', mode: 'long' });
  assert.deepEqual(parseRuntimeModeAction('default'), { type: 'set', mode: null });
  assert.deepEqual(parseRuntimeModeAction('status'), { type: 'status' });
  assert.equal(normalizeSessionRuntimeMode('hot'), 'long');
  assert.deepEqual(parseWorkspaceCommandAction('browse'), { type: 'browse' });
  assert.deepEqual(parseWorkspaceCommandAction('~/repo'), { type: 'set', value: '~/repo' });
  assert.equal(parseReasoningEffortInput('HIGH'), 'high');
  assert.equal(parseReasoningEffortInput('default', { allowDefault: true }), 'default');
  assert.equal(parseReasoningEffortInput('invalid'), null);
});

test('session-settings provides compact descriptions and provider defaults', () => {
  const warnings = [];
  const settings = createSessionSettings({
    readCodexDefaults: () => ({ model: 'gpt-5-codex', effort: 'high', fastMode: true }),
    readAntigravityDefaults: () => ({
      model: 'Claude Opus 4.6 (Thinking)',
      modelConfigured: true,
      source: 'settings.json',
      settingsPath: '/tmp/agy-settings.json',
      error: null,
    }),
    normalizeProvider: testNormalizeProvider,
    getSupportedCompactStrategies: () => ['hard', 'native', 'off'],
  });

  assert.equal(normalizeCompactStrategy('native'), 'native');
  assert.equal(normalizeCompactStrategy('weird', { logger: { warn: (line) => warnings.push(line) } }), 'hard');
  assert.match(warnings[0], /Unknown COMPACT_STRATEGY=weird/);
  assert.equal(describeCompactStrategy('native', 'zh'), 'native（由 provider CLI 原生压缩并继续当前 session）');
  assert.deepEqual(settings.resolveCompactStrategySetting({ provider: 'antigravity' }), {
    strategy: 'native',
    source: 'env default',
  });
  assert.deepEqual(settings.getProviderDefaults('codex'), {
    model: 'gpt-5-codex',
    profile: null,
    profileConfigured: false,
    effort: 'high',
    fastMode: true,
    source: 'config.toml',
  });
  assert.deepEqual(settings.getProviderDefaults('antigravity'), {
    model: 'Claude Opus 4.6 (Thinking)',
    modelConfigured: true,
    profile: null,
    profileConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: false,
    fastModeConfigured: false,
    source: 'settings.json',
    settingsPath: '/tmp/agy-settings.json',
    error: null,
  });
});

test('session-settings disables bot-managed compaction when a provider exposes no compact strategy', () => {
  const settings = createSessionSettings({
    normalizeProvider: testNormalizeProvider,
    getSupportedCompactStrategies: (provider) => provider === 'cursor' ? [] : ['hard', 'native', 'off'],
  });

  assert.deepEqual(settings.resolveCompactStrategySetting({ provider: 'cursor', compactStrategy: 'hard' }), {
    strategy: 'off',
    source: 'provider unsupported',
  });
});

test('session-settings uses DEFAULT_MODEL only where the provider supports shared fallback', () => {
  const settings = createSessionSettings({
    defaultModel: 'gpt-5.4',
    readCodexDefaults: () => ({
      model: null,
      modelConfigured: false,
      effort: null,
      effortConfigured: false,
      fastMode: true,
    }),
    readAntigravityDefaults: () => ({
      model: null,
      modelConfigured: false,
      source: 'provider',
      error: null,
    }),
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveModelSetting({ provider: 'codex', model: null }), {
    value: 'gpt-5.4',
    source: 'env default',
  });
  assert.deepEqual(settings.resolveModelSetting({ provider: 'antigravity', model: null }), {
    value: null,
    source: 'provider',
  });
  assert.deepEqual(settings.getProviderDefaults('antigravity'), {
    model: null,
    modelConfigured: false,
    profile: null,
    profileConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: false,
    fastModeConfigured: false,
    source: 'provider',
    settingsPath: null,
    error: null,
  });
});

test('session-settings resolves Antigravity model from session parent and settings.json', () => {
  const parentSession = {
    provider: 'antigravity',
    providers: {
      antigravity: {
        model: 'Gemini 3.5 Flash (High)',
      },
    },
  };
  const settings = createSessionSettings({
    getParentSession: () => parentSession,
    readAntigravityDefaults: () => ({
      model: 'Claude Opus 4.6 (Thinking)',
      modelConfigured: true,
      source: 'settings.json',
      error: null,
    }),
    normalizeProvider: testNormalizeProvider,
  });

  assert.deepEqual(settings.resolveModelSetting({ provider: 'antigravity', model: 'Gemini 3.5 Pro' }), {
    value: 'Gemini 3.5 Pro',
    source: 'session override',
  });
  assert.deepEqual(settings.resolveModelSetting({ provider: 'antigravity', model: null, parentChannelId: 'parent-1' }), {
    value: 'Gemini 3.5 Flash (High)',
    source: 'parent channel',
  });

  const providerSettings = createSessionSettings({
    readAntigravityDefaults: () => ({
      model: 'Claude Opus 4.6 (Thinking)',
      modelConfigured: true,
      source: 'settings.json',
      error: null,
    }),
    normalizeProvider: testNormalizeProvider,
  });
  assert.deepEqual(providerSettings.resolveModelSetting({ provider: 'antigravity', model: null }), {
    value: 'Claude Opus 4.6 (Thinking)',
    source: 'settings.json',
  });
});
