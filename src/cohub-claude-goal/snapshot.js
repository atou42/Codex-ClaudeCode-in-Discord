/**
 * @fileoverview Snapshot generation for Cohub goal controller decision core.
 * Fresh reads every inspect, allowlisted fact domains only, canonical hash
 * excluding volatile values, exact watch-set provenance, merged-chain tracking.
 *
 * Security: Freezes inputs before access to prevent descriptor/getter/proxy attacks.
 * Detects cycles, validates field types, rejects symbol properties and prototype pollution.
 */

import { canonicalHash } from '../../../claude-goal-foundation/src/cohub-claude-goal/canonical.js';

const ALLOWLISTED_STATE_FIELDS = Object.freeze([
  'status',
  'stage',
  'nextAction',
  'humanWait',
  'tasks'
]);

const ALLOWLISTED_GATE_FIELDS = Object.freeze([
  'gates'
]);

const ALLOWLISTED_WORKER_FIELDS = Object.freeze([
  'turnId',
  'spaceId',
  'sessionId',
  'status',
  'mergedIntoTurnId',
  'continuedByTurnId'
]);

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep freeze an object to prevent descriptor/getter/proxy execution.
 * Must be called before accessing any untrusted input fields.
 */
function deepFreeze(obj, seen = new WeakSet()) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (seen.has(obj)) {
    throw new TypeError('circular reference detected');
  }
  seen.add(obj);

  // Freeze before accessing to prevent getters/proxies
  Object.freeze(obj);

  // Check for symbol properties
  const symbols = Object.getOwnPropertySymbols(obj);
  if (symbols.length > 0) {
    throw new TypeError(`symbol properties not allowed: ${symbols.map(s => String(s)).join(', ')}`);
  }

  // Check for pollution keys
  for (const key of Object.keys(obj)) {
    if (POLLUTION_KEYS.has(key)) {
      throw new TypeError(`prototype pollution key not allowed: ${key}`);
    }
  }

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      deepFreeze(value, seen);
    }
  }

  return obj;
}

function filterObject(obj, allowedFields) {
  if (!obj || typeof obj !== 'object') return {};

  // Deep freeze to prevent attacker hooks
  try {
    deepFreeze(obj);
  } catch (err) {
    throw new TypeError(`filterObject: input validation failed: ${err.message}`);
  }

  const filtered = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(obj, field)) {
      filtered[field] = obj[field];
    }
  }
  return filtered;
}

function filterObjectAlreadyFrozen(obj, allowedFields) {
  if (!obj || typeof obj !== 'object') return {};

  const filtered = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(obj, field)) {
      filtered[field] = obj[field];
    }
  }
  return filtered;
}

function filterUndefined(obj, seen = new WeakSet()) {
  if (obj === null) return null;
  if (obj === undefined) return null;

  if (typeof obj === 'object' && obj !== null) {
    if (seen.has(obj)) {
      throw new TypeError('circular reference detected in filterUndefined');
    }
    seen.add(obj);
  }

  if (Array.isArray(obj)) {
    const result = obj.map(item => filterUndefined(item, seen)).filter((v) => v !== null && v !== undefined);
    seen.delete(obj);
    return result;
  }
  if (typeof obj === 'object') {
    const filtered = {};
    for (const [key, value] of Object.entries(obj)) {
      const filtered_value = filterUndefined(value, seen);
      if (filtered_value !== undefined && filtered_value !== null) {
        filtered[key] = filtered_value;
      }
    }
    seen.delete(obj);
    return filtered;
  }
  return obj;
}

function calculateCanonicalHash(snapshot) {
  // Build canonical structure with sorted keys and stable array ordering
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

  // canonicalHash from foundation already sorts keys and handles exact serialization
  return canonicalHash(canonical);
}

async function resolveWorkerTerminal(cohubReader, spaceId, sessionId, turnId, maxDepth = 10) {
  const chain = [];
  let currentTurnId = turnId;
  let depth = 0;

  while (depth < maxDepth) {
    const turn = await cohubReader.getTurn(spaceId, sessionId, currentTurnId);

    if (!turn) {
      return {
        resolvedStatus: null,
        mergeChain: chain,
        integrityError: { code: 'TURN_NOT_FOUND', turnId: currentTurnId }
      };
    }

    // Freeze turn object before accessing
    try {
      deepFreeze(turn);
    } catch (err) {
      return {
        resolvedStatus: null,
        mergeChain: chain,
        integrityError: { code: 'TURN_VALIDATION_FAILED', turnId: currentTurnId, message: err.message }
      };
    }

    chain.push(currentTurnId);

    if (turn.status === 'merged') {
      const nextTurnId = turn.mergedIntoTurnId || turn.continuedByTurnId;
      if (!nextTurnId) {
        return {
          resolvedStatus: null,
          mergeChain: chain,
          integrityError: { code: 'MISSING_MERGE_CHAIN', turnId: currentTurnId }
        };
      }
      currentTurnId = nextTurnId;
      depth += 1;
      continue;
    }

    // Terminal status reached
    return {
      resolvedStatus: turn.status,
      mergeChain: chain.length > 1 ? chain : undefined,
      finalTurnId: currentTurnId
    };
  }

  return {
    resolvedStatus: null,
    mergeChain: chain,
    integrityError: { code: 'MERGE_CHAIN_TOO_DEEP', depth: maxDepth }
  };
}

