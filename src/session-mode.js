export function normalizeSessionModeOverride(value) {
  if (value === null || value === undefined) return null;
  const mode = String(value).trim().toLowerCase();
  if (mode === 'default') return null;
  if (mode === 'safe' || mode === 'dangerous') return mode;
  throw new Error(`invalid execution mode: ${String(value)}`);
}

export function resolveSessionModeSetting(session, { getParentSession, defaultMode = 'safe' }, visited = new Set()) {
  if (!session) return { value: defaultMode, source: 'env default' };
  if (visited.has(session)) throw new Error('cyclic execution mode inheritance');
  visited.add(session);

  // Legacy records have no provenance: preserve their saved mode as an override.
  const override = Object.hasOwn(session, 'modeOverride')
    ? normalizeSessionModeOverride(session.modeOverride)
    : normalizeSessionModeOverride(session.mode ?? null);
  if (override !== null) return { value: override, source: 'session override' };
  const parent = getParentSession(session);
  if (!parent) return { value: defaultMode, source: 'env default' };
  const inherited = resolveSessionModeSetting(parent, { getParentSession, defaultMode }, visited);
  return { value: inherited.value, source: inherited.source === 'env default' ? 'env default' : 'parent channel' };
}
