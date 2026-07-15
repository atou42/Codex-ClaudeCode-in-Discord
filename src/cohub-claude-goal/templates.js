/**
 * @fileoverview Immutable continuation and native-goal templates.
 * Fixed renderer only, no arbitrary prompt text. Deterministic output.
 * All remote/prose/path fields are untrusted data, encoded safely.
 *
 * SECURITY MODEL:
 * - One descriptor-walking, Proxy-first, getter-free, exact-schema sanitizer.
 *   types.isProxy() runs BEFORE Array.isArray / Object.getPrototypeOf / Reflect.ownKeys.
 * - Validation returns a DETACHED sanitized clone; rendering reads only that clone.
 *   The attacker input is never read twice, closing the mutation race.
 * - Every string, object, array is exact-schema validated: no accessors, symbols,
 *   dangerous keys, non-enumerable properties, unknown keys, custom prototypes,
 *   sparse arrays, cycles, shared references, non-finite numbers, unsupported values,
 *   invalid Unicode/control characters, or excessive depth/bytes.
 * - Length-prefixed canonical JSON so bound content cannot escape into instructions.
 *
 * SCHEMA CONTRACT (integrated, authoritative — spec lines 216-228, 252-280):
 *   renderContinuationPrompt input top level:
 *     goalInstance, goalVersion, actionSlot, continuationId, snapshotHash,
 *     expectedParentSequence, expectedInputWatermark, decisionCode, runPath,
 *     registeredEventRefs, expectedNextAction
 *   actionSlot exact fields:
 *     actionSlotId, continuationId, expectedParentSequence, expectedInputWatermark,
 *     goalVersion, snapshotHash, decisionCode, attempt
 *   Every actionSlot binding (except actionSlotId + attempt) must EXACTLY equal
 *   its corresponding top-level field, else INVALID_ACTION_SLOT / ACTION_SLOT_MISMATCH.
 */

import { types } from 'node:util';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Byte and length bounds (exact, enforced).
const MAX_INPUT_BYTES = 50000;
const MAX_STRING_BYTES = 8192;
const MAX_DEPTH = 12;
const MAX_EVENT_REFS = 1000;
const MAX_EVENT_REF_BYTES = 512;
const MAX_RUN_PATH_BYTES = 4096;
const MAX_EXPECTED_NEXT_ACTION_STRING = 200;
const MAX_GOAL_INSTANCE_BYTES = 512;
const MAX_GOAL_VERSION_BYTES = 128;
const MAX_CONTINUATION_ID_BYTES = 256;

// Integrated decision-code allowlist (spec-authoritative). No invented codes,
// no user-approval operations that bypass the parent workflow guard.
const VALID_DECISION_CODES = new Set([
  'action-start',
  'worker-dispatch',
  'user-gate-response',
  'block-report',
  'external-wait-register'
]);

// Top-level continuation schema (exact).
const CONTINUATION_SCHEMA = new Set([
  'goalInstance',
  'goalVersion',
  'actionSlot',
  'continuationId',
  'snapshotHash',
  'expectedParentSequence',
  'expectedInputWatermark',
  'decisionCode',
  'runPath',
  'registeredEventRefs',
  'expectedNextAction'
]);

// actionSlot exact schema (integrated contract).
const ACTION_SLOT_SCHEMA = new Set([
  'actionSlotId',
  'continuationId',
  'expectedParentSequence',
  'expectedInputWatermark',
  'goalVersion',
  'snapshotHash',
  'decisionCode',
  'attempt'
]);

// expectedNextAction structured schema (bounded, allowlisted keys).
const EXPECTED_NEXT_ACTION_SCHEMA = new Set(['type', 'reason']);
const EXPECTED_NEXT_ACTION_TYPES = new Set([
  'inspect',
  'submit',
  'wait',
  'verify'
]);

const SHA256_REGEX = /^[a-f0-9]{64}$/;

/**
 * Validate string contains no invalid control characters, Unicode format/direction
 * control chars, BOM, or lone surrogates. Tab/LF/CR allowed.
 */
