import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore, normalizeChildThreadWorkspaceMode } from '../src/session-store.js';
import { normalizeProvider as normalizeAllProviders } from '../src/provider-metadata.js';
import { createSessionCommandActions } from '../src/session-command-actions.js';
import { createRunnerArgsBuilder } from '../src/runner-args.js';

function createModeInheritanceFixture(t, { provider = 'cursor', mode = 'safe', threads = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-mode-inheritance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataFile = path.join(root, 'sessions.json');
  fs.writeFileSync(dataFile, JSON.stringify({ threads }));
  const options = {
    dataFile,
    workspaceRoot: path.join(root, 'workspaces'),
    botProvider: provider,
    defaults: { provider, mode, language: 'zh', onboardingEnabled: true },
    getSessionId: (session) => session?.runnerSessionId || null,
    normalizeProvider: normalizeAllProviders,
    normalizeUiLanguage: (value) => value || 'zh',
    normalizeSessionSecurityProfile: (value) => value || null,
    normalizeSessionTimeoutMs: (value) => value || null,
    normalizeSessionCompactStrategy: (value) => value || null,
    normalizeSessionCompactEnabled: (value) => value ?? null,
    normalizeSessionCompactTokenLimit: (value) => value || null,
  };
  const store = createSessionStore(options);
  const actions = createSessionCommandActions({ saveDb: store.saveDb });
  return { store, actions, dataFile, reload: () => createSessionStore(options) };
}

for (const provider of ['codex', 'claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp']) {
  test(`${provider}: permission mode follows parent dynamically until explicitly overridden`, (t) => {
    const { store, actions, dataFile, reload } = createModeInheritanceFixture(t, { provider });
    const parent = store.getSession('parent');
    actions.setMode(parent, 'dangerous');
    const child = store.getSession('child', { parentChannelId: 'parent' });
    assert.equal(child.mode, 'dangerous');
    assert.equal(child.modeOverride, null);
    assert.equal(child.modeSource, 'parent channel');
    const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
      getSessionId: () => '00000000-0000-4000-8000-000000000001',
    });
    const runnerOptions = { provider, workspaceDir: '/tmp', prompt: 'test', promptFile: '/tmp/test-prompt' };
    const assertRunnerMode = (mode) => assert.deepEqual(
      buildSessionRunnerArgs({ ...runnerOptions, session: child }),
      buildSessionRunnerArgs({ ...runnerOptions, session: { mode } }),
    );
    assertRunnerMode('dangerous');

    actions.setMode(parent, 'safe');
    assert.equal(child.mode, 'safe', 'already loaded child must not cache its inherited mode');
    actions.setMode(child, 'safe');
    actions.setMode(parent, 'dangerous');
    assert.equal(child.mode, 'safe', 'explicit safe must survive a dangerous parent');
    assert.equal(child.modeSource, 'session override');
    assertRunnerMode('safe');

    actions.setMode(child, 'default');
    assert.equal(child.mode, 'dangerous');
    assert.equal(child.modeOverride, null);
    assertRunnerMode('dangerous');
    const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(persisted.threads.child.modeOverride, null);
    assert.equal(persisted.threads.child.mode, 'dangerous');

    const reopened = reload();
    const reopenedChild = reopened.getSession('child');
    assert.equal(reopenedChild.mode, 'dangerous', 'resolve parent before it has been hydrated');
    reopened.getSession('parent').mode = 'safe';
    assert.equal(reopenedChild.mode, 'safe');
  });
}

test('missing parent falls back to global, and a newly configured parent takes effect', (t) => {
  const { store, actions } = createModeInheritanceFixture(t, { mode: 'dangerous' });
  const child = store.getSession('child', { parentChannelId: 'parent' });
  assert.equal(child.mode, 'dangerous');
  assert.equal(child.modeOverride, null);
  const parent = store.getSession('parent');
  actions.setMode(parent, 'safe');
  assert.equal(child.mode, 'safe');
  actions.setMode(parent, 'default');
  assert.equal(child.mode, 'dangerous');
});

