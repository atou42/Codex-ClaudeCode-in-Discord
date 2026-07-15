import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalHash } from './canonical.js';
import { writeFileAtomic } from './atomic-file.js';
import { IntegrityError } from './errors.js';

export const GENESIS_PREVIOUS_ENTRY_HASH = '0'.repeat(64);
const APPEND_LOCK_SUFFIX = '.append-lock';

const REQUIRED_INPUT_FIELDS = [
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
];

const REQUIRED_RECORD_FIELDS = [
  'schemaVersion',
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
];

const ALLOWED_RECORD_FIELDS = new Set(REQUIRED_RECORD_FIELDS);

const TEMP_FILE_RE = /^\.(\d{8})-([0-9a-f]{64})\.json\.tmp-(\d+)-(\d+)-([0-9a-f]{16})$/;

const COMMITTED_FILE_RE = /^(\d{8})-([0-9a-f]{64})\.json$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertValidRecordSchema(record, filePath) {
  if (!isPlainObject(record)) {
    throw new IntegrityError(`ledger replay: record ${filePath} is not a plain object`);
  }
  const actualKeys = Object.keys(record);
  for (const key of actualKeys) {
    if (!ALLOWED_RECORD_FIELDS.has(key)) {
      throw new IntegrityError(`ledger replay: record ${filePath} has unknown field "${key}"`);
    }
  }
  for (const key of REQUIRED_RECORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new IntegrityError(`ledger replay: record ${filePath} missing required field "${key}"`);
    }
  }
  if (record.schemaVersion !== 1) {
    throw new IntegrityError(`ledger replay: record ${filePath} schemaVersion must be 1, got ${JSON.stringify(record.schemaVersion)}`);
  }
  if (!Number.isInteger(record.seq) || record.seq < 1) {
    throw new IntegrityError(`ledger replay: record ${filePath} seq must be a positive integer, got ${JSON.stringify(record.seq)}`);
  }
  if (typeof record.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.timestamp)) {
    throw new IntegrityError(`ledger replay: record ${filePath} timestamp must be UTC ISO string, got ${JSON.stringify(record.timestamp)}`);
  }
  if (typeof record.entryHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.entryHash)) {
    throw new IntegrityError(`ledger replay: record ${filePath} entryHash must be 64-char lowercase hex, got ${JSON.stringify(record.entryHash)}`);
  }
  if (typeof record.previousEntryHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.previousEntryHash)) {
    throw new IntegrityError(`ledger replay: record ${filePath} previousEntryHash must be 64-char lowercase hex, got ${JSON.stringify(record.previousEntryHash)}`);
  }
  if (!Array.isArray(record.evidenceRefs)) {
    throw new IntegrityError(`ledger replay: record ${filePath} evidenceRefs must be an array, got ${typeof record.evidenceRefs}`);
  }
}

export function computeEntryHash(entry) {
  const { entryHash, ...rest } = entry;
  return canonicalHash(rest);
}

