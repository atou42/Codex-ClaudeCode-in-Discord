import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunnerArgsBuilder, uniqueDirs } from '../src/runner-args.js';

process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = '/tmp/agents-in-discord-missing-openai-curated-marketplace';

test('uniqueDirs removes blanks and duplicates while keeping order', () => {
  assert.deepEqual(
    uniqueDirs([' /repo/a ', '', null, '/repo/b', '/repo/a', '  ', '/repo/b']),
    ['/repo/a', '/repo/b'],
  );
});

test('createRunnerArgsBuilder builds Antigravity args instead of codex args', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: session.model ? 'session override' : 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'antigravity',
    session: {
      provider: 'antigravity',
      mode: 'dangerous',
      model: 'Claude Opus 4.6 (Thinking)',
      runnerSessionId: 'sess-agy-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'summarize the repo',
  });

  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--conversation',
    'sess-agy-1',
    '--prompt',
    'summarize the repo',
  ]);
});

test('createRunnerArgsBuilder passes a selected Claude model to fresh and resumed runs', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model, source: 'session override' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  for (const runnerSessionId of [null, 'claude-session-1']) {
    const args = buildSessionRunnerArgs({
      provider: 'claude',
      session: {
        provider: 'claude',
        mode: 'dangerous',
        model: 'opus',
        runnerSessionId,
      },
      workspaceDir: '/tmp/workspace',
      prompt: 'inspect',
    });

    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  }
});

test('createRunnerArgsBuilder passes Claude native auto-compact settings to fresh and resumed runs', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: 'claude-fable-5-1', source: 'session override' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: (session) => ({
      tokens: session.nativeCompactTokenLimit ?? null,
      source: session.nativeCompactTokenLimit ? 'session override' : 'provider default',
    }),
  });

  for (const [runnerSessionId, nativeCompactTokenLimit, expected] of [
    [null, null, 'auto'],
    ['claude-session-1', 320000, '320000'],
  ]) {
    const args = buildSessionRunnerArgs({
      provider: 'claude',
      session: {
        provider: 'claude',
        mode: 'dangerous',
        runnerSessionId,
        nativeCompactTokenLimit,
      },
      workspaceDir: '/tmp/workspace',
      prompt: 'inspect',
    });

    assert.equal(args[args.indexOf('--autocompact') + 1], expected);
  }
});

test('createRunnerArgsBuilder builds sandboxed and dangerous Grok headless runs', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: 'session override' }),
    resolveReasoningEffortSetting: (session) => ({ value: session.effort || null, source: 'session override' }),
  });

  const safe = buildSessionRunnerArgs({
    provider: 'grok',
    session: {
      provider: 'grok',
      mode: 'safe',
      model: 'grok-4.5',
      effort: 'high',
      runnerSessionId: 'grok-session-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    promptFile: '/tmp/grok-prompt.txt',
    systemPrompt: 'discord context',
    inputImages: ['/tmp/input.png'],
  });
  assert.deepEqual(safe, [
    '--prompt-file', '/tmp/grok-prompt.txt',
    '--cwd', '/tmp/workspace',
    '--output-format', 'streaming-json',
    '--resume', 'grok-session-1',
    '--rules', 'discord context',
    '--model', 'grok-4.5',
    '--effort', 'high',
    '--always-approve',
    '--sandbox', 'workspace',
  ]);

  const dangerous = buildSessionRunnerArgs({
    provider: 'grok',
    session: { provider: 'grok', mode: 'dangerous', runnerSessionId: 'grok-session-1' },
    workspaceDir: '/tmp/workspace',
    prompt: 'continue',
    promptFile: '/tmp/grok-prompt.txt',
  });
  assert.equal(dangerous.includes('--always-approve'), true);
  assert.equal(dangerous.includes('--sandbox'), false);
  assert.equal(dangerous[dangerous.indexOf('--resume') + 1], 'grok-session-1');
});

