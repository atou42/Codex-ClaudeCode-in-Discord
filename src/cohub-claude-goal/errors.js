export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  PENDING: 10,
  PAUSED_USER: 20,
  BLOCKED: 30,
  INTEGRITY_FAILURE: 40,
  CAPABILITY_GATE_FAILURE: 50,
  LEASE_CONFLICT: 60,
});

export class GoalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoalError';
  }
}

export class IntegrityError extends GoalError {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export class PendingError extends GoalError {
  constructor(message) {
    super(message);
    this.name = 'PendingError';
  }
}

export class PausedUserError extends GoalError {
  constructor(message) {
    super(message);
    this.name = 'PausedUserError';
  }
}

export class CapabilityGateError extends GoalError {
  constructor(message) {
    super(message);
    this.name = 'CapabilityGateError';
  }
}

export class LeaseConflictError extends GoalError {
  constructor(message) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new TypeError('BlockedError evidence is required and must be a nonempty array');
  }
  for (const item of evidence) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError('BlockedError evidence is required: each entry must be a nonempty string');
    }
  }
}

export class BlockedError extends GoalError {
  constructor(message, evidence) {
    validateEvidence(evidence);
    super(message);
    this.name = 'BlockedError';
    this.evidence = Object.freeze([...evidence]);
  }
}

const EXIT_CODE_BY_NAME = Object.freeze({
  GoalError: 1,
  IntegrityError: EXIT_CODES.INTEGRITY_FAILURE,
  PendingError: EXIT_CODES.PENDING,
  PausedUserError: EXIT_CODES.PAUSED_USER,
  BlockedError: EXIT_CODES.BLOCKED,
  CapabilityGateError: EXIT_CODES.CAPABILITY_GATE_FAILURE,
  LeaseConflictError: EXIT_CODES.LEASE_CONFLICT,
});

export function exitCode(err) {
  if (err === null || err === undefined) {
    return EXIT_CODES.SUCCESS;
  }
  if (err instanceof Error && Object.prototype.hasOwnProperty.call(EXIT_CODE_BY_NAME, err.name)) {
    return EXIT_CODE_BY_NAME[err.name];
  }
  return 1;
}
