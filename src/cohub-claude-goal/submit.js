/**
 * Submit action to Cohub parent Agent with idempotent send protocol.
 *
 * Protocol invariants:
 * - Fresh inspect before real send; reject STALE_SNAPSHOT / UNCONSUMED_EXTERNAL_INPUT without sending.
 * - Rederive all fields from fresh inspect; never trust caller-provided snapshot/seq/watermark.
 * - Ledger phases: OBSERVED → PREPARED → REQUEST_STARTED → CONFIRMED at exact durability boundaries.
 * - continuationId is Cohub SDK clientMessageId.
 * - PREPARED recovery: safe first send only if snapshot still matches and never REQUEST_STARTED.
 * - REQUEST_STARTED / AMBIGUOUS recovery: reconcile by clientMessageId in parent Turn meta.
 *   Found exactly one → bind existing Turn, never resend. Not found or multiple/malformed → BLOCKED_AMBIGUOUS_SEND.
 * - CANCELLED_STALE_BEFORE_SEND must be persisted before returning when snapshot changed during PREPARED.
 * - Fixed continuation renderer only; Claude cannot pass arbitrary prompts.
 * - Strict response validation before CONFIRMED.
 *
 * All external effects are injected. Node built-ins only.
 */

import {
  PHASES,
  assertExactOwnKeys,
  assertSafeInteger,
  assertSnapshotHash,
  assertDecisionCode,
  assertValidTransition,
  isTerminalPhase,
  validateSlotHistory,
} from './action-slot.js';

class InjectedCrashError extends Error {
  constructor(at) {
    super(`INJECTED_CRASH at ${at}`);
    this.name = 'InjectedCrashError';
    this.at = at;
  }
}

/**
 * Fixed continuation prompt template. Claude cannot pass arbitrary prompts.
 */
export function buildContinuationTemplate({
  goalInstance,
  goalVersion,
  actionSlotId,
  continuationId,
  snapshotHash,
  expectedParentSequence,
  expectedInputWatermark,
  decisionCode,
  runPath,
  eventRefs = [],
  expectedNextAction,
}) {
  return [
    'COHUB_GOAL_CONTINUATION',
    `goalInstance: ${goalInstance}`,
    `goalVersion: ${goalVersion ?? ''}`,
    `actionSlot: ${actionSlotId}`,
    `continuationId: ${continuationId}`,
    `snapshotHash: ${snapshotHash}`,
    `expectedParentSequence: ${expectedParentSequence ?? ''}`,
    `expectedInputWatermark: ${expectedInputWatermark ?? ''}`,
    `decisionCode: ${decisionCode}`,
    `runPath: ${runPath ?? ''}`,
    `registeredEventRefs: ${JSON.stringify(eventRefs)}`,
    `expectedNextAction: ${expectedNextAction ?? decisionCode}`,
    '',
    'Read authoritative state first. Consume the registered events above.',
    'Execute only the single legal action for the current state.',
    'Before ending, form a real external wait, a legal user gate,',
    'an evidenced block, or a state change. Do not present inference as fact.',
  ].join('\n');
}

function validateResponseSchema(response) {
  if (!response || typeof response !== 'object') {
    throw new TypeError('Response must be an object');
  }
  if (typeof response.turnId !== 'string' || response.turnId.length === 0) {
    throw new TypeError('Response missing valid turnId');
  }
  if (!Number.isSafeInteger(response.sequence) || response.sequence < 0) {
    throw new TypeError('Response missing valid sequence');
  }
}

const SUBMIT_KEYS = [
  'ctx',
  'goalInstance',
  'expectedSnapshotHash',
  'actionSlotId',
  'continuationId',
  'decisionCode',
  'evidenceRefs',
  'currentSnapshot',
  'freshInspect',
  'reconcileByClientMessageId',
  'cohubSend',
  'injectCrash',
  'goalVersion',
  'runPath',
];

/**
 * Submit an action with strict validation and idempotent recovery.
 *
 * @returns {Promise<object>} { success, turnId, reconciled? } or { error, reason }
 */
