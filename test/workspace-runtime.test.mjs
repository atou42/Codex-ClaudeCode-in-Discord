import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspaceRuntime } from '../src/workspace-runtime.js';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

test('createWorkspaceRuntime serializes access to the same workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-workspace-lock-'));
  const runtime = createWorkspaceRuntime({
    lockRoot: path.join(root, 'locks'),
    ensureDir,
    pollIntervalMs: 30,
  });

  const first = await runtime.acquireWorkspace('/tmp/workspace-a', { key: 'thread-a' });
  assert.equal(first.acquired, true);

  let waited = false;
  const secondPromise = runtime.acquireWorkspace('/tmp/workspace-a', { key: 'thread-b' }, {
    onWait: () => {
      waited = true;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(waited, true);

  first.release();
  const second = await secondPromise;
  assert.equal(second.acquired, true);
  second.release();
});

test('createWorkspaceRuntime removes stale workspace locks from dead processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-workspace-lock-'));
  const runtime = createWorkspaceRuntime({
    lockRoot: path.join(root, 'locks'),
    ensureDir,
    pollIntervalMs: 30,
  });
  const info = runtime.readLock('/tmp/workspace-b');
  ensureDir(path.dirname(info.lockFile));
  fs.writeFileSync(info.lockFile, JSON.stringify({
    pid: 999999,
    key: 'stale-thread',
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  }));

  const lock = await runtime.acquireWorkspace('/tmp/workspace-b', { key: 'thread-live' });
  assert.equal(lock.acquired, true);
  lock.release();
  assert.equal(fs.existsSync(info.lockFile), false);
});
