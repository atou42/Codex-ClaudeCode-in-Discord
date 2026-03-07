import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

function uniqueDirs(dirs = []) {
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

export function createRunnerExecutor({
  debugEvents = false,
  spawnEnv,
  defaultTimeoutMs = 0,
  defaultModel = null,
  ensureDir,
  normalizeProvider,
  getSessionProvider,
  getProviderBin,
  getSessionId,
  getProviderDefaultWorkspace = () => ({ workspaceDir: null }),
  resolveTimeoutSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveNativeCompactTokenLimitSetting,
  normalizeTimeoutMs,
  safeError,
  stopChildProcess,
  startSessionProgressBridge,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} = {}) {
  async function runCodex({ session, workspaceDir, prompt, onSpawn, wasCancelled, onEvent, onLog }) {
    ensureDir(workspaceDir);

    const provider = getSessionProvider(session);
    const notes = [];
    const providerDefault = getProviderDefaultWorkspace(provider) || {};
    const additionalWorkspaceDirs = normalizeProvider(provider) === 'claude'
      ? uniqueDirs([providerDefault.workspaceDir].filter((dir) => dir && dir !== workspaceDir))
      : [];
    const args = buildSessionRunnerArgs({ provider, session, workspaceDir, prompt, additionalWorkspaceDirs });
    const timeoutMs = resolveTimeoutSetting(session).timeoutMs;
    const bin = getProviderBin(provider);

    if (debugEvents) {
      console.log(`Running ${provider}:`, [bin, ...args].join(' '));
    }

    const result = await spawnRunner({ provider, args, cwd: workspaceDir, workspaceDir }, {
      onSpawn,
      wasCancelled,
      onEvent,
      onLog,
      timeoutMs,
    });

    return {
      ...result,
      notes,
    };
  }

  function buildSessionRunnerArgs({ provider, session, workspaceDir, prompt, additionalWorkspaceDirs = [] }) {
    return normalizeProvider(provider) === 'claude'
      ? buildClaudeArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs })
      : buildCodexArgs({ session, workspaceDir, prompt });
  }

  function buildCodexArgs({ session, workspaceDir, prompt }) {
    const modeFlag = session.mode === 'dangerous'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--full-auto';

    const model = session.model || defaultModel;
    const effort = session.effort;
    const extraConfigs = session.configOverrides || [];
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);

    const common = [];
    if (model) common.push('-m', model);
    if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
    if (compactSetting.strategy === 'native' && compactEnabled.enabled) {
      common.push('-c', `model_auto_compact_token_limit=${nativeLimit.tokens}`);
    }
    for (const cfg of extraConfigs) common.push('-c', cfg);

    const sessionId = getSessionId(session);
    if (sessionId) {
      return ['exec', 'resume', '--json', modeFlag, ...common, sessionId, prompt];
    }

    return ['exec', '--json', '--skip-git-repo-check', modeFlag, '-C', workspaceDir, ...common, prompt];
  }

  function buildClaudeArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs = [] }) {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];
    for (const dir of uniqueDirs([workspaceDir, ...additionalWorkspaceDirs])) {
      args.push('--add-dir', dir);
    }
    const model = session.model || defaultModel;
    const effort = session.effort;
    const sessionId = getSessionId(session);

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    if (session.mode === 'dangerous') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (sessionId) args.push('--resume', sessionId);
    else args.push('--session-id', randomUUID());

    args.push('--allowedTools', 'default', '--', prompt);
    return args;
  }

  function spawnRunner({ provider, args, cwd, workspaceDir }, options = {}) {
    return new Promise((resolve) => {
      const bin = getProviderBin(provider);
      const child = spawn(bin, args, {
        cwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      options.onSpawn?.(child);

      let stdoutBuf = '';
      let stderrBuf = '';

      const messages = [];
      const finalAnswerMessages = [];
      const reasonings = [];
      const logs = [];
      let usage = null;
      let threadId = null;
      let resolved = false;
      let timedOut = false;
      let progressBridgeThreadId = null;
      let stopProgressBridge = null;
      const timeoutMs = normalizeTimeoutMs(options.timeoutMs, defaultTimeoutMs);
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          logs.push(`Timeout after ${timeoutMs}ms`);
          stopChildProcess(child);
        }, timeoutMs)
        : null;

      const stopBridges = () => {
        if (typeof stopProgressBridge === 'function') {
          try {
            stopProgressBridge();
          } catch {
          }
        }
        stopProgressBridge = null;
        progressBridgeThreadId = null;
      };

      const ensureSessionBridge = (nextThreadId) => {
        const id = String(nextThreadId || '').trim();
        if (!id) return;
        if (typeof options.onEvent !== 'function') return;
        if (id === progressBridgeThreadId && typeof stopProgressBridge === 'function') return;

        stopBridges();
        stopProgressBridge = startSessionProgressBridge({
          provider,
          threadId: id,
          workspaceDir,
          onEvent: options.onEvent,
        });
        progressBridgeThreadId = id;
      };

      const consumeLine = (line, source) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const ev = JSON.parse(trimmed);
            if (debugEvents) console.log('[event]', ev.type, ev);
            handleEvent(ev);
            options.onEvent?.(ev);
            return;
          } catch {
          }
        }

        if (provider === 'codex' && trimmed.includes('state db missing rollout path for thread')) return;
        if (source === 'stderr' || debugEvents) logs.push(trimmed);
        options.onLog?.(trimmed, source);
      };

      const onData = (chunk, source) => {
        let buf = source === 'stdout' ? stdoutBuf : stderrBuf;
        buf += chunk.toString('utf8');

        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) consumeLine(line, source);

        if (source === 'stdout') stdoutBuf = buf;
        else stderrBuf = buf;
      };

      const flushRemainders = () => {
        if (stdoutBuf.trim()) consumeLine(stdoutBuf, 'stdout');
        if (stderrBuf.trim()) consumeLine(stderrBuf, 'stderr');
      };

      const handleEvent = (ev) => {
        const state = { messages, finalAnswerMessages, reasonings, logs, usage, threadId };
        if (normalizeProvider(provider) === 'claude') {
          handleClaudeRunnerEvent(ev, state, ensureSessionBridge);
        } else {
          handleCodexRunnerEvent(ev, state, ensureSessionBridge);
        }
        usage = state.usage;
        threadId = state.threadId;
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        stopBridges();
        resolve(result);
      };

      child.stdout.on('data', (chunk) => onData(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => onData(chunk, 'stderr'));

      child.on('error', (err) => {
        finish({
          ok: false,
          cancelled: false,
          timedOut,
          error: safeError(err),
          logs,
          messages,
          finalAnswerMessages,
          reasonings,
          usage,
          threadId,
        });
      });

      child.on('close', (code, signal) => {
        flushRemainders();
        const cancelled = Boolean(timedOut || options.wasCancelled?.());
        const ok = !cancelled && code === 0;
        finish({
          ok,
          cancelled,
          timedOut,
          error: ok ? '' : buildRunnerError({ provider, code, signal, logs }),
          logs,
          messages,
          finalAnswerMessages,
          reasonings,
          usage,
          threadId,
        });
      });
    });
  }

  return {
    runCodex,
    buildSessionRunnerArgs,
  };
}

