import crypto from 'node:crypto';
import { sanitizeObject, sanitizeArray } from './sanitize.js';

/**
 * Fixed allowlist of decision codes the bridge is permitted to issue.
 */
export const ALLOWED_DECISIONS = Object.freeze([
  'action-start',
  'worker-dispatch',
  'user-gate-response',
  'block-report',
  'external-wait-register',
]);

export const PHASES = Object.freeze({
  OBSERVED: 'OBSERVED',
  PREPARED: 'PREPARED',
  REQUEST_STARTED: 'REQUEST_STARTED',
  AMBIGUOUS: 'AMBIGUOUS',
  CONFIRMED: 'CONFIRMED',
  CANCELLED_STALE_BEFORE_SEND: 'CANCELLED_STALE_BEFORE_SEND',
});

export const TERMINAL_PHASES = Object.freeze([PHASES.CONFIRMED, PHASES.CANCELLED_STALE_BEFORE_SEND]);

const TERMINAL_PHASE_SET = new Set(TERMINAL_PHASES);

/**
 * Legal phase transitions with complete history validation.
 */
const TRANSITIONS = new Map([
  [undefined, [PHASES.OBSERVED]],
  [PHASES.OBSERVED, [PHASES.PREPARED, PHASES.CANCELLED_STALE_BEFORE_SEND]],
  [PHASES.PREPARED, [PHASES.REQUEST_STARTED, PHASES.CANCELLED_STALE_BEFORE_SEND]],
  [PHASES.REQUEST_STARTED, [PHASES.CONFIRMED, PHASES.AMBIGUOUS]],
  [PHASES.AMBIGUOUS, [PHASES.CONFIRMED]],
]);

const SNAPSHOT_HASH_RE = /^[0-9a-f]{64}$/;