test('createRunnerArgsBuilder builds fresh and resumed Cursor headless runs', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: 'session override' }),
  });

  const safe = buildSessionRunnerArgs({
    provider: 'cursor',
    session: {
      provider: 'cursor',
      mode: 'safe',
      model: 'gpt-5.6-sol-high',
      runnerSessionId: 'cursor-session-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    systemPrompt: 'discord context',
  });
  assert.deepEqual(safe, [
    '--print',
    '--output-format', 'stream-json',
    '--trust',
    '--workspace', '/tmp/workspace',
    '--resume', 'cursor-session-1',
    '--model', 'gpt-5.6-sol-high',
    '--auto-review',
    '--sandbox', 'enabled',
    'discord context\n\ninspect',
  ]);

  const dangerous = buildSessionRunnerArgs({
    provider: 'cursor',
    session: { provider: 'cursor', mode: 'dangerous', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'continue',
  });
  assert.deepEqual(dangerous, [
    '--print',
    '--output-format', 'stream-json',
    '--trust',
    '--workspace', '/tmp/workspace',
    '--force',
    '--sandbox', 'disabled',
    'continue',
  ]);
});

test('createRunnerArgsBuilder rejects Cursor image inputs instead of silently dropping them', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    normalizeProvider: (value) => value,
    getSessionId: () => null,
  });
  assert.throws(() => buildSessionRunnerArgs({
    provider: 'cursor',
    session: { provider: 'cursor', mode: 'safe' },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect image',
    inputImages: ['/tmp/input.png'],
  }), /does not expose native image input/);
});

test('createRunnerArgsBuilder keeps Pi and OMP resume syntax separate', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: 'session override' }),
    resolveReasoningEffortSetting: (session) => ({ value: session.effort || null, source: 'session override' }),
  });
  const common = {
    session: {
      mode: 'dangerous',
      model: 'anthropic/claude-sonnet-4',
      effort: 'high',
      runnerSessionId: '019abc-session',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    systemPrompt: 'discord context',
    additionalWorkspaceDirs: ['/tmp/shared'],
  };

  assert.deepEqual(buildSessionRunnerArgs({ provider: 'pi', ...common }), [
    '-p',
    '--mode', 'json',
    '--approve',
    '--model', 'anthropic/claude-sonnet-4',
    '--thinking', 'high',
    '--append-system-prompt', 'discord context',
    '--session', '019abc-session',
    'inspect',
  ]);
  assert.deepEqual(buildSessionRunnerArgs({ provider: 'omp', ...common }), [
    '-p',
    '--mode', 'json',
    '--approval-mode', 'yolo',
    '--model', 'anthropic/claude-sonnet-4',
    '--thinking', 'high',
    '--append-system-prompt', 'discord context',
    '--add-dir', '/tmp/shared',
    '--resume', '019abc-session',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder maps OMP fast overrides to service tier without affecting Pi', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: 'session override' }),
    resolveReasoningEffortSetting: (session) => ({ value: session.effort || null, source: 'session override' }),
    resolveFastModeSetting: (session) => ({
      enabled: session.effectiveFastMode,
      supported: session.provider === 'omp',
      serviceTier: session.effectiveFastMode ? 'priority' : 'none',
      source: session.fastModeSource,
    }),
  });
  const build = (provider, effectiveFastMode, fastModeSource) => buildSessionRunnerArgs({
    provider,
    session: {
      provider,
      mode: 'dangerous',
      model: 'ccswitch-newapi/gpt-5.6-sol',
      effort: 'high',
      effectiveFastMode,
      fastModeSource,
      runnerSessionId: null,
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  const enabled = build('omp', true, 'session override');
  assert.deepEqual(enabled.slice(enabled.indexOf('--service-tier'), enabled.indexOf('--service-tier') + 2), [
    '--service-tier',
    'priority',
  ]);

  const disabled = build('omp', false, 'parent channel');
  assert.deepEqual(disabled.slice(disabled.indexOf('--service-tier'), disabled.indexOf('--service-tier') + 2), [
    '--service-tier',
    'none',
  ]);

  const providerDefault = build('omp', false, 'provider default');
  assert.deepEqual(providerDefault.slice(providerDefault.indexOf('--service-tier'), providerDefault.indexOf('--service-tier') + 2), [
    '--service-tier',
    'none',
  ]);
  assert.equal(build('pi', true, 'session override').includes('--service-tier'), false);
});

test('createRunnerArgsBuilder adds native compact config for fresh codex sessions when enabled', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    codexModelContextWindow: 1_050_000,
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: true, source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 123456 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: ['foo="bar"'],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '-C',
    '/tmp/workspace',
    '--enable',
    'goals',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=true',
    '-c',
    'model_context_window=1050000',
    '-c',
    'model_auto_compact_token_limit=123456',
    '-c',
    'foo="bar"',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder keeps native compact config for resumed codex sessions', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    codexModelContextWindow: 1_050_000,
    normalizeProvider: (value) => value,
    getSessionId: () => 'sess-1',
    resolveFastModeSetting: () => ({ enabled: true, source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 123456 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: ['foo="bar"'],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '--enable',
    'goals',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=true',
    '-c',
    'model_context_window=1050000',
    '-c',
    'model_auto_compact_token_limit=123456',
    '-c',
    'foo="bar"',
    'sess-1',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder never passes the Codex context window to non-Codex providers', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    codexModelContextWindow: 1_050_000,
    normalizeProvider: (value) => value,
    getSessionId: () => null,
  });

  for (const provider of ['claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp']) {
    const args = buildSessionRunnerArgs({
      provider,
      session: { provider, mode: 'safe', configOverrides: [] },
      workspaceDir: '/tmp/workspace',
      prompt: 'inspect',
      promptFile: provider === 'grok' ? '/tmp/grok-prompt.txt' : '',
    });
    assert.equal(args.join(' ').includes('model_context_window'), false, provider);
    assert.equal(args.join(' ').includes('1050000'), false, provider);
  }
});

test('createRunnerArgsBuilder applies model-specific Codex context and compact limits', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    codexModelContextWindows: { 'gpt-5.6-sol': 1050000, 'gpt-5.6-luna': 1050000 },
    codexModelCompactTokenLimits: { 'gpt-5.6-sol': 400000, 'gpt-5.6-luna': 40000 },
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: (session) => ({ value: session.model, source: 'session override' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 400000, source: 'env default' }),
  });
  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: { provider: 'codex', mode: 'safe', model: 'gpt-5.6-luna', configOverrides: [] },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });
  assert.equal(args.includes('model_context_window=1050000'), true);
  assert.equal(args.includes('model_auto_compact_token_limit=40000'), true);
  assert.equal(args.includes('model_auto_compact_token_limit=400000'), false);
});