test('legacy modes are preserved because their override provenance was not recorded', (t) => {
  const { store, actions, reload } = createModeInheritanceFixture(t, {
    threads: {
      parent: { provider: 'cursor', mode: 'dangerous' },
      child: { provider: 'cursor', mode: 'safe', parentChannelId: 'parent' },
    },
  });
  const child = store.getSession('child');
  assert.equal(child.mode, 'safe');
  assert.equal(child.modeOverride, 'safe');
  assert.equal(reload().getSession('child').mode, 'safe');
  actions.setMode(child, 'default');
  assert.equal(child.mode, 'dangerous');
});

test('invalid persisted overrides and cyclic inheritance fail rather than granting permissions', (t) => {
  const { store, dataFile } = createModeInheritanceFixture(t, {
    threads: {
      broken: { provider: 'cursor', mode: 'dangerous', modeOverride: 'yes' },
      a: { provider: 'cursor', mode: 'safe', modeOverride: null, parentChannelId: 'b' },
      b: { provider: 'cursor', mode: 'safe', modeOverride: null, parentChannelId: 'a' },
    },
  });
  const before = fs.readFileSync(dataFile, 'utf8');
  assert.throws(() => store.getSession('broken'), /invalid.*mode/i);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
  assert.throws(() => store.getSession('a'), /cyclic.*mode/i);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
});

test('invalid mode commands do not mutate or save a session', (t) => {
  const { store, actions, dataFile } = createModeInheritanceFixture(t);
  const child = store.getSession('child');
  const before = fs.readFileSync(dataFile, 'utf8');
  assert.throws(() => actions.setMode(child, 'approve'), /invalid.*mode/i);
  assert.equal(child.mode, 'safe');
  assert.equal(child.modeOverride, null);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
});

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'claude') return 'claude';
  return 'codex';
}

function normalizeProviderWithAntigravity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'claude') return 'claude';
  if (raw === 'antigravity' || raw === 'agy') return 'antigravity';
  return 'codex';
}

function normalizeUiLanguage(value) {
  return value === 'en' ? 'en' : 'zh';
}

function normalizeSessionSecurityProfile(value) {
  if (!value) return null;
  return value;
}

function normalizeSessionTimeoutMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSessionCompactStrategy(value) {
  if (!value) return null;
  return value;
}

function normalizeSessionCompactEnabled(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  return null;
}

function normalizeSessionCompactTokenLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

test('createSessionStore keeps legacy fallback for fresh thread when no default workspace exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    botProvider: 'claude',
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  const workspaceDir = store.ensureWorkspace(session, 'thread-1');

  assert.equal(session.provider, 'claude');
  assert.equal(session.extraInfoEnabled, null);
  assert.equal(session.extraInfoText, null);
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(session.workspaceDir, null);
  assert.equal(fs.existsSync(workspaceDir), true);
});

test('createSessionStore resolves provider default workspace without persisting thread override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const defaultWorkspaceDir = path.join(root, 'shared-workspace');
  fs.mkdirSync(defaultWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    botProvider: 'claude',
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    resolveDefaultWorkspace: () => ({
      workspaceDir: defaultWorkspaceDir,
      source: 'provider-scoped env',
      envKey: 'CLAUDE__DEFAULT_WORKSPACE_DIR',
    }),
  });

  const session = store.getSession('thread-1');
  const binding = store.getWorkspaceBinding(session, 'thread-1');
  const workspaceDir = store.ensureWorkspace(session, 'thread-1');

  assert.equal(binding.workspaceDir, defaultWorkspaceDir);
  assert.equal(binding.source, 'provider default');
  assert.equal(workspaceDir, defaultWorkspaceDir);
  assert.equal(session.workspaceDir, null);
});

test('createSessionStore records the parent channel for thread sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.parentChannelId, 'channel-1');
  assert.equal(persisted.threads['thread-1'].parentChannelId, 'channel-1');
  assert.equal(store.getParentSession(session), null);
});

test('createSessionStore lets a thread inherit the parent channel workspace binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const parentWorkspaceDir = path.join(root, 'parent-workspace');
  fs.mkdirSync(parentWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const parentSession = store.getSession('channel-1');
  parentSession.workspaceDir = parentWorkspaceDir;
  store.saveDb();

  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, parentWorkspaceDir);
  assert.equal(binding.source, 'parent channel');
  assert.equal(binding.parentChannelId, 'channel-1');
});

