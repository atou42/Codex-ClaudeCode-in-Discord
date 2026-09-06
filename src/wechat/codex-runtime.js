import path from 'node:path';

import { stopChildProcess } from '../channel-runtime.js';
import {
  composeFinalAnswerText,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from '../codex-event-utils.js';
import { getProviderDefaultBin, normalizeProvider } from '../provider-metadata.js';
import { buildSpawnEnv } from '../provider-runtime.js';
import { createRunnerExecutor } from '../runner-executor.js';
import { normalizeTimeoutMs } from '../session-settings.js';
import { ensureDir } from '../session-store.js';
import { safeError } from '../runtime-utils.js';
import { createWorkspaceRuntime } from '../workspace-runtime.js';

export function createWechatCodexRuntime({
  sessionStore,
  lockRoot,
  codexBin = 'codex',
  runtimeMode = 'long',
  allowDangerous = false,
  timeoutMs = 0,
  spawnEnv = buildSpawnEnv(process.env),
  logger = console,
  runnerExecutor = null,
  workspaceRuntime = null,
} = {}) {
  const active = new Map();
  const workspaceLocks = workspaceRuntime || createWorkspaceRuntime({ lockRoot, ensureDir });
  const runner = runnerExecutor || createRunnerExecutor({
    spawnEnv,
    defaultTimeoutMs: timeoutMs,
    ensureDir,
    normalizeProvider,
    getSessionProvider: () => 'codex',
    getProviderBin: () => codexBin || getProviderDefaultBin('codex'),
    getSessionId: (session) => session.sessionId || null,
    resolveModelSetting: (session) => ({ value: session.model || null, source: 'wechat session' }),
    resolveCodexProfileSetting: () => ({
      value: null,
      source: 'provider default',
      valid: true,
      isExplicit: false,
    }),
    resolveReasoningEffortSetting: (session) => ({
      value: session.effort || null,
      source: 'wechat session',
    }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'provider default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveRuntimeModeSetting: () => ({
      mode: runtimeMode === 'long' ? 'long' : 'normal',
      supported: true,
      source: 'wechat runtime',
    }),
    resolveTimeoutSetting: () => ({ timeoutMs }),
    normalizeTimeoutMs,
    safeError,
    stopChildProcess,
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  function getActive(userId) {
    return active.get(String(userId)) || null;
  }

  async function run(userId, prompt, { onWait = null } = {}) {
    const key = String(userId);
    if (active.has(key)) {
      return { ok: false, busy: true, error: '当前微信会话已有任务在运行' };
    }
    const saved = sessionStore.get(key);
    if (saved.mode === 'dangerous' && !allowDangerous) {
      throw new Error('微信 dangerous mode 已禁用；请先使用 /mode safe，或由管理员显式启用 WECHAT_ALLOW_DANGEROUS=true');
    }
    const session = {
      provider: 'codex',
      runnerSessionId: saved.sessionId,
      codexThreadId: saved.sessionId,
      sessionId: saved.sessionId,
      workspaceDir: saved.workspaceDir,
      model: saved.model,
      effort: saved.effort,
      mode: saved.mode,
      configOverrides: [],
    };
    const state = {
      userId: key,
      cancelled: false,
      child: null,
      workspaceLock: null,
    };
    active.set(key, state);

    try {
      state.workspaceLock = await workspaceLocks.acquireWorkspace(
        saved.workspaceDir,
        {
          key: `wechat:dm:${key}`,
          provider: 'codex',
          sessionId: saved.sessionId,
          channel: 'wechat',
        },
        {
          isAborted: () => state.cancelled,
          onWait,
        },
      );
      if (state.cancelled || state.workspaceLock?.aborted) {
        return { ok: false, cancelled: true, error: 'cancelled' };
      }

      const result = await runner.runProviderTask({
        session,
        sessionKey: `wechat:dm:${key}`,
        workspaceDir: saved.workspaceDir,
        prompt,
        onSpawn: (child) => {
          state.child = child;
          if (state.cancelled) stopChildProcess(child);
        },
        wasCancelled: () => state.cancelled,
        onLog: (line, source) => {
          if (source === 'stderr') logger.warn(`[wechat/codex] ${line}`);
        },
      });

      if (result.ok && result.threadId) {
        sessionStore.update(key, { sessionId: result.threadId });
      }
      const text = composeFinalAnswerText(result)
        || (Array.isArray(result.messages) ? result.messages.join('\n\n').trim() : '');
      return {
        ...result,
        text,
        workspaceDir: path.resolve(saved.workspaceDir),
        sessionId: result.threadId || saved.sessionId || null,
      };
    } finally {
      try {
        state.workspaceLock?.release?.();
      } catch {
      }
      active.delete(key);
    }
  }

  function cancel(userId) {
    const state = getActive(userId);
    if (!state) return { ok: false, cancelled: false, reason: 'idle' };
    state.cancelled = true;
    if (state.child) stopChildProcess(state.child);
    return { ok: true, cancelled: true };
  }

  function close() {
    for (const state of active.values()) {
      state.cancelled = true;
      if (state.child) stopChildProcess(state.child);
    }
    runner.closeAllRuntimeSessions?.();
  }

  return {
    run,
    cancel,
    close,
    getActive,
    readWorkspaceLock: workspaceLocks.readLock,
  };
}