export async function submitAction(params) {
  const allowedKeys = SUBMIT_KEYS.filter(k => k in params);
  assertExactOwnKeys(params, allowedKeys, 'submitAction params');

  const {
    ctx,
    goalInstance,
    expectedSnapshotHash,
    actionSlotId,
    continuationId,
    decisionCode,
    evidenceRefs = [],
    currentSnapshot,
    freshInspect,
    reconcileByClientMessageId,
    cohubSend,
    injectCrash,
    goalVersion,
    runPath,
  } = params;

  const send = cohubSend || ctx.cohubSend;

  if (!currentSnapshot || typeof currentSnapshot !== 'object') {
    return { error: 'INVALID_CURRENT_SNAPSHOT', reason: 'currentSnapshot must be provided' };
  }

  // 1. Validate action slot against bridge-issued slot. Caller-provided IDs never replace bridge IDs.
  const issuedSlot = currentSnapshot.actionSlot;
  if (!issuedSlot
    || issuedSlot.actionSlotId !== actionSlotId
    || issuedSlot.continuationId !== continuationId) {
    return {
      error: 'INVALID_ACTION_SLOT',
      reason: 'Action slot mismatch: caller-provided slot does not match bridge-issued slot. Self-built IDs, old slots, and ID-swapped retries rejected.',
    };
  }

  // 2. Fresh inspect immediately before send. Rederive all facts; never trust caller snapshot/seq/watermark.
  if (freshInspect) {
    const fresh = await freshInspect();

    if (fresh.snapshotHash !== expectedSnapshotHash) {
      return {
        error: 'STALE_SNAPSHOT',
        reason: `Snapshot changed: expected ${expectedSnapshotHash}, fresh ${fresh.snapshotHash}. Never sending on stale snapshot.`,
        freshSnapshotHash: fresh.snapshotHash,
      };
    }

    if (issuedSlot.expectedParentSequence !== undefined
      && fresh.parentSequence !== undefined
      && issuedSlot.expectedParentSequence !== fresh.parentSequence) {
      return {
        error: 'STALE_SNAPSHOT',
        reason: `Parent sequence changed: expected ${issuedSlot.expectedParentSequence}, fresh ${fresh.parentSequence}.`,
      };
    }

    if (issuedSlot.expectedInputWatermark !== undefined
      && fresh.inputWatermark !== undefined
      && issuedSlot.expectedInputWatermark !== fresh.inputWatermark) {
      return {
        error: 'UNCONSUMED_EXTERNAL_INPUT',
        reason: `Input watermark changed: expected ${issuedSlot.expectedInputWatermark}, fresh ${fresh.inputWatermark}.`,
      };
    }

    if (Array.isArray(fresh.unconsumedEvents) && fresh.unconsumedEvents.length > 0) {
      return {
        error: 'UNCONSUMED_EXTERNAL_INPUT',
        reason: 'Unconsumed user or external control input exists. Never sending before consumed.',
        unconsumedEvents: fresh.unconsumedEvents,
      };
    }
  }

  // 3. Check persisted phases for this exact slot — recover, never create a new ID.
  const slotEntries = ctx.ledger.filter(e => e.actionSlotId === actionSlotId);
  validateSlotHistory(slotEntries);

  const phases = new Set(slotEntries.map(e => e.phase));

  if (phases.has(PHASES.CONFIRMED)) {
    const confirmed = slotEntries.find(e => e.phase === PHASES.CONFIRMED);
    return { success: true, turnId: confirmed.turnId, alreadyConfirmed: true };
  }

  if (phases.has(PHASES.REQUEST_STARTED) || phases.has(PHASES.AMBIGUOUS)) {
    return reconcileStartedSlot({
      ctx,
      actionSlotId,
      continuationId,
      reconcileByClientMessageId,
    });
  }

  const alreadyObserved = phases.has(PHASES.OBSERVED);
  const alreadyPrepared = phases.has(PHASES.PREPARED);

  // 4. Write OBSERVED if not already written.
  if (!alreadyObserved) {
    await ctx.writePhase(PHASES.OBSERVED, {
      actionSlotId,
      continuationId,
      decisionCode,
      expectedSnapshotHash,
      expectedParentSequence: issuedSlot.expectedParentSequence,
      expectedInputWatermark: issuedSlot.expectedInputWatermark,
      goalInstance,
    });
  }

  // 5. Write PREPARED if not already written (unless recovering an existing PREPARED with matching snapshot).
  if (!alreadyPrepared) {
    await ctx.writePhase(PHASES.PREPARED, {
      actionSlotId,
      continuationId,
      decisionCode,
      evidenceRefs,
      expectedSnapshotHash,
      expectedParentSequence: issuedSlot.expectedParentSequence,
      expectedInputWatermark: issuedSlot.expectedInputWatermark,
      goalInstance,
    });
  }

  if (injectCrash?.at === 'before-send') {
    throw new InjectedCrashError('before-send');
  }

  // 6. Build fixed continuation template using only the fixed renderer.
  const prompt = buildContinuationTemplate({
    goalInstance,
    goalVersion,
    actionSlotId,
    continuationId,
    snapshotHash: expectedSnapshotHash,
    expectedParentSequence: issuedSlot.expectedParentSequence,
    expectedInputWatermark: issuedSlot.expectedInputWatermark,
    decisionCode,
    runPath,
    eventRefs: evidenceRefs,
  });

  // 7. REQUEST_STARTED immediately before network call.
  await ctx.writePhase(PHASES.REQUEST_STARTED, {
    actionSlotId,
    continuationId,
    expectedSnapshotHash,
    goalInstance,
  });

  // 8. Send. continuationId is the SDK clientMessageId.
  const response = await send({
    goalInstance,
    clientMessageId: continuationId,
    prompt,
  });

  if (injectCrash?.at === 'during-send' || injectCrash?.at === 'after-send') {
    throw new InjectedCrashError(injectCrash.at);
  }

  // 9. Validate response schema before CONFIRMED.
  validateResponseSchema(response);

  // 10. CONFIRMED after validated response.
  await ctx.writePhase(PHASES.CONFIRMED, {
    actionSlotId,
    continuationId,
    turnId: response.turnId,
    sequence: response.sequence,
    goalInstance,
  });

  return { success: true, turnId: response.turnId };
}

