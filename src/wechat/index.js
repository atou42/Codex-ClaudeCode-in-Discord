#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import qrcode from 'qrcode-terminal';

import { loadRuntimeEnv } from '../env-loader.js';
import { createWechatBridge } from './bridge.js';
import { createWechatCodexRuntime } from './codex-runtime.js';
import { configureWechatProxy } from './http.js';
import { loginWechat } from './auth.js';
import { WechatILinkClient } from './ilink-client.js';
import { createWechatSessionStore } from './session-store.js';
import {
  ensurePrivateDir,
  readJson,
  writeJson,
} from './storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadRuntimeEnv({ rootDir: ROOT, env: process.env });

const DATA_DIR = path.join(ROOT, 'data', 'wechat');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');
const POLL_CURSOR_FILE = path.join(DATA_DIR, 'poll-cursor.txt');
const CONTEXT_TOKENS_FILE = path.join(DATA_DIR, 'context-tokens.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const WORKSPACE_LOCK_ROOT = path.join(ROOT, 'data', 'workspace-locks');

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(text);
}

function parseTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, os.homedir()));
}

function showQrCode(content) {
  qrcode.generate(content, { small: true });
}

async function loadOrLogin() {
  const stored = readJson(CREDENTIALS_FILE, null);
  if (stored?.botToken && stored?.baseUrl) return stored;
  const credentials = await loginWechat({ showQrCode });
  writeJson(CREDENTIALS_FILE, credentials);
  return credentials;
}

async function main() {
  ensurePrivateDir(DATA_DIR);
  configureWechatProxy(process.env);

  const codexBin = String(process.env.CODEX_BIN || 'codex').trim() || 'codex';
  const health = spawnSync(codexBin, ['--version'], { encoding: 'utf8' });
  if (health.error || health.status !== 0) {
    throw new Error(`Codex CLI unavailable via ${codexBin}: ${health.error?.message || health.stderr || health.status}`);
  }

  const credentials = await loadOrLogin();
  const allowedUserIds = new Set(parseCsv(process.env.WECHAT_ALLOWED_USER_IDS));
  if (parseBoolean(process.env.WECHAT_ALLOW_LOGIN_USER, true) && credentials.ilinkUserId) {
    allowedUserIds.add(String(credentials.ilinkUserId));
  }
  if (allowedUserIds.size === 0) {
    throw new Error('No WeChat users allowed. Set WECHAT_ALLOWED_USER_IDS before starting the bridge.');
  }

  const defaultWorkspaceDir = resolveLocalPath(
    process.env.WECHAT_DEFAULT_WORKSPACE_DIR
    || process.env.CODEX__DEFAULT_WORKSPACE_DIR
    || process.env.DEFAULT_WORKSPACE_DIR
    || ROOT,
  );
  const explicitWechatRoots = parseCsv(process.env.WECHAT_WORKSPACE_ROOTS);
  const configuredRoots = (
    explicitWechatRoots.length
      ? explicitWechatRoots
      : [process.env.WORKSPACE_ROOT, defaultWorkspaceDir].filter(Boolean)
  ).map(resolveLocalPath);

  const sessionStore = createWechatSessionStore({
    dataFile: SESSIONS_FILE,
    defaultWorkspaceDir,
    workspaceRoots: configuredRoots,
  });
  sessionStore.ensureWorkspaceAllowed(defaultWorkspaceDir);
  const allowDangerous = parseBoolean(process.env.WECHAT_ALLOW_DANGEROUS, false);
  const codexRuntime = createWechatCodexRuntime({
    sessionStore,
    lockRoot: WORKSPACE_LOCK_ROOT,
    allowDangerous,
    codexBin,
    runtimeMode: String(process.env.WECHAT_CODEX_RUNTIME_MODE || 'long').trim().toLowerCase(),
    timeoutMs: parseTimeout(process.env.WECHAT_CODEX_TIMEOUT_MS || process.env.CODEX_TIMEOUT_MS),
  });
  const ilink = new WechatILinkClient({
    credentials,
    pollCursorFile: POLL_CURSOR_FILE,
    contextTokensFile: CONTEXT_TOKENS_FILE,
  });
  createWechatBridge({
    ilink,
    sessionStore,
    codexRuntime,
    allowedUserIds,
    allowDangerous,
  });
  ilink.setReloginHandler(async () => {
    const refreshed = await loginWechat({ showQrCode });
    writeJson(CREDENTIALS_FILE, refreshed);
    return refreshed;
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[wechat] stopping after ${signal}`);
    ilink.stop();
    codexRuntime.close();
    setTimeout(() => process.exit(0), 250).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log([
    'Agents in WeChat started',
    `Codex: ${String(health.stdout || health.stderr).trim()}`,
    `runtime: ${process.env.WECHAT_CODEX_RUNTIME_MODE || 'long'}`,
    `workspace: ${defaultWorkspaceDir}`,
    `workspace roots: ${configuredRoots.join(', ')}`,
    `allowed users: ${allowedUserIds.size}`,
  ].join('\n'));
  ilink.start();
}

main().catch((err) => {
  console.error(`[wechat] startup failed: ${err?.stack || err}`);
  process.exit(1);
});
