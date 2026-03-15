import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSlashCommandRouter,
  parseCommandActionButtonId,
} from '../src/slash-command-router.js';

function createInteraction(commandName) {
  return {
    commandName,
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    user: { id: 'user-1' },
    options: {
      getString() {
        return null;
      },
    },
  };
}

function createRouterState(overrides = {}) {
  const session = { provider: 'codex', language: 'zh' };
  const replies = [];
  let resetCalls = 0;
  const cancelCalls = [];
  const retryCalls = [];
  const browseCalls = [];
  let retryOutcome = { ok: true, enqueued: true, queuedAhead: 0 };

  const router = createSlashCommandRouter({
    slashRef: (name) => `/cx_${name}`,
    getSession: () => session,
    getSessionLanguage: (currentSession) => currentSession.language,
    getSessionProvider: (currentSession) => currentSession.provider,
    getProviderDisplayName: (provider) => provider,
    getEffectiveSecurityProfile: () => ({ profile: 'team' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0, source: 'default' }),
    isReasoningEffortSupported: () => true,
    commandActions: {
      resetSession() {
        resetCalls += 1;
      },
      startNewSession() {
        resetCalls += 1;
      },
      formatRecentSessionsReport: () => '',
      clearWorkspaceDir: () => ({}),
      setWorkspaceDir: () => ({}),
      setDefaultWorkspaceDir: () => ({}),
      setProvider: () => ({ previous: 'codex' }),
      setModel: () => ({ model: null }),
      setReasoningEffort: () => ({ effort: null }),
      applyCompactConfig() {},
      setMode: () => ({ mode: 'safe' }),
      bindSession: () => ({ providerLabel: 'Codex', sessionId: 'sid' }),
      renameSession: () => ({ label: 'name' }),
      setOnboardingEnabled: () => ({ enabled: true }),
      setLanguage: () => ({ language: 'zh' }),
      setSecurityProfile: () => ({ profile: 'team' }),
      setTimeoutMs: () => ({ timeoutSetting: { timeoutMs: 0, source: 'default' } }),
    },
    isOnboardingEnabled: () => true,
    buildOnboardingActionRows: () => [],
    formatOnboardingStepReport: () => '',
    formatOnboardingDisabledMessage: () => '',
    formatOnboardingConfigReport: () => '',
    formatStatusReport: () => '',
    formatQueueReport: () => '',
    formatDoctorReport: () => '',
    formatWorkspaceReport: () => '',
    formatWorkspaceSetHelp: () => '',
    formatWorkspaceUpdateReport: () => '',
    formatDefaultWorkspaceSetHelp: () => '',
    formatDefaultWorkspaceUpdateReport: () => '',
    formatLanguageConfigReport: () => '',
    formatProfileConfigHelp: () => '',
    formatProfileConfigReport: () => '',
    formatTimeoutConfigHelp: () => '',
    formatTimeoutConfigReport: () => '',
    formatProgressReport: () => '',
    formatCancelReport: (outcome) => JSON.stringify(outcome),
    formatCompactStrategyConfigHelp: () => '',
    formatCompactConfigReport: () => '',
    formatCompactConfigUnsupported: () => '',
    formatReasoningEffortUnsupported: () => '',
    normalizeProvider: (value) => value,
    parseWorkspaceCommandAction: (value) => String(value || '').trim().toLowerCase() === 'browse'
      ? { type: 'browse' }
      : { type: 'status' },
    parseUiLanguageInput: () => 'zh',
    parseSecurityProfileInput: () => 'team',
    parseTimeoutConfigAction: () => ({ type: 'status' }),
    parseCompactConfigAction: () => ({ type: 'status' }),
    providerSupportsCompactConfigAction: () => true,
    cancelChannelWork: (key, reason) => {
      const outcome = { key, reason };
      cancelCalls.push(outcome);
      return outcome;
    },
    retryLastPrompt: async (key, userId) => {
      retryCalls.push({ key, userId });
      return retryOutcome;
    },
    openWorkspaceBrowser: ({ key, mode, userId }) => {
      const payload = { content: `browse:${mode}:${key}:${userId}`, components: [] };
      browseCalls.push(payload);
      return payload;
    },
    resolvePath: (value) => value,
    safeError: (err) => String(err?.message || err),
    ...overrides,
  });

  return {
    session,
    replies,
    router,
    getBrowseCalls: () => [...browseCalls],
    getResetCalls: () => resetCalls,
    getCancelCalls: () => [...cancelCalls],
    getRetryCalls: () => [...retryCalls],
    setRetryOutcome: (value) => {
      retryOutcome = value;
    },
  };
}

test('createSlashCommandRouter routes new command through new-session handler', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_new'),
    commandName: 'new',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(state.getResetCalls(), 1);
  assert.deepEqual(state.replies, [{
    content: '🆕 已切换到新会话。\n下一条普通消息会开启新的上下文。',
    flags: 64,
  }]);
});

test('createSlashCommandRouter routes abort alias to cancel handler', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_abort'),
    commandName: 'abort',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getCancelCalls(), [{ key: 'channel-1', reason: 'slash_cancel' }]);
  assert.deepEqual(state.replies, [{
    content: JSON.stringify({ key: 'channel-1', reason: 'slash_cancel' }),
    flags: 64,
  }]);
});

test('createSlashCommandRouter opens workspace browser for setdir browse', async () => {
  const state = createRouterState();
  const interaction = createInteraction('cx_setdir');
  interaction.options.getString = () => 'browse';

  const handled = await state.router({
    interaction,
    commandName: 'setdir',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getBrowseCalls(), [{
    content: 'browse:thread:channel-1:user-1',
    components: [],
  }]);
  assert.deepEqual(state.replies, [{
    content: 'browse:thread:channel-1:user-1',
    components: [],
  }]);
});

test('parseCommandActionButtonId decodes command buttons', () => {
  assert.deepEqual(parseCommandActionButtonId('cmd:new:123456789'), {
    command: 'new',
    userId: '123456789',
  });
  assert.deepEqual(parseCommandActionButtonId('cmd:retry:123456789'), {
    command: 'retry',
    userId: '123456789',
  });
  assert.equal(parseCommandActionButtonId('cmd:unknown:123456789'), null);
});

test('createSlashCommandRouter routes retry command through retry handler', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_retry'),
    commandName: 'retry',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getRetryCalls(), [{ key: 'channel-1', userId: 'user-1' }]);
  assert.deepEqual(state.replies, [{
    content: '🔁 已重新加入队列。',
    flags: 64,
  }]);
});

test('createSlashCommandRouter rejects only unsupported compact actions for non-native providers', async () => {
  const state = createRouterState({
    parseCompactConfigAction: () => ({ type: 'set_strategy', strategy: 'native' }),
    providerSupportsCompactConfigAction: () => false,
    formatCompactConfigUnsupported: () => '⚠️ 当前 provider Gemini CLI 不支持 `native` 压缩。',
  });
  state.session.provider = 'gemini';
  const interaction = createInteraction('cx_compact');
  interaction.options.getString = (name) => (name === 'key' ? 'strategy' : 'native');

  const handled = await state.router({
    interaction,
    commandName: 'compact',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.replies, [{
    content: '⚠️ 当前 provider Gemini CLI 不支持 `native` 压缩。',
    flags: 64,
  }]);
});