function handleCodexRunnerEvent(ev, state, ensureSessionBridge) {
  switch (ev.type) {
    case 'thread.created':
    case 'thread.resumed':
      state.threadId = ev.thread_id || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'assistant.message.delta':
    case 'assistant.message': {
      const text = extractAgentMessageText(ev);
      if (!text) break;
      if (isFinalAnswerLikeAgentMessage(ev)) state.finalAnswerMessages.push(text);
      else state.messages.push(text);
      break;
    }
    case 'reasoning.delta':
    case 'reasoning': {
      const text = String(ev.text || '').trim();
      if (text) state.reasonings.push(text);
      break;
    }
    case 'usage':
      state.usage = ev;
      break;
    default:
      break;
  }
}

function handleClaudeRunnerEvent(ev, state, ensureSessionBridge) {
  switch (ev.type) {
    case 'session.created':
    case 'session.resumed':
      state.threadId = ev.session_id || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'message':
    case 'assistant': {
      const text = extractClaudeText(ev);
      if (!text) break;
      state.messages.push(text);
      break;
    }
    case 'result': {
      const text = extractClaudeText(ev);
      if (text) state.finalAnswerMessages.push(text);
      if (ev.session_id) {
        state.threadId = ev.session_id;
        ensureSessionBridge(state.threadId);
      }
      if (ev.usage) state.usage = ev.usage;
      break;
    }
    default:
      break;
  }
}

function extractClaudeText(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (typeof ev.text === 'string') return ev.text.trim();
  if (typeof ev.message === 'string') return ev.message.trim();
  if (Array.isArray(ev.content)) {
    return ev.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function buildRunnerError({ provider, code, signal, logs }) {
  if (signal) return `${provider} exited via signal ${signal}`;
  if (typeof code === 'number') return `${provider} exited with code ${code}`;
  if (logs.length) return logs[logs.length - 1];
  return `${provider} run failed`;
}
