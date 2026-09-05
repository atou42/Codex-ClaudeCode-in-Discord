import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { persistEnvUpdates } from './env-file-updater.js';

export const PROJECT_UPGRADE_MODE_ENV = 'AGENTS_IN_DISCORD_UPGRADE_MODE';
export const PROJECT_UPGRADE_MODES = Object.freeze(['off', 'notify', 'auto']);

export function normalizeProjectUpgradeMode(value, fallback = 'notify') {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!raw) return normalizeProjectUpgradeMode(fallback, 'notify');
  if (['off', 'disable', 'disabled', 'false', '0', '关闭'].includes(raw)) return 'off';
  if (['notify', 'notice', 'prompt', '提示', '只提示'].includes(raw)) return 'notify';
  if (['auto', 'on', 'enable', 'enabled', 'true', '1', '自动'].includes(raw)) return 'auto';
  return normalizeProjectUpgradeMode(fallback, 'notify');
}

export function parseProjectUpgradeTextInput(input = '') {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  if (!lower || ['status', 'check', 'state', 'show', '查看', '状态'].includes(lower)) {
    return { type: 'check' };
  }
  if (['apply', 'upgrade', 'update', 'run', '升级', '更新'].includes(lower)) {
    return { type: 'apply' };
  }
  if (['off', 'disable', 'disabled', '关闭'].includes(lower)) {
    return { type: 'set_mode', mode: 'off' };
  }
  if (['notify', 'notice', 'prompt', '提示', '只提示'].includes(lower)) {
    return { type: 'set_mode', mode: 'notify' };
  }
  if (['auto', 'on', 'enable', 'enabled', '自动'].includes(lower)) {
    return { type: 'set_mode', mode: 'auto' };
  }
  const modeMatch = lower.match(/^mode\s+(.+)$/);
  if (modeMatch) return { type: 'set_mode', mode: normalizeProjectUpgradeMode(modeMatch[1]) };
  return { type: 'help' };
}

export function parseProjectUpgradeSlashInput({ action = 'status', mode = '' } = {}) {
  const normalizedAction = String(action || 'status').trim().toLowerCase();
  if (normalizedAction === 'status' || normalizedAction === 'check') return { type: 'check' };
  if (normalizedAction === 'apply') return { type: 'apply' };
  if (normalizedAction === 'mode') return { type: 'set_mode', mode: normalizeProjectUpgradeMode(mode || 'notify') };
  return { type: 'help' };
}

