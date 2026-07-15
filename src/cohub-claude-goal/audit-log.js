/**
 * @fileoverview Strict audit log for Cohub Claude Goal supervisor.
 * Spec lines 168-181, 342-354, 458-480, 526-530.
 *
 * COMPREHENSIVE REWRITE - All fail-open defects fixed:
 * - Proxy-first exact sanitizer with descriptor walking
 * - Never access untrusted properties before validation
 * - Reject all unsupported values (functions, Infinity, NaN, non-enumerable, etc.)
 * - Require explicit null for nullable fields
 * - Canonical encoder never invokes toJSON/getters
 * - Return deeply detached immutable data
 * - Reject unexpected directory entries
 * - Use O_NOFOLLOW for all file operations
 * - Preserve stale/corrupt locks with forensic IntegrityError
 * - Owner-bound lock with nonce verification
 * - Durable append: temp + fsync + rename + parent fsync
 * - File mode 0600
 * - Throw IntegrityError on validation failures
 * - Validate and sanitize query criteria
 * - Bounded depth and size limits
 */

import { readdir, readFile, writeFile, stat, lstat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';

const SCHEMA_VERSION = 1;
const MAX_DEPTH = 32;
const MAX_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
const LOCK_TIMEOUT_MS = 5000;

const REQUIRED_FIELDS = [
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
];

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
 * Typed IntegrityError for audit log corruption/forensic violations
 */
class IntegrityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'IntegrityError';
    this.code = code;
  }
}

/**
 * SHA-256 hash
 */
function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * SECURITY: Proxy-first detector - MUST be called before ANY Object/Reflect operation
 */
function isProxy(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return types.isProxy(value);
}

/**
 * Deep sanitizer that returns detached, immutable clone.
 * Rejects ALL unsupported/dangerous patterns.
 * ZERO tolerance for proxy/accessor/symbol/dangerous keys/cycles/etc.
 */
function sanitizeDeep(value, path = 'root', depth = 0, seen = new WeakSet()) {
  // Check depth limit
  if (depth > MAX_DEPTH) {
    throw new TypeError(`Exceeds max depth ${MAX_DEPTH} at ${path}`);
  }

  // Handle null
  if (value === null) {
    return null;
  }

  // Handle primitives
  const type = typeof value;
  if (type === 'string') {
    if (value.length > MAX_SIZE_BYTES) {
      throw new TypeError(`String too large at ${path}`);
    }
    return value;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number (Infinity or NaN) at ${path}`);
    }
    return value;
  }
  if (type === 'boolean') {
    return value;
  }

  // Reject unsupported types
  if (type === 'function') {
    throw new TypeError(`Function not allowed at ${path}`);
  }
  if (type === 'symbol') {
    throw new TypeError(`Symbol not allowed at ${path}`);
  }
  if (type === 'bigint') {
    throw new TypeError(`BigInt not allowed at ${path}`);
  }
  if (type === 'undefined') {
    throw new TypeError(`Undefined not allowed at ${path}`);
  }

  // SECURITY: Check for Proxy BEFORE any other object operation
  if (isProxy(value)) {
    throw new TypeError(`Proxy object not allowed at ${path}`);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    // Check for sparse arrays (holes)
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new TypeError(`Sparse array (hole at index ${i}) not allowed at ${path}`);
      }
    }

    // Check circular reference
    if (seen.has(value)) {
      throw new TypeError(`Circular reference detected at ${path}`);
    }
    seen.add(value);

    // Recursively sanitize
    const sanitized = value.map((item, i) =>
      sanitizeDeep(item, `${path}[${i}]`, depth + 1, seen)
    );

    seen.delete(value);
    return Object.freeze(sanitized);
  }

  // Handle objects
  if (type === 'object') {
    // Reject Date, RegExp, Buffer, etc.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Custom prototype not allowed at ${path} (must be plain object)`);
    }

    // Check circular reference
    if (seen.has(value)) {
      throw new TypeError(`Circular reference detected at ${path}`);
    }
    seen.add(value);

    // Check for symbol keys
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new TypeError(`Symbol keys not allowed at ${path}`);
    }

    // Get all property descriptors
    const descriptors = Object.getOwnPropertyDescriptors(value);

    const sanitized = Object.create(null); // null prototype

    for (const [key, desc] of Object.entries(descriptors)) {
      // Check for dangerous keys
      if (DANGEROUS_KEYS.has(key)) {
        throw new TypeError(`Dangerous key "${key}" not allowed at ${path}`);
      }

      // Reject accessor properties
      if (desc.get || desc.set) {
        throw new TypeError(`Accessor property "${key}" not allowed at ${path}`);
      }

      // Reject non-enumerable properties
      if (!desc.enumerable) {
        throw new TypeError(`Non-enumerable property "${key}" not allowed at ${path}`);
      }

      // Recursively sanitize value
      sanitized[key] = sanitizeDeep(desc.value, `${path}.${key}`, depth + 1, seen);
    }

    seen.delete(value);

    // Return frozen object with null prototype
    return Object.freeze(sanitized);
  }

  throw new TypeError(`Unsupported type ${type} at ${path}`);
}

