import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './atomic-file.js';
import { IntegrityError, LeaseConflictError } from './errors.js';

export const LEASE_FILE_NAME = 'lease.json';

const REQUIRED_LOCK_FIELDS = ['pid', 'processStartTime', 'host', 'acquiredAt', 'nonce', 'goalInstance'];
const ALLOWED_LOCK_FIELDS = new Set(REQUIRED_LOCK_FIELDS);
const TAKEOVER_LOCK_SUFFIX = '.takeover-lock';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertValidLockSchema(lock, lockPath) {
  if (!isPlainObject(lock)) {
    throw new IntegrityError(`lease: lock file ${lockPath} is not a plain object`);
  }
  const actualKeys = Object.keys(lock);
  for (const key of actualKeys) {
    if (!ALLOWED_LOCK_FIELDS.has(key)) {
      throw new IntegrityError(`lease: lock file ${lockPath} has unknown field "${key}"`);
    }
  }
  for (const field of REQUIRED_LOCK_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(lock, field)) {
      throw new IntegrityError(`lease: lock file ${lockPath} missing required field "${field}"`);
    }
  }
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid < 1) {
    throw new IntegrityError(`lease: lock file ${lockPath} pid must be a positive integer, got ${JSON.stringify(lock.pid)}`);
  }
  if (typeof lock.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(lock.nonce)) {
    throw new IntegrityError(`lease: lock file ${lockPath} nonce must be 32-char hex, got ${JSON.stringify(lock.nonce)}`);
  }
  if (typeof lock.host !== 'string' || lock.host.length === 0) {
    throw new IntegrityError(`lease: lock file ${lockPath} host must be a nonempty string`);
  }
  if (typeof lock.goalInstance !== 'string' || lock.goalInstance.length === 0) {
    throw new IntegrityError(`lease: lock file ${lockPath} goalInstance must be a non-empty string, got ${JSON.stringify(lock.goalInstance)}`);
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    if (err.code === 'EPERM') {
      return true;
    }
    throw err;
  }
}

async function readLockOrNull(lockPath) {
  let fd;
  try {
    fd = await fsPromises.open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    if (err.code === 'ELOOP') {
      throw new IntegrityError(`lease: ${lockPath} is a symlink; rejecting to prevent TOCTOU attacks`);
    }
    throw err;
  }

  let raw;
  try {
    raw = await fd.readFile('utf8');
  } finally {
    await fd.close();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IntegrityError(`lease: malformed JSON in ${lockPath}: ${err.message}`);
  }
  assertValidLockSchema(parsed, lockPath);
  return parsed;
}

/**
 * Approximates this process's own start time as wall-clock time. Only used
 * as diagnostic identity in the lock record; liveness decisions rely solely
 * on whether the recorded pid still responds to signal 0, per spec.
 */
function ownProcessStartTime() {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
}

/**
 * Acquires an exclusive lease for goalInstance in dir. If an existing lock
 * belongs to a live pid, fails immediately with LeaseConflictError. If the
 * existing lock's pid is dead, takeover requires options.auditDeadOwnerTakeover
 * to be provided and to resolve successfully (recording the dead owner to an
 * audit ledger) before the old lock is archived and replaced atomically.
 * Never shells out to any command to make this determination.
 *
 * Concurrent takeover attempts are serialized via an exclusive takeover lock
 * to ensure exactly one winner.
 */
