import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPiFamilySessionMetaBySessionId } from './provider-sessions.js';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config/omp-discord.yml', import.meta.url));
const DEFAULT_PTY_BRIDGE_PATH = fileURLToPath(new URL('../scripts/omp-pty-bridge.exp', import.meta.url));
const TERMINAL_STOP_REASONS = new Set(['stop', 'error', 'aborted']);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalize(value) {
  return String(value || '').trim();
}

function safeMessage(err) {
  return String(err?.message || err || 'unknown error');
}

function collectText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function readOmpSessionJournal(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const sourceLines = raw.split('\n');
  const rows = [];
  let sessionId = null;
  let cwd = null;
  let goal = null;
  let lastGoal = null;
  let goalMode = 'none';
  let latestModeRow = -1;
  const assistantMessages = [];

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      const isIncompleteTail = index === sourceLines.length - 1 && !raw.endsWith('\n');
      if (isIncompleteTail) break;
      throw new Error(`Invalid OMP session journal at line ${index + 1}: ${safeMessage(err)}`);
    }
    const rowIndex = rows.length;
    rows.push(row);
    if (row?.type === 'session') {
      sessionId = normalize(row.id) || sessionId;
      cwd = normalize(row.cwd) || cwd;
      continue;
    }
    if (row?.type === 'mode_change') {
      latestModeRow = rowIndex;
      const mode = normalize(row.mode).toLowerCase();
      if ((mode === 'goal' || mode === 'goal_paused') && row.data?.goal) {
        goalMode = mode;
        goal = { ...row.data.goal };
        lastGoal = { ...row.data.goal };
      } else if (mode === 'none') {
        goalMode = 'none';
        goal = null;
      }
      continue;
    }
    if (row?.type !== 'message' || row.message?.role !== 'assistant') continue;
    const text = collectText(row.message.content);
    assistantMessages.push({
      rowIndex,
      text,
      stopReason: normalize(row.message.stopReason),
      usage: row.message.usage || null,
      message: row.message,
    });
  }

  return {
    file,
    rows,
    rowCount: rows.length,
    sessionId,
    cwd,
    goal,
    lastGoal,
    goalMode,
    latestModeRow,
    assistantMessages,
  };
}

function findFilesRecursive(root, predicate, out = []) {
  if (!root || !fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) findFilesRecursive(fullPath, predicate, out);
    else if (entry.isFile() && predicate(entry.name, fullPath)) out.push(fullPath);
  }
  return out;
}

function findLatestOmpJournal(sessionDir, notOlderThanMs = 0, excludedFiles = new Set()) {
  let latest = null;
  for (const file of findFilesRecursive(sessionDir, (name) => name.endsWith('.jsonl'))) {
    if (excludedFiles.has(file)) continue;
    const stat = fs.statSync(file);
    if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;
    if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs };
  }
  return latest;
}

function defaultSessionDir({ key, spawnEnv }) {
  const home = normalize(spawnEnv?.HOME || spawnEnv?.USERPROFILE || process.env.HOME || process.env.USERPROFILE);
  const agentDir = normalize(spawnEnv?.PI_CODING_AGENT_DIR)
    || (home ? path.join(home, '.omp', 'agent') : '');
  if (!agentDir) throw new Error('Cannot resolve OMP agent directory');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(agentDir, 'sessions', 'discord', digest);
}

function buildRuntimeSignature({ session, workspaceDir, systemPrompt, resolveModelSetting, resolveReasoningEffortSetting, resolveFastModeSetting }) {
  const fastMode = resolveFastModeSetting(session) || {};
  return JSON.stringify({
    workspaceDir: path.resolve(workspaceDir),
    mode: session?.mode || 'safe',
    model: resolveModelSetting(session)?.value || null,
    effort: resolveReasoningEffortSetting(session)?.value || null,
    serviceTier: fastMode.supported ? normalize(fastMode.serviceTier).toLowerCase() : null,
    systemPrompt: normalize(systemPrompt) || null,
  });
}

