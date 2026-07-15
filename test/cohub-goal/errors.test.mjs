import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GoalError,
  IntegrityError,
  BlockedError,
  PausedUserError,
  PendingError,
  CapabilityGateError,
  LeaseConflictError,
  EXIT_CODES,
  exitCode,
} from '../../src/cohub-claude-goal/errors.js';

test('GoalError has correct exit code', () => {
  const err = new GoalError('test');
  assert.equal(err.name, 'GoalError');
  assert.equal(err.message, 'test');
  assert.equal(exitCode(err), 1);
});

test('IntegrityError has fixed exit code 40', () => {
  const err = new IntegrityError('corrupt ledger');
  assert.equal(err.name, 'IntegrityError');
  assert.equal(err.message, 'corrupt ledger');
  assert.equal(exitCode(err), 40);
});

test('BlockedError requires nonempty evidence', () => {
  assert.throws(
    () => new BlockedError('blocked', []),
    /evidence.*required/i
  );
  assert.throws(
    () => new BlockedError('blocked', null),
    /evidence.*required/i
  );
  assert.throws(
    () => new BlockedError('blocked'),
    /evidence.*required/i
  );
});

test('BlockedError has fixed exit code 30', () => {
  const err = new BlockedError('blocked', ['evidence-1']);
  assert.equal(err.name, 'BlockedError');
  assert.equal(err.message, 'blocked');
  assert.deepEqual(err.evidence, ['evidence-1']);
  assert.equal(exitCode(err), 30);
});

test('BlockedError with multiple evidence', () => {
  const err = new BlockedError('ambiguous send', ['ledger-seq-5', 'no-turn-receipt']);
  assert.deepEqual(err.evidence, ['ledger-seq-5', 'no-turn-receipt']);
});

test('exitCode returns 1 for unknown errors', () => {
  assert.equal(exitCode(new Error('generic')), 1);
  assert.equal(exitCode(new TypeError('type')), 1);
});

test('exitCode returns 0 for null/undefined', () => {
  assert.equal(exitCode(null), 0);
  assert.equal(exitCode(undefined), 0);
});

test('all error types extend Error', () => {
  assert.ok(new GoalError('test') instanceof Error);
  assert.ok(new IntegrityError('test') instanceof Error);
  assert.ok(new BlockedError('test', ['e']) instanceof Error);
  assert.ok(new PausedUserError('test') instanceof Error);
  assert.ok(new PendingError('test') instanceof Error);
  assert.ok(new CapabilityGateError('test') instanceof Error);
  assert.ok(new LeaseConflictError('test') instanceof Error);
});

test('PendingError has exit code 10', () => {
  const err = new PendingError('normal incomplete');
  assert.equal(exitCode(err), 10);
  assert.equal(err.name, 'PendingError');
});

test('PausedUserError has exit code 20', () => {
  const err = new PausedUserError('waiting for user');
  assert.equal(exitCode(err), 20);
  assert.equal(err.name, 'PausedUserError');
});

test('CapabilityGateError has exit code 50', () => {
  const err = new CapabilityGateError('gate failed');
  assert.equal(exitCode(err), 50);
  assert.equal(err.name, 'CapabilityGateError');
});

test('LeaseConflictError has exit code 60', () => {
  const err = new LeaseConflictError('concurrent lease');
  assert.equal(exitCode(err), 60);
  assert.equal(err.name, 'LeaseConflictError');
});

test('EXIT_CODES matches fixed contract', () => {
  assert.deepEqual(EXIT_CODES, {
    SUCCESS: 0,
    PENDING: 10,
    PAUSED_USER: 20,
    BLOCKED: 30,
    INTEGRITY_FAILURE: 40,
    CAPABILITY_GATE_FAILURE: 50,
    LEASE_CONFLICT: 60,
  });
});

test('BlockedError rejects non-string evidence entries', () => {
  assert.throws(() => new BlockedError('blocked', [123]), /evidence/i);
  assert.throws(() => new BlockedError('blocked', ['ok', '']), /evidence/i);
});

test('BlockedError evidence array is frozen/copied, not shared reference mutation', () => {
  const evidence = ['a', 'b'];
  const err = new BlockedError('blocked', evidence);
  evidence.push('c');
  assert.deepEqual(err.evidence, ['a', 'b']);
});