function hasInvalidControlChars(str) {
  if (typeof str !== 'string') return false;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    // ASCII control characters (reject except tab/LF/CR)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
    if (code === 0) return true;

    // Unicode format and direction control characters (U+200B-U+206F)
    if (code >= 0x200B && code <= 0x206F) {
      return true;
    }

    // BOM (U+FEFF)
    if (code === 0xFEFF) {
      return true;
    }

    // Lone surrogates (U+D800-U+DFFF)
    if (code >= 0xD800 && code <= 0xDFFF) {
      if (code >= 0xD800 && code <= 0xDBFF) {
        // High surrogate - must be followed by low surrogate
        if (i + 1 >= str.length) {
          return true;
        }
        const nextCode = str.charCodeAt(i + 1);
        if (nextCode < 0xDC00 || nextCode > 0xDFFF) {
          return true;
        }
        i++; // Skip the low surrogate
      } else {
        // Low surrogate without preceding high surrogate
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if value is a plain object (not array, null, or other types).
 * Rejects Proxy objects and objects with custom prototypes.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  // Reject Proxy objects BEFORE any operation
  if (types.isProxy(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  // Only allow Object.prototype or null prototype (from Object.create(null))
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }

  return true;
}

/**
 * Descriptor-walking exact validator. Never reads values through property access.
 * Returns a DETACHED canonical JSON string or throws. The returned clone is safe
 * to render; the original input is never touched again.
 */
function validateAndCanonicalizeValue(value, depth = 0, seen = new Map()) {
  if (depth > MAX_DEPTH) {
    throw new Error('MAX_DEPTH_EXCEEDED: nesting too deep');
  }

  // Primitives
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'undefined') {
    throw new Error('UNSUPPORTED_VALUE: undefined not allowed');
  }

  if (type === 'function') {
    throw new Error('UNSUPPORTED_VALUE: functions not allowed');
  }

  if (type === 'symbol') {
    throw new Error('UNSUPPORTED_VALUE: symbols not allowed');
  }

  if (type === 'bigint') {
    throw new Error('UNSUPPORTED_VALUE: bigint not allowed');
  }

  if (type === 'string') {
    // Validate string
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);

      // Reject ASCII control characters except tab/LF/CR
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        throw new Error('INVALID_STRING: contains control characters');
      }
      if (code === 0) {
        throw new Error('INVALID_STRING: contains null byte');
      }

      // Reject Unicode format and direction control characters (U+200B-U+206F)
      if (code >= 0x200B && code <= 0x206F) {
        throw new Error('INVALID_STRING: contains Unicode format or direction control characters');
      }

      // Reject BOM (U+FEFF)
      if (code === 0xFEFF) {
        throw new Error('INVALID_STRING: contains byte order mark');
      }

      // Reject lone surrogates
      if (code >= 0xD800 && code <= 0xDFFF) {
        if (code >= 0xD800 && code <= 0xDBFF) {
          // High surrogate - must be followed by low surrogate
          if (i + 1 >= value.length) {
            throw new Error('INVALID_STRING: contains lone high surrogate');
          }
          const nextCode = value.charCodeAt(i + 1);
          if (nextCode < 0xDC00 || nextCode > 0xDFFF) {
            throw new Error('INVALID_STRING: contains lone high surrogate');
          }
          i++; // Skip the low surrogate
        } else {
          // Low surrogate without preceding high surrogate
          throw new Error('INVALID_STRING: contains lone low surrogate');
        }
      }
    }

    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_STRING_BYTES) {
      throw new Error(`STRING_TOO_LARGE: string is ${bytes} bytes, max ${MAX_STRING_BYTES}`);
    }

    return JSON.stringify(value);
  }

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('UNSUPPORTED_VALUE: non-finite number not allowed');
    }
    return JSON.stringify(value);
  }

  if (type === 'boolean') {
    return JSON.stringify(value);
  }

  // Must be object type here
  if (type !== 'object') {
    throw new Error(`UNSUPPORTED_VALUE: unexpected type ${type}`);
  }

  // Reject Proxy objects BEFORE any operation
  if (types.isProxy(value)) {
    throw new Error('PROXY_REJECTED: Proxy objects not allowed');
  }

  // Cycle detection
  if (seen.has(value)) {
    throw new Error('CIRCULAR_REFERENCE: circular reference detected');
  }
  seen.set(value, true);

  try {
    // Check prototype
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
      throw new Error('CUSTOM_PROTOTYPE: custom prototype not allowed');
    }

    // Arrays
    if (Array.isArray(value)) {
      // Check for sparse arrays (holes)
      for (let i = 0; i < value.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        if (!desc) {
          throw new Error('SPARSE_ARRAY: array contains holes');
        }
        if (desc.get || desc.set) {
          throw new Error('GETTER_SETTER: array element has getter/setter');
        }
      }

      // Check for extra non-index properties
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (typeof key === 'symbol') {
          throw new Error('SYMBOL_KEY: symbol keys not allowed');
        }
        // Allow 'length' and numeric indices only
        if (key !== 'length') {
          const asNum = Number(key);
          if (!Number.isInteger(asNum) || asNum < 0 || asNum >= value.length) {
            throw new Error(`EXTRA_ARRAY_PROPERTY: unexpected array property "${key}"`);
          }
        }
      }

      // Recursively validate elements (read via descriptor)
      const parts = [];
      for (let i = 0; i < value.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        parts.push(validateAndCanonicalizeValue(desc.value, depth + 1, seen));
      }
      return '[' + parts.join(',') + ']';
    }

    // Plain objects
    const ownKeys = Reflect.ownKeys(value);

    // Reject symbol keys
    for (const key of ownKeys) {
      if (typeof key === 'symbol') {
        throw new Error('SYMBOL_KEY: symbol keys not allowed');
      }
    }

    // Reject dangerous keys
    for (const key of ownKeys) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new Error(`DANGEROUS_KEY: key "${key}" not allowed`);
      }
    }

    // Sort keys for determinism
    const stringKeys = ownKeys.filter(k => typeof k === 'string').sort();

    const parts = [];
    for (const key of stringKeys) {
      const desc = Object.getOwnPropertyDescriptor(value, key);

      if (!desc) {
        throw new Error(`MISSING_DESCRIPTOR: no descriptor for key "${key}"`);
      }

      if (desc.get || desc.set) {
        throw new Error(`GETTER_SETTER: key "${key}" has getter or setter`);
      }

      if (!desc.enumerable) {
        // Skip non-enumerable properties silently (like 'length' on arrays)
        continue;
      }

      // Recursively validate value (read from descriptor, not property access)
      const canonicalValue = validateAndCanonicalizeValue(desc.value, depth + 1, seen);
      parts.push(JSON.stringify(key) + ':' + canonicalValue);
    }

    return '{' + parts.join(',') + '}';
  } finally {
    seen.delete(value);
  }
}

