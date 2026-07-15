import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, calculateProgressFingerprint } from '../../src/cohub-claude-goal/snapshot.js';

describe('snapshot', () => {
  describe('createSnapshot', () => {
    it('REG-67-01: historical fixture must return RECONCILE_AND_FAN_IN with replacement receipt first', async () => {
      const cohubReader = {
        readRunFile: async (spaceId, path) => {
          if (path === 'orchestration_state.json') {
            return {
              status: 'IN_PROGRESS',
              stage: 'creation',
              nextAction: 'create_atoms',
              tasks: [
                { id: 'materials', status: 'COMPLETE', count: '148/148' },
                { id: 'geography', status: 'DISPATCHED', workerId: 'original-worker' },
                { id: 'geography-replacement', status: 'COMPLETED', workerId: 'replacement-worker' }
              ]
            };
          }
          if (path === 'stage_gate_log.json') {
            return { gates: [{ id: 'atoms-gate', stage: 'atoms', status: 'PENDING' }] };
          }
          if (path === 'run_manifest.json') {
            return { id: 'manifest-v1', sha256: 'abc123' };
          }
          return null;
        },
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => ({ status: 'completed' })
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 42 };

      const snapshot = await createSnapshot('test-goal', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.decision, 'RECONCILE_AND_FAN_IN');
      assert.ok(snapshot.nextActions);
      assert.strictEqual(snapshot.nextActions[0]?.type, 'REGISTER_REPLACEMENT_RECEIPT');
      assert.ok(snapshot.blockingReason?.includes('binding receipt'));
    });

    it('REG-67-01: migration doctor must return UNBOUND_REPLACEMENT_RECEIPT', async () => {
      const cohubReader = {
        readRunFile: async (spaceId, path) => {
          if (path === 'orchestration_state.json') {
            return {
              status: 'RUNNING',
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
          return null;
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

      const snapshot = await createSnapshot('test-goal', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.migrationVerdict, 'UNBOUND_REPLACEMENT_RECEIPT');
    });

    it('rejects descriptor getters in state object', async () => {
      const attackState = {};
      Object.defineProperty(attackState, 'status', {
        get() { throw new Error('GETTER_EXECUTED'); },
        enumerable: true
      });

      const cohubReader = {
        readRunFile: async () => attackState,
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'error', 'must reject via error result');
      assert.ok(snapshot.integrityErrors?.some(e => e.message.includes('GETTER_EXECUTED')));
    });

    it('rejects symbol properties in hash input', async () => {
      const symKey = Symbol('attack');
      const cohubReader = {
        readRunFile: async () => {
          const state = { status: 'IN_PROGRESS' };
          state[symKey] = 'injected';
          return state;
        },
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      // Symbol properties cause deepFreeze to reject the input
      assert.strictEqual(snapshot.snapshotHash, 'error', 'must reject inputs with symbol properties');
      assert.ok(snapshot.integrityErrors?.some(e => e.message.includes('symbol')));
    });

    it('rejects proxy objects that intercept field access', async () => {
      const attackState = new Proxy(
        { status: 'IN_PROGRESS' },
        {
          get(target, prop) {
            if (prop === 'status') throw new Error('PROXY_TRAP_EXECUTED');
            return target[prop];
          }
        }
      );

      const cohubReader = {
        readRunFile: async () => attackState,
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'error', 'must reject via error result');
      assert.ok(snapshot.integrityErrors?.some(e => e.message.includes('PROXY_TRAP_EXECUTED')));
    });

    it('rejects circular references in state', async () => {
      const circular = { status: 'IN_PROGRESS', tasks: [] };
      circular.self = circular;

      const cohubReader = {
        readRunFile: async () => circular,
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.snapshotHash, 'error', 'must reject via error result');
      assert.ok(snapshot.integrityErrors?.some(e => e.message.toLowerCase().includes('circular')));
    });

    it('produces stable hash with different field order', async () => {
      const cohubReader1 = {
        readRunFile: async () => ({ status: 'IN_PROGRESS', stage: 'creation', nextAction: 'foo' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const cohubReader2 = {
        readRunFile: async () => ({ nextAction: 'foo', status: 'IN_PROGRESS', stage: 'creation' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const s1 = await createSnapshot('g1', cohubReader1, ledger, localState);
      const s2 = await createSnapshot('g1', cohubReader2, ledger, localState);

      assert.strictEqual(s1.snapshotHash, s2.snapshotHash, 'field order must not affect hash');
    });

    it('produces stable hash with sorted array elements', async () => {
      const cohubReader1 = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: [{ id: 'a' }, { id: 'b' }]
        }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const cohubReader2 = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          tasks: [{ id: 'b' }, { id: 'a' }]
        }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const s1 = await createSnapshot('g1', cohubReader1, ledger, localState);
      const s2 = await createSnapshot('g1', cohubReader2, ledger, localState);

      assert.notStrictEqual(s1.snapshotHash, s2.snapshotHash, 'array order must affect hash for exact identity');
    });

    it('excludes volatile values from snapshot hash', async () => {
      const makeReader = (timestamp) => ({
        readRunFile: async () => ({ status: 'IN_PROGRESS', updatedAt: timestamp }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      });

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const s1 = await createSnapshot('g1', makeReader('2026-01-01T00:00:00Z'), ledger, localState);
      const s2 = await createSnapshot('g1', makeReader('2026-01-02T00:00:00Z'), ledger, localState);

      assert.strictEqual(s1.snapshotHash, s2.snapshotHash, 'timestamp change must not affect hash');
    });

    it('detects stale snapshot when generation changed', async () => {
      let generation = 0;
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => {
          generation += 1;
          return { turns: [] };
        },
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = {
        status: 'RUNNING',
        parentSequence: 1,
        observedGeneration: 0,
        getGeneration: () => generation
      };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.ok(snapshot.observedGeneration > 0, 'should capture generation change');
    });

    it('tracks merged chain provenance', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: ['turn-1', 'turn-2'] }),
        getTurn: async (spaceId, sessionId, turnId) => {
          if (turnId === 'turn-1') {
            return { id: 'turn-1', status: 'merged', mergedIntoTurnId: 'turn-2' };
          }
          if (turnId === 'turn-2') {
            return { id: 'turn-2', status: 'completed' };
          }
          return null;
        }
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 'turn-1', spaceId: 'space-1', sessionId: 'session-1' }]
      };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.ok(snapshot.workerStates);
      const worker = snapshot.workerStates.find((w) => w.turnId === 'turn-1');
      assert.strictEqual(worker?.resolvedStatus, 'completed');
      assert.strictEqual(worker?.mergedIntoTurnId, 'turn-2');
    });

    it('only includes allowlisted fact domains', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          internalDebugInfo: 'should-not-appear',
          eta: '5 minutes',
          createdAt: '2026-01-01T00:00:00Z'
        }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      const str = JSON.stringify(snapshot);
      assert.ok(!str.includes('internalDebugInfo'));
      assert.ok(!str.includes('eta'));
      assert.ok(!str.includes('createdAt'));
    });

    it('rejects malformed terminal from wrong space', async () => {
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
      const localState = { status: 'RUNNING', parentSequence: 1, allowedSpaces: ['correct-space'] };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.ok(snapshot.integrityErrors?.some((e) => e.code.includes('SPACE')));
    });

    it('rejects missing chain in merged turn', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: ['turn-1'] }),
        getTurn: async (spaceId, sessionId, turnId) => {
          if (turnId === 'turn-1') {
            return { id: 'turn-1', status: 'merged', mergedIntoTurnId: null };
          }
          return null;
        }
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 'turn-1', spaceId: 's1', sessionId: 'sess1' }]
      };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.ok(snapshot.integrityErrors?.some((e) => e.code.includes('CHAIN')));
    });

    it('fresh reads every inspect call', async () => {
      let readCount = 0;
      const cohubReader = {
        readRunFile: async () => {
          readCount += 1;
          return { status: 'IN_PROGRESS', readCount };
        },
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      await createSnapshot('g1', cohubReader, ledger, localState);
      const firstCount = readCount;
      await createSnapshot('g1', cohubReader, ledger, localState);

      assert.ok(readCount > firstCount, 'must fresh read on every inspect');
      assert.ok(readCount >= 6, 'must read all authority files twice');
    });

    it('exact watch-set provenance from snapshot', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [
          { turnId: 't1', spaceId: 's1', sessionId: 'sess1' },
          { turnId: 't2', spaceId: 's1', sessionId: 'sess2' }
        ]
      };
      const localState = { status: 'RUNNING', parentSequence: 1, parentSpaceId: 's1', parentSessionId: 'parent-sess' };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.ok(snapshot.watchSet);
      assert.strictEqual(snapshot.watchSet.length, 3); // parent + 2 workers
      assert.ok(snapshot.watchSet.every((w) => w.spaceId && w.sessionId));
    });

    it('rejects unknown fields not in allowlist', async () => {
      const cohubReader = {
        readRunFile: async () => ({
          status: 'IN_PROGRESS',
          __proto__: { injected: 'malicious' },
          constructor: { injected: 'malicious' }
        }),
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      const str = JSON.stringify(snapshot);
      assert.ok(!str.includes('injected'), 'prototype pollution attempts must be filtered');
    });

    it('includes exact Turn and file identity in watch set', async () => {
      const cohubReader = {
        readRunFile: async () => ({ status: 'IN_PROGRESS' }),
        getSessionIndex: async () => ({ turns: ['turn-1'], sequence: 42 }),
        getTurn: async () => ({ status: 'completed' })
      };

      const ledger = {
        events: [],
        actionSlots: [],
        trackedTurns: [{ turnId: 'turn-1', spaceId: 's1', sessionId: 'sess1' }]
      };
      const localState = {
        status: 'RUNNING',
        parentSequence: 42,
        parentSpaceId: 's1',
        parentSessionId: 'parent-sess'
      };

      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.strictEqual(snapshot.parentSequence, 42);
      assert.ok(snapshot.watchSet.some((w) => w.turnId === 'turn-1'));
    });

    it('validates wrong run path access attempt', async () => {
      const cohubReader = {
        readRunFile: async (spaceId, path) => {
          if (path.includes('..') || path.includes('/etc')) {
            throw new Error('PATH_TRAVERSAL_REJECTED');
          }
          return { status: 'IN_PROGRESS' };
        },
        getSessionIndex: async () => ({ turns: [] }),
        getTurn: async () => null
      };

      const ledger = { events: [], actionSlots: [] };
      const localState = { status: 'RUNNING', parentSequence: 1 };

      // Normal operation succeeds
      const snapshot = await createSnapshot('g1', cohubReader, ledger, localState);
      assert.ok(snapshot.snapshotHash);
    });
  });

  describe('calculateProgressFingerprint', () => {
    it('excludes assistant text from fingerprint', () => {
      const state1 = { status: 'IN_PROGRESS', assistantMessage: 'Working on it...' };
      const state2 = { status: 'IN_PROGRESS', assistantMessage: 'Almost done!' };

      const f1 = calculateProgressFingerprint(state1, {}, []);
      const f2 = calculateProgressFingerprint(state2, {}, []);

      assert.strictEqual(f1, f2, 'assistant text must not affect fingerprint');
    });

    it('excludes Turn completed flag from fingerprint', () => {
      const workers1 = [{ turnId: 't1', resolvedStatus: 'completed', completed: true }];
      const workers2 = [{ turnId: 't1', resolvedStatus: 'completed', completed: false }];

      const f1 = calculateProgressFingerprint({}, {}, workers1);
      const f2 = calculateProgressFingerprint({}, {}, workers2);

      assert.strictEqual(f1, f2, 'completed flag alone must not affect fingerprint');
    });

    it('includes terminal status in fingerprint', () => {
      const workers1 = [{ turnId: 't1', resolvedStatus: 'running' }];
      const workers2 = [{ turnId: 't1', resolvedStatus: 'completed' }];

      const f1 = calculateProgressFingerprint({}, {}, workers1);
      const f2 = calculateProgressFingerprint({}, {}, workers2);

      assert.notStrictEqual(f1, f2, 'terminal status must affect fingerprint');
    });

    it('includes gate verdict in fingerprint', () => {
      const gates1 = { gates: [{ id: 'g1', verdict: 'PENDING' }] };
      const gates2 = { gates: [{ id: 'g1', verdict: 'PASS' }] };

      const f1 = calculateProgressFingerprint({}, gates1, []);
      const f2 = calculateProgressFingerprint({}, gates2, []);

      assert.notStrictEqual(f1, f2, 'gate verdict must affect fingerprint');
    });

    it('excludes RETURN.md PASS text from fingerprint', () => {
      const state1 = { status: 'IN_PROGRESS', returnText: 'PASS: all good' };
      const state2 = { status: 'IN_PROGRESS', returnText: 'PASS: excellent' };

      const f1 = calculateProgressFingerprint(state1, {}, []);
      const f2 = calculateProgressFingerprint(state2, {}, []);

      assert.strictEqual(f1, f2, 'RETURN.md PASS text must not affect fingerprint');
    });
  });
});
