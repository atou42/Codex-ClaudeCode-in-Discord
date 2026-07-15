import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
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

function makeGoalDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-adv-'));
  fs.mkdirSync(path.join(dir, 'ledger'));
  return dir;
}

function baseFields(overrides = {}) {
  return {
    goalInstance: 'test-goal',
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

test('appendLedgerEntry writes schemaVersion 1 to every record', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const files = fs.readdirSync(path.join(dir, 'ledger'));
  const raw = fs.readFileSync(path.join(dir, 'ledger', files[0]), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schemaVersion, 1);
});

test('replayLedger rejects a record missing schemaVersion', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete parsed.schemaVersion;
  const newHash = computeEntryHash(parsed);
  parsed.entryHash = newHash;
  fs.unlinkSync(filePath);
  fs.writeFileSync(path.join(dir, 'ledger', `00000001-${newHash}.json`), JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects schemaVersion other than 1', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.schemaVersion = 2;
  const newHash = computeEntryHash(parsed);
  parsed.entryHash = newHash;
  fs.unlinkSync(filePath);
  fs.writeFileSync(path.join(dir, 'ledger', `00000001-${newHash}.json`), JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects non-integer seq', async () => {
  const dir = makeGoalDir();
  const entryNoHash = {
    schemaVersion: 1,
    seq: 1.5,
    timestamp: new Date().toISOString(),
    goalInstance: 'test-goal',
    goalVersion: 1,
    claudeSessionId: null,
    type: 'OBSERVED',
    eventId: 'evt-1',
    actionId: null,
    beforeSnapshotHash: null,
    afterSnapshotHash: null,
    decision: null,
    evidenceRefs: [],
    previousEntryHash: GENESIS_PREVIOUS_ENTRY_HASH,
  };
  const hash = computeEntryHash(entryNoHash);
  const entry = { ...entryNoHash, entryHash: hash };
  fs.writeFileSync(path.join(dir, 'ledger', `00000001-${hash}.json`), JSON.stringify(entry));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects negative seq', async () => {
  const dir = makeGoalDir();
  const entryNoHash = {
    schemaVersion: 1,
    seq: -1,
    timestamp: new Date().toISOString(),
    goalInstance: 'test-goal',
    goalVersion: 1,
    claudeSessionId: null,
    type: 'OBSERVED',
    eventId: 'evt-1',
    actionId: null,
    beforeSnapshotHash: null,
    afterSnapshotHash: null,
    decision: null,
    evidenceRefs: [],
    previousEntryHash: GENESIS_PREVIOUS_ENTRY_HASH,
  };
  const hash = computeEntryHash(entryNoHash);
  const entry = { ...entryNoHash, entryHash: hash };
  fs.writeFileSync(path.join(dir, 'ledger', `00000001-${hash}.json`), JSON.stringify(entry, null, 2));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects non-UTC-ISO timestamp', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.timestamp = 'not-a-timestamp';
  const newHash = computeEntryHash(parsed);
  parsed.entryHash = newHash;
  fs.unlinkSync(filePath);
  fs.writeFileSync(path.join(dir, 'ledger', `00000001-${newHash}.json`), JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects non-array evidenceRefs', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.evidenceRefs = 'not-an-array';
  const newHash = computeEntryHash(parsed);
  parsed.entryHash = newHash;
  fs.unlinkSync(filePath);
  fs.writeFileSync(path.join(dir, 'ledger', `00000001-${newHash}.json`), JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects record with unknown extra field', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const filePath = path.join(dir, 'ledger', `00000001-${r1.entry.entryHash}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  parsed.unknownField = 'bad';
  fs.writeFileSync(filePath, JSON.stringify(parsed));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects a directory in ledger/ as IntegrityError not silent temp', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  fs.mkdirSync(path.join(dir, 'ledger', 'subdir'));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects a symlink in ledger/ as IntegrityError not silent temp', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const target = path.join(dir, 'outside.txt');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, path.join(dir, 'ledger', 'link.json'));
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects near-miss JSON name "00000001-badhash.json" as IntegrityError not temp', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  fs.writeFileSync(path.join(dir, 'ledger', '00000001-badhash.json'), '{}');
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('replayLedger rejects malformed committed name with uppercase hex', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const badName = '00000002-' + 'A'.repeat(64) + '.json';
  fs.writeFileSync(path.join(dir, 'ledger', badName), '{}');
  await assert.rejects(() => replayLedger(dir), IntegrityError);
});

test('reconcileMaterializedState rejects state.json missing schemaVersion', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const state = {
    goalInstance: 'test-goal',
    goalVersion: 1,
    headSeq: 1,
    headHash: r1.entry.entryHash,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('reconcileMaterializedState rejects state.json with schemaVersion other than 1', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const state = {
    schemaVersion: 2,
    goalInstance: 'test-goal',
    goalVersion: 1,
    headSeq: 1,
    headHash: r1.entry.entryHash,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('reconcileMaterializedState rejects state.json with non-integer headSeq', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const state = {
    schemaVersion: 1,
    goalInstance: 'test-goal',
    goalVersion: 1,
    headSeq: '1',
    headHash: r1.entry.entryHash,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('reconcileMaterializedState rejects state.json with malformed headHash', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const state = {
    schemaVersion: 1,
    goalInstance: 'test-goal',
    goalVersion: 1,
    headSeq: 1,
    headHash: 'not-64-hex',
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('reconcileMaterializedState rejects state.json goalInstance mismatch', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields({ goalInstance: 'goal-a' }));
  const state = {
    schemaVersion: 1,
    goalInstance: 'goal-b',
    goalVersion: 1,
    headSeq: 1,
    headHash: r1.entry.entryHash,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('reconcileMaterializedState rejects state.json goalVersion mismatch', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields({ goalVersion: 1 }));
  const state = {
    schemaVersion: 1,
    goalInstance: 'test-goal',
    goalVersion: 2,
    headSeq: 1,
    headHash: r1.entry.entryHash,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const replay = await replayLedger(dir);
  await assert.rejects(() => reconcileMaterializedState(dir, replay), IntegrityError);
});

test('appendLedgerEntry validates materialized state before committing any new record', async () => {
  const dir = makeGoalDir();
  const r1 = await appendLedgerEntry(dir, baseFields());
  const corruptState = {
    schemaVersion: 1,
    goalInstance: 'test-goal',
    goalVersion: 1,
    headSeq: 99,
    headHash: r1.entry.entryHash,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(corruptState));
  const beforeLedger = fs.readdirSync(path.join(dir, 'ledger'));
  await assert.rejects(() => appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' })), IntegrityError);
  const afterLedger = fs.readdirSync(path.join(dir, 'ledger'));
  assert.deepEqual(beforeLedger, afterLedger, 'no new ledger record must be committed when state is corrupt');
});

test('appendLedgerEntry preserves exact corrupt state.json bytes on validation failure', async () => {
  const dir = makeGoalDir();
  await appendLedgerEntry(dir, baseFields());
  const corruptState = '{"schemaVersion":1,"headSeq":"not-an-int"}';
  fs.writeFileSync(path.join(dir, 'state.json'), corruptState);
  const before = fs.readFileSync(path.join(dir, 'state.json'));
  await assert.rejects(() => appendLedgerEntry(dir, baseFields({ eventId: 'evt-2' })), IntegrityError);
  const after = fs.readFileSync(path.join(dir, 'state.json'));
  assert.deepEqual(before, after, 'corrupt state bytes must be preserved exactly');
});
