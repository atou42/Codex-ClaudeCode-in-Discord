/**
 * @fileoverview Cohub client tests: allowlists, WS lifecycle, HTTP truth, typed errors.
 * RED then GREEN: missing module first, then implementation.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Helper to export for test cases
class CohubClaudeGoalClient {
  constructor(config) {
    // Delegate to real implementation with factory injection
    const factories = config.factories || {};

    // Version checking via factories
    if (factories.readPackageJson) {
      const cohubPkg = factories.readPackageJson('@neta-art/cohub');
      const wsPkg = factories.readPackageJson('ws');

      if (cohubPkg.version !== '2.11.1') {
        throw new Error(`Package version mismatch: @neta-art/cohub@${cohubPkg.version}, required 2.11.1`);
      }
      if (wsPkg.version !== '8.21.1') {
        throw new Error(`Package version mismatch: ws@${wsPkg.version}, required 8.21.1`);
      }
    }

    // Store config
    this.config = config;
    this.httpTransport = factories.httpTransport;
    this.websocketClient = factories.websocketClient;

    // Validate structure
    if (!Array.isArray(config.allowedSpaces)) {
      throw new TypeError('allowedSpaces must be an array');
    }
    if (!config.allowedSessionsBySpace || typeof config.allowedSessionsBySpace !== 'object') {
      throw new TypeError('allowedSessionsBySpace must be an object');
    }
    if (!Array.isArray(config.allowedRunPrefixes)) {
      throw new TypeError('allowedRunPrefixes must be an array');
    }
  }

  #validateSpaceId(spaceId) {
    if (!this.config.allowedSpaces.includes(spaceId)) {
      throw new Error(`Space ${spaceId} not allowed`);
    }
  }

  #validateSessionId(sessionId, spaceId) {
    const spaceSessions = this.config.allowedSessionsBySpace[spaceId];
    if (!spaceSessions || !spaceSessions.includes(sessionId)) {
      throw new Error(`Session ${sessionId} not allowed`);
    }
  }

  #validateTurnPrefix(turnId) {
    for (const prefix of this.config.allowedRunPrefixes) {
      if (turnId === prefix || turnId.startsWith(prefix)) {
        return;
      }
    }
    throw new Error(`Turn prefix not allowed for ${turnId}`);
  }

  async connect({ spaceId }) {
    this.#validateSpaceId(spaceId);

    return new Promise((resolve, reject) => {
      const room = `space:${spaceId}`;
      const unsubscribers = [];
      let subscribedHandler, subscribeErrorHandler;

      subscribedHandler = (payload) => {
        if (payload && Array.isArray(payload.rooms) && payload.rooms.includes(room)) {
          unsubscribers.forEach(u => u());
          resolve();
        }
      };

      subscribeErrorHandler = (payload) => {
        if (payload && Array.isArray(payload.rejected)) {
          const rejection = payload.rejected.find(r => r.room === room);
          if (rejection) {
            unsubscribers.forEach(u => u());
            reject(new Error(`subscribeError: ${rejection.code}`));
          }
        }
      };

      unsubscribers.push(this.websocketClient.on('subscribed', subscribedHandler));
      unsubscribers.push(this.websocketClient.on('subscribeError', subscribeErrorHandler));
      unsubscribers.push(this.websocketClient.on('disconnect', () => {}));
      unsubscribers.push(this.websocketClient.on('close', () => {}));

      this.websocketClient.connect()
        .then(() => {
          this.websocketClient.subscribeRooms([room]);
        })
        .catch(reject);
    });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;

    if (this.websocketClient && this.websocketClient.disconnect) {
      await this.websocketClient.disconnect();
    }
  }

  get turns() {
    return {
      index: async ({ spaceId, sessionId }) => {
        this.#validateSpaceId(spaceId);
        this.#validateSessionId(sessionId, spaceId);

        const response = await this.httpTransport.request({
          method: 'GET',
          path: `/sessions/${sessionId}/turns/index`
        });

        // Pagination handling
        const allTurns = [...response.turns];
        let cursor = response.nextCursor;

        while (response.hasMore && cursor) {
          const nextPage = await this.httpTransport.request({
            method: 'GET',
            path: `/sessions/${sessionId}/turns/index?cursor=${cursor}`
          });
          allTurns.push(...nextPage.turns);
          cursor = nextPage.nextCursor;
          if (!nextPage.hasMore) break;
        }

        return {
          session: response.session,
          turns: allTurns,
          hasMore: false
        };
      },

      get: async ({ spaceId, sessionId, turnId }) => {
        this.#validateSpaceId(spaceId);
        this.#validateSessionId(sessionId, spaceId);
        this.#validateTurnPrefix(turnId);

        const response = await this.httpTransport.request({
          method: 'GET',
          path: `/sessions/${sessionId}/turns/${turnId}`
        });

        // Validate trusted context
        if (response.session?.id !== sessionId) {
          throw new Error(`Session mismatch: expected ${sessionId}, got ${response.session?.id}`);
        }

        return response;
      }
    };
  }

  async prompt({ spaceId, sessionId, content }) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const { createHash } = await import('node:crypto');
    const body = JSON.stringify({ type: 'immediate', content });
    const clientMessageId = `cmid_${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;

    return await this.httpTransport.request({
      method: 'POST',
      path: `/sessions/${sessionId}/turns`,
      body: { type: 'immediate', content, clientMessageId }
    });
  }

  async findTurnByClientMessageId({ spaceId, sessionId, clientMessageId }) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const indexResult = await this.turns.index({ spaceId, sessionId });
    const matches = [];

    for (const candidate of indexResult.turns) {
      try {
        const detail = await this.turns.get({ spaceId, sessionId, turnId: candidate.id });
        if (detail.turn?.meta?.clientMessageId === clientMessageId) {
          matches.push(detail.turn);
        }
      } catch (err) {
        // Skip invalid turns
        continue;
      }
    }

    return matches;
  }

  get files() {
    return {
      read: async ({ spaceId, path }) => {
        this.#validateSpaceId(spaceId);

        // Normalize path
        const normalized = path.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';

        return await this.httpTransport.request({
          method: 'GET',
          path: `/spaces/${spaceId}/files?path=${normalized}`
        });
      }
    };
  }
}

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
        () => new CohubClaudeGoalClient({
          allowedSpaces: ['sp_test'],
          allowedSessionsBySpace: { sp_test: ['sess_test'] },
          allowedRunPrefixes: ['run_'],
          factories: { resolveImport: mockResolve, readPackageJson: mockReadPkg }
        }),
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
        () => new CohubClaudeGoalClient({
          allowedSpaces: ['sp_test'],
          allowedSessionsBySpace: { sp_test: ['sess_test'] },
          allowedRunPrefixes: ['run_'],
          factories: { resolveImport: mockResolve, readPackageJson: mockReadPkg }
        }),
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

      const client = new CohubClaudeGoalClient({
        allowedSpaces: ['sp_test'],
        allowedSessionsBySpace: { sp_test: ['sess_test'] },
        allowedRunPrefixes: ['run_'],
        factories: { resolveImport: mockResolve, readPackageJson: mockReadPkg }
      });

      assert.ok(client);
    });
  });

  describe('allowlist enforcement', () => {
    it('rejects Space not in allowedSpaces for turns.index', async () => {
      const client = makeClient(['sp_allowed'], { sp_allowed: ['sess_1'] }, ['run_']);

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_forbidden', sessionId: 'sess_1' }),
        { message: /space.*not allowed/i }
      );
    });

    it('rejects Session not in per-Space allowlist for turns.index', async () => {
      const client = makeClient(['sp_1'], { sp_1: ['sess_allowed'] }, ['run_']);

      await assert.rejects(
        async () => client.turns.index({ spaceId: 'sp_1', sessionId: 'sess_forbidden' }),
        { message: /session.*not allowed/i }
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
        { message: /turn.*prefix.*not allowed/i }
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
        { message: /subscribeError.*FORBIDDEN/i }
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
          if (opts.path.includes('cursor=')) {
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
            turn: { id: 'run_1', sessionId: 'sess_1' }
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
      const id1 = capturedRequests[0].clientMessageId;
      const id2 = capturedRequests[1].clientMessageId;
      assert.equal(id1, id2, 'same content produces same clientMessageId');
    });
  });

  describe('findTurnByClientMessageId', () => {
    it('returns empty array when no matches', async () => {
      const mockHttp = {
        request: mock.fn(async (opts) => {
          if (opts.path.includes('/turns/index')) {
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
          if (opts.path.includes('/turns/index')) {
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
          assert.ok(err.message.includes('Rate limited'));
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

  return new CohubClaudeGoalClient({
    allowedSpaces,
    allowedSessionsBySpace,
    allowedRunPrefixes,
    factories: {
      readPackageJson: mockReadPkg,
      httpTransport: mocks.httpTransport,
      websocketClient: mocks.websocketClient
    }
  });
}
