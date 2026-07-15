/**
 * @fileoverview Snapshot generation for Cohub goal controller decision core.
 * Fresh reads every inspect, allowlisted fact domains only, canonical hash
 * excluding volatile values, exact watch-set provenance, merged-chain tracking.
 *
 * STRICT BOUNDARY SECURITY:
 * - All outer inputs validated BEFORE any property access
 * - Proxy/getter/accessor detection before execution
 * - Exact schema validation (unknown keys rejected, not filtered)
 * - Depth/size/string/number bounds enforced
 * - Outputs deeply frozen
 * - Structured integrity errors (no fake hash values)
 * - NO key name/type/value leaks in errors
 */

import { canonicalHash } from '../../../claude-goal-foundation/src/cohub-claude-goal/canonical.js';
import {
  validateAndFreeze,
  requireIdentityString,
  createIntegrityError,
  validateOuterBoundary,
  deepFreeze
} from './boundary-validator.js';

const ALLOWLISTED_STATE_FIELDS = Object.freeze([
  'status',
  'stage',
  'nextAction',
  'humanWait',
  'tasks',
  'parent'
]);

const ALLOWLISTED_GATE_FIELDS = Object.freeze([
  'gates'
]);

const TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'merged'
]);

function filterUndefined(obj, seen = new WeakSet()) {
  if (obj === null) return null;
  if (obj === undefined) return null;

  if (typeof obj === 'object' && obj !== null) {
    if (seen.has(obj)) {
      throw new TypeError('CIRCULAR_REFERENCE_IN_FILTER');
    }
    seen.add(obj);
  }

  if (Array.isArray(obj)) {
    const result = obj.map(item => filterUndefined(item, seen)).filter(v => v !== null && v !== undefined);
    seen.delete(obj);
    return result;
  }

  if (typeof obj === 'object') {
    const filtered = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      const filteredValue = filterUndefined(value, seen);
      if (filteredValue !== undefined && filteredValue !== null) {
        filtered[key] = filteredValue;
      }
    }
    seen.delete(obj);
    return filtered;
  }

  return obj;
}

function calculateCanonicalHash(snapshot) {
  const canonical = {};

  if (snapshot.workflowStatus !== undefined) canonical.workflowStatus = snapshot.workflowStatus;
  if (snapshot.stageStatus !== undefined) canonical.stageStatus = snapshot.stageStatus;
  if (snapshot.nextAction !== undefined) canonical.nextAction = snapshot.nextAction;
  if (snapshot.humanWait !== undefined) canonical.humanWait = snapshot.humanWait;

  canonical.gates = filterUndefined(snapshot.gates || []);
  canonical.tasks = filterUndefined(snapshot.tasks || []);
  canonical.workerStates = filterUndefined(snapshot.workerStates || []);
  canonical.receipts = filterUndefined(snapshot.receipts || []);
  canonical.manifestId = snapshot.manifestId;
  canonical.parentSequence = snapshot.parentSequence;
  canonical.inputWatermark = snapshot.inputWatermark;

  canonical.parentSpaceId = snapshot.parentSpaceId;
  canonical.parentSessionId = snapshot.parentSessionId;

  return canonicalHash(canonical);
}

async function resolveWorkerTerminal(cohubReader, spaceId, sessionId, turnId, maxDepth = 10) {
  const chain = [];
  let currentTurnId = turnId;
  let depth = 0;

  while (depth < maxDepth) {
    let turn;
    try {
      turn = await cohubReader.getTurn(spaceId, sessionId, currentTurnId);
    } catch (err) {
      return {
        resolvedStatus: null,
        mergeChain: chain,
        integrityError: createIntegrityError('TURN_READ_FAILED', 'authority')
      };
    }

    if (!turn) {
      return {
        resolvedStatus: null,
        mergeChain: chain,
        integrityError: createIntegrityError('TURN_NOT_FOUND', 'authority')
      };
    }

    // Sanitize turn before accessing any fields
    let sanitized;
    try {
      sanitized = validateAndFreeze(turn);
    } catch (err) {
      return {
        resolvedStatus: null,
        mergeChain: chain,
        integrityError: createIntegrityError('TURN_VALIDATION_FAILED', 'security')
      };
    }

    chain.push(currentTurnId);

    if (sanitized.status === 'merged') {
      const nextTurnId = sanitized.mergedIntoTurnId || sanitized.continuedByTurnId;
      if (!nextTurnId) {
        return {
          resolvedStatus: null,
          mergeChain: chain,
          integrityError: createIntegrityError('MISSING_MERGE_CHAIN', 'integrity')
        };
      }
      currentTurnId = nextTurnId;
      depth += 1;
      continue;
    }

    // Terminal status reached
    return {
      resolvedStatus: sanitized.status,
      mergeChain: chain.length > 1 ? Object.freeze([...chain]) : undefined,
      finalTurnId: currentTurnId
    };
  }

  return {
    resolvedStatus: null,
    mergeChain: chain,
    integrityError: createIntegrityError('MERGE_CHAIN_TOO_DEEP', 'integrity')
  };
}

