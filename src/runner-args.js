import { randomUUID } from 'node:crypto';
import { buildCodexPermissionArgs } from './codex-permissions.js';
import { buildCodexOpenAICuratedMarketplaceArgs } from './codex-marketplaces.js';
import { createClaudeProviderAdapter } from './providers/claude.js';
import { createCodexProviderAdapter } from './providers/codex.js';
import { createCursorProviderAdapter } from './providers/cursor.js';
import { createGrokProviderAdapter } from './providers/grok.js';
import { createAntigravityProviderAdapter } from './providers/antigravity.js';
import { createZCodeProviderAdapter } from './providers/zcode.js';
import { createPiProviderAdapter } from './providers/pi.js';
import { createOmpProviderAdapter } from './providers/omp.js';
import { createProviderAdapterRegistry } from './providers/index.js';

export function uniqueDirs(dirs = []) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const key = String(dir || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function composePromptWithSystemFallback(prompt, systemPrompt) {
  const systemText = String(systemPrompt || '').trim();
  if (!systemText) return prompt;
  return [
    systemText,
    '',
    String(prompt || ''),
  ].join('\n');
}

function matchesContextModel(model, targetModel) {
  const target = String(targetModel || '').trim();
  return !target || String(model || '').trim().toLowerCase() === target.toLowerCase();
}

function modelLimit(map, model) {
  if (!map || typeof map !== 'object') return null;
  const key = String(model || '').trim().toLowerCase();
  const entry = Object.entries(map).find(([name]) => String(name).trim().toLowerCase() === key);
  return entry ? entry[1] : null;
}

export function createRunnerArgsBuilder({
  defaultModel = null,
  codexModelContextWindow = null,
  codexModelContextWindowModel = null,
  codexModelContextWindows = null,
  codexModelCompactTokenLimits = null,
  codexModelCatalogJson = null,
  normalizeProvider = (value) => String(value || '').trim().toLowerCase(),
  getSessionId = () => null,
  resolveModelSetting = () => ({ value: defaultModel, source: 'provider' }),
  resolveCodexProfileSetting = () => ({ value: null, source: 'provider default', valid: true, isExplicit: false }),
  resolveReasoningEffortSetting = () => ({ value: null, source: 'provider' }),
  resolveFastModeSetting = () => ({ enabled: false, source: 'provider unsupported' }),
  resolveCompactStrategySetting = () => ({ strategy: 'native' }),
  resolveCompactEnabledSetting = () => ({ enabled: false }),
  resolveNativeCompactTokenLimitSetting = () => ({ tokens: 0 }),
} = {}) {
  const providerAdapters = createProviderAdapterRegistry([
    createCodexProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) => buildCodexArgs({
        session,
        workspaceDir,
        prompt,
        inputImages,
        systemPrompt,
      }),
    }),
    createClaudeProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, additionalWorkspaceDirs = [], systemPrompt = '' }) => buildClaudeArgs({
        session,
        workspaceDir,
        prompt,
        additionalWorkspaceDirs,
        systemPrompt,
      }),
    }),
    createCursorProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) => buildCursorArgs({
        session,
        workspaceDir,
        prompt,
        inputImages,
        systemPrompt,
      }),
    }),
    createGrokProviderAdapter({
      buildArgs: ({ session, workspaceDir, promptFile, systemPrompt = '' }) => buildGrokArgs({
        session,
        workspaceDir,
        promptFile,
        systemPrompt,
      }),
    }),
    createAntigravityProviderAdapter({
      buildArgs: ({ session, prompt, systemPrompt = '' }) => buildAntigravityArgs({ session, prompt, systemPrompt }),
    }),
    createZCodeProviderAdapter({
      buildArgs: ({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) => buildZCodeArgs({
        session,
        workspaceDir,
        prompt,
        inputImages,
        systemPrompt,
      }),
    }),
    createPiProviderAdapter({
      buildArgs: (options) => buildPiFamilyArgs({ ...options, provider: 'pi' }),
    }),
    createOmpProviderAdapter({
      buildArgs: (options) => buildPiFamilyArgs({ ...options, provider: 'omp' }),
    }),
  ]);

  function buildSessionRunnerArgs({
    provider,
    session,
    workspaceDir,
    prompt,
    additionalWorkspaceDirs = [],
    inputImages = [],
    systemPrompt = '',
    promptFile = '',
  }) {
    const adapter = providerAdapters.get(provider);
    return adapter.runtime.buildArgs({
      session,
      workspaceDir,
      prompt,
      additionalWorkspaceDirs,
      inputImages,
      systemPrompt,
      promptFile,
    });
  }

  function buildCodexArgs({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) {
    const sessionId = getSessionId(session);
    const permissionArgs = buildCodexPermissionArgs(session.mode, { resume: Boolean(sessionId) });
    const model = resolveModelSetting(session).value || defaultModel;
    const codexProfile = resolveCodexProfileSetting(session);
    const effort = resolveReasoningEffortSetting(session).value;
    const fastMode = resolveFastModeSetting(session);
    const extraConfigs = session.configOverrides || [];
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
    const systemText = String(systemPrompt || '').trim();
    const shouldPassFastMode = fastMode.source === 'session override'
      || fastMode.source === 'parent channel'
      || fastMode.enabled === false;

    const common = ['--enable', 'goals', ...buildCodexOpenAICuratedMarketplaceArgs()];
    if (codexModelCatalogJson) {
      common.push('-c', `model_catalog_json=${tomlString(codexModelCatalogJson)}`);
    }
    if (systemText) common.push('-c', `developer_instructions=${tomlString(systemText)}`);
    if (codexProfile?.isExplicit) {
      if (!codexProfile.valid) {
        throw new Error(`invalid Codex profile: ${codexProfile.value} (${codexProfile.error || 'unknown error'})`);
      }
      if (codexProfile.value) common.push('--profile', codexProfile.value);
    }
    if (model) common.push('-m', model);
    if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
    if (shouldPassFastMode) {
      common.push('-c', `features.fast_mode=${fastMode.enabled ? 'true' : 'false'}`);
    }
    const modelContextWindow = modelLimit(codexModelContextWindows, model)
      ?? (codexModelContextWindow !== null && matchesContextModel(model, codexModelContextWindowModel)
        ? codexModelContextWindow
        : null);
    if (modelContextWindow !== null) {
      common.push('-c', `model_context_window=${modelContextWindow}`);
    }
    if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
      const modelCompactLimit = modelLimit(codexModelCompactTokenLimits, model);
      const effectiveNativeLimit = modelCompactLimit !== null && nativeLimit.source === 'env default'
        ? modelCompactLimit
        : nativeLimit.tokens;
      common.push('-c', `model_auto_compact_token_limit=${effectiveNativeLimit}`);
    }
    for (const cfg of extraConfigs) common.push('-c', cfg);
    for (const imagePath of inputImages) {
      const value = String(imagePath || '').trim();
      if (value) common.push('--image', value);
    }

    if (sessionId) {
      return ['exec', 'resume', '--json', ...permissionArgs, ...common, sessionId, prompt];
    }

    return ['exec', '--json', '--skip-git-repo-check', ...permissionArgs, '-C', workspaceDir, ...common, prompt];
  }

  function buildClaudeArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs = [], systemPrompt = '' }) {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];
    const systemText = String(systemPrompt || '').trim();
    for (const dir of uniqueDirs([workspaceDir, ...additionalWorkspaceDirs])) {
      args.push('--add-dir', dir);
    }
    const model = resolveModelSetting(session).value || defaultModel;
    const effort = resolveReasoningEffortSetting(session).value;
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
    const sessionId = getSessionId(session);
    const pendingForkFromSessionId = String(session?.pendingForkFromSessionId || '').trim();

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
      args.push('--autocompact', nativeLimit.tokens === null ? 'auto' : String(nativeLimit.tokens));
    }

    if (session.mode === 'dangerous') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (pendingForkFromSessionId) {
      args.push('--resume', pendingForkFromSessionId, '--fork-session');
      args.push('--session-id', sessionId || randomUUID());
    } else if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', randomUUID());
    }

    if (systemText) args.push('--append-system-prompt', systemText);
    args.push('--allowedTools', 'default', '--', prompt);
    return args;
  }

  function buildGrokArgs({ session, workspaceDir, promptFile, systemPrompt = '' }) {
    const normalizedPromptFile = String(promptFile || '').trim();
    if (!normalizedPromptFile) throw new Error('Grok prompt file is required');
    const sessionId = getSessionId(session);
    const args = [
      '--prompt-file', normalizedPromptFile,
      '--cwd', workspaceDir,
      '--output-format', 'streaming-json',
    ];
    if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', randomUUID());
    }
    const systemText = String(systemPrompt || '').trim();
    const model = resolveModelSetting(session).value || defaultModel;
    const effort = resolveReasoningEffortSetting(session).value;
    if (systemText) args.push('--rules', systemText);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (session.mode === 'dangerous') {
      args.push('--always-approve');
    } else {
      args.push('--always-approve', '--sandbox', 'workspace');
    }
    return args;
  }

  function buildCursorArgs({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) {
    const attachments = inputImages
      .map((imagePath) => String(imagePath || '').trim())
      .filter(Boolean);
    if (attachments.length) {
      throw new Error('Cursor Agent does not expose native image input in headless mode');
    }

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--trust',
      '--workspace', workspaceDir,
    ];
    const sessionId = getSessionId(session);
    if (sessionId) args.push('--resume', sessionId);
    const model = resolveModelSetting(session).value || defaultModel;
    if (model) args.push('--model', model);
    if (session.mode === 'dangerous') {
      args.push('--force', '--sandbox', 'disabled');
    } else {
      args.push('--auto-review', '--sandbox', 'enabled');
    }
    args.push(composePromptWithSystemFallback(prompt, systemPrompt));
    return args;
  }

  function buildAntigravityArgs({ session, prompt, systemPrompt = '' }) {
    const args = [];
    const sessionId = getSessionId(session);
    const promptText = composePromptWithSystemFallback(prompt, systemPrompt);

    if (session.mode === 'dangerous') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--sandbox');
    }

    if (sessionId) args.push('--conversation', sessionId);
    args.push('--prompt', promptText);
    return args;
  }

  function buildZCodeArgs({ session, workspaceDir, prompt, inputImages = [], systemPrompt = '' }) {
    const args = ['--prompt', composePromptWithSystemFallback(prompt, systemPrompt)];
    for (const imagePath of inputImages) {
      const value = String(imagePath || '').trim();
      if (value) args.push('--attach', value);
    }
    args.push('--cwd', workspaceDir);
    const sessionId = getSessionId(session);
    if (sessionId) args.push('--resume', sessionId);
    args.push('--mode', session.mode === 'dangerous' ? 'yolo' : 'edit');
    args.push('--json', '--no-color');
    return args;
  }

  function buildPiFamilyArgs({
    provider,
    session,
    prompt,
    additionalWorkspaceDirs = [],
    inputImages = [],
    systemPrompt = '',
  }) {
    const isOmp = provider === 'omp';
    const args = ['-p', '--mode', 'json'];
    if (isOmp) {
      args.push('--approval-mode', session.mode === 'dangerous' ? 'yolo' : 'write');
    } else if (session.mode === 'dangerous') {
      args.push('--approve');
    } else {
      args.push('--no-approve', '--tools', 'read');
    }

    const model = resolveModelSetting(session).value || defaultModel;
    const effort = resolveReasoningEffortSetting(session).value;
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    if (isOmp) {
      const fastMode = resolveFastModeSetting(session);
      if (fastMode.supported) {
        const serviceTier = String(fastMode.serviceTier || '').trim().toLowerCase();
        if (!['none', 'auto', 'default', 'flex', 'scale', 'priority'].includes(serviceTier)) {
          throw new Error(`invalid OMP service tier: ${serviceTier || '(empty)'}`);
        }
        args.push('--service-tier', serviceTier);
      }
    }

    const systemText = String(systemPrompt || '').trim();
    if (systemText) args.push('--append-system-prompt', systemText);
    if (isOmp) {
      for (const dir of uniqueDirs(additionalWorkspaceDirs)) args.push('--add-dir', dir);
    }

    const sessionId = getSessionId(session);
    if (sessionId) args.push(isOmp ? '--resume' : '--session', sessionId);
    for (const imagePath of inputImages) {
      const value = String(imagePath || '').trim();
      if (value) args.push(`@${value}`);
    }
    args.push(prompt);
    return args;
  }

  return {
    buildSessionRunnerArgs,
    buildCodexArgs,
    buildClaudeArgs,
    buildCursorArgs,
    buildGrokArgs,
    buildAntigravityArgs,
    buildZCodeArgs,
    buildPiFamilyArgs,
  };
}