test('normalizeChildThreadWorkspaceMode defaults invalid values to inherit', () => {
  assert.equal(normalizeChildThreadWorkspaceMode('inherit'), 'inherit');
  assert.equal(normalizeChildThreadWorkspaceMode('separate'), 'separate');
  assert.equal(normalizeChildThreadWorkspaceMode('unknown'), 'inherit');
});

test('createSessionStore can keep child threads on separate fallback workspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const parentWorkspaceDir = path.join(root, 'parent-workspace');
  fs.mkdirSync(parentWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    childThreadWorkspaceMode: 'separate',
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const parentSession = store.getSession('channel-1');
  parentSession.workspaceDir = parentWorkspaceDir;
  store.saveDb();

  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');
  const workspaceDir = store.ensureWorkspace(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(binding.source, 'legacy fallback');
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(fs.existsSync(workspaceDir), true);
});

test('createSessionStore can resolve child thread workspace mode dynamically per provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const parentWorkspaceDir = path.join(root, 'parent-workspace');
  fs.mkdirSync(parentWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    resolveChildThreadWorkspaceMode: (provider) => (provider === 'codex' ? 'separate' : 'inherit'),
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const parentSession = store.getSession('channel-1');
  parentSession.workspaceDir = parentWorkspaceDir;
  store.saveDb();

  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(binding.source, 'legacy fallback');
});

test('createSessionStore keeps thread legacy fallback isolated when parent has no explicit workspace override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  store.getSession('channel-1');
  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');
  const workspaceDir = store.ensureWorkspace(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(binding.source, 'legacy fallback');
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'channel-1')), false);
});

test('createSessionStore migrates persisted legacy thread workspace to null so defaults can apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const defaultWorkspaceDir = path.join(root, 'repo-root');
  const legacyDir = path.join(workspaceRoot, 'thread-1');
  fs.mkdirSync(defaultWorkspaceDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'codex',
        workspaceDir: legacyDir,
        runnerSessionId: 'sess-1',
        codexThreadId: 'sess-1',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        lastPrompt: 'legacy prompt',
        lastPromptAt: '2026-01-01T00:00:00.000Z',
        processLines: 5,
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    resolveDefaultWorkspace: () => ({
      workspaceDir: defaultWorkspaceDir,
      source: 'provider-scoped env',
      envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
  });

  const session = store.getSession('thread-1');
  const binding = store.getWorkspaceBinding(session, 'thread-1');

  assert.equal(session.workspaceDir, null);
  assert.equal(binding.workspaceDir, defaultWorkspaceDir);
  assert.equal(binding.source, 'provider default');
  assert.equal('lastPrompt' in session, false);
  assert.equal('lastPromptAt' in session, false);
  assert.equal('processLines' in session, false);
});

test('createSessionStore adopts the real workspace for existing workspace-bound sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const realWorkspaceDir = path.join(workspaceRoot, 'parent-thread');
  fs.mkdirSync(realWorkspaceDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'child-thread': {
        provider: 'claude',
        workspaceDir: null,
        runnerSessionId: 'claude-session-1',
        codexThreadId: 'claude-session-1',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'claude',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    resolveSessionWorkspace: (provider, sessionId) => (
      provider === 'claude' && sessionId === 'claude-session-1' ? realWorkspaceDir : null
    ),
  });

  const session = store.getSession('child-thread');
  const workspaceDir = store.ensureWorkspace(session, 'child-thread');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.workspaceDir, realWorkspaceDir);
  assert.equal(workspaceDir, realWorkspaceDir);
  assert.equal(persisted.threads['child-thread'].workspaceDir, realWorkspaceDir);
});

test('createSessionStore backfills missing mode from defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'codex',
        runnerSessionId: 'sess-1',
        codexThreadId: 'sess-1',
        language: 'zh',
        onboardingEnabled: true,
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'dangerous',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.mode, 'dangerous');
  assert.equal(persisted.threads['thread-1'].mode, 'dangerous');
});

