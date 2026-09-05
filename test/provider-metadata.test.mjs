import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCompactConfigUnsupported,
  formatReasoningEffortUnsupported,
  formatWorkspaceSessionPolicy,
  getProviderBinEnvName,
  getProviderCompactCapabilities,
  getProviderDefaultBin,
  getProviderDefaultSlashPrefix,
  getProviderDisplayName,
  getProviderShortName,
  getSupportedCompactStrategies,
  isReasoningEffortSupported,
  normalizeProvider,
  parseOptionalProvider,
  parseProviderInput,
  providerBindsSessionsToWorkspace,
  providerSupportsCompactConfigAction,
} from '../src/provider-metadata.js';

test('provider-metadata normalizes aliases and optional parsing consistently', () => {
  assert.equal(normalizeProvider('openai'), 'codex');
  assert.equal(normalizeProvider('anthropic'), 'claude');
  assert.equal(normalizeProvider('cursor-agent'), 'cursor');
  assert.equal(normalizeProvider('xai'), 'grok');
  assert.equal(normalizeProvider('agy'), 'antigravity');
  assert.equal(normalizeProvider('antigravity'), 'antigravity');
  assert.equal(normalizeProvider('zcode'), 'zcode');
  assert.equal(normalizeProvider('glm'), 'zcode');
  assert.equal(normalizeProvider('pi'), 'pi');
  assert.equal(normalizeProvider('omp'), 'omp');
  assert.equal(normalizeProvider('oh-my-pi'), 'omp');
  assert.equal(normalizeProvider('google'), 'codex');
  assert.equal(normalizeProvider('gemini'), 'codex');
  assert.equal(parseOptionalProvider('google'), null);
  assert.equal(parseOptionalProvider('gemini'), null);
  assert.equal(parseOptionalProvider(''), null);
  assert.equal(parseProviderInput('anthropic'), 'claude');
  assert.equal(parseProviderInput('cursor'), 'cursor');
  assert.equal(parseProviderInput('grok-build'), 'grok');
  assert.equal(parseProviderInput('zcode'), 'zcode');
  assert.equal(parseProviderInput('unknown'), null);
  assert.throws(() => normalizeProvider('unknown'), /unsupported provider: unknown/);
});

test('provider-metadata exposes provider labels, bins, and slash prefixes', () => {
  assert.equal(getProviderDisplayName('codex'), 'Codex CLI');
  assert.equal(getProviderDisplayName('claude'), 'Claude Code');
  assert.equal(getProviderDisplayName('cursor'), 'Cursor Agent');
  assert.equal(getProviderDisplayName('grok'), 'Grok Build');
  assert.equal(getProviderDisplayName('antigravity'), 'Antigravity CLI');
  assert.equal(getProviderDisplayName('zcode'), 'ZCode CLI');
  assert.equal(getProviderDisplayName('pi'), 'Pi Agent');
  assert.equal(getProviderDisplayName('omp'), 'Oh My Pi');
  assert.equal(getProviderDisplayName('gemini'), 'Codex CLI');
  assert.equal(getProviderShortName('antigravity'), 'Antigravity');
  assert.equal(getProviderShortName('cursor'), 'Cursor');
  assert.equal(getProviderShortName('zcode'), 'ZCode');
  assert.equal(getProviderDefaultBin('claude'), 'claude');
  assert.equal(getProviderDefaultBin('cursor'), 'agent');
  assert.equal(getProviderDefaultBin('grok'), 'grok');
  assert.equal(getProviderDefaultBin('antigravity'), 'agy');
  assert.equal(getProviderDefaultBin('zcode'), 'zcode');
  assert.equal(getProviderDefaultBin('pi'), 'pi');
  assert.equal(getProviderDefaultBin('omp'), 'omp');
  assert.equal(getProviderBinEnvName('codex'), 'CODEX_BIN');
  assert.equal(getProviderBinEnvName('cursor'), 'CURSOR_BIN');
  assert.equal(getProviderBinEnvName('grok'), 'GROK_BIN');
  assert.equal(getProviderBinEnvName('antigravity'), 'ANTIGRAVITY_BIN');
  assert.equal(getProviderBinEnvName('zcode'), 'ZCODE_BIN');
  assert.equal(getProviderBinEnvName('pi'), 'PI_BIN');
  assert.equal(getProviderBinEnvName('omp'), 'OMP_BIN');
  assert.equal(getProviderDefaultSlashPrefix('codex'), 'cx');
  assert.equal(getProviderDefaultSlashPrefix('claude'), 'cc');
  assert.equal(getProviderDefaultSlashPrefix('cursor'), 'cursor');
  assert.equal(getProviderDefaultSlashPrefix('grok'), 'grok');
  assert.equal(getProviderDefaultSlashPrefix('antigravity'), 'ag');
  assert.equal(getProviderDefaultSlashPrefix('zcode'), 'zc');
  assert.equal(getProviderDefaultSlashPrefix('pi'), 'pi');
  assert.equal(getProviderDefaultSlashPrefix('omp'), 'omp');
});

