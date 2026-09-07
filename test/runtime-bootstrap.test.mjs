import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureRuntimeProxy,
  createDiscordClient,
  ensureDiscordWsProxyPatch,
  normalizeSlashPrefix,
  readAntigravityDefaults,
  readAntigravityModelCatalog,
  readClaudeDefaults,
  readCodexDefaults,
  readCodexModelCatalog,
  readCodexProfileCatalog,
  readClaudeModelCatalog,
  readCursorModelCatalog,
  readOmpDefaults,
  readPiFamilyModelCatalog,
  readProviderModelCatalog,
  renderMissingDiscordTokenHint,
  writeAntigravityModelSetting,
  writeCodexDefaults,
} from '../src/runtime-bootstrap.js';

test('readCursorModelCatalog parses the Cursor Agent model list', () => {
  const calls = [];
  const catalog = readCursorModelCatalog({
    cursorBin: '/tmp/cursor-agent-test-bin',
    now: () => 1,
    execFileSyncFn(bin, args, options) {
      calls.push({ bin, args, timeout: options.timeout });
      return [
        'Available models',
        '',
        'auto - Auto (default)',
        'gpt-5.6-sol-high - GPT-5.6 Sol 1M High',
        '',
        'Tip: use --model <id> to switch.',
      ].join('\n');
    },
  });

  assert.deepEqual(calls, [{ bin: '/tmp/cursor-agent-test-bin', args: ['models'], timeout: 30_000 }]);
  assert.deepEqual(catalog.models.map((model) => [model.slug, model.displayName]), [
    ['auto', 'Auto (default)'],
    ['gpt-5.6-sol-high', 'GPT-5.6 Sol 1M High'],
  ]);
  assert.equal(catalog.error, null);
});

test('readCursorModelCatalog exposes Fable 5.1 high with the standard 300k context', () => {
  const catalog = readCursorModelCatalog({
    cursorBin: '/tmp/cursor-agent-fable-test-bin',
    now: () => 2,
    execFileSyncFn() {
      return [
        'Available models',
        '',
        'claude-fable-5-1-thinking-high - Claude Fable 5.1 1M Thinking (NO ZDR)',
      ].join('\n');
    },
  });

  assert.deepEqual(catalog.models[0], {
    slug: 'claude-fable-5-1[context=300k,effort=high]',
    displayName: 'Claude Fable 5.1 300k Thinking High',
    description: 'Cursor Agent standard-context Fable 5.1',
    defaultReasoningLevel: 'high',
    supportedReasoningLevels: ['high'],
    visibility: 'catalog',
  });
  assert.equal(catalog.models[1].slug, 'claude-fable-5-1-thinking-high');
});

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-runtime-bootstrap-'));
}

test('readCodexDefaults reads model reasoning effort and keeps fast mode on by default', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['model = "o3"', 'model_reasoning_effort = "high"', '[features]', 'fast_mode = true'].join('\n'),
  );

  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    modelConfigured: true,
    effort: 'high',
    effortConfigured: true,
    fastMode: true,
    fastModeConfigured: true,
  });

  fs.writeFileSync(
    configPath,
    ['model = "o3"', 'model_reasoning_effort = "high"', '[features]'].join('\n'),
  );
  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    modelConfigured: true,
    effort: 'high',
    effortConfigured: true,
    fastMode: true,
    fastModeConfigured: false,
  });

  fs.writeFileSync(
    configPath,
    ['model = "o3"', 'model_reasoning_effort = "high"', '[features]', 'fast_mode = false'].join('\n'),
  );
  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    modelConfigured: true,
    effort: 'high',
    effortConfigured: true,
    fastMode: false,
    fastModeConfigured: true,
  });

  assert.deepEqual(readCodexDefaults({ env: { HOME: path.join(rootDir, 'missing') } }), {
    model: null,
    modelConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  });
});