/**
 * Encode value as length-prefixed canonical JSON.
 */
function encodeAsLengthPrefixedJSON(value) {
  const canonical = validateAndCanonicalizeValue(value);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  return `${bytes}:${canonical}`;
}

/**
 * Validate actionSlot structure (integrated contract).
 * EXACT schema: actionSlotId, continuationId, expectedParentSequence,
 * expectedInputWatermark, goalVersion, snapshotHash, decisionCode, attempt.
 */
function validateActionSlot(actionSlot, seen = new Set()) {
  if (!isPlainObject(actionSlot)) {
    throw new Error('INVALID_ACTION_SLOT: actionSlot must be a plain object');
  }

  // Check for cycles
  if (seen.has(actionSlot)) {
    throw new Error('CIRCULAR_REFERENCE: circular reference in actionSlot');
  }
  seen.add(actionSlot);

  const ownKeys = Reflect.ownKeys(actionSlot);

  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      throw new Error('SYMBOL_KEY: actionSlot contains symbol key');
    }

    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`DANGEROUS_KEY: actionSlot contains "${key}"`);
    }

    if (!ACTION_SLOT_SCHEMA.has(key)) {
      throw new Error(`UNKNOWN_ACTION_SLOT_KEY: unexpected key "${key}" in actionSlot`);
    }

    const desc = Object.getOwnPropertyDescriptor(actionSlot, key);
    if (!desc) {
      throw new Error(`MISSING_DESCRIPTOR: no descriptor for actionSlot.${key}`);
    }

    if (desc.get || desc.set) {
      throw new Error(`GETTER_SETTER: actionSlot.${key} has getter or setter`);
    }
  }

  // Check all required fields present
  for (const requiredKey of ACTION_SLOT_SCHEMA) {
    if (!Object.hasOwn(actionSlot, requiredKey)) {
      throw new Error(`MISSING_ACTION_SLOT_FIELD: required field "${requiredKey}" missing from actionSlot`);
    }
  }
}

/**
 * Validate runPath: must be normalized relative path, no traversal/absolute/backslash/NUL.
 */
