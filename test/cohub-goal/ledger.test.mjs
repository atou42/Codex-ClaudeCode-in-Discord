import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLedgerEntry,
  replayLedger,
  reconcileMaterializedState,
  computeEntryHash,
  GENESIS_PREVIOUS_ENTRY_HASH,
} from '../../src/cohub-claude-goal/ledger.js';
import { IntegrityError } from '../../src/cohub-claude-goal/errors.js';
import { canonicalHash } from '../../src/cohub-claude-goal/canonical.js';

function makeGoalDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-'));
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

test('appendLedgerEntry rejects when a required field is missing (not even explicit null)', async () => {
  const dir = makeGoalDir();
  const fields = baseFields();
  delete fields.actionId;
  await assert.rejects(() => appendLedgerEntry(dir, fields));
});

test('appendLedgerEntry accepts explicit null for inapplicable fields', async () => {
  const dir = makeGoalDir();
  const result = await appendLedgerEntry(dir, baseFields());
  assert.equal(result.entry.actionId, null);
  assert.equal(result.entry.beforeSnapshotHash, null);
  assert.equal(result.entry.decision, null);
});

test('appendLedgerEntry writes seq starting at 1 with genesis previousEntryHash', async () => {
  const dir = makeGoalDir();
  const result = await appendLedgerEntry(dir, baseFields());
  assert.equal(result.entry.seq, 1);
  assert.equal(result.entry.previousEntryHash, GENESIS_PREVIOUS_ENTRY_HASH);
});

test('appendLedgerEntry chains previousEntryHash to the prior entryHash', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));
  const r2 = await appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' }));
  assert.equal(r2.entry.seq, 2);
  assert.equal(r2.entry.previousEntryHash, r1.entry.entryHash);
});

test('appendLedgerEntry writes a file named <seq8>-<entryHash>.json', async () => {
  const dir = makeGoalDir();
  const result = await appendLedgerEntry(dir, baseFields());
  const expectedName = `00000001-${result.entry.entryHash}.json`;
  assert.ok(fs.existsSync(path.join(dir, 'ledger', expectedName)));
});

test('appendLedgerEntry entryHash is the canonical hash of the entry without entryHash field', async () => {
  const dir = makeGoalDir();
  const result = await appendLedgerEntry(dir, baseFields());
  const { entryHash, ...withoutHash } = result.entry;
  assert.equal(computeEntryHash(withoutHash), entryHash);
});

test('appendLedgerEntry record file contains full required field set with explicit nulls preserved', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const files = fs.readdirSync(path.join(dir, 'ledger'));
  const raw = fs.readFileSync(path.join(dir, 'ledger', files[0]), 'utf8');
  const parsed = JSON.parse(raw);
  for (const key of [
    'seq',
    'timestamp',
    'goalInstance',
    'goalVersion',
    'claudeSessionId',
    'type',
    'eventId',
    'actionId',
    'beforeSnapshotHash',
    'afterSnapshotHash',
    'decision',
    'evidenceRefs',
    'previousEntryHash',
    'entryHash',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, key), `missing field ${key}`);
  }
  assert.equal(parsed.actionId, null);
});

test('appendLedgerEntry advances materialized state.json to match new ledger head', async () => {
  const dir = makeGoalDir();
  const result = await appendLedgerEntry(dir, baseFields());
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.headSeq, 1);
  assert.equal(state.headHash, result.entry.entryHash);
});

test('replayLedger replays contiguous valid records in order', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' }));
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-3' }));
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 3);
  assert.deepEqual(replay.records.map((r) => r.seq), [1, 2, 3]);
  assert.equal(replay.headSeq, 3);
  assert.equal(replay.headHash, replay.records[2].entryHash);
});

test('replayLedger reports temp files but excludes them from records', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const validTempName = `.00000002-${'a'.repeat(64)}.json.tmp-${process.pid}-${Date.now()}-${'b'.repeat(16)}`;
  fs.writeFileSync(path.join(dir, 'ledger', validTempName), 'partial-bytes');
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1);
  assert.deepEqual(replay.tempFilesFound, [validTempName]);
});

test('replayLedger on empty ledger returns headSeq 0 and no records', async () => {
  const dir = makeGoalDir();
  const replay = await replayLedger(dir);
  assert.equal(replay.headSeq, 0);
  assert.equal(replay.records.length, 0);
  assert.equal(replay.headHash, GENESIS_PREVIOUS_ENTRY_HASH);
});

