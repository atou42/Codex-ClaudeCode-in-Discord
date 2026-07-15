/**
 * Port interfaces for cohub-claude-goal launcher
 *
 * All ports use strict descriptor validation, deep immutability,
 * and closed error categories. No fallback implementations.
 * Production composition wires real foundation modules.
 */

/**
 * Lease port - exclusive process lock per goalInstance
 *
 * @typedef {Object} LeasePort
 * @property {(goalInstance: string, metadata: Object) => Promise<void>} acquire
 *   Acquire exclusive lease. Throws LEASE_CONFLICT if already held by active process.
 * @property {() => Promise<void>} release
 *   Release lease. Idempotent.
 */

/**
 * Ledger port - append-only event log with hash chain
 *
 * @typedef {Object} LedgerRecord
 * @property {number} seq - Monotonic sequence number
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} type - Event type
 * @property {string} goalInstance - Goal instance ID
 * @property {string} goalVersion - Goal version
 * @property {string} claudeSessionId - Claude session UUID
 * @property {Object} data - Event-specific data
 * @property {string|null} eventId - External event ID if applicable
 * @property {string|null} actionId - Action ID if applicable
 * @property {string|null} beforeSnapshotHash - Snapshot hash before event
 * @property {string|null} afterSnapshotHash - Snapshot hash after event
 * @property {Object|null} decision - Decision taken
 * @property {Array<string>} evidenceRefs - References to evidence files
 * @property {string|null} previousEntryHash - Previous entry hash (null for first)
 * @property {string} entryHash - This entry's hash
 *
 * @typedef {Object} LedgerPort
 * @property {() => Promise<void>} init
 *   Initialize ledger (create directory, load existing entries)
 * @property {(entry: Object) => Promise<LedgerRecord>} append
 *   Append entry to ledger. Returns immutable record.
 * @property {() => Promise<Array<LedgerRecord>>} read
 *   Read all entries. Returns immutable array.
 * @property {() => Promise<LedgerRecord|null>} getLatest
 *   Get latest entry or null if empty.
 */

/**
 * State persistence port - atomic materialized state
 *
 * @typedef {Object} StatePort
 * @property {(state: Object) => Promise<void>} write
 *   Atomically write state (temp + fsync + rename + fsync parent)
 * @property {() => Promise<Object>} read
 *   Read state. Returns deeply frozen object. Throws on corruption.
 * @property {(filePath: string) => Promise<boolean>} exists
 *   Check if file exists (for initialization)
 */

/**
 * Process spawn port - Claude Code invocation
 *
 * @typedef {Object} ChildProcessPort
 * @property {ReadableStream} stdout - stdout stream
 * @property {ReadableStream} stderr - stderr stream
 * @property {boolean} killed - Whether process was killed
 * @property {(signal: string) => void} kill - Send signal to process
 * @property {(event: string, handler: Function) => void} on - Attach event listener
 * @property {(event: string, handler: Function) => void} once - Attach one-time listener
 *
 * @typedef {Object} SpawnPort
 * @property {(command: string, args: Array<string>, options: Object) => ChildProcessPort} spawn
 *   Spawn child process. Returns ChildProcessPort.
 */

/**
 * Clock port - time source for testing
 *
 * @typedef {Object} ClockPort
 * @property {() => number} now
 *   Return current time in milliseconds since epoch
 */

/**
 * Stream parser port - parse and validate Claude stream-json events
 *
 * @typedef {Object} StreamParserPort
 * @property {(line: string) => Object|null} parse
 *   Parse JSON line. Returns validated event or null on malformed input.
 * @property {(buffer: string) => string} boundBuffer
 *   Bound buffer to max size.
 */

/**
 * Verifier port - extract verdict from cohub_goal_verify tool result
 *
 * @typedef {Object} VerifyResult
 * @property {string} verdict - RUNNING | PAUSED_USER | BLOCKED | DONE
 * @property {string|null} requiredAction - Required action ('wait' | 'submit' | null)
 * @property {Object} snapshot - Full snapshot from verifier
 * @property {Array<string>} evidenceRefs - Evidence file references
 *
 * @typedef {Object} VerifierPort
 * @property {(toolResult: Object) => VerifyResult} extract
 *   Extract verdict from tool_result. Throws on invalid result.
 */