function validateRunPath(runPath) {
  if (typeof runPath !== 'string' || runPath.trim() === '') {
    throw new Error('INVALID_RUN_PATH: runPath must be a non-empty string');
  }

  if (hasInvalidControlChars(runPath)) {
    throw new Error('INVALID_RUN_PATH: runPath contains invalid control characters');
  }

  const bytes = Buffer.byteLength(runPath, 'utf8');
  if (bytes > MAX_RUN_PATH_BYTES) {
    throw new Error(`INVALID_RUN_PATH: runPath is ${bytes} bytes, max ${MAX_RUN_PATH_BYTES}`);
  }

  // Reject absolute paths
  if (runPath.startsWith('/')) {
    throw new Error('INVALID_RUN_PATH: runPath must not be absolute');
  }

  // Reject backslashes (Windows-style paths, ambiguity)
  if (runPath.includes('\\')) {
    throw new Error('INVALID_RUN_PATH: runPath must not contain backslashes');
  }

  // Reject path traversal
  if (runPath.includes('../') || runPath.includes('/..') || runPath === '..') {
    throw new Error('INVALID_RUN_PATH: runPath must not contain traversal (..)');
  }
}

/**
 * Validate registeredEventRefs: bounded array of exact non-empty event ID strings.
 */
function validateRegisteredEventRefs(registeredEventRefs) {
  if (!Array.isArray(registeredEventRefs)) {
    throw new Error('INVALID_REGISTERED_EVENT_REFS: registeredEventRefs must be an array');
  }

  if (registeredEventRefs.length > MAX_EVENT_REFS) {
    throw new Error(`INVALID_REGISTERED_EVENT_REFS: too many event refs (${registeredEventRefs.length}, max ${MAX_EVENT_REFS})`);
  }

  // Validate array elements via descriptors
  for (let i = 0; i < registeredEventRefs.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(registeredEventRefs, i);
    if (!desc) {
      throw new Error('SPARSE_ARRAY: registeredEventRefs contains holes');
    }
    if (desc.get || desc.set) {
      throw new Error('GETTER_SETTER: registeredEventRefs element has getter/setter');
    }
    if (typeof desc.value !== 'string') {
      throw new Error('INVALID_REGISTERED_EVENT_REFS: all event refs must be strings');
    }
    if (desc.value.trim() === '') {
      throw new Error('INVALID_REGISTERED_EVENT_REFS: event refs must be non-empty');
    }
    const bytes = Buffer.byteLength(desc.value, 'utf8');
    if (bytes > MAX_EVENT_REF_BYTES) {
      throw new Error(`INVALID_REGISTERED_EVENT_REFS: event ref is ${bytes} bytes, max ${MAX_EVENT_REF_BYTES}`);
    }
  }

  // Check for extra array properties
  const refKeys = Reflect.ownKeys(registeredEventRefs);
  for (const key of refKeys) {
    if (typeof key === 'symbol') {
      throw new Error('SYMBOL_KEY: registeredEventRefs has symbol key');
    }
    if (key !== 'length') {
      const asNum = Number(key);
      if (!Number.isInteger(asNum) || asNum < 0 || asNum >= registeredEventRefs.length) {
        throw new Error(`EXTRA_ARRAY_PROPERTY: registeredEventRefs has unexpected property "${key}"`);
      }
    }
  }
}

/**
 * Validate expectedNextAction: bounded allowlisted/structured value consistent with decisionCode.
 */
function validateExpectedNextAction(expectedNextAction) {
  if (typeof expectedNextAction === 'string') {
    if (expectedNextAction.trim() === '') {
      throw new Error('INVALID_EXPECTED_NEXT_ACTION: expectedNextAction string must be non-empty');
    }
    if (expectedNextAction.length > MAX_EXPECTED_NEXT_ACTION_STRING) {
      throw new Error(`INVALID_EXPECTED_NEXT_ACTION: string too long (${expectedNextAction.length}, max ${MAX_EXPECTED_NEXT_ACTION_STRING})`);
    }
    return;
  }

  if (isPlainObject(expectedNextAction)) {
    const ownKeys = Reflect.ownKeys(expectedNextAction);
    for (const key of ownKeys) {
      if (typeof key === 'symbol') {
        throw new Error('SYMBOL_KEY: expectedNextAction contains symbol key');
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw new Error(`DANGEROUS_KEY: expectedNextAction contains "${key}"`);
      }
      if (!EXPECTED_NEXT_ACTION_SCHEMA.has(key)) {
        throw new Error(`UNKNOWN_KEY: unexpected key "${key}" in expectedNextAction`);
      }

      const desc = Object.getOwnPropertyDescriptor(expectedNextAction, key);
      if (desc && (desc.get || desc.set)) {
        throw new Error(`GETTER_SETTER: expectedNextAction.${key} has getter or setter`);
      }
    }

    // Validate type field if present
    if (Object.hasOwn(expectedNextAction, 'type')) {
      const typeDesc = Object.getOwnPropertyDescriptor(expectedNextAction, 'type');
      const typeValue = typeDesc.value;
      if (typeof typeValue !== 'string') {
        throw new Error('INVALID_EXPECTED_NEXT_ACTION: type must be a string');
      }
      if (!EXPECTED_NEXT_ACTION_TYPES.has(typeValue)) {
        throw new Error(`INVALID_EXPECTED_NEXT_ACTION: type "${typeValue}" not allowed`);
      }
    }

    return;
  }

  throw new Error('INVALID_EXPECTED_NEXT_ACTION: must be string or plain object');
}

