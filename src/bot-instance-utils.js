export function parseOptionalProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['codex', 'openai'].includes(raw)) return 'codex';
  if (['claude', 'anthropic'].includes(raw)) return 'claude';
  if (['gemini', 'google'].includes(raw)) return 'gemini';
  return null;
}

export function resolveProviderScopedEnv(envKey, provider = null, env = process.env) {
  const lockedProvider = parseOptionalProvider(provider);
  if (lockedProvider) {
    const scopedKey = `${envKey}_${lockedProvider.toUpperCase()}`;
    const scopedValue = String(env?.[scopedKey] || '').trim();
    if (scopedValue) return scopedValue;
  }

  const fallbackValue = String(env?.[envKey] || '').trim();
  return fallbackValue;
}

export function resolveDiscordToken({ botProvider = null, env = process.env } = {}) {
  return resolveProviderScopedEnv('DISCORD_TOKEN', botProvider, env);
}

export function appendProviderSuffix(filename, provider = null) {
  const lockedProvider = parseOptionalProvider(provider);
  if (!lockedProvider) return filename;

  const normalized = String(filename || '').trim();
  if (!normalized) return normalized;

  const lastDot = normalized.lastIndexOf('.');
  if (lastDot <= 0) return `${normalized}.${lockedProvider}`;
  return `${normalized.slice(0, lastDot)}.${lockedProvider}${normalized.slice(lastDot)}`;
}

export function describeBotMode(provider = null) {
  const lockedProvider = parseOptionalProvider(provider);
  if (!lockedProvider) return 'shared';
  return `locked:${lockedProvider}`;
}

export function getDefaultSlashPrefix(provider = null) {
  const lockedProvider = parseOptionalProvider(provider);
  if (lockedProvider === 'claude') return 'cc';
  if (lockedProvider === 'gemini') return 'gm';
  return 'cx';
}
