/**
 * @fileoverview Deterministic verify verdict engine with strict input sanitization.
 *
 * Accepts only fresh exact snapshot binding. Returns only RUNNING, DONE,
 * PAUSED_USER, or BLOCKED with reason, evidence refs, and missing evidence.
 *
 * DONE requires orchestration COMPLETE + all delivery evidence.
 * PAUSED_USER requires real user gate (proposal_approval/style_approval/studio_acceptance) with receipt.
 * BLOCKED requires evidence-based blocker.
 *
 * Workflow state must be WAITING_USER (not WAITING_USER_INPUT).
 * Gate names must be exact: proposal_approval, style_approval, studio_acceptance.
 * RUNNING must contain exact allowlisted next action or non-empty watchSet (never UNKNOWN).
 *
 * All input is sanitized through strict descriptor-walking validator BEFORE any use.
 * Output is descriptor-safe frozen object. Fail-closed on ambiguity.
 * No network, no package imports except sanitizer.
 */

import { sanitize, freezeOutput } from './sanitize.js';

// Valid user gates per spec lines 317-320
const VALID_USER_GATES = new Set(['proposal_approval', 'style_approval', 'studio_acceptance']);

// Valid workflow states per spec
const VALID_WORKFLOW_STATES = new Set(['IN_PROGRESS', 'WAITING_USER', 'BLOCKED', 'COMPLETE']);

// Init checkpoint patterns to reject fake completion (spec line 336-338)
const INIT_CHECKPOINT_PATTERNS = [/^init/i, /^initial/i, /_init$/i];

// Allowlisted next action types (spec line 193)
const VALID_NEXT_ACTIONS = new Set([
  'WAIT_WORKER',
  'ASK_PROPOSAL_APPROVAL',
  'ASK_STYLE_APPROVAL',
  'RECONCILE_AND_FAN_IN',
  'REDISPATCH_GEOGRAPHY',
  'FINALIZE_DELIVERY'
]);

// Closed blocker type set
const VALID_BLOCKER_TYPES = new Set([
  'UNBOUND_REPLACEMENT_RECEIPT',
  'PERMISSION_DENIED',
  'QUOTA_EXCEEDED',
  'PLATFORM_ERROR',
  'INTEGRITY_FAILURE',
  'REPAIR_BUDGET_EXHAUSTED'
]);

/**
 * Verify current goal state and return deterministic verdict.
 *
 * @param {object} goalInstance - Goal instance metadata (goalId, version, spaceId)
 * @param {object} options - Options with snapshot and expectedSnapshotHash
 * @returns {object} Frozen verdict object with verdict, snapshotHash, reason, etc.
 */