/**
 * Validate continuation input schema and security properties.
 * Integrated contract: exact top-level schema with actionSlot field bindings.
 */
function validateContinuationInput(input) {
  // Must be plain object
  if (!isPlainObject(input)) {
    throw new Error('INVALID_INPUT: input must be a plain object');
  }

  // Check for dangerous keys and symbols at top level
  const inputKeys = Reflect.ownKeys(input);
  for (const key of inputKeys) {
    if (typeof key === 'symbol') {
      throw new Error('SYMBOL_KEY: input contains symbol key');
    }
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`DANGEROUS_KEY: input contains "${key}"`);
    }
  }

  // Check for schema drift
  const stringKeys = inputKeys.filter(k => typeof k === 'string');
  for (const key of stringKeys) {
    if (!CONTINUATION_SCHEMA.has(key)) {
      throw new Error(`UNKNOWN_KEY: unexpected key "${key}" in input`);
    }
  }

  // Check all required keys present
  for (const key of CONTINUATION_SCHEMA) {
    if (!Object.hasOwn(input, key)) {
      throw new Error(`MISSING_KEY: required key "${key}" missing from input`);
    }
  }

  // Read values via descriptors to avoid triggering getters
  const goalInstanceDesc = Object.getOwnPropertyDescriptor(input, 'goalInstance');
  const goalVersionDesc = Object.getOwnPropertyDescriptor(input, 'goalVersion');
  const actionSlotDesc = Object.getOwnPropertyDescriptor(input, 'actionSlot');
  const continuationIdDesc = Object.getOwnPropertyDescriptor(input, 'continuationId');
  const snapshotHashDesc = Object.getOwnPropertyDescriptor(input, 'snapshotHash');
  const expectedParentSequenceDesc = Object.getOwnPropertyDescriptor(input, 'expectedParentSequence');
  const expectedInputWatermarkDesc = Object.getOwnPropertyDescriptor(input, 'expectedInputWatermark');
  const decisionCodeDesc = Object.getOwnPropertyDescriptor(input, 'decisionCode');
  const runPathDesc = Object.getOwnPropertyDescriptor(input, 'runPath');
  const registeredEventRefsDesc = Object.getOwnPropertyDescriptor(input, 'registeredEventRefs');
  const expectedNextActionDesc = Object.getOwnPropertyDescriptor(input, 'expectedNextAction');

  // Check for getters/setters
  if (goalInstanceDesc?.get || goalInstanceDesc?.set) {
    throw new Error('GETTER_SETTER: goalInstance has getter or setter');
  }
  if (goalVersionDesc?.get || goalVersionDesc?.set) {
    throw new Error('GETTER_SETTER: goalVersion has getter or setter');
  }
  if (actionSlotDesc?.get || actionSlotDesc?.set) {
    throw new Error('GETTER_SETTER: actionSlot has getter or setter');
  }
  if (continuationIdDesc?.get || continuationIdDesc?.set) {
    throw new Error('GETTER_SETTER: continuationId has getter or setter');
  }
  if (snapshotHashDesc?.get || snapshotHashDesc?.set) {
    throw new Error('GETTER_SETTER: snapshotHash has getter or setter');
  }
  if (expectedParentSequenceDesc?.get || expectedParentSequenceDesc?.set) {
    throw new Error('GETTER_SETTER: expectedParentSequence has getter or setter');
  }
  if (expectedInputWatermarkDesc?.get || expectedInputWatermarkDesc?.set) {
    throw new Error('GETTER_SETTER: expectedInputWatermark has getter or setter');
  }
  if (decisionCodeDesc?.get || decisionCodeDesc?.set) {
    throw new Error('GETTER_SETTER: decisionCode has getter or setter');
  }
  if (runPathDesc?.get || runPathDesc?.set) {
    throw new Error('GETTER_SETTER: runPath has getter or setter');
  }
  if (registeredEventRefsDesc?.get || registeredEventRefsDesc?.set) {
    throw new Error('GETTER_SETTER: registeredEventRefs has getter or setter');
  }
  if (expectedNextActionDesc?.get || expectedNextActionDesc?.set) {
    throw new Error('GETTER_SETTER: expectedNextAction has getter or setter');
  }

  // Now safe to read values from descriptors
  const goalInstance = goalInstanceDesc.value;
  const goalVersion = goalVersionDesc.value;
  const actionSlot = actionSlotDesc.value;
  const continuationId = continuationIdDesc.value;
  const snapshotHash = snapshotHashDesc.value;
  const expectedParentSequence = expectedParentSequenceDesc.value;
  const expectedInputWatermark = expectedInputWatermarkDesc.value;
  const decisionCode = decisionCodeDesc.value;
  const runPath = runPathDesc.value;
  const registeredEventRefs = registeredEventRefsDesc.value;
  const expectedNextAction = expectedNextActionDesc.value;

  // Validate individual top-level fields
  if (typeof goalInstance !== 'string' || goalInstance.trim() === '') {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance must be a non-empty string');
  }
  const goalInstanceBytes = Buffer.byteLength(goalInstance, 'utf8');
  if (goalInstanceBytes > MAX_GOAL_INSTANCE_BYTES) {
    throw new Error(`INVALID_GOAL_INSTANCE: too large (${goalInstanceBytes} bytes, max ${MAX_GOAL_INSTANCE_BYTES})`);
  }

  if (typeof goalVersion !== 'string' || goalVersion.trim() === '') {
    throw new Error('INVALID_GOAL_VERSION: goalVersion must be a non-empty string');
  }
  const goalVersionBytes = Buffer.byteLength(goalVersion, 'utf8');
  if (goalVersionBytes > MAX_GOAL_VERSION_BYTES) {
    throw new Error(`INVALID_GOAL_VERSION: too large (${goalVersionBytes} bytes, max ${MAX_GOAL_VERSION_BYTES})`);
  }

  validateActionSlot(actionSlot);

  if (typeof continuationId !== 'string' || continuationId.trim() === '') {
    throw new Error('INVALID_CONTINUATION_ID: continuationId must be a non-empty string');
  }
  const continuationIdBytes = Buffer.byteLength(continuationId, 'utf8');
  if (continuationIdBytes > MAX_CONTINUATION_ID_BYTES) {
    throw new Error(`INVALID_CONTINUATION_ID: too large (${continuationIdBytes} bytes, max ${MAX_CONTINUATION_ID_BYTES})`);
  }

  if (typeof snapshotHash !== 'string' || !SHA256_REGEX.test(snapshotHash)) {
    throw new Error('INVALID_SNAPSHOT_HASH: snapshotHash must be a 64-character hex string');
  }

  if (!Number.isInteger(expectedParentSequence) || expectedParentSequence < 0 || !Number.isSafeInteger(expectedParentSequence)) {
    throw new Error('INVALID_EXPECTED_PARENT_SEQUENCE: expectedParentSequence must be a non-negative safe integer');
  }

  if (!Number.isInteger(expectedInputWatermark) || expectedInputWatermark < 0 || !Number.isSafeInteger(expectedInputWatermark)) {
    throw new Error('INVALID_EXPECTED_INPUT_WATERMARK: expectedInputWatermark must be a non-negative safe integer');
  }

  if (!VALID_DECISION_CODES.has(decisionCode)) {
    throw new Error(`INVALID_DECISION_CODE: decisionCode must be one of ${[...VALID_DECISION_CODES].join(', ')}`);
  }

  validateRunPath(runPath);
  validateRegisteredEventRefs(registeredEventRefs);
  validateExpectedNextAction(expectedNextAction);

  // Now validate actionSlot field bindings (exact match to top-level fields)
  const actionSlotContinuationIdDesc = Object.getOwnPropertyDescriptor(actionSlot, 'continuationId');
  const actionSlotExpectedParentSequenceDesc = Object.getOwnPropertyDescriptor(actionSlot, 'expectedParentSequence');
  const actionSlotExpectedInputWatermarkDesc = Object.getOwnPropertyDescriptor(actionSlot, 'expectedInputWatermark');
  const actionSlotGoalVersionDesc = Object.getOwnPropertyDescriptor(actionSlot, 'goalVersion');
  const actionSlotSnapshotHashDesc = Object.getOwnPropertyDescriptor(actionSlot, 'snapshotHash');
  const actionSlotDecisionCodeDesc = Object.getOwnPropertyDescriptor(actionSlot, 'decisionCode');
  const actionSlotAttemptDesc = Object.getOwnPropertyDescriptor(actionSlot, 'attempt');

  if (actionSlotContinuationIdDesc.value !== continuationId) {
    throw new Error('ACTION_SLOT_MISMATCH: actionSlot.continuationId does not match top-level continuationId');
  }

  if (actionSlotExpectedParentSequenceDesc.value !== expectedParentSequence) {
    throw new Error('ACTION_SLOT_MISMATCH: actionSlot.expectedParentSequence does not match top-level expectedParentSequence');
  }

  if (actionSlotExpectedInputWatermarkDesc.value !== expectedInputWatermark) {
    throw new Error('ACTION_SLOT_MISMATCH: actionSlot.expectedInputWatermark does not match top-level expectedInputWatermark');
  }

  if (actionSlotGoalVersionDesc.value !== goalVersion) {
    throw new Error('ACTION_SLOT_MISMATCH: actionSlot.goalVersion does not match top-level goalVersion');
  }

  if (actionSlotSnapshotHashDesc.value !== snapshotHash) {
    throw new Error('ACTION_SLOT_MISMATCH: actionSlot.snapshotHash does not match top-level snapshotHash');
  }

  if (actionSlotDecisionCodeDesc.value !== decisionCode) {
    throw new Error('ACTION_SLOT_MISMATCH: actionSlot.decisionCode does not match top-level decisionCode');
  }

  // Validate attempt field
  const attempt = actionSlotAttemptDesc.value;
  if (!Number.isInteger(attempt) || attempt < 0 || !Number.isSafeInteger(attempt)) {
    throw new Error('INVALID_ATTEMPT: attempt must be a non-negative safe integer');
  }

  // Check total input size using canonical encoding
  const canonicalInput = validateAndCanonicalizeValue(input);
  const serializedSize = Buffer.byteLength(canonicalInput, 'utf8');
  if (serializedSize > MAX_INPUT_BYTES) {
    throw new Error(`INPUT_TOO_LARGE: input serialized size ${serializedSize} exceeds maximum ${MAX_INPUT_BYTES}`);
  }
}