function buildOmpLaunch({
  ompBin,
  session,
  sessionId,
  sessionDir,
  configPath,
  systemPrompt,
  resolveModelSetting,
  resolveReasoningEffortSetting,
  resolveFastModeSetting,
}) {
  const ompArgs = [ompBin, '--config', configPath, '--session-dir', sessionDir];
  ompArgs.push('--approval-mode', session?.mode === 'dangerous' ? 'yolo' : 'write');
  const model = resolveModelSetting(session)?.value;
  const effort = resolveReasoningEffortSetting(session)?.value;
  const fastMode = resolveFastModeSetting(session) || {};
  if (model) ompArgs.push('--model', model);
  if (effort) ompArgs.push('--thinking', effort);
  if (fastMode.supported) {
    const serviceTier = normalize(fastMode.serviceTier).toLowerCase();
    if (!['none', 'auto', 'default', 'flex', 'scale', 'priority'].includes(serviceTier)) {
      throw new Error(`invalid OMP service tier: ${serviceTier || '(empty)'}`);
    }
    ompArgs.push('--service-tier', serviceTier);
  }
  if (systemPrompt) ompArgs.push('--append-system-prompt', systemPrompt);
  if (sessionId) ompArgs.push('--resume', sessionId);
  return { bin: ompBin, args: ompArgs.slice(1) };
}

function parseNativeGoalCommand(prompt) {
  const match = /^\/goal(?:\s+(set|show|pause|resume|drop)(?:\s+([\s\S]*))?)?\s*$/i.exec(String(prompt || ''));
  if (!match) return null;
  return {
    action: String(match[1] || 'menu').toLowerCase(),
    rest: normalize(match[2]),
  };
}

function formatGoalStatus(journal) {
  const goal = journal?.goal;
  if (!goal) return 'OMP 当前没有 goal。';
  const status = journal.goalMode === 'goal_paused' || goal.status === 'paused'
    ? '已暂停'
    : goal.status === 'complete'
      ? '已完成'
      : '进行中';
  const tokens = Number.isFinite(goal.tokensUsed) ? `\nTokens：${goal.tokensUsed}` : '';
  const budget = Number.isFinite(goal.tokenBudget) ? ` / ${goal.tokenBudget}` : '';
  const elapsed = Number.isFinite(goal.timeUsedSeconds) ? `\n用时：${goal.timeUsedSeconds} 秒` : '';
  return `OMP goal\n目标：${goal.objective}\n状态：${status}${tokens}${budget}${elapsed}`;
}

function buildEmptyResult(error, threadId = null, extras = {}) {
  return {
    ok: false,
    cancelled: false,
    timedOut: false,
    error,
    logs: [],
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    usage: null,
    threadId,
    ...extras,
  };
}

function emptyJournal(file = null) {
  return {
    file,
    rows: [],
    rowCount: 0,
    sessionId: null,
    cwd: null,
    goal: null,
    lastGoal: null,
    goalMode: 'none',
    latestModeRow: -1,
    assistantMessages: [],
  };
}