test('provider-metadata exposes workspace, compact, and reasoning capabilities', () => {
  assert.equal(providerBindsSessionsToWorkspace('codex'), true);
  assert.equal(providerBindsSessionsToWorkspace('claude'), true);
  assert.equal(providerBindsSessionsToWorkspace('cursor'), true);
  assert.equal(providerBindsSessionsToWorkspace('grok'), true);
  assert.equal(providerBindsSessionsToWorkspace('antigravity'), true);
  assert.equal(providerBindsSessionsToWorkspace('pi'), true);
  assert.equal(providerBindsSessionsToWorkspace('omp'), true);
  assert.deepEqual(getSupportedCompactStrategies('codex'), ['hard', 'native', 'off']);
  assert.deepEqual(getSupportedCompactStrategies('claude'), ['hard', 'native', 'off']);
  assert.deepEqual(getSupportedCompactStrategies('cursor'), []);
  assert.deepEqual(getSupportedCompactStrategies('grok'), ['hard', 'native', 'off']);
  assert.equal(getProviderCompactCapabilities('claude').supportsNativeLimit, true);
  assert.equal(getProviderCompactCapabilities('antigravity').supportsNativeLimit, false);
  assert.equal(providerSupportsCompactConfigAction('claude', { type: 'set_strategy', strategy: 'native' }), true);
  assert.equal(providerSupportsCompactConfigAction('claude', { type: 'set_native_limit', tokens: 320000 }), true);
  assert.equal(providerSupportsCompactConfigAction('antigravity', { type: 'set_native_limit', tokens: 123 }), false);
  assert.equal(providerSupportsCompactConfigAction('antigravity', { type: 'set_threshold', tokens: 123 }), true);
  assert.equal(isReasoningEffortSupported('codex', 'xhigh'), true);
  assert.equal(isReasoningEffortSupported('claude', 'xhigh'), false);
  assert.equal(isReasoningEffortSupported('grok', 'max'), true);
  assert.equal(isReasoningEffortSupported('antigravity', 'medium'), false);
  assert.equal(isReasoningEffortSupported('pi', 'max'), true);
  assert.equal(isReasoningEffortSupported('omp', 'auto'), true);
});

test('provider-metadata formats provider-aware help', () => {
  assert.match(formatReasoningEffortUnsupported('antigravity', 'en'), /Antigravity CLI/);
  assert.match(formatReasoningEffortUnsupported('claude', 'zh'), /`low`、`medium`、`high`/);
  assert.match(formatCompactConfigUnsupported('antigravity', { type: 'set_native_limit' }, 'en'), /native_limit/);
  assert.match(formatWorkspaceSessionPolicy('claude', 'en'), /workspace-scoped/);
});
