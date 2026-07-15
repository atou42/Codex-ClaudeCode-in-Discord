/**
 * @fileoverview Reconciliation engine for Cohub goal controller.
 * Event deduplication by ID and logical terminal family, generation race protocol,
 * reconnect full reconciliation, user input watermark tracking.
 *
 * Security: STRICT BOUNDARY - validates events before execution, never mutates caller
 * seenSet until batch validates, rejects Proxy/getter before any property access.
 */

import util from 'node:util';
import { createSnapshot } from './snapshot.js';

function makeLogicalTerminalKey(spaceId, sessionId, turnId, status) {
  return `${spaceId}:${sessionId}:${turnId}:${status}`;
}

/**
 * Validate event structure before ANY property access.
 * MUST detect Proxy/getter/accessor before execution.
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('Event must be an object');
  }

  // CRITICAL: Detect Proxy before any property access
  if (util.types.isProxy(event)) {
    throw new TypeError('Proxy objects not allowed');
  }

  // Check prototype
  const proto = Object.getPrototypeOf(event);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('Invalid event prototype');
  }

  // Get descriptors to check for accessors without invoking them
  const descriptors = Object.getOwnPropertyDescriptors(event);

  // Reject accessor properties
  for (const [key, desc] of Object.entries(descriptors)) {
    if (desc.get || desc.set) {
      throw new TypeError(`Accessor property not allowed in event: ${key}`);
    }
  }

  // Reject symbol properties
  const symbols = Object.getOwnPropertySymbols(event);
  if (symbols.length > 0) {
    throw new TypeError('Symbol properties not allowed in event');
  }

  // NOW safe to access fields (no getters/proxies can execute)
  if (typeof event.id !== 'string' || event.id.trim() === '') {
    throw new TypeError('Event id must be a non-empty string');
  }
  if (typeof event.spaceId !== 'string') {
    throw new TypeError('Event spaceId must be a string');
  }
  if (typeof event.sessionId !== 'string') {
    throw new TypeError('Event sessionId must be a string');
  }
  if (typeof event.turnId !== 'string') {
    throw new TypeError('Event turnId must be a string');
  }
  if (typeof event.status !== 'string') {
    throw new TypeError('Event status must be a string');
  }

  // Freeze to prevent mutation (but this is caller's object, so clone first if needed)
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
    throw new TypeError('events must be an array');
  }

  if (!seenSet || typeof seenSet.add !== 'function') {
    throw new TypeError('seenSet must be a Set');
  }

  // Phase 1: Validate ALL events first (before mutating seenSet)
  const validated = [];
  for (const event of events) {
    try {
      const validatedEvent = validateEvent(event);
      validated.push(validatedEvent);
    } catch (err) {
      // On ANY validation error, throw without modifying seenSet
      throw new Error(`deduplicateEvents: malicious event detected: ${err.message}`);
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
 * Detects ALL unconsumed user input between lastConsumedUserTurn and the latest turn.
 * Spec requirement: not just the last turn, but all unconsumed user turns.
 * MUST sanitize parentIndex before accessing nested fields.
 */
function detectUnconsumedUserInput(parentIndex, lastConsumedUserTurn) {
  if (!parentIndex || typeof parentIndex !== 'object') {
    return false;
  }

  // Validate parentIndex structure before access
  if (util.types.isProxy(parentIndex)) {
    throw new TypeError('Proxy not allowed in parentIndex');
  }

  const turns = parentIndex.turns;
  const turnsMetadata = parentIndex.turns_metadata;

  if (!turns || !Array.isArray(turns)) {
    return false;
  }

  const userTurns = [];
  for (const turnId of turns) {
    if (!turnsMetadata || typeof turnsMetadata !== 'object') {
      continue;
    }

    const metadata = turnsMetadata[turnId];
    if (metadata && typeof metadata === 'object' && metadata.role === 'user') {
      userTurns.push(turnId);
    }
  }

  if (userTurns.length === 0) return false;

  // No watermark means all user turns are unconsumed
  if (!lastConsumedUserTurn) return true;

  // Find index of last consumed user turn
  const lastConsumedIndex = userTurns.indexOf(lastConsumedUserTurn);
  if (lastConsumedIndex === -1) {
    // Watermark not found in current turn list - assume unconsumed
    return true;
  }

  // Check if there are any user turns after the watermark
  const unconsumedCount = userTurns.length - 1 - lastConsumedIndex;
  return unconsumedCount > 0;
}

export async function reconcile(goalInstance, cohubReader, ledger, localState) {
  const generationBefore = localState.getGeneration?.() ?? 0;

  // Fresh read to generate snapshot
  const snapshot = await createSnapshot(goalInstance, cohubReader, ledger, localState);

  const generationAfter = localState.getGeneration?.() ?? 0;

  // Generation race detection
  if (generationBefore !== generationAfter) {
    return Object.freeze({
      snapshot,
      stale: true,
      mustReconcile: true,
      observedGeneration: generationAfter,
      reason: 'generation_changed_during_read'
    });
  }

  // Check for unconsumed user input - must validate identity first
  let parentSpaceId, parentSessionId;
  try {
    if (typeof localState.parentSpaceId !== 'string' || localState.parentSpaceId.trim() === '') {
      throw new TypeError('parentSpaceId required');
    }
    if (typeof localState.parentSessionId !== 'string' || localState.parentSessionId.trim() === '') {
      throw new TypeError('parentSessionId required');
    }
    parentSpaceId = localState.parentSpaceId;
    parentSessionId = localState.parentSessionId;
  } catch (err) {
    return Object.freeze({
      snapshot: Object.freeze({
        ...snapshot,
        decision: 'BLOCKED',
        blockingReason: 'missing required identity'
      }),
      stale: true,
      hasUnconsumedInput: false
    });
  }

  let parentIndex;
  try {
    parentIndex = await cohubReader.getSessionIndex(parentSpaceId, parentSessionId);
  } catch (err) {
    return Object.freeze({
      snapshot: Object.freeze({
        ...snapshot,
        decision: 'BLOCKED',
        blockingReason: 'parent index read failure'
      }),
      stale: true,
      hasUnconsumedInput: false
    });
  }

  const hasUnconsumedInput = detectUnconsumedUserInput(
    parentIndex,
    localState.lastConsumedUserTurn
  );

  if (hasUnconsumedInput) {
    return Object.freeze({
      snapshot: Object.freeze({
        ...snapshot,
        decision: 'BLOCKED_UNCONSUMED_INPUT',
        blockingReason: 'unconsumed user input in parent session'
      }),
      stale: true,
      hasUnconsumedInput: true
    });
  }

  // Migration verdict for REG-67-01
  let migrationVerdict = snapshot.migrationVerdict;

  // Reconnect reconciliation
  if (localState.reconnected) {
    return Object.freeze({
      snapshot,
      stale: false,
      hasUnconsumedInput,
      migrationVerdict,
      reconnected: true,
      reason: 'full_reconciliation_after_reconnect'
    });
  }

  return Object.freeze({
    snapshot,
    stale: snapshot.stale || false,
    hasUnconsumedInput,
    migrationVerdict,
    observedGeneration: generationAfter
  });
}