/**
 * Renderer port - render goal condition text
 *
 * @typedef {Object} RendererPort
 * @property {(goalInstance: string, mode: string) => string} render
 *   Render goal condition text. Max 4000 chars.
 */

/**
 * Error categories - closed set for launcher errors
 */
export const ErrorCategory = Object.freeze({
  LEASE_CONFLICT: 'LEASE_CONFLICT',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
  CAPABILITY_GATE_FAILURE: 'CAPABILITY_GATE_FAILURE',
  STATE_TRANSITION_ERROR: 'STATE_TRANSITION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  SPAWN_FAILURE: 'SPAWN_FAILURE',
  STREAM_MALFORMED: 'STREAM_MALFORMED',
  VERIFY_MISSING: 'VERIFY_MISSING',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED'
});

/**
 * Create error with closed category
 */
export function createError(category, message, details = {}) {
  if (!Object.values(ErrorCategory).includes(category)) {
    throw new Error(`Invalid error category: ${category}`);
  }

  const error = new Error(message);
  error.code = category;
  error.category = category;
  // Deeply freeze details to prevent mutation
  error.details = Object.freeze(JSON.parse(JSON.stringify(details)));

  return error;
}

// Import util.types at module level
import { types } from 'node:util';

/**
 * Validate input against schema - reject proxies, getters, symbols, etc.
 */
export function validateInput(value, schema, path = 'input') {
  // Reject null/undefined for required values
  if (value === null || value === undefined) {
    if (schema.required !== false) {
      throw createError('INVALID_INPUT', `${path} is required`);
    }
    return value;
  }

  // Reject proxies using node:util
  if (typeof value === 'object' && value !== null) {
    if (types.isProxy(value)) {
      throw createError('INVALID_INPUT', `${path} cannot be a Proxy`);
    }
  }

  // Reject symbols
  if (typeof value === 'symbol') {
    throw createError('INVALID_INPUT', `${path} cannot be a symbol`);
  }

  // Type validation
  if (schema.type) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== schema.type) {
      throw createError('INVALID_INPUT',
        `${path} must be ${schema.type}, got ${actualType}`);
    }
  }

  // String validations
  if (schema.type === 'string') {
    if (schema.maxLength && value.length > schema.maxLength) {
      throw createError('INVALID_INPUT',
        `${path} exceeds max length ${schema.maxLength}`);
    }
    if (schema.minLength && value.length < schema.minLength) {
      throw createError('INVALID_INPUT',
        `${path} below min length ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw createError('INVALID_INPUT',
        `${path} does not match pattern ${schema.pattern}`);
    }
  }

  // Number validations
  if (schema.type === 'number') {
    if (!Number.isFinite(value)) {
      throw createError('INVALID_INPUT', `${path} must be finite`);
    }
    if (schema.min !== undefined && value < schema.min) {
      throw createError('INVALID_INPUT', `${path} below min ${schema.min}`);
    }
    if (schema.max !== undefined && value > schema.max) {
      throw createError('INVALID_INPUT', `${path} exceeds max ${schema.max}`);
    }
  }

  // Object validations
  if (schema.type === 'object' && !Array.isArray(value)) {
    // Check for getters/setters
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, desc] of Object.entries(descriptors)) {
      if (desc.get || desc.set) {
        throw createError('INVALID_INPUT',
          `${path}.${key} has getter/setter, not allowed`);
      }
    }

    // Validate required properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (propSchema.required !== false && !(key in value)) {
          throw createError('INVALID_INPUT', `${path}.${key} is required`);
        }
        if (key in value) {
          validateInput(value[key], propSchema, `${path}.${key}`);
        }
      }
    }

    // Reject unknown properties if strict
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
          throw createError('INVALID_INPUT',
            `${path}.${key} is not allowed (strict schema)`);
        }
      }
    }
  }

  // Array validations
  if (schema.type === 'array') {
    if (schema.maxItems && value.length > schema.maxItems) {
      throw createError('INVALID_INPUT',
        `${path} exceeds max items ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        validateInput(item, schema.items, `${path}[${i}]`);
      });
    }
  }

  return value;
}

/**
 * Deep freeze object recursively
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  Object.freeze(obj);

  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }

  return obj;
}

/**
 * Deep detach - create immutable copy with no shared references
 */
export function deepDetach(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Use JSON round-trip for deep detachment (removes functions, symbols, etc.)
  const detached = JSON.parse(JSON.stringify(obj));
  return deepFreeze(detached);
}
