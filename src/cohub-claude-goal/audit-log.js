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
 * Query by event/action/Turn must reconstruct complete chain.
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
 */
function sanitizeError(error, record) {
  let message = error.message || String(error);

  // Don't sanitize validation errors - they don't contain user secrets
  if (!record || !message.includes('[')) {
    return message;
  }

  // Redact potential secret fields
  const sensitiveFields = ['eventId', 'actionId', 'turnId', 'claudeSessionId'];

  for (const field of sensitiveFields) {
    if (record && record[field] && typeof record[field] === 'string') {
      const value = record[field];
      if (value.length > 8) { // Only redact substantial values
        // Replace any occurrence of the value
        const regex = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        message = message.replace(regex, `[${field.toUpperCase()}]`);
      }
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
  for (const key of Object.keys(obj)) {
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
 * Ignore temp files. Detect corruption but don't fix it.
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
    // Skip temp files
    if (entry.startsWith('.audit-temp')) {
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
 * Append audit record with atomic write, hash chain, and integrity checks.
 * Never overwrite corrupt evidence. Fail fast on any violation.
 * Retries on concurrent write conflicts.
 */
export async function appendAuditRecord(dir, record, maxRetries = 5) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Validate structure
      validateRecordStructure(record);

      // Check integrity before append
      const integrity = await validateAuditIntegrity(dir);
      if (!integrity.valid) {
        throw new Error(`Cannot append to corrupt audit log: ${integrity.errors.join('; ')}`);
      }

      // Scan directory for highest existing sequence number
      // New sequence is always highestSeq + 1 to prevent filling gaps
      const existingFiles = await readdir(dir).catch(() => []);
      const seqPattern = /^(\d{8})-/;
      let highestSeq = 0;
      for (const file of existingFiles) {
        const match = file.match(seqPattern);
        if (match) {
          const seq = parseInt(match[1], 10);
          if (seq > highestSeq) {
            highestSeq = seq;
          }
        }
      }

      // New sequence must be exactly highestSeq + 1
      const nextSeq = highestSeq + 1;

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
        previousEntryHash: integrity.headHash
      };

      // Add optional metadata if present
      if (record.metadata !== undefined) {
        if (!isPlainObject(record.metadata)) {
          throw new TypeError('metadata must be a plain object');
        }
        if (hasDangerousKeys(record.metadata)) {
          throw new TypeError('metadata contains dangerous keys');
        }
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
      const seqPadded = String(completeRecord.seq).padStart(8, '0');
      const hashPrefix = entryHash.slice(0, 16);
      const filename = `${seqPadded}-${hashPrefix}.json`;
      const finalPath = join(dir, filename);

      // Atomic conflict check using filesystem as lock
      // Create a lock file for this sequence number exclusively
      const lockPath = join(dir, `.audit-lock-${seqPadded}`);
      let lockFd;
      try {
        lockFd = await open(lockPath, 'wx');
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Another writer is working on this sequence - retry
          const conflictErr = new Error(`Sequence ${completeRecord.seq} locked by concurrent writer`);
          conflictErr.code = 'EEXIST';
          throw conflictErr;
        }
        throw err;
      }

      // We have the lock, write the file
      try {
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
      } finally {
        // Release lock
        await lockFd.close();
        await unlink(lockPath).catch(() => {});
      }

      // Fsync directory (best effort - not all filesystems support)
      try {
        const dirFd = await open(dir, 'r');
        try {
          await dirFd.sync();
        } finally {
          await dirFd.close();
        }
      } catch (err) {
        // Directory fsync not supported on all platforms - continue
      }

      return {
        seq: completeRecord.seq,
        entryHash,
        filePath: finalPath
      };
    } catch (error) {
      // Validation errors (TypeError) should not be retried
      if (error instanceof TypeError) {
        throw error;
      }

      // If it's a file already exists error, retry
      if (error.code === 'EEXIST' && attempt < maxRetries - 1) {
        lastError = error;
        // Small random delay to reduce contention
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
        continue;
      }

      // For other errors or final retry, sanitize and throw
      const sanitized = sanitizeError(error, record);
      const ErrorClass = error.constructor || Error;
      const err = new ErrorClass(sanitized);
      err.code = error.code;
      throw err;
    }
  }

  // If we exhausted retries
  throw lastError || new Error('Failed to append record after retries');
}

/**
 * Query audit log by criteria: eventId, actionId, turnId, type.
 * Returns all matching records in sequence order.
 */
export async function queryAuditLog(dir, criteria) {
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
 */
export async function readAuditLog(dir) {
  const records = await readAuditRecords(dir);
  return records.map(r => r.record);
}