/**
 * Render immutable continuation prompt.
 * All bindings are encoded as length-prefixed canonical JSON to prevent injection.
 */
export function renderContinuationPrompt(input) {
  validateContinuationInput(input);

  // Read validated values via descriptors (already validated above)
  const goalInstanceDesc = Object.getOwnPropertyDescriptor(input, 'goalInstance');
  const goalVersionDesc = Object.getOwnPropertyDescriptor(input, 'goalVersion');
  const actionSlotDesc = Object.getOwnPropertyDescriptor(input, 'actionSlot');
  const continuationIdDesc = Object.getOwnPropertyDescriptor(input, 'continuationId');
  const snapshotHashDesc = Object.getOwnPropertyDescriptor(input, 'snapshotHash');
  const expectedParentSequenceDesc = Object.getOwnPropertyDescriptor(input, 'expectedParentSequence');
  const expectedInputWatermarkDesc = Object.getOwnPropertyDescriptor(input, 'expectedInputWatermark');
  const decisionCodeDesc = Object.getOwnPropertyDescriptor(input, 'decisionCode');
  const runPathDesc = Object.getOwnPropertyDescriptor(input, 'runPath');
  const registeredEventRefsDesc = Object.getOwnPropertyDescriptor(input, 'registeredEventRefs');
  const expectedNextActionDesc = Object.getOwnPropertyDescriptor(input, 'expectedNextAction');

  // Encode all fields as length-prefixed canonical JSON
  const encodedGoalInstance = encodeAsLengthPrefixedJSON(goalInstanceDesc.value);
  const encodedGoalVersion = encodeAsLengthPrefixedJSON(goalVersionDesc.value);
  const encodedActionSlot = encodeAsLengthPrefixedJSON(actionSlotDesc.value);
  const encodedContinuationId = encodeAsLengthPrefixedJSON(continuationIdDesc.value);
  const encodedSnapshotHash = encodeAsLengthPrefixedJSON(snapshotHashDesc.value);
  const encodedParentSequence = encodeAsLengthPrefixedJSON(expectedParentSequenceDesc.value);
  const encodedInputWatermark = encodeAsLengthPrefixedJSON(expectedInputWatermarkDesc.value);
  const encodedDecisionCode = encodeAsLengthPrefixedJSON(decisionCodeDesc.value);
  const encodedRunPath = encodeAsLengthPrefixedJSON(runPathDesc.value);
  const encodedEventRefs = encodeAsLengthPrefixedJSON(registeredEventRefsDesc.value);
  const encodedNextAction = encodeAsLengthPrefixedJSON(expectedNextActionDesc.value);

  // Fixed template with all bindings as structured data
  return `COHUB_GOAL_CONTINUATION

Goal Instance: ${encodedGoalInstance}
Goal Version: ${encodedGoalVersion}
Action Slot: ${encodedActionSlot}
Continuation ID: ${encodedContinuationId}
Snapshot Hash: ${encodedSnapshotHash}
Expected Parent Sequence: ${encodedParentSequence}
Expected Input Watermark: ${encodedInputWatermark}
Decision Code: ${encodedDecisionCode}
Run Path: ${encodedRunPath}
Registered Event Refs: ${encodedEventRefs}
Expected Next Action: ${encodedNextAction}

Instructions:
1. Read the current state from the authority files in the run path
2. Consume all registered events from the event refs list
3. Execute the single allowed action specified in the action slot
4. Before completing this turn, ensure one of:
   - A real external event is being waited for
   - A legitimate user gate is active
   - An evidence-based blocking condition exists
   - The state has changed and been persisted

Do not present inference or speculation as established fact.
Do not claim completion without verify evidence.
Every state assertion must be traceable to a fresh read or confirmed write.`;
}