async function persistState(dir, headRecord, crashHook) {
  const statePath = path.join(dir, 'state.json');
  const stateObj = {
    schemaVersion: 1,
    goalInstance: headRecord.goalInstance,
    goalVersion: headRecord.goalVersion,
    headSeq: headRecord.seq,
    headHash: headRecord.entryHash,
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(statePath, JSON.stringify(stateObj, null, 2), {
    mode: 0o600,
    allowReplace: true,
    crashHook,
  });
}

export async function replayLedger(dir) {
  const ledgerDir = path.join(dir, 'ledger');

  let entries;
  try {
    entries = await fsPromises.readdir(ledgerDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { records: [], headSeq: 0, headHash: GENESIS_PREVIOUS_ENTRY_HASH, tempFilesFound: [] };
    }
    throw err;
  }

  const committed = [];
  const tempFilesFound = [];
  for (const name of entries) {
    const commitMatch = COMMITTED_FILE_RE.exec(name);
    const tempMatch = TEMP_FILE_RE.exec(name);
    if (commitMatch) {
      committed.push({ name, seq: Number(commitMatch[1]), fileHash: commitMatch[2] });
    } else if (tempMatch) {
      tempFilesFound.push(name);
    } else {
      const filePath = path.join(ledgerDir, name);
      let stat;
      try {
        stat = await fsPromises.lstat(filePath);
      } catch (err) {
        throw new IntegrityError(`ledger replay: cannot lstat unexpected entry ${name} in ${ledgerDir}: ${err.message}`);
      }
      if (stat.isDirectory()) {
        throw new IntegrityError(`ledger replay: unexpected directory ${name} in ${ledgerDir}`);
      }
      if (stat.isSymbolicLink()) {
        throw new IntegrityError(`ledger replay: unexpected symlink ${name} in ${ledgerDir}`);
      }
      throw new IntegrityError(`ledger replay: unexpected file ${name} in ${ledgerDir} (not a committed record or recognized temp pattern)`);
    }
  }
  tempFilesFound.sort();
  committed.sort((a, b) => a.seq - b.seq);

  const seenSeq = new Set();
  for (const c of committed) {
    if (seenSeq.has(c.seq)) {
      throw new IntegrityError(`ledger replay: duplicate seq ${c.seq} detected in ${ledgerDir}`);
    }
    seenSeq.add(c.seq);
  }

  const records = [];
  let previousHash = GENESIS_PREVIOUS_ENTRY_HASH;
  let headGoalInstance = null;
  let headGoalVersion = null;

  for (let i = 0; i < committed.length; i += 1) {
    const expectedSeq = i + 1;
    const c = committed[i];
    if (c.seq !== expectedSeq) {
      throw new IntegrityError(
        `ledger replay: sequence gap, expected seq ${expectedSeq} but found ${c.seq} (file ${c.name})`,
      );
    }

    const filePath = path.join(ledgerDir, c.name);
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (err) {
      throw new IntegrityError(`ledger replay: unable to read ${filePath}: ${err.message}`);
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      throw new IntegrityError(`ledger replay: malformed JSON in ${filePath}: ${err.message}`);
    }

    assertValidRecordSchema(record, filePath);
    if (record.seq !== expectedSeq) {
      throw new IntegrityError(`ledger replay: record ${filePath} declares seq ${record.seq}, expected ${expectedSeq}`);
    }

    let recomputedHash;
    try {
      recomputedHash = computeEntryHash(record);
    } catch (err) {
      throw new IntegrityError(`ledger replay: unable to canonicalize record ${filePath}: ${err.message}`);
    }
    if (recomputedHash !== record.entryHash) {
      throw new IntegrityError(`ledger replay: record ${filePath} entryHash does not match its own content`);
    }
    if (recomputedHash !== c.fileHash) {
      throw new IntegrityError(`ledger replay: record ${filePath} filename hash does not match recomputed hash`);
    }
    if (record.previousEntryHash !== previousHash) {
      throw new IntegrityError(`ledger replay: record ${filePath} previousEntryHash chain is broken`);
    }
    if (headGoalInstance !== null && record.goalInstance !== headGoalInstance) {
      throw new IntegrityError(
        `ledger replay: record ${filePath} goalInstance "${record.goalInstance}" differs from ledger's "${headGoalInstance}"`,
      );
    }
    if (headGoalVersion !== null && record.goalVersion !== headGoalVersion) {
      throw new IntegrityError(
        `ledger replay: record ${filePath} goalVersion ${record.goalVersion} differs from ledger's ${headGoalVersion}`,
      );
    }

    records.push(record);
    previousHash = record.entryHash;
    headGoalInstance = record.goalInstance;
    headGoalVersion = record.goalVersion;
  }

  return {
    records,
    headSeq: records.length,
    headHash: records.length > 0 ? records[records.length - 1].entryHash : GENESIS_PREVIOUS_ENTRY_HASH,
    tempFilesFound,
  };
}

export async function appendLedgerEntry(dir, fields, options = {}) {
  for (const key of REQUIRED_INPUT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error(`ledger append: missing required field "${key}"`);
    }
  }

  // DEFECT-2: Validate goalInstance is a non-empty string
  if (typeof fields.goalInstance !== 'string' || fields.goalInstance.length === 0) {
    throw new Error('ledger append: goalInstance must be a non-empty string');
  }

  // DEFECT-1: Acquire exclusive append lock to serialize concurrent appends.
  // The lock lives in the goal dir (not ledger/) so replayLedger's strict
  // directory scan never sees it.
  const ledgerDir = path.join(dir, 'ledger');
  const appendLockPath = path.join(dir, `ledger${APPEND_LOCK_SUFFIX}`);

  let appendLockFd;
  try {
    appendLockFd = await fsPromises.open(
      appendLockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Check if lock is stale (older than 30 seconds)
      let lockStat;
      try {
        lockStat = await fsPromises.stat(appendLockPath);
        const lockAge = Date.now() - lockStat.mtimeMs;
        if (lockAge > 30000) {
          // Try to read lock contents for forensics
          let lockContent = null;
          try {
            lockContent = await fsPromises.readFile(appendLockPath, 'utf8');
          } catch (readErr) {
            // Ignore read errors
          }
          throw new IntegrityError(
            `ledger append: stale append lock detected (age: ${Math.round(lockAge / 1000)}s, content: ${lockContent || 'unreadable'}); manual intervention required`
          );
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') {
          throw statErr;
        }
        // Lock disappeared between open attempt and stat; retry would be safe but we'll fail for clarity
      }
      throw new IntegrityError(
        `ledger append: another process is currently appending to the ledger; retry`
      );
    }
    throw err;
  }

  try {
    // Write lock metadata with descriptor validation
    const lockData = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
    });
    await appendLockFd.write(lockData, 0, 'utf8');
    await appendLockFd.sync();

    // Re-read ledger under lock to detect concurrent changes
    const replay = await replayLedger(dir);

    const statePath = path.join(dir, 'state.json');
    if (fs.existsSync(statePath)) {
      await reconcileMaterializedState(dir, replay);
    }

    if (replay.records.length > 0) {
      const head = replay.records[replay.records.length - 1];
      if (head.goalInstance !== fields.goalInstance) {
        throw new IntegrityError(
          `ledger append: goalInstance mismatch: ledger head is "${head.goalInstance}", got "${fields.goalInstance}"`,
        );
      }
      if (head.goalVersion !== fields.goalVersion) {
        throw new IntegrityError(
          `ledger append: goalVersion mismatch: ledger head is ${head.goalVersion}, got ${fields.goalVersion}`,
        );
      }
    }

    const seq = replay.headSeq + 1;
    const entryWithoutHash = {
      schemaVersion: 1,
      seq,
      timestamp: new Date().toISOString(),
      goalInstance: fields.goalInstance,
      goalVersion: fields.goalVersion,
      claudeSessionId: fields.claudeSessionId,
      type: fields.type,
      eventId: fields.eventId,
      actionId: fields.actionId,
      beforeSnapshotHash: fields.beforeSnapshotHash,
      afterSnapshotHash: fields.afterSnapshotHash,
      decision: fields.decision,
      evidenceRefs: fields.evidenceRefs,
      previousEntryHash: replay.headHash,
    };
    const entryHash = computeEntryHash(entryWithoutHash);
    const entry = { ...entryWithoutHash, entryHash };

    const fileName = `${String(seq).padStart(8, '0')}-${entryHash}.json`;
    const recordPath = path.join(ledgerDir, fileName);

    await writeFileAtomic(recordPath, JSON.stringify(entry, null, 2), {
      mode: 0o600,
      crashHook: options.recordCrashHook,
    });

    if (!options.skipStateWrite) {
      await persistState(dir, entry, options.stateCrashHook);
    }

    return { entry };
  } finally {
    // Always close and remove lock, even on error
    if (appendLockFd) {
      await appendLockFd.close();
      try {
        await fsPromises.unlink(appendLockPath);
      } catch (unlinkErr) {
        // If unlink fails, preserve forensic evidence but continue
        // The stale lock detection will catch it on next append
      }
    }
  }
}

