import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, deduplicateEvents } from '../../src/cohub-claude-goal/reconcile.js';

describe('reconcile', () => {
  describe('event deduplication', () => {
    it('EVT-04: deduplicates by event ID', () => {
      const events = [
        { id: 'evt-1', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' },
        { id: 'evt-1', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' },
        { id: 'evt-1', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' }
      ];

      const seen = new Set();
      const deduplicated = deduplicateEvents(events, seen);

      assert.strictEqual(deduplicated.length, 1);
      assert.strictEqual(seen.size, 2); // event ID + logical key
    });

    it('EVT-04: deduplicates by logical terminal family', () => {
      const events = [
        { id: 'evt-1', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' },
        { id: 'evt-2', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' },
        { id: 'evt-3', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' }
      ];

      const seen = new Set();
      const deduplicated = deduplicateEvents(events, seen);

      assert.strictEqual(deduplicated.length, 1);
      assert.strictEqual(seen.size, 4); // 3 event IDs + 1 shared logical key
    });

    it('EVT-04: allows different turns with same event ID pattern', () => {
      const events = [
        { id: 'evt-1', spaceId: 's1', sessionId: 'sess1', turnId: 't1', status: 'completed' },
        { id: 'evt-2', spaceId: 's1', sessionId: 'sess1', turnId: 't2', status: 'completed' }
      ];

      const seen = new Set();
      const deduplicated = deduplicateEvents(events, seen);

      assert.strictEqual(deduplicated.length, 2);
    });

    it('EVT-04: handles 100 replays with same event ID', () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: 'evt-same',
        spaceId: 's1',
        sessionId: 'sess1',
        turnId: 't1',
        status: 'completed',
        index: i
      }));

      const seen = new Set();
      const deduplicated = deduplicateEvents(events, seen);

      assert.strictEqual(deduplicated.length, 1);
    });
  });

  describe('generation race protocol', () => {
    it('EVT-02: detects snapshot change during HTTP read', async () => {
      let generation = 0;
      const cohubReader = {
        readRunFile: async () => {
          generation += 1;
          return { status: 'IN_PROGRESS' };
        },
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        parentSpaceId: 'test-space',
        parentSessionId: 'test-session',
        status: 'RUNNING',
        parentSequence: 1,
        observedGeneration: 0,
        getGeneration: () => generation
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.stale || result.observedGeneration > 0);
    });

    it('EVT-02: detects event arrival in park critical section', async () => {
      let eventInjected = false;
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        parentSpaceId: 'test-space',
        parentSessionId: 'test-session',
        status: 'RUNNING',
        parentSequence: 1,
        observedGeneration: 0,
        getGeneration: () => (eventInjected ? 1 : 0)
      };

      // Simulate event arriving before park
      eventInjected = true;

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.mustReconcile || result.observedGeneration > 0);
    });
  });

  describe('reconnect reconciliation', () => {
    it('EVT-03: performs full reconciliation after reconnect', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: ['turn-1'] }),
        getTurn: async (spaceId, sessionId, turnId) => {
          if (turnId === 'turn-1') {
            return { id: 'turn-1', status: 'completed' };
          }
          return null;
        }
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 'turn-1', spaceId: 's1', sessionId: 'sess1' }]
      };
      const localState = {
        parentSpaceId: 'test-space',
        parentSessionId: 'test-session',
        status: 'RUNNING',
        parentSequence: 1,
        reconnected: true
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.snapshot);
      assert.ok(result.snapshot.workerStates?.some((w) => w.turnId === 'turn-1'));
    });
  });

  describe('user input watermark', () => {
    it('CON-02: blocks continuation when unconsumed user input exists', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({
          turns: ['turn-1', 'turn-2'],
          turns_metadata: { 'turn-1': { role: 'user' }, 'turn-2': { role: 'user' } }
        }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        status: 'RUNNING',
        parentSequence: 1,
        lastConsumedUserTurn: 'turn-1',
        parentSpaceId: 's1',
        parentSessionId: 'sess1'
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.hasUnconsumedInput);
      assert.strictEqual(result.snapshot?.decision, 'BLOCKED_UNCONSUMED_INPUT');
    });

    it('CON-02: allows continuation when all user input consumed', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({
          turns: ['turn-1'],
          turns_metadata: { 'turn-1': { role: 'user' } }
        }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        status: 'RUNNING',
        parentSequence: 1,
        lastConsumedUserTurn: 'turn-1',
        parentSpaceId: 's1',
        parentSessionId: 'sess1'
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(!result.hasUnconsumedInput);
    });

    it('CON-02: detects multiple unconsumed user turns between watermark and latest', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({
          turns: ['turn-1', 'turn-2', 'turn-3', 'turn-4'],
          turns_metadata: {
            'turn-1': { role: 'user' },
            'turn-2': { role: 'assistant' },
            'turn-3': { role: 'user' },
            'turn-4': { role: 'user' }
          }
        }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        status: 'RUNNING',
        parentSequence: 1,
        lastConsumedUserTurn: 'turn-1',
        parentSpaceId: 's1',
        parentSessionId: 'sess1'
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.hasUnconsumedInput, 'must detect unconsumed turn-3 and turn-4');
    });
  });

  describe('merged-chain tracking', () => {
    it('EVT-06: follows merged turn to real terminal', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: ['turn-1', 'turn-2', 'turn-3'] }),
        getTurn: async (spaceId, sessionId, turnId) => {
          if (turnId === 'turn-1') {
            return { id: 'turn-1', status: 'merged', mergedIntoTurnId: 'turn-2' };
          }
          if (turnId === 'turn-2') {
            return { id: 'turn-2', status: 'merged', continuedByTurnId: 'turn-3' };
          }
          if (turnId === 'turn-3') {
            return { id: 'turn-3', status: 'completed' };
          }
          return null;
        }
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 'turn-1', spaceId: 's1', sessionId: 'sess1' }]
      };
      const localState = { parentSpaceId: 'test-space', parentSessionId: 'test-session', status: 'RUNNING', parentSequence: 42 };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      const worker = result.snapshot.workerStates.find((w) => w.originalTurnId === 'turn-1');
      assert.strictEqual(worker?.resolvedStatus, 'completed');
      assert.ok(worker?.mergeChain?.includes('turn-2'));
      assert.ok(worker?.mergeChain?.includes('turn-3'));
    });

    it('EVT-06: rejects treating merged as permanent wait', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: ['turn-1'] }),
        getTurn: async (spaceId, sessionId, turnId) => {
          if (turnId === 'turn-1') {
            return { id: 'turn-1', status: 'merged', mergedIntoTurnId: 'turn-2' };
          }
          return null;
        }
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 'turn-1', spaceId: 's1', sessionId: 'sess1' }]
      };
      const localState = { parentSpaceId: 'test-space', parentSessionId: 'test-session', status: 'RUNNING', parentSequence: 42 };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      const worker = result.snapshot.workerStates.find((w) => w.originalTurnId === 'turn-1');
      assert.notStrictEqual(worker?.resolvedStatus, 'merged');
      assert.ok(worker?.integrityError || worker?.resolvedStatus === 'completed' || worker?.resolvedStatus === 'failed');
    });
  });

  describe('wrong space/session/path validation', () => {
    it('rejects turn from wrong space', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 't1', spaceId: 'wrong-space', sessionId: 's1' }]
      };
      const localState = {
        parentSpaceId: 'test-space',
        parentSessionId: 'test-session',
        status: 'RUNNING',
        parentSequence: 1,
        allowedSpaces: ['correct-space']
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.snapshot.integrityErrors?.some((e) => e.field.includes('space')));
    });

    it('rejects turn from wrong session pattern', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 't1', spaceId: 's1', sessionId: 'unregistered-session' }]
      };
      const localState = {
        parentSpaceId: 'test-space',
        parentSessionId: 'test-session',
        status: 'RUNNING',
        parentSequence: 1,
        allowedSessions: ['parent-session', 'worker-session-1']
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.snapshot.integrityErrors?.some((e) => e.field.includes('session')));
    });
  });

  describe('current migration verdict', () => {
    it('REG-67-01: migration doctor returns UNBOUND_REPLACEMENT_RECEIPT', async () => {
      const cohubReader = {
        readRunFile: async (spaceId, path) => {
          if (path === 'orchestration_state.json') {
            return {
              status: 'IN_PROGRESS',
              parent: 'parent-session-id',
              tasks: [
                { id: 'geography-replacement', status: 'COMPLETED', workerId: 'replacement-worker' }
              ]
            };
          }
          if (path === 'stage_gate_log.json') {
            return { gates: [] };
          }
          if (path === 'run_manifest.json') {
            return { id: 'manifest-v1' };
          }
          return { gates: [] };
        },
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [], replacementReceipts: [] };
      const localState = {
        status: 'RUNNING',
        parentSequence: 1,
        migrationMode: true,
        parentSpaceId: 's1',
        parentSessionId: 'sess1'
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.strictEqual(result.migrationVerdict, 'UNBOUND_REPLACEMENT_RECEIPT');
    });
  });

  describe('stale snapshot detection', () => {
    it('detects parent sequence change', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [], sequence: 50 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        parentSpaceId: 'test-space',
        parentSessionId: 'test-session',
        status: 'RUNNING',
        parentSequence: 42,
        expectedParentSequence: 42
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.snapshot.stale || result.snapshot.currentParentSequence !== 42);
    });

    it('detects input watermark change', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({
          turns: ['turn-1', 'turn-2'],
          turns_metadata: { 'turn-1': { role: 'user' }, 'turn-2': { role: 'user' } }
        }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        status: 'RUNNING',
        parentSequence: 1,
        lastConsumedUserTurn: 'turn-1',
        expectedInputWatermark: 'turn-1',
        parentSpaceId: 's1',
        parentSessionId: 'sess1'
      };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(result.hasUnconsumedInput);
    });
  });

  describe('adversarial input protection', () => {
    it('rejects event with descriptor getter', async () => {
      const attackEvent = {};
      Object.defineProperty(attackEvent, 'id', {
        get() { throw new Error('GETTER_IN_EVENT'); },
        enumerable: true
      });

      const seen = new Set();
      assert.throws(
        () => deduplicateEvents([attackEvent], seen),
        /malicious event|Accessor property/,
        'must not execute getters in untrusted events'
      );
    });

    it('freezes snapshot before returning to prevent tampering', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'test-space', parentSessionId: 'test-session', status: 'RUNNING', parentSequence: 42 };

      const result = await reconcile('g1', cohubReader, ledger, localState);
      assert.ok(Object.isFrozen(result.snapshot), 'snapshot must be frozen');
    });
  });
});