test('createSessionStore projects current provider state and preserves other provider buckets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        runnerSessionId: 'legacy-claude',
        codexThreadId: 'legacy-claude',
        model: 'legacy-model',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          codex: {
            runnerSessionId: 'sess-codex',
            codexThreadId: 'sess-codex',
            lastInputTokens: 111,
            model: 'gpt-5.3-codex',
            effort: 'high',
            compactStrategy: 'native',
            compactEnabled: true,
            compactThresholdTokens: 1000,
            nativeCompactTokenLimit: 1000,
            configOverrides: ['personality="concise"'],
          },
          claude: {
            runnerSessionId: 'sess-claude',
            codexThreadId: 'sess-claude',
            lastInputTokens: 222,
            model: 'sonnet',
            effort: 'medium',
            compactStrategy: 'hard',
            compactEnabled: true,
            compactThresholdTokens: 2000,
            nativeCompactTokenLimit: null,
            configOverrides: [],
          },
        },
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  session.model = 'claude-opus';
  session.lastObservedModel = 'claude-opus-5';
  store.saveDb();
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.runnerSessionId, 'sess-claude');
  assert.equal(session.model, 'claude-opus');
  assert.equal(persisted.threads['thread-1'].providers.claude.model, 'claude-opus');
  assert.equal(persisted.threads['thread-1'].providers.claude.lastObservedModel, 'claude-opus-5');
  assert.equal(persisted.threads['thread-1'].providers.codex.model, 'gpt-5.3-codex');
});

test('createSessionStore keeps canonical antigravity provider state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'antigravity',
        runnerSessionId: 'agy-conv-1',
        codexThreadId: 'agy-conv-1',
        model: 'Claude Opus 4.6 (Thinking)',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          antigravity: {
            runnerSessionId: 'agy-conv-1',
            codexThreadId: 'agy-conv-1',
            model: 'Claude Opus 4.6 (Thinking)',
          },
        },
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider: normalizeProviderWithAntigravity,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.provider, 'antigravity');
  assert.equal(session.runnerSessionId, 'agy-conv-1');
  assert.equal(session.model, 'Claude Opus 4.6 (Thinking)');
  assert.ok(persisted.threads['thread-1'].providers.antigravity);
  assert.equal(persisted.threads['thread-1'].providers.antigravity.runnerSessionId, 'agy-conv-1');
});

test('createSessionStore does not merge removed gemini provider state into antigravity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'antigravity',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          gemini: {
            runnerSessionId: 'old',
            codexThreadId: 'old',
            model: 'old-model',
          },
          antigravity: {
            runnerSessionId: 'new',
            codexThreadId: 'new',
            model: 'new-model',
          },
        },
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider: normalizeProviderWithAntigravity,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.provider, 'antigravity');
  assert.equal(session.runnerSessionId, 'new');
  assert.equal(session.model, 'new-model');
  assert.equal(persisted.threads['thread-1'].providers.antigravity.runnerSessionId, 'new');
  assert.equal(persisted.threads['thread-1'].providers.gemini, undefined);
  assert.equal(persisted.threads['thread-1'].providers.codex, undefined);
  assert.equal(persisted.threads['thread-1'].providerMigrationWarnings, undefined);
});

test('createSessionStore surfaces malformed state instead of replacing it with empty DB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, '{bad json', 'utf8');

  assert.throws(() => createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider: normalizeProviderWithAntigravity,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  }), /Failed to load session DB/);

  assert.equal(fs.readFileSync(dataFile, 'utf8'), '{bad json');
});

test('createSessionStore surfaces malformed compact thresholds without rewriting the session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const original = JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        compactThresholdTokens: 'broken',
      },
    },
    workspaceFavorites: {},
  }, null, 2);
  fs.writeFileSync(dataFile, original, 'utf8');

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  assert.throws(
    () => store.getSession('thread-1'),
    /invalid persisted compact threshold for claude/i,
  );
  assert.equal(fs.readFileSync(dataFile, 'utf8'), original);
});