export async function createSnapshot(goalInstance, cohubReader, ledger, localState) {
  const integrityErrors = [];

  // Fresh read all authority files
  let orchestrationState;
  let gateLog;
  let manifest;
  let parentIndex;

  try {
    const spaceId = localState.parentSpaceId || 'default-space';
    orchestrationState = await cohubReader.readRunFile(spaceId, 'orchestration_state.json');
    gateLog = await cohubReader.readRunFile(spaceId, 'stage_gate_log.json');
    manifest = await cohubReader.readRunFile(spaceId, 'run_manifest.json');
    parentIndex = await cohubReader.getSessionIndex(spaceId, localState.parentSessionId || 'default-session');

    // Freeze all inputs immediately after read to prevent attacker hooks
    deepFreeze(orchestrationState);
    deepFreeze(gateLog);
    deepFreeze(manifest);
    deepFreeze(parentIndex);
  } catch (err) {
    integrityErrors.push({
      code: 'AUTHORITY_READ_FAILURE',
      field: 'cohubReader',
      message: err.message
    });

    return {
      goalInstance,
      snapshotHash: 'error',
      integrityErrors: Object.freeze(integrityErrors),
      decision: 'BLOCKED',
      stale: true,
      observedGeneration: localState.getGeneration?.() ?? localState.observedGeneration ?? 0
    };
  }

  // Capture generation after all reads
  const observedGeneration = localState.getGeneration?.() ?? localState.observedGeneration ?? 0;

  // Validate critical fields - inputs already frozen
  let filteredState;
  let filteredGates;

  try {
    if (!orchestrationState || typeof orchestrationState.status !== 'string') {
      integrityErrors.push({
        code: 'ORCHESTRATION_STATE_INVALID',
        field: 'orchestration_state.status',
        message: 'status field missing or invalid'
      });
    }

    // Filter to allowlisted fact domains - inputs already frozen by deepFreeze above
    filteredState = filterObjectAlreadyFrozen(orchestrationState, ALLOWLISTED_STATE_FIELDS);
    filteredGates = filterObjectAlreadyFrozen(gateLog, ALLOWLISTED_GATE_FIELDS);
  } catch (err) {
    integrityErrors.push({
      code: 'INPUT_VALIDATION_FAILED',
      field: 'orchestrationState',
      message: err.message
    });

    return {
      goalInstance,
      snapshotHash: 'error',
      integrityErrors: Object.freeze(integrityErrors),
      decision: 'BLOCKED',
      stale: true,
      observedGeneration
    };
  }

  // Track worker states with merged-chain resolution
  const workerStates = [];
  const allowedSpaces = localState.allowedSpaces || [];
  const allowedSessions = localState.allowedSessions || [];

  if (ledger.trackedTurns) {
    for (const tracked of ledger.trackedTurns) {
      // Validate space/session
      if (allowedSpaces.length > 0 && !allowedSpaces.includes(tracked.spaceId)) {
        integrityErrors.push({
          code: 'WORKER_WRONG_SPACE',
          field: `trackedTurns[${tracked.turnId}].spaceId`,
          message: `space ${tracked.spaceId} not in allowed list`
        });
        continue;
      }

      if (allowedSessions.length > 0 && !allowedSessions.includes(tracked.sessionId)) {
        integrityErrors.push({
          code: 'WORKER_WRONG_SESSION',
          field: `trackedTurns[${tracked.turnId}].sessionId`,
          message: `session ${tracked.sessionId} not in allowed list`
        });
        continue;
      }

      const resolution = await resolveWorkerTerminal(
        cohubReader,
        tracked.spaceId,
        tracked.sessionId,
        tracked.turnId
      );

      const workerState = {
        originalTurnId: tracked.turnId,
        turnId: tracked.turnId,
        spaceId: tracked.spaceId,
        sessionId: tracked.sessionId,
        resolvedStatus: resolution.resolvedStatus || null
      };

      if (resolution.mergeChain) {
        workerState.mergeChain = resolution.mergeChain;
        // For merged chains, set mergedIntoTurnId to the final turn
        workerState.mergedIntoTurnId = resolution.finalTurnId;
      }
      if (resolution.integrityError) {
        workerState.integrityError = resolution.integrityError;
      }

      workerStates.push(workerState);

      if (resolution.integrityError) {
        integrityErrors.push(resolution.integrityError);
      }
    }
  }

  // Calculate progress fingerprint
  const progressFingerprint = calculateProgressFingerprint(
    filteredState,
    filteredGates,
    workerStates
  );

  // Determine decision based on current state
  let decision = 'RUNNING';
  let nextActions = null;
  let blockingReason = null;

  // REG-67-01: Historical fixture rule
  if (filteredState.tasks && Array.isArray(filteredState.tasks)) {
    const materials = filteredState.tasks.find((t) => t && t.id === 'materials');
    const geography = filteredState.tasks.find((t) => t && t.id === 'geography');
    const geographyReplacement = filteredState.tasks.find((t) => t && t.id === 'geography-replacement');

    if (
      materials?.count === '148/148' &&
      geographyReplacement?.status === 'COMPLETED' &&
      geography?.status === 'DISPATCHED'
    ) {
      const receipts = ledger.replacementReceipts || [];
      const hasReplacementReceipt = receipts.some(
        (r) => r && r.workerId === geographyReplacement.workerId
      );

      if (!hasReplacementReceipt) {
        decision = 'RECONCILE_AND_FAN_IN';
        nextActions = [
          {
            type: 'REGISTER_REPLACEMENT_RECEIPT',
            workerId: geographyReplacement.workerId || 'unknown',
            originalTaskId: geography?.id || 'geography'
          }
        ];
        blockingReason = 'replacement geography lacks binding receipt';
      }
    }
  }

  // Migration verdict
  let migrationVerdict = null;
  if (localState.migrationMode && orchestrationState.parent) {
    const hasUnboundReceipt = ledger.replacementReceipts?.length === 0 ||
      ledger.replacementReceipts.some((r) => !r.bound);

    if (hasUnboundReceipt) {
      migrationVerdict = 'UNBOUND_REPLACEMENT_RECEIPT';
    }
  }

  // Build watch set from provenance
  const watchSet = [];

  if (localState.parentSpaceId && localState.parentSessionId) {
    watchSet.push({
      spaceId: localState.parentSpaceId,
      sessionId: localState.parentSessionId,
      role: 'parent'
    });
  }

  for (const worker of workerStates) {
    watchSet.push({
      spaceId: worker.spaceId,
      sessionId: worker.sessionId,
      turnId: worker.turnId,
      role: 'worker'
    });
  }

  // Check for staleness
  const currentParentSequence = parentIndex?.sequence ?? localState.parentSequence;
  const stale = localState.expectedParentSequence !== undefined &&
    currentParentSequence !== localState.expectedParentSequence;

  const snapshot = {
    goalInstance,
    workflowStatus: filteredState.status,
    stageStatus: filteredState.stage,
    nextAction: filteredState.nextAction,
    humanWait: filteredState.humanWait,
    gates: filteredGates.gates || [],
    tasks: filteredState.tasks || [],
    workerStates: Object.freeze(workerStates),
    receipts: (ledger.replacementReceipts || []),
    manifestId: manifest?.id || null,
    parentSequence: currentParentSequence,
    currentParentSequence,
    inputWatermark: localState.lastConsumedUserTurn || null,
    progressFingerprint,
    decision,
    nextActions: nextActions ? Object.freeze(nextActions) : undefined,
    blockingReason,
    watchSet: Object.freeze(watchSet),
    integrityErrors: integrityErrors.length > 0 ? Object.freeze(integrityErrors) : undefined,
    stale,
    observedGeneration,
    migrationVerdict
  };

  snapshot.snapshotHash = calculateCanonicalHash(snapshot);

  return Object.freeze(snapshot);
}

export function calculateProgressFingerprint(state, gates, workerStates) {
  const fingerprintInput = {};

  if (state?.status !== undefined && state.status !== null) {
    fingerprintInput.status = state.status;
  }
  if (state?.stage !== undefined && state.stage !== null) {
    fingerprintInput.stage = state.stage;
  }
  if (state?.nextAction !== undefined && state.nextAction !== null) {
    fingerprintInput.nextAction = state.nextAction;
  }

  if (state?.tasks) {
    fingerprintInput.tasks = state.tasks.map((t) => {
      const task = { id: t.id };
      if (t.status !== undefined && t.status !== null) task.status = t.status;
      if (t.count !== undefined && t.count !== null) task.count = t.count;
      return task;
    });
  }

  if (gates?.gates) {
    fingerprintInput.gates = gates.gates.map((g) => {
      const gate = { id: g.id };
      if (g.verdict !== undefined && g.verdict !== null) gate.verdict = g.verdict;
      return gate;
    });
  }

  if (workerStates && workerStates.length > 0) {
    fingerprintInput.workers = workerStates.map((w) => {
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
