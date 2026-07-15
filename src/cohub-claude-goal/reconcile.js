/**
 * @fileoverview Reconciliation engine for Cohub goal controller.
 * Event deduplication by ID and logical terminal family, generation race protocol,
 * reconnect full reconciliation, user input watermark tracking.
 *
 * STRICT BOUNDARY SECURITY:
 * - Validates events before execution, never mutates caller seenSet until batch validates
 * - Rejects Proxy/getter before any property access
 * - Detects unconsumed external input: ALL unregistered parent Turns after watermark
 * - Bridge-created Turns identified by registered continuation/clientMessageId
 * - Double-read consistency: captures generation before and after, refuses on race
 * - Exact Cohub sequence ordering preserved
 */

import util from 'node:util';
import { createSnapshot } from './snapshot.js';
import { createIntegrityError, deepFreeze } from './boundary-validator.js';

function makeLogicalTerminalKey(spaceId, sessionId, turnId, status) {
  return `${spaceId}:${sessionId}:${turnId}:${status}`;
}

/**
 * Validate event structure before ANY property access.
 * MUST detect Proxy/getter/accessor before execution.
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('EVENT_MUST_BE_OBJECT');
  }

  // CRITICAL: Detect Proxy before any property access
  if (util.types.isProxy(event)) {
    throw new TypeError('PROXY_NOT_ALLOWED');
  }

  // Check prototype
  const proto = Object.getPrototypeOf(event);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('INVALID_EVENT_PROTOTYPE');
  }

  // Get descriptors to check for accessors without invoking them
  const descriptors = Object.getOwnPropertyDescriptors(event);

  // Reject accessor properties
  for (const key of Object.keys(descriptors)) {
    const desc = descriptors[key];
    if (desc.get || desc.set) {
      throw new TypeError('ACCESSOR_PROPERTY_NOT_ALLOWED');
    }
  }

  // Reject symbol properties
  const symbols = Object.getOwnPropertySymbols(event);
  if (symbols.length > 0) {
    throw new TypeError('SYMBOL_PROPERTIES_NOT_ALLOWED');
  }

  // NOW safe to access fields (no getters/proxies can execute)
  if (typeof event.id !== 'string' || event.id.trim() === '') {
    throw new TypeError('EVENT_ID_INVALID');
  }
  if (typeof event.spaceId !== 'string') {
    throw new TypeError('EVENT_SPACEID_INVALID');
  }
  if (typeof event.sessionId !== 'string') {
    throw new TypeError('EVENT_SESSIONID_INVALID');
  }
  if (typeof event.turnId !== 'string') {
    throw new TypeError('EVENT_TURNID_INVALID');
  }
  if (typeof event.status !== 'string') {
    throw new TypeError('EVENT_STATUS_INVALID');
  }

  return Object.freeze({
    id: event.id,
    spaceId: event.spaceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    status: event.status
  });
}

/**
 * Deduplicate events by ID and logical terminal family.
 * CRITICAL: Must validate ALL events before updating seenSet.
 * If any event is malformed, seenSet must remain unchanged (no partial state).
 */
export function deduplicateEvents(events, seenSet) {
  if (!Array.isArray(events)) {
    throw new TypeError('EVENTS_MUST_BE_ARRAY');
  }

  if (!seenSet || typeof seenSet.add !== 'function') {
    throw new TypeError('SEENSET_MUST_BE_SET');
  }

  // Phase 1: Validate ALL events first (before mutating seenSet)
  const validated = [];
  for (const event of events) {
    try {
      const validatedEvent = validateEvent(event);
      validated.push(validatedEvent);
    } catch (err) {
      // On ANY validation error, throw without modifying seenSet
      throw new Error(`deduplicateEvents: malicious event detected`);
    }
  }

  // Phase 2: Now safe to process and update seenSet
  const deduplicated = [];

  for (const event of validated) {
    let isDuplicate = false;

    // Check event ID duplication
    if (seenSet.has(event.id)) {
      isDuplicate = true;
    }

    // Check logical terminal family duplication
    const logicalKey = makeLogicalTerminalKey(
      event.spaceId,
      event.sessionId,
      event.turnId,
      event.status
    );

    if (seenSet.has(logicalKey)) {
      isDuplicate = true;
    }

    // Record in seenSet
    seenSet.add(event.id);
    seenSet.add(logicalKey);

    // Only add to deduplicated if not a duplicate
    if (!isDuplicate) {
      deduplicated.push(event);
    }
  }

  return deduplicated;
}