test('writeCodexDefaults updates codex config defaults and can clear back to built-in/provider defaults', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');

  fs.writeFileSync(
    configPath,
    [
      'model_provider = "tabcode"',
      '[features]',
      'unified_exec = true',
      'fast_mode = false',
    ].join('\n'),
  );

  let defaults = writeCodexDefaults({
    env: { HOME: homeDir },
    model: 'gpt-5.4',
    effort: 'xhigh',
    fastMode: true,
  });

  assert.deepEqual(defaults, {
    model: 'gpt-5.4',
    modelConfigured: true,
    effort: 'xhigh',
    effortConfigured: true,
    fastMode: true,
    fastModeConfigured: true,
  });
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^model = "gpt-5\.4"$/m);
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^model_reasoning_effort = "xhigh"$/m);
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^\[features\]$/m);
  assert.match(fs.readFileSync(configPath, 'utf-8'), /^fast_mode = true$/m);

  defaults = writeCodexDefaults({
    env: { HOME: homeDir },
    model: null,
    effort: null,
    fastMode: null,
  });

  assert.deepEqual(defaults, {
    model: null,
    modelConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  });
  const raw = fs.readFileSync(configPath, 'utf-8');
  assert.doesNotMatch(raw, /^model = /m);
  assert.doesNotMatch(raw, /^model_reasoning_effort = /m);
  assert.doesNotMatch(raw, /^fast_mode = /m);
  assert.match(raw, /^\[features\]$/m);
});

test('writeCodexDefaults trims string inputs and clears blank string values', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');

  const defaults = writeCodexDefaults({
    env: { HOME: homeDir },
    model: '  gpt-5.4  ',
    effort: '   ',
  });

  assert.deepEqual(defaults, {
    model: 'gpt-5.4',
    modelConfigured: true,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  });

  const raw = fs.readFileSync(configPath, 'utf-8');
  assert.match(raw, /^model = "gpt-5\.4"$/m);
  assert.doesNotMatch(raw, /^model_reasoning_effort = /m);
});

test('readCodexProfileCatalog reads named codex profiles from config.toml', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');

  fs.writeFileSync(configPath, [
    'model = "gpt-5.4"',
    '',
    '[profiles.default_work]',
    'model = "gpt-5.4"',
    '',
    '[profiles."vision qa"]',
    'model = "gpt-5.4-mini"',
    '',
    '[profiles.default_work]',
    'model = "o3"',
  ].join('\n'));

  assert.deepEqual(readCodexProfileCatalog({ env: { HOME: homeDir } }), {
    profiles: ['default_work', 'vision qa'],
    configPath,
  });
});

test('readCodexModelCatalog reads Codex CLI model catalog', () => {
  const catalog = readCodexModelCatalog({
    codexBin: 'codex-test',
    now: () => 1000,
    execFileSyncFn(bin, args) {
      assert.equal(bin, 'codex-test');
      assert.deepEqual(args, ['debug', 'models']);
      return JSON.stringify({
        models: [{
          slug: 'gpt-5.4',
          display_name: 'gpt-5.4',
          description: 'Strong model',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
          ],
          visibility: 'list',
        }],
      });
    },
  });

  assert.deepEqual(catalog, {
    models: [{
      slug: 'gpt-5.4',
      displayName: 'gpt-5.4',
      description: 'Strong model',
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'medium', 'high'],
      visibility: 'list',
    }],
    error: null,
  });
});

test('readCodexModelCatalog reports CLI catalog errors', () => {
  const catalog = readCodexModelCatalog({
    codexBin: 'codex-fail',
    now: () => 2000,
    execFileSyncFn() {
      throw new Error('codex debug models failed');
    },
  });

  assert.deepEqual(catalog, {
    models: [],
    error: 'codex debug models failed',
  });
});

test('readClaudeModelCatalog reads aliases and effort levels from Claude CLI help', () => {
  const homeDir = path.join(makeTempRoot(), 'home');
  const catalog = readClaudeModelCatalog({
    claudeBin: 'claude-test',
    env: { HOME: homeDir },
    now: () => 3000,
    execFileSyncFn(bin, args) {
      assert.equal(bin, 'claude-test');
      assert.deepEqual(args, ['--help']);
      return [
        "--effort <level>    Effort level for the current session (low, medium, high)",
        "--model <model>     Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').",
      ].join('\n');
    },
  });

  assert.deepEqual(catalog, {
    models: [
      {
        slug: 'sonnet',
        displayName: 'sonnet',
        description: 'Claude Code model alias from CLI help',
        defaultReasoningLevel: null,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        visibility: 'help',
      },
      {
        slug: 'opus',
        displayName: 'opus',
        description: 'Claude Code model alias from CLI help',
        defaultReasoningLevel: null,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        visibility: 'help',
      },
      {
        slug: 'claude-sonnet-4-6',
        displayName: 'claude-sonnet-4-6',
        description: 'Claude Code full model name from CLI help',
        defaultReasoningLevel: null,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        visibility: 'help',
      },
    ],
    error: null,
  });
});

