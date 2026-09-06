import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectUpgradeManager, formatProjectUpgradeReport } from '../src/project-upgrade.js';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-upgrade-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const writer = path.join(root, 'writer');
  fs.mkdirSync(remote);
  git(remote, ['init', '--bare', '--initial-branch=main']);
  git(root, ['clone', remote, writer]);
  git(writer, ['config', 'user.name', 'Upgrade Regression']);
  git(writer, ['config', 'user.email', 'regression@example.invalid']);
  function release(version) {
    fs.writeFileSync(path.join(writer, 'package.json'), JSON.stringify({ name: 'fixture', version }));
    git(writer, ['add', 'package.json']);
    git(writer, ['commit', '-m', `release ${version}`]);
    return git(writer, ['rev-parse', 'HEAD']);
  }
  release('0.1.0');
  git(writer, ['push', 'origin', 'main']);
  git(root, ['clone', remote, local]);
  const validated = release('0.1.1');
  git(writer, ['push', 'origin', 'main']);
  const unvalidated = release('0.1.2');
  return { root, local, writer, validated, unvalidated };
}

for (const moves of [true, false]) {
  test(`upgrade installs the validated revision when remote ref ${moves ? 'moves' : 'stays unchanged'}`, async (t) => {
    const f = fixture(t);
    let mergeCalls = 0;
    let validatedVersion = null;
    const shellCalls = [];
    const manager = createProjectUpgradeManager({
      projectRoot: f.local,
      env: { ...process.env },
      lockDir: path.join(f.root, 'upgrade.lock'),
      installCommand: 'fixture-install',
      // Exercise the default verification contract without running installation or services.
      spawnFn: () => { throw new Error('service launch forbidden in this fixture'); },
      spawnSyncFn: (cmd, args, options) => {
        if (cmd !== 'git') {
          const version = JSON.parse(fs.readFileSync(path.join(options.cwd, 'package.json'), 'utf8')).version;
          const command = args.at(-1);
          shellCalls.push({ command, staging: options.cwd !== f.local, version });
          if (command === 'npm run test:progress') validatedVersion = version;
          return { status: version === '0.1.1' ? 0 : 7, stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'merge') {
          mergeCalls += 1;
          if (moves) {
            // Simulate an independent fetch after staging verified the previous head.
            git(f.writer, ['push', 'origin', 'main']);
            git(f.local, ['fetch', 'origin']);
          }
        }
        return spawnSync(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      },
    });
    const result = await manager.apply();
    assert.equal(git(f.local, ['rev-parse', 'HEAD']), f.validated, 'only the tested revision may reach the worktree');
    assert.equal(result.ok, true, result.error);
    assert.equal(mergeCalls, 1);
    assert.equal(validatedVersion, '0.1.1');
    assert.equal(result.before.remoteHead, f.validated);
    assert.deepEqual(shellCalls, [
      { command: 'fixture-install', staging: true, version: '0.1.1' },
      { command: 'npm run test:progress', staging: true, version: '0.1.1' },
      { command: 'fixture-install', staging: false, version: '0.1.1' },
    ]);
    assert.equal(result.restartRequested, false);
    assert.equal(result.check.localHead, f.validated);
    assert.equal(result.check.remoteHead, moves ? f.unvalidated : f.validated);
    assert.equal(result.check.updateAvailable, moves, 'a newer revision must still be reported as unvalidated');
    if (moves) {
      const report = formatProjectUpgradeReport(result.check, 'en', { applyResult: result });
      assert.match(report, /upgraded to 0\.1\.1/);
      assert.ok(report.includes(`newer revision ${f.unvalidated} remains available and requires validation`));
    }
    assert.ok(result.logs.some((line) => line.includes(`merged validated revision ${f.validated}`)));
    assert.equal(git(f.local, ['rev-parse', 'HEAD']), f.validated, 'only the tested revision may reach the worktree');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.local, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(git(f.local, ['rev-parse', 'origin/main']), moves ? f.unvalidated : f.validated);
    assert.equal(fs.existsSync(path.join(f.root, 'upgrade.lock')), false);
    assert.equal(git(f.local, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  });
}
