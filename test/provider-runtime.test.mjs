import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpawnEnv,
  formatCliHealth,
  getProviderBin,
  isCliNotFound,
} from '../src/provider-runtime.js';
import {
  getLaunchctlGuardBinDir,
} from '../src/launchctl-guard.js';

test('buildSpawnEnv prepends the launchctl guard and appends common executable locations', () => {
  const env = buildSpawnEnv({
    HOME: '/tmp/home',
    PATH: '/usr/bin',
  });

  const parts = env.PATH.split(':');
  assert.equal(parts[0], getLaunchctlGuardBinDir());
  assert.ok(parts.includes('/usr/bin'));
  assert.ok(parts.includes('/tmp/home/.local/bin'));
  assert.ok(parts.includes('/opt/homebrew/bin'));
});

test('getProviderBin respects configured provider bins', () => {
  assert.equal(getProviderBin('codex', { codexBin: '/bin/codex-custom' }), '/bin/codex-custom');
  assert.equal(getProviderBin('claude', { claudeBin: '/bin/claude-custom' }), '/bin/claude-custom');
  assert.equal(getProviderBin('gemini', { geminiBin: '/bin/gemini-custom' }), '/bin/gemini-custom');
});

test('formatCliHealth renders not-found and success states', () => {
  assert.equal(isCliNotFound('spawn gemini ENOENT'), true);
  assert.match(formatCliHealth({ ok: false, bin: 'gemini', envKey: 'GEMINI_BIN', error: 'spawn gemini ENOENT' }, 'en'), /GEMINI_BIN/);
  assert.equal(formatCliHealth({ ok: true, bin: 'gemini', version: '0.33.1' }, 'zh'), '✅ `gemini` (0.33.1)');
});
