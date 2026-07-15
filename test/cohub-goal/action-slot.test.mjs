import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateActionSlot,
  recoverActionSlot,
  ALLOWED_DECISIONS,
  PHASES,
  assertDecisionCode,
  assertSnapshotHash,
  validateSlotHistory,
} from '../../src/cohub-claude-goal/action-slot.js';

describe('action-slot', () => {
  describe('ALLOWED_DECISIONS allowlist', () => {
    it('should reject decision codes not in allowlist', () => {
      assert.throws(() => assertDecisionCode('codex-dispatch'), /not allowlisted/);
      assert.throws(() => assertDecisionCode('arbitrary-code'), /not allowlisted/);
      assert.doesNotThrow(() => assertDecisionCode('action-start'));
      assert.doesNotThrow(() => assertDecisionCode('worker-dispatch'));
    });
  });

  describe('snapshot hash validation', () => {
    it('should require 64-character lowercase hex', () => {
      assert.throws(() => assertSnapshotHash('short', 'test'), /64-character lowercase-hex/);
      assert.throws(() => assertSnapshotHash('G' + '0'.repeat(63), 'test'), /64-character lowercase-hex/);
      assert.doesNotThrow(() => assertSnapshotHash('a'.repeat(64), 'test'));
    });
  });

  describe('generateActionSlot', () => {
    it('should generate collision-resistant IDs including all bindings', () => {
      const slot1 = generateActionSlot({
        goalVersion: 'v1',
        snapshotHash: 'a'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      });

      const slot2 = generateActionSlot({
        goalVersion: 'v1',
        snapshotHash: 'a'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 6, // Changed binding
        expectedInputWatermark: 2,
      });

      assert.ok(slot1.actionSlotId.startsWith('slot-'));
      assert.ok(slot1.continuationId.startsWith('cont-'));
      assert.notStrictEqual(slot1.actionSlotId, slot2.actionSlotId, 'IDs must include expectedParentSequence');
      assert.notStrictEqual(slot1.continuationId, slot2.continuationId);
    });

    it('should produce full 64-hex hash (collision-resistant)', () => {
      const slot = generateActionSlot({
        goalVersion: 'v1',
        snapshotHash: 'b'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      });

      const hashPart = slot.actionSlotId.replace('slot-', '');
      assert.strictEqual(hashPart.length, 64);
      assert.match(hashPart, /^[0-9a-f]{64}$/);
    });

    it('should freeze returned slot', () => {
      const slot = generateActionSlot({
        goalVersion: 'v1',
        snapshotHash: 'c'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      });

      assert.throws(() => { slot.actionSlotId = 'modified'; });
    });

    it('should reject exact-own-keys violations', () => {
      assert.throws(() => generateActionSlot({
        goalVersion: 'v1',
        snapshotHash: 'a'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
        extraField: 'bad',
      }), /unexpected key/);
    });

    it('should reject dangerous values (accessors, symbols, cycles)', () => {
      const objWithGetter = {};
      Object.defineProperty(objWithGetter, 'foo', { get: () => 'bar' });

      assert.throws(() => generateActionSlot(objWithGetter), /accessors/);
    });
  });

  describe('validateSlotHistory', () => {
    it('should enforce legal phase transitions', () => {
      assert.throws(() => validateSlotHistory([
        { phase: PHASES.PREPARED, actionSlotId: 'slot-1', continuationId: 'cont-1' },
      ]), /illegal phase transition 'NONE' -> 'PREPARED'/);

      assert.doesNotThrow(() => validateSlotHistory([
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ]));
    });

    it('should reject changed bindings across phases', () => {
      assert.throws(() => validateSlotHistory([
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-2', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ]), /actionSlotId changed/);

      assert.throws(() => validateSlotHistory([
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-1', continuationId: 'cont-2', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ]), /continuationId changed/);
    });
  });

  describe('recoverActionSlot', () => {
    it('should enforce at most one unfinished slot', () => {
      const ledger = [
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-2', continuationId: 'cont-2', expectedSnapshotHash: 'b'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ];

      assert.throws(() => recoverActionSlot({
        ledgerEntries: ledger,
        currentSnapshotHash: 'a'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      }), /multiple unfinished action slots/);
    });

    it('should return OBSERVED recovery with requiresPrepareBefore flag', () => {
      const ledger = [
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ];

      const result = recoverActionSlot({
        ledgerEntries: ledger,
        currentSnapshotHash: 'a'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      });

      assert.strictEqual(result.phase, PHASES.OBSERVED);
      assert.strictEqual(result.canSafelySend, false);
      assert.strictEqual(result.requiresPrepareBefore, true);
    });

    it('should return PREPARED recovery when snapshot matches', () => {
      const ledger = [
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ];

      const result = recoverActionSlot({
        ledgerEntries: ledger,
        currentSnapshotHash: 'a'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      });

      assert.strictEqual(result.phase, PHASES.PREPARED);
      assert.strictEqual(result.canSafelySend, true);
      assert.strictEqual(result.isRecovered, true);
    });

    it('should return CANCELLED_STALE_BEFORE_SEND with mustPersistCancellation when snapshot changed', () => {
      const ledger = [
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      ];

      const result = recoverActionSlot({
        ledgerEntries: ledger,
        currentSnapshotHash: 'b'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      });

      assert.strictEqual(result.phase, PHASES.CANCELLED_STALE_BEFORE_SEND);
      assert.strictEqual(result.canSafelySend, false);
      assert.strictEqual(result.mustPersistCancellation, true);
      assert.ok(result.evidence);
    });

    it('should return mustReconcile for REQUEST_STARTED or AMBIGUOUS', () => {
      const ledger = [
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-1', continuationId: 'cont-1', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
        { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-1', continuationId: 'cont-1' },
      ];

      const result = recoverActionSlot({
        ledgerEntries: ledger,
        currentSnapshotHash: 'a'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      });

      assert.strictEqual(result.phase, PHASES.REQUEST_STARTED);
      assert.strictEqual(result.mustReconcile, true);
      assert.strictEqual(result.canSafelySend, false);
    });

    it('should generate new slot when no unfinished slots exist', () => {
      const ledger = [
        { phase: PHASES.OBSERVED, actionSlotId: 'slot-old', continuationId: 'cont-old', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 3, expectedInputWatermark: 1 },
        { phase: PHASES.PREPARED, actionSlotId: 'slot-old', continuationId: 'cont-old', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 3, expectedInputWatermark: 1 },
        { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-old', continuationId: 'cont-old' },
        { phase: PHASES.CONFIRMED, actionSlotId: 'slot-old', continuationId: 'cont-old', turnId: 'turn-1' },
      ];

      const result = recoverActionSlot({
        ledgerEntries: ledger,
        currentSnapshotHash: 'b'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'worker-dispatch',
        attempt: 0,
        expectedParentSequence: 5,
        expectedInputWatermark: 2,
      });

      assert.strictEqual(result.phase, 'NEW');
      assert.ok(result.actionSlotId);
      assert.notStrictEqual(result.actionSlotId, 'slot-old');
      assert.strictEqual(result.isRecovered, false);
    });
  });
});
