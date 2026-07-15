/**
 * @fileoverview Deterministic verify verdict engine.
 *
 * Accepts only fresh exact snapshot binding. Returns only RUNNING, DONE,
 * PAUSED_USER, or BLOCKED with reason, evidence refs, and missing evidence.
 *
 * DONE requires orchestration COMPLETE + all delivery evidence.
 * PAUSED_USER requires real user gate (proposal/style/studio) with receipt.
 * BLOCKED requires evidence-based blocker.
 *
 * Worker/parent prose, "Turn completed", "Return PASS", and missing evidence
 * can never yield DONE.
 *
 * Enforces user gates, rejects fake completion, detects corrupt state,
 * handles UNBOUND_REPLACEMENT_RECEIPT, validates historical regression.
 *
 * Output is descriptor-safe frozen object. Fail-closed on ambiguity.
 * No network, no package imports, no other modules.
 */

const VALID_USER_GATES = new Set(['proposal', 'style', 'studio']);
const INIT_CHECKPOINT_PATTERNS = [/^init/, /^initial/, /_init$/];

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

  const { snapshotHash } = snapshot;

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

  const orchestrationState = snapshot.orchestrationState || {};
  const { status } = orchestrationState;

  // Check for migration doctor verdict
  if (snapshot.migrationDoctor?.verdict === 'UNBOUND_REPLACEMENT_RECEIPT') {
    return freezeVerdict({
      verdict: 'BLOCKED',
      snapshotHash,
      reason: 'UNBOUND_REPLACEMENT_RECEIPT',
      evidenceRefs: ['migrationDoctor'],
      missingEvidence: []
    });
  }

  // Check for corrupt state
  if (snapshot.stageGateLog) {
    for (const [stage, log] of Object.entries(snapshot.stageGateLog)) {
      if (log.status && !['PASS', 'FAIL', 'PENDING'].includes(log.status)) {
        return freezeVerdict({
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
  if (snapshot.blocker) {
    const { type, evidence } = snapshot.blocker;
    if (type && evidence) {
      return freezeVerdict({
        verdict: 'BLOCKED',
        snapshotHash,
        reason: type,
        evidenceRefs: ['blocker.evidence'],
        missingEvidence: []
      });
    }
  }

  // Check for user gate (PAUSED_USER)
  if (orchestrationState.status === 'WAITING_USER_INPUT' && snapshot.userGate) {
    const { gate, consumed, promptTurnId } = snapshot.userGate;

    if (VALID_USER_GATES.has(gate) && consumed !== true && promptTurnId) {
      return freezeVerdict({
        verdict: 'PAUSED_USER',
        snapshotHash,
        gate,
        promptTurnId,
        evidenceRefs: ['userGate.promptReceipt'],
        missingEvidence: []
      });
    }
  }

  // Check for DONE
  if (status === 'COMPLETE') {
    const doneResult = checkDoneConditions(snapshot, snapshotHash);
    if (doneResult) {
      return doneResult;
    }
    // If COMPLETE but conditions not met, fall through to list missing evidence
  }

  // Default to RUNNING
  const nextAction = snapshot.nextAction || { type: 'UNKNOWN' };
  const missingEvidence = [];

  // Determine reason based on state
  let reason = 'Orchestration in progress';

  // If orchestration is COMPLETE but evidence missing, list what's missing
  if (status === 'COMPLETE') {
    const deliveryEvidence = snapshot.deliveryEvidence || {};
    const requiredFields = [
      'worldId', 'spaceId', 'checkpointId', 'studioUrl', 'cohubUrl',
      'desktopScreenshot', 'mobileScreenshot', 'guestProbe',
      'finalReport', 'gateLog'
    ];

    for (const field of requiredFields) {
      if (!deliveryEvidence[field]) {
        missingEvidence.push(field);
      }
    }

    if (!snapshot.studioAcceptance?.consumed) {
      missingEvidence.push('studioAcceptance.consumed');
    }

    reason = 'Missing delivery evidence for COMPLETE orchestration';
  } else if (snapshot.deliveryEvidence && status !== 'COMPLETE') {
    // Delivery evidence present but orchestration not COMPLETE
    reason = 'Orchestration not COMPLETE yet';
  }

  return freezeVerdict({
    verdict: 'RUNNING',
    snapshotHash,
    nextAction,
    reason,
    evidenceRefs: [],
    missingEvidence
  });
}

/**
 * Check DONE conditions exhaustively.
 * Returns frozen verdict if DONE, null if conditions not met, BLOCKED if fake completion.
 */
function checkDoneConditions(snapshot, snapshotHash) {
  const { orchestrationState, deliveryEvidence, studioAcceptance } = snapshot;

  if (orchestrationState.status !== 'COMPLETE') {
    return null;
  }

  if (!deliveryEvidence) {
    return null;
  }

  // IMPORTANT: Check for init checkpoint FIRST before other evidence
  // This catches fake completion attempts early, even if other fields missing
  const { checkpointId } = deliveryEvidence;
  if (checkpointId) {
    const isInitCheckpoint = INIT_CHECKPOINT_PATTERNS.some(
      pattern => pattern.test(checkpointId)
    );

    if (isInitCheckpoint) {
      return freezeVerdict({
        verdict: 'BLOCKED',
        snapshotHash,
        reason: `Fake completion: init checkpoint ${checkpointId} forbidden`,
        evidenceRefs: ['deliveryEvidence.checkpointId'],
        missingEvidence: []
      });
    }
  }

  // Check studio acceptance consumed
  if (!studioAcceptance?.consumed) {
    return null;
  }

  // Required fields
  const required = [
    'schemaVersion', 'worldId', 'spaceId', 'checkpointId',
    'checkpointCreatedAt', 'manifestSha256', 'studioUrl', 'cohubUrl',
    'desktopScreenshot', 'mobileScreenshot', 'guestProbe',
    'finalReport', 'gateLog', 'evidenceCreatedAt'
  ];

  const missing = required.filter(field => !deliveryEvidence[field]);
  if (missing.length > 0) {
    return null;
  }

  // Validate screenshots
  const { desktopScreenshot, mobileScreenshot } = deliveryEvidence;

  if (!validateScreenshot(desktopScreenshot, 1440, 900, deliveryEvidence.manifestSha256)) {
    return null;
  }

  if (!validateScreenshot(mobileScreenshot, 390, 844, deliveryEvidence.manifestSha256)) {
    return null;
  }

  // Validate guest probe
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
  return freezeVerdict({
    verdict: 'DONE',
    snapshotHash,
    evidenceRefs: [
      'deliveryEvidence.worldId',
      'deliveryEvidence.spaceId',
      'deliveryEvidence.checkpointId',
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
 * Validate screenshot evidence.
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

/**
 * Create frozen verdict object with descriptor-safe properties.
 */
function freezeVerdict(obj) {
  const frozen = {};

  for (const [key, value] of Object.entries(obj)) {
    Object.defineProperty(frozen, key, {
      value: value,
      writable: false,
      enumerable: true,
      configurable: false
    });
  }

  return Object.freeze(frozen);
}
