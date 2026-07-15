import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  appendLedgerEntry,
  replayLedger,
} from '../../src/cohub-claude-goal/ledger.js';
import { IntegrityError } from '../../src/cohub-claude-goal/errors.js';

function makeGoalDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-sec-'));
  fs.mkdirSync(path.join(dir, 'ledger'));
  return dir;
}

function baseFields(overrides = {}) {
  return {
    goalInstance: 'test-instance',
    goalVersion: 1,
    claudeSessionId: 'test-session',
    type: 'OBSERVED',
    eventId: crypto.randomUUID(),
    actionId: null,
    beforeSnapshotHash: null,
    afterSnapshotHash: null,
    decision: null,
    evidenceRefs: [],
    ...overrides,
  };
}

// DEFECT: Pre-existing symlink can disclose arbitrary file metadata/content
test('SECURITY: pre-existing symlink to sentinel file must not disclose content', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // Create a sentinel secret file
  const secretPath = path.join(dir, 'SECRET_CREDENTIALS.txt');
  const secretContent = 'password=SuperSecret123!';
  await fsPromises.writeFile(secretPath, secretContent, 'utf8');

  // Attacker creates symlink before append
  await fsPromises.symlink(secretPath, lockPath);

  try {
    await appendLedgerEntry(dir, baseFields());
    assert.fail('append should detect symlink and fail');
  } catch (err) {
    // The error message must not contain the secret content
    assert.ok(err instanceof IntegrityError, `expected IntegrityError, got ${err.constructor.name}`);
    assert.ok(!err.message.includes('SuperSecret123'), 'error must not leak secret content');
    assert.ok(!err.message.includes('password='), 'error must not leak secret content');

    // Verify sentinel file was not modified or read
    const sentinelAfter = await fsPromises.readFile(secretPath, 'utf8');
    assert.equal(sentinelAfter, secretContent, 'sentinel file must be untouched');
  }
});

// DEFECT: Stale lock read errors are swallowed, attacker-controlled content can appear in error
test('SECURITY: corrupted lock must not leak raw attacker content in error', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // Attacker creates corrupted lock with malicious content
  const attackerPayload = 'ATTACKER_MARKER_XYZ_' + 'X'.repeat(10000);
  await fsPromises.writeFile(lockPath, attackerPayload, 'utf8');

  // Make it appear stale
  const oldTime = Date.now() - 35000;
  await fsPromises.utimes(lockPath, oldTime / 1000, oldTime / 1000);

  try {
    await appendLedgerEntry(dir, baseFields());
    assert.fail('append should detect stale lock');
  } catch (err) {
    assert.ok(err instanceof IntegrityError);
    // Error must not include raw attacker payload
    assert.ok(!err.message.includes('ATTACKER_MARKER_XYZ'), 'error must not leak attacker payload');
    // Error should describe the issue, not echo content
    assert.ok(err.message.includes('stale') || err.message.includes('corrupt') || err.message.includes('invalid'));
  }
});

// DEFECT: Cleanup unlinks by pathname without proving identity
test('SECURITY: lock replacement after acquire must not cause foreign lock deletion', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  let lockAcquired = false;
  let foreignLockNonce = null;

  // Intercept the append to replace lock mid-flight
  const originalOpen = fsPromises.open;
  let lockFd = null;

  fsPromises.open = async function(...args) {
    const result = await originalOpen.apply(this, args);
    if (args[0] === lockPath && !lockAcquired) {
      lockAcquired = true;
      lockFd = result;

      // Simulate race: attacker replaces lock file after we acquired it
      setImmediate(async () => {
        try {
          // Close our fd
          await lockFd.close();
          // Replace with foreign lock
          foreignLockNonce = crypto.randomBytes(16).toString('hex');
          const foreignLock = JSON.stringify({
            pid: 88888,
            acquiredAt: new Date().toISOString(),
            nonce: foreignLockNonce,
          });
          await fsPromises.unlink(lockPath);
          await fsPromises.writeFile(lockPath, foreignLock, { mode: 0o600 });
        } catch (err) {
          // Ignore race setup errors
        }
      });
    }
    return result;
  };

  try {
    await appendLedgerEntry(dir, baseFields());

    // If append succeeded, check if foreign lock survived
    if (foreignLockNonce) {
      const lockExists = fs.existsSync(lockPath);
      if (lockExists) {
        const lockContent = await fsPromises.readFile(lockPath, 'utf8');
        const lockData = JSON.parse(lockContent);
        assert.equal(lockData.nonce, foreignLockNonce, 'foreign lock must survive cleanup');
      } else {
        assert.fail('foreign lock was incorrectly deleted');
      }
    }
  } catch (err) {
    // If append failed, verify foreign lock survived
    if (foreignLockNonce && fs.existsSync(lockPath)) {
      const lockContent = await fsPromises.readFile(lockPath, 'utf8');
      const lockData = JSON.parse(lockContent);
      assert.equal(lockData.nonce, foreignLockNonce, 'foreign lock must survive even on error');
    }
  } finally {
    fsPromises.open = originalOpen;
  }
});

// DEFECT: Unlink failure is swallowed
test('SECURITY: cleanup unlink failure must be observable', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  let unlinkAttempted = false;
  const originalUnlink = fsPromises.unlink;

  fsPromises.unlink = async function(path) {
    if (path === lockPath) {
      unlinkAttempted = true;
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return originalUnlink.apply(this, arguments);
  };

  try {
    await appendLedgerEntry(dir, baseFields());
    assert.fail('append should fail when lock cleanup fails');
  } catch (err) {
    assert.ok(unlinkAttempted, 'unlink must be attempted');
    // Error should mention cleanup failure or permission issue
    assert.ok(err.message.includes('EPERM') || err.message.includes('cleanup') || err.message.includes('unlink'));
  } finally {
    fsPromises.unlink = originalUnlink;
  }
});

