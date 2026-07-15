/**
 * @fileoverview Cohub client tests: allowlists, WS lifecycle, HTTP truth, typed errors.
 * Tests the production implementation in src/cohub-claude-goal/cohub-client.js
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CohubGoalClient as CohubClaudeGoalClient } from '../../src/cohub-claude-goal/cohub-client.js';

describe('CohubClaudeGoalClient', () => {
  describe('construction and version enforcement', () => {
    it('throws when @neta-art/cohub version is not exactly 2.11.1', async () => {
      const mockResolve = async (spec) => {
        if (spec === '@neta-art/cohub') return 'file:///fake/cohub/dist/index.js';
        if (spec === 'ws') return 'file:///fake/ws/wrapper.mjs';
        throw new Error('unexpected');
      };
      const mockReadPkg = (name) => {
        if (name === '@neta-art/cohub') return { name: '@neta-art/cohub', version: '2.10.0' };
        if (name === 'ws') return { name: 'ws', version: '8.21.1' };
        throw new Error('unexpected');
      };

      assert.throws(
        () => new CohubClaudeGoalClient(
          {
            allowedSpaces: ['sp_test'],
            allowedSessionsBySpace: { sp_test: ['sess_test'] },
            allowedRunPrefixes: ['run_']
          },
          {
            factories: { resolveImport: mockResolve, readPackageJson: mockReadPkg }
          }
        ),
        { message: /cohub.*2\.11\.1/i }
      );
    });

    it('throws when ws version is not exactly 8.21.1', async () => {
      const mockResolve = async (spec) => {
        if (spec === '@neta-art/cohub') return 'file:///fake/cohub/dist/index.js';
        if (spec === 'ws') return 'file:///fake/ws/wrapper.mjs';
        throw new Error('unexpected');
      };
      const mockReadPkg = (name) => {
        if (name === '@neta-art/cohub') return { name: '@neta-art/cohub', version: '2.11.1' };
        if (name === 'ws') return { name: 'ws', version: '8.20.0' };
        throw new Error('unexpected');
      };

      assert.throws(
        () => new CohubClaudeGoalClient(
          {
            allowedSpaces: ['sp_test'],
            allowedSessionsBySpace: { sp_test: ['sess_test'] },
            allowedRunPrefixes: ['run_']
          },
          {
            factories: { resolveImport: mockResolve, readPackageJson: mockReadPkg }
          }
        ),
        { message: /ws.*8\.21\.1/i }
      );
    });

    it('constructs successfully with exact versions and valid allowlists', async () => {
      const mockResolve = async (spec) => {
        if (spec === '@neta-art/cohub') return 'file:///fake/cohub/dist/index.js';
        if (spec === 'ws') return 'file:///fake/ws/wrapper.mjs';
        throw new Error('unexpected');
      };
      const mockReadPkg = (name) => {
        if (name === '@neta-art/cohub') return { name: '@neta-art/cohub', version: '2.11.1' };
        if (name === 'ws') return { name: 'ws', version: '8.21.1' };
        throw new Error('unexpected');
      };
      const mockHttp = { request: mock.fn(async () => ({})) };

      const client = new CohubClaudeGoalClient(
        {
          allowedSpaces: ['sp_test'],
          allowedSessionsBySpace: { sp_test: ['sess_test'] },
          allowedRunPrefixes: ['run_']
        },
        {
          factories: {
            resolveImport: mockResolve,
            readPackageJson: mockReadPkg,
            httpTransport: mockHttp,
            websocketClient: { on: () => () => {}, connect: async () => {} }
          }
        }
      );

      assert.ok(client);
    });
  });

  describe('descriptor-safety', () => {
    it('rejects config with getter properties', () => {
      const mockReadPkg = (name) => {
        if (name === '@neta-art/cohub') return { name: '@neta-art/cohub', version: '2.11.1' };
        if (name === 'ws') return { name: 'ws', version: '8.21.1' };
        throw new Error('unexpected');
      };

      const config = {
        allowedRunPrefixes: ['run_'],
        allowedSessionsBySpace: {}
      };
      Object.defineProperty(config, 'allowedSpaces', {
        get() { return ['sp_evil']; }
      });

      assert.throws(
        () => new CohubClaudeGoalClient(config, {
          factories: {
            readPackageJson: mockReadPkg,
            httpTransport: { request: async () => ({}) },
            websocketClient: { on: () => () => {}, connect: async () => {} }
          }
        }),
        { message: /getters\/setters not allowed/i }
      );
    });

    it('rejects Proxy-wrapped arrays', () => {
      const mockReadPkg = (name) => {
        if (name === '@neta-art/cohub') return { name: '@neta-art/cohub', version: '2.11.1' };
        if (name === 'ws') return { name: 'ws', version: '8.21.1' };
        throw new Error('unexpected');
      };

      const proxy = new Proxy(['sp_1'], {
        get(target, prop) {
          if (prop === 'includes') return () => true;
          return target[prop];
        }
      });

      assert.throws(
        () => new CohubClaudeGoalClient(
          {
            allowedSpaces: proxy,
            allowedSessionsBySpace: {},
            allowedRunPrefixes: ['run_']
          },
          {
            factories: {
              readPackageJson: mockReadPkg,
              httpTransport: { request: async () => ({}) },
              websocketClient: { on: () => () => {}, connect: async () => {} }
            }
          }
        ),
        { message: /plain array.*no Proxies/i }
      );
    });
  });

  describe('allowlist enforcement', () => {
    it('rejects Space not in allowedSpaces for turns.index', async () => {
      const client = makeClient(['sp_allowed'], { sp_allowed: ['sess_1'] }, ['run_']);

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_forbidden', sessionId: 'sess_1' }),
        { message: /space.*not.*allow/i }
      );
    });

    it('rejects Session not in per-Space allowlist for turns.index', async () => {
      const client = makeClient(['sp_1'], { sp_1: ['sess_allowed'] }, ['run_']);

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_forbidden' }),
        { message: /session.*not.*allow/i }
      );
    });

    it('rejects run prefix not in allowedRunPrefixes for turns.get', async () => {
      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_']);

      await assert.rejects(
        async () => client.turns.get({
          spaceId: 'sp_1',
          sessionId: 'sess_1',
          turnId: 'turn_bad_prefix_123'
        }),
        { message: /turn.*not.*allow/i }
      );
    });

    it('accepts valid Space, Session, and run prefix', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_1', spaceId: 'sp_1' },
          turn: { id: 'run_123', sessionId: 'sess_1' }
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.turns.get({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        turnId: 'run_123'
      });

      assert.equal(result.turn.id, 'run_123');
      assert.equal(mockHttp.request.mock.calls.length, 1);
    });
  });

  describe('WebSocket lifecycle', () => {
    it('attaches listener before connect', async () => {
      const events = [];
      let subscribedHandler;
      const mockWs = {
        state: 'idle',
        on: mock.fn((evt, handler) => {
          events.push({ event: evt, phase: 'on' });
          if (evt === 'subscribed') subscribedHandler = handler;
          return () => {};
        }),
        connect: mock.fn(async () => {
          events.push({ phase: 'connect' });
        }),
        subscribeRooms: mock.fn(() => {
          setImmediate(() => {
            if (subscribedHandler) subscribedHandler({ rooms: ['space:sp_1'] });
          });
          return () => {};
        }),
        disconnect: mock.fn(async () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { websocketClient: mockWs });

      await client.connect({ spaceId: 'sp_1' });

      // Verify 'on' calls happened before connect
      const onIndex = events.findIndex(e => e.phase === 'on');
      const connectIndex = events.findIndex(e => e.phase === 'connect');
      assert.ok(onIndex >= 0 && connectIndex > onIndex, 'listener attached before connect');
    });

    it('rejects on subscribeError', async () => {
      let subscribeErrorHandler;
      const mockWs = {
        state: 'idle',
        on: mock.fn((evt, handler) => {
          if (evt === 'subscribeError') subscribeErrorHandler = handler;
          return () => {};
        }),
        connect: mock.fn(async () => {}),
        subscribeRooms: mock.fn(() => {
          setImmediate(() => {
            subscribeErrorHandler({
              rejected: [{ room: 'space:sp_1', code: 'FORBIDDEN', message: 'no access' }]
            });
          });
          return () => {};
        }),
        disconnect: mock.fn(async () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { websocketClient: mockWs });

      await assert.rejects(
        async () => client.connect({ spaceId: 'sp_1' }),
        { message: /subscribe.*error.*FORBIDDEN/i }
      );
    });

    it('waits for exact Space room subscribed ack', async () => {
      let subscribedHandler;
      const mockWs = {
        state: 'idle',
        connectionId: 'conn_1',
        on: mock.fn((evt, handler) => {
          if (evt === 'subscribed') subscribedHandler = handler;
          return () => {};
        }),
        connect: mock.fn(async () => {}),
        subscribeRooms: mock.fn(() => {
          setImmediate(() => {
            subscribedHandler({ rooms: ['space:sp_1'] });
          });
          return () => {};
        }),
        disconnect: mock.fn(async () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { websocketClient: mockWs });

      await client.connect({ spaceId: 'sp_1' });

      assert.equal(mockWs.subscribeRooms.mock.calls.length, 1);
      assert.deepEqual(mockWs.subscribeRooms.mock.calls[0].arguments[0], ['space:sp_1']);
    });

    it('cleans up listeners on disconnect', async () => {
      const unsubscribers = [];
      let subscribedHandler;
      const mockWs = {
        state: 'idle',
        connectionId: 'conn_1',
        on: mock.fn((evt, handler) => {
          const unsub = mock.fn();
          unsubscribers.push(unsub);
          if (evt === 'subscribed') subscribedHandler = handler;
          return unsub;
        }),
        connect: mock.fn(async () => {}),
        subscribeRooms: mock.fn(() => {
          setImmediate(() => subscribedHandler({ rooms: ['space:sp_1'] }));
          return () => {};
        }),
        disconnect: mock.fn(async () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { websocketClient: mockWs });

      await client.connect({ spaceId: 'sp_1' });
      await client.close();

      assert.ok(unsubscribers.every(u => u.mock.calls.length > 0), 'all listeners cleaned up');
    });
  });

  describe('turns.index with pagination', () => {
    it('fetches all pages when hasMore is true', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.query && opts.query.cursor) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turns: [{ id: 'run_3', sequence: 3 }],
              hasMore: false
            };
          }
          return {
            session: { id: 'sess_1', spaceId: 'sp_1' },
            turns: [{ id: 'run_1', sequence: 1 }, { id: 'run_2', sequence: 2 }],
            hasMore: true,
            nextCursor: '100'
          };
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' });

      assert.equal(result.turns.length, 3);
      assert.equal(mockHttp.request.mock.calls.length, 2);
    });

    it('normalizes paths and validates bytes for files.read', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          path: '/normalized/path.txt',
          content: 'data',
          size: 4,
          encoding: 'utf8'
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: [] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.files.read({ spaceId: 'sp_1', path: '//double//slash.txt' });

      assert.equal(result.path, '/normalized/path.txt');
      assert.equal(result.content.length, 4);
    });
  });

  describe('prompt with stable clientMessageId', () => {
    it('generates stable clientMessageId from content', async () => {
      const capturedRequests = [];
      const mockHttp = {
        request: mock.fn(async (opts) => {
          capturedRequests.push(opts.body);
          return {
            mode: 'immediate',
            session: { id: 'sess_1', spaceId: 'sp_1' },
            turn: {
              id: 'run_1',
              sessionId: 'sess_1',
              meta: { clientMessageId: opts.body.meta.clientMessageId }
            }
          };
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await client.prompt({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        content: [{ type: 'text', text: 'hello' }]
      });

      await client.prompt({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        content: [{ type: 'text', text: 'hello' }]
      });

      assert.equal(capturedRequests.length, 2);
      const id1 = capturedRequests[0].meta.clientMessageId;
      const id2 = capturedRequests[1].meta.clientMessageId;
      assert.equal(id1, id2, 'same content produces same clientMessageId');
    });
  });

  describe('findTurnByClientMessageId', () => {
    it('returns empty array when no matches', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.path.includes('/turns') && !opts.path.match(/\/turns\/[^/]+$/)) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turns: [],
              hasMore: false
            };
          }
          throw new Error('unexpected path');
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.findTurnByClientMessageId({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        clientMessageId: 'msg_missing'
      });

      assert.deepEqual(result, []);
    });

    it('returns multiple matches when found', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.path.includes('/turns') && !opts.path.match(/\/turns\/[^/]+$/)) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turns: [
                { id: 'run_1', sequence: 1 },
                { id: 'run_2', sequence: 2 }
              ],
              hasMore: false
            };
          }
          if (opts.path.includes('/turns/run_1')) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turn: {
                id: 'run_1',
                sessionId: 'sess_1',
                meta: { clientMessageId: 'msg_target' }
              }
            };
          }
          if (opts.path.includes('/turns/run_2')) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turn: {
                id: 'run_2',
                sessionId: 'sess_1',
                meta: { clientMessageId: 'msg_different' }
              }
            };
          }
          throw new Error('unexpected path');
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.findTurnByClientMessageId({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        clientMessageId: 'msg_target'
      });

      assert.equal(result.length, 1);
      assert.equal(result[0].id, 'run_1');
    });

    it('skips allowlist errors but fails on context mismatches', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.path.includes('/turns') && !opts.path.match(/\/turns\/[^/]+$/)) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turns: [
                { id: 'run_1', sequence: 1 },
                { id: 'evil_prefix_2', sequence: 2 }
              ],
              hasMore: false
            };
          }
          if (opts.path.includes('/turns/run_1')) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turn: {
                id: 'run_1',
                sessionId: 'sess_1',
                meta: { clientMessageId: 'msg_target' }
              }
            };
          }
          if (opts.path.includes('/turns/evil_prefix_2')) {
            // This should be skipped (allowlist error)
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turn: {
                id: 'evil_prefix_2',
                sessionId: 'sess_1',
                meta: { clientMessageId: 'msg_other' }
              }
            };
          }
          throw new Error('unexpected path');
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      // Should skip evil_prefix_2 without throwing
      const result = await client.findTurnByClientMessageId({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        clientMessageId: 'msg_target'
      });

      assert.equal(result.length, 1);
      assert.equal(result[0].id, 'run_1');
    });

    it('fails closed on non-allowlist errors', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.path.includes('/turns') && !opts.path.match(/\/turns\/[^/]+$/)) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turns: [
                { id: 'run_1', sequence: 1 }
              ],
              hasMore: false
            };
          }
          if (opts.path.includes('/turns/run_1')) {
            // Return wrong session (context mismatch, not allowlist)
            return {
              session: { id: 'sess_wrong', spaceId: 'sp_1' },
              turn: {
                id: 'run_1',
                sessionId: 'sess_wrong',
                meta: { clientMessageId: 'msg_target' }
              }
            };
          }
          throw new Error('unexpected path');
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      // Should throw on context mismatch (not skip it)
      await assert.rejects(
        async () => client.findTurnByClientMessageId({
          spaceId: 'sp_1',
          sessionId: 'sess_1',
          clientMessageId: 'msg_target'
        }),
        { message: /mismatch/i }
      );
    });
  });

  describe('typed error handling', () => {
    it('throws typed error for 401', async () => {
      const mockHttp = {
        request: mock.fn(async () => {
          const err = new Error('Unauthorized');
          err.status = 401;
          throw err;
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' }),
        (err) => {
          assert.ok(err.message.includes('Unauthorized'));
          return true;
        }
      );
    });

    it('throws typed error for 429', async () => {
      const mockHttp = {
        request: mock.fn(async () => {
          const err = new Error('Rate limited');
          err.status = 429;
          throw err;
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.get({ spaceId: 'sp_1', sessionId: 'sess_1', turnId: 'run_1' }),
        (err) => {
          assert.ok(err.message.includes('Rate limit'));
          return true;
        }
      );
    });
  });

  describe('trusted execution context validation', () => {
    it('validates Space/Session/Turn identity in turns.get response', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_wrong', spaceId: 'sp_1' },
          turn: { id: 'run_1', sessionId: 'sess_wrong' }
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.get({ spaceId: 'sp_1', sessionId: 'sess_1', turnId: 'run_1' }),
        { message: /session.*mismatch/i }
      );
    });

    it('reports context mismatch before allowlist violation', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_wrong', spaceId: 'sp_1' },
          turn: { id: 'evil_prefix_123', sessionId: 'sess_wrong' }
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.get({ spaceId: 'sp_1', sessionId: 'sess_1', turnId: 'evil_prefix_123' }),
        (err) => {
          // Should get CONTEXT_MISMATCH, not TURN_NOT_ALLOWED
          assert.ok(err.message.includes('mismatch'), 'Should report context mismatch');
          assert.ok(!err.message.includes('not allowed'), 'Should not report allowlist error');
          return true;
        }
      );
    });
  });

  describe('close idempotency', () => {
    it('allows multiple close calls', async () => {
      const mockWs = {
        state: 'open',
        disconnect: mock.fn(async () => {}),
        on: mock.fn(() => () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: [] }, ['run_'], { websocketClient: mockWs });

      await client.close();
      await client.close();

      assert.equal(mockWs.disconnect.mock.calls.length, 1, 'disconnect called only once');
    });
  });
});

// Test helper
function makeClient(allowedSpaces, allowedSessionsBySpace, allowedRunPrefixes, mocks = {}) {
  const mockReadPkg = (name) => {
    if (name === '@neta-art/cohub') return { name: '@neta-art/cohub', version: '2.11.1' };
    if (name === 'ws') return { name: 'ws', version: '8.21.1' };
    throw new Error('unexpected');
  };

  const defaultMockHttp = { request: mock.fn(async () => ({ session: { id: 'sess_1', spaceId: 'sp_1' }, turns: [], hasMore: false })) };
  const defaultMockWs = { on: () => () => {}, connect: async () => {}, subscribeRooms: () => {}, disconnect: async () => {} };

  return new CohubClaudeGoalClient(
    {
      allowedSpaces,
      allowedSessionsBySpace,
      allowedRunPrefixes
    },
    {
      factories: {
        readPackageJson: mockReadPkg,
        httpTransport: mocks.httpTransport || defaultMockHttp,
        websocketClient: mocks.websocketClient || defaultMockWs
      }
    }
  );
}