test('readClaudeModelCatalog reads wrapped Claude help and configured local model names', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
    model: null,
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'claude-opus-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    },
  }));

  const catalog = readClaudeModelCatalog({
    claudeBin: 'claude-test-wrapped',
    env: { HOME: homeDir },
    now: () => 3100,
    execFileSyncFn() {
      return [
        '  --effort <level>                      Effort level for the current session',
        '                                        (low, medium, high, xhigh, max)',
        '  --model <model>                       Model for the current session. Provide',
        '                                        an alias for the latest model (e.g.',
        "                                        'fable', 'opus', or 'sonnet') or a",
        '                                        model\'s full name (e.g.',
        "                                        'claude-fable-5').",
        '  -n, --name <name>                     Set a display name for this session',
      ].join('\n');
    },
  });

  assert.deepEqual(catalog.models.map((model) => model.slug), [
    'fable',
    'opus',
    'sonnet',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-6',
  ]);
  assert.deepEqual(catalog.models[0].supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(catalog.models.find((model) => model.slug === 'claude-opus-5')?.visibility, 'settings');
  assert.equal(catalog.error, null);
});

test('readClaudeDefaults reads ~/.claude/settings.json and reports malformed settings', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    },
    model: 'fable',
  }));

  assert.deepEqual(readClaudeDefaults({ env: { HOME: homeDir } }), {
    model: 'fable',
    modelConfigured: true,
    profile: null,
    profileConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: false,
    fastModeConfigured: false,
    source: 'settings.json',
    settingsPath,
    error: null,
  });

  fs.writeFileSync(settingsPath, '{not json');
  const malformed = readClaudeDefaults({ env: { HOME: homeDir } });
  assert.equal(malformed.model, null);
  assert.equal(malformed.modelConfigured, false);
  assert.equal(malformed.source, 'settings.json');
  assert.equal(malformed.settingsPath, settingsPath);
  assert.match(String(malformed.error || ''), /json|property name|position/i);
});

test('readAntigravityDefaults reads settings.json and reports malformed settings', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    colorScheme: 'dark',
    model: 'Claude Opus 4.6 (Thinking)',
  }));

  assert.deepEqual(readAntigravityDefaults({ env: { HOME: homeDir } }), {
    model: 'Claude Opus 4.6 (Thinking)',
    modelConfigured: true,
    profile: null,
    profileConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: false,
    fastModeConfigured: false,
    source: 'settings.json',
    settingsPath,
    error: null,
  });

  fs.writeFileSync(settingsPath, '{bad json');
  const malformed = readAntigravityDefaults({ env: { HOME: homeDir } });
  assert.equal(malformed.model, null);
  assert.equal(malformed.source, 'settings.json');
  assert.match(malformed.error, /Unexpected token|Expected property name/i);
});

test('writeAntigravityModelSetting preserves settings and rejects malformed settings', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    colorScheme: 'dark',
    enableTelemetry: false,
    model: 'Gemini 3.5 Flash (High)',
  }));

  const defaults = writeAntigravityModelSetting({
    env: { HOME: homeDir },
    model: 'Claude Opus 4.6 (Thinking)',
  });
  assert.equal(defaults.model, 'Claude Opus 4.6 (Thinking)');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
    colorScheme: 'dark',
    enableTelemetry: false,
    model: 'Claude Opus 4.6 (Thinking)',
  });

  writeAntigravityModelSetting({ env: { HOME: homeDir }, model: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
    colorScheme: 'dark',
    enableTelemetry: false,
  });

  fs.writeFileSync(settingsPath, '{bad json');
  assert.throws(
    () => writeAntigravityModelSetting({ env: { HOME: homeDir }, model: 'Gemini 3.5 Flash (High)' }),
    /Unexpected token|Expected property name/i,
  );
});

