import fs from 'node:fs';
import path from 'node:path';

import { normalizeProvider } from './provider-metadata.js';

export function listRecentSessions({ provider = 'codex', workspaceDir = '', limit = 10 } = {}) {
  switch (normalizeProvider(provider)) {
    case 'claude':
      return listRecentClaudeSessions(limit, workspaceDir);
    case 'cursor':
      return listRecentCursorSessions(limit, workspaceDir);
    case 'grok':
      return listRecentGrokSessions(limit, workspaceDir);
    case 'antigravity':
      return listRecentAntigravitySessions(limit, workspaceDir);
    case 'zcode':
      return listRecentZCodeSessions(limit);
    case 'pi':
      return listRecentPiFamilySessions('pi', limit, workspaceDir);
    case 'omp':
      return listRecentPiFamilySessions('omp', limit, workspaceDir);
    default:
      return listRecentCodexSessions(limit);
  }
}

function getCursorChatsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.cursor', 'chats') : '';
}

function readCursorSessionMetaFile(metaPath) {
  const meta = readJsonFile(metaPath);
  if (!meta || typeof meta !== 'object') return null;
  const id = String(path.basename(path.dirname(metaPath)) || '').trim();
  const cwd = String(meta.cwd || '').trim();
  if (!id || !cwd) return null;
  return {
    id,
    cwd: path.resolve(cwd),
    meta,
    file: metaPath,
  };
}

function listRecentCursorSessions(limit = 10, workspaceDir = '') {
  const chatsRoot = getCursorChatsDir();
  if (!chatsRoot || !fs.existsSync(chatsRoot)) return [];
  const targetWorkspace = String(workspaceDir || '').trim();
  const sessions = [];
  for (const file of findFilesRecursive(chatsRoot, (name) => name === 'meta.json')) {
    const session = readCursorSessionMetaFile(file);
    if (!session) continue;
    if (targetWorkspace && path.resolve(session.cwd) !== path.resolve(targetWorkspace)) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const updatedAtMs = Number(session.meta.updatedAtMs);
      sessions.push({
        id: session.id,
        mtime: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : stat.mtimeMs,
      });
    } catch {
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function readCursorSessionMetaBySessionId(sessionId, notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim();
  const chatsRoot = getCursorChatsDir();
  if (!targetId || !chatsRoot || !fs.existsSync(chatsRoot)) return null;
  let latest = null;
  for (const file of findFilesRecursive(chatsRoot, (name, fullPath) => (
    name === 'meta.json' && path.basename(path.dirname(fullPath)) === targetId
  ))) {
    try {
      const stat = fs.statSync(file);
      const session = readCursorSessionMetaFile(file);
      if (!stat.isFile() || !session) continue;
      const updatedAtMs = Number(session.meta.updatedAtMs);
      const mtimeMs = Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : stat.mtimeMs;
      if (notOlderThanMs > 0 && mtimeMs < notOlderThanMs) continue;
      if (!latest || mtimeMs > latest.mtimeMs) latest = { ...session, mtimeMs };
    } catch {
    }
  }
  return latest;
}

function getGrokSessionsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.grok', 'sessions') : '';
}

function readGrokSessionSummary(summaryPath) {
  const summary = readJsonFile(summaryPath);
  if (!summary || typeof summary !== 'object') return null;
  const sessionDir = path.dirname(summaryPath);
  const info = summary.info && typeof summary.info === 'object' ? summary.info : {};
  const id = String(summary.id || summary.sessionId || summary.session_id || info.id || path.basename(sessionDir)).trim();
  if (!id) return null;
  const encodedCwd = path.basename(path.dirname(sessionDir));
  let decodedCwd = '';
  try {
    decodedCwd = decodeURIComponent(encodedCwd);
  } catch {
    decodedCwd = '';
  }
  const cwd = String(
    summary.cwd
      || summary.workingDirectory
      || summary.working_directory
      || summary.workspaceDir
      || summary.workspace_dir
      || info.cwd
      || decodedCwd,
  ).trim();
  return { id, cwd, summary, file: summaryPath };
}

function listRecentGrokSessions(limit = 10, workspaceDir = '') {
  const sessionsRoot = getGrokSessionsDir();
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return [];
  const targetWorkspace = String(workspaceDir || '').trim();
  const sessions = [];
  for (const file of findFilesRecursive(sessionsRoot, (name) => name === 'summary.json')) {
    const meta = readGrokSessionSummary(file);
    if (!meta) continue;
    if (targetWorkspace && (!meta.cwd || path.resolve(meta.cwd) !== path.resolve(targetWorkspace))) continue;
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) sessions.push({ id: meta.id, mtime: stat.mtimeMs });
    } catch {
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function readGrokSessionMetaBySessionId(sessionId, notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim();
  const sessionsRoot = getGrokSessionsDir();
  if (!targetId || !sessionsRoot || !fs.existsSync(sessionsRoot)) return null;
  let latest = null;
  for (const file of findFilesRecursive(sessionsRoot, (name, fullPath) => (
    name === 'summary.json' && path.basename(path.dirname(fullPath)) === targetId
  ))) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs)) continue;
      const meta = readGrokSessionSummary(file);
      if (!meta?.cwd) continue;
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { ...meta, mtimeMs: stat.mtimeMs };
    } catch {
    }
  }
  return latest;
}