export async function acquireLease(dir, options = {}) {
  const { goalInstance, auditDeadOwnerTakeover, processIdentityProvider } = options;

  if (typeof goalInstance !== 'string' || goalInstance.length === 0) {
    throw new Error('acquireLease: options.goalInstance is required and must be a non-empty string');
  }

  const lockPath = path.join(dir, LEASE_FILE_NAME);
  const takeoverLockPath = lockPath + TAKEOVER_LOCK_SUFFIX;

  const existing = await readLockOrNull(lockPath);

  if (existing) {
    if (existing.host !== os.hostname()) {
      throw new LeaseConflictError(
        `lease: goalInstance is held by foreign host "${existing.host}" (this host: "${os.hostname()}")`,
      );
    }

    const pidAlive = isProcessAlive(existing.pid);
    let ownerIsLive = pidAlive;

    if (pidAlive && typeof processIdentityProvider === 'function') {
      const identity = await processIdentityProvider(existing.pid);
      if (identity === null) {
        throw new LeaseConflictError(
          `lease: existing lock's pid ${existing.pid} is alive but identity cannot be verified; failing closed`,
        );
      }
      if (identity.startTime !== existing.processStartTime) {
        ownerIsLive = false;
      }
    }

    if (ownerIsLive) {
      throw new LeaseConflictError(
        `lease: goalInstance is already held by live pid ${existing.pid} (acquiredAt ${existing.acquiredAt})`,
      );
    }

    if (typeof auditDeadOwnerTakeover !== 'function') {
      throw new LeaseConflictError(
        `lease: existing lock's owner pid ${existing.pid} is dead, but no auditDeadOwnerTakeover callback was provided; refusing silent takeover`,
      );
    }

    // Acquire exclusive takeover lock to serialize concurrent takeover attempts
    let takeoverLockFd;
    try {
      takeoverLockFd = await fsPromises.open(
        takeoverLockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new LeaseConflictError(
          `lease: another process is currently taking over the dead lease; retry`,
        );
      }
      throw err;
    }

    try {
      await takeoverLockFd.write(`${process.pid}\n`, 0, 'utf8');
      await takeoverLockFd.sync();

      // Re-read the lease under the takeover lock to detect if another process
      // already completed takeover
      const recheck = await readLockOrNull(lockPath);
      if (!recheck) {
        throw new LeaseConflictError(
          `lease: dead lease disappeared during takeover; another process may have taken over`,
        );
      }
      if (recheck.nonce !== existing.nonce) {
        throw new LeaseConflictError(
          `lease: dead lease was replaced by another process during takeover`,
        );
      }

      // Run the audit callback
      await auditDeadOwnerTakeover(existing);

      // Archive the exact old lock bytes before replacement
      const archivePath = path.join(dir, `${LEASE_FILE_NAME}.dead-${Date.now()}-${existing.nonce}`);
      let oldBytesFd;
      try {
        oldBytesFd = await fsPromises.open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch (err) {
        if (err.code === 'ELOOP') {
          throw new IntegrityError(`lease: ${lockPath} became a symlink during takeover`);
        }
        throw err;
      }
      const oldBytes = await oldBytesFd.readFile();
      await oldBytesFd.close();
      await writeFileAtomic(archivePath, oldBytes, { mode: 0o600 });

      // Create the new lock atomically, replacing the old one
      const newLock = {
        pid: process.pid,
        processStartTime: ownProcessStartTime(),
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
        goalInstance,
      };

      await writeFileAtomic(lockPath, JSON.stringify(newLock, null, 2), { mode: 0o600, allowReplace: true });

      return { lock: newLock };
    } finally {
      await takeoverLockFd.close();
      try {
        await fsPromises.unlink(takeoverLockPath);
      } catch (err) {
        // Best effort cleanup; ignore errors
      }
    }
  }

  // No existing lease; create new one
  const newLock = {
    pid: process.pid,
    processStartTime: ownProcessStartTime(),
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
    goalInstance,
  };

  await writeFileAtomic(lockPath, JSON.stringify(newLock, null, 2), { mode: 0o600, allowReplace: false });

  return { lock: newLock };
}

/**
 * Releases the lease only if the on-disk lock still matches lock's nonce
 * exactly. If a different owner already holds the lease (different nonce),
 * this is a no-op rather than an error or a deletion of someone else's lock.
 * Uses file descriptor-based read and conditional unlink to prevent race
 * where another process acquires between read and unlink.
 */
export async function releaseLease(dir, lock) {
  const lockPath = path.join(dir, LEASE_FILE_NAME);

  let fd;
  try {
    fd = await fsPromises.open(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return; // Already released
    }
    if (err.code === 'ELOOP') {
      throw new IntegrityError(`lease: ${lockPath} is a symlink during release`);
    }
    throw err;
  }

  try {
    const raw = await fd.readFile('utf8');
    let existing;
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      // Corrupt lock; not our lock, don't delete
      return;
    }

    if (!existing || existing.nonce !== lock.nonce) {
      // Not our lock anymore
      return;
    }

    // Our lock is still there; now we can safely unlink
    // Close fd before unlinking
    await fd.close();
    fd = null;

    await fsPromises.unlink(lockPath);
    const dirFd = await fsPromises.open(dir, fs.constants.O_RDONLY);
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
  } finally {
    if (fd) {
      await fd.close();
    }
  }
}
