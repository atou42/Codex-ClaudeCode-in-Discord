import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, calculateProgressFingerprint } from '../../src/cohub-claude-goal/snapshot.js';

describe('snapshot adversarial boundary tests', () => {
  describe('proxy zero-trap at every boundary', () => {
    it('rejects proxy in localState before any access', async () => {
      const attackLocalState = new Proxy(
        { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' },
        {
          get(target, prop) {
            throw new Error('LOCALSTATE_PROXY_TRAP_EXECUTED');
          }
        }
      );

      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };

      await assert.rejects(
        async () => createSnapshot('g1', cohubReader, ledger, attackLocalState),
        /LOCALSTATE_PROXY_TRAP_EXECUTED|Proxy/,
        'must reject localState proxy before any property access'
      );
    });

    it('rejects proxy in cohubReader before any access', async () => {
      const attackReader = new Proxy(
        {
          readRunFile: async () => ({ status: 'IN_PROGRESS' }),
          getSessionIndex: async () => ({ turns: [] }),
          getTurn: async () => null
        },
        {
          get(target, prop) {
            throw new Error('READER_PROXY_TRAP_EXECUTED');
          }
        }
      );

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      await assert.rejects(
        async () => createSnapshot('g1', attackReader, ledger, localState),
        /READER_PROXY_TRAP_EXECUTED|Proxy/,
        'must reject cohubReader proxy before any property access'
      );
    });

    it('rejects proxy in ledger before any access', async () => {
      const attackLedger = new Proxy(
        { events: [], actionSlots: [], trackedTurns: [] },
        {
          get(target, prop) {
            throw new Error('LEDGER_PROXY_TRAP_EXECUTED');
          }
        }
      );

      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      await assert.rejects(
        async () => createSnapshot('g1', cohubReader, attackLedger, localState),
        /LEDGER_PROXY_TRAP_EXECUTED|Proxy/,
        'must reject ledger proxy before any property access'
      );
    });

    it('rejects nested proxy in state.tasks array', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: [
            new Proxy({ id: 'task1' }, {
              get() { throw new Error('NESTED_TASK_PROXY_EXECUTED'); }
            })
          ]
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'INPUT_VALIDATION_FAILED'));
    });
  });

  describe('sanitizeUntrusted must reject unknown keys', () => {
    it('rejects state with unknown fields not in allowlist', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          stage: 'creation',
          unknownField: 'should-cause-rejection',
          anotherUnknown: 'also-reject'
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'UNKNOWN_FIELD_REJECTED'));
    });
  });

  describe('depth and size bounds', () => {
    it('rejects deeply nested object beyond depth limit', async () => {
      let deep = { value: 'end' };
      for (let i = 0; i < 150; i++) {
        deep = { nested: deep };
      }

      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: [deep]
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'DEPTH_LIMIT_EXCEEDED'));
    });

    it('rejects oversized array beyond element limit', async () => {
      const hugeTasks = [];
      for (let i = 0; i < 10000; i++) {
        hugeTasks.push({ id: `task-${i}`, status: 'PENDING' });
      }

      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: hugeTasks
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'SIZE_LIMIT_EXCEEDED'));
    });

    it('rejects string exceeding length limit', async () => {
      const hugeString = 'x'.repeat(1_000_000);

      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          nextAction: hugeString
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'STRING_TOO_LONG'));
    });
  });

  describe('number validation', () => {
    it('rejects NaN in nested number field', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: [{ id: 'task1', priority: NaN }]
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'INVALID_NUMBER'));
    });

    it('rejects Infinity in nested number field', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: [{ id: 'task1', weight: Infinity }]
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'INVALID_NUMBER'));
    });
  });

  describe('no error message leaks', () => {
    it('does not leak key names in error messages', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          secretApiKey: 'sk-12345',
          internalToken: 'tok_secret'
        }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);

      if (snapshot.integrityErrors) {
        for (const err of snapshot.integrityErrors) {
          const msg = JSON.stringify(err);
          assert.ok(!msg.includes('secretApiKey'), 'must not leak key name secretApiKey');
          assert.ok(!msg.includes('internalToken'), 'must not leak key name internalToken');
          assert.ok(!msg.includes('sk-12345'), 'must not leak value');
          assert.ok(!msg.includes('tok_secret'), 'must not leak value');
        }
      }
    });
  });

  describe('structured integrity errors instead of fake hashes', () => {
    it('returns structured error for missing parent identity, not "error" hash', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING' }; // Missing parentSpaceId, parentSessionId

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);

      assert.notStrictEqual(snapshot.snapshotHash, 'error', 'must not return fake "error" hash');
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors);
      assert.ok(snapshot.integrityErrors.some(e => e.code === 'MISSING_REQUIRED_IDENTITY'));
    });

    it('returns structured error for authority read failure', async () => {
      const cohubReader = {
        readRunFile: async () => {
          throw new Error('Network timeout');
        },
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);

      assert.notStrictEqual(snapshot.snapshotHash, 'error');
      assert.notStrictEqual(snapshot.progressFingerprint, 'error');
      assert.strictEqual(snapshot.snapshotHash, 'integrity_failure');
      assert.ok(snapshot.integrityErrors?.some(e => e.code === 'AUTHORITY_READ_FAILURE'));
    });
  });

  describe('REG-67-01 must use exact workerId', () => {
    it('must not use fallback "unknown" workerId in decision', async () => {
      const cohubReader = {
        readRunFile: async (spaceId, path) => {
          if (path === 'orchestration_state.json') {
            return {
              status: 'IN_PROGRESS',
              stage: 'creation',
              tasks: [
                { id: 'materials', status: 'COMPLETE', count: '148/148' },
                { id: 'geography', status: 'DISPATCHED' },
                { id: 'geography-replacement', status: 'COMPLETED' } // Missing workerId
              ]
            };
          }
          if (path === 'stage_gate_log.json') {
            return { gates: [{ id: 'atoms-gate', status: 'PENDING' }] };
          }
          if (path === 'run_manifest.json') {
            return { id: 'manifest-v1' };
          }
          return null;
        },
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => ({ status: 'completed' })
      };

      const ledger = { events: [], actionSlots: [], replacementReceipts: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);

      if (snapshot.decision === 'RECONCILE_AND_FAN_IN' && snapshot.nextActions) {
        const action = snapshot.nextActions[0];
        assert.notStrictEqual(action.workerId, 'unknown', 'must not use fallback "unknown" workerId');
        assert.ok(snapshot.integrityErrors?.some(e => e.code === 'MISSING_WORKER_ID'));
      }
    });
  });

  describe('generation race in reconcile double-read', () => {
    it('detects inconsistent parent index across two reads', async () => {
      let readCount = 0;
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => {
          readCount += 1;
          // Return different sequence on second read
          return { turns: [], sequence: readCount };
        },
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        parentSpaceId: 'space',
        parentSessionId: 'session',
        status: 'RUNNING',
        lastConsumedUserTurn: null
      };

      // Current code reads parent index twice without consistency check
      const { reconcile } = await import('../../src/cohub-claude-goal/reconcile.js');
      const result = await reconcile('g1', cohubReader, ledger, localState);

      // Must detect the race and refuse to proceed
      assert.ok(result.mustReconcile || result.stale, 'must detect parent index changed between reads');
    });
  });

  describe('unconsumed input must check all Turn types', () => {
    it('detects unconsumed assistant Turn without clientMessageId as external', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({
          turns: ['turn1', 'turn2', 'turn3'],
          turns_metadata: {
            turn1: { role: 'user', sequence: 1 },
            turn2: { role: 'assistant', sequence: 2 }, // Bridge-created continuations have clientMessageId
            turn3: { role: 'assistant', sequence: 3 }  // External without clientMessageId
          },
          sequence: 3
        }),
        getTurn: async () => null
      };

      const ledger = {
        events: [],
        actionSlots: [],
        registeredContinuations: new Set(['turn2']) // Only turn2 is registered
      };

      const localState = {
        parentSpaceId: 'space',
        parentSessionId: 'session',
        status: 'RUNNING',
        lastConsumedUserTurn: 'turn1'
      };

      const { reconcile } = await import('../../src/cohub-claude-goal/reconcile.js');
      const result = await reconcile('g1', cohubReader, ledger, localState);

      // turn3 is external input (not registered), must be detected
      assert.ok(result.hasUnconsumedInput, 'must detect unregistered assistant Turn as external input');
    });
  });

  describe('output immutability', () => {
    it('deeply freezes all nested integrity errors', async () => {
      const cohubReader = {
        readRunFile: async () => {
          const circular = { status: 'IN_PROGRESS' };
          circular.self = circular;
          return circular;
        },
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);

      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.integrityErrors));

      if (snapshot.integrityErrors && snapshot.integrityErrors.length > 0) {
        for (const err of snapshot.integrityErrors) {
          assert.ok(Object.isFrozen(err), 'each integrity error must be frozen');
        }
      }
    });

    it('deeply freezes all receipts', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [], sequence: 1 }),
        getTurn: async () => null
      };

      const ledger = {
        events: [],
        actionSlots: [],
        replacementReceipts: [
          { workerId: 'w1', artifacts: ['a1', 'a2'] }
        ]
      };
      const localState = { parentSpaceId: 'space', parentSessionId: 'session', status: 'RUNNING' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);

      assert.ok(Object.isFrozen(snapshot.receipts));
      for (const receipt of snapshot.receipts) {
        assert.ok(Object.isFrozen(receipt), 'each receipt must be frozen');
        if (receipt.artifacts) {
          assert.ok(Object.isFrozen(receipt.artifacts), 'nested arrays must be frozen');
        }
      }
    });
  });

  describe('canonical hash stability', () => {
    it('produces identical hash when no facts changed', async () => {
      const cohubReader = {
        readRunFile: async (spaceId, path) => {
          if (path === 'orchestration_state.json') {
            return {
              status: 'IN_PROGRESS',
              stage: 'creation',
              tasks: [{ id: 'task1', status: 'PENDING' }]
            };
          }
          if (path === 'stage_gate_log.json') {
            return { gates: [] };
          }
          if (path === 'run_manifest.json') {
            return { id: 'manifest-v1' };
          }
          return {};
        },
        getSessionIndex: async () => ({ turns: [], sequence: 5 }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        parentSpaceId: 'space',
        parentSessionId: 'session',
        status: 'RUNNING'
      };

      const s1 = await createSnapshot('g1', cohubReader, ledger, localState);
      const s2 = await createSnapshot('g1', cohubReader, ledger, localState);

      assert.strictEqual(s1.snapshotHash, s2.snapshotHash, 'identical facts must produce identical hash');
      assert.notStrictEqual(s1.snapshotHash, 'error');
      assert.notStrictEqual(s1.snapshotHash, 'integrity_failure');
    });
  });
});