test('createSessionStore preserves explicit and unset compact thresholds for every provider across reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const providers = ['codex', 'claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp'];
  const threads = {};
  for (const provider of providers) {
    for (const [suffix, compactThresholdTokens] of [['explicit', 272_000], ['default', null]]) {
      threads[`${provider}-${suffix}`] = {
        provider,
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        compactThresholdTokens,
      };
    }
  }
  fs.writeFileSync(dataFile, JSON.stringify({ threads, workspaceFavorites: {} }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider: normalizeAllProviders,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  for (const provider of providers) {
    assert.equal(store.getSession(`${provider}-explicit`).compactThresholdTokens, 272_000, provider);
    assert.equal(store.getSession(`${provider}-default`).compactThresholdTokens, null, provider);
  }
  store.saveDb();

  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  for (const provider of providers) {
    assert.equal(persisted.threads[`${provider}-explicit`].compactThresholdTokens, 272_000, provider);
    assert.equal(persisted.threads[`${provider}-explicit`].providers[provider].compactThresholdTokens, 272_000, provider);
    assert.equal(persisted.threads[`${provider}-default`].compactThresholdTokens, null, provider);
    assert.equal(persisted.threads[`${provider}-default`].providers[provider].compactThresholdTokens, null, provider);
  }
});

test('createSessionStore.saveDb preserves untouched provider buckets before a session is hydrated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const favoriteDir = path.join(root, 'favorite-workspace');
  fs.mkdirSync(favoriteDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        runnerSessionId: 'legacy-claude',
        codexThreadId: 'legacy-claude',
        model: 'legacy-model',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          claude: {
            runnerSessionId: 'sess-claude',
            codexThreadId: 'sess-claude',
            lastInputTokens: 222,
            model: 'sonnet',
            effort: 'medium',
            compactStrategy: 'hard',
            compactEnabled: true,
            compactThresholdTokens: 2000,
            nativeCompactTokenLimit: null,
            configOverrides: [],
          },
        },
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  store.addFavoriteWorkspace('codex', favoriteDir);
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(persisted.threads['thread-1'].providers.claude.runnerSessionId, 'sess-claude');
  assert.equal(persisted.threads['thread-1'].providers.claude.model, 'sonnet');
});

test('createSessionStore.listSessions hydrates provider-scoped state before saving list mutations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        runnerSessionId: 'legacy-claude',
        codexThreadId: 'legacy-claude',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          claude: {
            runnerSessionId: 'sess-claude',
            codexThreadId: 'sess-claude',
            lastInputTokens: 222,
            model: 'sonnet',
            effort: 'medium',
            compactStrategy: 'hard',
            compactEnabled: true,
            compactThresholdTokens: 2000,
            nativeCompactTokenLimit: null,
            configOverrides: [],
          },
        },
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const [{ session }] = store.listSessions({ provider: 'claude' });
  session.runnerSessionId = null;
  session.codexThreadId = null;
  store.saveDb();
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.runnerSessionId, null);
  assert.equal(persisted.threads['thread-1'].providers.claude.runnerSessionId, null);
});

test('createSessionStore persists provider-scoped workspace favorites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const favoriteA = path.join(root, 'repo-a');
  const favoriteB = path.join(root, 'repo-b');
  fs.mkdirSync(favoriteA, { recursive: true });
  fs.mkdirSync(favoriteB, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const addedA = store.addFavoriteWorkspace('codex', favoriteA);
  const addedB = store.addFavoriteWorkspace('codex', favoriteB);
  const duplicate = store.addFavoriteWorkspace('codex', favoriteA);

  assert.equal(addedA.changed, true);
  assert.equal(addedB.changed, true);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(store.listFavoriteWorkspaces({ provider: 'codex' }), [favoriteB, favoriteA]);

  const reloaded = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  assert.deepEqual(reloaded.listFavoriteWorkspaces({ provider: 'codex' }), [favoriteB, favoriteA]);

  const removed = reloaded.removeFavoriteWorkspace('codex', favoriteB);
  assert.equal(removed.changed, true);
  assert.deepEqual(reloaded.listFavoriteWorkspaces({ provider: 'codex' }), [favoriteA]);
});