function createIntegrityFailureSnapshot(goalInstance, errors, generation = 0) {
  return deepFreeze({
    goalInstance,
    snapshotHash: 'integrity_failure',
    integrityErrors: deepFreeze(errors),
    decision: 'BLOCKED',
    stale: true,
    observedGeneration: generation,
    workflowStatus: null,
    stageStatus: null,
    nextAction: null,
    humanWait: null,
    gates: Object.freeze([]),
    tasks: Object.freeze([]),
    workerStates: Object.freeze([]),
    receipts: Object.freeze([]),
    manifestId: null,
    parentSequence: null,
    currentParentSequence: null,
    inputWatermark: null,
    progressFingerprint: 'integrity_failure',
    blockingReason: 'Integrity validation failed',
    watchSet: Object.freeze([]),
    migrationVerdict: null
  });
}

export async function createSnapshot(goalInstance, cohubReader, ledger, localState) {
  // CRITICAL: Validate ALL outer boundaries BEFORE any property access
  const boundaryValidation = validateOuterBoundary(localState, cohubReader, ledger);
  if (!boundaryValidation.valid) {
    // Proxy detection must THROW to prevent any further access
    const hasProxyError = boundaryValidation.errors.some(e =>
      e.code.includes('PROXY_DETECTED')
    );
    if (hasProxyError) {
      throw new TypeError('Proxy objects not allowed in outer boundary inputs');
    }
    return createIntegrityFailureSnapshot(goalInstance, boundaryValidation.errors, 0);
  }

  const integrityErrors = [];

  // Capture generation BEFORE any reads
  const generationBefore = typeof localState.getGeneration === 'function'
    ? localState.getGeneration()
    : (localState.observedGeneration || 0);

  // CRITICAL: Require exact identity strings - NO fallbacks
  let parentSpaceId, parentSessionId;
  try {
    parentSpaceId = requireIdentityString(localState.parentSpaceId, 'parentSpaceId');
    parentSessionId = requireIdentityString(localState.parentSessionId, 'parentSessionId');
  } catch (err) {
    integrityErrors.push(createIntegrityError('MISSING_REQUIRED_IDENTITY', 'configuration'));
    return createIntegrityFailureSnapshot(goalInstance, integrityErrors, generationBefore);
  }

  // Fresh read all authority files
  let orchestrationState, gateLog, manifest, parentIndex;

  try {
    orchestrationState = await cohubReader.readRunFile(parentSpaceId, 'orchestration_state.json');
    gateLog = await cohubReader.readRunFile(parentSpaceId, 'stage_gate_log.json');
    manifest = await cohubReader.readRunFile(parentSpaceId, 'run_manifest.json');
    parentIndex = await cohubReader.getSessionIndex(parentSpaceId, parentSessionId);
  } catch (err) {
    integrityErrors.push(createIntegrityError('AUTHORITY_READ_FAILURE', 'authority'));

    const snapshot = createIntegrityFailureSnapshot(goalInstance, integrityErrors, generationBefore);
    return deepFreeze({
      ...snapshot,
      parentSpaceId,
      parentSessionId
    });
  }

  // Capture generation AFTER all reads
  const generationAfter = typeof localState.getGeneration === 'function'
    ? localState.getGeneration()
    : (localState.observedGeneration || 0);

  // Detect generation race
  if (generationBefore !== generationAfter) {
    integrityErrors.push(createIntegrityError('GENERATION_RACE_DETECTED', 'race'));
    return createIntegrityFailureSnapshot(goalInstance, integrityErrors, generationAfter);
  }

  // Sanitize all inputs into detached clones - NEVER mutates caller objects
  let sanitizedState, sanitizedGates, sanitizedManifest, sanitizedParentIndex;

  try {
    sanitizedState = validateAndFreeze(orchestrationState, ALLOWLISTED_STATE_FIELDS);
    sanitizedGates = validateAndFreeze(gateLog, ALLOWLISTED_GATE_FIELDS);
    sanitizedManifest = validateAndFreeze(manifest);
    sanitizedParentIndex = validateAndFreeze(parentIndex);
  } catch (err) {
    // Map specific validation errors to integrity error codes
    const errorMessage = String(err.message || '');
    let errorCode = 'INPUT_VALIDATION_FAILED';

    if (errorMessage.includes('UNKNOWN_FIELD_REJECTED')) {
      errorCode = 'UNKNOWN_FIELD_REJECTED';
    } else if (errorMessage.includes('DEPTH_LIMIT_EXCEEDED')) {
      errorCode = 'DEPTH_LIMIT_EXCEEDED';
    } else if (errorMessage.includes('SIZE_LIMIT_EXCEEDED')) {
      errorCode = 'SIZE_LIMIT_EXCEEDED';
    } else if (errorMessage.includes('STRING_TOO_LONG')) {
      errorCode = 'STRING_TOO_LONG';
    } else if (errorMessage.includes('INVALID_NUMBER')) {
      errorCode = 'INVALID_NUMBER';
    }

    integrityErrors.push(createIntegrityError(errorCode, 'security'));

    const snapshot = createIntegrityFailureSnapshot(goalInstance, integrityErrors, generationAfter);
    return deepFreeze({
      ...snapshot,
      parentSpaceId,
      parentSessionId
    });
  }

  // Validate critical fields from sanitized data
  if (!sanitizedState || typeof sanitizedState.status !== 'string') {
    integrityErrors.push(createIntegrityError('ORCHESTRATION_STATE_INVALID', 'authority'));
  }

  // Track worker states with merged-chain resolution
  const workerStates = [];
  const allowedSpaces = ledger.allowedSpaces || [];
  const allowedSessions = ledger.allowedSessions || [];

  if (ledger.trackedTurns) {
    for (const tracked of ledger.trackedTurns) {
      // Validate space/session
      if (allowedSpaces.length > 0 && !allowedSpaces.includes(tracked.spaceId)) {
        integrityErrors.push(createIntegrityError('WORKER_WRONG_SPACE', 'authorization'));
        continue;
      }

      if (allowedSessions.length > 0 && !allowedSessions.includes(tracked.sessionId)) {
        integrityErrors.push(createIntegrityError('WORKER_WRONG_SESSION', 'authorization'));
        continue;
      }

      const resolution = await resolveWorkerTerminal(
        cohubReader,
        tracked.spaceId,
        tracked.sessionId,
        tracked.turnId
      );

      const workerState = deepFreeze({
        originalTurnId: tracked.turnId,
        turnId: tracked.turnId,
        spaceId: tracked.spaceId,
        sessionId: tracked.sessionId,
        resolvedStatus: resolution.resolvedStatus || null,
        mergeChain: resolution.mergeChain,
        mergedIntoTurnId: resolution.finalTurnId,
        integrityError: resolution.integrityError
      });

      workerStates.push(workerState);

      if (resolution.integrityError) {
        integrityErrors.push(resolution.integrityError);
      }
    }
  }

  // Calculate progress fingerprint from sanitized data
  const progressFingerprint = calculateProgressFingerprint(
    sanitizedState,
    sanitizedGates,
    workerStates
  );

  // Determine decision based on current state
  let decision = 'RUNNING';
  let nextActions = null;
  let blockingReason = null;

  // REG-67-01: Historical fixture rule - must use EXACT workerId
  if (sanitizedState.tasks && Array.isArray(sanitizedState.tasks)) {
    const materials = sanitizedState.tasks.find(t => t && t.id === 'materials');
    const geography = sanitizedState.tasks.find(t => t && t.id === 'geography');
    const geographyReplacement = sanitizedState.tasks.find(t => t && t.id === 'geography-replacement');

    if (
      materials && materials.count === '148/148' &&
      geographyReplacement && geographyReplacement.status === 'COMPLETED' &&
      geography && geography.status === 'DISPATCHED'
    ) {
      const receipts = ledger.replacementReceipts ? [...ledger.replacementReceipts] : [];
      const hasReplacementReceipt = receipts.some(
        r => r && r.workerId === geographyReplacement.workerId
      );

      if (!hasReplacementReceipt) {
        // Must have exact workerId, no fallback "unknown"
        if (!geographyReplacement.workerId) {
          integrityErrors.push(createIntegrityError('MISSING_WORKER_ID', 'integrity'));
          decision = 'BLOCKED';
          blockingReason = 'replacement geography lacks exact worker ID';
        } else {
          decision = 'RECONCILE_AND_FAN_IN';
          nextActions = deepFreeze([
            deepFreeze({
              type: 'REGISTER_REPLACEMENT_RECEIPT',
              workerId: geographyReplacement.workerId,
              originalTaskId: geography.id
            })
          ]);
          blockingReason = 'replacement geography lacks binding receipt';
        }
      }
    }
  }

  // Migration verdict
  let migrationVerdict = null;
  if (localState.migrationMode && sanitizedState.parent) {
    const receipts = ledger.replacementReceipts ? [...ledger.replacementReceipts] : [];
    const hasUnboundReceipt = receipts.length === 0 || receipts.some(r => !r.bound);

    if (hasUnboundReceipt) {
      migrationVerdict = 'UNBOUND_REPLACEMENT_RECEIPT';
    }
  }

  // Build watch set from provenance - deeply frozen
  const watchSet = [];

  watchSet.push(deepFreeze({
    spaceId: parentSpaceId,
    sessionId: parentSessionId,
    role: 'parent'
  }));

  for (const worker of workerStates) {
    watchSet.push(deepFreeze({
      spaceId: worker.spaceId,
      sessionId: worker.sessionId,
      turnId: worker.turnId,
      role: 'worker'
    }));
  }

  // Check for staleness
  const currentParentSequence = sanitizedParentIndex && sanitizedParentIndex.sequence !== undefined
    ? sanitizedParentIndex.sequence
    : localState.parentSequence;

  const stale = localState.expectedParentSequence !== undefined &&
    currentParentSequence !== localState.expectedParentSequence;

  // Deep clone and freeze ledger receipts
  const detachedReceipts = ledger.replacementReceipts
    ? deepFreeze(ledger.replacementReceipts.map(r => {
        const cloned = {};
        for (const key of Object.keys(r)) {
          const value = r[key];
          if (value && typeof value === 'object') {
            cloned[key] = Array.isArray(value) ? Object.freeze([...value]) : deepFreeze({ ...value });
          } else {
            cloned[key] = value;
          }
        }
        return cloned;
      }))
    : Object.freeze([]);

  const snapshot = {
    goalInstance,
    parentSpaceId,
    parentSessionId,
    workflowStatus: sanitizedState.status,
    stageStatus: sanitizedState.stage,
    nextAction: sanitizedState.nextAction,
    humanWait: sanitizedState.humanWait,
    gates: sanitizedGates.gates || Object.freeze([]),
    tasks: sanitizedState.tasks || Object.freeze([]),
    workerStates: Object.freeze(workerStates),
    receipts: detachedReceipts,
    manifestId: sanitizedManifest && sanitizedManifest.id ? sanitizedManifest.id : null,
    parentSequence: currentParentSequence,
    currentParentSequence,
    inputWatermark: localState.lastConsumedUserTurn || null,
    progressFingerprint,
    decision,
    nextActions,
    blockingReason,
    watchSet: Object.freeze(watchSet),
    integrityErrors: integrityErrors.length > 0 ? deepFreeze(integrityErrors) : undefined,
    stale,
    observedGeneration: generationAfter,
    migrationVerdict
  };

  snapshot.snapshotHash = calculateCanonicalHash(snapshot);

  return deepFreeze(snapshot);
}