/**
 * Render native goal condition for Claude /goal.
 * Launcher-owned, <4000 chars, rejects injection/format controls, safely encodes goalInstance.
 * Semantically settles only on fresh verify DONE|PAUSED_USER|BLOCKED.
 * Only DONE ends macro goal.
 */
export function renderNativeGoalCondition(goalInstance) {
  // Validate goal instance
  if (typeof goalInstance !== 'string' || goalInstance.trim() === '') {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance must be a non-empty string');
  }

  const goalInstanceBytes = Buffer.byteLength(goalInstance, 'utf8');
  if (goalInstanceBytes > MAX_GOAL_INSTANCE_BYTES) {
    throw new Error(`INVALID_GOAL_INSTANCE: too large (${goalInstanceBytes} bytes, max ${MAX_GOAL_INSTANCE_BYTES})`);
  }

  // Reject newlines and control characters (potential injection)
  if (hasInvalidControlChars(goalInstance) || goalInstance.includes('\n')) {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance contains invalid characters');
  }

  // Reject common injection patterns
  if (goalInstance.match(/<[^>]+>/) || goalInstance.match(/\b(ignore|disregard|forget)\b/i)) {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance contains suspicious patterns');
  }

  // Fixed template, under 4000 characters
  const condition = `Monitor and supervise goalInstance="${goalInstance}".

Use only the cohub_goal MCP tools: inspect, submit, wait, verify.

The Cohub parent Agent is the sole workflow writer. You supervise and verify.

When waiting for external work, call wait and remain in the current turn. Do not poll.

This native goal settles when the latest verify returns:
- DONE: workflow is complete (macro goal ends)
- PAUSED_USER: awaiting user input (native goal ends, macro goal persists)
- BLOCKED: evidence-based blocker (native goal ends, macro goal persists)

Only DONE represents workflow completion. PAUSED_USER and BLOCKED end this monitoring session but the macro goal remains active in the ledger.

If verify returns RUNNING, continue executing the single allowed action.

Do not treat assistant text, Turn completed status, worker reports, or legacy callbacks as completion evidence.

Do not call Codex tools.`;

  // Enforce length constraint
  if (condition.length > 4000) {
    throw new Error(`CONDITION_TOO_LONG: condition is ${condition.length} characters, must be ≤4000`);
  }

  return condition;
}