test('createRunnerArgsBuilder keeps the Codex compact threshold out of non-Codex provider args', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: (session) => ({
      tokens: session.provider === 'claude' ? null : 272_000,
    }),
  });

  for (const provider of ['claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp']) {
    const args = buildSessionRunnerArgs({
      provider,
      session: { provider, mode: 'safe', configOverrides: [] },
      workspaceDir: '/tmp/workspace',
      prompt: 'inspect',
      promptFile: provider === 'grok' ? '/tmp/grok-prompt.txt' : '',
    });
    assert.equal(args.join(' ').includes('272000'), false, provider);
    assert.equal(args.join(' ').includes('model_auto_compact_token_limit'), false, provider);
    if (provider === 'claude') {
      assert.equal(args[args.indexOf('--autocompact') + 1], 'auto');
    }
  }
});

test('createRunnerArgsBuilder passes native image inputs to codex exec', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    inputImages: ['/tmp/image-a.jpg', '/tmp/image-b.png'],
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '-C',
    '/tmp/workspace',
    '--enable',
    'goals',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=false',
    '--image',
    '/tmp/image-a.jpg',
    '--image',
    '/tmp/image-b.png',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder passes extra context to codex developer instructions', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]\nline two',
  });

  const systemIndex = args.indexOf('developer_instructions="[Via agents-in-discord; discord_thread=thread-1]\\nline two"');
  assert.notEqual(systemIndex, -1);
  assert.equal(args[systemIndex - 1], '-c');
  assert.equal(args.at(-1), 'inspect');
});

test('createRunnerArgsBuilder passes fast mode through when inherited from the parent channel', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'parent channel' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '-C',
    '/tmp/workspace',
    '--enable',
    'goals',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=false',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder uses inherited model and effort settings', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: 'gpt-5.4', source: 'parent channel' }),
    resolveCodexProfileSetting: () => ({ value: 'work', source: 'parent channel', valid: true, isExplicit: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high', source: 'parent channel' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '-C',
    '/tmp/workspace',
    '--enable',
    'goals',
    '--profile',
    'work',
    '-m',
    'gpt-5.4',
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'features.fast_mode=false',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder throws when the effective codex profile is invalid', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveCodexProfileSetting: () => ({
      value: 'missing-profile',
      source: 'session override',
      valid: false,
      isExplicit: true,
      error: 'missing in /tmp/codex-config.toml',
    }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  assert.throws(() => buildSessionRunnerArgs({
    provider: 'codex',
    session: { mode: 'safe', configOverrides: [] },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  }), /invalid Codex profile: missing-profile/);
});