test('readAntigravityModelCatalog lists configured documented and recently observed models', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const agyDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  const logDir = path.join(agyDir, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({
    model: 'Claude Opus 4.6 (Thinking)',
  }));
  fs.writeFileSync(path.join(logDir, 'cli-1.log'), [
    'I model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (High)"',
    'I model_resolver.go:227] Resolving model Claude Opus 4.6 (Thinking)',
  ].join('\n'));

  const catalog = readAntigravityModelCatalog({
    env: { HOME: homeDir },
    now: () => 10_000,
    ttlMs: 0,
  });

  assert.deepEqual(catalog, {
    models: [
      {
        slug: 'Claude Opus 4.6 (Thinking)',
        displayName: 'Claude Opus 4.6 (Thinking)',
        description: 'Antigravity configured model from settings.json',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'settings',
      },
      {
        slug: 'Gemini 3.5 Flash',
        displayName: 'Gemini 3.5 Flash',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3.1 Pro (High)',
        displayName: 'Gemini 3.1 Pro (High)',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3.1 Pro (Low)',
        displayName: 'Gemini 3.1 Pro (Low)',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3 Flash',
        displayName: 'Gemini 3 Flash',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Claude Sonnet 4.6 (Thinking)',
        displayName: 'Claude Sonnet 4.6 (Thinking)',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'GPT-OSS-120B',
        displayName: 'GPT-OSS-120B',
        description: 'Antigravity documented reasoning model',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'documented',
      },
      {
        slug: 'Gemini 3.5 Flash (High)',
        displayName: 'Gemini 3.5 Flash (High)',
        description: 'Antigravity model observed in local CLI logs',
        defaultReasoningLevel: null,
        supportedReasoningLevels: [],
        visibility: 'logs',
      },
    ],
    error: null,
  });
});

test('readProviderModelCatalog dispatches Claude Antigravity and unknown providers', () => {
  const claude = readProviderModelCatalog({
    provider: 'claude',
    claudeBin: 'claude-provider-test',
    now: () => 4000,
    execFileSyncFn() {
      return "--model <model> (e.g. 'sonnet')";
    },
  });
  assert.equal(claude.models[0].slug, 'sonnet');

  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const settingsDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
    model: 'Claude Opus 4.6 (Thinking)',
  }));
  const antigravity = readProviderModelCatalog({
    provider: 'antigravity',
    env: { HOME: homeDir },
    now: () => 5000,
    ttlMs: 0,
  });
  assert.equal(antigravity.models[0].slug, 'Claude Opus 4.6 (Thinking)');

  assert.deepEqual(readProviderModelCatalog({ provider: 'unknown' }), { models: [], error: null });
});

test('normalizeSlashPrefix trims strips and truncates invalid input', () => {
  assert.equal(normalizeSlashPrefix('  Codex-Bot__Alpha!!  '), 'codexbot__al');
  assert.equal(normalizeSlashPrefix('___'), '');
  assert.equal(normalizeSlashPrefix(''), '');
});

test('renderMissingDiscordTokenHint explains provider-scoped and shared token states', () => {
  assert.equal(
    renderMissingDiscordTokenHint({ botProvider: 'antigravity', env: {} }),
    'Missing Discord token in environment (DISCORD_TOKEN_ANTIGRAVITY or DISCORD_TOKEN)',
  );
  assert.match(
    renderMissingDiscordTokenHint({
      env: {
        CODEX__DISCORD_TOKEN: 'a',
        ANTIGRAVITY__DISCORD_TOKEN: 'b',
      },
    }),
    /Found provider-scoped tokens for: codex, antigravity/,
  );
  assert.equal(
    renderMissingDiscordTokenHint({ env: {} }),
    'Missing DISCORD_TOKEN in environment',
  );
});

