import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  getProviderBinEnvName,
  normalizeProvider,
} from './provider-metadata.js';
import {
  getLaunchctlGuardBinDir,
} from './launchctl-guard.js';

function truncate(text, max) {
  const value = String(text || '');
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

export function buildSpawnEnv(env) {
  const out = { ...env };
  const home = out.HOME || out.USERPROFILE || '';
  const delimiter = path.delimiter;
  const rawPath = out.PATH || '';
  const entries = [];
  const seen = new Set();
  const guardBinDir = getLaunchctlGuardBinDir();

  const extras = [
    guardBinDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    home ? path.join(home, '.local', 'bin') : null,
    home ? path.join(home, 'bin') : null,
  ].filter(Boolean);

  const addPath = (currentPath) => {
    if (!currentPath || seen.has(currentPath)) return;
    entries.push(currentPath);
    seen.add(currentPath);
  };

  for (const currentPath of extras) {
    addPath(currentPath);
  }

  for (const currentPath of rawPath.split(delimiter).filter(Boolean)) {
    addPath(currentPath);
  }

  out.PATH = entries.join(delimiter);
  return out;
}

export function getProviderBin(provider, {
  codexBin = 'codex',
  claudeBin = 'claude',
  geminiBin = 'gemini',
} = {}) {
  switch (normalizeProvider(provider)) {
    case 'claude':
      return claudeBin;
    case 'gemini':
      return geminiBin;
    default:
      return codexBin;
  }
}

function getCliHealthForBin({
  bin,
  envKey,
  spawnEnv,
  safeError = (err) => String(err?.message || err || 'unknown error'),
} = {}) {
  const check = spawnSync(bin, ['--version'], {
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (check.error) {
    return {
      ok: false,
      bin,
      envKey,
      error: safeError(check.error),
    };
  }

  if (check.status !== 0) {
    return {
      ok: false,
      bin,
      envKey,
      error: (check.stderr || check.stdout || `exit=${check.status}`).trim(),
    };
  }

  const versionLine = (check.stdout || check.stderr || '').trim().split('\n')[0] || 'ok';
  return {
    ok: true,
    bin,
    envKey,
    version: versionLine,
  };
}

export function getCliHealth(provider, {
  codexBin = 'codex',
  claudeBin = 'claude',
  geminiBin = 'gemini',
  spawnEnv = process.env,
  safeError,
} = {}) {
  const bin = getProviderBin(provider, {
    codexBin,
    claudeBin,
    geminiBin,
  });
  return getCliHealthForBin({
    bin,
    envKey: getProviderBinEnvName(provider),
    spawnEnv,
    safeError,
  });
}

export function isCliNotFound(errorText) {
  const message = String(errorText || '').toLowerCase();
  return message.includes('enoent') || message.includes('not found');
}

export function formatCliHealth(health, language = 'zh') {
  if (health.ok) return `✅ \`${health.bin}\` (${health.version})`;
  if (isCliNotFound(health.error)) {
    return language === 'en'
      ? `❌ \`${health.bin}\` not found (set ${health.envKey || 'CLI_BIN'}=/absolute/path/${health.bin} in .env)`
      : `❌ 未找到 \`${health.bin}\`（可在 .env 设置 ${health.envKey || 'CLI_BIN'}=/绝对路径/${health.bin}）`;
  }
  return `❌ ${truncate(String(health.error || 'unknown error'), 220)}`;
}
