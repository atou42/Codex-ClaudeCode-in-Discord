import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectUpgradeManager } from '../src/project-upgrade.js';

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
    const manager = createProjectUpgradeManager({
      projectRoot: f.local,
      env: { ...process.env },
      lockDir: path.join(f.root, 'upgrade.lock'),
      installCommand: 'node -e ""',
      verifyCommand: 'node -e "if(require(\'./package.json\').version!==\'0.1.1\')process.exit(7)"',
      spawnSyncFn: (cmd, args, options) => {
        if (cmd !== 'git' && options.cwd !== f.local) {
          validatedVersion = JSON.parse(fs.readFileSync(path.join(options.cwd, 'package.json'), 'utf8')).version;
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
    assert.equal(result.ok, true, result.error);
    assert.equal(mergeCalls, 1);
    assert.equal(validatedVersion, '0.1.1');
    assert.equal(result.before.remoteHead, f.validated);
    assert.equal(git(f.local, ['rev-parse', 'HEAD']), f.validated, 'only the tested revision may reach the worktree');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.local, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(git(f.local, ['rev-parse', 'origin/main']), moves ? f.unvalidated : f.validated);
    assert.equal(fs.existsSync(path.join(f.root, 'upgrade.lock')), false);
    assert.equal(git(f.local, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  });
}