test('replayLedger throws IntegrityError on sequence gap and preserves files', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));
  // simulate a gap by writing seq 3 directly with a bogus but well-formed-looking chain
  const bogusEntryNoHash = {
    seq: 3,
    timestamp: new Date().toISOString(),
    goalInstance: 'yu-gi-oh-duel-monsters-v1',
    goalVersion: 1,
    claudeSessionId: null,
    type: 'OBSERVED',
    eventId: 'evt-3',
    actionId: null,
    beforeSnapshotHash: null,
    afterSnapshotHash: null,
    decision: null,
    evidenceRefs: [],
    previousEntryHash: r1.entry.entryHash,
  };
  const bogusHash = computeEntryHash(bogusEntryNoHash);
  const bogusEntry = { ...bogusEntryNoHash, entryHash: bogusHash };
  fs.writeFileSync(path.join(dir, 'ledger', `00000003-${bogusHash}.json`), JSON.stringify(bogusEntry));
  const beforeBytes = fs.readFileSync(path.join(dir, 'ledger', `00000003-${bogusHash}.json`));

  await assert.rejects(() => replayLedger(dir), IntegrityError);

  const afterBytes = fs.readFileSync(path.join(dir, 'ledger', `00000003-${bogusHash}.json`));
  assert.deepEqual(beforeBytes, afterBytes);
});