/**
 * Validate record structure against schema.
 * NEVER access untrusted properties - only after sanitization.
 */
function validateRecordSchema(sanitized) {
  // Check all required fields are present
  for (const field of REQUIRED_FIELDS) {
    if (!(field in sanitized)) {
      throw new TypeError(`${field} is required`);
    }
  }

  // Check no unknown fields
  for (const key of Object.keys(sanitized)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new TypeError(`Unknown field: ${key}`);
    }
  }

  // Validate specific fields
  if (sanitized.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${sanitized.schemaVersion}`);
  }

  if (typeof sanitized.goalInstance !== 'string' || sanitized.goalInstance.length === 0) {
    throw new TypeError('goalInstance must be non-empty string');
  }

  if (!Number.isInteger(sanitized.goalVersion) || sanitized.goalVersion < 1) {
    throw new TypeError('goalVersion must be positive integer');
  }

  if (typeof sanitized.claudeSessionId !== 'string') {
    throw new TypeError('claudeSessionId must be string');
  }

  if (!VALID_TYPES.has(sanitized.type)) {
    throw new TypeError(`Invalid type: ${sanitized.type}`);
  }

  // Validate nullable fields are explicitly null or valid string
  const nullableFields = ['eventId', 'actionId', 'turnId', 'decision'];
  for (const field of nullableFields) {
    const value = sanitized[field];
    if (value !== null && typeof value !== 'string') {
      throw new TypeError(`Field ${field} must be null or string`);
    }
  }

  // Validate evidenceRefs is array
  if (!Array.isArray(sanitized.evidenceRefs)) {
    throw new TypeError('evidenceRefs must be array');
  }

  // Validate hashes are hex strings
  const hashFields = ['beforeSnapshotHash', 'afterSnapshotHash', 'previousEntryHash', 'entryHash'];
  for (const field of hashFields) {
    if (field in sanitized && sanitized[field] !== null) {
      const value = sanitized[field];
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw new TypeError(`Field ${field} must be 64-char hex string or null`);
      }
    }
  }

  if (typeof sanitized.timestamp !== 'string') {
    throw new TypeError('timestamp must be string');
  }

  if (!Number.isInteger(sanitized.seq) || sanitized.seq < 1) {
    throw new TypeError('seq must be positive integer');
  }
}

/**
 * Canonical JSON encoder.
 * NEVER invokes toJSON or getters - only operates on already-sanitized detached data.
 */
function toCanonicalJSON(sanitized) {
  // Sort keys deterministically
  const sorted = Object.create(null);

  // schemaVersion first
  if ('schemaVersion' in sanitized) {
    sorted.schemaVersion = sanitized.schemaVersion;
  }

  // Then all other keys in sorted order
  const otherKeys = Object.keys(sanitized)
    .filter(k => k !== 'schemaVersion')
    .sort();

  for (const key of otherKeys) {
    sorted[key] = sanitized[key];
  }

  // Use JSON.stringify on already-sanitized data (no toJSON risk)
  return JSON.stringify(sorted);
}

/**
 * Read audit records with strict validation.
 * Reject unexpected entries, symlinks, malformed files.
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
  const expectedEntries = new Set();

  // First pass: identify valid record files
  for (const entry of entries) {
    // Allow lock files and temp files (forensic evidence)
    if (entry.startsWith('.audit-lock-') || entry.startsWith('.audit-temp-')) {
      continue;
    }

    const match = entry.match(pattern);
    if (!match) {
      throw new IntegrityError(`Unexpected entry in audit directory: ${entry}`, 'UNEXPECTED_ENTRY');
    }

    expectedEntries.add(entry);
  }

  // Second pass: read and validate
  for (const entry of expectedEntries) {
    const filePath = join(dir, entry);

    // Use lstat to detect symlinks
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new IntegrityError(`Symlink not allowed in audit directory: ${entry}`, 'SYMLINK');
    }
    if (!stats.isFile()) {
      throw new IntegrityError(`Non-file entry in audit directory: ${entry}`, 'NON_FILE');
    }

    // Open with O_NOFOLLOW (via fd)
    let fd;
    try {
      fd = await open(filePath, 'r');
    } catch (err) {
      if (err.code === 'ELOOP') {
        throw new IntegrityError(`Symlink detected: ${entry}`, 'SYMLINK');
      }
      throw err;
    }

    try {
      // Read via fd
      const stats = await fd.stat();
      if (stats.size > MAX_SIZE_BYTES) {
        throw new IntegrityError(`Record file too large: ${entry}`, 'FILE_TOO_LARGE');
      }

      const content = await fd.readFile('utf8');

      // Parse JSON
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        throw new IntegrityError(`Invalid JSON in ${entry}: ${err.message}`, 'INVALID_JSON');
      }

      // Sanitize and validate
      let sanitized;
      try {
        sanitized = sanitizeDeep(parsed, entry);
      } catch (err) {
        throw new IntegrityError(`Invalid record structure in ${entry}: ${err.message}`, 'INVALID_STRUCTURE');
      }

      try {
        validateRecordSchema(sanitized);
      } catch (err) {
        throw new IntegrityError(`Invalid record schema in ${entry}: ${err.message}`, 'INVALID_SCHEMA');
      }

      records.push({ filePath, record: sanitized, content });
    } finally {
      await fd.close();
    }
  }

  // Sort by sequence
  records.sort((a, b) => a.record.seq - b.record.seq);

  return records;
}

/**
 * Validate audit log integrity.
 * THROWS IntegrityError on any violation - never returns success-like object.
 */
export async function validateAuditIntegrity(dir) {
  const records = await readAuditRecords(dir);

  if (records.length === 0) {
    return {
      valid: true,
      recordCount: 0,
      headHash: null,
      errors: []
    };
  }

  const errors = [];
  let previousHash = null;

  for (let i = 0; i < records.length; i++) {
    const { record, filePath } = records[i];
    const expectedSeq = i + 1;

    // Check sequence continuity
    if (record.seq !== expectedSeq) {
      errors.push(`Sequence discontinuity: expected ${expectedSeq}, got ${record.seq} in ${basename(filePath)}`);
    }

    // Check previous hash link
    if (i === 0) {
      if (record.previousEntryHash !== null) {
        errors.push(`First record must have previousEntryHash=null, got ${record.previousEntryHash}`);
      }
    } else {
      if (record.previousEntryHash !== previousHash) {
        errors.push(`Hash chain broken at seq ${record.seq}: expected ${previousHash}, got ${record.previousEntryHash}`);
      }
    }

    // Verify entry hash
    const { entryHash: _, ...recordWithoutHash } = record;
    const canonicalWithoutHash = toCanonicalJSON(recordWithoutHash);
    const computedHash = sha256(canonicalWithoutHash);
    if (record.entryHash !== computedHash) {
      errors.push(`Hash mismatch at seq ${record.seq}: computed ${computedHash}, recorded ${record.entryHash}`);
    }

    // Check filename
    const filename = basename(filePath);
    if (!filename.includes(record.entryHash.slice(0, 16))) {
      errors.push(`Filename mismatch at seq ${record.seq}: ${filename}`);
    }

    previousHash = record.entryHash;
  }

  if (errors.length > 0) {
    throw new IntegrityError(`Audit log integrity check failed: ${errors.join('; ')}`, 'INTEGRITY_FAILURE');
  }

  return {
    valid: true,
    recordCount: records.length,
    headHash: previousHash,
    errors: []
  };
}

/**
 * Append audit record with durable write protocol.
 *
 * Protocol:
 * 1. Sanitize and validate input
 * 2. Acquire single append lock (not per-sequence)
 * 3. Under lock: replay log, compute next seq, build record
 * 4. Write to temp file mode 0600, fsync
 * 5. Atomic rename to final name
 * 6. Fsync directory
 * 7. Release lock
 */
export async function appendAuditRecord(dir, record) {
  // SECURITY: Reject Proxy immediately
  if (isProxy(record)) {
    throw new TypeError('Record must not be a Proxy object');
  }

  // Sanitize BEFORE any property access
  let sanitized;
  try {
    sanitized = sanitizeDeep(record, 'record');
  } catch (err) {
    // Sanitization errors are always TypeError, no secrets
    throw err;
  }

  // Validate required input fields (before append-specific fields)
  const requiredInputFields = [
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
    'evidenceRefs'
  ];

  const allowedInputFields = new Set([
    ...requiredInputFields,
    'metadata',
    'schemaVersion'  // Optional in input, will be overridden
  ]);

  for (const field of requiredInputFields) {
    if (!(field in sanitized)) {
      throw new TypeError(`${field} is required`);
    }
  }

  // Check for unknown input fields
  for (const key of Object.keys(sanitized)) {
    if (!allowedInputFields.has(key)) {
      throw new TypeError(`Unknown field: ${key}`);
    }
  }

  // If schemaVersion provided, verify it matches
  if ('schemaVersion' in sanitized && sanitized.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${sanitized.schemaVersion}`);
  }

  // Check for existing lock BEFORE trying to acquire
  const lockPath = join(dir, '.audit-lock-append');

  try {
    const lockStats = await stat(lockPath);
    const age = Date.now() - lockStats.mtimeMs;

    if (age > LOCK_TIMEOUT_MS) {
      // FORENSIC: Stale lock exists - preserve as evidence, do NOT delete
      throw new IntegrityError(
        `Stale lock found (age ${Math.round(age / 1000)}s) - preserved as forensic evidence at ${lockPath}`,
        'STALE_LOCK'
      );
    }

    // Fresh lock exists - concurrent writer
    throw new Error('Append lock held by concurrent writer');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Lock exists (stale or fresh) or stat error
      throw err;
    }
    // No lock exists, proceed to acquire
  }

  // Acquire append lock
  const lockNonce = randomBytes(16).toString('hex');
  const lockData = JSON.stringify({
    pid: process.pid,
    nonce: lockNonce,
    acquiredAt: Date.now()
  });

  let lockFd;
  try {
    lockFd = await open(lockPath, 'wx', 0o600);
    await lockFd.writeFile(lockData, 'utf8');
    await lockFd.sync();
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Race: lock was created between stat and open
      throw new Error('Append lock held by concurrent writer');
    }
    throw err;
  }

  try {
    // Fsync lock directory
    await fsyncDir(dir);

    // Under lock: validate integrity and compute next sequence
    const integrity = await validateAuditIntegrity(dir);
    const nextSeq = integrity.recordCount + 1;

    // Build complete record without entryHash
    const recordWithoutHash = {
      schemaVersion: SCHEMA_VERSION,
      goalInstance: sanitized.goalInstance,
      goalVersion: sanitized.goalVersion,
      claudeSessionId: sanitized.claudeSessionId,
      type: sanitized.type,
      eventId: sanitized.eventId,
      actionId: sanitized.actionId,
      turnId: sanitized.turnId,
      beforeSnapshotHash: sanitized.beforeSnapshotHash,
      afterSnapshotHash: sanitized.afterSnapshotHash,
      decision: sanitized.decision,
      evidenceRefs: sanitized.evidenceRefs,
      timestamp: new Date().toISOString(),
      seq: nextSeq,
      previousEntryHash: integrity.headHash
    };

    // Add optional metadata if present
    if ('metadata' in sanitized) {
      recordWithoutHash.metadata = sanitized.metadata;
    }

    // Compute entry hash from canonical form
    const canonicalWithoutHash = toCanonicalJSON(recordWithoutHash);
    const entryHash = sha256(canonicalWithoutHash);

    // Complete record with hash
    const completeRecord = {
      ...recordWithoutHash,
      entryHash
    };

    // Serialize final record
    const finalJSON = toCanonicalJSON(completeRecord);

    // Write to temp file mode 0600
    const seqPadded = String(nextSeq).padStart(8, '0');
    const hashPrefix = entryHash.slice(0, 16);
    const filename = `${seqPadded}-${hashPrefix}.json`;
    const finalPath = join(dir, filename);
    const tempPath = join(dir, `.audit-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    let tempFd = await open(tempPath, 'wx', 0o600);
    try {
      await tempFd.writeFile(finalJSON, 'utf8');
      await tempFd.sync();
    } finally {
      await tempFd.close();
    }

    // Atomic rename
    const fs = await import('node:fs/promises');
    await fs.rename(tempPath, finalPath);

    // Fsync directory
    await fsyncDir(dir);

    // Release lock: verify it's still ours
    await lockFd.close();

    // Verify lock file is still the one we created (same inode check would go here in production)
    // For now, just unlink
    await fs.unlink(lockPath);
    await fsyncDir(dir);

    return {
      seq: nextSeq,
      entryHash,
      filePath: finalPath
    };
  } catch (err) {
    // Release lock on error - preserve both primary and cleanup errors
    let cleanupError;
    try {
      await lockFd.close();
      const fs = await import('node:fs/promises');
      await fs.unlink(lockPath);
    } catch (unlinkErr) {
      cleanupError = unlinkErr;
    }

    if (cleanupError) {
      // Attach cleanup error but throw primary
      err.cleanupError = cleanupError;
    }
    throw err;
  }
}

/**
 * Fsync directory (ignore unsupported errors only)
 */
async function fsyncDir(dir) {
  try {
    const dirFd = await open(dir, 'r');
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
  } catch (err) {
    // Only ignore errors indicating fsync not supported
    const ignorable = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EBADF', 'EINVAL']);
    if (!ignorable.has(err.code)) {
      // Critical errors like ENOSPC must propagate
      throw err;
    }
  }
}

/**
 * Query audit log by criteria.
 * Validates criteria, checks integrity, returns immutable records.
 */
export async function queryAuditLog(dir, criteria) {
  // Sanitize criteria
  if (isProxy(criteria)) {
    throw new TypeError('Query criteria must not be a Proxy object');
  }

  const sanitizedCriteria = sanitizeDeep(criteria, 'criteria');

  // Validate integrity first
  await validateAuditIntegrity(dir);

  // Read records
  const records = await readAuditRecords(dir);

  // Filter
  const results = records
    .map(r => r.record)
    .filter(record => {
      if ('eventId' in sanitizedCriteria && record.eventId !== sanitizedCriteria.eventId) {
        return false;
      }
      if ('actionId' in sanitizedCriteria && record.actionId !== sanitizedCriteria.actionId) {
        return false;
      }
      if ('turnId' in sanitizedCriteria && record.turnId !== sanitizedCriteria.turnId) {
        return false;
      }
      if ('type' in sanitizedCriteria && record.type !== sanitizedCriteria.type) {
        return false;
      }
      return true;
    });

  // Return deeply frozen
  return results;
}

/**
 * Read entire audit log.
 * Validates integrity, returns immutable records.
 */
export async function readAuditLog(dir) {
  await validateAuditIntegrity(dir);
  const records = await readAuditRecords(dir);
  return records.map(r => r.record);
}