export function createProjectUpgradeManager({
  projectRoot = process.cwd(),
  env = process.env,
  envFilePath = '',
  spawnSyncFn = spawnSync,
  spawnFn = spawn,
  now = () => new Date(),
  lockDir = path.join(os.tmpdir(), 'agents-in-discord-project-upgrade.lock'),
  remoteName = env.AGENTS_IN_DISCORD_UPGRADE_REMOTE || 'origin',
  remoteBranch = env.AGENTS_IN_DISCORD_UPGRADE_BRANCH || 'main',
  verifyCommand = env.AGENTS_IN_DISCORD_UPGRADE_VERIFY_COMMAND || 'npm run test:progress',
  installCommand = env.AGENTS_IN_DISCORD_UPGRADE_INSTALL_COMMAND || '',
  cacheTtlMs = Number(env.AGENTS_IN_DISCORD_UPGRADE_STATUS_CACHE_MS || 10 * 60_000),
  restartCommand = env.AGENTS_IN_DISCORD_UPGRADE_RESTART_COMMAND || '',
} = {}) {
  let currentMode = normalizeProjectUpgradeMode(env[PROJECT_UPGRADE_MODE_ENV] || 'notify');
  let cachedStatus = null;
  let cachedAt = 0;

  const remote = String(remoteName || 'origin').trim() || 'origin';
  const branch = String(remoteBranch || 'main').trim() || 'main';
  const remoteRef = `${remote}/${branch}`;

  function resolveConfig() {
    return {
      mode: currentMode,
      source: 'env default',
      envKey: PROJECT_UPGRADE_MODE_ENV,
      remote,
      branch,
      remoteRef,
      verifyCommand,
      installCommand: installCommand || null,
      restartCommand: restartCommand || null,
    };
  }

  function setMode(mode) {
    currentMode = normalizeProjectUpgradeMode(mode, currentMode);
    env[PROJECT_UPGRADE_MODE_ENV] = currentMode;
    persistEnvUpdates(envFilePath, { [PROJECT_UPGRADE_MODE_ENV]: currentMode });
    return resolveConfig();
  }

  function runGit(args, options = {}) {
    return run('git', args, options);
  }

  function run(cmd, args, options = {}) {
    const { allowFailure = false, capture = true, mutates = false, dryRun = false } = options;
    if (dryRun && mutates) {
      return { ok: true, status: 0, stdout: '', stderr: '', dryRun: true };
    }
    const result = spawnSyncFn(cmd, args, {
      cwd: options.cwd || projectRoot,
      env,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (result.error) {
      if (allowFailure) return { ok: false, status: 1, stdout: '', stderr: result.error.message };
      throw result.error;
    }
    const status = result.status ?? 1;
    if (status !== 0 && !allowFailure) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error(`${cmd} ${args.join(' ')} exited ${status}${detail ? `: ${detail}` : ''}`);
    }
    return {
      ok: status === 0,
      status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  }

  function runShell(command, options = {}) {
    const shell = process.platform === 'win32'
      ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { cmd: '/bin/sh', args: ['-lc', command] };
    return run(shell.cmd, shell.args, options);
  }

  async function check({ fetch = true } = {}) {
    try {
      const inside = runGit(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
      if (!inside.ok || output(inside) !== 'true') {
        return { ok: false, error: 'project root is not a git work tree', config: resolveConfig() };
      }
      if (fetch) {
        const fetched = runGit([
          'fetch',
          '--prune',
          remote,
          `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        ], { allowFailure: true, capture: true });
        if (!fetched.ok) {
          return { ok: false, error: `git fetch failed: ${describeFailure(fetched)}`, config: resolveConfig() };
        }
      }

      const localHead = output(runGit(['rev-parse', 'HEAD']));
      const remoteHeadResult = runGit(['rev-parse', remoteRef], { allowFailure: true });
      if (!remoteHeadResult.ok) {
        return { ok: false, error: `remote ref not found: ${remoteRef}`, config: resolveConfig() };
      }
      const remoteHead = output(remoteHeadResult);
      const currentBranch = output(runGit(['branch', '--show-current'], { allowFailure: true })) || '(detached)';
      const statusText = output(runGit(['status', '--porcelain'], { allowFailure: true }));
      const dirtyEntries = statusText ? statusText.split(/\r?\n/).filter(Boolean) : [];
      const dirty = dirtyEntries.length > 0;
      const behindCount = toCount(output(runGit(['rev-list', '--count', `HEAD..${remoteRef}`], { allowFailure: true })));
      const aheadCount = toCount(output(runGit(['rev-list', '--count', `${remoteRef}..HEAD`], { allowFailure: true })));
      const canFastForward = runGit(['merge-base', '--is-ancestor', 'HEAD', remoteRef], { allowFailure: true }).ok;
      const remoteContained = runGit(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], { allowFailure: true }).ok;
      const diverged = behindCount > 0 && (!canFastForward || aheadCount > 0);
      const localVersion = readPackageVersion(path.join(projectRoot, 'package.json'));
      const remoteVersion = readRemotePackageVersion(runGit, remoteRef);
      const releaseNotes = readRemoteReleaseNotes(runGit, remoteRef, remoteVersion);
      const updateAvailable = behindCount > 0 && localHead !== remoteHead;
      const reasons = [];
      if (currentBranch !== branch) reasons.push(`current branch is ${currentBranch}, expected ${branch}`);
      if (dirty) reasons.push('working tree has local changes');
      if (diverged) reasons.push('local branch diverged from remote');
      if (updateAvailable && !canFastForward) reasons.push('remote update is not a fast-forward');
      const canApply = updateAvailable && currentBranch === branch && !dirty && canFastForward && !diverged;

      return {
        ok: true,
        checkedAt: now().toISOString(),
        config: resolveConfig(),
        localVersion,
        remoteVersion,
        localHead,
        remoteHead,
        localShort: shortSha(localHead),
        remoteShort: shortSha(remoteHead),
        currentBranch,
        remoteRef,
        updateAvailable,
        canApply,
        reasons,
        dirty,
        dirtyEntries,
        behindCount,
        aheadCount,
        diverged,
        canFastForward,
        remoteContained,
        releaseNotes,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), config: resolveConfig() };
    }
  }

  async function getCachedStatus({ refresh = false, maxAgeMs = cacheTtlMs } = {}) {
    const age = Date.now() - cachedAt;
    if (!refresh && cachedStatus && age >= 0 && age < Math.max(1000, Number(maxAgeMs) || cacheTtlMs)) {
      return {
        ...cachedStatus,
        cached: true,
        cacheAgeMs: age,
      };
    }
    const status = await check({ fetch: true });
    cachedStatus = status;
    cachedAt = Date.now();
    return {
      ...status,
      cached: false,
      cacheAgeMs: 0,
    };
  }

  async function apply({ dryRun = false, restart = false, requireIdle = null } = {}) {
    return withLock(async () => {
      let merged = false;
      if (typeof requireIdle === 'function') {
        const idle = requireIdle();
        if (!idle?.ok) {
          return { ok: false, changed: false, error: idle?.error || 'bot has running or queued work', check: null };
        }
      }
      const before = await check({ fetch: true });
      if (!before.ok) return { ok: false, changed: false, error: before.error, check: before };
      if (!before.updateAvailable) return { ok: true, changed: false, check: before, logs: ['already up to date'] };
      if (!before.canApply) {
        return {
          ok: false,
          changed: false,
          error: before.reasons.length ? before.reasons.join('; ') : 'upgrade is not safe to apply',
          check: before,
        };
      }

      const logs = [];
      const install = installCommand || (fs.existsSync(path.join(projectRoot, 'package-lock.json')) ? 'npm ci' : 'npm install');
      try {
        logs.push(`validating ${before.remoteShort} in a temporary worktree`);
        validateRemoteHeadInWorktree(before.remoteHead, { install, dryRun, logs });

        logs.push(`upgrading ${before.localShort} -> ${before.remoteShort}`);
        runGit(['merge', '--ff-only', before.remoteHead], { capture: false, mutates: true, dryRun });
        merged = !dryRun;
        logs.push(`merged validated revision ${before.remoteHead} (${remoteRef})`);

        runShell(install, { capture: false, mutates: true, dryRun });
        logs.push(`main install command completed: ${install}`);

        let restartRequested = false;
        if (restart) {
          requestRestart({ dryRun });
          restartRequested = true;
          logs.push('restart requested');
        }

        const after = dryRun ? before : await check({ fetch: false });
        cachedStatus = after;
        cachedAt = Date.now();
        return {
          ok: true,
          changed: !dryRun,
          dryRun,
          restartRequested,
          check: after,
          before,
          logs,
        };
      } catch (err) {
        return {
          ok: false,
          changed: merged,
          error: String(err?.message || err),
          check: merged ? await check({ fetch: false }) : before,
          before,
          logs,
        };
      }
    });
  }

  function validateRemoteHeadInWorktree(remoteHead, { install, dryRun = false, logs = [] } = {}) {
    const head = String(remoteHead || '').trim();
    if (!head) throw new Error('remote head is empty');
    if (dryRun) {
      logs.push(`[dry-run] would create temporary worktree for ${shortSha(head)}`);
      return;
    }
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-upgrade-worktree-'));
    try {
      runGit(['worktree', 'add', '--detach', tmpRoot, head], { capture: false, mutates: true });
      logs.push(`temporary worktree ready: ${tmpRoot}`);
      runShell(install, { capture: false, mutates: true, cwd: tmpRoot });
      logs.push(`staging install command completed: ${install}`);
      if (verifyCommand && String(verifyCommand).trim().toLowerCase() !== 'off') {
        runShell(verifyCommand, { capture: false, mutates: true, cwd: tmpRoot });
        logs.push(`staging verify command completed: ${verifyCommand}`);
      }
    } finally {
      runGit(['worktree', 'remove', '--force', tmpRoot], { allowFailure: true, capture: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  function requestRestart({ dryRun = false } = {}) {
    const command = String(restartCommand || '').trim();
    if (!command) return false;
    if (dryRun) return true;
    const child = spawnFn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-lc', command], {
      cwd: projectRoot,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
    return true;
  }

  async function withLock(fn) {
    try {
      fs.mkdirSync(lockDir);
    } catch (err) {
      if (err?.code === 'EEXIST') {
        return { ok: false, changed: false, error: 'another project upgrade is already running' };
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // ignore cleanup race
      }
    }
  }

  return {
    resolveConfig,
    setMode,
    check,
    getCachedStatus,
    apply,
    requestRestart,
  };
}

export function formatProjectUpgradeReport(result, language = 'zh', { changedMode = null, applyResult = null } = {}) {
  const lang = language === 'en' ? 'en' : 'zh';
  if (changedMode) {
    return lang === 'en'
      ? `✅ Project upgrade mode updated: ${formatMode(changedMode.mode, lang)}`
      : `✅ 项目升级模式已更新：${formatMode(changedMode.mode, lang)}`;
  }
  if (applyResult) return formatProjectUpgradeApplyReport(applyResult, lang);
  if (!result?.ok) {
    return lang === 'en'
      ? `❌ Project upgrade check failed\n• error: ${result?.error || 'unknown error'}`
      : `❌ 项目升级检查失败\n• 错误：${result?.error || 'unknown error'}`;
  }
  const modeLine = lang === 'en'
    ? `• mode: ${formatMode(result.config.mode, lang)}`
    : `• 模式：${formatMode(result.config.mode, lang)}`;
  const versionLine = lang === 'en'
    ? `• version: ${result.localVersion || 'unknown'} -> ${result.remoteVersion || 'unknown'}`
    : `• 版本：${result.localVersion || 'unknown'} -> ${result.remoteVersion || 'unknown'}`;
  const commitLine = lang === 'en'
    ? `• commits: ${result.localShort} -> ${result.remoteShort}; behind ${result.behindCount}, ahead ${result.aheadCount}`
    : `• 提交：${result.localShort} -> ${result.remoteShort}；落后 ${result.behindCount}，超前 ${result.aheadCount}`;
  const stateLine = formatProjectUpgradeStateLine(result, lang);
  const notes = result.updateAvailable ? formatReleaseNotes(result.releaseNotes, lang) : null;
  return [
    lang === 'en' ? '🧭 **Project Upgrade**' : '🧭 **项目升级**',
    modeLine,
    versionLine,
    commitLine,
    stateLine,
    notes,
  ].filter(Boolean).join('\n');
}

export function formatProjectUpgradeStatusLine(result, language = 'zh') {
  const lang = language === 'en' ? 'en' : 'zh';
  if (!result?.ok) {
    return lang === 'en'
      ? `• project upgrade: check failed (${result?.error || 'unknown error'})`
      : `• 项目升级：检查失败（${result?.error || 'unknown error'}）`;
  }
  if (!result.updateAvailable) {
    return lang === 'en'
      ? `• project upgrade: up to date (${result.localVersion || 'unknown'}, ${formatMode(result.config.mode, lang)})`
      : `• 项目升级：已是最新（${result.localVersion || 'unknown'}，${formatMode(result.config.mode, lang)}）`;
  }
  const action = result.canApply
    ? (lang === 'en' ? 'run upgrade apply' : '可执行 upgrade apply')
    : (lang === 'en' ? `blocked: ${result.reasons.join('; ')}` : `已阻止：${result.reasons.join('；')}`);
  return lang === 'en'
    ? `• project upgrade: available ${result.localVersion || 'unknown'} -> ${result.remoteVersion || 'unknown'} (${action})`
    : `• 项目升级：发现新版本 ${result.localVersion || 'unknown'} -> ${result.remoteVersion || 'unknown'}（${action}）`;
}

function formatProjectUpgradeApplyReport(result, language = 'zh') {
  const lang = language === 'en' ? 'en' : 'zh';
  if (!result?.ok) {
    const prefix = result?.changed
      ? (lang === 'en' ? '❌ Project upgrade failed after changing the worktree' : '❌ 项目升级在修改工作区后失败')
      : (lang === 'en' ? '❌ Project upgrade not applied' : '❌ 项目升级未执行');
    return [
      prefix,
      lang === 'en' ? `• error: ${result?.error || 'unknown error'}` : `• 错误：${result?.error || 'unknown error'}`,
      ...formatUpgradeLogs(result?.logs, lang),
    ].join('\n');
  }
  if (!result.changed) {
    if (result.dryRun) {
      return lang === 'en'
        ? ['✅ Project upgrade dry-run completed. No files were changed.', ...formatUpgradeLogs(result.logs, lang)].join('\n')
        : ['✅ 项目升级 dry-run 已完成，没有修改文件。', ...formatUpgradeLogs(result.logs, lang)].join('\n');
    }
    return lang === 'en'
      ? '✅ Project is already up to date.'
      : '✅ 项目已经是最新版本。';
  }
  const version = result.check?.localVersion || result.before?.remoteVersion || 'unknown';
  const restart = result.restartRequested
    ? (lang === 'en' ? 'restart requested' : '已请求重启')
    : (lang === 'en' ? 'restart not requested' : '未请求重启');
  return lang === 'en'
    ? [`✅ Project upgraded to ${version}`, `• ${restart}`, ...formatUpgradeLogs(result.logs, lang)].join('\n')
    : [`✅ 项目已升级到 ${version}`, `• ${restart}`, ...formatUpgradeLogs(result.logs, lang)].join('\n');
}

function formatUpgradeLogs(logs = [], language = 'zh') {
  const items = Array.isArray(logs) ? logs.slice(-6) : [];
  if (!items.length) return [];
  const title = language === 'en' ? '• recent steps:' : '• 最近步骤：';
  return [
    title,
    ...items.map((item) => `  ${item}`),
  ];
}

function formatProjectUpgradeStateLine(result, language) {
  if (!result.updateAvailable) {
    return language === 'en' ? '• state: up to date' : '• 状态：已是最新';
  }
  if (result.canApply) {
    return language === 'en'
      ? '• state: update available and safe to fast-forward'
      : '• 状态：有新版本，可安全快进升级';
  }
  const reason = result.reasons.join(language === 'en' ? '; ' : '；') || 'unknown';
  return language === 'en'
    ? `• state: update available but blocked (${reason})`
    : `• 状态：有新版本，但已阻止（${reason}）`;
}

function formatReleaseNotes(notes, language) {
  const text = String(notes || '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6);
  if (!lines.length) return null;
  return [
    language === 'en' ? '• release notes:' : '• 更新说明：',
    ...lines.map((line) => `  ${line}`),
  ].join('\n');
}

function formatMode(mode, language) {
  const normalized = normalizeProjectUpgradeMode(mode);
  if (language === 'en') {
    if (normalized === 'off') return 'off';
    if (normalized === 'auto') return 'auto apply';
    return 'notify only';
  }
  if (normalized === 'off') return '关闭';
  if (normalized === 'auto') return '自动升级';
  return '只提示';
}

function output(result) {
  return String(result?.stdout || '').trim();
}

function describeFailure(result) {
  const status = result?.status ?? 'unknown';
  const detail = String(result?.stderr || result?.stdout || '').trim();
  return detail ? `exit ${status}: ${detail}` : `exit ${status}`;
}

function toCount(value) {
  const count = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

function readPackageVersion(packageJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function readRemotePackageVersion(runGit, remoteRef) {
  const result = runGit(['show', `${remoteRef}:package.json`], { allowFailure: true });
  if (!result.ok) return null;
  try {
    return JSON.parse(output(result)).version || null;
  } catch {
    return null;
  }
}

function readRemoteReleaseNotes(runGit, remoteRef, version) {
  if (!version) return '';
  const result = runGit(['show', `${remoteRef}:CHANGELOG.md`], { allowFailure: true });
  if (!result.ok) return '';
  return extractChangelogSection(output(result), version);
}

function extractChangelogSection(content, version) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function shortSha(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 7) : 'unknown';
}