test('configureRuntimeProxy wires repaired proxy settings into agents and logs', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    SOCKS_PROXY: 'socks5h://127.0.0.1:7891',
    INSECURE_TLS: '1',
  };
  const globalTarget = {};
  const dispatcherCalls = [];
  const repairs = [];

  const result = configureRuntimeProxy({
    env,
    envFilePath: '/tmp/.env',
    autoRepairProxyEnvFn: (envFilePath, options) => {
      repairs.push({ envFilePath, options });
      return { logs: ['proxy repaired'] };
    },
    createHttpProxyAgent: (uri) => ({ kind: 'http', uri }),
    createHttpsProxyAgent: (uri) => ({ kind: 'https', uri }),
    createSocksProxyAgent: (uri) => ({ kind: 'socks', uri }),
    setGlobalDispatcherFn: (agent) => dispatcherCalls.push(agent),
    globalTarget,
  });

  assert.equal(repairs[0].envFilePath, '/tmp/.env');
  assert.equal(repairs[0].options.env, env);
  assert.deepEqual(result.restProxyAgent, { kind: 'http', uri: 'http://127.0.0.1:7890' });
  assert.deepEqual(result.wsProxyAgent, { kind: 'socks', uri: 'socks5h://127.0.0.1:7891' });
  assert.deepEqual(dispatcherCalls, [{ kind: 'http', uri: 'http://127.0.0.1:7890' }]);
  assert.equal(globalTarget.__discordWsAgent, result.wsProxyAgent);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.deepEqual(result.logs, [
    'proxy repaired',
    '🌐 Proxy: REST=http://127.0.0.1:7890 | WS=socks5h://127.0.0.1:7891 | INSECURE_TLS=true',
  ]);
});

test('configureRuntimeProxy can force Discord WebSocket through HTTP proxy', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    DISCORD_WS_PROXY: 'http://127.0.0.1:7890',
  };
  const globalTarget = {};

  const result = configureRuntimeProxy({
    env,
    autoRepairProxyEnvFn: () => ({ logs: [] }),
    createHttpProxyAgent: (uri) => ({ kind: 'http', uri }),
    createHttpsProxyAgent: (uri) => ({ kind: 'https', uri }),
    createSocksProxyAgent: (uri) => ({ kind: 'socks', uri }),
    setGlobalDispatcherFn: () => {},
    globalTarget,
  });

  assert.deepEqual(result.restProxyAgent, { kind: 'http', uri: 'http://127.0.0.1:7890' });
  assert.deepEqual(result.wsProxyAgent, { kind: 'https', uri: 'http://127.0.0.1:7890' });
  assert.equal(globalTarget.__discordWsAgent, result.wsProxyAgent);
  assert.deepEqual(result.logs, [
    '🌐 Proxy: REST=http://127.0.0.1:7890 | WS=http://127.0.0.1:7890 | INSECURE_TLS=false',
  ]);
});

test('ensureDiscordWsProxyPatch injects the Discord WebSocket proxy agent once', () => {
  const rootDir = makeTempRoot();
  const targetPath = path.join(rootDir, 'node_modules', '@discordjs', 'ws', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    'const connection = new WebSocketConstructor(url, [], { handshakeTimeout: 30_000 });\n',
  );

  const first = ensureDiscordWsProxyPatch({ rootDir });
  const second = ensureDiscordWsProxyPatch({ rootDir });
  const patched = fs.readFileSync(targetPath, 'utf8');

  assert.equal(first.status, 'patched');
  assert.equal(second.status, 'already_patched');
  assert.match(patched, /agent: globalThis\.__discordWsAgent, handshakeTimeout: 30_000/);
});

test('createDiscordClient applies Discord intents and optional REST proxy agent', () => {
  class FakeClient {
    constructor(options) {
      this.options = options;
      this.rest = {
        setAgent: (agent) => {
          this.agent = agent;
        },
      };
    }
  }

  const restProxyAgent = { kind: 'proxy' };
  const buildGatewayStrategy = () => {};
  const client = createDiscordClient({
    Client: FakeClient,
    GatewayIntentBits: {
      Guilds: 'guilds',
      GuildMessages: 'messages',
      MessageContent: 'content',
    },
    Partials: {
      Channel: 'channel',
      Message: 'message',
    },
    restProxyAgent,
    buildGatewayStrategy,
  });

  assert.deepEqual(client.options.intents, ['guilds', 'messages', 'content']);
  assert.deepEqual(client.options.partials, ['channel', 'message']);
  assert.equal(client.agent, restProxyAgent);
  assert.equal(client.options.ws.buildStrategy, buildGatewayStrategy);
});

