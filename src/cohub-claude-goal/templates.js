/**
 * @fileoverview Immutable continuation and native-goal templates.
 * Fixed renderer only, no arbitrary prompt text. Deterministic output.
 * All remote/prose/path fields are untrusted data, encoded safely.
 * Dangerous keys, circular references, unknown keys rejected.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_INPUT_BYTES = 50000; // Conservative limit for JSON serialization
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

/**
 * Check if value is a plain object (not array, null, or other types)
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively check for dangerous keys in object tree
 */
function hasDangerousKeys(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object') return false;
  if (seen.has(obj)) return false; // Already checked
  seen.add(obj);

  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) return true;

    const value = obj[key];
    if (typeof value === 'object' && value !== null) {
      if (hasDangerousKeys(value, seen)) return true;
    }
  }
  return false;
}

/**
 * Detect circular references by attempting JSON serialization
 */
function hasCircularReferences(obj) {
  try {
    JSON.stringify(obj);
    return false;
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('circular')) {
      return true;
    }
    // Other JSON errors (e.g., symbol keys) also indicate invalid structure
    return true;
  }
}

/**
 * Validate string contains no control characters except tab/newline/carriage return
 */
function hasInvalidControlChars(str) {
  if (typeof str !== 'string') return false;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Allow tab (9), newline (10), carriage return (13), and printable chars (32-126, 128+)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
    // Reject null byte explicitly
    if (code === 0) return true;
  }
  return false;
}

/**
 * Encode value as length-prefixed JSON for safe embedding
 * Format: <byte-length>:<json-data>
 */
function encodeAsLengthPrefixedJSON(value) {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  return `${bytes}:${json}`;
}

/**
 * Validate continuation input schema and security properties
 */
function validateContinuationInput(input) {
  // Must be plain object
  if (!isPlainObject(input)) {
    throw new Error('INVALID_INPUT: input must be a plain object');
  }

  // Check for dangerous keys FIRST (before other validations)
  if (hasDangerousKeys(input)) {
    throw new Error('DANGEROUS_KEY: input contains __proto__, constructor, or prototype');
  }

  // Check for circular references
  if (hasCircularReferences(input)) {
    throw new Error('CIRCULAR_REFERENCE: input contains circular references');
  }

  // Check for schema drift
  const inputKeys = new Set(Object.keys(input));
  for (const key of inputKeys) {
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

  // Validate individual fields
  if (typeof input.goalInstance !== 'string' || input.goalInstance.trim() === '') {
    throw new Error('INVALID_GOAL_INSTANCE: goalInstance must be a non-empty string');
  }

  if (typeof input.goalVersion !== 'string' || input.goalVersion.trim() === '') {
    throw new Error('INVALID_GOAL_VERSION: goalVersion must be a non-empty string');
  }

  if (!isPlainObject(input.actionSlot)) {
    throw new Error('INVALID_ACTION_SLOT: actionSlot must be a plain object');
  }

  if (typeof input.continuationId !== 'string' || input.continuationId.trim() === '') {
    throw new Error('INVALID_CONTINUATION_ID: continuationId must be a non-empty string');
  }

  if (typeof input.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.snapshotHash)) {
    throw new Error('INVALID_SNAPSHOT_HASH: snapshotHash must be a 64-character hex string');
  }

  if (!Number.isInteger(input.expectedParentSequence) || input.expectedParentSequence < 0) {
    throw new Error('INVALID_EXPECTED_PARENT_SEQUENCE: expectedParentSequence must be a non-negative integer');
  }

  if (!Number.isInteger(input.expectedInputWatermark) || input.expectedInputWatermark < 0) {
    throw new Error('INVALID_EXPECTED_INPUT_WATERMARK: expectedInputWatermark must be a non-negative integer');
  }

  if (!VALID_DECISIONS.has(input.decision)) {
    throw new Error(`INVALID_DECISION: decision must be one of ${[...VALID_DECISIONS].join(', ')}`);
  }

  if (typeof input.runPath !== 'string' || input.runPath.trim() === '') {
    throw new Error('INVALID_RUN_PATH: runPath must be a non-empty string');
  }

  if (hasInvalidControlChars(input.runPath)) {
    throw new Error('INVALID_RUN_PATH: runPath contains invalid control characters');
  }

  if (!Array.isArray(input.registeredEventRefs)) {
    throw new Error('INVALID_REGISTERED_EVENT_REFS: registeredEventRefs must be an array');
  }

  for (const ref of input.registeredEventRefs) {
    if (typeof ref !== 'string') {
      throw new Error('INVALID_REGISTERED_EVENT_REFS: all event refs must be strings');
    }
  }

  if (typeof input.expectedNextAction !== 'string' || input.expectedNextAction.trim() === '') {
    throw new Error('INVALID_EXPECTED_NEXT_ACTION: expectedNextAction must be a non-empty string');
  }

  // Check total input size
  const serializedSize = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (serializedSize > MAX_INPUT_BYTES) {
    throw new Error(`INPUT_TOO_LARGE: input serialized size ${serializedSize} exceeds maximum ${MAX_INPUT_BYTES}`);
  }
}

/**
 * Render immutable continuation prompt.
 * All bindings are encoded as length-prefixed JSON to prevent injection.
 */
export function renderContinuationPrompt(input) {
  validateContinuationInput(input);

  // Encode all fields as length-prefixed JSON for safety
  const encodedGoalInstance = encodeAsLengthPrefixedJSON(input.goalInstance);
  const encodedGoalVersion = encodeAsLengthPrefixedJSON(input.goalVersion);
  const encodedActionSlot = encodeAsLengthPrefixedJSON(input.actionSlot);
  const encodedContinuationId = encodeAsLengthPrefixedJSON(input.continuationId);
  const encodedSnapshotHash = encodeAsLengthPrefixedJSON(input.snapshotHash);
  const encodedParentSequence = encodeAsLengthPrefixedJSON(input.expectedParentSequence);
  const encodedInputWatermark = encodeAsLengthPrefixedJSON(input.expectedInputWatermark);
  const encodedDecision = encodeAsLengthPrefixedJSON(input.decision);
  const encodedRunPath = encodeAsLengthPrefixedJSON(input.runPath);
  const encodedEventRefs = encodeAsLengthPrefixedJSON(input.registeredEventRefs);
  const encodedNextAction = encodeAsLengthPrefixedJSON(input.expectedNextAction);

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