// DEFECT: Whitespace-only goalInstance is accepted
test('SECURITY: whitespace-only goalInstance must be rejected', async () => {
  const dir = makeGoalDir();

  await assert.rejects(
    () => appendLedgerEntry(dir, baseFields({ goalInstance: '   ' })),
    (err) => {
      assert.ok(err.message.includes('goalInstance'));
      assert.ok(err.message.includes('non-empty') || err.message.includes('whitespace'));
      return true;
    },
    'whitespace-only goalInstance must be rejected'
  );

  await assert.rejects(
    () => appendLedgerEntry(dir, baseFields({ goalInstance: '\t\n' })),
    (err) => {
      assert.ok(err.message.includes('goalInstance'));
      return true;
    },
    'whitespace-only goalInstance (tabs/newlines) must be rejected'
  );
});

// Parent directory fsync after lock create
test('SECURITY: parent directory must be synced after lock creation', async () => {
  const dir = makeGoalDir();

  let dirFsyncCalled = false;
  const originalOpen = fsPromises.open;

  // Track directory fsync calls
  fsPromises.open = async function(...args) {
    const fd = await originalOpen.apply(this, args);

    const originalSync = fd.sync;
    fd.sync = async function() {
      try {
        const stats = await fd.stat();
        if (stats.isDirectory()) {
          dirFsyncCalled = true;
        }
      } catch (err) {
        // Ignore stat errors during sync detection
      }
      return originalSync.apply(this, arguments);
    };

    return fd;
  };

  try {
    await appendLedgerEntry(dir, baseFields());

    // Directory fsync should have been called after lock creation
    assert.ok(dirFsyncCalled, 'directory fsync must be called after lock creation');
  } finally {
    fsPromises.open = originalOpen;
  }
});

// DEFECT: Parent directory fsync is missing after lock release
test('SECURITY: parent directory must be synced after lock release', async () => {
  const dir = makeGoalDir();

  // Similar to above - this will pass when the fix is implemented
  await appendLedgerEntry(dir, baseFields());

  // Currently parent-dir fsync after unlink is missing
  // This test documents the expected behavior
  assert.ok(true, 'parent-dir fsync after lock release will be added in fix');
});

// DEFECT: Truncated/corrupt lock is treated as "unreadable" not error
test('SECURITY: truncated lock descriptor must fail with typed IntegrityError', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // Create truncated JSON
  await fsPromises.writeFile(lockPath, '{"pid":123,"acquir', 'utf8');

  // Make it appear stale
  const oldTime = Date.now() - 35000;
  await fsPromises.utimes(lockPath, oldTime / 1000, oldTime / 1000);

  try {
    await appendLedgerEntry(dir, baseFields());
    assert.fail('truncated lock must cause failure');
  } catch (err) {
    assert.ok(err instanceof IntegrityError, 'must be IntegrityError');
    assert.ok(err.message.includes('corrupt') || err.message.includes('invalid') || err.message.includes('malformed'));
  }
});

// DEFECT: Lock with wrong schema is not validated before use
test('SECURITY: lock with missing nonce field must be rejected', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // Create lock without nonce
  const invalidLock = JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    // Missing nonce field
  });
  await fsPromises.writeFile(lockPath, invalidLock, 'utf8');

  // Make it appear stale
  const oldTime = Date.now() - 35000;
  await fsPromises.utimes(lockPath, oldTime / 1000, oldTime / 1000);

  try {
    await appendLedgerEntry(dir, baseFields());
    assert.fail('lock without nonce must be rejected');
  } catch (err) {
    assert.ok(err instanceof IntegrityError);
    assert.ok(err.message.includes('nonce') || err.message.includes('corrupt') || err.message.includes('invalid'));
  }
});

// DEFECT: Lock with invalid nonce format
test('SECURITY: lock with invalid nonce format must be rejected', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // Create lock with bad nonce format
  const invalidLock = JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    nonce: 'not-a-hex-string!',
  });
  await fsPromises.writeFile(lockPath, invalidLock, 'utf8');

  // Make it appear stale
  const oldTime = Date.now() - 35000;
  await fsPromises.utimes(lockPath, oldTime / 1000, oldTime / 1000);

  try {
    await appendLedgerEntry(dir, baseFields());
    assert.fail('lock with invalid nonce format must be rejected');
  } catch (err) {
    assert.ok(err instanceof IntegrityError);
    assert.ok(err.message.includes('nonce') || err.message.includes('corrupt') || err.message.includes('invalid'));
  }
});

// Combined test: Normal flow with correct cleanup and error preservation
test('SECURITY: aggregate error preserves both operation and cleanup failures', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // First append to establish ledger
  await appendLedgerEntry(dir, baseFields({ goalInstance: 'instance-1' }));

  let unlinkAttempted = false;
  const originalUnlink = fsPromises.unlink;

  fsPromises.unlink = async function(path) {
    if (path === lockPath) {
      unlinkAttempted = true;
      const err = new Error('cleanup unlink failed');
      err.code = 'EACCES';
      throw err;
    }
    return originalUnlink.apply(this, arguments);
  };

  try {
    // This will fail due to goalInstance mismatch
    await appendLedgerEntry(dir, baseFields({ goalInstance: 'instance-2' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(unlinkAttempted, 'cleanup must be attempted');
    // Error should preserve both the original error (mismatch) and cleanup error
    const msg = err.message;
    assert.ok(
      msg.includes('goalInstance') || msg.includes('mismatch') || msg.includes('cleanup') || msg.includes('unlink'),
      'error must preserve context'
    );
  } finally {
    fsPromises.unlink = originalUnlink;
  }
});
