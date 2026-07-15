/**
 * @fileoverview Immutable continuation and native-goal templates.
 * Fixed renderer only, no arbitrary prompt text. Deterministic output.
 * All remote/prose/path fields are untrusted data, encoded safely.
 * Dangerous keys, circular references, unknown keys rejected.
 *
 * SECURITY: Descriptor-walking validator never reads through property access.
 * No getters, setters, toJSON, Proxy traps, functions, symbols, or custom prototypes invoked.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_INPUT_BYTES = 50000;
const VALID_DECISIONS = new Set([
  'continue',
  'continue_with_verify',
  'continue_with_wait',
  'reopen_gate',
  'approve_proposal',
  'approve_style'
]);

const CONTINUATION_SCHEMA = new Set([
  'goalInstance',
  'goalVersion',
  'actionSlot',
  'continuationId',
  'snapshotHash',
  'expectedParentSequence',
  'expectedInputWatermark',
  'decision',
  'runPath',
  'registeredEventRefs',
  'expectedNextAction'
]);

// Valid actionSlot fields (whitelist)
const ACTION_SLOT_SCHEMA = new Set([
  'id',
  'type',
  'phase',
  'event',
  'note',
  'data'
]);

/**
 * Descriptor-walking exact validator. Never reads values through property access.
 * Returns canonical JSON string or throws.
 */
function validateAndCanonicalizeValue(value, depth = 0, seen = new Map()) {
  const MAX_DEPTH = 20;

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
    // Validate string (no reading needed, already a primitive)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        throw new Error('INVALID_STRING: contains control characters');
      }
      if (code === 0) {
        throw new Error('INVALID_STRING: contains null byte');
      }
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

    // Reject Proxy objects (best effort - they may pass through)
    // We can't reliably detect Proxies, but descriptor walking avoids triggering traps

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
 * Encode value as length-prefixed canonical JSON
 */
function encodeAsLengthPrefixedJSON(value) {
  const canonical = validateAndCanonicalizeValue(value);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  return `${bytes}:${canonical}`;
}

/**
 * Check if value is a plain object (not array, null, or other types)
 * Rejects Proxy objects and objects with custom prototypes
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
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
 * Check for __proto__ descriptor (separate check after isPlainObject passes)
 */
function hasProtoDescriptor(value) {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const protoDesc = Object.getOwnPropertyDescriptor(value, '__proto__');
  return protoDesc !== undefined;
}

/**
 * Validate string contains no control characters except tab/newline/carriage return
 */
function hasInvalidControlChars(str) {
  if (typeof str !== 'string') return false;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
    if (code === 0) return true;
  }
  return false;
}

/**
 * Validate actionSlot structure without reading through property access
 */