test('createRunnerArgsBuilder explicitly disables fast mode when config.toml resolves to off', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: 'gpt-5-codex',
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'codex',
    session: {
      mode: 'safe',
      configOverrides: [],
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '-C',
    '/tmp/workspace',
    '--enable',
    'goals',
    '-m',
    'gpt-5-codex',
    '-c',
    'features.fast_mode=false',
    'inspect',
  ]);
});

test('createRunnerArgsBuilder uses claude dash-p for normal runtime args', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: 'high', source: 'session override' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'claude',
    session: {
      provider: 'claude',
      mode: 'dangerous',
      runnerSessionId: null,
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(args[0], '-p');
  assert.equal(args.includes('--print'), false);
  assert.equal(args.includes('--effort'), true);
  assert.equal(args.includes('high'), true);
  assert.equal(args.includes('--dangerously-skip-permissions'), true);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'hello');
});

test('createRunnerArgsBuilder passes extra context to Claude append-system-prompt', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: () => 'claude-session-1',
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'claude',
    session: {
      provider: 'claude',
      mode: 'safe',
      runnerSessionId: 'claude-session-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  const systemIndex = args.indexOf('--append-system-prompt');
  assert.notEqual(systemIndex, -1);
  assert.equal(args[systemIndex + 1], '[Via agents-in-discord; discord_thread=thread-1]');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'hello');
});

test('createRunnerArgsBuilder uses Claude fork-session from pending fork parent', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'claude',
    session: {
      provider: 'claude',
      mode: 'safe',
      runnerSessionId: 'child-session',
      pendingForkFromSessionId: 'parent-session',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'first fork turn',
  });

  assert.equal(args[args.indexOf('--resume') + 1], 'parent-session');
  assert.equal(args.includes('--fork-session'), true);
  assert.equal(args[args.indexOf('--session-id') + 1], 'child-session');
  assert.equal(args.at(-1), 'first fork turn');
});

test('createRunnerArgsBuilder resumes a Grok session already forked into its workspace', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'grok',
    session: {
      provider: 'grok',
      mode: 'safe',
      runnerSessionId: 'child-session',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'first fork turn',
    promptFile: '/tmp/grok-prompt.txt',
  });

  assert.equal(args[args.indexOf('--resume') + 1], 'child-session');
  assert.equal(args.includes('--fork-session'), false);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args[args.indexOf('--prompt-file') + 1], '/tmp/grok-prompt.txt');
  assert.equal(args.includes('first fork turn'), false);
});

test('createRunnerArgsBuilder falls back to prompt context for Antigravity', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const args = buildSessionRunnerArgs({
    provider: 'antigravity',
    session: {
      provider: 'antigravity',
      mode: 'safe',
      runnerSessionId: null,
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  assert.equal(args.at(-2), '--prompt');
  assert.equal(args.at(-1), '[Via agents-in-discord; discord_thread=thread-1]\n\nhello');
});

test('createRunnerArgsBuilder builds new and resumed ZCode prompts', () => {
  const { buildSessionRunnerArgs } = createRunnerArgsBuilder({
    defaultModel: null,
    normalizeProvider: (value) => value,
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider unsupported' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
  });

  const fresh = buildSessionRunnerArgs({
    provider: 'zcode',
    session: { provider: 'zcode', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
    inputImages: ['/tmp/input.png'],
  });
  assert.deepEqual(fresh, [
    '--prompt', '[Via agents-in-discord; discord_thread=thread-1]\n\nhello',
    '--attach', '/tmp/input.png',
    '--cwd', '/tmp/workspace',
    '--mode', 'edit',
    '--json',
    '--no-color',
  ]);

  const resumed = buildSessionRunnerArgs({
    provider: 'zcode',
    session: { provider: 'zcode', mode: 'dangerous', runnerSessionId: 'sess_zcode_1' },
    workspaceDir: '/tmp/workspace',
    prompt: 'continue',
  });
  assert.deepEqual(resumed, [
    '--prompt', 'continue',
    '--cwd', '/tmp/workspace',
    '--resume', 'sess_zcode_1',
    '--mode', 'yolo',
    '--json',
    '--no-color',
  ]);
});
