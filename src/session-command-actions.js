function hasWorkspaceChanged(previousDir, nextDir) {
  return String(previousDir || '') !== String(nextDir || '');
}

function shouldResetSessionForWorkspaceChange(provider, previousDir, nextDir) {
  return provider === 'codex' && hasWorkspaceChanged(previousDir, nextDir);
}

export function createSessionCommandActions({
  saveDb,
  ensureWorkspace,
  getWorkspaceBinding = () => ({ workspaceDir: null, source: 'legacy fallback' }),
  listStoredSessions = () => [],
  resolveProviderDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset', envKey: null }),
  setProviderDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset', envKey: null }),
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getProviderShortName,
  resolveTimeoutSetting,
  resolveProcessLinesSetting,
  listRecentSessions,
  humanAge,
} = {}) {
  function setOnboardingEnabled(session, enabled) {
    session.onboardingEnabled = enabled;
    saveDb();
    return { enabled: session.onboardingEnabled };
  }

  function setLanguage(session, language) {
    session.language = language;
    saveDb();
    return { language: session.language };
  }

  function setSecurityProfile(session, profile) {
    session.securityProfile = profile;
    saveDb();
    return { profile: session.securityProfile };
  }

  function setTimeoutMs(session, timeoutMs) {
    session.timeoutMs = timeoutMs;
    saveDb();
    return { timeoutSetting: resolveTimeoutSetting(session) };
  }

  function setProcessLines(session, lines) {
    session.processLines = lines;
    saveDb();
    return { processLinesSetting: resolveProcessLinesSetting(session) };
  }

  function setProvider(session, requested) {
    const previous = getSessionProvider(session);
    session.provider = requested;
    clearSessionId(session);
    saveDb();
    return { previous, provider: requested };
  }

  function setModel(session, name) {
    session.model = String(name || '').toLowerCase() === 'default' ? null : name;
    saveDb();
    return { model: session.model };
  }

  function setReasoningEffort(session, effort) {
    session.effort = effort === 'default' ? null : effort;
    saveDb();
    return { effort: session.effort };
  }

  function applyCompactConfig(session, parsed) {
    if (parsed.type === 'reset') {
      session.compactStrategy = null;
      session.compactEnabled = null;
      session.compactThresholdTokens = null;
      session.nativeCompactTokenLimit = null;
    } else if (parsed.type === 'set_strategy') {
      session.compactStrategy = parsed.strategy;
    } else if (parsed.type === 'set_enabled') {
      session.compactEnabled = parsed.enabled;
    } else if (parsed.type === 'set_threshold') {
      session.compactThresholdTokens = parsed.tokens;
    } else if (parsed.type === 'set_native_limit') {
      session.nativeCompactTokenLimit = parsed.tokens;
    }
    saveDb();
    return {
      compactStrategy: session.compactStrategy,
      compactEnabled: session.compactEnabled,
      compactThresholdTokens: session.compactThresholdTokens,
      nativeCompactTokenLimit: session.nativeCompactTokenLimit,
    };
  }

  function setMode(session, mode) {
    session.mode = mode;
    saveDb();
    return { mode: session.mode };
  }

  function bindSession(session, sessionId) {
    setSessionId(session, sessionId);
    saveDb();
    return {
      providerLabel: getProviderShortName(getSessionProvider(session)),
      sessionId: getSessionId(session),
    };
  }

  function renameSession(session, label) {
    session.name = label;
    saveDb();
    return { label: session.name };
  }

  function setWorkspaceDir(session, key, resolvedPath) {
    const provider = getSessionProvider(session);
    const previousBinding = getWorkspaceBinding(session, key);
    session.workspaceDir = resolvedPath;
    const nextBinding = getWorkspaceBinding(session, key);
    const sessionReset = shouldResetSessionForWorkspaceChange(provider, previousBinding.workspaceDir, nextBinding.workspaceDir);
    if (sessionReset) clearSessionId(session);
    saveDb();
    return {
      provider,
      workspaceDir: nextBinding.workspaceDir,
      source: nextBinding.source,
      previousWorkspaceDir: previousBinding.workspaceDir,
      sessionReset,
      sessionId: getSessionId(session),
    };
  }

  function clearWorkspaceDir(session, key) {
    const provider = getSessionProvider(session);
    const previousBinding = getWorkspaceBinding(session, key);
    session.workspaceDir = null;
    const nextBinding = getWorkspaceBinding(session, key);
    const sessionReset = shouldResetSessionForWorkspaceChange(provider, previousBinding.workspaceDir, nextBinding.workspaceDir);
    if (sessionReset) clearSessionId(session);
    saveDb();
    return {
      provider,
      workspaceDir: nextBinding.workspaceDir,
      source: nextBinding.source,
      previousWorkspaceDir: previousBinding.workspaceDir,
      sessionReset,
      sessionId: getSessionId(session),
      clearedOverride: true,
    };
  }

  function setDefaultWorkspaceDir(session, resolvedPath) {
    const provider = getSessionProvider(session);
    const previousDefault = resolveProviderDefaultWorkspace(provider);
    const trackedSessions = listStoredSessions({ provider });
    const beforeBindings = new Map(
      trackedSessions.map(({ key, session: storedSession }) => [key, getWorkspaceBinding(storedSession, key)]),
    );

    const nextDefault = setProviderDefaultWorkspace(provider, resolvedPath);

    let affectedThreads = 0;
    let resetSessions = 0;
    let currentThreadChanged = false;
    let currentSessionReset = false;

    if (provider === 'codex') {
      for (const { key, session: storedSession } of trackedSessions) {
        const before = beforeBindings.get(key);
        const after = getWorkspaceBinding(storedSession, key);
        if (!hasWorkspaceChanged(before?.workspaceDir, after.workspaceDir)) continue;
        affectedThreads += 1;
        currentThreadChanged ||= storedSession === session;
        if (getSessionId(storedSession)) {
          clearSessionId(storedSession);
          resetSessions += 1;
          if (storedSession === session) currentSessionReset = true;
        }
      }
      if (affectedThreads > 0 || resetSessions > 0) {
        saveDb();
      }
    } else {
      const currentKey = trackedSessions.find(({ session: storedSession }) => storedSession === session)?.key || null;
      if (currentKey) {
        const before = beforeBindings.get(currentKey);
        const after = getWorkspaceBinding(session, currentKey);
        currentThreadChanged = hasWorkspaceChanged(before?.workspaceDir, after.workspaceDir);
      }
      affectedThreads = trackedSessions.filter(({ key, session: storedSession }) => {
        const before = beforeBindings.get(key);
        const after = getWorkspaceBinding(storedSession, key);
        return hasWorkspaceChanged(before?.workspaceDir, after.workspaceDir);
      }).length;
    }

    return {
      provider,
      defaultWorkspaceDir: nextDefault.workspaceDir,
      defaultSource: nextDefault.source,
      defaultEnvKey: nextDefault.envKey,
      previousDefaultWorkspaceDir: previousDefault.workspaceDir,
      previousDefaultSource: previousDefault.source,
      affectedThreads,
      resetSessions,
      currentThreadChanged,
      currentSessionReset,
    };
  }

  function resetSession(session) {
    clearSessionId(session);
    session.configOverrides = [];
    saveDb();
    return { sessionId: getSessionId(session), configOverrides: session.configOverrides };
  }

  function formatRecentSessionsReport({ key, session, resumeRef = '!resume <id>', limit = 10 } = {}) {
    const provider = getSessionProvider(session);
    const sessions = listRecentSessions({ provider, workspaceDir: ensureWorkspace(session, key), limit });
    if (!sessions.length) {
      return `没有找到任何 ${getProviderShortName(provider)} session。`;
    }
    const lines = sessions.map((entry, index) => {
      const ago = humanAge(Date.now() - entry.mtime);
      return `${index + 1}. \`${entry.id}\` (${ago} ago)`;
    });
    return [
      `**最近 ${getProviderShortName(provider)} Sessions**（用 \`${resumeRef}\` 继承）`,
      ...lines,
    ].join('\n');
  }

  return {
    setOnboardingEnabled,
    setLanguage,
    setSecurityProfile,
    setTimeoutMs,
    setProcessLines,
    setProvider,
    setModel,
    setReasoningEffort,
    applyCompactConfig,
    setMode,
    bindSession,
    renameSession,
    setWorkspaceDir,
    clearWorkspaceDir,
    setDefaultWorkspaceDir,
    resetSession,
    formatRecentSessionsReport,
  };
}