async function reconcileStartedSlot({ ctx, actionSlotId, continuationId, reconcileByClientMessageId }) {
  if (!reconcileByClientMessageId) {
    return {
      error: 'BLOCKED_AMBIGUOUS_SEND',
      reason: 'Request already started but outcome uncertain and no reconciliation available. Server does not dedupe clientMessageId. Blocking to prevent duplicate parent Turns.',
    };
  }

  const reconciliation = await reconcileByClientMessageId(continuationId);

  if (!reconciliation || typeof reconciliation !== 'object') {
    return {
      error: 'BLOCKED_AMBIGUOUS_SEND',
      reason: 'Reconciliation returned invalid result.',
    };
  }

  if (reconciliation.found === true) {
    if (!reconciliation.turnId || typeof reconciliation.turnId !== 'string') {
      return {
        error: 'BLOCKED_AMBIGUOUS_SEND',
        reason: 'Reconciliation found=true but turnId is missing or invalid.',
      };
    }

    // Bind the existing real Turn; never resend.
    await ctx.writePhase(PHASES.CONFIRMED, {
      actionSlotId,
      continuationId,
      turnId: reconciliation.turnId,
      reconciled: true,
    });
    return { success: true, turnId: reconciliation.turnId, reconciled: true };
  }

  if (reconciliation.found === false) {
    // Cannot prove whether request reached server → block.
    const slotEntries = ctx.ledger.filter(e => e.actionSlotId === actionSlotId);
    const alreadyAmbiguous = slotEntries.some(e => e.phase === PHASES.AMBIGUOUS);

    if (!alreadyAmbiguous) {
      await ctx.writePhase(PHASES.AMBIGUOUS, {
        actionSlotId,
        continuationId,
        reason: 'REQUEST_STARTED with no receipt; reconciliation found no Turn with this clientMessageId.',
      });
    }

    return {
      error: 'BLOCKED_AMBIGUOUS_SEND',
      reason: 'Request was started but outcome uncertain: no Turn found by clientMessageId and server does not dedupe. Blocking to prevent duplicate parent Turn.',
    };
  }

  // Multiple or malformed reconciliation result
  return {
    error: 'BLOCKED_AMBIGUOUS_SEND',
    reason: 'Reconciliation returned malformed result (found not true/false).',
  };
}