function listRecentPiFamilySessions(provider, limit = 10, workspaceDir = '') {
  const sessionsRoot = getPiFamilySessionsDir(provider);
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return [];

  const targetWorkspace = String(workspaceDir || '').trim();
  const latestById = new Map();
  for (const file of findFilesRecursive(sessionsRoot, (name) => name.endsWith('.jsonl'))) {
    const header = readFirstJsonLine(file);
    if (header?.type !== 'session') continue;
    const id = String(header.id || '').trim();
    const cwd = String(header.cwd || '').trim();
    if (!id || (targetWorkspace && (!cwd || path.resolve(cwd) !== path.resolve(targetWorkspace)))) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const previous = latestById.get(id);
      if (!previous || stat.mtimeMs > previous.mtime) {
        latestById.set(id, { id, mtime: stat.mtimeMs });
      }
    } catch {
    }
  }
  return [...latestById.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

export function readPiFamilySessionMetaBySessionId(provider, sessionId, notOlderThanMs = 0) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider !== 'pi' && normalizedProvider !== 'omp') return null;
  const targetId = String(sessionId || '').trim();
  const sessionsRoot = getPiFamilySessionsDir(normalizedProvider);
  if (!targetId || !sessionsRoot || !fs.existsSync(sessionsRoot)) return null;

  let latest = null;
  for (const file of findFilesRecursive(sessionsRoot, (name) => name.endsWith('.jsonl'))) {
    const header = readFirstJsonLine(file);
    if (header?.type !== 'session' || String(header.id || '').trim() !== targetId) continue;
    const cwd = String(header.cwd || '').trim();
    if (!cwd) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs)) continue;
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = {
          cwd: path.resolve(cwd),
          file,
          mtimeMs: stat.mtimeMs,
        };
      }
    } catch {
    }
  }
  return latest;
}