export async function reconcileMaterializedState(dir, replay) {
  const statePath = path.join(dir, 'state.json');

  let raw = null;
  try {
    raw = await fsPromises.readFile(statePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  let existing = null;
  if (raw !== null) {
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      throw new IntegrityError(`materialized state: malformed JSON in ${statePath}: ${err.message}`);
    }
    const requiredStateFields = ['schemaVersion', 'goalInstance', 'goalVersion', 'headSeq', 'headHash', 'updatedAt'];
    for (const key of requiredStateFields) {
      if (!Object.prototype.hasOwnProperty.call(existing, key)) {
        throw new IntegrityError(`materialized state: missing field "${key}" in ${statePath}`);
      }
    }
    if (existing.schemaVersion !== 1) {
      throw new IntegrityError(`materialized state: schemaVersion must be 1 in ${statePath}, got ${JSON.stringify(existing.schemaVersion)}`);
    }
    if (!Number.isInteger(existing.headSeq) || existing.headSeq < 0) {
      throw new IntegrityError(`materialized state: headSeq must be a non-negative integer in ${statePath}, got ${JSON.stringify(existing.headSeq)}`);
    }
    if (typeof existing.headHash !== 'string' || !/^[0-9a-f]{64}$/.test(existing.headHash)) {
      throw new IntegrityError(`materialized state: headHash must be 64-char lowercase hex in ${statePath}, got ${JSON.stringify(existing.headHash)}`);
    }
    if (typeof existing.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(existing.updatedAt)) {
      throw new IntegrityError(`materialized state: updatedAt must be UTC ISO string in ${statePath}, got ${JSON.stringify(existing.updatedAt)}`);
    }
    if (replay.records.length > 0) {
      const ledgerGoalInstance = replay.records[0].goalInstance;
      const ledgerGoalVersion = replay.records[0].goalVersion;
      if (existing.goalInstance !== ledgerGoalInstance) {
        throw new IntegrityError(`materialized state: goalInstance mismatch in ${statePath}: state says "${existing.goalInstance}", ledger says "${ledgerGoalInstance}"`);
      }
      if (existing.goalVersion !== ledgerGoalVersion) {
        throw new IntegrityError(`materialized state: goalVersion mismatch in ${statePath}: state says ${existing.goalVersion}, ledger says ${ledgerGoalVersion}`);
      }
    }
  }

  if (existing === null) {
    if (replay.records.length === 0) {
      return { advanced: false };
    }
    await persistState(dir, replay.records[replay.records.length - 1]);
    return { advanced: true };
  }

  if (existing.headSeq > replay.headSeq) {
    throw new IntegrityError(
      `materialized state: state.json headSeq ${existing.headSeq} is ahead of ledger head ${replay.headSeq} (${statePath})`,
    );
  }

  if (existing.headSeq === replay.headSeq) {
    if (existing.headHash !== replay.headHash) {
      throw new IntegrityError(
        `materialized state: headHash mismatch at seq ${existing.headSeq} between ${statePath} and ledger head (contradictory state)`,
      );
    }
    return { advanced: false };
  }

  if (existing.headSeq === 0) {
    if (existing.headHash !== GENESIS_PREVIOUS_ENTRY_HASH) {
      throw new IntegrityError(`materialized state: headSeq 0 must carry the genesis headHash (${statePath})`);
    }
  } else {
    const recordAtSeq = replay.records.find((r) => r.seq === existing.headSeq);
    if (!recordAtSeq || recordAtSeq.entryHash !== existing.headHash) {
      throw new IntegrityError(
        `materialized state: headHash at seq ${existing.headSeq} does not correspond to a valid ledger prefix (non-prefix state) (${statePath})`,
      );
    }
  }

  await persistState(dir, replay.records[replay.records.length - 1]);
  return { advanced: true };
}