const RECOVER_KEYS = [
  'ctx',
  'goalInstance',
  'freshInspect',
  'reconcileByClientMessageId',
  'cohubSend',
];

/**
 * Recover a crashed submit from the persisted ledger with strict validation.
 *
 * - PREPARED with matching snapshot → safe first send.
 * - REQUEST_STARTED without CONFIRMED → reconcile by clientMessageId; found exactly one → bind Turn; not found / multiple → AMBIGUOUS + BLOCKED.
 * - Stale PREPARED → persist CANCELLED_STALE_BEFORE_SEND before returning.
 */
export async function recoverSubmit(params) {
  assertExactOwnKeys(params, RECOVER_KEYS, 'recoverSubmit params');
  const { ctx, goalInstance, freshInspect, reconcileByClientMessageId, cohubSend } = params;

  const slotIds = [...new Set(ctx.ledger.map(e => e.actionSlotId))];

  for (let i = slotIds.length - 1; i >= 0; i--) {
    const actionSlotId = slotIds[i];
    const entries = ctx.ledger.filter(e => e.actionSlotId === actionSlotId);
    validateSlotHistory(entries);

    const phases = new Set(entries.map(e => e.phase));

    if (phases.has(PHASES.CONFIRMED) || phases.has(PHASES.CANCELLED_STALE_BEFORE_SEND)) {
      continue;
    }

    const observedEntry = entries.find(e => e.phase === PHASES.OBSERVED);
    const preparedEntry = entries.find(e => e.phase === PHASES.PREPARED);
    const continuationId = entries.find(e => e.continuationId)?.continuationId;

    if (phases.has(PHASES.REQUEST_STARTED) || phases.has(PHASES.AMBIGUOUS)) {
      return reconcileStartedSlot({ ctx, actionSlotId, continuationId, reconcileByClientMessageId });
    }

    if (preparedEntry) {
      const fresh = await freshInspect();

      if (fresh.snapshotHash !== preparedEntry.expectedSnapshotHash) {
        await ctx.writePhase(PHASES.CANCELLED_STALE_BEFORE_SEND, {
          actionSlotId,
          continuationId,
          evidence: `Snapshot changed from ${preparedEntry.expectedSnapshotHash} to ${fresh.snapshotHash} while PREPARED.`,
        });
        return {
          error: 'CANCELLED_STALE_BEFORE_SEND',
          reason: 'Snapshot changed while PREPARED; slot cancelled with evidence.',
        };
      }

      if (Array.isArray(fresh.unconsumedEvents) && fresh.unconsumedEvents.length > 0) {
        return {
          error: 'UNCONSUMED_EXTERNAL_INPUT',
          reason: 'Unconsumed input arrived before recovery send.',
          unconsumedEvents: fresh.unconsumedEvents,
        };
      }

      const prompt = buildContinuationTemplate({
        goalInstance,
        actionSlotId,
        continuationId,
        snapshotHash: preparedEntry.expectedSnapshotHash,
        expectedParentSequence: preparedEntry.expectedParentSequence,
        expectedInputWatermark: preparedEntry.expectedInputWatermark,
        decisionCode: preparedEntry.decisionCode,
        eventRefs: preparedEntry.evidenceRefs || [],
      });

      await ctx.writePhase(PHASES.REQUEST_STARTED, {
        actionSlotId,
        continuationId,
        expectedSnapshotHash: preparedEntry.expectedSnapshotHash,
        goalInstance,
      });

      const response = await cohubSend({
        goalInstance,
        clientMessageId: continuationId,
        prompt,
      });

      validateResponseSchema(response);

      await ctx.writePhase(PHASES.CONFIRMED, {
        actionSlotId,
        continuationId,
        turnId: response.turnId,
        sequence: response.sequence,
        goalInstance,
      });

      return { success: true, turnId: response.turnId };
    }
  }

  return { success: true, nothingToRecover: true };
}