function listRecentZCodeSessions(limit = 10) {
  const rolloutDir = getZCodeRolloutDir();
  if (!rolloutDir || !fs.existsSync(rolloutDir)) return [];

  const sessions = [];
  for (const filename of fs.readdirSync(rolloutDir)) {
    const match = /^model-io-(sess_.+)\.jsonl$/.exec(filename);
    if (!match?.[1]) continue;
    const file = path.join(rolloutDir, filename);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) sessions.push({ id: match[1], mtime: stat.mtimeMs });
    } catch {
    }
  }
  return sessions
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function listRecentCodexSessions(limit = 10) {
  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return [];

  const files = findCodexRolloutFiles(sessionsDir);
  const latestById = new Map();

  for (const file of files) {
    const id = parseSessionIdFromRolloutFile(path.basename(file));
    if (!id) continue;

    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }

    const previous = latestById.get(id);
    if (!previous || mtime > previous.mtime) {
      latestById.set(id, { id, mtime });
    }
  }

  return [...latestById.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function listRecentClaudeSessions(limit = 10, workspaceDir = '') {
  const preferredRoot = getClaudeProjectDir(workspaceDir);
  const searchRoot = preferredRoot && fs.existsSync(preferredRoot) ? preferredRoot : getClaudeProjectsDir();
  if (!searchRoot || !fs.existsSync(searchRoot)) return [];

  return findClaudeSessionFiles(searchRoot)
    .map((file) => {
      const id = parseClaudeSessionIdFromFile(path.basename(file));
      if (!id) return null;
      try {
        const stat = fs.statSync(file);
        return stat.isFile() ? { id, mtime: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function getZCodeRolloutDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.zcode', 'cli', 'rollout') : '';
}

function extractZCodeRolloutWorkspace(row) {
  const system = Array.isArray(row?.request?.body?.system) ? row.request.body.system : [];
  for (const part of system) {
    const text = String(part?.text || '').trim();
    const match = text.match(/(?:^|\n)- Primary working directory:\s*([^\n]+)/);
    const workspaceDir = String(match?.[1] || '').trim();
    if (workspaceDir) return path.resolve(workspaceDir);
  }
  return null;
}

export function findLatestZCodeRolloutFile({
  sessionId = '',
  workspaceDir = '',
  notOlderThanMs = 0,
} = {}) {
  const targetSessionId = String(sessionId || '').trim();
  const targetWorkspaceDir = String(workspaceDir || '').trim();
  if (!targetSessionId && !targetWorkspaceDir) return null;

  const rolloutDir = getZCodeRolloutDir();
  if (!rolloutDir || !fs.existsSync(rolloutDir)) return null;
  const normalizedWorkspaceDir = targetWorkspaceDir ? path.resolve(targetWorkspaceDir) : null;
  let latest = null;

  for (const filename of fs.readdirSync(rolloutDir)) {
    const match = /^model-io-(sess_.+)\.jsonl$/.exec(filename);
    const candidateSessionId = String(match?.[1] || '').trim();
    if (!candidateSessionId) continue;
    if (targetSessionId && candidateSessionId !== targetSessionId) continue;

    const file = path.join(rolloutDir, filename);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs)) continue;

    if (normalizedWorkspaceDir) {
      const first = readFirstJsonLine(file);
      if (extractZCodeRolloutWorkspace(first) !== normalizedWorkspaceDir) continue;
    }
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        file,
        sessionId: candidateSessionId,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    }
  }

  return latest;
}

function listRecentAntigravitySessions(limit = 10, workspaceDir = '') {
  const antigravityConversation = readAntigravityLastConversation(workspaceDir);
  if (antigravityConversation?.id) {
    return [{
      id: antigravityConversation.id,
      mtime: antigravityConversation.mtime,
    }];
  }
  return [];
}

export function findLatestRolloutFileBySessionId(sessionId, notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return null;

  const files = findCodexRolloutFiles(sessionsDir);
  let latest = null;

  for (const file of files) {
    const id = parseSessionIdFromRolloutFile(path.basename(file));
    if (!id || String(id).toLowerCase() !== targetId) continue;

    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat?.isFile()) continue;
    if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        file,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    }
  }

  return latest;
}

function readFirstJsonLine(filePath, maxBytes = 128 * 1024) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat?.isFile?.()) return null;
      const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
      if (bytesToRead <= 0) return null;
      const buf = Buffer.allocUnsafe(bytesToRead);
      const readBytes = fs.readSync(fd, buf, 0, bytesToRead, 0);
      const chunk = buf.toString('utf8', 0, readBytes);
      const line = chunk.split('\n')[0] || '';
      if (!line.trim()) return null;
      return JSON.parse(line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readFirstJsonLineMatching(filePath, predicate, maxBytes = 512 * 1024) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat?.isFile?.()) return null;
      const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
      if (bytesToRead <= 0) return null;
      const buf = Buffer.allocUnsafe(bytesToRead);
      const readBytes = fs.readSync(fd, buf, 0, bytesToRead, 0);
      const chunk = buf.toString('utf8', 0, readBytes);
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (predicate(parsed)) return parsed;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return null;
}

function extractSessionCwd(line) {
  return String(line?.cwd || line?.payload?.cwd || '').trim();
}

export function readCodexSessionMetaBySessionId(sessionId, notOlderThanMs = 0) {
  const match = findLatestRolloutFileBySessionId(sessionId, notOlderThanMs);
  if (!match?.file) return null;

  const first = readFirstJsonLine(match.file);
  const payload = first && typeof first === 'object' ? first.payload : null;
  const cwd = String(payload?.cwd || '').trim();
  if (!cwd) return null;

  return {
    cwd: path.resolve(cwd),
    file: match.file,
    mtimeMs: Number(match.mtimeMs) || 0,
  };
}

export function findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const roots = [];
  const preferredRoot = getClaudeProjectDir(workspaceDir);
  if (preferredRoot) roots.push(preferredRoot);
  const projectsRoot = getClaudeProjectsDir();
  if (projectsRoot && !roots.includes(projectsRoot)) roots.push(projectsRoot);

  let latest = null;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const file of findClaudeSessionFiles(root)) {
      const id = parseClaudeSessionIdFromFile(path.basename(file));
      if (!id || String(id).toLowerCase() !== targetId) continue;

      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat?.isFile()) continue;
      if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      }
    }
    if (latest) return latest;
  }

  return latest;
}

