const NATIVE_GOAL_PROVIDERS = new Set(['claude', 'grok', 'zcode', 'omp']);

function normalize(value) {
  return String(value || '').trim();
}

function normalizeProvider(value) {
  return normalize(value).toLowerCase();
}

function normalizeAction(value) {
  return normalize(value || 'set').toLowerCase();
}

function parsePositiveInteger(value, label) {
  const text = normalize(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function providerSupportsNativeGoalSlash(provider) {
  return NATIVE_GOAL_PROVIDERS.has(normalizeProvider(provider));
}

export function parseProviderGoalSlashInput({
  provider,
  action = 'set',
  objective = '',
  tokenBudget = '',
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!providerSupportsNativeGoalSlash(normalizedProvider)) {
    throw new Error(`${normalizedProvider || 'provider'} does not support native goal commands in Discord`);
  }

  const normalizedAction = normalizeAction(action);
  const supportedActions = normalizedProvider === 'claude'
    ? new Set(['set', 'status', 'clear'])
    : new Set(['set', 'status', 'pause', 'resume', 'clear']);
  if (!supportedActions.has(normalizedAction)) {
    throw new Error(`${normalizedProvider} goal does not support action: ${normalizedAction || '(empty)'}`);
  }

  const normalizedObjective = normalize(objective);
  if (normalizedAction === 'set' && !normalizedObjective) {
    throw new Error('goal objective is required');
  }

  const normalizedBudget = normalize(tokenBudget);
  if (normalizedBudget && (normalizedProvider !== 'grok' || normalizedAction !== 'set')) {
    throw new Error(`${normalizedProvider} goal does not support token_budget for ${normalizedAction}`);
  }

  return {
    provider: normalizedProvider,
    action: normalizedAction,
    objective: normalizedObjective,
    tokenBudget: normalizedBudget ? parsePositiveInteger(normalizedBudget, 'token_budget') : null,
  };
}

export function buildProviderGoalCommand(input) {
  const parsed = parseProviderGoalSlashInput(input);
  const { provider, action, objective, tokenBudget } = parsed;

  if (provider === 'claude') {
    if (action === 'set') return `/goal ${objective}`;
    if (action === 'status') return '/goal';
    return '/goal clear';
  }

  if (provider === 'grok') {
    if (action === 'set') {
      return `/goal ${objective}${tokenBudget ? ` --budget ${tokenBudget}` : ''}`;
    }
    return `/goal ${action}`;
  }

  if (provider === 'zcode') {
    if (action === 'set') return `/goal replace ${objective}`;
    if (action === 'status') return '/goal';
    return `/goal ${action}`;
  }

  if (provider === 'omp') {
    if (action === 'set') return `/goal set ${objective}`;
    if (action === 'status') return '/goal show';
    if (action === 'clear') return '/goal drop';
    return `/goal ${action}`;
  }

  throw new Error(`${provider} does not support native goal commands in Discord`);
}

export function formatProviderGoalQueueResult({ provider, action, queuedAhead = 0 } = {}, language = 'zh') {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedAction = normalizeAction(action);
  const ahead = Number.isFinite(Number(queuedAhead)) ? Math.max(0, Math.floor(Number(queuedAhead))) : 0;
  if (language === 'en') {
    return ahead > 0
      ? `${normalizedProvider} goal ${normalizedAction} is queued behind ${ahead} task(s).`
      : `${normalizedProvider} goal ${normalizedAction} has started.`;
  }
  return ahead > 0
    ? `${normalizedProvider} goal ${normalizedAction} 已排队，前面还有 ${ahead} 个任务。`
    : `${normalizedProvider} goal ${normalizedAction} 已开始。`;
}
