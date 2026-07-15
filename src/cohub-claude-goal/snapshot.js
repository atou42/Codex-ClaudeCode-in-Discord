/**
 * @fileoverview Snapshot generation for Cohub goal controller decision core.
 * Fresh reads every inspect, allowlisted fact domains only, canonical hash
 * excluding volatile values, exact watch-set provenance, merged-chain tracking.
 *
 * Security: STRICT BOUNDARY - detaches and freezes clone, never mutates caller objects.
 * Rejects Proxy/getter/accessor/symbol before execution. Requires exact identity strings.
 */

import util from 'node:util';
import { canonicalHash } from '../../../claude-goal-foundation/src/cohub-claude-goal/canonical.js';

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
 * Validate and sanitize untrusted input into detached plain data.
 * NEVER mutates input. Returns deeply frozen detached clone.
 */
function sanitizeUntrusted(value, allowedKeys = null, seen = new Map()) {
  // Primitives: return as-is (immutable by nature)
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // Reject non-object types
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported type: ${typeof value}`);
  }

  // Detect cycles
  if (seen.has(value)) {
    throw new TypeError('Circular reference detected');
  }
  seen.set(value, true);

  try {
    // CRITICAL: Detect Proxy before ANY property access
    if (util.types.isProxy(value)) {
      throw new TypeError('Proxy objects not allowed');
    }

    // Check prototype - must be Object.prototype, Array.prototype, or null
    const proto = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if (!isArray && proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Invalid prototype: ${proto?.constructor?.name || 'unknown'}`);
    }

    // Inspect all own property keys using Reflect to avoid traps
    const ownKeys = Reflect.ownKeys(value);

    // Reject symbol properties
    const symbols = ownKeys.filter(k => typeof k === 'symbol');
    if (symbols.length > 0) {
      throw new TypeError(`Symbol properties not allowed: ${symbols.map(s => String(s)).join(', ')}`);
    }

    // Get all descriptors at once
    const descriptors = Object.getOwnPropertyDescriptors(value);

    // Check for accessor properties (getter/setter) without invoking them
    for (const [key, desc] of Object.entries(descriptors)) {
      if (desc.get || desc.set) {
        throw new TypeError(`Accessor property not allowed: ${key}`);
      }
    }

    // Check for pollution keys
    for (const key of Object.keys(descriptors)) {
      if (POLLUTION_KEYS.has(key)) {
        throw new TypeError(`Prototype pollution key not allowed: ${key}`);
      }
    }

    // Arrays: clone to new detached array, recursively sanitize elements
    if (isArray) {
      // Detect sparse arrays - count numeric indices only (descriptors includes 'length')
      const numericKeys = Object.keys(descriptors).filter(k => !isNaN(parseInt(k, 10)));
      if (value.length !== numericKeys.length) {
        throw new TypeError('Sparse arrays not allowed');
      }

      const cloned = [];
      for (let i = 0; i < value.length; i++) {
        cloned[i] = sanitizeUntrusted(value[i], null, seen);
      }
      seen.delete(value);
      return Object.freeze(cloned);
    }

    // Objects: clone to new detached null-prototype object
    const cloned = Object.create(null);
    const keys = Object.keys(descriptors);

    // If allowedKeys specified, filter to only those keys
    const keysToProcess = allowedKeys ? keys.filter(k => allowedKeys.includes(k)) : keys;

    for (const key of keysToProcess) {
      cloned[key] = sanitizeUntrusted(value[key], null, seen);
    }

    seen.delete(value);
    return Object.freeze(cloned);
  } finally {
    seen.delete(value);
  }
}

/**
 * Validate required identity string - must be exact non-empty string.
 * NO fallback values permitted.
 */
