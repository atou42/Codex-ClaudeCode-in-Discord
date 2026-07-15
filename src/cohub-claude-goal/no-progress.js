/**
 * @fileoverview No-progress fingerprint and detection engine with strict sanitization.
 *
 * Fingerprint changes only on real state/action/wait/user gate/blocker changes,
 * never on prose (worker/parent messages, "Turn completed", "will continue").
 *
 * Progress fingerprint spec (lines 191): remote state hash, gate log hash, manifest hash,
 * worker IDs+terminal status, artifact hashes, receipt status and human gate.
 * Excludes prose, ETA, RETURN PASS words, and Turn completed alone.
 *
 * Canonical encoding must preserve nested keys/types and deterministic array order.
 * Do not sort away meaningful ordering or use JSON replacer incorrectly.
 *
 * Two consecutive NO_PROGRESS turns become BLOCKED_REPEATED_NO_PROGRESS.
 * Two consecutive Claude turns refusing required wait become BLOCKED_CLAUDE_WAIT_REFUSAL.
 * No third turn allowed after wait refusal.
 *
 * First NO_PROGRESS allows REPAIR_NO_PROGRESS template.
 * Prose, "Turn completed", and missing evidence never reset no-progress count.
 * Irrelevant tool actions (text only) do not count as progress.
 *
 * Output is descriptor-safe frozen object. No network, no packages.
 */

import { createHash } from 'node:crypto';
import { sanitize, freezeOutput } from './sanitize.js';

/**
 * Compute progress fingerprint from snapshot (spec line 191).
 * Stable across prose changes, changes only on real progress signals.
 * Preserves nested keys and types with canonical JSON encoding.
 *
 * @param {object} snapshot - Current snapshot
 * @returns {string} Deterministic fingerprint hex string (64 lowercase hex chars)
 */
export function computeProgressFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot is required and must be an object');
  }

  // Sanitize snapshot to ensure no trap execution
  let sanitized;
  try {
    sanitized = sanitize(snapshot);
  } catch (err) {
    throw new TypeError(`Snapshot sanitization failed: ${err.message}`);
  }

  // Extract only progress-relevant fields, excluding all prose (spec line 191)
  const relevant = {
    // Remote state hash
    orchestrationStatus: sanitized.orchestrationState?.status,
    orchestrationStateHash: sanitized.orchestrationState?.hash,
    currentStage: sanitized.orchestrationState?.currentStage,

    // Gate log hash
    gateLogHash: sanitized.gateLogHash,

    // Manifest hash
    manifestHash: sanitized.manifestHash,

    // Worker IDs and terminal status
    pendingWorkers: sanitized.pendingWorkers || [],
    completedWorkers: sanitized.completedWorkers || [],
    workerTerminalStatuses: sanitized.workerTerminalStatuses || {},

    // Artifact hashes
    artifactHashes: sanitized.artifactHashes || {},

    // Receipt status
    receiptStatus: sanitized.receiptStatus,

    // Human gate (preserve full structure to detect gate type changes)
    userGate: sanitized.userGate ? {
      gate: sanitized.userGate.gate,
      consumed: sanitized.userGate.consumed,
      promptTurnId: sanitized.userGate.promptTurnId
    } : null,

    // Last action and external wait
    lastActionId: sanitized.lastActionId,
    externalWait: sanitized.externalWait,

    // Blocker
    blocker: sanitized.blocker ? {
      type: sanitized.blocker.type,
      resource: sanitized.blocker.resource
    } : null,

    // Stage gate status (preserve nested structure)
    stageGateStatus: sanitized.stageGateLog ?
      Object.fromEntries(
        Object.entries(sanitized.stageGateLog).map(([stage, log]) => [stage, log.status])
      ) : null
  };

  // Sort arrays for determinism, preserving nested structure
  if (Array.isArray(relevant.pendingWorkers)) {
    relevant.pendingWorkers = [...relevant.pendingWorkers].sort();
  }
  if (Array.isArray(relevant.completedWorkers)) {
    relevant.completedWorkers = [...relevant.completedWorkers].sort();
  }

  // Canonical JSON: sort top-level keys with a custom replacer that preserves all nested structure
  // We cannot use Object.keys(relevant).sort() as the replacer because it filters out nested keys
  const topLevelKeys = Object.keys(relevant).sort();
  const canonical = JSON.stringify(relevant, (key, value) => {
    // Root level: filter to sorted top-level keys
    if (key === '') {
      const sorted = {};
      for (const k of topLevelKeys) {
        sorted[k] = relevant[k];
      }
      return sorted;
    }
    // Nested levels: preserve all keys and values as-is
    return value;
  });

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
    toolActionWasRelevant = true, // Default to true for backward compatibility
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
      return freezeOutput({
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
      return freezeOutput({
        isNoProgress: true,
        isClaudeSubmitRefusal: true,
        count: 2,
        shouldBlock: true,
        blockReason: 'BLOCKED_REPEATED_NO_PROGRESS',
        allowRepair: false
      });
    }
  }

  // Tool action resets progress tracking ONLY if relevant
  // Irrelevant tool actions (text generation only) do not reset
  if (hadToolAction && toolActionWasRelevant) {
    return freezeOutput({
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
    const prevRelevant = prev.hadToolAction ? (prev.toolActionWasRelevant !== false) : false;
    if (prev.fingerprint === currentFingerprint && !prevRelevant) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  // Fingerprint change resets
  if (consecutiveCount === 0 && history.length > 0 && history[history.length - 1].fingerprint !== currentFingerprint) {
    return freezeOutput({
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
    return freezeOutput({
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
    return freezeOutput({
      isNoProgress: true,
      isClaudeWaitRefusal,
      count: totalCount,
      shouldBlock: true,
      blockReason: 'BLOCKED_REPEATED_NO_PROGRESS',
      allowRepair: false
    });
  }

  return freezeOutput({
    isNoProgress: false,
    isClaudeWaitRefusal,
    count: 0,
    shouldBlock: false,
    allowRepair: false
  });
}
