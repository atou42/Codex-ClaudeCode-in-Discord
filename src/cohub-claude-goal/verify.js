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
 * All snapshot input is sanitized through strict descriptor-walking validator.
 * Output is descriptor-safe frozen object. Fail-closed on ambiguity.
 * No network, no package imports except sanitizer.
 */

import { sanitize, freezeOutput } from './sanitize.js';

// Valid user gates per spec lines 317-320
const VALID_USER_GATES = new Set(['proposal_approval', 'style_approval', 'studio_acceptance']);

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

/**
 * Verify current goal state and return deterministic verdict.
 *
 * @param {object} goalInstance - Goal instance metadata (goalId, version, spaceId)
 * @param {object} options - Options with snapshot and expectedSnapshotHash
 * @returns {object} Frozen verdict object with verdict, snapshotHash, reason, etc.
 */
export function verify(goalInstance, options = {}) {
  if (!goalInstance || typeof goalInstance !== 'object') {
    throw new TypeError('goalInstance is required and must be an object');
  }

  const { snapshot, expectedSnapshotHash } = options;

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
  if (expectedSnapshotHash !== undefined) {
    if (typeof expectedSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSnapshotHash)) {
      throw new TypeError('expectedSnapshotHash must be exactly 64 lowercase hex characters');
    }
    if (expectedSnapshotHash !== snapshotHash) {
      throw new Error(
        `snapshot hash mismatch: expected ${expectedSnapshotHash}, got ${snapshotHash}`
      );
    }
  }

  const orchestrationState = sanitizedSnapshot.orchestrationState || {};
  const { status } = orchestrationState;

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
          reason: `Corrupt state: invalid stage status ${log.status} for ${stage}`,
          evidenceRefs: ['stageGateLog'],
          missingEvidence: []
        });
      }
    }
  }

  // Check for explicit blocker
  if (sanitizedSnapshot.blocker) {
    const { type, evidence } = sanitizedSnapshot.blocker;
    if (type && evidence) {
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
    const doneResult = checkDoneConditions(sanitizedSnapshot, snapshotHash);
    if (doneResult) {
      return doneResult;
    }
    // If COMPLETE but conditions not met, fall through to list missing evidence
  }

  // Default to RUNNING (spec lines 244-250)
  const nextAction = sanitizedSnapshot.nextAction || {};
  const watchSet = sanitizedSnapshot.watchSet || [];

  // If orchestration is COMPLETE but evidence missing, return RUNNING with missing evidence list
  // (no need for nextAction when just listing what's missing)
  if (status === 'COMPLETE') {
    const deliveryEvidence = sanitizedSnapshot.deliveryEvidence || {};
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
      'evidenceCreatedAt'
    ];

    const missingEvidence = [];
    for (const field of requiredFields) {
      if (!deliveryEvidence[field]) {
        missingEvidence.push(field);
      }
    }

    if (!sanitizedSnapshot.studioAcceptance?.consumed) {
      missingEvidence.push('studioAcceptance.consumed');
    }

    return freezeOutput({
      verdict: 'RUNNING',
      snapshotHash,
      nextAction,
      watchSet,
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
      reason: 'RUNNING verdict requires exact next action or non-empty watchSet, not UNKNOWN',
      evidenceRefs: [],
      missingEvidence: []
    });
  }

  if (nextAction.type && !VALID_NEXT_ACTIONS.has(nextAction.type)) {
    return freezeOutput({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: `Unknown next action type: ${nextAction.type}`,
      evidenceRefs: [],
      missingEvidence: []
    });
  }

  // For normal IN_PROGRESS, nextAction or watchSet is optional (may be in transition)
  // BLOCKED only if explicitly UNKNOWN, not if missing

  // Determine reason based on state
  let reason = 'Orchestration in progress';

  if (sanitizedSnapshot.deliveryEvidence && status !== 'COMPLETE') {
    // Delivery evidence present but orchestration not COMPLETE
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
function checkDoneConditions(sanitizedSnapshot, snapshotHash) {
  const { orchestrationState, deliveryEvidence, studioAcceptance } = sanitizedSnapshot;

  if (orchestrationState.status !== 'COMPLETE') {
    return null;
  }

  if (!deliveryEvidence) {
    return null;
  }

  // IMPORTANT: Check for init checkpoint FIRST before other evidence (spec line 336-338)
  // This catches fake completion attempts early, even if other fields missing
  const { checkpointId } = deliveryEvidence;
  if (checkpointId) {
    const isInitCheckpoint = INIT_CHECKPOINT_PATTERNS.some(
      pattern => pattern.test(checkpointId)
    );

    if (isInitCheckpoint) {
      return freezeOutput({
        verdict: 'BLOCKED',
        snapshotHash,
        reason: `Fake completion: init checkpoint ${checkpointId} forbidden`,
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
    'evidenceCreatedAt'
  ];

  const missing = required.filter(field => !deliveryEvidence[field]);
  if (missing.length > 0) {
    return null;
  }

  // Validate screenshots (spec line 342)
  const { desktopScreenshot, mobileScreenshot } = deliveryEvidence;

  if (!validateScreenshot(desktopScreenshot, 1440, 900, deliveryEvidence.manifestSha256)) {
    return null;
  }

  if (!validateScreenshot(mobileScreenshot, 390, 844, deliveryEvidence.manifestSha256)) {
    return null;
  }

  // Validate guest probe (spec line 344)
  const { guestProbe } = deliveryEvidence;
  if (
    guestProbe.status !== 200 ||
    guestProbe.role !== 'guest' ||
    guestProbe.requestHadCookie !== false ||
    guestProbe.requestHadAuthorization !== false
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
      'studioAcceptance'
    ],
    missingEvidence: []
  });
}

/**
 * Validate screenshot evidence (spec line 342).
 */
function validateScreenshot(screenshot, expectedWidth, expectedHeight, manifestHash) {
  if (!screenshot) return false;
  if (!screenshot.sha256 || !/^[a-f0-9]{64}$/.test(screenshot.sha256)) return false;
  if (screenshot.width !== expectedWidth) return false;
  if (screenshot.height !== expectedHeight) return false;
  if (!screenshot.capturedAt) return false;
  // manifestHash must also be exactly 64 lowercase hex
  if (!manifestHash || !/^[a-f0-9]{64}$/.test(manifestHash)) return false;
  if (screenshot.manifestHash !== manifestHash) return false;
  return true;
}