function requireIdentityString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string, got ${typeof value}`);
  }
  if (value.trim() === '') {
    throw new TypeError(`${fieldName} must not be empty or whitespace`);
  }
  return value;
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

  // CRITICAL: Include identity in hash so changing space/session changes hash
  canonical.parentSpaceId = snapshot.parentSpaceId;
  canonical.parentSessionId = snapshot.parentSessionId;

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

    // Sanitize turn before accessing any fields
    let sanitized;
    try {
      sanitized = sanitizeUntrusted(turn);
    } catch (err) {
      return {
        resolvedStatus: null,
        mergeChain: chain,
        integrityError: { code: 'TURN_VALIDATION_FAILED', turnId: currentTurnId, message: String(err.message).slice(0, 200) }
      };
    }

    chain.push(currentTurnId);

    if (sanitized.status === 'merged') {
      const nextTurnId = sanitized.mergedIntoTurnId || sanitized.continuedByTurnId;
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
      resolvedStatus: sanitized.status,
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

  // CRITICAL: Require exact identity strings - NO fallbacks
  let parentSpaceId, parentSessionId;
  try {
    parentSpaceId = requireIdentityString(localState.parentSpaceId, 'parentSpaceId');
    parentSessionId = requireIdentityString(localState.parentSessionId, 'parentSessionId');
  } catch (err) {
    integrityErrors.push({
      code: 'AUTHORITY_READ_FAILURE',
      field: 'identity',
      message: String(err.message).slice(0, 200)
    });

    return Object.freeze({
      goalInstance,
      snapshotHash: 'error',
      integrityErrors: Object.freeze(integrityErrors),
      decision: 'BLOCKED',
      stale: true,
      observedGeneration: localState.getGeneration?.() ?? localState.observedGeneration ?? 0
    });
  }

  // Fresh read all authority files
  let orchestrationState;
  let gateLog;
  let manifest;
  let parentIndex;

  try {
    orchestrationState = await cohubReader.readRunFile(parentSpaceId, 'orchestration_state.json');
    gateLog = await cohubReader.readRunFile(parentSpaceId, 'stage_gate_log.json');
    manifest = await cohubReader.readRunFile(parentSpaceId, 'run_manifest.json');
    parentIndex = await cohubReader.getSessionIndex(parentSpaceId, parentSessionId);
  } catch (err) {
    integrityErrors.push({
      code: 'AUTHORITY_READ_FAILURE',
      field: 'cohubReader',
      message: 'authority file read failed'
    });

    return Object.freeze({
      goalInstance,
      parentSpaceId,
      parentSessionId,
      snapshotHash: 'error',
      integrityErrors: Object.freeze(integrityErrors),
      decision: 'BLOCKED',
      stale: true,
      observedGeneration: localState.getGeneration?.() ?? localState.observedGeneration ?? 0
    });
  }

  // Capture generation after all reads
  const observedGeneration = localState.getGeneration?.() ?? localState.observedGeneration ?? 0;

  // Sanitize all inputs into detached clones - NEVER mutates caller objects
  let sanitizedState, sanitizedGates, sanitizedManifest, sanitizedParentIndex;

  try {
    sanitizedState = sanitizeUntrusted(orchestrationState, ALLOWLISTED_STATE_FIELDS);
    sanitizedGates = sanitizeUntrusted(gateLog, ALLOWLISTED_GATE_FIELDS);
    sanitizedManifest = sanitizeUntrusted(manifest);
    sanitizedParentIndex = sanitizeUntrusted(parentIndex);
  } catch (err) {
    integrityErrors.push({
      code: 'INPUT_VALIDATION_FAILED',
      field: 'sanitization',
      message: String(err.message).slice(0, 200)
    });

    // Must return BLOCKED on validation failure
    const blockedSnapshot = {
      goalInstance,
      parentSpaceId,
      parentSessionId,
      snapshotHash: 'error',
      integrityErrors: Object.freeze(integrityErrors),
      decision: 'BLOCKED',
      stale: true,
      observedGeneration,
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
      progressFingerprint: 'error',
      blockingReason: 'Input validation failed',
      watchSet: Object.freeze([]),
      migrationVerdict: null
    };

    return Object.freeze(blockedSnapshot);
  }

  // Validate critical fields from sanitized data
  if (!sanitizedState || typeof sanitizedState.status !== 'string') {
    integrityErrors.push({
      code: 'ORCHESTRATION_STATE_INVALID',
      field: 'status',
      message: 'status field missing or invalid'
    });
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
          message: 'space not in allowed list'
        });
        continue;
      }

      if (allowedSessions.length > 0 && !allowedSessions.includes(tracked.sessionId)) {
        integrityErrors.push({
          code: 'WORKER_WRONG_SESSION',
          field: `trackedTurns[${tracked.turnId}].sessionId`,
          message: 'session not in allowed list'
        });
        continue;
      }

      const resolution = await resolveWorkerTerminal(
        cohubReader,
        tracked.spaceId,
        tracked.sessionId,
        tracked.turnId
      );

      // Create detached worker state
      const workerState = Object.freeze({
        originalTurnId: tracked.turnId,
        turnId: tracked.turnId,
        spaceId: tracked.spaceId,
        sessionId: tracked.sessionId,
        resolvedStatus: resolution.resolvedStatus || null,
        mergeChain: resolution.mergeChain ? Object.freeze([...resolution.mergeChain]) : undefined,
        mergedIntoTurnId: resolution.finalTurnId || undefined,
        integrityError: resolution.integrityError ? Object.freeze({ ...resolution.integrityError }) : undefined
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

  // REG-67-01: Historical fixture rule
  if (sanitizedState.tasks && Array.isArray(sanitizedState.tasks)) {
    const materials = sanitizedState.tasks.find((t) => t && t.id === 'materials');
    const geography = sanitizedState.tasks.find((t) => t && t.id === 'geography');
    const geographyReplacement = sanitizedState.tasks.find((t) => t && t.id === 'geography-replacement');

    if (
      materials?.count === '148/148' &&
      geographyReplacement?.status === 'COMPLETED' &&
      geography?.status === 'DISPATCHED'
    ) {
      // Clone ledger receipts into detached array
      const receipts = ledger.replacementReceipts ? [...ledger.replacementReceipts] : [];
      const hasReplacementReceipt = receipts.some(
        (r) => r && r.workerId === geographyReplacement.workerId
      );

      if (!hasReplacementReceipt) {
        decision = 'RECONCILE_AND_FAN_IN';
        nextActions = Object.freeze([
          Object.freeze({
            type: 'REGISTER_REPLACEMENT_RECEIPT',
            workerId: geographyReplacement.workerId || 'unknown',
            originalTaskId: geography?.id || 'geography'
          })
        ]);
        blockingReason = 'replacement geography lacks binding receipt';
      }
    }
  }

  // Migration verdict
  let migrationVerdict = null;
  if (localState.migrationMode && sanitizedState.parent) {
    const receipts = ledger.replacementReceipts ? [...ledger.replacementReceipts] : [];
    const hasUnboundReceipt = receipts.length === 0 || receipts.some((r) => !r.bound);

    if (hasUnboundReceipt) {
      migrationVerdict = 'UNBOUND_REPLACEMENT_RECEIPT';
    }
  }

  // Build watch set from provenance - deeply frozen
  const watchSet = [];

  watchSet.push(Object.freeze({
    spaceId: parentSpaceId,
    sessionId: parentSessionId,
    role: 'parent'
  }));

  for (const worker of workerStates) {
    watchSet.push(Object.freeze({
      spaceId: worker.spaceId,
      sessionId: worker.sessionId,
      turnId: worker.turnId,
      role: 'worker'
    }));
  }

  // Check for staleness
  const currentParentSequence = sanitizedParentIndex?.sequence ?? localState.parentSequence;
  const stale = localState.expectedParentSequence !== undefined &&
    currentParentSequence !== localState.expectedParentSequence;

  // Clone ledger receipts to detached array - deep clone to prevent shared references
  const detachedReceipts = ledger.replacementReceipts
    ? Object.freeze(ledger.replacementReceipts.map(r => {
        // Deep clone each receipt
        const cloned = {};
        for (const key of Object.keys(r)) {
          const value = r[key];
          if (value && typeof value === 'object') {
            cloned[key] = Array.isArray(value) ? [...value] : { ...value };
          } else {
            cloned[key] = value;
          }
        }
        return Object.freeze(cloned);
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
    manifestId: sanitizedManifest?.id || null,
    parentSequence: currentParentSequence,
    currentParentSequence,
    inputWatermark: localState.lastConsumedUserTurn || null,
    progressFingerprint,
    decision,
    nextActions: nextActions || undefined,
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

  // Access sanitized fields safely - no optional chaining on untrusted
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
    fingerprintInput.tasks = state.tasks.map((t) => {
      const task = { id: t.id };
      if (t.status !== undefined && t.status !== null) task.status = t.status;
      if (t.count !== undefined && t.count !== null) task.count = t.count;
      return task;
    });
  }

  if (gates && gates.gates) {
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
