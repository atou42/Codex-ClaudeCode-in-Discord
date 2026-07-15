/**
 * @fileoverview No-progress fingerprint and detection engine.
 *
 * Fingerprint changes only on real state/action/wait/user gate/blocker changes,
 * never on prose (worker/parent messages, "Turn completed", "will continue").
 *
 * Two consecutive NO_PROGRESS turns become BLOCKED_REPEATED_NO_PROGRESS.
 * Two consecutive Claude turns refusing required wait become BLOCKED_CLAUDE_WAIT_REFUSAL.
 * No third turn allowed after wait refusal.
 *
 * First NO_PROGRESS allows REPAIR_NO_PROGRESS template.
 * Prose, "Turn completed", and missing evidence never reset no-progress count.
 *
 * Output is descriptor-safe frozen object. No network, no packages, no other modules.
 */

import { createHash } from 'node:crypto';

/**
 * Compute progress fingerprint from snapshot.
 * Stable across prose changes, changes only on real progress signals.
 *
 * @param {object} snapshot - Current snapshot
 * @returns {string} Deterministic fingerprint hex string (64 lowercase hex chars)
 */
export function computeProgressFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot is required and must be an object');
  }

  // Extract only progress-relevant fields, excluding all prose
  const relevant = {
    orchestrationStatus: snapshot.orchestrationState?.status,
    currentStage: snapshot.orchestrationState?.currentStage,
    pendingWorkers: snapshot.pendingWorkers || [],
    completedWorkers: snapshot.completedWorkers || [],
    lastActionId: snapshot.lastActionId,
    externalWait: snapshot.externalWait,
    userGate: snapshot.userGate ? {
      gate: snapshot.userGate.gate,
      consumed: snapshot.userGate.consumed,
      promptTurnId: snapshot.userGate.promptTurnId
    } : null,
    blocker: snapshot.blocker ? {
      type: snapshot.blocker.type,
      resource: snapshot.blocker.resource
    } : null,
    stageGateStatus: snapshot.stageGateLog ?
      Object.fromEntries(
        Object.entries(snapshot.stageGateLog).map(([stage, log]) => [stage, log.status])
      ) : null
  };

  // Sort arrays for determinism
  if (Array.isArray(relevant.pendingWorkers)) {
    relevant.pendingWorkers = [...relevant.pendingWorkers].sort();
  }
  if (Array.isArray(relevant.completedWorkers)) {
    relevant.completedWorkers = [...relevant.completedWorkers].sort();
  }

  const canonical = JSON.stringify(relevant, Object.keys(relevant).sort());
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  // Validate output is exactly 64 lowercase hex chars
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Internal error: fingerprint hash format invalid');
  }

  return hash;
}

/**
 * Detect no-progress condition and compute block decision.
 *
 * @param {string} currentFingerprint - Current turn's fingerprint (64 lowercase hex)
 * @param {Array<object>} history - Previous turns with fingerprints
 * @param {object} currentTurn - Current turn metadata
 * @returns {object} Frozen detection result
 */
export function detectNoProgress(currentFingerprint, history, currentTurn = {}) {
  if (typeof currentFingerprint !== 'string' || !currentFingerprint) {
    throw new TypeError('currentFingerprint is required and must be a non-empty string');
  }

  // Enforce exactly 64 lowercase hex characters for currentFingerprint
  if (!/^[a-f0-9]{64}$/.test(currentFingerprint)) {
    throw new TypeError('currentFingerprint must be exactly 64 lowercase hex characters');
  }

  if (!Array.isArray(history)) {
    throw new TypeError('history must be an array');
  }

  // Validate all historical fingerprints
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry && entry.fingerprint && !/^[a-f0-9]{64}$/.test(entry.fingerprint)) {
      throw new TypeError(`history[${i}].fingerprint must be exactly 64 lowercase hex characters`);
    }
  }

  const {
    hadToolAction = false,
    verifyVerdict,
    snapshotRequiresWait,
    claudeCalledWait,
    snapshotAllowsSubmit,
    claudeCalledSubmit,
    hadFreshInspect,
    hadFreshVerify
  } = currentTurn;

  // Check Claude wait refusal (two consecutive turns)
  let isClaudeWaitRefusal = false;
  if (verifyVerdict === 'RUNNING' && snapshotRequiresWait === true && claudeCalledWait === false) {
    // Check if previous turn also refused wait
    const prevTurn = history[history.length - 1];
    if (
      prevTurn &&
      prevTurn.verifyVerdict === 'RUNNING' &&
      prevTurn.snapshotRequiresWait === true &&
      prevTurn.claudeCalledWait === false
    ) {
      isClaudeWaitRefusal = true;
      return freezeResult({
        isNoProgress: true,
        isClaudeWaitRefusal: true,
        count: 2,
        shouldBlock: true,
        blockReason: 'BLOCKED_CLAUDE_WAIT_REFUSAL',
        allowRepair: false
      });
    }
  }

  // Check Claude submit refusal (two consecutive turns)
  if (
    verifyVerdict === 'RUNNING' &&
    snapshotAllowsSubmit === true &&
    claudeCalledSubmit === false &&
    hadFreshInspect === false &&
    hadFreshVerify === false
  ) {
    const prevTurn = history[history.length - 1];
    if (
      prevTurn &&
      prevTurn.verifyVerdict === 'RUNNING' &&
      prevTurn.snapshotAllowsSubmit === true &&
      prevTurn.claudeCalledSubmit === false &&
      prevTurn.hadFreshInspect === false &&
      prevTurn.hadFreshVerify === false
    ) {
      return freezeResult({
        isNoProgress: true,
        isClaudeSubmitRefusal: true,
        count: 2,
        shouldBlock: true,
        blockReason: 'BLOCKED_REPEATED_NO_PROGRESS',
        allowRepair: false
      });
    }
  }

  // Tool action resets progress tracking
  if (hadToolAction) {
    return freezeResult({
      isNoProgress: false,
      isClaudeWaitRefusal,
      count: 0,
      shouldBlock: false,
      allowRepair: false
    });
  }

  // Count consecutive no-progress turns with same fingerprint
  let consecutiveCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const prev = history[i];
    if (prev.fingerprint === currentFingerprint && !prev.hadToolAction) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  // Fingerprint change resets
  if (consecutiveCount === 0 && history.length > 0 && history[history.length - 1].fingerprint !== currentFingerprint) {
    return freezeResult({
      isNoProgress: false,
      isClaudeWaitRefusal,
      count: 0,
      shouldBlock: false,
      allowRepair: false
    });
  }

  const totalCount = consecutiveCount + 1;

  // Regular no-progress detection
  const isNoProgress = totalCount > 0;

  if (totalCount === 1) {
    // First no-progress: allow repair
    return freezeResult({
      isNoProgress: true,
      isClaudeWaitRefusal,
      count: 1,
      shouldBlock: false,
      allowRepair: true,
      repairAction: 'REPAIR_NO_PROGRESS'
    });
  }

  if (totalCount >= 2) {
    // Second consecutive no-progress: block
    return freezeResult({
      isNoProgress: true,
      isClaudeWaitRefusal,
      count: totalCount,
      shouldBlock: true,
      blockReason: 'BLOCKED_REPEATED_NO_PROGRESS',
      allowRepair: false
    });
  }

  return freezeResult({
    isNoProgress: false,
    isClaudeWaitRefusal,
    count: 0,
    shouldBlock: false,
    allowRepair: false
  });
}

/**
 * Create frozen result object with descriptor-safe properties.
 */
function freezeResult(obj) {
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