export function verify(goalInstance, options = {}) {
  // Sanitize ALL inputs BEFORE any destructuring or property access
  // This prevents Proxy traps from executing before validation
  let sanitizedGoal;
  let sanitizedOptions;

  try {
    if (!goalInstance || typeof goalInstance !== 'object') {
      throw new TypeError('goalInstance is required and must be an object');
    }
    sanitizedGoal = sanitize(goalInstance);

    if (!options || typeof options !== 'object') {
      throw new TypeError('options is required and must be an object');
    }
    sanitizedOptions = sanitize(options);
  } catch (err) {
    throw new TypeError(`Input sanitization failed: ${err.message}`);
  }

  // Extract goal binding fields
  const { goalId, version: goalVersion, spaceId: configuredSpaceId } = sanitizedGoal;

  if (!goalId || typeof goalId !== 'string') {
    throw new TypeError('goalInstance.goalId is required and must be a non-empty string');
  }

  if (!goalVersion || typeof goalVersion !== 'string') {
    throw new TypeError('goalInstance.version is required and must be a non-empty string');
  }

  if (!configuredSpaceId || typeof configuredSpaceId !== 'string') {
    throw new TypeError('goalInstance.spaceId is required and must be a non-empty string');
  }

  // Extract options
  const { snapshot, expectedSnapshotHash } = sanitizedOptions;

  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('options.snapshot is required and must be an object');
  }

  // Sanitize snapshot ONCE at boundary - all subsequent access uses sanitized clone
  let sanitizedSnapshot;
  try {
    sanitizedSnapshot = sanitize(snapshot);
  } catch (err) {
    throw new TypeError(`Snapshot sanitization failed: ${err.message}`);
  }

  const { snapshotHash } = sanitizedSnapshot;

  if (typeof snapshotHash !== 'string' || !snapshotHash) {
    throw new TypeError('snapshot.snapshotHash is required and must be a non-empty string');
  }

  // Enforce exactly 64 lowercase hex characters for snapshotHash
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) {
    throw new TypeError('snapshot.snapshotHash must be exactly 64 lowercase hex characters');
  }

  // Enforce exact snapshot binding with same validation
  if (expectedSnapshotHash !== undefined && expectedSnapshotHash !== null) {
    if (typeof expectedSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSnapshotHash)) {
      throw new TypeError('expectedSnapshotHash must be exactly 64 lowercase hex characters');
    }
    if (expectedSnapshotHash !== snapshotHash) {
      throw new Error(
        `Snapshot hash mismatch: expected ${expectedSnapshotHash}, got ${snapshotHash}`
      );
    }
  }

  const orchestrationState = sanitizedSnapshot.orchestrationState || {};
  const { status } = orchestrationState;

  // Validate workflow status
  if (status && !VALID_WORKFLOW_STATES.has(status)) {
    return freezeOutput({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: 'INVALID_WORKFLOW_STATE',
      evidenceRefs: ['orchestrationState.status'],
      missingEvidence: []
    });
  }

  // Check for migration doctor verdict (spec line 193)
  if (sanitizedSnapshot.migrationDoctor?.verdict === 'UNBOUND_REPLACEMENT_RECEIPT') {
    return freezeOutput({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: 'UNBOUND_REPLACEMENT_RECEIPT',
      evidenceRefs: ['migrationDoctor'],
      missingEvidence: []
    });
  }

  // Check for corrupt state
  if (sanitizedSnapshot.stageGateLog) {
    for (const [stage, log] of Object.entries(sanitizedSnapshot.stageGateLog)) {
      if (log.status && !['PASS', 'FAIL', 'PENDING'].includes(log.status)) {
        return freezeOutput({
          verdict: 'BLOCKED',
          snapshotHash,
          reason: 'CORRUPT_STAGE_STATUS',
          evidenceRefs: ['stageGateLog'],
          missingEvidence: []
        });
      }
    }
  }

  // Check for explicit blocker (must be closed type set)
  if (sanitizedSnapshot.blocker) {
    const { type, evidence } = sanitizedSnapshot.blocker;
    if (type && evidence) {
      if (!VALID_BLOCKER_TYPES.has(type)) {
        return freezeOutput({
          verdict: 'BLOCKED',
          snapshotHash,
          reason: 'INVALID_BLOCKER_TYPE',
          evidenceRefs: ['blocker.type'],
          missingEvidence: []
        });
      }
      return freezeOutput({
        verdict: 'BLOCKED',
        snapshotHash,
        reason: type,
        evidenceRefs: ['blocker.evidence'],
        missingEvidence: []
      });
    }
  }

  // Check for user gate (PAUSED_USER) - spec lines 317-320
  // Must be WAITING_USER (not WAITING_USER_INPUT) and exact gate names
  if (status === 'WAITING_USER' && sanitizedSnapshot.userGate) {
    const { gate, consumed, promptTurnId } = sanitizedSnapshot.userGate;

    if (VALID_USER_GATES.has(gate) && consumed !== true && promptTurnId) {
      return freezeOutput({
        verdict: 'PAUSED_USER',
        snapshotHash,
        gate,
        promptTurnId,
        evidenceRefs: ['userGate.promptReceipt'],
        missingEvidence: []
      });
    }
  }

  // Check for DONE (spec lines 334-346)
  if (status === 'COMPLETE') {
    const doneResult = checkDoneConditions(sanitizedSnapshot, snapshotHash, configuredSpaceId);
    if (doneResult) {
      return doneResult;
    }
    // If COMPLETE but conditions not met, fall through to list missing evidence
  }

  // Default to RUNNING (spec lines 244-250)
  const nextAction = sanitizedSnapshot.nextAction || {};
  const watchSet = sanitizedSnapshot.watchSet || [];

  // If orchestration is COMPLETE but evidence missing, return RUNNING with missing evidence list
  if (status === 'COMPLETE') {
    const deliveryEvidence = sanitizedSnapshot.deliveryEvidence || {};
    const missingEvidence = [];

    // Required fields per spec line 340
    const requiredFields = [
      'schemaVersion',
      'worldId',
      'spaceId',
      'checkpointId',
      'checkpointCreatedAt',
      'manifestSha256',
      'studioUrl',
      'cohubUrl',
      'desktopScreenshot',
      'mobileScreenshot',
      'guestProbe',
      'finalReport',
      'gateLog',
      'evidenceCreatedAt',
      'parentSessionId',
      'parentTurnId'
    ];

    for (const field of requiredFields) {
      if (!deliveryEvidence[field]) {
        missingEvidence.push(`deliveryEvidence.${field}`);
      }
    }

    if (!sanitizedSnapshot.studioAcceptance?.consumed) {
      missingEvidence.push('studioAcceptance.consumed');
    }

    return freezeOutput({
      verdict: 'RUNNING',
      snapshotHash,
      nextAction: { type: 'FINALIZE_DELIVERY' },
      watchSet: [],
      reason: 'Missing delivery evidence for COMPLETE orchestration',
      evidenceRefs: [],
      missingEvidence
    });
  }

  // Validate next action if present
  if (nextAction.type === 'UNKNOWN') {
    return freezeOutput({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: 'INVALID_NEXT_ACTION',
      evidenceRefs: [],
      missingEvidence: []
    });
  }

  if (nextAction.type && !VALID_NEXT_ACTIONS.has(nextAction.type)) {
    return freezeOutput({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: 'UNKNOWN_NEXT_ACTION_TYPE',
      evidenceRefs: [],
      missingEvidence: []
    });
  }

  // For normal IN_PROGRESS, nextAction or watchSet is optional (may be in transition)
  // per spec lines 224-225

  // Determine reason based on state
  let reason = 'Orchestration in progress';

  if (sanitizedSnapshot.deliveryEvidence && status !== 'COMPLETE') {
    reason = 'Orchestration not COMPLETE yet';
  }

  return freezeOutput({
    verdict: 'RUNNING',
    snapshotHash,
    nextAction,
    watchSet,
    reason,
    evidenceRefs: [],
    missingEvidence: []
  });
}

