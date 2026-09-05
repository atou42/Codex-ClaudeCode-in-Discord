import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReportNonce,
  buildThreadReportContent,
  buildUpgradeReport,
  chunkDiscordContent,
  collectAddedHelpLines,
  compareVersions,
  extractVersionRange,
  fallbackImportantSummary,
  isVerifiedUpgrade,
  parseVersion,
  shouldCreateReport,
} from '../src/agent-upgrade-report.js';

test('parseVersion and compareVersions handle stable releases', () => {
  assert.equal(parseVersion('codex-cli 0.152.1'), '0.152.1');
  assert.equal(compareVersions('1.1.19', '1.1.3'), 1);
  assert.equal(compareVersions('1.1.3', '1.1.19'), -1);
  assert.equal(compareVersions('1.1.19', '1.1.19'), 0);
});

test('upgrade verification accepts a newer release than the stale expected version', () => {
  assert.equal(isVerifiedUpgrade({ before: '1.1.3', expected: '1.1.19', actual: '1.1.24' }), true);
  assert.equal(isVerifiedUpgrade({ before: '1.1.3', expected: '1.1.19', actual: '1.1.18' }), false);
  assert.equal(isVerifiedUpgrade({ before: '1.1.3', expected: '1.1.19', actual: '1.1.3' }), false);
});

test('report nonce stays within Discord limits', () => {
  const nonce = buildReportNonce('2026-09-02', 1_788_278_400_000);
  assert.match(nonce, /^agu-20260902-[a-z0-9]+$/);
  assert.ok(nonce.length <= 25);
});

test('extractVersionRange keeps only releases newer than before through after', () => {
  const changelog = [
    '1.1.5:',
    '· newest fix',
    '',
    '1.1.4:',
    '· middle fix',
    '',
    '1.1.3:',
    '· old fix',
  ].join('\n');

  assert.equal(
    extractVersionRange(changelog, '1.1.3', '1.1.5'),
    ['1.1.5:', '· newest fix', '', '1.1.4:', '· middle fix'].join('\n'),
  );
});

test('collectAddedHelpLines reports only new CLI surface', () => {
  assert.deepEqual(
    collectAddedHelpLines('Commands:\n  update  Update CLI', 'Commands:\n  clone  Lazy clone\n  update  Update CLI'),
    ['clone  Lazy clone'],
  );
});

test('fallbackImportantSummary keeps meaningful release notes', () => {
  const summary = fallbackImportantSummary('· Added a new command\n· Fixed a credential leak\n· Internal cleanup');
  assert.match(summary, /Added a new command/);
  assert.match(summary, /Fixed a credential leak/);
});

test('report is silent without changes and renders updates plus failures', () => {
  assert.equal(shouldCreateReport({ updates: [], failures: [] }), false);
  assert.equal(shouldCreateReport({ updates: [{ name: 'Codex' }], failures: [] }), true);

  const report = buildUpgradeReport({
    date: '2026-09-02',
    updates: [{
      name: 'Antigravity',
      before: '1.1.3',
      after: '1.1.19',
      summary: '- Added remote control fixes',
      sourceUrl: 'https://example.com/releases',
    }],
    failures: [{ name: 'Claude Code', message: 'update check failed' }],
  });
  assert.match(report, /Antigravity/);
  assert.match(report, /`1\.1\.3` → `1\.1\.19`/);
  assert.match(report, /Claude Code：update check failed/);
});

test('Discord mention is placed inside the thread report', () => {
  assert.equal(
    buildThreadReportContent('# Agent 更新 2026-09-03', '477027411532316683'),
    '<@477027411532316683>\n# Agent 更新 2026-09-03',
  );
});

test('chunkDiscordContent preserves all content within Discord limits', () => {
  const source = Array.from({ length: 120 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');
  const chunks = chunkDiscordContent(source, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), source.replace(/\n+/g, '\n'));
});
