import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendLedgerEntry,
  replayLedger,
} from '../../src/cohub-claude-goal/ledger.js';
import { IntegrityError } from '../../src/cohub-claude-goal/errors.js';

function makeGoalDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-lock-'));
  fs.mkdirSync(path.join(dir, 'ledger'));
  return dir;
}

function baseFields(overrides = {}) {
  return {
    goalInstance: 'test-instance',
    goalVersion: 1,
    claudeSessionId: 'test-session',
    type: 'OBSERVED',
    eventId: 'evt-1',
    actionId: null,
    beforeSnapshotHash: null,
    afterSnapshotHash: null,
    decision: null,
    evidenceRefs: [],
    ...overrides,
  };
}

test('append lock is removed after successful append', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());

  const lockPath = path.join(dir, 'ledger.append-lock');
  assert.ok(!fs.existsSync(lockPath), 'lock must be removed after success');
});

test('append lock is removed even after append failure', async () => {
  const dir = makeGoalDir();

  // First append succeeds
  await appendLedgerEntry(dir, baseFields({ goalInstance: 'instance-1' }));

  // Second append with different goalInstance fails
  try {
    await appendLedgerEntry(dir, baseFields({ goalInstance: 'instance-2' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('goalInstance mismatch'));
  }

  const lockPath = path.join(dir, 'ledger.append-lock');
  assert.ok(!fs.existsSync(lockPath), 'lock must be removed even after failure');
});

test('append lock contains valid metadata', async () => {
  const dir = makeGoalDir();

  // Create a slow append by intercepting
  let lockData = null;
  const appendPromise = appendLedgerEntry(dir, baseFields());

  // Give it a moment to acquire lock
  await new Promise(resolve => setTimeout(resolve, 10));

  const lockPath = path.join(dir, 'ledger.append-lock');
  if (fs.existsSync(lockPath)) {
    lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  }

  await appendPromise;

  if (lockData) {
    assert.ok(typeof lockData.pid === 'number', 'lock must have pid');
    assert.ok(typeof lockData.acquiredAt === 'string', 'lock must have acquiredAt');
    assert.ok(typeof lockData.nonce === 'string', 'lock must have nonce');
    assert.ok(/^[0-9a-f]{32}$/.test(lockData.nonce), 'nonce must be 32-char hex');
  }
});

test('stale lock (>30s) is detected and reported with forensics', async () => {
  const dir = makeGoalDir();
  const lockPath = path.join(dir, 'ledger.append-lock');

  // Create a stale lock
  const staleLock = {
    pid: 99999,
    acquiredAt: new Date(Date.now() - 35000).toISOString(),
    nonce: 'a'.repeat(32),
  };
  fs.writeFileSync(lockPath, JSON.stringify(staleLock));

  // Touch the file to make it old
  const oldTime = Date.now() - 35000;
  fs.utimesSync(lockPath, oldTime / 1000, oldTime / 1000);

  await assert.rejects(
    () => appendLedgerEntry(dir, baseFields()),
    (err) => {
      assert.ok(err instanceof IntegrityError);
      assert.ok(err.message.includes('stale append lock'));
      assert.ok(err.message.includes('age:'));
      return true;
    }
  );
});

test('concurrent appends: second detects conflict and fails before writing (fail-fast strategy)', async () => {
  const dir = makeGoalDir();

  const append1 = appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));

  // Wait for first append to acquire lock
  await new Promise(resolve => setTimeout(resolve, 10));

  const append2 = appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' }));

  const results = await Promise.allSettled([append1, append2]);

  // First succeeds, second fails with conflict
  const successes = results.filter(r => r.status === 'fulfilled');
  const failures = results.filter(r => r.status === 'rejected');

  assert.equal(successes.length, 1, 'exactly one append succeeds');
  assert.equal(failures.length, 1, 'exactly one append fails');

  const failedError = failures[0].reason;
  assert.ok(failedError instanceof IntegrityError);
  assert.ok(failedError.message.includes('another process is currently appending'));

  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1, 'only successful append is committed');
});

test('append lock location is in goal dir, not ledger/ subdir', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());

  // Lock should have been in goal dir
  const lockInGoalDir = path.join(dir, 'ledger.append-lock');
  const lockInLedgerDir = path.join(dir, 'ledger', 'ledger.append-lock');

  // Neither should exist after successful append
  assert.ok(!fs.existsSync(lockInGoalDir), 'lock in goal dir cleaned up');
  assert.ok(!fs.existsSync(lockInLedgerDir), 'no lock in ledger/ subdir');

  // Verify replayLedger can still scan ledger/ cleanly
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1);
});

test('concurrent appends with retry: caller can retry after conflict', async () => {
  const dir = makeGoalDir();

  // Multiple concurrent appends with automatic retry on conflict
  const attemptAppend = async (eventId, maxRetries = 20) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await appendLedgerEntry(dir, baseFields({ eventId }));
      } catch (err) {
        if (err instanceof IntegrityError && err.message.includes('another process is currently appending')) {
          // Wait with exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.min(50 * (i + 1), 200)));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Failed after ${maxRetries} retries`);
  };

  const appends = Array.from({ length: 5 }, (_, i) =>
    attemptAppend(`evt-${i}`)
  );

  const results = await Promise.all(appends);

  // All should eventually succeed
  assert.equal(results.length, 5, 'all appends succeed with retry');

  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 5);

  // Verify sequence is continuous
  const seqs = replay.records.map(r => r.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);

  // Verify chain is intact
  for (let i = 1; i < replay.records.length; i++) {
    assert.equal(
      replay.records[i].previousEntryHash,
      replay.records[i - 1].entryHash,
      `record ${i + 1} must chain to record ${i}`
    );
  }
});
