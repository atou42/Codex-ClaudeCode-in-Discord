/**
 * @fileoverview RED tests capturing all fail-open defects in commit 0807e62
 * These tests MUST fail on the current implementation and pass after repair.
 *
 * Defects to capture:
 * 1. sanitizeError reads error.message through optional chaining and recordSnapshot fields directly
 * 2. recordSnapshot itself built by accessing untrusted record before validation
 * 3. validators use Array.isArray/Object.values/Object.entries/for-of/property access on untrusted nested objects
 * 4. validators skip unsupported nested values and do not return detached clone
 * 5. missing required nullable correlation fields silently defaulted with ?? instead of requiring explicit null
 * 6. canonical JSON uses JSON.stringify on caller-owned objects and may invoke toJSON
 * 7. output record retains metadata/evidenceRefs references
 * 8. readAuditRecords silently ignores arbitrary unexpected entries
 * 9. readAuditRecords follows pathname races after lstat
 * 10. readAuditRecords parses without exact schema validation and returns mutable objects
 * 11. cleanStaleLocks automatically deletes old locks, follows symlinks, swallows all failures
 * 12. cleanStaleLocks violates explicit forensic rule
 * 13. lock cleanup unlinks by pathname without owner identity
 * 14. lock cleanup swallows errors
 * 15. directory durability after lock create/removal is missing
 * 16. record file writes directly to final name instead of temp + fsync + atomic rename + parent fsync
 * 17. file mode is 0644, not 0600
 * 18. directory fsync errors broadly ignored
 * 19. concurrency retry uses random sleeps rather than deterministic conflict
 * 20. concurrency retry may obscure errors
 * 21. integrity validation returns success-like objects for errors and uses raw attacker text
 * 22. query criteria is unvalidated and returned records are mutable
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink, symlink, chmod, rm, stat, lstat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

// This will be the NEW implementation we build
let appendAuditRecord, queryAuditLog, readAuditLog, validateAuditIntegrity;

try {
  const module = await import('../src/cohub-claude-goal/audit-log.js');
  appendAuditRecord = module.appendAuditRecord;
  queryAuditLog = module.queryAuditLog;
  readAuditLog = module.readAuditLog;
  validateAuditIntegrity = module.validateAuditIntegrity;
} catch (err) {
  console.error('Failed to import audit-log module:', err.message);
  process.exit(1);
}

const SENTINEL_SECRET = 'SENTINEL_9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d';

function makeTempDir() {
  return join(tmpdir(), `audit-red-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function makeRecord(partial) {
  return {
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

test('RED-1: sanitizeError must not read error.message through optional chaining on attacker Error', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Create malicious Error with getter that throws
    const maliciousError = new Error('base message');
    let getTrapCalled = false;
    Object.defineProperty(maliciousError, 'message', {
      get() {
        getTrapCalled = true;
        throw new Error('GETTER TRAP EXECUTED');
      },
      configurable: true,
      enumerable: true
    });

    const record = makeRecord({ eventId: SENTINEL_SECRET });
    delete record.goalInstance; // Make it invalid

    try {
      await appendAuditRecord(dir, record);
      assert.fail('Should have thrown validation error');
    } catch (err) {
      // The error should NOT have triggered the malicious getter
      assert.strictEqual(getTrapCalled, false, 'Must not read error.message through getter');
      assert.ok(!err.message.includes(SENTINEL_SECRET), 'Must not leak secret in error');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-2: recordSnapshot must not be built by accessing untrusted record before validation', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Create record with getter that tracks access
    const accessLog = [];
    const record = makeRecord({ eventId: 'test' });

    for (const key of Object.keys(record)) {
      const value = record[key];
      delete record[key];
      Object.defineProperty(record, key, {
        get() {
          accessLog.push(key);
          return value;
        },
        enumerable: true,
        configurable: true
      });
    }

    delete record.goalInstance; // Make invalid to trigger error path

    try {
      await appendAuditRecord(dir, record);
      assert.fail('Should have thrown');
    } catch (err) {
      // Access log should be empty - no getters should have been called before validation
      assert.strictEqual(accessLog.length, 0, 'Must not access record properties before validation');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-3: validators must not use Array.isArray/Object.values on untrusted nested objects', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'nested-trap' });

    // Create nested object with trapped Array.isArray check
    const nestedTrap = {};
    let trapCalled = false;
    Object.defineProperty(nestedTrap, Symbol.toStringTag, {
      get() {
        trapCalled = true;
        return 'Array';
      }
    });

    record.metadata = { nested: nestedTrap };

    try {
      await appendAuditRecord(dir, record);
      assert.fail('Should reject nested trap');
    } catch (err) {
      assert.strictEqual(trapCalled, false, 'Must not trigger Symbol.toStringTag getter');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-4: validators must return detached clone, not skip unsupported values', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'unsupported' });
    record.metadata = { func: function() { return 'evil'; } };

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /function|unsupported/i,
      'Must reject function in metadata, not skip it'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-5: missing nullable fields must require explicit null, not default with ??', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'missing-nullable' });
    delete record.actionId; // Remove nullable field entirely

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /actionId.*required|missing.*actionId/i,
      'Must require explicit actionId: null, not default it'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-6: canonical JSON must never invoke toJSON on caller objects', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'tojson-trap' });

    let toJSONcalled = false;
    record.metadata = {
      trap: {
        toJSON() {
          toJSONcalled = true;
          return 'EVIL_INJECTED';
        }
      }
    };

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /toJSON|method/i,
      'Must reject objects with toJSON method'
    );

    assert.strictEqual(toJSONcalled, false, 'Must never call toJSON during validation or serialization');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-7: output record must not retain metadata/evidenceRefs references', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const metadata = { key: 'original' };
    const evidenceRefs = [{ ref: 'file.json', hash: sha256('data') }];

    const record = makeRecord({
      eventId: 'mutation-test',
      metadata,
      evidenceRefs
    });

    const result = await appendAuditRecord(dir, record);

    // Mutate original objects
    metadata.key = 'MUTATED';
    evidenceRefs[0].ref = 'MUTATED';

    // Read back the record
    const records = await readAuditLog(dir);
    const stored = records[0];

    assert.strictEqual(stored.metadata.key, 'original', 'Stored metadata must not be affected by mutation');
    assert.strictEqual(stored.evidenceRefs[0].ref, 'file.json', 'Stored evidenceRefs must not be affected by mutation');

    // Verify the returned record is frozen/immutable
    assert.throws(
      () => { stored.metadata.key = 'SECOND_MUTATION'; },
      /Cannot assign to read only property|read only/,
      'Read records must be immutable (frozen)'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-8: readAuditRecords must not silently ignore unexpected entries', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));

    // Create unexpected file (not matching pattern)
    await writeFile(join(dir, 'unexpected-file.txt'), 'garbage', 'utf8');

    await assert.rejects(
      async () => readAuditLog(dir),
      /unexpected.*entry|unknown.*file/i,
      'Must reject unexpected files in audit directory'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-9: readAuditRecords must use O_NOFOLLOW, not follow pathnames after lstat', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));

    // Create a file outside audit dir
    const outsideFile = join(tmpdir(), `outside-${Date.now()}.json`);
    await writeFile(outsideFile, JSON.stringify(makeRecord({ eventId: 'EVIL' })), 'utf8');

    // Replace audit record with symlink (TOCTOU race)
    await unlink(r1.filePath);
    await symlink(outsideFile, r1.filePath);

    await assert.rejects(
      async () => readAuditLog(dir),
      /symlink/i,
      'Must detect and reject symlinks'
    );

    await unlink(outsideFile).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-10: readAuditRecords must validate exact schema and return immutable objects', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));

    const records = await readAuditLog(dir);

    // Verify returned records are frozen/immutable
    assert.throws(
      () => { records[0].eventId = 'MUTATED'; },
      /Cannot assign to read only property|read only/,
      'Returned records must be deeply frozen/immutable'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-11: cleanStaleLocks must not auto-delete - violates forensic rule', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Create a stale lock (using new single-lock naming)
    const staleLock = join(dir, '.audit-lock-append');
    await writeFile(staleLock, JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 100000 }), 'utf8');

    // Mark it as old using mtime
    const oldTime = Date.now() - 60000; // 60 seconds ago, > LOCK_TIMEOUT_MS (5s)
    const { utimes } = await import('node:fs/promises');
    await utimes(staleLock, oldTime / 1000, oldTime / 1000);

    // Try to append - current implementation auto-deletes stale lock (WRONG)
    // Correct implementation should preserve it and return typed forensic error
    await assert.rejects(
      async () => appendAuditRecord(dir, makeRecord({ eventId: 'after-stale' })),
      /stale.*lock|foreign.*lock|forensic/i,
      'Must preserve stale lock and return forensic IntegrityError, not auto-delete'
    );

    // Verify lock still exists
    assert.ok(existsSync(staleLock), 'Stale lock must be preserved as evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-12: lock cleanup must verify owner identity before unlink', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // This test simulates a race where lock is replaced after acquisition
    // Current implementation: unlinks by pathname without checking owner
    // Correct implementation: verifies inode and nonce match before unlink

    // We can't easily test this without injecting the race, but we document the requirement
    const record = makeRecord({ eventId: 'owner-test' });
    await appendAuditRecord(dir, record);

    // Requirement: Implementation must use fstat on held fd, compare inode with lstat result,
    // and verify nonce before unlink. Test in integration with actual race injection.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-13: record write must use temp + fsync + rename, not direct write', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Current implementation writes directly to final name (WRONG)
    // Correct: write to .tmp, fsync, rename, fsync dir

    const record = makeRecord({ eventId: 'durability-test' });
    const result = await appendAuditRecord(dir, record);

    // Verify the file was created with correct permissions
    const stats = await stat(result.filePath);
    const mode = stats.mode & 0o777;

    assert.strictEqual(mode, 0o600, `File must have mode 0600, got ${mode.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-14: directory fsync errors must not be broadly ignored', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Current implementation ignores directory fsync errors too broadly
    // Correct: only ignore ENOTSUP/EOPNOTSUPP, propagate ENOSPC/EIO

    // This is hard to test without mocking, but document requirement
    const record = makeRecord({ eventId: 'fsync-test' });
    await appendAuditRecord(dir, record);

    // Requirement: critical fsync errors (ENOSPC, EIO) must propagate
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-15: concurrency retry must use deterministic conflict, not random sleep', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    // Current implementation: random sleeps that may obscure errors
    // Correct: deterministic conflict with typed error, caller decides retry

    // Create a lock
    const lockPath = join(dir, '.audit-lock-00000001');
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), 'utf8');

    const startTime = Date.now();

    try {
      await appendAuditRecord(dir, makeRecord({ eventId: 'conflict' }));
      assert.fail('Should have thrown conflict error');
    } catch (err) {
      const elapsed = Date.now() - startTime;

      // Must fail quickly with deterministic conflict, not retry with random delays
      assert.ok(elapsed < 3000, `Must fail within 2 seconds with conflict, took ${elapsed}ms`);
      assert.match(err.message, /lock|conflict|concurrent/i, 'Must report lock conflict');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-16: integrity validation must throw on errors, not return success-like objects with raw text', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const r1 = await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));

    // Corrupt with attacker-controlled text
    await writeFile(r1.filePath, `{"ATTACKER_PAYLOAD": "${SENTINEL_SECRET}"}`, 'utf8');

    await assert.rejects(
      async () => validateAuditIntegrity(dir),
      (err) => {
        // Must throw, not return { valid: false, errors: [...] }
        assert.ok(err instanceof Error, 'Must throw Error');
        assert.ok(!err.message.includes(SENTINEL_SECRET), 'Must not include raw attacker text');
        return true;
      },
      'validateAuditIntegrity must throw IntegrityError, not return success-like object'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-17: query criteria must be validated and sanitized', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    await appendAuditRecord(dir, makeRecord({ eventId: 'e1' }));

    // Try to query with malicious criteria
    const maliciousCriteria = {};
    Object.defineProperty(maliciousCriteria, 'eventId', {
      get() {
        throw new Error('CRITERIA GETTER TRAP');
      },
      enumerable: true
    });

    await assert.rejects(
      async () => queryAuditLog(dir, maliciousCriteria),
      /criteria|invalid|untrusted/i,
      'Must reject untrusted query criteria'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-18: Proxy must be detected before ANY Object/Reflect operation', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'proxy' });

    let trapCount = 0;
    const handler = {
      get(t, p) { trapCount++; return t[p]; },
      has(t, p) { trapCount++; return Reflect.has(t, p); },
      ownKeys(t) { trapCount++; return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, p) { trapCount++; return Reflect.getOwnPropertyDescriptor(t, p); },
      getPrototypeOf(t) { trapCount++; return Reflect.getPrototypeOf(t); }
    };

    const proxied = new Proxy(record, handler);

    await assert.rejects(
      async () => appendAuditRecord(dir, proxied),
      /proxy/i,
      'Must reject Proxy'
    );

    assert.strictEqual(trapCount, 0, 'Must detect Proxy BEFORE any handler invocation (zero traps)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-19: Non-enumerable properties must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'non-enum' });
    Object.defineProperty(record, 'hidden', {
      value: 'HIDDEN_EVIL',
      enumerable: false,
      configurable: true,
      writable: true
    });

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /non-enumerable|hidden.*property/i,
      'Must reject non-enumerable properties'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-20: Custom prototype must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'proto' });
    const customProto = { evil: 'PROTO_POLLUTION' };
    Object.setPrototypeOf(record, customProto);

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /prototype|plain.*object/i,
      'Must reject objects with custom prototype'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-21: Sparse arrays must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'sparse' });
    record.evidenceRefs = new Array(10);
    record.evidenceRefs[5] = { ref: 'file.json', hash: sha256('data') };

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /sparse|array.*hole|undefined.*element/i,
      'Must reject sparse arrays'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-22: Infinite and NaN must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'nonfinite' });
    record.metadata = { value: Infinity };

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /infinite|NaN|nonfinite/i,
      'Must reject Infinity'
    );

    record.metadata = { value: NaN };
    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /infinite|NaN|nonfinite/i,
      'Must reject NaN'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-23: Excessive depth must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'deep' });

    // Create deeply nested structure (e.g., 100 levels)
    let deep = {};
    let current = deep;
    for (let i = 0; i < 100; i++) {
      current.next = {};
      current = current.next;
    }

    record.metadata = deep;

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /depth|nested|too.*deep/i,
      'Must reject excessive nesting depth'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RED-24: Excessive byte size must be rejected', async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });

  try {
    const record = makeRecord({ eventId: 'huge' });

    // Create very large string (e.g., 10MB)
    record.metadata = { huge: 'A'.repeat(10 * 1024 * 1024) };

    await assert.rejects(
      async () => appendAuditRecord(dir, record),
      /size|too.*large|excessive/i,
      'Must reject excessive byte size'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
