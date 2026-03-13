import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionCommandActions } from '../src/session-command-actions.js';

function createWorkspaceBindingResolver(defaultState) {
  return (session, key) => ({
    workspaceDir: session.workspaceDir || defaultState.value || `/legacy/${key}`,
    source: session.workspaceDir ? 'thread override' : defaultState.value ? 'provider default' : 'legacy fallback',
    defaultWorkspaceDir: defaultState.value,
    defaultSource: defaultState.value ? 'provider-scoped env' : 'unset',
    defaultEnvKey: `CODEX__DEFAULT_WORKSPACE_DIR`,
  });
}

test('createSessionCommandActions.setProvider clears bound session and persists', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'codex', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setProvider(session, 'claude');

  assert.equal(result.previous, 'codex');
  assert.equal(result.provider, 'claude');
  assert.equal(session.provider, 'claude');
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setWorkspaceDir resets codex session when workspace changes', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared',
    getWorkspaceBinding: createWorkspaceBindingResolver(defaultState),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'codex', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, 'thread-1', '/new/project');

  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(result.sessionReset, true);
  assert.equal(session.runnerSessionId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setWorkspaceDir keeps claude session when workspace changes', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared',
    getWorkspaceBinding: createWorkspaceBindingResolver(defaultState),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'claude', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, 'thread-1', '/new/project');

  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(result.sessionReset, false);
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setWorkspaceDir resets gemini session when workspace changes', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared',
    getWorkspaceBinding: createWorkspaceBindingResolver(defaultState),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => {
      if (provider === 'claude') return 'Claude';
      if (provider === 'gemini') return 'Gemini';
      return 'Codex';
    },
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'gemini', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, 'thread-1', '/new/project');

  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(result.sessionReset, true);
  assert.equal(session.runnerSessionId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setDefaultWorkspaceDir clears affected codex sessions', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared-a' };
  const sessionA = { provider: 'codex', workspaceDir: null, runnerSessionId: 'sess-a', codexThreadId: 'sess-a' };
  const sessionB = { provider: 'codex', workspaceDir: '/explicit', runnerSessionId: 'sess-b', codexThreadId: 'sess-b' };
  const getWorkspaceBinding = createWorkspaceBindingResolver(defaultState);
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared-a',
    getWorkspaceBinding,
    listStoredSessions: () => [
      { key: 'thread-a', session: sessionA },
      { key: 'thread-b', session: sessionB },
    ],
    resolveProviderDefaultWorkspace: () => ({
      workspaceDir: defaultState.value,
      source: 'provider-scoped env',
      envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
    setProviderDefaultWorkspace: (_provider, nextDir) => {
      defaultState.value = nextDir;
      return {
        workspaceDir: defaultState.value,
        source: defaultState.value ? 'provider-scoped env' : 'unset',
        envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
      };
    },
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const result = actions.setDefaultWorkspaceDir(sessionA, '/shared-b');

  assert.equal(result.affectedThreads, 1);
  assert.equal(result.resetSessions, 1);
  assert.equal(sessionA.runnerSessionId, null);
  assert.equal(sessionB.runnerSessionId, 'sess-b');
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.startNewSession clears bound session and token snapshot', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: () => 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = {
    provider: 'codex',
    runnerSessionId: 'sess-1',
    codexThreadId: 'sess-1',
    lastInputTokens: 123,
  };

  const result = actions.startNewSession(session);

  assert.equal(result.sessionId, null);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(session.lastInputTokens, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.formatRecentSessionsReport renders resume hint and items', () => {
  const actions = createSessionCommandActions({
    saveDb: () => {},
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: () => {},
    getSessionId: () => null,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [
      { id: 'abc123', mtime: Date.now() - 1_000 },
      { id: 'def456', mtime: Date.now() - 5_000 },
    ],
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
  });
  const session = { provider: 'codex' };

  const report = actions.formatRecentSessionsReport({
    key: 'thread-1',
    session,
    resumeRef: '/bot-resume',
  });

  assert.match(report, /最近 Codex Sessions/);
  assert.match(report, /`\/bot-resume`/);
  assert.match(report, /1\. `abc123`/);
  assert.match(report, /2\. `def456`/);
});