export function createOmpInteractiveRunner({
  spawnEnv = process.env,
  getProviderBin = () => 'omp',
  getSessionId = () => null,
  resolveModelSetting = () => ({ value: null }),
  resolveReasoningEffortSetting = () => ({ value: null }),
  resolveFastModeSetting = () => ({ supported: false }),
  resolveTimeoutSetting = () => ({ timeoutMs: 0 }),
  normalizeTimeoutMs = (value, fallback) => Number(value || fallback || 0),
  safeError = safeMessage,
  stopChildProcess = (child) => child?.kill?.('SIGTERM'),
  spawnFn = spawn,
  expectBin = '/usr/bin/expect',
  ptyBridgePath = DEFAULT_PTY_BRIDGE_PATH,
  configPath = DEFAULT_CONFIG_PATH,
  resolveSessionDir = defaultSessionDir,
  readSessionMeta = readPiFamilySessionMetaBySessionId,
  readJournal = readOmpSessionJournal,
  pollIntervalMs = 100,
  startupSettleMs = 750,
  localCommandSettleMs = 750,
  localCommandTimeoutMs = 10_000,
  clearConfirmTimeoutMs = 5000,
  inputSubmitDelayMs = 50,
  inputClearDelayMs = 25,
  goalQuietMs = 2500,
  discoveryTimeoutMs = 30_000,
  startupTimeoutMs = 30_000,
  idleMs = 15 * 60_000,
  maxSessions = 8,
  log = (message) => console.log(message),
} = {}) {
  const entries = new Map();
  const lostSessions = new Map();

  function logEvent(event, fields = {}) {
    const detail = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`).join(' ');
    log(`[omp-interactive] ${event}${detail ? ` ${detail}` : ''}`);
  }

  function resolveTurn(entry, result) {
    const turn = entry.currentTurn;
    if (!turn) return;
    entry.currentTurn = null;
    if (turn.timeout) clearTimeout(turn.timeout);
    entry.lastUsedAt = Date.now();
    turn.resolve(result);
    scheduleIdleClose(entry);
  }

  function closeEntry(entry, reason = 'closed') {
    if (!entry || entry.closed) return false;
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entries.delete(entry.key);
    if (entry.currentTurn) {
      resolveTurn(entry, buildEmptyResult(reason, entry.sessionId, {
        cancelled: Boolean(entry.currentTurn?.wasCancelled?.()),
        timedOut: Boolean(entry.currentTurn?.timedOut),
        logs: entry.currentTurn?.logs || [],
      }));
    }
    try {
      stopChildProcess(entry.child);
    } catch {
      try { entry.child?.kill?.('SIGTERM'); } catch {}
    }
    logEvent('close', { key: entry.key, pid: entry.child?.pid ?? 'none', reason });
    return true;
  }

  function scheduleIdleClose(entry) {
    if (!entry || entry.closed || entry.currentTurn) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    let journal = null;
    try {
      journal = entry.journalFile ? readJournal(entry.journalFile) : null;
    } catch (err) {
      lostSessions.set(entry.key, `OMP session journal became unreadable: ${safeError(err)}`);
      closeEntry(entry, 'OMP session journal became unreadable');
      return;
    }
    entry.lastJournal = journal;
    if (journal?.goal) return;
    entry.idleTimer = setTimeout(() => closeEntry(entry, 'idle timeout'), Math.max(0, idleMs));
    entry.idleTimer.unref?.();
  }

  function handleUnexpectedClose(entry, code, signal) {
    if (entry.closed) return;
    entry.closed = true;
    entries.delete(entry.key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const reason = `OMP interactive session was lost${signal ? ` via ${signal}` : ` with code ${code}`}; native goal continuity cannot be guaranteed.`;
    lostSessions.set(entry.key, reason);
    const turn = entry.currentTurn;
    if (turn) {
      entry.currentTurn = null;
      if (turn.timeout) clearTimeout(turn.timeout);
      turn.resolve(buildEmptyResult(reason, entry.sessionId, {
        cancelled: Boolean(turn.wasCancelled?.()),
        timedOut: Boolean(turn.timedOut),
        logs: turn.logs,
      }));
    }
    logEvent('lost', { key: entry.key, pid: entry.child?.pid ?? 'none', code, signal: signal || 'none' });
  }

  function attachProcessHandlers(entry) {
    entry.child.stdout?.on?.('data', (chunk) => {
      const text = String(chunk || '');
      entry.rawOutputTail = `${entry.rawOutputTail}${text}`.slice(-16_000);
      entry.lastOutputAt = Date.now();
      if (entry.rawOutputTail.includes('\u001b[?2004h')) entry.sawTerminalInit = true;
      if (entry.currentTurn) {
        entry.currentTurn.rawOutput = `${entry.currentTurn.rawOutput}${text}`.slice(-32_000);
      }
    });
    entry.child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (!text || !entry.currentTurn) return;
      entry.currentTurn.logs.push(text);
      entry.currentTurn.onLog?.(text, 'stderr');
    });
    entry.child.on?.('error', (err) => {
      if (entry.currentTurn) entry.currentTurn.logs.push(safeError(err));
    });
    entry.child.on?.('close', (code, signal) => handleUnexpectedClose(entry, code, signal));
  }

  async function waitForTuiReady(entry) {
    const deadline = Date.now() + Math.max(1, startupTimeoutMs);
    while (Date.now() <= deadline) {
      if (entry.closed) throw new Error('OMP exited before its interactive TUI became ready');
      if (entry.sawTerminalInit) return;
      await wait(Math.min(50, pollIntervalMs));
    }
    throw new Error('Timed out waiting for OMP interactive TUI readiness');
  }

  function evictIfNeeded() {
    if (entries.size < maxSessions) return;
    const candidates = [...entries.values()]
      .filter((entry) => !entry.currentTurn && !entry.lastJournal?.goal)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (!candidates.length) {
      throw new Error(`OMP interactive session limit reached (${maxSessions}); active goals were not evicted`);
    }
    closeEntry(candidates[0], 'session limit eviction');
  }

  async function createEntry({ key, session, workspaceDir, systemPrompt, signature }) {
    evictIfNeeded();
    const requestedSessionId = normalize(getSessionId(session)) || null;
    let sessionMeta = null;
    if (requestedSessionId) {
      sessionMeta = readSessionMeta('omp', requestedSessionId);
      if (!sessionMeta?.file) throw new Error(`OMP session not found: ${requestedSessionId}`);
    }
    const sessionDir = sessionMeta?.file
      ? path.dirname(sessionMeta.file)
      : resolveSessionDir({ key, session, workspaceDir, spawnEnv });
    fs.mkdirSync(sessionDir, { recursive: true });
    const existingJournalFiles = new Set(findFilesRecursive(sessionDir, (name) => name.endsWith('.jsonl')));
    const launch = buildOmpLaunch({
      ompBin: getProviderBin('omp'),
      session,
      sessionId: requestedSessionId,
      sessionDir,
      configPath,
      systemPrompt,
      resolveModelSetting,
      resolveReasoningEffortSetting,
      resolveFastModeSetting,
    });
    const child = spawnFn(expectBin, ['-f', ptyBridgePath, '--', launch.bin, ...launch.args], {
      cwd: workspaceDir,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (spawnFn === spawn) {
      const framedStdin = child.stdin;
      const writeFrame = framedStdin.write.bind(framedStdin);
      framedStdin.write = (value, callback) => {
        const frame = `${Buffer.from(String(value)).toString('base64')}\n`;
        return writeFrame(frame, callback);
      };
    }
    const entry = {
      key,
      child,
      args: launch.args,
      signature,
      sessionDir,
      sessionId: requestedSessionId,
      journalFile: sessionMeta?.file || null,
      lastJournal: null,
      currentTurn: null,
      idleTimer: null,
      lastUsedAt: Date.now(),
      closed: false,
      rawOutputTail: '',
      lastOutputAt: 0,
      sawTerminalInit: false,
      existingJournalFiles,
    };
    entries.set(key, entry);
    attachProcessHandlers(entry);
    try {
      if (spawnFn === spawn) await waitForTuiReady(entry);
      if (startupSettleMs > 0) await wait(startupSettleMs);
      if (entry.journalFile) {
        entry.lastJournal = readJournal(entry.journalFile);
      } else {
        const latest = findLatestOmpJournal(entry.sessionDir, 0, entry.existingJournalFiles);
        if (latest) {
          entry.journalFile = latest.file;
          entry.lastJournal = readJournal(latest.file);
        }
      }
      entry.sessionId = entry.lastJournal?.sessionId || requestedSessionId;
      if (requestedSessionId && !entry.sessionId) throw new Error('OMP session journal is missing its session id');
      logEvent('spawn', { key, pid: child.pid ?? 'none', sessionId: entry.sessionId, cwd: workspaceDir });
      return entry;
    } catch (err) {
      closeEntry(entry, safeError(err));
      throw err;
    }
  }

  async function getOrCreateEntry({ key, session, workspaceDir, systemPrompt }) {
    const signature = buildRuntimeSignature({
      session,
      workspaceDir,
      systemPrompt,
      resolveModelSetting,
      resolveReasoningEffortSetting,
      resolveFastModeSetting,
    });
    const requestedSessionId = normalize(getSessionId(session)) || null;
    const existing = entries.get(key);
    if (existing) {
      const sessionMatches = !requestedSessionId || requestedSessionId === existing.sessionId;
      if (existing.signature === signature && sessionMatches && !existing.closed) {
        if (existing.idleTimer) clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
        existing.lastUsedAt = Date.now();
        logEvent('reuse', { key, pid: existing.child?.pid ?? 'none', sessionId: existing.sessionId });
        return existing;
      }
      closeEntry(existing, 'runtime config or session changed');
    }
    return createEntry({ key, session, workspaceDir, systemPrompt, signature });
  }

  function validateGoalCommand(command, journal) {
    if (!command) return '';
    const paused = journal?.goalMode === 'goal_paused' || journal?.goal?.status === 'paused';
    const active = Boolean(journal?.goal && !paused);
    if (command.action === 'set' && journal?.goal) return 'OMP goal is already set; clear it before setting another objective.';
    if (command.action === 'pause' && !active) return 'OMP has no active goal to pause.';
    if (command.action === 'resume' && !paused) return 'OMP has no paused goal to resume.';
    if (command.action === 'drop' && !journal?.goal) return 'OMP has no goal to clear.';
    return '';
  }

  function writeInput(entry, prompt, inputImages, callback) {
    const attachments = inputImages.map((file) => normalize(file)).filter(Boolean).map((file) => `@${file}`);
    const text = [String(prompt || ''), ...attachments].filter(Boolean).join('\n');
    const paste = text.includes('\n') ? `\u001b[200~${text}\u001b[201~` : text;
    const confirmAutocomplete = /^\/goal\s+(show|pause|resume|drop)\s*$/i.test(text);
    if (inputSubmitDelayMs <= 0 && inputClearDelayMs <= 0) {
      const testPaste = `\u001b[200~${text}\u001b[201~`;
      entry.child.stdin.write(`${testPaste}\r`, callback);
      return;
    }
    const writePaste = () => entry.child.stdin.write(paste, (err) => {
      if (err) {
        callback?.(err);
        return;
      }
      setTimeout(() => entry.child.stdin.write('\r', (submitErr) => {
        if (submitErr || !confirmAutocomplete) {
          callback?.(submitErr);
          return;
        }
        setTimeout(() => entry.child.stdin.write('\r', callback), inputSubmitDelayMs);
      }), inputSubmitDelayMs);
    });
    entry.child.stdin.write('\u0015', (err) => {
      if (err) {
        callback?.(err);
        return;
      }
      setTimeout(writePaste, inputClearDelayMs);
    });
  }

  function cleanTerminalOutput(value) {
    return String(value || '')
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
  }

  async function waitForTurnOutput(entry, turn, pattern, timeoutMs) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (!entry.closed && entry.currentTurn === turn && Date.now() <= deadline) {
      if (pattern.test(cleanTerminalOutput(turn.rawOutput))) return true;
      await wait(Math.min(50, pollIntervalMs));
    }
    return false;
  }

  async function waitForCommandResult(entry, turn, baseline, command) {
    let emittedRows = baseline.rowCount;
    let terminalCandidate = null;
    let observedRowCount = baseline.rowCount;
    let journalChangedAt = Date.now();
    while (!entry.closed && entry.currentTurn === turn) {
      let journal;
      try {
        if (!entry.journalFile) {
          const latest = findLatestOmpJournal(entry.sessionDir, 0, entry.existingJournalFiles);
          if (latest) entry.journalFile = latest.file;
        }
        journal = entry.journalFile ? readJournal(entry.journalFile) : emptyJournal();
      } catch (err) {
        return buildEmptyResult(`OMP session journal read failed: ${safeError(err)}`, entry.sessionId, { logs: turn.logs });
      }
      entry.lastJournal = journal;
      if (journal.rowCount !== observedRowCount) {
        observedRowCount = journal.rowCount;
        journalChangedAt = Date.now();
      }
      if (!entry.sessionId && journal.sessionId) {
        entry.sessionId = journal.sessionId;
        turn.onThreadReady?.(journal.sessionId);
      }
      for (let index = emittedRows; index < journal.rows.length; index += 1) {
        const row = journal.rows[index];
        turn.onEvent?.(row?.type === 'message' ? { ...row, type: 'message_end' } : row);
      }
      emittedRows = journal.rowCount;

      if (command?.action === 'show') {
        const visible = cleanTerminalOutput(turn.rawOutput);
        if (/Objective:\s|No goal set\./i.test(visible) && !turn.localOutputSeenAt) {
          turn.localOutputSeenAt = Date.now();
        }
        if (turn.localOutputSeenAt && Date.now() - turn.localOutputSeenAt >= localCommandSettleMs) {
          const text = formatGoalStatus(journal);
          return { ...buildEmptyResult('', entry.sessionId), ok: true, finalAnswerMessages: [text], messages: [text] };
        }
      } else if (command?.action === 'pause') {
        if (journal.latestModeRow >= baseline.rowCount && journal.goalMode === 'goal_paused') {
          const text = `OMP goal 已暂停。\n${formatGoalStatus(journal)}`;
          return { ...buildEmptyResult('', entry.sessionId), ok: true, finalAnswerMessages: [text], messages: [text] };
        }
      } else if (command?.action === 'drop') {
        if (journal.latestModeRow >= baseline.rowCount && journal.goalMode === 'none' && !journal.goal) {
          const text = 'OMP goal 已清除。';
          return { ...buildEmptyResult('', entry.sessionId), ok: true, finalAnswerMessages: [text], messages: [text] };
        }
      }

      if (['show', 'pause', 'drop'].includes(command?.action)
        && Date.now() - turn.startedAt >= localCommandTimeoutMs) {
        const detail = cleanTerminalOutput(turn.rawOutput).replace(/\s+/g, ' ').trim();
        return buildEmptyResult(
          detail
            ? `OMP goal ${command.action} did not complete: ${detail.slice(-1000)}`
            : `OMP goal ${command.action} did not complete`,
          entry.sessionId,
          { logs: turn.logs },
        );
      }

      if (!entry.journalFile && Date.now() - turn.startedAt >= discoveryTimeoutMs) {
        const detail = entry.rawOutputTail.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ').trim();
        return buildEmptyResult(
          detail
            ? `Timed out waiting for OMP interactive session journal: ${detail.slice(-1000)}`
            : 'Timed out waiting for OMP interactive session journal',
          entry.sessionId,
          { logs: turn.logs },
        );
      }

      const terminal = journal.assistantMessages
        .filter((message) => message.rowIndex >= baseline.rowCount && TERMINAL_STOP_REASONS.has(message.stopReason))
        .at(-1);
      if (terminal && terminal.rowIndex !== terminalCandidate?.rowIndex) {
        terminalCandidate = terminal;
      }
      if (terminalCandidate) {
        if (terminalCandidate.stopReason !== 'stop') {
          return buildEmptyResult(
            terminalCandidate.text || `OMP turn ended with stop reason: ${terminalCandidate.stopReason}`,
            entry.sessionId,
            { logs: turn.logs, usage: terminalCandidate.usage },
          );
        }
        const activeGoalNeedsQuietWindow = Boolean(journal.goal && journal.goalMode === 'goal');
        if (!activeGoalNeedsQuietWindow || Date.now() - journalChangedAt >= goalQuietMs) {
          if (!terminalCandidate.text) {
            return buildEmptyResult('OMP returned a terminal assistant turn without visible output', entry.sessionId, { logs: turn.logs });
          }
          const texts = journal.assistantMessages
            .filter((message) => message.rowIndex >= baseline.rowCount && message.text)
            .map((message) => message.text);
          return {
            ...buildEmptyResult('', entry.sessionId),
            ok: true,
            messages: texts,
            finalAnswerMessages: [terminalCandidate.text],
            usage: terminalCandidate.usage,
          };
        }
      }
      await wait(pollIntervalMs);
    }
    return buildEmptyResult('OMP interactive session closed before the command completed', entry.sessionId, { logs: turn.logs });
  }

  async function runTask({
    session,
    sessionKey,
    workspaceDir,
    prompt,
    systemPrompt = '',
    inputImages = [],
    onSpawn,
    onThreadReady,
    wasCancelled,
    onEvent,
    onLog,
  } = {}) {
    const key = normalize(sessionKey || workspaceDir);
    if (!key) return buildEmptyResult('missing OMP interactive session key');
    const lostReason = lostSessions.get(key);
    if (lostReason) {
      lostSessions.delete(key);
      return buildEmptyResult(lostReason, normalize(getSessionId(session)) || null);
    }

    let entry;
    try {
      entry = await getOrCreateEntry({ key, session, workspaceDir, systemPrompt: normalize(systemPrompt) });
    } catch (err) {
      return buildEmptyResult(safeError(err), normalize(getSessionId(session)) || null);
    }
    if (entry.currentTurn) return buildEmptyResult('OMP interactive session already has an active turn', entry.sessionId);
    onSpawn?.(entry.child);
    if (entry.sessionId) onThreadReady?.(entry.sessionId);

    let baseline;
    try {
      baseline = entry.journalFile ? readJournal(entry.journalFile) : emptyJournal();
      entry.lastJournal = baseline;
    } catch (err) {
      return buildEmptyResult(`OMP session journal read failed: ${safeError(err)}`, entry.sessionId);
    }
    const command = parseNativeGoalCommand(prompt);
    const nativeStateError = validateGoalCommand(command, baseline);

    return new Promise((resolve) => {
      const timeoutMs = normalizeTimeoutMs(resolveTimeoutSetting(session)?.timeoutMs, 0);
      const turn = {
        resolve,
        wasCancelled,
        onEvent,
        onLog,
        onThreadReady,
        logs: [],
        timeout: null,
        timedOut: false,
        startedAt: Date.now(),
        rawOutput: '',
        localOutputSeenAt: 0,
      };
      entry.currentTurn = turn;
      if (timeoutMs > 0) {
        turn.timeout = setTimeout(() => {
          turn.timedOut = true;
          closeEntry(entry, 'OMP interactive runner timed out');
        }, timeoutMs);
        turn.timeout.unref?.();
      }

      try {
        writeInput(entry, prompt, inputImages, async (err) => {
          if (err) {
            closeEntry(entry, `OMP interactive stdin write failed: ${safeError(err)}`);
            return;
          }
          if (command?.action === 'drop' && !nativeStateError) {
            const confirmationVisible = await waitForTurnOutput(entry, turn, /Drop goal\?/i, clearConfirmTimeoutMs);
            if (!confirmationVisible) {
              if (entry.currentTurn === turn) {
                resolveTurn(entry, buildEmptyResult('OMP goal clear confirmation did not appear', entry.sessionId, { logs: turn.logs }));
              }
              return;
            }
            try {
              entry.child.stdin.write('\r');
            } catch (confirmErr) {
              closeEntry(entry, `OMP goal clear confirmation failed: ${safeError(confirmErr)}`);
              return;
            }
          }
          if (nativeStateError) {
            await wait(localCommandSettleMs);
            if (entry.currentTurn === turn) resolveTurn(entry, buildEmptyResult(nativeStateError, entry.sessionId, { logs: turn.logs }));
            return;
          }
          const result = await waitForCommandResult(entry, turn, baseline, command);
          if (entry.currentTurn === turn) resolveTurn(entry, result);
        });
      } catch (err) {
        closeEntry(entry, `OMP interactive stdin write failed: ${safeError(err)}`);
      }
    });
  }

  function closeSession(sessionKey, reason = 'closed') {
    return closeEntry(entries.get(normalize(sessionKey)), reason);
  }

  function closeAll(reason = 'closed') {
    let closed = 0;
    for (const entry of [...entries.values()]) {
      if (closeEntry(entry, reason)) closed += 1;
    }
    return closed;
  }

  function getSnapshot() {
    return [...entries.values()]
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .map((entry) => ({
        key: entry.key,
        pid: entry.child?.pid ?? null,
        sessionId: entry.sessionId,
        sessionDir: entry.sessionDir,
        journalFile: entry.journalFile,
        excludedJournalFiles: [...entry.existingJournalFiles],
        active: Boolean(entry.currentTurn),
        goal: entry.lastJournal?.goal || null,
        lastUsedAt: entry.lastUsedAt,
      }));
  }

  return { runTask, closeSession, closeAll, getSnapshot };
}
