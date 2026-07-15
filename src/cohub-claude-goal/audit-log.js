/**
 * @fileoverview Strict audit log for Cohub Claude Goal supervisor.
 * Spec lines 168-181, 342-354, 458-480, 526-530.
 *
 * Every append record: exact schemaVersion, required correlation fields,
 * null explicit where inapplicable, canonical JSON, prefix/previous/entry
 * hash chain, durable atomic append or immutable numbered records, exact
 * state reconciliation before append.
 *
 * Reject: accessors, symbols, dangerous keys, cycles, unsupported objects,
 * unknown/missing fields, corrupt/truncated/unexpected/symlink files.
 * Never overwrite corrupt evidence.
 *
 * Query by event/action/Turn must validate complete chain before returning.
 * Secret substrings absent from error/stdout/records.
 * Exact bytes preserved on failure.
 */

import { readdir, readFile, writeFile, rename, stat, lstat, open, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const SCHEMA_VERSION = 1;

const REQUIRED_FIELDS = new Set([
  'schemaVersion',
  'goalInstance',
  'goalVersion',
  'claudeSessionId',
  'type',
  'eventId',
  'actionId',
  'turnId',
  'beforeSnapshotHash',
  'afterSnapshotHash',
  'decision',
  'evidenceRefs',
  'timestamp',
  'seq',
  'previousEntryHash',
  'entryHash'
]);

const ALLOWED_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  'metadata'
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const VALID_TYPES = new Set([
  'OBSERVATION',
  'PREPARED',
  'REQUEST_STARTED',
  'CONFIRMED',
  'AMBIGUOUS',
  'ACTION',
  'CANCELLED_STALE_BEFORE_SEND',
  'BLOCKED_AMBIGUOUS_SEND'
]);

/**
 * Redact secrets from error messages using descriptor-safe zero-leak sanitizer.
 * Replace any potential secret substring with placeholder.
 * Never access record properties directly - use sanitized copies only.
 */
function sanitizeError(error, recordSnapshot) {
  let message = String(error?.message || error || '');

  // Don't sanitize validation errors - they don't contain user secrets
  if (!recordSnapshot || !message.includes('[')) {
    return message;
  }

  // Work with frozen snapshot to avoid getter triggers
  const sensitiveFields = ['eventId', 'actionId', 'turnId', 'claudeSessionId'];

  for (const field of sensitiveFields) {
    const value = recordSnapshot[field];
    if (value && typeof value === 'string' && value.length > 8) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');
      message = message.replace(regex, `[${field.toUpperCase()}]`);
    }
  }

  return message;
}

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasDangerousKeys(obj) {
  // Check both enumerable keys (Object.keys) and all own properties
  const allKeys = new Set([
    ...Object.keys(obj),
    ...Object.getOwnPropertyNames(obj)
  ]);

  for (const key of allKeys) {
    if (DANGEROUS_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

function hasAccessorProperties(obj) {
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  for (const desc of Object.values(descriptors)) {
    if (desc.get || desc.set) {
      return true;
    }
  }
  return false;
}

function hasSymbolKeys(obj) {
  return Object.getOwnPropertySymbols(obj).length > 0;
}

function detectCircular(obj, seen = new WeakSet()) {
  if (obj === null || typeof obj !== 'object') {
    return false;
  }

  if (seen.has(obj)) {
    return true;
  }

  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (detectCircular(item, seen)) {
        return true;
      }
    }
  } else {
    for (const value of Object.values(obj)) {
      if (detectCircular(value, seen)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Recursively validate object structure for dangerous patterns.
 * Checks all nested objects, not just top level.
 */
function validateObjectDeep(obj, path = 'record') {
  if (!isPlainObject(obj)) {
    throw new TypeError(`${path} must be a plain object`);
  }

  if (hasDangerousKeys(obj)) {
    throw new TypeError(`${path} contains dangerous keys (__proto__, constructor, prototype)`);
  }

  if (hasAccessorProperties(obj)) {
    throw new TypeError(`${path} contains accessor properties`);
  }

  if (hasSymbolKeys(obj)) {
    throw new TypeError(`${path} contains symbol keys`);
  }

  // Recursively validate nested objects and arrays
  for (const [key, value] of Object.entries(obj)) {
    // Check the key itself isn't dangerous
    if (DANGEROUS_KEYS.has(key)) {
      throw new TypeError(`${path} contains dangerous key: ${key}`);
    }

    if (isPlainObject(value)) {
      validateObjectDeep(value, `${path}.${key}`);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (isPlainObject(value[i])) {
          validateObjectDeep(value[i], `${path}.${key}[${i}]`);
        }
      }
    }
  }
}

/**
 * Validate record structure before serialization.
 * Throw on any violation - never silently accept bad data.
 */
function validateRecordStructure(record) {
  if (!isPlainObject(record)) {
    throw new TypeError('Record must be a plain object');
  }

  if (hasDangerousKeys(record)) {
    throw new TypeError('Record contains dangerous keys (__proto__, constructor, prototype)');
  }

  if (hasAccessorProperties(record)) {
    throw new TypeError('Record contains accessor properties');
  }

  if (hasSymbolKeys(record)) {
    throw new TypeError('Record contains symbol keys');
  }

  if (detectCircular(record)) {
    throw new TypeError('Record contains circular references');
  }

  // Check for unknown fields
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new TypeError(`Unknown field: ${key}`);
    }
  }

  // Check required fields (except those added during serialization)
  const requiredInputFields = [
    'goalInstance',
    'goalVersion',
    'claudeSessionId',
    'type',
    'beforeSnapshotHash',
    'afterSnapshotHash'
  ];

  for (const field of requiredInputFields) {
    if (!(field in record)) {
      throw new TypeError(`${field} is required but missing`);
    }
  }

  // Validate types
  if (typeof record.schemaVersion !== 'undefined' && record.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${record.schemaVersion}`);
  }

  if (typeof record.goalInstance !== 'string' || record.goalInstance.trim() === '') {
    throw new TypeError('goalInstance must be a non-empty string');
  }

  if (!Number.isInteger(record.goalVersion) || record.goalVersion < 1) {
    throw new TypeError('goalVersion must be a positive integer');
  }

  if (typeof record.claudeSessionId !== 'string') {
    throw new TypeError('claudeSessionId must be a string');
  }

  if (!VALID_TYPES.has(record.type)) {
    throw new TypeError(`Invalid type: ${record.type}`);
  }

  // Validate nullable fields are explicitly null or valid
  const nullableFields = ['eventId', 'actionId', 'turnId', 'decision'];
  for (const field of nullableFields) {
    if (field in record && record[field] !== null && typeof record[field] !== 'string') {
      throw new TypeError(`Field ${field} must be null or string`);
    }
  }

  // Validate evidenceRefs is array
  if ('evidenceRefs' in record && !Array.isArray(record.evidenceRefs)) {
    throw new TypeError('evidenceRefs must be an array');
  }

  if (Array.isArray(record.evidenceRefs)) {
    for (const ref of record.evidenceRefs) {
      if (!isPlainObject(ref)) {
        throw new TypeError('evidenceRefs items must be plain objects');
      }
      if (hasDangerousKeys(ref)) {
        throw new TypeError('evidenceRefs item contains dangerous keys');
      }
    }
  }

  // Recursively validate metadata if present
  if (record.metadata !== undefined) {
    validateObjectDeep(record.metadata, 'metadata');
  }
}

/**
 * Serialize record to canonical JSON.
 * Field order: schemaVersion first, then alphabetical.
 * Single line, no trailing whitespace, no extra spaces.
 */
function toCanonicalJSON(record) {
  const ordered = {};

  // schemaVersion always first
  ordered.schemaVersion = record.schemaVersion;

  // Then all other fields in sorted order
  const otherKeys = Object.keys(record)
    .filter(k => k !== 'schemaVersion')
    .sort();

  for (const key of otherKeys) {
    ordered[key] = record[key];
  }

  return JSON.stringify(ordered);
}

/**
 * Read all valid audit records from directory, in sequence order.
 * Ignore temp files and lock files. Detect corruption but don't fix it.
 */
async function readAuditRecords(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const records = [];
  const pattern = /^(\d{8})-([a-f0-9]{16,})\.json$/;

  for (const entry of entries) {
    // Skip temp files and lock files
    if (entry.startsWith('.audit-temp') || entry.startsWith('.audit-lock')) {
      continue;
    }

    const match = entry.match(pattern);
    if (!match) {
      continue;
    }

    const filePath = join(dir, entry);

    // Reject symlinks - use lstat to detect without following
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Audit log contains symlink: ${entry}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Audit log contains non-file entry: ${entry}`);
    }

    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read audit record ${entry}: ${err.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Audit record ${entry} contains invalid or truncated JSON`);
    }

    if (!parsed.seq || !parsed.entryHash) {
      throw new Error(`Audit record ${entry} missing seq or entryHash`);
    }

    records.push({ filePath, record: parsed, content });
  }

  // Sort by sequence
  records.sort((a, b) => a.record.seq - b.record.seq);

  return records;
}

/**
 * Validate audit log integrity: sequence continuity, hash chain, no tampering.
 * Never auto-fix corruption - preserve evidence.
 */
export async function validateAuditIntegrity(dir) {
  const errors = [];
  let records;

  try {
    records = await readAuditRecords(dir);
  } catch (err) {
    return {
      valid: false,
      recordCount: 0,
      headHash: null,
      errors: [err.message]
    };
  }

  if (records.length === 0) {
    return {
      valid: true,
      recordCount: 0,
      headHash: null,
      errors: []
    };
  }

  let previousHash = null;

  for (let i = 0; i < records.length; i++) {
    const { record, content, filePath } = records[i];
    const expectedSeq = i + 1;

    // Check sequence continuity - must be exactly i+1
    if (record.seq !== expectedSeq) {
      errors.push(`Sequence gap or duplicate: expected ${expectedSeq}, got ${record.seq} in ${basename(filePath)}`);
    }

    // Check previous hash link
    if (i === 0) {
      if (record.previousEntryHash !== null) {
        errors.push(`First record must have previousEntryHash=null, got ${record.previousEntryHash}`);
      }
    } else {
      if (record.previousEntryHash !== previousHash) {
        errors.push(`Hash chain broken at seq ${record.seq}: expected previous ${previousHash}, got ${record.previousEntryHash}`);
      }
    }

    // Verify entry hash - compute from record without entryHash field
    const { entryHash: _, ...recordWithoutHash } = record;
    const canonicalWithoutHash = toCanonicalJSON(recordWithoutHash);
    const computedHash = sha256(canonicalWithoutHash);
    if (record.entryHash !== computedHash) {
      errors.push(`Hash mismatch at seq ${record.seq}: computed ${computedHash}, recorded ${record.entryHash}`);
    }

    // Check filename includes correct hash prefix
    const filename = basename(filePath);
    if (!filename.includes(record.entryHash.slice(0, 16))) {
      errors.push(`Filename hash mismatch at seq ${record.seq}: ${filename} does not contain ${record.entryHash.slice(0, 16)}`);
    }

    previousHash = record.entryHash;
  }

  // Additional check: highest seq should equal record count
  if (records.length > 0) {
    const lastSeq = records[records.length - 1].record.seq;
    if (lastSeq !== records.length) {
      errors.push(`Sequence discontinuity: last seq is ${lastSeq} but only ${records.length} records exist`);
    }
  }

  return {
    valid: errors.length === 0,
    recordCount: records.length,
    headHash: previousHash,
    errors
  };
}

/**
 * Clean stale lock files that are older than timeout.
 */
async function cleanStaleLocks(dir, timeoutMs = 30000) {
  try {
    const entries = await readdir(dir);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.startsWith('.audit-lock-')) {
        continue;
      }

      const lockPath = join(dir, entry);
      try {
        const stats = await stat(lockPath);
        const age = now - stats.mtimeMs;
        if (age > timeoutMs) {
          await unlink(lockPath).catch(() => {});
        }
      } catch (err) {
        // Lock file disappeared, that's fine
      }
    }
  } catch (err) {
    // Directory doesn't exist or not accessible, that's fine
  }
}

/**
 * Append audit record with atomic write, hash chain, and integrity checks.
 * Never overwrite corrupt evidence. Fail fast on any violation.
 * Retries on concurrent write conflicts.
 */
export async function appendAuditRecord(dir, record, maxRetries = 5) {
  let lastError;

  // Create snapshot for error sanitization (frozen to prevent getter triggers)
  const recordSnapshot = Object.freeze({
    eventId: record?.eventId,
    actionId: record?.actionId,
    turnId: record?.turnId,
    claudeSessionId: record?.claudeSessionId
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Validate structure first
      validateRecordStructure(record);

      // Check integrity before append
      const integrity = await validateAuditIntegrity(dir);
      if (!integrity.valid) {
        throw new Error(`Cannot append to corrupt audit log: ${integrity.errors.join('; ')}`);
      }

      // CRITICAL FIX: Take lock FIRST, then scan for sequence
      // This ensures atomic sequence allocation
      const lockSeq = integrity.recordCount + 1;
      const seqPadded = String(lockSeq).padStart(8, '0');
      const lockPath = join(dir, `.audit-lock-${seqPadded}`);

      let lockFd;
      try {
        lockFd = await open(lockPath, 'wx');
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Lock exists - try to clean if stale, then retry
          await cleanStaleLocks(dir, 5000); // More aggressive: 5s timeout

          // Try once more after cleanup
          try {
            lockFd = await open(lockPath, 'wx');
          } catch (retryErr) {
            if (retryErr.code === 'EEXIST') {
              // Still locked - concurrent writer is active
              const conflictErr = new Error(`Sequence ${lockSeq} locked by concurrent writer`);
              conflictErr.code = 'EEXIST';
              throw conflictErr;
            }
            throw retryErr;
          }
        } else {
          throw err;
        }
      }

      // We have the lock, now verify sequence is still valid
      // Re-validate integrity under lock to ensure no race
      try {
        const integrityUnderLock = await validateAuditIntegrity(dir);
        if (!integrityUnderLock.valid) {
          throw new Error(`Cannot append to corrupt audit log: ${integrityUnderLock.errors.join('; ')}`);
        }

        if (integrityUnderLock.recordCount !== integrity.recordCount) {
          // Another writer completed between our first check and lock acquisition
          // Release lock and retry
          await lockFd.close();
          await unlink(lockPath).catch(() => {});
          const conflictErr = new Error(`Concurrent write detected, retrying`);
          conflictErr.code = 'EEXIST';
          throw conflictErr;
        }

        const nextSeq = integrityUnderLock.recordCount + 1;

        // Build complete record without entryHash first
        const recordWithoutHash = {
          schemaVersion: SCHEMA_VERSION,
          goalInstance: record.goalInstance,
          goalVersion: record.goalVersion,
          claudeSessionId: record.claudeSessionId,
          type: record.type,
          eventId: record.eventId ?? null,
          actionId: record.actionId ?? null,
          turnId: record.turnId ?? null,
          beforeSnapshotHash: record.beforeSnapshotHash,
          afterSnapshotHash: record.afterSnapshotHash,
          decision: record.decision ?? null,
          evidenceRefs: record.evidenceRefs ?? [],
          timestamp: new Date().toISOString(),
          seq: nextSeq,
          previousEntryHash: integrityUnderLock.headHash
        };

        // Add optional metadata if present (already validated)
        if (record.metadata !== undefined) {
          recordWithoutHash.metadata = record.metadata;
        }

        // Serialize to canonical JSON without entryHash
        const canonicalWithoutHash = toCanonicalJSON(recordWithoutHash);

        // Compute entry hash from canonical form
        const entryHash = sha256(canonicalWithoutHash);

        // Add entryHash to complete record
        const completeRecord = {
          ...recordWithoutHash,
          entryHash
        };

        // Serialize final record with hash
        const final = toCanonicalJSON(completeRecord);

        // Generate filename: 8-digit padded sequence + 16-char hash prefix
        const hashPrefix = entryHash.slice(0, 16);
        const filename = `${seqPadded}-${hashPrefix}.json`;
        const finalPath = join(dir, filename);

        // Write file atomically
        let fd;
        try {
          fd = await open(finalPath, 'wx', 0o644);
        } catch (err) {
          if (err.code === 'EEXIST') {
            // Shouldn't happen since we have the lock, but handle it
            const conflictErr = new Error(`Sequence ${completeRecord.seq} already exists`);
            conflictErr.code = 'EEXIST';
            throw conflictErr;
          }
          throw err;
        }

        // Write content and fsync
        try {
          await fd.writeFile(final, 'utf8');
          await fd.sync();
        } finally {
          await fd.close();
        }

        // Fsync directory - propagate real failures
        try {
          const dirFd = await open(dir, 'r');
          try {
            await dirFd.sync();
          } finally {
            await dirFd.close();
          }
        } catch (err) {
          // Only ignore errors that indicate fsync is not supported
          // ENOTSUP, EOPNOTSUPP, EISDIR, EBADF (on some platforms)
          const ignorableCodes = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EBADF', 'EINVAL']);
          if (!ignorableCodes.has(err.code)) {
            // Real error like ENOSPC, EIO - propagate it
            throw new Error(`Directory fsync failed: ${err.message}`);
          }
          // Otherwise, directory fsync not supported - that's OK
        }

        // Success - release lock
        await lockFd.close();
        await unlink(lockPath).catch(() => {});

        return {
          seq: completeRecord.seq,
          entryHash,
          filePath: finalPath
        };
      } catch (error) {
        // Release lock on any error in the locked section
        await lockFd.close();
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      // Validation errors (TypeError) should not be retried
      if (error instanceof TypeError) {
        throw error;
      }

      // If it's a conflict error, retry
      if (error.code === 'EEXIST' && attempt < maxRetries - 1) {
        lastError = error;
        // Small random delay to reduce contention
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5));
        continue;
      }

      // For other errors or final retry, sanitize and throw
      const sanitized = sanitizeError(error, recordSnapshot);
      // SECURITY FIX: Never use error.constructor directly
      const ErrorConstructor = (error instanceof TypeError) ? TypeError : Error;
      const err = new ErrorConstructor(sanitized);
      if (error.code) {
        err.code = error.code;
      }
      throw err;
    }
  }

  // If we exhausted retries
  const sanitized = sanitizeError(lastError, recordSnapshot);
  throw new Error(`Failed to append record after ${maxRetries} retries: ${sanitized}`);
}

/**
 * Query audit log by criteria: eventId, actionId, turnId, type.
 * Returns all matching records in sequence order.
 * MUST validate integrity before returning.
 */
export async function queryAuditLog(dir, criteria) {
  // CRITICAL FIX: Validate integrity before returning any data
  const integrity = await validateAuditIntegrity(dir);
  if (!integrity.valid) {
    throw new Error(`Cannot query corrupt audit log: ${integrity.errors.join('; ')}`);
  }

  const records = await readAuditRecords(dir);

  const results = records
    .map(r => r.record)
    .filter(record => {
      if (criteria.eventId !== undefined && record.eventId !== criteria.eventId) {
        return false;
      }
      if (criteria.actionId !== undefined && record.actionId !== criteria.actionId) {
        return false;
      }
      if (criteria.turnId !== undefined && record.turnId !== criteria.turnId) {
        return false;
      }
      if (criteria.type !== undefined && record.type !== criteria.type) {
        return false;
      }
      return true;
    });

  return results;
}

/**
 * Read entire audit log in sequence order.
 * MUST validate integrity before returning.
 */
export async function readAuditLog(dir) {
  // CRITICAL FIX: Validate integrity before returning any data
  const integrity = await validateAuditIntegrity(dir);
  if (!integrity.valid) {
    throw new Error(`Cannot read corrupt audit log: ${integrity.errors.join('; ')}`);
  }

  const records = await readAuditRecords(dir);
  return records.map(r => r.record);
}