export function readClaudeSessionMetaBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const match = findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir, notOlderThanMs);
  if (!match?.file) return null;

  const firstWithCwd = readFirstJsonLineMatching(match.file, (line) => Boolean(extractSessionCwd(line)));
  const cwd = extractSessionCwd(firstWithCwd);
  if (!cwd) return null;

  return {
    cwd: path.resolve(cwd),
    file: match.file,
    mtimeMs: Number(match.mtimeMs) || 0,
  };
}

export function buildClaudeSessionRescueSummary({
  sessionId,
  workspaceDir = '',
  maxTaskItems = 24,
  maxAssistantItems = 8,
} = {}) {
  const match = findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir);
  if (!match?.file) {
    return { ok: false, error: 'claude session file not found', summary: '' };
  }

  const rows = readJsonLines(match.file);
  if (!rows.length) {
    return { ok: false, error: 'claude session file is empty', summary: '' };
  }

  const taskResults = [];
  const assistantNotes = [];
  const errors = [];
  let lastPrompt = '';

  for (const row of rows) {
    if (row?.type === 'last-prompt') {
      const prompt = normalizeOneLine(row.lastPrompt || '');
      if (prompt) lastPrompt = prompt;
      continue;
    }

    if (row?.type === 'user') {
      const text = extractClaudeRowText(row);
      const prompt = normalizeOneLine(text);
      if (prompt && !prompt.includes('<task-notification>') && !prompt.includes('请压缩总结当前会话上下文')) {
        lastPrompt = prompt;
      }
      const task = extractTaskNotification(text);
      if (task) taskResults.push(task);
      continue;
    }

    if (row?.type !== 'assistant') continue;
    const text = extractClaudeRowText(row);
    const normalized = normalizeOneLine(text);
    if (!normalized) continue;
    if (row.isApiErrorMessage || normalized.includes('context window limit') || normalized.includes('API Error')) {
      errors.push(normalized);
      continue;
    }
    assistantNotes.push(normalized);
  }

  const recentTasks = taskResults.slice(-Math.max(1, maxTaskItems));
  const recentAssistantNotes = assistantNotes.slice(-Math.max(1, maxAssistantItems));
  if (!recentTasks.length && !recentAssistantNotes.length && !lastPrompt) {
    return { ok: false, error: 'no compactable Claude session content found', summary: '' };
  }

  const completedTasks = taskResults.filter((item) => item.status === 'completed').length;
  const failedTasks = taskResults.filter((item) => item.status && item.status !== 'completed').length;
  const lines = [
    `目标：延续 Claude project session ${sessionId} 的工作。该 session 已超过上下文窗，以下摘要从本地 session 文件救援提取，不是模型原生压缩。`,
    lastPrompt ? `最近用户意图：${truncateText(lastPrompt, 260)}` : '',
    `进展概览：本地记录中识别到 ${taskResults.length} 个任务通知，其中完成 ${completedTasks} 个${failedTasks ? `，非完成 ${failedTasks} 个` : ''}。`,
    recentTasks.length ? '最近任务结果：' : '',
    ...recentTasks.map((item) => {
      const parts = [
        item.summary || item.id || '未命名任务',
        item.status ? `状态 ${item.status}` : '',
        item.outputFile ? `输出 ${item.outputFile}` : '',
        item.result ? truncateText(item.result, 220) : '',
      ].filter(Boolean);
      return `- ${parts.join('；')}`;
    }),
    recentAssistantNotes.length ? '最近可见回复：' : '',
    ...recentAssistantNotes.map((note) => `- ${truncateText(note, 220)}`),
    errors.length ? `风险与约束：最近出现 ${errors.length} 次 API/context 错误，最新错误是 ${truncateText(errors[errors.length - 1], 180)}。后续必须使用新 session 继续，不能再 resume 旧 session。` : '风险与约束：旧 session 已接近或超过上下文窗，后续必须使用新 session 继续。',
    '下一步建议：从最近用户意图继续；如果是在批量报告任务中，先盘点已生成目录和失败项，再用小批次继续，避免把完整历史和大量 task-notification 重新塞回上下文。',
  ].filter(Boolean);

  return {
    ok: true,
    summary: truncateText(lines.join('\n'), 6000),
    sourceFile: match.file,
  };
}

export function resolveAntigravityProjectRootBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim();
  if (!targetId) return null;

  const antigravityConversation = readAntigravityLastConversation(workspaceDir);
  if (antigravityConversation?.id && antigravityConversation.id === targetId) {
    return path.resolve(workspaceDir);
  }

  const conversations = readAntigravityLastConversationsFile();
  if (!conversations) return null;
  if (notOlderThanMs > 0 && conversations.mtime < notOlderThanMs) return null;
  for (const [candidateWorkspace, conversationId] of Object.entries(conversations.map)) {
    if (String(conversationId || '').trim() === targetId && candidateWorkspace) {
      return path.resolve(candidateWorkspace);
    }
  }
  return null;
}

function getCodexSessionsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.codex', 'sessions');
}

function getPiFamilySessionsDir(provider) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, provider === 'omp' ? '.omp' : '.pi', 'agent', 'sessions');
}

function getAntigravityDataRootDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.gemini');
}

function getAntigravityCliDir() {
  const root = getAntigravityDataRootDir();
  if (!root) return '';
  return path.join(root, 'antigravity-cli');
}

function readAntigravityLastConversationsFile() {
  const cliDir = getAntigravityCliDir();
  if (!cliDir) return null;
  const file = path.join(cliDir, 'cache', 'last_conversations.json');
  const parsed = readJsonFile(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  let mtime = Date.now();
  try {
    const stat = fs.statSync(file);
    if (stat?.isFile()) mtime = stat.mtimeMs;
  } catch {
  }
  return { map: parsed, file, mtime };
}

function readAntigravityLastConversation(workspaceDir = '', notOlderThanMs = 0) {
  const rawWorkspace = String(workspaceDir || '').trim();
  if (!rawWorkspace) return null;

  const conversations = readAntigravityLastConversationsFile();
  if (!conversations) return null;

  const normalizedWorkspace = path.resolve(rawWorkspace);
  const directId = String(conversations.map[normalizedWorkspace] || conversations.map[rawWorkspace] || '').trim();
  if (!directId) return null;

  if (notOlderThanMs > 0 && conversations.mtime < notOlderThanMs) return null;

  return {
    id: directId,
    mtime: conversations.mtime,
    file: conversations.file,
  };
}

function getClaudeProjectsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.claude', 'projects');
}

function getClaudeProjectDir(workspaceDir = '') {
  const projectsRoot = getClaudeProjectsDir();
  const slug = encodeClaudeProjectPath(workspaceDir);
  if (!projectsRoot || !slug) return '';
  return path.join(projectsRoot, slug);
}

function encodeClaudeProjectPath(workspaceDir = '') {
  const raw = String(workspaceDir || '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/[\\/]/g, '-');
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        try {
          return JSON.parse(trimmed);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractClaudeRowText(row) {
  const parts = [];
  collectTextParts(row?.message, parts);
  collectTextParts(row?.content, parts);
  return parts.join('\n\n').trim();
}

function collectTextParts(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, out);
    return;
  }
  if (typeof value !== 'object') return;
  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'thinking' || type === 'tool_use') return;
  collectTextParts(value.text, out);
  collectTextParts(value.result, out);
  collectTextParts(value.content, out);
}

function extractTaskNotification(text) {
  const raw = String(text || '');
  if (!raw.includes('<task-notification>')) return null;
  return {
    id: extractTag(raw, 'task-id'),
    status: extractTag(raw, 'status'),
    summary: extractTag(raw, 'summary'),
    outputFile: extractTag(raw, 'output-file'),
    result: normalizeOneLine(stripMarkdown(extractTag(raw, 'result'))),
  };
}

function extractTag(text, tag) {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return String(text.match(pattern)?.[1] || '').trim();
}

function normalizeOneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1');
}

function truncateText(value, maxChars) {
  const text = String(value || '').trim();
  const max = Math.max(20, Number(maxChars) || 200);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function findFilesRecursive(root, predicate) {
  const out = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && predicate(entry.name, fullPath)) {
        out.push(fullPath);
      }
    }
  }

  return out;
}

function findCodexRolloutFiles(root) {
  return findFilesRecursive(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
}

function findClaudeSessionFiles(root) {
  return findFilesRecursive(root, (name) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i.test(name));
}

function parseSessionIdFromRolloutFile(filename) {
  const match = filename.match(/^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function parseClaudeSessionIdFromFile(filename) {
  const match = String(filename || '').match(/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readAntigravitySessionState({ sessionId, workspaceDir = '', notOlderThanMs = 0 } = {}) {
  const antigravityConversation = readAntigravityLastConversation(workspaceDir, notOlderThanMs);
  if (antigravityConversation?.id && (!sessionId || antigravityConversation.id === String(sessionId || '').trim())) {
    return {
      sessionId: antigravityConversation.id,
      messages: [],
      finalAnswer: '',
      usage: null,
      file: antigravityConversation.file,
    };
  }
  return null;
}
