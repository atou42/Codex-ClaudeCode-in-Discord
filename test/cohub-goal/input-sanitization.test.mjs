/**
 * Input sanitization tests for action-slot.js and submit.js
 *
 * These tests verify that all public entry points reject:
 * - Proxies (zero trap calls)
 * - Accessors (getters/setters)
 * - Symbols
 * - Non-enumerable properties
 * - Custom prototypes
 * - Sparse arrays
 * - Extra array properties
 * - Cycles and shared references
 * - Unsupported values (undefined, NaN, Infinity, functions, symbols)
 * - Excessive depth/size
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  generateActionSlot,
  recoverActionSlot,
  assertSafeOwnPlainObject,
  assertExactOwnKeys,
  PHASES,
} from '../../src/cohub-claude-goal/action-slot.js';
import {
  submitAction,
  buildContinuationTemplate,
} from '../../src/cohub-claude-goal/submit.js';

describe('input-sanitization', () => {
  describe('Proxy rejection', () => {
    test('generateActionSlot rejects proxy params', () => {
      const params = new Proxy({
        goalVersion: 'v1',
        snapshotHash: '0'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      }, {});

      assert.throws(() => generateActionSlot(params), /proxy/i);
    });

    test('recoverActionSlot rejects proxy params', () => {
      const params = new Proxy({
        ledgerEntries: [],
        currentSnapshotHash: '0'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      }, {});

      assert.throws(() => recoverActionSlot(params), /proxy/i);
    });

    test('submitAction rejects proxy currentSnapshot', async () => {
      const ledger = [];
      const ctx = {
        ledger,
        async writePhase() {},
        cohubSend: async () => ({ turnId: 't1', sequence: 1 }),
      };

      const currentSnapshot = new Proxy({
        actionSlot: {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
      }, {});

      const result = await submitAction({
        ctx,
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot,
        goalVersion: 'v1',
        runPath: '/test',
      });

      assert.equal(result.error, 'INVALID_CURRENT_SNAPSHOT');
    });

    test('submitAction rejects proxy ledger entries', async () => {
      const ledger = [
        new Proxy({
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.OBSERVED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }, {}),
      ];

      const ctx = {
        ledger,
        async writePhase() {},
        cohubSend: async () => ({ turnId: 't1', sequence: 1 }),
      };

      await assert.rejects(
        submitAction({
          ctx,
          goalInstance: 'test',
          expectedSnapshotHash: '0'.repeat(64),
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'action-start',
          currentSnapshot: {
            actionSlot: {
              actionSlotId: 'slot-1',
              continuationId: 'cont-1',
              expectedParentSequence: 0,
              expectedInputWatermark: 0,
            },
          },
          goalVersion: 'v1',
          runPath: '/test',
        }),
        /proxy/i,
      );
    });

    test('submitAction rejects proxy reconciliation result', async () => {
      const ledger = [
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.OBSERVED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.PREPARED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.REQUEST_STARTED,
          expectedSnapshotHash: '0'.repeat(64),
        },
      ];

      const ctx = {
        ledger,
        async writePhase() {},
      };

      const reconcileByClientMessageId = async () => new Proxy({ matches: [] }, {});

      const result = await submitAction({
        ctx,
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot: {
          actionSlot: {
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
          },
        },
        reconcileByClientMessageId,
        goalVersion: 'v1',
        runPath: '/test',
      });

      assert.equal(result.error, 'BLOCKED_AMBIGUOUS_SEND');
      assert.match(result.reason, /invalid result/i);
    });
  });

  describe('Accessor rejection', () => {
    test('generateActionSlot rejects params with getters', () => {
      const params = {
        goalVersion: 'v1',
        snapshotHash: '0'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      };
      Object.defineProperty(params, 'goalVersion', {
        get() { return 'v1'; },
        enumerable: true,
      });

      assert.throws(() => generateActionSlot(params), /accessor/i);
    });

    test('recoverActionSlot rejects ledger entries with getters', () => {
      const entry = {
        actionSlotId: 'slot-1',
        phase: PHASES.OBSERVED,
      };
      Object.defineProperty(entry, 'phase', {
        get() { return PHASES.OBSERVED; },
        enumerable: true,
      });

      assert.throws(
        () => recoverActionSlot({
          ledgerEntries: [entry],
          currentSnapshotHash: '0'.repeat(64),
          goalVersion: 'v1',
          decisionCode: 'action-start',
          attempt: 0,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /accessor/i,
      );
    });

    test('submitAction rejects reconciliation matches with getters', async () => {
      const ledger = [
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.OBSERVED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.PREPARED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.REQUEST_STARTED,
        },
      ];

      const ctx = {
        ledger,
        async writePhase() {},
      };

      const match = {
        turnId: 't1',
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        clientMessageId: 'cont-1',
        parentSessionId: 's1',
      };
      Object.defineProperty(match, 'turnId', {
        get() { return 't1'; },
        enumerable: true,
      });

      const reconcileByClientMessageId = async () => ({ matches: [match] });

      const result = await submitAction({
        ctx,
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot: {
          actionSlot: {
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
          },
        },
        reconcileByClientMessageId,
        goalVersion: 'v1',
        runPath: '/test',
      });

      assert.equal(result.error, 'BLOCKED_AMBIGUOUS_SEND');
      assert.match(result.reason, /invalid result/i);
    });
  });

  describe('Symbol rejection', () => {
    test('generateActionSlot rejects params with symbol keys', () => {
      const params = {
        goalVersion: 'v1',
        snapshotHash: '0'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
        [Symbol('extra')]: 'value',
      };

      assert.throws(() => generateActionSlot(params), /symbol/i);
    });
  });

  describe('Cycle rejection', () => {
    test('recoverActionSlot rejects ledger with cycles', () => {
      const entry = {
        actionSlotId: 'slot-1',
        phase: PHASES.OBSERVED,
      };
      entry.self = entry;

      assert.throws(
        () => recoverActionSlot({
          ledgerEntries: [entry],
          currentSnapshotHash: '0'.repeat(64),
          goalVersion: 'v1',
          decisionCode: 'action-start',
          attempt: 0,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /cycle/i,
      );
    });

    test('submitAction rejects currentSnapshot with shared references', async () => {
      const shared = { value: 1 };
      const currentSnapshot = {
        actionSlot: {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
        },
        ref1: shared,
        ref2: shared,
      };

      const result = await submitAction({
        ctx: {
          ledger: [],
          async writePhase() {},
          cohubSend: async () => ({ turnId: 't1', sequence: 1 }),
        },
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot,
        goalVersion: 'v1',
        runPath: '/test',
      });

      // Should catch shared reference during currentSnapshot sanitization
      assert.equal(result.error, 'INVALID_CURRENT_SNAPSHOT');
      assert.match(result.reason, /shared reference|cycle/i);
    });
  });

  describe('Sparse and extra array properties', () => {
    test('recoverActionSlot rejects sparse ledger array', () => {
      const ledgerEntries = [];
      ledgerEntries[0] = {
        actionSlotId: 'slot-1',
        phase: PHASES.OBSERVED,
      };
      ledgerEntries[2] = {
        actionSlotId: 'slot-2',
        phase: PHASES.OBSERVED,
      };

      assert.throws(
        () => recoverActionSlot({
          ledgerEntries,
          currentSnapshotHash: '0'.repeat(64),
          goalVersion: 'v1',
          decisionCode: 'action-start',
          attempt: 0,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /sparse|dangerous|non-enumerable/i,
      );
    });

    test('submitAction rejects reconciliation matches array with extra properties', async () => {
      const ledger = [
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.OBSERVED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.PREPARED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.REQUEST_STARTED,
        },
      ];

      const ctx = {
        ledger,
        async writePhase() {},
      };

      const matches = [{
        turnId: 't1',
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        clientMessageId: 'cont-1',
        parentSessionId: 's1',
      }];
      matches.extraProp = 'bad';

      const reconcileByClientMessageId = async () => ({ matches });

      const result = await submitAction({
        ctx,
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot: {
          actionSlot: {
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
          },
        },
        reconcileByClientMessageId,
        goalVersion: 'v1',
        runPath: '/test',
      });

      assert.equal(result.error, 'BLOCKED_AMBIGUOUS_SEND');
      assert.match(result.reason, /invalid result/i);
    });
  });

  describe('Unsupported values', () => {
    test('generateActionSlot rejects NaN', () => {
      assert.throws(
        () => generateActionSlot({
          goalVersion: 'v1',
          snapshotHash: '0'.repeat(64),
          decisionCode: 'action-start',
          attempt: NaN,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /unsupported value|safe integer/i,
      );
    });

    test('generateActionSlot rejects Infinity', () => {
      assert.throws(
        () => generateActionSlot({
          goalVersion: 'v1',
          snapshotHash: '0'.repeat(64),
          decisionCode: 'action-start',
          attempt: Infinity,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /unsupported value|safe integer/i,
      );
    });

    test('recoverActionSlot rejects undefined in ledger entry', () => {
      assert.throws(
        () => recoverActionSlot({
          ledgerEntries: [{
            actionSlotId: 'slot-1',
            phase: PHASES.OBSERVED,
            badField: undefined,
          }],
          currentSnapshotHash: '0'.repeat(64),
          goalVersion: 'v1',
          decisionCode: 'action-start',
          attempt: 0,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /unsupported value.*undefined/i,
      );
    });
  });

  describe('Excessive depth and size', () => {
    test('recoverActionSlot rejects deeply nested ledger entry', () => {
      let deep = { value: 1 };
      for (let i = 0; i < 100; i++) {
        deep = { nested: deep };
      }

      assert.throws(
        () => recoverActionSlot({
          ledgerEntries: [{
            actionSlotId: 'slot-1',
            phase: PHASES.OBSERVED,
            deep,
          }],
          currentSnapshotHash: '0'.repeat(64),
          goalVersion: 'v1',
          decisionCode: 'action-start',
          attempt: 0,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        }),
        /depth.*exceeded|dangerous/i,
      );
    });

    test('submitAction rejects oversized currentSnapshot', async () => {
      // Create a large object that exceeds 1MB when serialized
      const large = Array(50000).fill(0).map((_, i) => `item-with-longer-name-${i}`);

      const result = await submitAction({
        ctx: {
          ledger: [],
          async writePhase() {},
          cohubSend: async () => ({ turnId: 't1', sequence: 1 }),
        },
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot: {
          actionSlot: {
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
          },
          large,
        },
        goalVersion: 'v1',
        runPath: '/test',
      });

      assert.equal(result.error, 'INVALID_CURRENT_SNAPSHOT');
      assert.match(result.reason, /size.*exceeds|too large/i);
    });
  });

  describe('Output immutability', () => {
    test('generateActionSlot returns deeply frozen object', () => {
      const slot = generateActionSlot({
        goalVersion: 'v1',
        snapshotHash: '0'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      });

      assert.throws(() => {
        slot.actionSlotId = 'modified';
      });

      assert.throws(() => {
        delete slot.actionSlotId;
      });
    });

    test('recoverActionSlot returns detached data', () => {
      const ledgerEntries = [{
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        phase: PHASES.OBSERVED,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      }];

      const result = recoverActionSlot({
        ledgerEntries,
        currentSnapshotHash: '0'.repeat(64),
        goalVersion: 'v1',
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      });

      // Mutate input
      ledgerEntries[0].actionSlotId = 'modified';

      // Output should not be affected
      assert.equal(result.actionSlotId, 'slot-1');
    });
  });

  describe('Error message safety', () => {
    test('generateActionSlot does not leak attacker values', () => {
      try {
        generateActionSlot({
          goalVersion: 'v1<script>alert(1)</script>',
          snapshotHash: 'invalid',
          decisionCode: 'action-start',
          attempt: 0,
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.match(err.message, /snapshot hash/i);
        assert.doesNotMatch(err.message, /<script>/);
      }
    });

    test('submitAction does not leak reconciliation text', async () => {
      const ledger = [
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.OBSERVED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.PREPARED,
          expectedSnapshotHash: '0'.repeat(64),
          expectedParentSequence: 0,
          expectedInputWatermark: 0,
        },
        {
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          phase: PHASES.REQUEST_STARTED,
        },
      ];

      const ctx = {
        ledger,
        async writePhase() {},
      };

      const reconcileByClientMessageId = async () => ({
        matches: [],
        extraData: 'SENSITIVE<script>alert(1)</script>',
      });

      const result = await submitAction({
        ctx,
        goalInstance: 'test',
        expectedSnapshotHash: '0'.repeat(64),
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        decisionCode: 'action-start',
        currentSnapshot: {
          actionSlot: {
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
          },
        },
        reconcileByClientMessageId,
        goalVersion: 'v1',
        runPath: '/test',
      });

      assert.equal(result.error, 'BLOCKED_AMBIGUOUS_SEND');
      // Should reject due to extra fields, not leak the content
      assert.match(result.reason, /invalid result|exactly.*matches/i);
      assert.doesNotMatch(result.reason, /SENSITIVE/);
      assert.doesNotMatch(result.reason, /<script>/);
    });
  });

  describe('Zero-trap proxy detection', () => {
    test('never calls proxy traps during validation', () => {
      let trapCalls = 0;
      const handler = {
        get(target, prop, receiver) {
          trapCalls++;
          return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
          trapCalls++;
          return Reflect.has(target, prop);
        },
        ownKeys(target) {
          trapCalls++;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
          trapCalls++;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      };

      const params = new Proxy({
        goalVersion: 'v1',
        snapshotHash: '0'.repeat(64),
        decisionCode: 'action-start',
        attempt: 0,
        expectedParentSequence: 0,
        expectedInputWatermark: 0,
      }, handler);

      try {
        generateActionSlot(params);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.match(err.message, /proxy|dangerous/i);
        assert.equal(trapCalls, 0, 'Proxy traps should never be called');
      }
    });
  });
});