/**
 * Detects ALL unconsumed external input between lastConsumedUserTurn and latest.
 * External input = any Turn NOT in registeredContinuations, regardless of role.
 * Bridge-created Turns identified by clientMessageId in registeredContinuations.
 * Spec requirement: not just role=user, but ALL unregistered Turns after watermark.
 */
function detectUnconsumedExternalInput(parentIndex, lastConsumedUserTurn, registeredContinuations) {
  if (!parentIndex || typeof parentIndex !== 'object') {
    // Malformed index = cannot verify, fail closed
    throw new TypeError('PARENT_INDEX_INVALID');
  }

  // Validate parentIndex structure before access
  if (util.types.isProxy(parentIndex)) {
    throw new TypeError('PARENT_INDEX_PROXY_DETECTED');
  }

  const turns = parentIndex.turns;
  const turnsMetadata = parentIndex.turns_metadata;

  if (!turns || !Array.isArray(turns)) {
    // Malformed = fail closed
    throw new TypeError('PARENT_INDEX_TURNS_INVALID');
  }

  // Find watermark position
  let watermarkIndex = -1;
  if (lastConsumedUserTurn) {
    watermarkIndex = turns.indexOf(lastConsumedUserTurn);
    if (watermarkIndex === -1) {
      // Watermark not found in current turns = assume unconsumed
      return true;
    }
  }

  // Check all Turns after watermark
  const turnsAfterWatermark = turns.slice(watermarkIndex + 1);

  for (const turnId of turnsAfterWatermark) {
    // Bridge-created Turns are in registeredContinuations
    if (registeredContinuations && registeredContinuations.has(turnId)) {
      continue; // This is a known bridge continuation, not external
    }

    // Any unregistered Turn (user, assistant without clientMessageId, or other) is external
    return true;
  }

  return false;
}