test('replayLedger throws IntegrityError when a record entryHash does not match its own content', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.decision = 'TAMPERED';
  fs.writeFileSync(filePath, JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger throws IntegrityError when filename hash does not match recomputed hash', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const oldPath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const newPath = path.join(dir, 'ledger', '00000001-0000000000000000000000000000000000000000000000000000000000000000.json');
  fs.renameSync(oldPath, newPath);
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger throws IntegrityError when previousEntryHash chain is broken', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));
  const r2 = await appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' }));
  const filePath = path.join(dir, 'ledger', `00000002-${r2.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.previousEntryHash = 'f'.repeat(64);
  const newHash = computeEntryHash({ ...parsed, entryHash: undefined });
  parsed.entryHash = newHash;
  const newPath = path.join(dir, 'ledger', `00000002-${newHash}.json`);
  fs.unlinkSync(filePath);
  fs.writeFileSync(newPath, JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger throws IntegrityError on truncated/malformed JSON record', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  fs.writeFileSync(filePath, '{"seq":1,"trunc');
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger throws IntegrityError when goalVersion is inconsistent across records without a documented rebind', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ goalVersion: 1, eventId: 'evt-1' }));
  await assert.rejects(
    () => appendLedgerEntry(dir, baseFields({ goalVersion: 2, eventId: 'evt-2' })),
    IntegrityError,
  );
});

test('appendLedgerEntry rejects goalInstance mismatch against existing ledger head', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ goalInstance: 'goal-a' }));
  await assert.rejects(
    () => appendLedgerEntry(dir, baseFields({ goalInstance: 'goal-b' })),
    IntegrityError,
  );
});

test('crash during record write (mid-write) leaves temp preserved, no committed record, replay sees zero records', async () => {
  const dir = makeGoalDir();
  await assert.rejects(() =>
    appendLedgerEntry(dir, baseFields(), {
      recordCrashHook: (point) => {
        if (point === 'after-open') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 0);
  assert.equal(replay.tempFilesFound.length, 1);
});

test('crash after record fsync (before rename) leaves temp preserved, no committed record', async () => {
  const dir = makeGoalDir();
  await assert.rejects(() =>
    appendLedgerEntry(dir, baseFields(), {
      recordCrashHook: (point) => {
        if (point === 'after-fsync-file') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 0);
  assert.equal(replay.tempFilesFound.length, 1);
});

test('crash after record rename (before dir fsync) leaves committed record recoverable', async () => {
  const dir = makeGoalDir();
  await assert.rejects(() =>
    appendLedgerEntry(dir, baseFields(), {
      recordCrashHook: (point) => {
        if (point === 'after-rename') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1);
  assert.equal(replay.records[0].seq, 1);
});

test('crash after directory fsync but before state.json write: state.json missing, ledger has the record, reconcile advances state', async () => {
  const dir = makeGoalDir();
  await assert.rejects(() =>
    appendLedgerEntry(dir, baseFields(), {
      recordCrashHook: (point) => {
        if (point === 'after-fsync-dir') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1);
  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, true);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.headSeq, 1);
  assert.equal(state.headHash, replay.headHash);
});

test('crash during state.json write (mid-write): record committed, state.json still missing/behind, recoverable via reconcile', async () => {
  const dir = makeGoalDir();
  await assert.rejects(() =>
    appendLedgerEntry(dir, baseFields(), {
      stateCrashHook: (point) => {
        if (point === 'after-open') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  const replay = await replayLedger(dir);
  assert.equal(replay.records.length, 1, 'the ledger record itself must already be committed');
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, true);
});

test('crash after state.json rename: state already advanced correctly, second reconcile is a no-op', async () => {
  const dir = makeGoalDir();
  await assert.rejects(() =>
    appendLedgerEntry(dir, baseFields(), {
      stateCrashHook: (point) => {
        if (point === 'after-rename') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  const replay = await replayLedger(dir);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.headSeq, replay.headSeq);
  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, false);
});

test('reconcileMaterializedState advances a legitimately-behind but valid state.json to ledger head', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));
  // Roll state.json back to reflect only the first record (simulates a crash between record commit and state advance on the 2nd append).
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      goalInstance: 'yu-gi-oh-duel-monsters-v1',
      goalVersion: 1,
      headSeq: 1,
      headHash: r1.entry.entryHash,
      updatedAt: new Date().toISOString(),
    }),
  );
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' }), { skipStateWrite: true });
  const replay = await replayLedger(dir);
  assert.equal(replay.headSeq, 2);
  const stateBefore = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(stateBefore.headSeq, 1);

  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, true);
  const stateAfter = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(stateAfter.headSeq, 2);
  assert.equal(stateAfter.headHash, replay.headHash);
});

test('reconcileMaterializedState throws IntegrityError and preserves file when state.json is corrupt JSON', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  fs.writeFileSync(path.join(dir, 'state.json'), '{not valid');
  const replay = await replayLedger(dir);
  const before = fs.readFileSync(path.join(dir, 'state.json'));
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
  const after = fs.readFileSync(path.join(dir, 'state.json'));
  assert.deepEqual(before, after);
});

test('reconcileMaterializedState throws IntegrityError when state.json is ahead of ledger head', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      goalInstance: 'yu-gi-oh-duel-monsters-v1',
      goalVersion: 1,
      headSeq: 99,
      headHash: r1.entry.entryHash,
      updatedAt: new Date().toISOString(),
    }),
  );
  const replay = await replayLedger(dir);
  const before = fs.readFileSync(path.join(dir, 'state.json'));
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
  const after = fs.readFileSync(path.join(dir, 'state.json'));
  assert.deepEqual(before, after);
});

test('reconcileMaterializedState throws IntegrityError when state.json headHash does not correspond to its headSeq (non-prefix / contradictory)', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields({ eventId: 'evt-1' }));
  const r2 = await appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' }));
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      goalInstance: 'yu-gi-oh-duel-monsters-v1',
      goalVersion: 1,
      headSeq: 1,
      headHash: r2.entry.entryHash, // wrong: seq 1's hash should be r1's, not r2's
      updatedAt: new Date().toISOString(),
    }),
  );
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('reconcileMaterializedState is a no-op when state.json already matches ledger head exactly', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const replay = await replayLedger(dir);
  const before = fs.readFileSync(path.join(dir, 'state.json'));
  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, false);
  const after = fs.readFileSync(path.join(dir, 'state.json'));
  assert.deepEqual(before, after);
});

test('reconcileMaterializedState creates fresh state.json when none exists yet and ledger is nonempty', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields(), { skipStateWrite: true });
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  const replay = await replayLedger(dir);
  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, true);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.headSeq, 1);
  assert.equal(state.headHash, r1.entry.entryHash);
});

test('reconcileMaterializedState with empty ledger and no state.json is a no-op', async () => {
  const dir = makeGoalDir();
  const replay = await replayLedger(dir);
  const reconciled = await reconcileMaterializedState(dir, replay);
  assert.equal(reconciled.advanced, false);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});