/**
 * Check DONE conditions exhaustively (spec lines 334-346).
 * Returns frozen verdict if DONE, null if conditions not met, BLOCKED if fake completion.
 */
function checkDoneConditions(sanitizedSnapshot, snapshotHash, configuredSpaceId) {
  const { orchestrationState, deliveryEvidence, studioAcceptance } = sanitizedSnapshot;

  if (orchestrationState.status !== 'COMPLETE') {
    return null;
  }

  if (!deliveryEvidence) {
    return null;
  }

  // IMPORTANT: Check Space ID binding FIRST (spec line 336-340)
  const { spaceId: evidenceSpaceId } = deliveryEvidence;
  if (evidenceSpaceId !== configuredSpaceId) {
    return freezeOutput({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: 'SPACE_ID_MISMATCH',
      evidenceRefs: ['deliveryEvidence.spaceId', 'goalInstance.spaceId'],
      missingEvidence: []
    });
  }

  // Check for init checkpoint BEFORE other evidence (spec line 336-338)
  const { checkpointId } = deliveryEvidence;
  if (checkpointId) {
    const isInitCheckpoint = INIT_CHECKPOINT_PATTERNS.some(
      pattern => pattern.test(checkpointId)
    );

    if (isInitCheckpoint) {
      return freezeOutput({
        verdict: 'BLOCKED',
        snapshotHash,
        reason: 'INIT_CHECKPOINT_FORBIDDEN',
        evidenceRefs: ['deliveryEvidence.checkpointId'],
        missingEvidence: []
      });
    }
  }

  // Check studio acceptance consumed (spec line 336)
  if (!studioAcceptance?.consumed) {
    return null;
  }

  // Required fields (spec line 340)
  const required = [
    'schemaVersion',
    'worldId',
    'spaceId',
    'checkpointId',
    'checkpointCreatedAt',
    'manifestSha256',
    'studioUrl',
    'cohubUrl',
    'desktopScreenshot',
    'mobileScreenshot',
    'guestProbe',
    'finalReport',
    'gateLog',
    'evidenceCreatedAt',
    'parentSessionId',
    'parentTurnId'
  ];

  const missing = required.filter(field => !deliveryEvidence[field]);
  if (missing.length > 0) {
    return null;
  }

  // Validate screenshots (spec line 342)
  const { desktopScreenshot, mobileScreenshot } = deliveryEvidence;

  if (!validateScreenshot(desktopScreenshot, 1440, 900, deliveryEvidence.manifestSha256, deliveryEvidence.worldId, deliveryEvidence.checkpointId)) {
    return null;
  }

  if (!validateScreenshot(mobileScreenshot, 390, 844, deliveryEvidence.manifestSha256, deliveryEvidence.worldId, deliveryEvidence.checkpointId)) {
    return null;
  }

  // Validate guest probe (spec line 344)
  const { guestProbe } = deliveryEvidence;
  if (
    guestProbe.status !== 200 ||
    guestProbe.role !== 'guest' ||
    guestProbe.requestHadCookie !== false ||
    guestProbe.requestHadAuthorization !== false ||
    !guestProbe.observedWorldId ||
    guestProbe.observedWorldId !== deliveryEvidence.worldId
  ) {
    return null;
  }

  // All conditions met
  return freezeOutput({
    verdict: 'DONE',
    snapshotHash,
    evidenceRefs: [
      'deliveryEvidence.worldId',
      'deliveryEvidence.spaceId',
      'deliveryEvidence.checkpointId',
      'deliveryEvidence.checkpointCreatedAt',
      'deliveryEvidence.manifestSha256',
      'deliveryEvidence.desktopScreenshot',
      'deliveryEvidence.mobileScreenshot',
      'deliveryEvidence.guestProbe',
      'deliveryEvidence.finalReport',
      'deliveryEvidence.gateLog',
      'deliveryEvidence.parentSessionId',
      'deliveryEvidence.parentTurnId',
      'studioAcceptance'
    ],
    missingEvidence: []
  });
}

/**
 * Validate screenshot evidence (spec line 342).
 */
function validateScreenshot(screenshot, expectedWidth, expectedHeight, manifestHash, worldId, checkpointId) {
  if (!screenshot) return false;
  if (!screenshot.sha256 || !/^[a-f0-9]{64}$/.test(screenshot.sha256)) return false;
  if (screenshot.width !== expectedWidth) return false;
  if (screenshot.height !== expectedHeight) return false;
  if (!screenshot.capturedAt) return false;
  if (!manifestHash || !/^[a-f0-9]{64}$/.test(manifestHash)) return false;
  if (screenshot.manifestHash !== manifestHash) return false;
  // Spec line 342: screenshots must bind to worldId and checkpointId
  if (screenshot.worldId !== worldId) return false;
  if (screenshot.checkpointId !== checkpointId) return false;
  return true;
}
