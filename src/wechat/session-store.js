import fs from 'node:fs';
import path from 'node:path';

import {
  listRecentSessions,
  readCodexSessionMetaBySessionId,
} from '../provider-sessions.js';
import { readJson, writeJson } from './storage.js';

function normalizeOptionalString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase() === 'dangerous' ? 'dangerous' : 'safe';
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function readCodexSessionPreview(file, maxBytes = 2 * 1024 * 1024) {
  if (!file) return '';
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.trim()) continue;
      let item = null;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (item?.type !== 'event_msg' || item?.payload?.type !== 'user_message') continue;
      const text = String(item.payload.message || '').replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('<')) continue;
      return text.length > 72 ? `${text.slice(0, 69)}...` : text;
    }
  } catch {
    return '';
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
    }
  }
  return '';
}

export function createWechatSessionStore({
  dataFile,
  defaultWorkspaceDir,
  workspaceRoots = [],
  recentLimit = 10,
  now = () => new Date(),
  listRecentSessionsFn = listRecentSessions,
  readSessionMetaFn = readCodexSessionMetaBySessionId,
} = {}) {
  const roots = [...new Set(
    workspaceRoots
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => fs.realpathSync(path.resolve(item))),
  )];
  const db = readJson(dataFile, { version: 1, users: {} });
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(db) || !isRecord(db.users)
    || (db.version !== undefined && db.version !== 1)
    || Object.values(db.users).some((session) => !isRecord(session))) {
    throw new Error(`Invalid WeChat session state in ${dataFile}; preserve the file and repair it before restarting`);
  }
  const recentSelections = new Map();

  function save() {
    writeJson(dataFile, db);
  }

  function ensureWorkspaceAllowed(workspaceDir) {
    const resolved = path.resolve(String(workspaceDir || ''));
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`工作目录不存在: ${resolved}`);
    }
    const canonical = fs.realpathSync(resolved);
    if (roots.length && !roots.some((root) => isWithinRoot(canonical, root))) {
      throw new Error(`工作目录不在 WECHAT_WORKSPACE_ROOTS 允许范围内: ${resolved}`);
    }
    return canonical;
  }

  function get(userId) {
    const key = String(userId || '').trim();
    if (!key) throw new Error('missing WeChat user id');
    if (!db.users[key]) {
      db.users[key] = {
        provider: 'codex',
        sessionId: null,
        workspaceDir: ensureWorkspaceAllowed(defaultWorkspaceDir),
        model: null,
        effort: null,
        mode: 'safe',
        updatedAt: now().toISOString(),
      };
      save();
    }
    const session = db.users[key];
    session.provider = 'codex';
    session.sessionId = normalizeOptionalString(session.sessionId);
    session.workspaceDir = ensureWorkspaceAllowed(session.workspaceDir || defaultWorkspaceDir);
    session.model = normalizeOptionalString(session.model);
    session.effort = normalizeOptionalString(session.effort);
    session.mode = normalizeMode(session.mode);
    return session;
  }

  function update(userId, patch) {
    const session = get(userId);
    // Validate before changing the live binding (including cached /resume selections).
    const next = { ...session, ...patch, updatedAt: now().toISOString() };
    next.sessionId = normalizeOptionalString(next.sessionId);
    next.model = normalizeOptionalString(next.model);
    next.effort = normalizeOptionalString(next.effort);
    next.mode = normalizeMode(next.mode);
    next.workspaceDir = ensureWorkspaceAllowed(next.workspaceDir);
    Object.assign(session, next);
    save();
    return session;
  }

  function listRecent(userId, limit = recentLimit) {
    const items = listRecentSessionsFn({ provider: 'codex', limit })
      .map((item) => {
        const meta = readSessionMetaFn(item.id);
        if (!meta?.cwd) return null;
        try {
          ensureWorkspaceAllowed(meta.cwd);
        } catch {
          return null;
        }
        return {
          id: item.id,
          mtime: item.mtime,
          workspaceDir: meta.cwd,
          preview: readCodexSessionPreview(meta.file),
        };
      })
      .filter(Boolean);
    recentSelections.set(String(userId), items);
    return items;
  }

  function resolveResumeTarget(userId, selector) {
    const text = String(selector || '').trim();
    if (!text) throw new Error('请使用 /resume <编号|thread-id>');
    if (/^\d+$/.test(text)) {
      let items = recentSelections.get(String(userId));
      if (!items) items = listRecent(userId);
      const item = items[Number(text) - 1];
      if (!item) throw new Error(`会话编号不存在: ${text}`);
      return item;
    }
    const meta = readSessionMetaFn(text);
    if (!meta?.cwd) throw new Error(`找不到 Codex 会话: ${text}`);
    return {
      id: text,
      mtime: meta.mtimeMs,
      workspaceDir: ensureWorkspaceAllowed(meta.cwd),
    };
  }

  function bind(userId, selector) {
    const target = resolveResumeTarget(userId, selector);
    return update(userId, {
      sessionId: target.id,
      workspaceDir: target.workspaceDir,
    });
  }

  function startNew(userId) {
    return update(userId, { sessionId: null });
  }

  function setWorkspace(userId, workspaceDir) {
    return update(userId, {
      workspaceDir: ensureWorkspaceAllowed(workspaceDir),
      sessionId: null,
    });
  }

  return {
    get,
    update,
    listRecent,
    resolveResumeTarget,
    bind,
    startNew,
    setWorkspace,
    ensureWorkspaceAllowed,
  };
}
