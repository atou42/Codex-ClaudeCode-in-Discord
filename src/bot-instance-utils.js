import {
  getProviderDefaultSlashPrefix,
  parseOptionalProvider,
} from './provider-metadata.js';

export { parseOptionalProvider };

export function resolveProviderScopedEnv(envKey, provider = null, env = process.env) {
  const lockedProvider = parseOptionalProvider(provider);
  if (lockedProvider) {
    const providerPrefixKey = `${lockedProvider.toUpperCase()}__${envKey}`;
    const providerPrefixValue = String(env?.[providerPrefixKey] || '').trim();
    if (providerPrefixValue) return providerPrefixValue;

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
  return getProviderDefaultSlashPrefix(provider);
}
