/**
 * Foundation module adapters for lease and ledger
 *
 * These are minimal implementations matching the foundation contract.
 * When real foundation modules land, swap these for imports.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, open, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { hostname } from 'node:os';

/**
 * Lease adapter - provides exclusive locking per goalInstance
 */
export class LeaseAdapter {
  constructor({ leasePath, clock = Date }) {
    this.leasePath = leasePath;
    this.clock = clock;
  }

  async acquire(goalInstance, metadata = {}) {
    const lease = {
      goalInstance,
      pid: process.pid,
      startTime: this.clock.now(),
      host: hostname(),
      nonce: randomUUID(),
      acquiredAt: new Date(this.clock.now()).toISOString(),
      ...metadata
    };

    try {
      const existing = await readFile(this.leasePath, 'utf8');
      const existingLease = JSON.parse(existing);

      // Check if it's our own process
      if (existingLease.pid === process.pid) {
        await this._atomicWrite(this.leasePath, lease);
        return;
      }

      // Check if process still alive
      let processExists = false;
      try {
        process.kill(existingLease.pid, 0);
        processExists = true;
      } catch (err) {
        if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err;
        if (err.code === 'EPERM') processExists = true;
      }

      // If process exists and goal active, reject
      if (processExists && existingLease.nativeGoalActive) {
        const error = new Error(`Lease conflict: PID ${existingLease.pid} holds active lease`);
        error.code = 'LEASE_CONFLICT';
        throw error;
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'LEASE_CONFLICT') throw err;
      if (err.code === 'LEASE_CONFLICT') throw err;
    }

    await this._atomicWrite(this.leasePath, lease);
  }

  async release() {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.leasePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async _atomicWrite(filePath, data) {
    const tmpPath = `${filePath}.tmp.${randomUUID()}`;
    const content = JSON.stringify(data, null, 2);

    await writeFile(tmpPath, content, 'utf8');
    const fd = await open(tmpPath, 'r+');
    await fd.sync();
    await fd.close();

    await rename(tmpPath, filePath);
    const parentDir = path.dirname(filePath);
    const dirFd = await open(parentDir, 'r');
    await dirFd.sync();
    await dirFd.close();
  }
}

/**
 * Ledger adapter - append-only event log with hash chain
 */
export class LedgerAdapter {
  constructor({ ledgerDir, clock = Date }) {
    this.ledgerDir = ledgerDir;
    this.clock = clock;
    this.sequence = 0;
    this.previousEntryHash = null;
  }

  async init() {
    await mkdir(this.ledgerDir, { recursive: true });

    // Load existing entries
    const entries = await this._loadEntries();
    if (entries.length > 0) {
      this.sequence = entries[entries.length - 1].seq;
      this.previousEntryHash = entries[entries.length - 1].entryHash;
    }
  }

  async append(entry) {
    this.sequence++;

    const record = {
      seq: this.sequence,
      timestamp: new Date(this.clock.now()).toISOString(),
      ...entry,
      previousEntryHash: this.previousEntryHash,
      entryHash: null // Will be computed
    };

    // Compute entry hash
    const hashInput = JSON.stringify({
      seq: record.seq,
      timestamp: record.timestamp,
      type: record.type,
      data: record.data,
      previousEntryHash: record.previousEntryHash
    });
    record.entryHash = createHash('sha256').update(hashInput).digest('hex');

    // Write to disk atomically
    const filename = `${String(this.sequence).padStart(8, '0')}-${record.entryHash.slice(0, 16)}.json`;
    const filePath = path.join(this.ledgerDir, filename);

    const tmpPath = `${filePath}.tmp.${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');

    const fd = await open(tmpPath, 'r+');
    await fd.sync();
    await fd.close();

    await rename(tmpPath, filePath);

    const dirFd = await open(this.ledgerDir, 'r');
    await dirFd.sync();
    await dirFd.close();

    this.previousEntryHash = record.entryHash;
    return record;
  }

  async read() {
    return await this._loadEntries();
  }

  async getLatest() {
    const entries = await this._loadEntries();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  async _loadEntries() {
    let files;
    try {
      files = await readdir(this.ledgerDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const entries = [];
    const ledgerFiles = files
      .filter(f => f.endsWith('.json') && !f.includes('.tmp.'))
      .sort();

    for (const file of ledgerFiles) {
      const content = await readFile(path.join(this.ledgerDir, file), 'utf8');
      const entry = JSON.parse(content);
      entries.push(entry);
    }

    // Validate hash chain
    for (let i = 0; i < entries.length; i++) {
      if (i > 0 && entries[i].previousEntryHash !== entries[i - 1].entryHash) {
        const error = new Error('Ledger hash chain broken');
        error.code = 'INTEGRITY_FAILURE';
        throw error;
      }
    }

    return entries;
  }
}

/**
 * Usage extractor - parse Claude stream-json for token/time usage
 */
export class UsageExtractor {
  extract(event) {
    // Extract usage from various event types
    if (event.type === 'usage' && event.tokens) {
      return {
        tokens: (event.tokens.input || 0) + (event.tokens.output || 0),
        turns: event.turns || 0,
        seconds: event.seconds || 0
      };
    }

    if (event.type === 'turn_end' && event.usage) {
      return {
        tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
        turns: 1,
        seconds: event.duration_seconds || 0
      };
    }

    return null;
  }
}

/**
 * Stream validator - strict schema validation for stream-json events
 */
export class StreamValidator {
  constructor({ maxBufferSize = 1024 * 1024 } = {}) {
    this.maxBufferSize = maxBufferSize;
    this.dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);
  }

  validate(event) {
    // Must be plain object
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { valid: false, reason: 'Event must be a plain object' };
    }

    // Check for dangerous keys
    if (this._hasDangerousKeys(event)) {
      return { valid: false, reason: 'Event contains dangerous keys' };
    }

    // Validate type field
    if (event.type !== undefined) {
      if (typeof event.type !== 'string') {
        return { valid: false, reason: 'Event type must be a string' };
      }
      if (typeof event.type === 'symbol') {
        return { valid: false, reason: 'Event type cannot be a symbol' };
      }
    }

    // Validate tool field
    if (event.tool !== undefined) {
      if (typeof event.tool !== 'string') {
        return { valid: false, reason: 'Tool must be a string' };
      }
    }

    // Freeze output to prevent mutation
    return { valid: true, event: Object.freeze({ ...event }) };
  }

  _hasDangerousKeys(obj) {
    for (const key of Object.keys(obj)) {
      if (this.dangerousKeys.has(key)) return true;
    }
    return false;
  }

  boundBuffer(buffer) {
    if (buffer.length > this.maxBufferSize) {
      return buffer.slice(-this.maxBufferSize);
    }
    return buffer;
  }
}

/**
 * Secret redactor - remove sensitive data from logs
 */
export class SecretRedactor {
  constructor() {
    this.patterns = [
      /sk-ant-[a-zA-Z0-9_-]+/g,
      /Bearer [a-zA-Z0-9_-]+/g,
      /token[=:]\s*[a-zA-Z0-9_-]+/gi,
      /secret[=:]\s*[a-zA-Z0-9_-]+/gi,
      /api[_-]?key[=:]\s*[a-zA-Z0-9_-]+/gi
    ];
  }

  redact(text) {
    let redacted = text;
    for (const pattern of this.patterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }
}
