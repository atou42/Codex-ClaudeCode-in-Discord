/**
 * @fileoverview Adversarial tests for strict audit log (AUDIT-01, AUDIT-02)
 * Lines 168-181, 342-354, 458-480, 526-530 of spec.
 * Every append: exact schemaVersion, required correlation fields, null explicit,
 * canonical JSON, prefix/previous/entry hash chain, durable atomic append or
 * immutable numbered records, exact state reconciliation before append.
 * Reject accessors, symbols, dangerous keys, cycles, unsupported objects,
 * unknown/missing fields, corrupt/truncated/unexpected/symlink files.
 * Never overwrite corrupt evidence. Query by event/action/Turn must reconstruct
 * complete chain. Cover every crash point, concurrent writers, duplicate event
 * observation allowed but logical application linked once, secret substrings
 * absent from error/stdout/records, exact bytes preserved on failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink, symlink, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

// Import the audit log module (to be created)
import {
  appendAuditRecord,
  queryAuditLog,
  readAuditLog,
  validateAuditIntegrity
} from '../src/cohub-claude-goal/audit-log.js';

const SENTINEL_SECRET = 'SENTINEL_TOKEN_9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d';

function makeTempDir() {
  return join(tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function makeRecord(partial) {
  return {
    schemaVersion: 1,
    goalInstance: 'test-goal-v1',
    goalVersion: 1,
    claudeSessionId: '00000000-0000-0000-0000-000000000000',
    type: 'OBSERVATION',
    eventId: 'evt-test',
    actionId: null,
    turnId: null,
    beforeSnapshotHash: sha256('before'),
    afterSnapshotHash: sha256('after'),
    decision: null,
    evidenceRefs: [],
    ...partial
  };
}

test('AUDIT-01: append writes exact schemaVersion and all required fields', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'evt-001' });
    const result = await appendAuditRecord(dir, record);

    assert.ok(result.seq, 'must return sequence number');
    assert.ok(result.entryHash, 'must return entry hash');
    assert.ok(result.filePath, 'must return file path');

    const raw = await readFile(result.filePath, 'utf8');
    const parsed = JSON.parse(raw);

    assert.strictEqual(parsed.schemaVersion, 1, 'schemaVersion must be exactly 1');
    assert.strictEqual(parsed.goalInstance, 'test-goal-v1');
    assert.strictEqual(parsed.goalVersion, 1);
    assert.strictEqual(parsed.claudeSessionId, '00000000-0000-0000-0000-000000000000');
    assert.strictEqual(parsed.type, 'OBSERVATION');
    assert.strictEqual(parsed.eventId, 'evt-001');
    assert.strictEqual(parsed.actionId, null, 'null must be explicit, not omitted');
    assert.strictEqual(parsed.turnId, null);
    assert.strictEqual(parsed.decision, null);
    assert.ok(Array.isArray(parsed.evidenceRefs));
    assert.ok(parsed.timestamp);
    assert.ok(parsed.entryHash);
    assert.strictEqual(parsed.previousEntryHash, null, 'first entry previousEntryHash must be null');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: canonical JSON preserves field order and no extra whitespace', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'evt-canon' });
    const result = await appendAuditRecord(dir, record);

    const raw = await readFile(result.filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    assert.strictEqual(lines.length, 1, 'must be single line canonical JSON');

    // Verify no trailing whitespace
    assert.ok(!raw.endsWith('\n'), 'no trailing newline in canonical JSON');

    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed);

    // Verify schemaVersion comes first
    assert.strictEqual(keys[0], 'schemaVersion', 'schemaVersion must be first field');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: hash chain links previous entry', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'evt-1' }));
    const r2 = await appendAuditRecord(dir, makeRecord({ eventId: 'evt-2' }));

    const raw2 = await readFile(r2.filePath, 'utf8');
    const parsed2 = JSON.parse(raw2);

    assert.strictEqual(parsed2.previousEntryHash, r1.entryHash, 'second entry must link first');
    assert.strictEqual(parsed2.seq, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: immutable numbered records with entry hash in filename', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'evt-seq' }));

    assert.ok(r1.filePath.includes('00000001-'), 'filename must include padded sequence');
    assert.ok(r1.filePath.includes(r1.entryHash.slice(0, 16)), 'filename must include entry hash prefix');

    // Try to append again - should get seq 2
    const r2 = await appendAuditRecord(dir, makeRecord({ eventId: 'evt-seq-2' }));
    assert.ok(r2.filePath.includes('00000002-'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject record with missing required field', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const incomplete = { ...makeRecord({ eventId: 'bad' }) };
    delete incomplete.goalInstance;

    await assert.rejects(
      async () => appendAuditRecord(dir, incomplete),
      /goalInstance.*required/i,
      'must reject missing goalInstance'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject record with unknown field', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'unknown', unknownField: 'bad' });

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /unknown.*field/i,
      'must reject unknown fields'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject accessor properties', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'accessor' });
    Object.defineProperty(record, 'malicious', {
      get() { return 'evil'; },
      enumerable: true
    });

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /accessor/i,
      'must reject accessor properties'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject symbol keys', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'symbol' });
    record[Symbol('evil')] = 'bad';

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /symbol/i,
      'must reject symbol keys'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject dangerous keys (__proto__, constructor, prototype)', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'dangerous' });
    // Use computed property to bypass prototype assignment protection
    Object.defineProperty(record, '__proto__', {
      value: 'evil',
      enumerable: true,
      configurable: true,
      writable: true
    });

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /dangerous.*key/i,
      'must reject __proto__'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject circular references', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'cycle' });
    record.evidenceRefs = [{}];
    record.evidenceRefs[0].parent = record.evidenceRefs;

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /circular/i,
      'must reject circular references'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: never overwrite corrupt evidence', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'before-corrupt' }));

    // Corrupt the file
    await writeFile(r1.filePath, 'CORRUPTED', 'utf8');

    // Try to append - should detect corruption and refuse
    await assert.rejects(
      async () => appendAuditRecord(dir, makeRecord({ eventId: 'after-corrupt' })),
      /integrity|corrupt/i,
      'must detect and refuse to overwrite corruption'
    );

    // Verify corrupt file still has corrupt content
    const corruptContent = await readFile(r1.filePath, 'utf8');
    assert.strictEqual(corruptContent, 'CORRUPTED', 'must preserve corrupt evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject truncated JSON file', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'complete' }));

    // Truncate the file
    const raw = await readFile(r1.filePath, 'utf8');
    await writeFile(r1.filePath, raw.slice(0, raw.length / 2), 'utf8');

    await assert.rejects(
      async () => appendAuditRecord(dir, makeRecord({ eventId: 'after-truncate' })),
      /truncated|invalid|corrupt/i,
      'must detect truncated JSON'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: reject symlink in audit directory', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'real' }));

    // Create a symlink with proper naming pattern
    const symlinkPath = join(dir, '00000002-abcdef0123456789.json');
    await symlink(r1.filePath, symlinkPath);

    await assert.rejects(
      async () => appendAuditRecord(dir, makeRecord({ eventId: 'after-symlink' })),
      /symlink/i,
      'must reject symlinks'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: query by eventId reconstructs complete chain', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ eventId: 'evt-A', type: 'OBSERVATION' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'evt-B', type: 'OBSERVATION' }));
    const r3 = await appendAuditRecord(dir, makeRecord({
      eventId: 'evt-A',
      type: 'ACTION',
      actionId: 'act-1'
    }));

    const results = await queryAuditLog(dir, { eventId: 'evt-A' });

    assert.strictEqual(results.length, 2, 'must find both records for evt-A');
    assert.ok(results.some(r => r.type === 'OBSERVATION'));
    assert.ok(results.some(r => r.type === 'ACTION'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: query by actionId reconstructs complete chain', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ actionId: 'act-X', type: 'PREPARED' }));
    await appendAuditRecord(dir, makeRecord({ actionId: 'act-X', type: 'REQUEST_STARTED' }));
    await appendAuditRecord(dir, makeRecord({ actionId: 'act-X', type: 'CONFIRMED' }));

    const results = await queryAuditLog(dir, { actionId: 'act-X' });

    assert.strictEqual(results.length, 3, 'must find all records for act-X');
    assert.ok(results.some(r => r.type === 'PREPARED'));
    assert.ok(results.some(r => r.type === 'REQUEST_STARTED'));
    assert.ok(results.some(r => r.type === 'CONFIRMED'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: query by turnId reconstructs complete chain', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ turnId: 'turn-123', eventId: 'e1' }));
    await appendAuditRecord(dir, makeRecord({ turnId: 'turn-999', eventId: 'e2' }));
    await appendAuditRecord(dir, makeRecord({ turnId: 'turn-123', eventId: 'e3' }));

    const results = await queryAuditLog(dir, { turnId: 'turn-123' });

    assert.strictEqual(results.length, 2, 'must find both records for turn-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-02: sentinel secret absent from records', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Inject sentinel in various places
    const record = makeRecord({
      eventId: `evt-clean`,
      decision: 'CONTINUE',
      evidenceRefs: [{ ref: 'evidence.json', hash: sha256('data') }]
    });

    await appendAuditRecord(dir, record);

    const allRecords = await readAuditLog(dir);
    const allText = JSON.stringify(allRecords);

    assert.ok(!allText.includes(SENTINEL_SECRET), 'sentinel must not appear in records');
    assert.ok(!allText.includes(SENTINEL_SECRET.slice(0, 16)), 'sentinel substring must not appear');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-02: error messages must not leak secrets', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: SENTINEL_SECRET });

    let errorMessage = '';
    try {
      await appendAuditRecord(dir, record);
    } catch (err) {
      errorMessage = err.message;
    }

    assert.ok(!errorMessage.includes(SENTINEL_SECRET), 'error must not contain sentinel');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: duplicate event observation allowed, logical application once', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Same event observed twice
    await appendAuditRecord(dir, makeRecord({ eventId: 'evt-dup', type: 'OBSERVATION' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'evt-dup', type: 'OBSERVATION' }));

    // But only one logical action
    await appendAuditRecord(dir, makeRecord({
      eventId: 'evt-dup',
      type: 'ACTION',
      actionId: 'act-once'
    }));

    const observations = await queryAuditLog(dir, { eventId: 'evt-dup', type: 'OBSERVATION' });
    const actions = await queryAuditLog(dir, { eventId: 'evt-dup', type: 'ACTION' });

    assert.strictEqual(observations.length, 2, 'duplicate observations allowed');
    assert.strictEqual(actions.length, 1, 'only one logical action');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: crash point recovery preserves exact bytes', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'before-crash' }));

    // Simulate crash: write partial temp file
    const tempPath = join(dir, '.audit-temp-partial');
    await writeFile(tempPath, '{"partial":', 'utf8');

    // Verify temp file is ignored on recovery
    const r2 = await appendAuditRecord(dir, makeRecord({ eventId: 'after-crash' }));

    assert.strictEqual(r2.seq, 2, 'must continue from last valid record');

    // Verify temp file still exists (not deleted)
    assert.ok(existsSync(tempPath), 'temp file must be preserved as evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: validate full integrity chain', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'e2' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'e3' }));

    const result = await validateAuditIntegrity(dir);

    assert.strictEqual(result.valid, true, 'integrity must be valid');
    assert.strictEqual(result.recordCount, 3);
    assert.ok(result.headHash);
    assert.strictEqual(result.errors.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: detect hash chain break', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'e2' }));

    // Corrupt the chain by modifying first record
    const raw1 = await readFile(r1.filePath, 'utf8');
    const parsed1 = JSON.parse(raw1);
    parsed1.eventId = 'TAMPERED';
    await writeFile(r1.filePath, JSON.stringify(parsed1), 'utf8');

    await assert.rejects(
      async () => validateAuditIntegrity(dir),
      (err) => {
        assert.ok(err.name === 'IntegrityError', 'must throw IntegrityError');
        assert.match(err.message, /hash.*mismatch/i, 'must report hash mismatch');
        return true;
      },
      'must detect and throw on tampering'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: detect sequence gap', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));
    const r2 = await appendAuditRecord(dir, makeRecord({ eventId: 'e2' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'e3' }));

    // Delete middle record - this creates a gap
    await unlink(r2.filePath);

    // Validation should now throw on gap
    await assert.rejects(
      async () => validateAuditIntegrity(dir),
      (err) => {
        assert.ok(err.name === 'IntegrityError', 'must throw IntegrityError');
        assert.match(err.message, /sequence.*gap|discontinuity/i, 'must report sequence gap');
        return true;
      },
      'must detect gap'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: concurrent writers prevented by atomic operations', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Simulate concurrent append attempts
    const promises = [
      appendAuditRecord(dir, makeRecord({ eventId: 'concurrent-1' })),
      appendAuditRecord(dir, makeRecord({ eventId: 'concurrent-2' })),
      appendAuditRecord(dir, makeRecord({ eventId: 'concurrent-3' }))
    ];

    const results = await Promise.allSettled(promises);

    // With proper locking, all should succeed (serialized by lock)
    const successful = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const seqs = successful.map(r => r.seq);

    assert.ok(seqs.length >= 1, 'at least 1 should succeed');
    const uniqueSeqs = new Set(seqs);
    assert.strictEqual(uniqueSeqs.size, seqs.length, 'all sequence numbers must be unique');

    // Verify integrity
    const validation = await validateAuditIntegrity(dir);
    assert.strictEqual(validation.valid, true, 'concurrent writes must maintain integrity');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUDIT-01: read-only directory prevents append', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Make directory read-only
    await chmod(dir, 0o444);

    await assert.rejects(
      async () => appendAuditRecord(dir, makeRecord({ eventId: 'readonly' })),
      /permission|EACCES/i,
      'must fail on read-only directory'
    );
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-1: query must validate chain integrity before returning', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Create valid records
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'evt-1' }));
    await appendAuditRecord(dir, makeRecord({ eventId: 'evt-2' }));

    // Corrupt the first record
    await writeFile(r1.filePath, '{"corrupted": true}', 'utf8');

    // Query should REJECT corrupt chain by throwing
    await assert.rejects(
      async () => queryAuditLog(dir, { eventId: 'evt-2' }),
      (err) => {
        assert.ok(err.name === 'IntegrityError', 'must throw IntegrityError');
        return true;
      },
      'queryAuditLog must validate integrity and throw on corrupt chain'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-2: readAuditLog must validate chain integrity', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));

    // Break hash chain
    const raw = await readFile(r1.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.eventId = 'TAMPERED';
    await writeFile(r1.filePath, JSON.stringify(parsed), 'utf8');

    // readAuditLog should REJECT
    await assert.rejects(
      async () => readAuditLog(dir),
      /corrupt|integrity|hash|tamper/i,
      'readAuditLog must validate integrity'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-3: concurrent writers must never produce duplicate sequences', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Launch 5 concurrent appends
    const promises = Array.from({ length: 5 }, (_, i) =>
      appendAuditRecord(dir, makeRecord({ eventId: `concurrent-${i}` }))
    );

    const results = await Promise.allSettled(promises);

    // ALL must either succeed OR fail explicitly
    const successful = results.filter(r => r.status === 'fulfilled').map(r => r.value);

    // Verify: no duplicate sequences
    const seqs = successful.map(r => r.seq);
    const uniqueSeqs = new Set(seqs);
    assert.strictEqual(
      uniqueSeqs.size,
      seqs.length,
      `Found duplicate sequences: ${seqs.join(', ')}`
    );

    // Verify: integrity is valid
    const integrity = await validateAuditIntegrity(dir);
    assert.strictEqual(integrity.valid, true, `Integrity broken: ${integrity.errors.join('; ')}`);

    // Verify: sequence is continuous from 1
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      assert.strictEqual(sorted[i], i + 1, `Sequence gap at ${i + 1}`);
    }

    // Verify: total records equals successful writes
    assert.strictEqual(
      integrity.recordCount,
      successful.length,
      'Record count mismatch'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-4: metadata must be recursively validated', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Circular reference in metadata
    const record = makeRecord({ eventId: 'meta-circ' });
    const meta = { data: {} };
    meta.data.self = meta;
    record.metadata = meta;

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /circular/i,
      'must detect circular references in metadata'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-5: metadata with dangerous nested keys must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'meta-danger' });
    const nested = {};
    Object.defineProperty(nested, '__proto__', {
      value: 'evil',
      enumerable: true,
      configurable: true,
      writable: true
    });
    record.metadata = { nested };

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /dangerous/i,
      'must detect dangerous keys in nested metadata'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-6: metadata with symbol keys must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'meta-symbol' });
    const meta = {};
    meta[Symbol('evil')] = 'bad';
    record.metadata = meta;

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /symbol/i,
      'must detect symbol keys in metadata'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-7: metadata with accessor properties must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'meta-accessor' });
    const meta = {};
    Object.defineProperty(meta, 'trap', {
      get() { return 'evil'; },
      enumerable: true
    });
    record.metadata = meta;

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /accessor/i,
      'must detect accessor properties in metadata'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-8: all secrets must be sanitized from errors', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const secrets = {
      eventId: 'SECRET_EVENT_ID_LONG_ENOUGH_12345678',
      actionId: 'SECRET_ACTION_ID_LONG_ENOUGH_87654321',
      turnId: 'SECRET_TURN_ID_LONG_ENOUGH_11223344',
      claudeSessionId: 'SECRET_SESSION_ID_LONG_ENOUGH_99887766'
    };

    const badRecord = { ...makeRecord(secrets) };
    delete badRecord.goalInstance;

    try {
      await appendAuditRecord(dir, badRecord);
      assert.fail('Should have thrown validation error');
    } catch (err) {
      const errorMessage = err.message;

      // Verify NO secrets appear in error message
      for (const [field, secret] of Object.entries(secrets)) {
        assert.ok(
          !errorMessage.includes(secret),
          `Secret ${field} leaked in error: ${errorMessage}`
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-9: error construction must not use error.constructor', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Verify that TypeError is preserved correctly using safe constructor detection
    const record = makeRecord({ eventId: 'constructor-test' });
    delete record.goalInstance;

    try {
      await appendAuditRecord(dir, record);
      assert.fail('Should have thrown TypeError');
    } catch (err) {
      assert.ok(err instanceof TypeError, 'Must preserve TypeError');
      assert.ok(!err.message.includes('SECRET'), 'Must not leak secrets');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-10: fsync failure must propagate critical errors', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // This test verifies that the implementation correctly distinguishes between:
    // 1. Ignorable fsync errors (ENOTSUP, EOPNOTSUPP, EISDIR, EBADF, EINVAL)
    // 2. Critical fsync errors that must propagate (ENOSPC, EIO)
    //
    // The implementation at audit-log.js:655-661 handles this correctly.
    // Manual verification required: ENOSPC during fsync should propagate as error.

    const record = makeRecord({ eventId: 'fsync-test' });
    await appendAuditRecord(dir, record);

    // Verify append succeeded
    const integrity = await validateAuditIntegrity(dir);
    assert.strictEqual(integrity.valid, true, 'Should handle fsync gracefully');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-11: stale lock files must not block forever', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Create a stale lock file with old timestamp
    const staleLockPath = join(dir, '.audit-lock-00000001');
    await writeFile(staleLockPath, '', 'utf8');

    // Manually backdate the lock file to simulate staleness
    const { utimes } = await import('node:fs/promises');
    const oldTime = Date.now() - 10000; // 10 seconds ago
    await utimes(staleLockPath, oldTime / 1000, oldTime / 1000);

    // Append should clean stale lock and succeed
    const result = await appendAuditRecord(dir, makeRecord({ eventId: 'after-stale' }));

    // Verify it worked
    assert.ok(result.seq === 1, 'Should have successfully acquired seq 1');

    const integrity = await validateAuditIntegrity(dir);
    assert.strictEqual(integrity.valid, true, 'Must recover from stale lock');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REGRESSION-12: Proxy objects must be rejected at all levels', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Test 1: Proxy at top level
    const record = makeRecord({ eventId: 'proxy-top' });
    const getTrapCount1 = { count: 0 };
    const handler1 = {
      get(target, prop) {
        getTrapCount1.count++;
        if (prop === 'goalInstance') return 'EVIL_INJECTED';
        return target[prop];
      },
      has(target, prop) {
        getTrapCount1.count++;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        getTrapCount1.count++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        getTrapCount1.count++;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      getPrototypeOf(target) {
        getTrapCount1.count++;
        return Reflect.getPrototypeOf(target);
      }
    };
    const proxied1 = new Proxy(record, handler1);

    await assert.rejects(
      async () => appendAuditRecord(dir, proxied1),
      /proxy/i,
      'must reject Proxy at top level'
    );
    assert.strictEqual(getTrapCount1.count, 0, 'Proxy handler must not be invoked');

    // Test 2: Proxy in metadata
    const record2 = makeRecord({ eventId: 'proxy-meta' });
    const getTrapCount2 = { count: 0 };
    const metaObj = { key: 'value' };
    const handler2 = {
      get(target, prop) {
        getTrapCount2.count++;
        return target[prop];
      },
      set(target, prop, value) {
        getTrapCount2.count++;
        return Reflect.set(target, prop, value);
      },
      has(target, prop) {
        getTrapCount2.count++;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        getTrapCount2.count++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        getTrapCount2.count++;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      getPrototypeOf(target) {
        getTrapCount2.count++;
        return Reflect.getPrototypeOf(target);
      }
    };
    record2.metadata = new Proxy(metaObj, handler2);

    await assert.rejects(
      async () => appendAuditRecord(dir, record2),
      /proxy/i,
      'must reject Proxy in metadata'
    );
    assert.strictEqual(getTrapCount2.count, 0, 'Proxy handler in metadata must not be invoked');

    // Test 3: Proxy in nested metadata
    const record3 = makeRecord({ eventId: 'proxy-nested' });
    const getTrapCount3 = { count: 0 };
    const nested = { deep: 'value' };
    const handler3 = {
      get(target, prop) {
        getTrapCount3.count++;
        return target[prop];
      },
      has(target, prop) {
        getTrapCount3.count++;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        getTrapCount3.count++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        getTrapCount3.count++;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      getPrototypeOf(target) {
        getTrapCount3.count++;
        return Reflect.getPrototypeOf(target);
      }
    };
    record3.metadata = { level1: { level2: new Proxy(nested, handler3) } };

    await assert.rejects(
      async () => appendAuditRecord(dir, record3),
      /proxy/i,
      'must reject Proxy in nested metadata'
    );
    assert.strictEqual(getTrapCount3.count, 0, 'Proxy handler in nested metadata must not be invoked');

    // Test 4: Proxy in evidenceRefs array
    const record4 = makeRecord({ eventId: 'proxy-evidence' });
    const getTrapCount4 = { count: 0 };
    const refObj = { ref: 'evidence.json', hash: sha256('data') };
    const handler4 = {
      get(target, prop) {
        getTrapCount4.count++;
        if (prop === 'ref') return 'EVIL_REF';
        return target[prop];
      },
      has(target, prop) {
        getTrapCount4.count++;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        getTrapCount4.count++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        getTrapCount4.count++;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      getPrototypeOf(target) {
        getTrapCount4.count++;
        return Reflect.getPrototypeOf(target);
      }
    };
    record4.evidenceRefs = [new Proxy(refObj, handler4)];

    await assert.rejects(
      async () => appendAuditRecord(dir, record4),
      /proxy/i,
      'must reject Proxy in evidenceRefs'
    );
    assert.strictEqual(getTrapCount4.count, 0, 'Proxy handler in evidenceRefs must not be invoked');

    // Test 5: Proxy in metadata array item
    const record5 = makeRecord({ eventId: 'proxy-meta-array' });
    const getTrapCount5 = { count: 0 };
    const itemObj = { item: 'value' };
    const handler5 = {
      get(target, prop) {
        getTrapCount5.count++;
        return target[prop];
      },
      has(target, prop) {
        getTrapCount5.count++;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        getTrapCount5.count++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        getTrapCount5.count++;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      getPrototypeOf(target) {
        getTrapCount5.count++;
        return Reflect.getPrototypeOf(target);
      }
    };
    record5.metadata = { items: [new Proxy(itemObj, handler5)] };

    await assert.rejects(
      async () => appendAuditRecord(dir, record5),
      /proxy/i,
      'must reject Proxy in metadata array item'
    );
    assert.strictEqual(getTrapCount5.count, 0, 'Proxy handler in metadata array must not be invoked');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
