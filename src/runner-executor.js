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
  readGeminiSessionState = () => null,
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

    if (normalizeProvider(provider) === 'claude' && shouldAutoRecoverClaudeResult(result)) {
      const recoverySessionId = result.threadId || getSessionId(session);
      if (recoverySessionId) {
        const recoverySession = {
          ...session,
          runnerSessionId: recoverySessionId,
          codexThreadId: recoverySessionId,
        };
        const recoveryArgs = buildSessionRunnerArgs({
          provider,
          session: recoverySession,
          workspaceDir,
          prompt: buildClaudeRecoveryPrompt(),
          additionalWorkspaceDirs,
        });
        const recovered = await spawnRunner({ provider, args: recoveryArgs, cwd: workspaceDir, workspaceDir }, {
          onSpawn,
          wasCancelled,
          onEvent,
          onLog,
          timeoutMs,
        });

        if (recovered.ok && hasVisibleAssistantText(recovered) && !shouldAutoRecoverClaudeResult(recovered)) {
          return {
            ...recovered,
            notes: [...notes, '检测到 Claude 子代理提前返回，已自动续跑一次。'],
          };
        }

        return {
          ...result,
          notes: [...notes, '检测到 Claude 子代理提前返回，已尝试自动续跑一次，但没有拿到更完整结果。'],
        };
      }
    }

    return {
      ...result,
      notes,
    };
  }

  function buildSessionRunnerArgs({ provider, session, workspaceDir, prompt, additionalWorkspaceDirs = [] }) {
    switch (normalizeProvider(provider)) {
      case 'claude':
        return buildClaudeArgs({ session, workspaceDir, prompt, additionalWorkspaceDirs });
      case 'gemini':
        return buildGeminiArgs({ session, prompt });
      default:
        return buildCodexArgs({ session, workspaceDir, prompt });
    }
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

  function buildGeminiArgs({ session, prompt }) {
    const args = ['--output-format', 'stream-json'];
    const model = session.model || defaultModel;
    const sessionId = getSessionId(session);

    if (session.mode === 'dangerous') {
      args.push('--yolo');
    } else {
      args.push('--sandbox', '--approval-mode', 'default');
    }

    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    args.push('--prompt', prompt);
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
      const meta = {
        claudeSawAgentToolUse: false,
        claudeStopReason: '',
        geminiDeltaBuffer: '',
      };
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
        const state = { messages, finalAnswerMessages, reasonings, logs, usage, threadId, meta };
        const normalizedProvider = normalizeProvider(provider);
        if (normalizedProvider === 'claude') {
          handleClaudeRunnerEvent(ev, state, ensureSessionBridge);
        } else if (normalizedProvider === 'gemini') {
          handleGeminiRunnerEvent(ev, state, ensureSessionBridge);
        } else {
          handleCodexRunnerEvent(ev, state, ensureSessionBridge, {
            extractAgentMessageText,
            isFinalAnswerLikeAgentMessage,
          });
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
          meta,
        });
      });

      child.on('close', (code, signal) => {
        flushRemainders();
        if (normalizeProvider(provider) === 'gemini') {
          const sessionState = readGeminiSessionState({
            sessionId: threadId,
            workspaceDir,
          });
          if (sessionState?.usage) {
            usage = sessionState.usage;
          }
          if (Array.isArray(sessionState?.messages) && messages.length === 0) {
            messages.push(...sessionState.messages);
          }
          const finalAnswer = String(sessionState?.finalAnswer || '').trim();
          if (finalAnswer && finalAnswerMessages.length === 0) {
            finalAnswerMessages.push(finalAnswer);
          } else if (finalAnswerMessages.length === 0) {
            const buffered = String(meta.geminiDeltaBuffer || '').trim();
            if (buffered) finalAnswerMessages.push(buffered);
          }
        }
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
          meta,
        });
      });
    });
  }

  return {
    runCodex,
    buildSessionRunnerArgs,
  };
}

function handleCodexRunnerEvent(ev, state, ensureSessionBridge, {
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} = {}) {
  switch (ev.type) {
    case 'thread.started':
    case 'thread.created':
    case 'thread.resumed':
      state.threadId = ev.thread_id || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'item.completed':
    case 'item.delta':
    case 'item.updated': {
      const item = ev.item;
      const itemType = String(item?.type || '').trim().toLowerCase();
      if (itemType === 'reasoning') {
        const text = String(item?.text || item?.summary || '').trim();
        if (text) state.reasonings.push(text);
        break;
      }
      if (!['agent_message', 'assistant_message', 'message'].includes(itemType)) break;
      const text = extractAgentMessageText(item);
      if (!text) break;
      if (isFinalAnswerLikeAgentMessage(item)) state.finalAnswerMessages.push(text);
      else state.messages.push(text);
      break;
    }
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
    case 'turn.completed':
      state.usage = ev;
      break;
    default:
      break;
  }
}

export { handleCodexRunnerEvent };

function handleGeminiRunnerEvent(ev, state, ensureSessionBridge) {
  switch (String(ev?.type || '').trim().toLowerCase()) {
    case 'init':
      state.threadId = ev.session_id || ev.sessionId || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'message': {
      if (String(ev.role || '').trim().toLowerCase() !== 'assistant') break;
      const text = String(ev.content || '');
      if (!text) break;
      if (ev.delta === true) {
        state.meta.geminiDeltaBuffer = `${state.meta.geminiDeltaBuffer || ''}${text}`;
      } else {
        state.messages.push(text.trim());
      }
      break;
    }
    case 'result':
      state.usage = ev.stats && typeof ev.stats === 'object' ? ev.stats : ev;
      break;
    default:
      break;
  }
}

export { handleGeminiRunnerEvent };

function handleClaudeRunnerEvent(ev, state, ensureSessionBridge) {
  switch (ev.type) {
    case 'stream_event': {
      const block = ev.event?.content_block;
      if (ev.event?.type === 'content_block_start' && block?.type === 'tool_use') {
        const toolName = String(block.name || '').trim().toLowerCase();
        if (toolName === 'agent') state.meta.claudeSawAgentToolUse = true;
      }
      break;
    }
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
      state.meta.claudeStopReason = ev.stop_reason ?? '';
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

function normalizeComparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasVisibleAssistantText(result) {
  return Boolean(
    (Array.isArray(result?.finalAnswerMessages) && result.finalAnswerMessages.some((item) => String(item || '').trim()))
    || (Array.isArray(result?.messages) && result.messages.some((item) => String(item || '').trim())),
  );
}

export function shouldAutoRecoverClaudeResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (!result.ok || result.cancelled || result.timedOut) return false;

  const meta = result.meta && typeof result.meta === 'object' ? result.meta : null;
  if (!meta?.claudeSawAgentToolUse) return false;
  if (meta.claudeStopReason !== null && meta.claudeStopReason !== '') return false;

  const finalText = normalizeComparableText(result.finalAnswerMessages?.[result.finalAnswerMessages.length - 1] || '');
  const latestMessage = normalizeComparableText(result.messages?.[result.messages.length - 1] || '');
  if (!finalText || !latestMessage) return false;
  return finalText === latestMessage;
}

export function buildClaudeRecoveryPrompt() {
  return [
    '继续刚才的同一任务。',
    '不要把“我来看看 / 我会分析 / 我将研究”之类的过程说明当作最终答案。',
    '请直接完成任务并输出最终答案。',
    '如果确实被工具、权限或外部访问限制卡住，请明确说明阻塞原因和下一步建议，不要只输出一句开场白。',
  ].join('\n');
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
