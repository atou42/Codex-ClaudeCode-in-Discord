/**
 * @fileoverview RED tests for confirmed defects in cohub-client.js
 * These tests MUST fail on commit 20320bd before the fix.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CohubGoalClient } from '../../src/cohub-claude-goal/cohub-client.js';

describe('CohubGoalClient - Confirmed Defects (RED)', () => {
  describe('DEFECT: production version enforcement skipped when no readPackageJson', () => {
    it('must enforce versions even without factories.readPackageJson', () => {
      // Production construction without readPackageJson should still validate
      // Current implementation skips enforcement when factories.readPackageJson is missing
      const mockHttp = { request: mock.fn(async () => ({})) };
      const mockWs = { on: () => () => {}, connect: async () => {}, disconnect: async () => {} };

      // This SHOULD throw because we can't verify versions, but current code silently succeeds
      assert.throws(
        () => new CohubGoalClient(
          {
            allowedSpaces: ['sp_test'],
            allowedSessionsBySpace: { sp_test: ['sess_test'] },
            allowedRunPrefixes: ['run_']
          },
          {
            factories: {
              httpTransport: mockHttp,
              websocketClient: mockWs
              // NO readPackageJson - production mode should fail-closed
            }
          }
        ),
        { message: /version.*enforcement/i }
      );
    });
  });

  describe('DEFECT: clientMessageId derived from content instead of caller continuationId', () => {
    it('must preserve caller-supplied continuationId as clientMessageId', async () => {
      const capturedRequests = [];
      const mockHttp = {
        request: mock.fn(async (opts) => {
          capturedRequests.push(opts.body);
          return {
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

      // Caller supplies explicit continuationId
      await client.prompt({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        continuationId: 'cont_caller_stable_123',
        content: [{ type: 'text', text: 'hello' }]
      });

      assert.equal(capturedRequests.length, 1);
      const clientMessageId = capturedRequests[0].meta.clientMessageId;

      // MUST equal caller's continuationId, not a hash of content
      assert.equal(clientMessageId, 'cont_caller_stable_123');
    });

    it('rejects prompt without caller continuationId', async () => {
      const mockHttp = { request: mock.fn(async () => ({})) };
      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.prompt({
          spaceId: 'sp_1',
          sessionId: 'sess_1',
          content: [{ type: 'text', text: 'hello' }]
          // NO continuationId - must reject
        }),
        { message: /continuationId.*required/i }
      );
    });
  });

  describe('DEFECT: wrong SDK imports and invented API surfaces', () => {
    it('uses correct @neta-art/cohub/http import', async () => {
      // Test that createHttpClient is imported from correct module
      // Current code imports from '@neta-art/cohub' root, should be '@neta-art/cohub/http'
      // This is validated by checking the actual import works with real SDK types
      const { createHttpClient } = await import('@neta-art/cohub/http');
      assert.equal(typeof createHttpClient, 'function');
    });

    it('uses correct WebSocket option names from SDK', async () => {
      const { createWebsocketClient } = await import('@neta-art/cohub/websocket');

      // SDK expects websocketUrl (not wsUrl), getAccessToken, WebSocketImpl (not WebSocket)
      const mockToken = async () => 'token_test';
      const mockWs = class MockWebSocket {};

      // This should work with real SDK
      const client = createWebsocketClient({
        websocketUrl: 'wss://test.example.com/ws',
        getAccessToken: mockToken,
        WebSocketImpl: mockWs  // Correct: WebSocketImpl, not WebSocket
      });

      assert.ok(client);
    });
  });

  describe('DEFECT: boundaries do direct reads before Proxy rejection', () => {
    it('rejects Proxy in response before reading any properties', async () => {
      let proxyTrapped = false;
      const maliciousResponse = new Proxy({}, {
        get(target, prop) {
          // JavaScript's await checks .then on resolved values; that's unavoidable.
          // What matters is that NO other property (session, turns, etc.) is read.
          if (prop === 'then') return undefined; // Not thenable
          proxyTrapped = true;
          return 'evil';
        }
      });

      const mockHttp = {
        request: mock.fn(async () => maliciousResponse)
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' }),
        { message: /proxy.*not.*allowed/i }
      );

      // MUST reject Proxy without reading domain properties (session, turns, etc.)
      assert.equal(proxyTrapped, false, 'Proxy trap for non-then properties should never fire');
    });

    it('rejects nested Proxy in turn objects', async () => {
      const maliciousTurn = new Proxy({ id: 'run_1', sessionId: 'sess_1' }, {
        get: () => { throw new Error('Proxy trap fired!'); }
      });

      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_1', spaceId: 'sp_1' },
          turn: maliciousTurn  // Nested Proxy
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.get({ spaceId: 'sp_1', sessionId: 'sess_1', turnId: 'run_1' }),
        { message: /proxy.*not.*allowed/i }
      );
    });

    it('rejects Array.isArray check on attacker-controlled arrays', async () => {
      // Array.isArray on a Proxy with isArray trap can leak or cause side effects
      const maliciousArray = new Proxy([], {
        get(target, prop) {
          if (prop === Symbol.toStringTag) {
            throw new Error('Symbol trap fired - leak');
          }
          return target[prop];
        }
      });

      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_1', spaceId: 'sp_1' },
          turns: maliciousArray
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' }),
        { message: /proxy.*not.*allowed/i }
      );
    });
  });

  describe('DEFECT: safeGet invokes untrusted accessors', () => {
    it('rejects objects with getter properties', async () => {
      const maliciousObj = {};
      Object.defineProperty(maliciousObj, 'id', {
        get() { throw new Error('Getter executed!'); }
      });

      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_1', spaceId: 'sp_1' },
          turns: [maliciousObj]
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' }),
        { message: /getter.*not.*allowed/i }
      );
    });
  });

  describe('DEFECT: response validators leak attacker values', () => {
    it('does not include attacker-controlled IDs in error messages', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: '<script>alert("xss")</script>', spaceId: 'sp_1' },
          turn: { id: 'run_1', sessionId: '<script>alert("xss")</script>' }
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      try {
        await client.turns.get({ spaceId: 'sp_1', sessionId: 'sess_1', turnId: 'run_1' });
        assert.fail('Should have thrown');
      } catch (err) {
        // Error message MUST NOT contain attacker-controlled session ID
        assert.ok(!err.message.includes('<script>'), 'Error must not leak attacker content');
        assert.ok(err.message.includes('mismatch') || err.message.includes('invalid'), 'Error must be typed');
      }
    });
  });

  describe('DEFECT: config clones remain shallow and mutable', () => {
    it('deeply freezes allowedSessionsBySpace to prevent mutation', () => {
      const config = {
        allowedSpaces: ['sp_1'],
        allowedSessionsBySpace: { sp_1: ['sess_allowed'] },
        allowedRunPrefixes: ['run_']
      };

      const client = makeClient(
        config.allowedSpaces,
        config.allowedSessionsBySpace,
        config.allowedRunPrefixes
      );

      // External mutation attempt
      config.allowedSessionsBySpace.sp_1.push('sess_evil');
      config.allowedSpaces.push('sp_evil');

      // Client MUST NOT see the mutations
      assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_evil', sessionId: 'sess_evil' }),
        { message: /not.*allow/i }
      );
    });
  });

  describe('DEFECT: path validation allows ambiguous forms', () => {
    it('rejects Unicode normalization attacks', async () => {
      const mockHttp = { request: mock.fn(async () => ({ content: 'data', size: 4 })) };
      const client = makeClient(['sp_1'], { sp_1: [] }, ['run_'], { httpTransport: mockHttp });

      // Unicode combining sequences that normalize to '../'
      await assert.rejects(
        async () => client.files.read({ spaceId: 'sp_1', path: '/path‥‥/secret' }),
        { message: /path.*not.*allowed/i }
      );
    });

    it('rejects backslash path separators', async () => {
      const mockHttp = { request: mock.fn(async () => ({ content: 'data', size: 4 })) };
      const client = makeClient(['sp_1'], { sp_1: [] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.files.read({ spaceId: 'sp_1', path: '\\..\\secret' }),
        { message: /path.*not.*allowed/i }
      );
    });

    it('rejects NUL byte path injection', async () => {
      const mockHttp = { request: mock.fn(async () => ({ content: 'data', size: 4 })) };
      const client = makeClient(['sp_1'], { sp_1: [] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.files.read({ spaceId: 'sp_1', path: '/allowed\x00/../secret' }),
        { message: /path.*not.*allowed/i }
      );
    });
  });

  describe('DEFECT: findTurn silently continues on malformed candidates', () => {
    it('fails closed on malformed candidate turn ID', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.path.includes('/turns') && !opts.path.match(/\/turns\/[^/]+$/)) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turns: [
                { id: null },  // Malformed - should fail, not skip
                { id: 'run_2' }
              ],
              hasMore: false
            };
          }
          throw new Error('Should not reach here');
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.findTurnByClientMessageId({
          spaceId: 'sp_1',
          sessionId: 'sess_1',
          clientMessageId: 'msg_any'
        }),
        { message: /malformed/i }
      );
    });
  });

  describe('DEFECT: errors can leak content', () => {
    it('sanitizes upstream error messages', async () => {
      const mockHttp = {
        request: mock.fn(async () => {
          const err = new Error('DB query failed: SELECT * FROM users WHERE secret=<ATTACKER_VALUE>');
          err.status = 500;
          throw err;
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      try {
        await client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' });
        assert.fail('Should have thrown');
      } catch (err) {
        // Error MUST be sanitized, not contain upstream message
        assert.ok(!err.message.includes('ATTACKER_VALUE'), 'Must not leak upstream error content');
        assert.ok(!err.message.includes('SELECT'), 'Must not leak SQL');
        assert.equal(err.message, 'Server error');
      }
    });
  });

  describe('DEFECT: connect has listener/timer cleanup and ack races', () => {
    it('cleans up ack timeout on subscribeError', async () => {
      let timeoutCleared = false;
      const originalClearTimeout = global.clearTimeout;
      global.clearTimeout = (id) => {
        timeoutCleared = true;
        return originalClearTimeout(id);
      };

      let subscribeErrorHandler;
      const mockWs = {
        on: mock.fn((evt, handler) => {
          if (evt === 'subscribeError') subscribeErrorHandler = handler;
          return () => {};
        }),
        connect: mock.fn(async () => {}),
        subscribeRooms: mock.fn(() => {
          setImmediate(() => {
            subscribeErrorHandler({ rejected: [{ room: 'space:sp_1', code: 'FORBIDDEN' }] });
          });
        }),
        disconnect: mock.fn(async () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { websocketClient: mockWs });

      try {
        await client.connect({ spaceId: 'sp_1' });
        assert.fail('Should have rejected');
      } catch (err) {
        // Timer MUST be cleaned up
        assert.ok(timeoutCleared, 'Ack timeout must be cleared on error');
      } finally {
        global.clearTimeout = originalClearTimeout;
      }
    });

    it('handles disconnect during ack wait', async () => {
      let disconnectHandler;
      const mockWs = {
        on: mock.fn((evt, handler) => {
          if (evt === 'disconnect') disconnectHandler = handler;
          return () => {};
        }),
        connect: mock.fn(async () => {}),
        subscribeRooms: mock.fn(() => {
          setImmediate(() => disconnectHandler());
        }),
        disconnect: mock.fn(async () => {})
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { websocketClient: mockWs });

      await assert.rejects(
        async () => client.connect({ spaceId: 'sp_1' }),
        { message: /disconnect/i }
      );
    });
  });

  describe('DEFECT: outputs retain dependency references', () => {
    it('returns deeply frozen response without internal references', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_1', spaceId: 'sp_1' },
          turns: [{ id: 'run_1', meta: { foo: 'bar' } }],
          hasMore: false
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' });

      // Result MUST be deeply frozen
      assert.throws(
        () => { result.turns[0].id = 'evil'; },
        /Cannot assign to read only property|extensible|frozen/
      );

      assert.throws(
        () => { result.turns[0].meta.foo = 'evil'; },
        /Cannot assign to read only property|extensible|frozen/
      );
    });
  });

  describe('DEFECT: duplicate clientMessageId not handled correctly', () => {
    it('returns all matching turns when multiple have same clientMessageId', async () => {
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
              turn: { id: 'run_1', sessionId: 'sess_1', meta: { clientMessageId: 'msg_dup' } }
            };
          }
          if (opts.path.includes('/turns/run_2')) {
            return {
              session: { id: 'sess_1', spaceId: 'sp_1' },
              turn: { id: 'run_2', sessionId: 'sess_1', meta: { clientMessageId: 'msg_dup' } }
            };
          }
          throw new Error('unexpected');
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.findTurnByClientMessageId({
        spaceId: 'sp_1',
        sessionId: 'sess_1',
        clientMessageId: 'msg_dup'
      });

      // MUST return both matches
      assert.equal(result.length, 2);
      assert.ok(result.some(t => t.id === 'run_1'));
      assert.ok(result.some(t => t.id === 'run_2'));
    });
  });

  describe('DEFECT: response mutation after validation', () => {
    it('prevents mutation of response after validation', async () => {
      const mockHttp = {
        request: mock.fn(async () => {
          const response = {
            session: { id: 'sess_1', spaceId: 'sp_1' },
            turns: [{ id: 'run_1', data: 'original' }],
            hasMore: false
          };
          // Simulate mutation after return
          setImmediate(() => {
            response.turns[0].data = 'mutated';
          });
          return response;
        })
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      const result = await client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Result MUST still have original value (deep frozen)
      assert.equal(result.turns[0].data, 'original');
    });
  });

  describe('DEFECT: secret sentinel not properly protected', () => {
    it('rejects objects containing secret sentinel token', async () => {
      const mockHttp = {
        request: mock.fn(async () => ({
          session: { id: 'sess_1', spaceId: 'sp_1', _secret: 'SENTINEL_TOKEN_12345' },
          turns: []
        }))
      };

      const client = makeClient(['sp_1'], { sp_1: ['sess_1'] }, ['run_'], { httpTransport: mockHttp });

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_1' }),
        { message: /secret.*not.*allowed/i }
      );
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

  return new CohubGoalClient(
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