function validateActionSlot(actionSlot, seen = new Set()) {
  if (!isPlainObject(actionSlot)) {
    throw new Error('INVALID_ACTION_SLOT: actionSlot must be a plain object');
  }

  // Check for __proto__ descriptor (catches descriptor-based attacks)
  if (hasProtoDescriptor(actionSlot)) {
    throw new Error('DANGEROUS_KEY: actionSlot contains __proto__ descriptor');
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

    const value = desc.value;

    // Recursively validate nested structures
    if (key === 'event' && Array.isArray(value)) {
      // Check for cycles in array itself
      if (seen.has(value)) {
        throw new Error('CIRCULAR_REFERENCE: circular reference in event array');
      }
      seen.add(value);

      // event field can be an array - validate each element
      for (let i = 0; i < value.length; i++) {
        const elemDesc = Object.getOwnPropertyDescriptor(value, i);
        if (!elemDesc) {
          throw new Error('SPARSE_ARRAY: event array contains holes');
        }
        if (elemDesc.get || elemDesc.set) {
          throw new Error('GETTER_SETTER: event array element has getter/setter');
        }

        const elem = elemDesc.value;
        if (typeof elem === 'object' && elem !== null) {
          // Check for cycles
          if (seen.has(elem)) {
            throw new Error('CIRCULAR_REFERENCE: circular reference in event array element');
          }

          // Nested object in event array
          if (!isPlainObject(elem)) {
            throw new Error('INVALID_EVENT_ELEMENT: event array element must be plain object');
          }

          seen.add(elem);

          const nestedKeys = Reflect.ownKeys(elem);
          for (const nk of nestedKeys) {
            if (typeof nk === 'symbol') {
              throw new Error('SYMBOL_KEY: event array element contains symbol key');
            }
            if (DANGEROUS_KEYS.has(nk)) {
              throw new Error(`DANGEROUS_KEY: event element contains "${nk}"`);
            }

            const nestedDesc = Object.getOwnPropertyDescriptor(elem, nk);
            if (nestedDesc && (nestedDesc.get || nestedDesc.set)) {
              throw new Error('GETTER_SETTER: nested event element has getter/setter');
            }
          }
        }
      }

      // Check for extra array properties
      const arrayKeys = Reflect.ownKeys(value);
      for (const ak of arrayKeys) {
        if (typeof ak === 'symbol') {
          throw new Error('SYMBOL_KEY: event array has symbol key');
        }
        if (ak !== 'length') {
          const asNum = Number(ak);
          if (!Number.isInteger(asNum) || asNum < 0 || asNum >= value.length) {
            throw new Error(`EXTRA_ARRAY_PROPERTY: event array has unexpected property "${ak}"`);
          }
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      // Check for cycles in nested objects
      if (seen.has(value)) {
        throw new Error('CIRCULAR_REFERENCE: circular reference in actionSlot');
      }
    }
  }
}

/**
 * Validate continuation input schema and security properties
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
  const decisionDesc = Object.getOwnPropertyDescriptor(input, 'decision');
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
  if (decisionDesc?.get || decisionDesc?.set) {
    throw new Error('GETTER_SETTER: decision has getter or setter');
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
  const decision = decisionDesc.value;
  const runPath = runPathDesc.value;
  const registeredEventRefs = registeredEventRefsDesc.value;
  const expectedNextAction = expectedNextActionDesc.value;

  // Validate individual fields
  if (typeof goalInstance !== 'string' || goalInstance.trim() === '') {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance must be a non-empty string');
  }

  if (typeof goalVersion !== 'string' || goalVersion.trim() === '') {
    throw new Error('INVALID_GOAL_VERSION: goalVersion must be a non-empty string');
  }

  validateActionSlot(actionSlot);

  if (typeof continuationId !== 'string' || continuationId.trim() === '') {
    throw new Error('INVALID_CONTINUATION_ID: continuationId must be a non-empty string');
  }

  if (typeof snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotHash)) {
    throw new Error('INVALID_SNAPSHOT_HASH: snapshotHash must be a 64-character hex string');
  }

  if (!Number.isInteger(expectedParentSequence) || expectedParentSequence < 0) {
    throw new Error('INVALID_EXPECTED_PARENT_SEQUENCE: expectedParentSequence must be a non-negative integer');
  }

  if (!Number.isInteger(expectedInputWatermark) || expectedInputWatermark < 0) {
    throw new Error('INVALID_EXPECTED_INPUT_WATERMARK: expectedInputWatermark must be a non-negative integer');
  }

  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`INVALID_DECISION: decision must be one of ${[...VALID_DECISIONS].join(', ')}`);
  }

  if (typeof runPath !== 'string' || runPath.trim() === '') {
    throw new Error('INVALID_RUN_PATH: runPath must be a non-empty string');
  }

  if (hasInvalidControlChars(runPath)) {
    throw new Error('INVALID_RUN_PATH: runPath contains invalid control characters');
  }

  if (!Array.isArray(registeredEventRefs)) {
    throw new Error('INVALID_REGISTERED_EVENT_REFS: registeredEventRefs must be an array');
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
  }

  // Check for extra array properties on registeredEventRefs
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

  if (typeof expectedNextAction !== 'string' || expectedNextAction.trim() === '') {
    throw new Error('INVALID_EXPECTED_NEXT_ACTION: expectedNextAction must be a non-empty string');
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
  const decisionDesc = Object.getOwnPropertyDescriptor(input, 'decision');
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
  const encodedDecision = encodeAsLengthPrefixedJSON(decisionDesc.value);
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
Decision: ${encodedDecision}
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
 * Semantically settles only on fresh verify DONE|PAUSED_USER|BLOCKED.
 * Only DONE ends macro goal.
 */
export function renderNativeGoalCondition(goalInstance) {
  // Validate goal instance
  if (typeof goalInstance !== 'string' || goalInstance.trim() === '') {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance must be a non-empty string');
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