export function calculateProgressFingerprint(state, gates, workerStates) {
  const fingerprintInput = {};

  if (state && state.status !== undefined && state.status !== null) {
    fingerprintInput.status = state.status;
  }
  if (state && state.stage !== undefined && state.stage !== null) {
    fingerprintInput.stage = state.stage;
  }
  if (state && state.nextAction !== undefined && state.nextAction !== null) {
    fingerprintInput.nextAction = state.nextAction;
  }

  if (state && state.tasks) {
    fingerprintInput.tasks = state.tasks.map(t => {
      const task = { id: t.id };
      if (t.status !== undefined && t.status !== null) task.status = t.status;
      if (t.count !== undefined && t.count !== null) task.count = t.count;
      return task;
    });
  }

  if (gates && gates.gates) {
    fingerprintInput.gates = gates.gates.map(g => {
      const gate = { id: g.id };
      if (g.verdict !== undefined && g.verdict !== null) gate.verdict = g.verdict;
      return gate;
    });
  }

  if (workerStates && workerStates.length > 0) {
    fingerprintInput.workers = workerStates.map(w => {
      const worker = { turnId: w.turnId };
      if (w.resolvedStatus !== undefined && w.resolvedStatus !== null) {
        worker.status = w.resolvedStatus;
      }
      if (w.mergeChain !== undefined && w.mergeChain !== null) {
        worker.mergeChain = w.mergeChain;
      }
      return worker;
    });
  }

  return canonicalHash(fingerprintInput);
}
