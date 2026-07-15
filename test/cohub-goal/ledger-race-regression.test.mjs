import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  appendLedgerEntry,
  replayLedger,
} from '../../src/cohub-claude-goal/ledger.js';
import { IntegrityError } from '../../src/cohub-claude-goal/errors.js';

function makeGoalDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-race-'));
  fs.mkdirSync(path.join(dir, 'ledger'));
  return dir;
}

function baseFields(overrides = {}) {
  return {
    goalInstance: 'yu-gi-oh-duel-monsters-v1',
    goalVersion: 1,
    claudeSessionId: '0ba32795-ab95-443e-b8c6-c773388bd4b7',
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

test('DEFECT-1 regression: concurrent appendLedgerEntry in same process corrupts ledger with duplicate seq', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));

  // Two concurrent appends
  const results = await Promise.allSettled([
    appendLedgerEntry(dir, baseFields({ eventId: 'evt-2a' })),
    appendLedgerEntry(dir, baseFields({ eventId: 'evt-2b' })),
  ]);

  // At least one must fail with conflict
  const failures = results.filter(r => r.status === 'rejected');
  assert.ok(failures.length > 0, 'at least one concurrent append must fail');

  // Ledger must remain valid
  const replay = await replayLedger(dir);
  assert.ok(replay.records.length >= 2, 'ledger must have at least 2 records');

  // No duplicate seq numbers
  const seqs = replay.records.map(r => r.seq);
  const uniqueSeqs = new Set(seqs);
  assert.equal(seqs.length, uniqueSeqs.size, 'no duplicate seq numbers');
});

test('DEFECT-1 regression: concurrent appendLedgerEntry across processes corrupts ledger', async (t) => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));

  // Create a worker script
  const workerScript = `
    import { appendLedgerEntry } from '${path.resolve('./src/cohub-claude-goal/ledger.js')}';
    const fields = {
      goalInstance: 'yu-gi-oh-duel-monsters-v1',
      goalVersion: 1,
      claudeSessionId: '0ba32795-ab95-443e-b8c6-c773388bd4b7',
      type: 'OBSERVED',
      eventId: process.argv[2],
      actionId: null,
      beforeSnapshotHash: null,
      afterSnapshotHash: null,
      decision: null,
      evidenceRefs: [],
    };
    try {
      await appendLedgerEntry('${dir}', fields);
      console.log('SUCCESS');
      process.exit(0);
    } catch (err) {
      console.error('CONFLICT:', err.message);
      process.exit(1);
    }
  `;

  const scriptPath = path.join(dir, 'worker.mjs');
  fs.writeFileSync(scriptPath, workerScript);

  // Spawn two processes concurrently
  const p1 = spawn(process.execPath, [scriptPath, 'evt-2a'], { stdio: 'pipe' });
  const p2 = spawn(process.execPath, [scriptPath, 'evt-2b'], { stdio: 'pipe' });

  const waitForProcess = (proc) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  const [r1, r2] = await Promise.all([waitForProcess(p1), waitForProcess(p2)]);

  // At least one must succeed
  const successCount = [r1, r2].filter(r => r.code === 0).length;
  assert.ok(successCount >= 1, 'at least one process must succeed');

  // Ledger must remain valid
  const replay = await replayLedger(dir);
  assert.ok(replay.records.length >= 2, 'ledger must have at least 2 records');

  // No duplicate seq numbers
  const seqs = replay.records.map(r => r.seq);
  const uniqueSeqs = new Set(seqs);
  assert.equal(seqs.length, uniqueSeqs.size, 'no duplicate seq numbers allowed');
});

test('DEFECT-2 regression: appendLedgerEntry rejects empty goalInstance string', async () => {
  const dir = makeGoalDir();

  await assert.rejects(
    () => appendLedgerEntry(dir, { ...baseFields(), goalInstance: '' }),
    (err) => {
      assert.ok(err.message.includes('goalInstance'));
      assert.ok(err.message.includes('non-empty'));
      return true;
    },
    'must reject empty goalInstance'
  );

  // Ledger must remain empty
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 0, 'no record should be written');
});

test('DEFECT-2 regression: appendLedgerEntry validates goalInstance is non-empty string', async () => {
  const dir = makeGoalDir();

  // Empty string
  await assert.rejects(
    () => appendLedgerEntry(dir, { ...baseFields(), goalInstance: '' }),
    /goalInstance.*non-empty/
  );

  // Non-string types
  await assert.rejects(
    () => appendLedgerEntry(dir, { ...baseFields(), goalInstance: null }),
    /goalInstance.*non-empty string/
  );

  await assert.rejects(
    () => appendLedgerEntry(dir, { ...baseFields(), goalInstance: 123 }),
    /goalInstance.*non-empty string/
  );

  // Valid non-empty string succeeds
  await appendLedgerEntry(dir, baseFields({ goalInstance: 'valid-instance' }));
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1);
  assert.equal(replay.records[0].goalInstance, 'valid-instance');
});