test('readPiFamilyModelCatalog reads models from the CLI JSON catalog', () => {
  const calls = [];
  const catalog = readPiFamilyModelCatalog({
    provider: 'omp',
    bin: '/usr/local/bin/omp',
    execFileSyncFn: (bin, args) => {
      calls.push({ bin, args });
      return JSON.stringify({
        models: [
          {
            provider: 'openai-codex',
            id: 'gpt-5.6-sol',
            selector: 'openai-codex/gpt-5.6-sol',
            name: 'GPT-5.6-Sol',
            thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
          {
            provider: 'zenmux',
            id: 'glm-5',
            selector: 'zenmux/glm-5',
            name: 'GLM-5',
            thinking: ['auto', 'bogus-level'],
          },
        ],
      });
    },
    now: () => 1_000,
  });

  assert.deepEqual(calls, [{ bin: '/usr/local/bin/omp', args: ['models', '--json'] }]);
  assert.equal(catalog.error, null);
  assert.deepEqual(catalog.models.map((model) => model.slug), [
    'openai-codex/gpt-5.6-sol',
    'zenmux/glm-5',
  ]);
  assert.equal(catalog.models[0].displayName, 'GPT-5.6-Sol');
  assert.deepEqual(catalog.models[0].supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  // Unknown thinking levels are dropped so the panel cannot offer an unsettable value.
  assert.deepEqual(catalog.models[1].supportedReasoningLevels, ['auto']);
});

test('readOmpDefaults reads and validates the configured OpenAI service tier', () => {
  const calls = [];
  const defaults = readOmpDefaults({
    ompBin: '/usr/local/bin/omp',
    execFileSyncFn: (bin, args) => {
      calls.push({ bin, args });
      return JSON.stringify({ key: 'tier.openai', value: 'priority', type: 'enum' });
    },
    now: () => 1_000,
  });

  assert.deepEqual(calls, [{
    bin: '/usr/local/bin/omp',
    args: ['config', 'get', 'tier.openai', '--json'],
  }]);
  assert.deepEqual(defaults, {
    serviceTier: 'priority',
    fastMode: true,
    source: 'OMP config',
  });
  assert.throws(() => readOmpDefaults({
    ompBin: '/usr/local/bin/omp-invalid-tier',
    execFileSyncFn: () => JSON.stringify({ key: 'tier.openai', value: 'unexpected' }),
    now: () => 2_000,
  }), /invalid tier\.openai/);
});

test('readPiFamilyModelCatalog caches per provider and reports failures', () => {
  let callCount = 0;
  const execFileSyncFn = () => {
    callCount += 1;
    return JSON.stringify({ models: [{ id: 'gpt-5.6-sol', selector: 'openai-codex/gpt-5.6-sol' }] });
  };

  const first = readPiFamilyModelCatalog({ provider: 'pi', bin: 'pi-cached', execFileSyncFn, now: () => 5_000 });
  const second = readPiFamilyModelCatalog({ provider: 'pi', bin: 'pi-cached', execFileSyncFn, now: () => 5_100 });
  assert.equal(callCount, 1);
  assert.deepEqual(first.models, second.models);

  const failed = readPiFamilyModelCatalog({
    provider: 'omp',
    bin: 'omp-missing',
    execFileSyncFn: () => { throw new Error('spawn omp-missing ENOENT'); },
    now: () => 6_000,
  });
  assert.deepEqual(failed.models, []);
  assert.match(failed.error, /ENOENT/);

  const unparseable = readPiFamilyModelCatalog({
    provider: 'omp',
    bin: 'omp-garbage',
    execFileSyncFn: () => 'not json',
    now: () => 7_000,
  });
  assert.deepEqual(unparseable.models, []);
  assert.match(unparseable.error, /unparseable/);
});

test('readProviderModelCatalog routes pi and omp to the Pi-family reader', () => {
  const bins = [];
  const read = (provider) => readProviderModelCatalog({
    provider,
    piBin: 'pi-routed',
    ompBin: 'omp-routed',
    execFileSyncFn: (bin) => {
      bins.push(bin);
      return JSON.stringify({ models: [{ selector: `${provider}/model-a` }] });
    },
    now: () => Date.now() + Math.random(),
    ttlMs: 0,
  });

  assert.deepEqual(read('pi').models.map((m) => m.slug), ['pi/model-a']);
  assert.deepEqual(read('omp').models.map((m) => m.slug), ['omp/model-a']);
  assert.deepEqual(bins, ['pi-routed', 'omp-routed']);
});

const invalidCodexCatalogs = [
  ['null root', null, /models.*array/i],
  ['array root', [], /models.*array/i],
  ['missing models', {}, /models.*array/i],
  ['null models', { models: null }, /models.*array/i],
  ['object models', { models: {} }, /models.*array/i],
  ['missing slug', { models: [{}] }, /models\[0\].slug/i],
  ['blank slug', { models: [{ slug: '  ' }] }, /models\[0\].slug/i],
  ['numeric slug', { models: [{ slug: 123 }] }, /models\[0\].slug/i],
  ['null item', { models: [null] }, /models\[0\].slug/i],
  ['array item', { models: [[]] }, /models\[0\].slug/i],
  ['mixed valid and bad items', { models: [{ slug: 'valid-one' }, {}] }, /models\[1\].slug/i],
];
for (const [label, payload, reason] of invalidCodexCatalogs) {
  test(`readCodexModelCatalog rejects ${label} without presenting a partial directory`, () => {
    let calls = 0;
    const result = readCodexModelCatalog({
      codexBin: `catalog-shape-${label}`, env: {}, ttlMs: 0,
      execFileSyncFn(bin, args, options) {
        calls += 1;
        assert.equal(bin, `catalog-shape-${label}`);
        assert.deepEqual(args, ['debug', 'models']);
        assert.equal(options.timeout, 5000);
        assert.deepEqual(options.env, {});
        return JSON.stringify(payload);
      },
    });
    assert.equal(calls, 1);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, reason);
    assert.deepEqual(result.models, []);
  });
}

test('readCodexModelCatalog preserves a structurally valid zero-model response', () => {
  const result = readCodexModelCatalog({ codexBin: 'catalog-valid-empty', env: {}, ttlMs: 0,
    execFileSyncFn: () => JSON.stringify({ models: [] }) });
  assert.deepEqual(result, { models: [], error: null });
});

test('readCodexModelCatalog retains both valid models and optional-field compatibility', () => {
  const result = readCodexModelCatalog({ codexBin: 'catalog-valid-two', env: {}, ttlMs: 0,
    execFileSyncFn: () => JSON.stringify({ models: [
      { slug: ' first ', display_name: 'First', description: 'first model', visibility: 'list',
        default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'second', displayName: 'Second', supported_reasoning_levels: null },
    ] }) });
  assert.equal(result.error, null);
  assert.deepEqual(result.models, [
    { slug: 'first', displayName: 'First', description: 'first model', visibility: 'list',
      defaultReasoningLevel: 'high', supportedReasoningLevels: ['low', 'high'] },
    { slug: 'second', displayName: 'Second', description: '', visibility: '',
      defaultReasoningLevel: null, supportedReasoningLevels: [] },
  ]);
});

for (const [label, response] of [
  ['timeout', () => { throw Object.assign(new Error('catalog command timed out'), { code: 'ETIMEDOUT' }); }],
  ['nonzero exit', () => { throw Object.assign(new Error('catalog exited 7'), { status: 7 }); }],
  ['invalid JSON', () => '{incomplete'],
]) {
  test(`readCodexModelCatalog exposes ${label} from the injected CLI executor`, () => {
    const result = readCodexModelCatalog({ codexBin: `catalog-cli-${label}`, env: {}, ttlMs: 0, execFileSyncFn: response });
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.deepEqual(result.models, []);
  });
}

test('readCodexModelCatalog retains cache policy and recovers after a malformed response expires', () => {
  let time = 0;
  let calls = 0;
  const options = { codexBin: 'catalog-recovery-cache', env: {}, now: () => time, ttlMs: 100,
    execFileSyncFn: () => { calls += 1; return JSON.stringify(calls === 1 ? {} : { models: [{ slug: 'first' }, { slug: 'second' }] }); } };
  const broken = readCodexModelCatalog(options);
  assert.match(broken.error, /models.*array/i);
  time = 99;
  assert.equal(readCodexModelCatalog(options), broken);
  assert.equal(calls, 1);
  time = 100;
  const healthy = readCodexModelCatalog(options);
  assert.equal(healthy.error, null);
  assert.deepEqual(healthy.models.map(({ slug }) => slug), ['first', 'second']);
  assert.equal(calls, 2);
});