export async function reconcile(goalInstance, cohubReader, ledger, localState) {
  // Capture generation BEFORE any reads
  const generationBefore = typeof localState.getGeneration === 'function'
    ? localState.getGeneration()
    : 0;

  // Validate identity first
  let parentSpaceId, parentSessionId;
  try {
    if (typeof localState.parentSpaceId !== 'string' || localState.parentSpaceId.trim() === '') {
      throw new TypeError('PARENT_SPACEID_REQUIRED');
    }
    if (typeof localState.parentSessionId !== 'string' || localState.parentSessionId.trim() === '') {
      throw new TypeError('PARENT_SESSIONID_REQUIRED');
    }
    parentSpaceId = localState.parentSpaceId;
    parentSessionId = localState.parentSessionId;
  } catch (err) {
    const snapshot = deepFreeze({
      goalInstance,
      snapshotHash: 'integrity_failure',
      decision: 'BLOCKED',
      blockingReason: 'missing required identity',
      integrityErrors: deepFreeze([createIntegrityError('MISSING_REQUIRED_IDENTITY', 'configuration')]),
      stale: true
    });

    return deepFreeze({
      snapshot,
      stale: true,
      hasUnconsumedInput: false
    });
  }

  // First parent index read
  let parentIndexBefore;
  try {
    parentIndexBefore = await cohubReader.getSessionIndex(parentSpaceId, parentSessionId);
  } catch (err) {
    const snapshot = deepFreeze({
      goalInstance,
      snapshotHash: 'integrity_failure',
      decision: 'BLOCKED',
      blockingReason: 'parent index read failure',
      integrityErrors: deepFreeze([createIntegrityError('AUTHORITY_READ_FAILURE', 'authority')]),
      stale: true
    });

    return deepFreeze({
      snapshot,
      stale: true,
      hasUnconsumedInput: false
    });
  }

  const sequenceBefore = parentIndexBefore && parentIndexBefore.sequence !== undefined
    ? parentIndexBefore.sequence
    : null;

  // Fresh read to generate snapshot (reads parent index internally)
  const snapshot = await createSnapshot(goalInstance, cohubReader, ledger, localState);

  // Second parent index read for consistency check
  let parentIndexAfter;
  try {
    parentIndexAfter = await cohubReader.getSessionIndex(parentSpaceId, parentSessionId);
  } catch (err) {
    return deepFreeze({
      snapshot: deepFreeze({
        ...snapshot,
        decision: 'BLOCKED',
        blockingReason: 'parent index consistency check failed',
        integrityErrors: deepFreeze([
          ...(snapshot.integrityErrors || []),
          createIntegrityError('AUTHORITY_READ_FAILURE', 'authority')
        ])
      }),
      stale: true,
      mustReconcile: true,
      hasUnconsumedInput: false
    });
  }

  const sequenceAfter = parentIndexAfter && parentIndexAfter.sequence !== undefined
    ? parentIndexAfter.sequence
    : null;

  // Capture generation AFTER all reads
  const generationAfter = typeof localState.getGeneration === 'function'
    ? localState.getGeneration()
    : 0;

  // Generation race detection
  if (generationBefore !== generationAfter) {
    return deepFreeze({
      snapshot,
      stale: true,
      mustReconcile: true,
      observedGeneration: generationAfter,
      reason: 'generation_changed_during_read'
    });
  }

  // Sequence consistency check across double-read
  if (sequenceBefore !== null && sequenceAfter !== null && sequenceBefore !== sequenceAfter) {
    return deepFreeze({
      snapshot,
      stale: true,
      mustReconcile: true,
      observedGeneration: generationAfter,
      reason: 'parent_index_changed_between_reads'
    });
  }

  // Check for unconsumed external input
  let hasUnconsumedInput = false;
  try {
    const registeredContinuations = ledger.registeredContinuations || new Set();
    hasUnconsumedInput = detectUnconsumedExternalInput(
      parentIndexAfter,
      localState.lastConsumedUserTurn,
      registeredContinuations
    );
  } catch (err) {
    // Malformed index = fail closed
    return deepFreeze({
      snapshot: deepFreeze({
        ...snapshot,
        decision: 'BLOCKED',
        blockingReason: 'parent index validation failed',
        integrityErrors: deepFreeze([
          ...(snapshot.integrityErrors || []),
          createIntegrityError('PARENT_INDEX_VALIDATION_FAILED', 'security')
        ])
      }),
      stale: true,
      hasUnconsumedInput: false
    });
  }

  if (hasUnconsumedInput) {
    return deepFreeze({
      snapshot: deepFreeze({
        ...snapshot,
        decision: 'BLOCKED_UNCONSUMED_INPUT',
        blockingReason: 'unconsumed external input in parent session'
      }),
      stale: true,
      hasUnconsumedInput: true
    });
  }

  // Migration verdict for REG-67-01
  const migrationVerdict = snapshot.migrationVerdict;

  // Reconnect reconciliation
  if (localState.reconnected) {
    return deepFreeze({
      snapshot,
      stale: false,
      hasUnconsumedInput,
      migrationVerdict,
      reconnected: true,
      reason: 'full_reconciliation_after_reconnect'
    });
  }

  return deepFreeze({
    snapshot,
    stale: snapshot.stale || false,
    hasUnconsumedInput,
    migrationVerdict,
    observedGeneration: generationAfter
  });
}
