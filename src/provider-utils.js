import { randomUUID } from 'node:crypto';
import {
  normalizeProvider as normalizeCliProvider,
  getProviderDisplayName,
  getProviderShortName,
  providerSupportsRawConfigOverrides,
  providerSupportsConfigOverrides,
  getProviderCompactCapabilities,
  providerSupportsCompactStrategy,
  providerSupportsNativeCompact,
} from './provider-metadata.js';
import { buildCodexPermissionArgs } from './codex-permissions.js';
import { buildCodexOpenAICuratedMarketplaceArgs } from './codex-marketplaces.js';

export {
  normalizeCliProvider,
  getProviderDisplayName,
  getProviderShortName,
  providerSupportsRawConfigOverrides,
  providerSupportsConfigOverrides,
  getProviderCompactCapabilities,
  providerSupportsCompactStrategy,
  providerSupportsNativeCompact,
};

export function buildRunnerArgs({
  provider,
  sessionId,
  workspaceDir,
  prompt,
  mode = 'safe',
  model = null,
  effort = null,
  fastMode = null,
  extraConfigs = [],
  compactStrategy = 'native',
  compactOnThreshold = true,
  modelAutoCompactTokenLimit = 0,
  pendingForkFromSessionId = null,
} = {}) {
  const normalizedProvider = normalizeCliProvider(provider);
  if (normalizedProvider === 'claude') {
    return buildClaudeArgs({
      sessionId,
      prompt,
      mode,
      model,
      effort,
      pendingForkFromSessionId,
    });
  }
  if (normalizedProvider === 'grok') {
    return buildGrokArgs({
      sessionId,
      workspaceDir,
      prompt,
      mode,
      model,
      effort,
      pendingForkFromSessionId,
    });
  }
  if (normalizedProvider === 'cursor') {
    return buildCursorArgs({
      sessionId,
      workspaceDir,
      prompt,
      mode,
      model,
    });
  }
  if (normalizedProvider === 'antigravity') {
    return buildAntigravityArgs({
      sessionId,
      prompt,
      mode,
      model,
    });
  }
  if (normalizedProvider === 'zcode') {
    return buildZCodeArgs({
      sessionId,
      workspaceDir,
      prompt,
      mode,
    });
  }
  if (normalizedProvider === 'pi' || normalizedProvider === 'omp') {
    return buildPiFamilyArgs({
      provider: normalizedProvider,
      sessionId,
      prompt,
      mode,
      model,
      effort,
      fastMode,
    });
  }

  return buildCodexArgs({
    sessionId,
    workspaceDir,
    prompt,
    mode,
    model,
    effort,
    fastMode,
    extraConfigs,
    compactStrategy,
    compactOnThreshold,
    modelAutoCompactTokenLimit,
  });
}

function buildCursorArgs({
  sessionId,
  workspaceDir,
  prompt,
  mode,
  model,
}) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--trust',
    '--workspace', workspaceDir,
  ];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  if (mode === 'dangerous') args.push('--force', '--sandbox', 'disabled');
  else args.push('--auto-review', '--sandbox', 'enabled');
  args.push(prompt);
  return args;
}

function buildCodexArgs({
  sessionId,
  workspaceDir,
  prompt,
  mode,
  model,
  effort,
  fastMode,
  extraConfigs,
  compactStrategy,
  compactOnThreshold,
  modelAutoCompactTokenLimit,
}) {
  const common = ['--enable', 'goals', ...buildCodexOpenAICuratedMarketplaceArgs()];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (typeof fastMode === 'boolean') {
    common.push('-c', `features.fast_mode=${fastMode ? 'true' : 'false'}`);
  }
  if (compactStrategy === 'native' && compactOnThreshold) {
    common.push('-c', `model_auto_compact_token_limit=${modelAutoCompactTokenLimit}`);
  }
  for (const cfg of extraConfigs || []) common.push('-c', cfg);

  if (sessionId) {
    return ['exec', 'resume', '--json', ...buildCodexPermissionArgs(mode, { resume: true }), ...common, sessionId, prompt];
  }

  return ['exec', '--json', '--skip-git-repo-check', ...buildCodexPermissionArgs(mode, { resume: false }), '-C', workspaceDir, ...common, prompt];
}

function buildClaudeArgs({
  sessionId,
  prompt,
  mode,
  model,
  effort,
  pendingForkFromSessionId,
}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (mode === 'dangerous') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (pendingForkFromSessionId) {
    args.push('--resume', pendingForkFromSessionId, '--fork-session');
    if (sessionId) args.push('--session-id', sessionId);
  } else if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push('--allowedTools', 'default', '--', prompt);
  return args;
}

function buildGrokArgs({
  sessionId,
  workspaceDir,
  prompt,
  mode,
  model,
  effort,
  pendingForkFromSessionId,
}) {
  const args = ['-p', prompt, '--cwd', workspaceDir, '--output-format', 'streaming-json'];
  if (pendingForkFromSessionId) {
    args.push('--resume', pendingForkFromSessionId, '--fork-session', '--session-id', sessionId || randomUUID());
  } else if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', randomUUID());
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (mode === 'dangerous') args.push('--always-approve');
  else args.push('--always-approve', '--sandbox', 'workspace');
  return args;
}

function buildAntigravityArgs({
  sessionId,
  prompt,
  mode,
}) {
  const args = [];

  if (mode === 'dangerous') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--sandbox');
  }

  if (sessionId) args.push('--conversation', sessionId);
  args.push('--prompt', prompt);
  return args;
}

function buildZCodeArgs({
  sessionId,
  workspaceDir,
  prompt,
  mode,
}) {
  const args = ['--prompt', prompt, '--cwd', workspaceDir];
  if (sessionId) args.push('--resume', sessionId);
  args.push('--mode', mode === 'dangerous' ? 'yolo' : 'edit', '--json', '--no-color');
  return args;
}

function buildPiFamilyArgs({
  provider,
  sessionId,
  prompt,
  mode,
  model,
  effort,
  fastMode,
}) {
  const isOmp = provider === 'omp';
  const args = ['-p', '--mode', 'json'];
  if (isOmp) {
    args.push('--approval-mode', mode === 'dangerous' ? 'yolo' : 'write');
  } else if (mode === 'dangerous') {
    args.push('--approve');
  } else {
    args.push('--no-approve', '--tools', 'read');
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--thinking', effort);
  if (isOmp && typeof fastMode === 'boolean') {
    args.push('--service-tier', fastMode ? 'priority' : 'none');
  }
  if (sessionId) args.push(isOmp ? '--resume' : '--session', sessionId);
  args.push(prompt);
  return args;
}