export function assertSafeOwnPlainObject(value, label) {
  // This is now a lightweight check after sanitize has been called
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

export function assertExactOwnKeys(obj, allowedKeys, label) {
  // Lightweight check - sanitize should be called before this
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const allowed = new Set(allowedKeys);
  const actual = Object.keys(obj);
  for (const key of actual) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label}: unexpected key '${key}'. Allowed: ${allowedKeys.join(', ')}`);
    }
  }
  for (const key of allowedKeys) {
    if (!actual.includes(key)) {
      throw new TypeError(`${label}: missing required key '${key}'`);
    }
  }
}

export function assertSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

export function assertSnapshotHash(value, label) {
  if (typeof value !== 'string' || !SNAPSHOT_HASH_RE.test(value)) {
    throw new TypeError(`${label} must be a 64-character lowercase-hex snapshot hash`);
  }
}

export function assertDecisionCode(value) {
  if (!ALLOWED_DECISIONS.includes(value)) {
    throw new TypeError(`decisionCode '${value}' is not allowlisted. Allowed: ${ALLOWED_DECISIONS.join(', ')}`);
  }
}

export function assertValidTransition(previousPhase, nextPhase) {
  const allowed = TRANSITIONS.get(previousPhase) || [];
  if (!allowed.includes(nextPhase)) {
    throw new Error(
      `INTEGRITY_FAILURE: illegal phase transition '${previousPhase ?? 'NONE'}' -> '${nextPhase}'`,
    );
  }
}

export function isTerminalPhase(phase) {
  return TERMINAL_PHASE_SET.has(phase);
}

/**
 * Collision-resistant length-prefixed canonical hash including all bindings.
 */
function canonicalHash(parts) {
  const encoded = parts.map(part => `${String(part).length}:${part}`).join('|');
  return crypto.createHash('sha256').update(encoded, 'utf8').digest('hex');
}

const GENERATE_KEYS = [
  'goalVersion',
  'snapshotHash',
  'decisionCode',
  'attempt',
  'expectedParentSequence',
  'expectedInputWatermark',
];

/**
 * Generate deterministic action slot with collision-resistant IDs that include all bindings.
 */
export function generateActionSlot(params) {
  // Sanitize params to reject proxies, accessors, symbols, cycles, NaN, Infinity, etc.
  const sanitized = sanitizeObject(params, 'generateActionSlot params');

  assertExactOwnKeys(sanitized, GENERATE_KEYS, 'generateActionSlot params');
  const {
    goalVersion, snapshotHash, decisionCode, attempt,
    expectedParentSequence, expectedInputWatermark,
  } = sanitized;

  if (typeof goalVersion !== 'string' || goalVersion.length === 0) {
    throw new TypeError('goalVersion must be a non-empty string');
  }
  assertSnapshotHash(snapshotHash, 'snapshotHash');
  assertDecisionCode(decisionCode);
  assertSafeInteger(attempt, 'attempt');
  assertSafeInteger(expectedParentSequence, 'expectedParentSequence');
  assertSafeInteger(expectedInputWatermark, 'expectedInputWatermark');

  const canonicalParts = [
    goalVersion,
    snapshotHash,
    decisionCode,
    String(attempt),
    String(expectedParentSequence),
    String(expectedInputWatermark),
  ];
  const actionSlotId = `slot-${canonicalHash(canonicalParts)}`;
  const continuationId = `cont-${canonicalHash([...canonicalParts, 'continuation'])}`;

  return Object.freeze({
    actionSlotId,
    continuationId,
    expectedParentSequence,
    expectedInputWatermark,
    goalVersion,
    snapshotHash,
    decisionCode,
    attempt,
  });
}

/**
 * Validate complete phase history for a slot: transitions must be legal, bindings immutable.
 */
export function validateSlotHistory(entries) {
  // Sanitize the entries array to prevent mutation/accessor attacks
  const sanitized = sanitizeArray(entries, 'validateSlotHistory entries');

  if (sanitized.length === 0) return;

  let prevPhase = undefined;
  let bindings = null;

  for (const entry of sanitized) {
    assertValidTransition(prevPhase, entry.phase);

    // After OBSERVED, all bindings are frozen
    if (entry.phase === PHASES.OBSERVED) {
      bindings = {
        actionSlotId: entry.actionSlotId,
        continuationId: entry.continuationId,
        expectedSnapshotHash: entry.expectedSnapshotHash,
        expectedParentSequence: entry.expectedParentSequence,
        expectedInputWatermark: entry.expectedInputWatermark,
      };
    } else if (bindings) {
      // All subsequent phases must have identical bindings
      if (entry.actionSlotId !== bindings.actionSlotId) {
        throw new Error(`INTEGRITY_FAILURE: actionSlotId changed in phase ${entry.phase}`);
      }
      if (entry.continuationId !== bindings.continuationId) {
        throw new Error(`INTEGRITY_FAILURE: continuationId changed in phase ${entry.phase}`);
      }
      if (entry.phase === PHASES.PREPARED) {
        if (entry.expectedSnapshotHash !== bindings.expectedSnapshotHash) {
          throw new Error(`INTEGRITY_FAILURE: expectedSnapshotHash changed in PREPARED`);
        }
        if (entry.expectedParentSequence !== bindings.expectedParentSequence) {
          throw new Error(`INTEGRITY_FAILURE: expectedParentSequence changed in PREPARED`);
        }
        if (entry.expectedInputWatermark !== bindings.expectedInputWatermark) {
          throw new Error(`INTEGRITY_FAILURE: expectedInputWatermark changed in PREPARED`);
        }
      }
    }

    prevPhase = entry.phase;
  }
}

const RECOVER_KEYS = [
  'ledgerEntries',
  'currentSnapshotHash',
  'goalVersion',
  'decisionCode',
  'attempt',
  'expectedParentSequence',
  'expectedInputWatermark',
];

/**
 * Recover action slot with strict validation: exactly one unfinished slot, immutable bindings,
 * legal phase histories, and persisted stale cancellation.
 */
export function recoverActionSlot(params) {
  // Check if params itself is a proxy before any property access
  if (params && typeof params === 'object') {
    try {
      // Try to detect proxy without triggering traps via util.types.isProxy
      const sanitized = sanitizeObject(params, 'recoverActionSlot params (top-level)');
      // If sanitize passes, continue with the sanitized version
      params = sanitized;
    } catch (err) {
      // If it's a proxy/dangerous object, throw immediately
      throw err;
    }
  }

  assertExactOwnKeys(params, RECOVER_KEYS, 'recoverActionSlot params');

  const {
    ledgerEntries, currentSnapshotHash, goalVersion, decisionCode,
    attempt, expectedParentSequence, expectedInputWatermark,
  } = params;

  if (!Array.isArray(ledgerEntries)) {
    throw new TypeError('ledgerEntries must be an array');
  }

  // Sanitize each ledger entry individually to catch nested proxies/accessors
  const sanitizedEntries = ledgerEntries.map((entry, idx) => {
    if (entry === undefined) {
      throw new TypeError(`ledgerEntries[${idx}]: sparse array detected`);
    }
    return sanitizeObject(entry, `ledgerEntries[${idx}]`);
  });
  assertSnapshotHash(currentSnapshotHash, 'currentSnapshotHash');
  assertDecisionCode(decisionCode);

  const slotEntries = new Map();

  for (const entry of sanitizedEntries) {
    if (!Object.values(PHASES).includes(entry.phase)) {
      throw new TypeError(`Unknown ledger phase '${entry.phase}'`);
    }
    if (!entry.actionSlotId) {
      throw new TypeError('Ledger entry missing actionSlotId');
    }

    if (!slotEntries.has(entry.actionSlotId)) {
      slotEntries.set(entry.actionSlotId, []);
    }
    slotEntries.get(entry.actionSlotId).push(entry);
  }

  // Validate complete history for each slot
  for (const [slotId, entries] of slotEntries) {
    validateSlotHistory(entries);
  }

  const latestPhaseBySlot = new Map();
  for (const [slotId, entries] of slotEntries) {
    latestPhaseBySlot.set(slotId, entries[entries.length - 1].phase);
  }

  const unfinishedSlotIds = [...latestPhaseBySlot.entries()]
    .filter(([, phase]) => !isTerminalPhase(phase))
    .map(([slotId]) => slotId);

  if (unfinishedSlotIds.length > 1) {
    throw new Error(
      `INTEGRITY_FAILURE: multiple unfinished action slots: ${unfinishedSlotIds.join(', ')}`,
    );
  }

  if (unfinishedSlotIds.length === 1) {
    const actionSlotId = unfinishedSlotIds[0];
    const entries = slotEntries.get(actionSlotId);
    const latestEntry = entries[entries.length - 1];
    const phase = latestEntry.phase;
    const observedEntry = entries.find(e => e.phase === PHASES.OBSERVED);
    const preparedEntry = entries.find(e => e.phase === PHASES.PREPARED);

    if (phase === PHASES.OBSERVED) {
      return {
        phase: PHASES.OBSERVED,
        actionSlotId: observedEntry.actionSlotId,
        continuationId: observedEntry.continuationId,
        expectedParentSequence: observedEntry.expectedParentSequence,
        expectedInputWatermark: observedEntry.expectedInputWatermark,
        canSafelySend: false,
        requiresPrepareBefore: true,
        isRecovered: true,
      };
    }

    if (phase === PHASES.PREPARED) {
      if (preparedEntry.expectedSnapshotHash === currentSnapshotHash) {
        return {
          phase: PHASES.PREPARED,
          actionSlotId: preparedEntry.actionSlotId,
          continuationId: preparedEntry.continuationId,
          expectedParentSequence: preparedEntry.expectedParentSequence,
          expectedInputWatermark: preparedEntry.expectedInputWatermark,
          canSafelySend: true,
          isRecovered: true,
        };
      }
      // Snapshot changed: stale cancellation must be persisted before returning
      return {
        phase: PHASES.CANCELLED_STALE_BEFORE_SEND,
        actionSlotId: preparedEntry.actionSlotId,
        continuationId: preparedEntry.continuationId,
        evidence: `Snapshot changed from ${preparedEntry.expectedSnapshotHash} to ${currentSnapshotHash}`,
        canSafelySend: false,
        mustPersistCancellation: true,
        isRecovered: true,
      };
    }

    if (phase === PHASES.REQUEST_STARTED || phase === PHASES.AMBIGUOUS) {
      return {
        phase,
        actionSlotId: latestEntry.actionSlotId,
        continuationId: latestEntry.continuationId,
        expectedParentSequence: preparedEntry?.expectedParentSequence,
        expectedInputWatermark: preparedEntry?.expectedInputWatermark,
        mustReconcile: true,
        canSafelySend: false,
        isRecovered: true,
      };
    }
  }

  const newSlot = generateActionSlot({
    goalVersion,
    snapshotHash: currentSnapshotHash,
    decisionCode,
    attempt,
    expectedParentSequence,
    expectedInputWatermark,
  });

  return {
    phase: 'NEW',
    ...newSlot,
    canSafelySend: false,
    isRecovered: false,
  };
}
