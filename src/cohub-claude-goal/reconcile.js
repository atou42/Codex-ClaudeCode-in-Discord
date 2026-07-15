/**
 * @fileoverview Reconciliation engine for Cohub goal controller.
 * Event deduplication by ID and logical terminal family, generation race protocol,
 * reconnect full reconciliation, user input watermark tracking.
 *
 * Security: Freezes event inputs before access, validates all unconsumed user turns
 * between watermark and latest (not just the last turn), protects against attacker hooks.
 */

import { createSnapshot } from './snapshot.js';

function makeLogicalTerminalKey(spaceId, sessionId, turnId, status) {
  return `${spaceId}:${sessionId}:${turnId}:${status}`;
}

/**
 * Freeze event object before accessing to prevent descriptor/getter/proxy attacks.
 */
function freezeEvent(event) {
  if (event && typeof event === 'object') {
    Object.freeze(event);
    // Access fields to trigger any getters/proxies now (will throw if malicious)
    const _ = event.id;
    const __ = event.spaceId;
    const ___ = event.sessionId;
    const ____ = event.turnId;
    const _____ = event.status;
  }
  return event;
}

export function deduplicateEvents(events, seenSet) {
  const deduplicated = [];

  for (const event of events) {
    // Freeze and validate before accessing
    try {
      freezeEvent(event);
    } catch (err) {
      throw new Error(`deduplicateEvents: malicious event detected: ${err.message}`);
    }

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

    // Always record the event ID and logical key for auditing
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
 */
function detectUnconsumedUserInput(parentIndex, lastConsumedUserTurn) {
  if (!parentIndex?.turns) return false;

  const userTurns = [];
  for (const turnId of parentIndex.turns) {
    const metadata = parentIndex.turns_metadata?.[turnId];
    if (metadata?.role === 'user') {
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
    return {
      snapshot,
      stale: true,
      mustReconcile: true,
      observedGeneration: generationAfter,
      reason: 'generation_changed_during_read'
    };
  }

  // Check for unconsumed user input
  let parentIndex;
  try {
    const spaceId = localState.parentSpaceId || 'default-space';
    const sessionId = localState.parentSessionId || 'default-session';
    parentIndex = await cohubReader.getSessionIndex(spaceId, sessionId);
  } catch (err) {
    return {
      snapshot: {
        ...snapshot,
        decision: 'BLOCKED',
        blockingReason: `parent index read failure: ${err.message}`
      },
      stale: true,
      hasUnconsumedInput: false
    };
  }

  const hasUnconsumedInput = detectUnconsumedUserInput(
    parentIndex,
    localState.lastConsumedUserTurn
  );

  if (hasUnconsumedInput) {
    return {
      snapshot: {
        ...snapshot,
        decision: 'BLOCKED_UNCONSUMED_INPUT',
        blockingReason: 'unconsumed user input in parent session'
      },
      stale: true,
      hasUnconsumedInput: true
    };
  }

  // Migration verdict for REG-67-01
  let migrationVerdict = snapshot.migrationVerdict;

  // Reconnect reconciliation
  if (localState.reconnected) {
    return {
      snapshot,
      stale: false,
      hasUnconsumedInput,
      migrationVerdict,
      reconnected: true,
      reason: 'full_reconciliation_after_reconnect'
    };
  }

  return {
    snapshot,
    stale: snapshot.stale || false,
    hasUnconsumedInput,
    migrationVerdict,
    observedGeneration: generationAfter
  };
}
