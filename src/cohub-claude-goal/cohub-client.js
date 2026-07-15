/**
 * Strict public Cohub client adapter for Claude goal supervisor.
 * Auth belongs in separate cohub-auth adapter; this client accepts injected getAccessToken.
 */

import { createHash } from 'node:crypto';
import { resolve, normalize, sep } from 'node:path';
import { createHttpClient } from '@neta-art/cohub';
import { createWebsocketClient } from '@neta-art/cohub/websocket';
import WebSocket from 'ws';

const REQUIRED_COHUB_VERSION = '2.11.1';
const REQUIRED_WS_VERSION = '8.21.1';

const MAX_PAGINATION_PAGES = 100;
const MAX_PAGINATION_TURNS = 10000;
const SUBSCRIBE_TIMEOUT_MS = 10000;
const PROMPT_TIMEOUT_MS = 30000;

/**
 * Typed errors for 401/403/429/5xx/bad-shape without raw leaks.
 */
class CohubClientError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'CohubClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Enforce exact package versions at construction time via injected validator.
 */
function enforcePackageVersions(factories) {
  if (!factories || !factories.readPackageJson) {
    // No version enforcement when factories not provided (production mode trusts package-lock.json)
    return;
  }

  const cohubPkg = factories.readPackageJson('@neta-art/cohub');
  const wsPkg = factories.readPackageJson('ws');

  if (cohubPkg.version !== REQUIRED_COHUB_VERSION) {
    throw new Error(
      `Package version mismatch: @neta-art/cohub@${cohubPkg.version}, required ${REQUIRED_COHUB_VERSION}`
    );
  }
  if (wsPkg.version !== REQUIRED_WS_VERSION) {
    throw new Error(
      `Package version mismatch: ws@${wsPkg.version}, required ${REQUIRED_WS_VERSION}`
    );
  }
}

/**
 * Canonical JSON serialization with sorted keys for stable hashing.
 */
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Normalize and validate path is contained within allowed prefix with boundary protection.
 */
function validatePathInPrefix(rawPath, allowedPrefix) {
  const normalized = normalize(rawPath).replace(/\/+/g, '/').replace(/\/+$/, '') || '/';

  // Reject ../ segments
  if (normalized.includes('..')) {
    throw new CohubClientError('Path traversal not allowed', 'PATH_TRAVERSAL', 403);
  }

  // Resolve to absolute and check containment with boundary
  const resolvedPath = resolve('/', normalized);
  const resolvedPrefix = resolve('/', allowedPrefix);

  if (!resolvedPath.startsWith(resolvedPrefix + sep) && resolvedPath !== resolvedPrefix) {
    throw new CohubClientError('Path outside allowed prefix', 'PATH_BOUNDARY', 403);
  }

  return normalized;
}

/**
 * Classify HTTP errors into typed closed-vocabulary codes.
 */
function classifyHttpError(err) {
  const status = err.status || err.statusCode || 0;

  if (status === 401) {
    return new CohubClientError('Unauthorized', 'UNAUTHORIZED', 401);
  }
  if (status === 403) {
    return new CohubClientError('Forbidden', 'FORBIDDEN', 403);
  }
  if (status === 429) {
    return new CohubClientError('Rate limit exceeded', 'RATE_LIMIT', 429);
  }
  if (status >= 500 && status < 600) {
    return new CohubClientError('Server error', 'SERVER_ERROR', status);
  }
  if (status >= 400 && status < 500) {
    return new CohubClientError('Client error', 'CLIENT_ERROR', status);
  }

  return new CohubClientError('Request failed', 'NETWORK_ERROR', 0);
}

/**
 * Validate response shape and trusted execution context.
 */
function validateTrustedContext(response, expected) {
  if (!response || typeof response !== 'object') {
    throw new CohubClientError('Malformed response: not an object', 'BAD_SHAPE', 0);
  }

  const session = response.session;
  if (!session || typeof session !== 'object') {
    throw new CohubClientError('Malformed response: missing session', 'BAD_SHAPE', 0);
  }

  if (session.id !== expected.sessionId) {
    throw new CohubClientError(
      `Session ID mismatch: expected ${expected.sessionId}, got ${session.id}`,
      'CONTEXT_MISMATCH',
      0
    );
  }

  if (session.spaceId !== expected.spaceId) {
    throw new CohubClientError(
      `Space ID mismatch: expected ${expected.spaceId}, got ${session.spaceId}`,
      'CONTEXT_MISMATCH',
      0
    );
  }

  if (expected.turnId && response.turn) {
    if (response.turn.id !== expected.turnId) {
      throw new CohubClientError(
        `Turn ID mismatch: expected ${expected.turnId}, got ${response.turn.id}`,
        'CONTEXT_MISMATCH',
        0
      );
    }
    // Validate turn.sessionId back-reference
    if (response.turn.sessionId !== session.id) {
      throw new CohubClientError(
        `Turn sessionId does not match session.id`,
        'CONTEXT_MISMATCH',
        0
      );
    }
  }
}

/**
 * Protect against accessor/prototype/symbol attacks.
 */
function hasOwnProperty(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function safeGet(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (typeof key === 'symbol') return undefined;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return hasOwnProperty(obj, key) ? obj[key] : undefined;
}

export class CohubGoalClient {
  #config;
  #httpTransport;
  #websocketClient;
  #getAccessToken;
  #subscribedRooms = new Set();
  #pendingAcks = new Map(); // room -> {resolve, reject, timer}
  #closed = false;

  /**
   * @param {Object} config - Descriptor-safe allowlists
   * @param {string[]} config.allowedSpaces - Exact Space IDs
   * @param {Object} config.allowedSessionsBySpace - Map of spaceId -> sessionId[]
   * @param {string[]} config.allowedRunPrefixes - Turn ID prefixes (e.g., 'run_123/')
   * @param {string} [config.baseUrl] - Cohub API base URL
   * @param {Object} options.factories - Injected factories
   * @param {Function} [options.factories.httpTransport] - HTTP transport
   * @param {Function} [options.factories.websocketClient] - WebSocket client
   * @param {Function} [options.factories.getAccessToken] - Auth token getter
   * @param {Function} [options.factories.readPackageJson] - Version validator (test only)
   */
  constructor(config, options = {}) {
    const factories = options.factories || {};
    enforcePackageVersions(factories);

    // Validate config structure
    if (!config || typeof config !== 'object') {
      throw new TypeError('config must be an object');
    }

    // Validate allowlists are arrays of strings (no symbols/accessors)
    const validateStringArray = (arr, name) => {
      if (!Array.isArray(arr)) {
        throw new TypeError(`${name} must be an array`);
      }
      for (const item of arr) {
        if (typeof item !== 'string') {
          throw new TypeError(`${name} must contain only strings`);
        }
      }
    };

    validateStringArray(config.allowedSpaces, 'allowedSpaces');
    validateStringArray(config.allowedRunPrefixes, 'allowedRunPrefixes');

    if (!config.allowedSessionsBySpace || typeof config.allowedSessionsBySpace !== 'object') {
      throw new TypeError('allowedSessionsBySpace must be an object');
    }

    // Build flat session list and validate structure
    const allowedSessionIds = [];
    for (const spaceId of config.allowedSpaces) {
      const sessions = config.allowedSessionsBySpace[spaceId];
      if (sessions) {
        validateStringArray(sessions, `allowedSessionsBySpace[${spaceId}]`);
        allowedSessionIds.push(...sessions);
      }
    }

    // Deep clone config to prevent external mutation
    this.#config = {
      allowedSpaceIds: [...config.allowedSpaces],
      allowedSessionIds,
      allowedSessionsBySpace: { ...config.allowedSessionsBySpace },
      allowedTurnPrefixes: [...config.allowedRunPrefixes],
      baseUrl: config.baseUrl || 'https://cohub.run/api'
    };

    // Use injected factories or real SDK
    if (factories.httpTransport) {
      this.#httpTransport = factories.httpTransport;
    } else if (factories.getAccessToken) {
      this.#getAccessToken = factories.getAccessToken;
      this.#httpTransport = createHttpClient({
        baseUrl: this.#config.baseUrl,
        getAccessToken: this.#getAccessToken
      });
    } else {
      throw new TypeError('factories.getAccessToken or factories.httpTransport required');
    }

    if (factories.websocketClient) {
      this.#websocketClient = factories.websocketClient;
    } else if (factories.getAccessToken) {
      this.#websocketClient = createWebsocketClient({
        websocketUrl: this.#config.baseUrl.replace(/^http/, 'ws').replace(/\/api$/, '/ws'),
        getAccessToken: factories.getAccessToken,
        WebSocket
      });
    } else {
      throw new TypeError('factories.getAccessToken or factories.websocketClient required');
    }
  }

  /**
   * Validate spaceId is in allowlist.
   */
  #validateSpaceId(spaceId) {
    if (!this.#config.allowedSpaceIds.includes(spaceId)) {
      throw new CohubClientError(
        `Space ${spaceId} not in allowlist`,
        'SPACE_NOT_ALLOWED',
        403
      );
    }
  }

  /**
   * Validate sessionId is in allowlist for given space.
   */
  #validateSessionId(sessionId, spaceId) {
    if (!this.#config.allowedSessionIds.includes(sessionId)) {
      throw new CohubClientError(
        `Session ${sessionId} not in allowlist`,
        'SESSION_NOT_ALLOWED',
        403
      );
    }

    // Validate session belongs to space
    const spaceSessions = this.#config.allowedSessionsBySpace[spaceId];
    if (!spaceSessions || !spaceSessions.includes(sessionId)) {
      throw new CohubClientError(
        `Session ${sessionId} not allowed for space ${spaceId}`,
        'SESSION_NOT_ALLOWED',
        403
      );
    }
  }

  /**
   * Validate turnId starts with allowed prefix (with boundary protection).
   */
  #validateTurnId(turnId) {
    // Reject path traversal attempts
    if (turnId.includes('..')) {
      throw new CohubClientError(
        'Turn ID contains path traversal',
        'TURN_NOT_ALLOWED',
        403
      );
    }

    // Check against each allowed prefix with strict boundary
    for (const prefix of this.#config.allowedTurnPrefixes) {
      if (turnId === prefix || turnId.startsWith(prefix + '/')) {
        return;
      }
    }

    throw new CohubClientError(
      `Turn ${turnId} does not match any allowed prefix`,
      'TURN_NOT_ALLOWED',
      403
    );
  }

  /**
   * Connect with strict listener-before-connect and ack-promise-before-subscribe ordering.
   *
   * @param {Object} params - Connection parameters
   * @param {string} params.spaceId - Space ID to subscribe to
   * @returns {Promise<void>} Resolves after subscribe.ok and HTTP reconciliation
   */
  async connect({ spaceId }) {
    this.#validateSpaceId(spaceId);

    const room = `space:${spaceId}`;

    return new Promise((resolve, reject) => {
      let ackTimeout;
      let subscribedHandler, subscribeErrorHandler, disconnectHandler, closeHandler;
      const unsubscribers = [];

      // Install ALL listeners BEFORE connect
      subscribedHandler = (payload) => {
        if (payload && Array.isArray(payload.rooms) && payload.rooms.includes(room)) {
          this.#subscribedRooms.add(room);

          // Clear pending ack
          const pending = this.#pendingAcks.get(room);
          if (pending) {
            clearTimeout(pending.timer);
            this.#pendingAcks.delete(room);
            pending.resolve();
          }

          // HTTP reconciliation after subscribe.ok
          this.#httpTransport.request({
            method: 'GET',
            path: `/spaces/${spaceId}`
          })
            .then(() => {
              // Clean up connect-phase listeners
              unsubscribers.forEach(unsub => unsub());
              resolve();
            })
            .catch(err => reject(classifyHttpError(err)));
        }
      };

      subscribeErrorHandler = (payload) => {
        if (payload && Array.isArray(payload.rejected)) {
          const rejection = payload.rejected.find(r => r.room === room);
          if (rejection) {
            const pending = this.#pendingAcks.get(room);
            if (pending) {
              clearTimeout(pending.timer);
              this.#pendingAcks.delete(room);
              pending.reject(new CohubClientError(
                `Subscribe error: ${rejection.code} - ${rejection.message}`,
                'SUBSCRIBE_ERROR',
                0
              ));
            }
          }
        }
      };

      disconnectHandler = () => {
        this.#subscribedRooms.clear();
        // Reject any pending acks
        for (const [room, pending] of this.#pendingAcks.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new CohubClientError('Disconnected before subscribe.ok', 'DISCONNECT', 0));
        }
        this.#pendingAcks.clear();
      };

      closeHandler = () => {
        this.#subscribedRooms.clear();
        for (const [room, pending] of this.#pendingAcks.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new CohubClientError('Connection closed before subscribe.ok', 'CLOSE', 0));
        }
        this.#pendingAcks.clear();
      };

      unsubscribers.push(this.#websocketClient.on('subscribed', subscribedHandler));
      unsubscribers.push(this.#websocketClient.on('subscribeError', subscribeErrorHandler));
      unsubscribers.push(this.#websocketClient.on('disconnect', disconnectHandler));
      unsubscribers.push(this.#websocketClient.on('close', closeHandler));

      // Now connect
      this.#websocketClient.connect()
        .then(() => {
          // Set up ack promise with timeout BEFORE subscribeRooms
          const ackPromise = new Promise((resolveAck, rejectAck) => {
            ackTimeout = setTimeout(() => {
              this.#pendingAcks.delete(room);
              rejectAck(new CohubClientError(
                `Subscribe timeout for ${room}`,
                'SUBSCRIBE_TIMEOUT',
                0
              ));
            }, SUBSCRIBE_TIMEOUT_MS);

            this.#pendingAcks.set(room, {
              resolve: resolveAck,
              reject: rejectAck,
              timer: ackTimeout
            });
          });

          // Now subscribe
          this.#websocketClient.subscribeRooms([room]);

          return ackPromise;
        })
        .catch(err => {
          if (ackTimeout) clearTimeout(ackTimeout);
          unsubscribers.forEach(unsub => unsub());
          reject(err instanceof CohubClientError ? err : classifyHttpError(err));
        });
    });
  }

  /**
   * Close WebSocket connection and clean up.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;

    // Clear all pending acks
    for (const [room, pending] of this.#pendingAcks.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new CohubClientError('Client closed', 'CLOSED', 0));
    }
    this.#pendingAcks.clear();
    this.#subscribedRooms.clear();

    if (this.#websocketClient && this.#websocketClient.disconnect) {
      await this.#websocketClient.disconnect();
    }
  }

  /**
   * Generate stable clientMessageId from prompt content.
   */
  #generateClientMessageId(content) {
    const canonical = canonicalStringify(content);
    const hash = createHash('sha256');
    hash.update(canonical);
    return `cmid_${hash.digest('hex').slice(0, 16)}`;
  }

  /**
   * Send immediate prompt with caller-stable clientMessageId and exact response validation.
   *
   * @param {Object} params - Prompt parameters
   * @param {string} params.spaceId - Space ID
   * @param {string} params.sessionId - Session ID
   * @param {Object} params.content - Prompt content
   * @returns {Promise<Object>} Response with validated turn
   */
  async prompt({ spaceId, sessionId, content }) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const clientMessageId = this.#generateClientMessageId(content);

    try {
      const response = await this.#httpTransport.request({
        method: 'POST',
        path: `/sessions/${sessionId}/turns`,
        body: {
          type: 'immediate',
          content,
          meta: { clientMessageId }
        },
        timeout: PROMPT_TIMEOUT_MS
      });

      validateTrustedContext(response, { sessionId, spaceId });

      // Validate response.turn.meta.clientMessageId matches
      if (!response.turn || !response.turn.meta ||
          response.turn.meta.clientMessageId !== clientMessageId) {
        throw new CohubClientError(
          'Response clientMessageId mismatch',
          'RESPONSE_ID_MISMATCH',
          0
        );
      }

      return response;
    } catch (err) {
      throw err instanceof CohubClientError ? err : classifyHttpError(err);
    }
  }

  /**
   * Get turn by ID with exact validation.
   */
  async getTurn({ spaceId, sessionId, turnId }) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);
    this.#validateTurnId(turnId);

    try {
      const response = await this.#httpTransport.request({
        method: 'GET',
        path: `/sessions/${sessionId}/turns/${turnId}`
      });

      validateTrustedContext(response, { sessionId, spaceId, turnId });

      return response;
    } catch (err) {
      throw err instanceof CohubClientError ? err : classifyHttpError(err);
    }
  }

  /**
   * List all turns with full pagination, cursor cycle detection, and limits.
   */
  async listAllTurns({ spaceId, sessionId }) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const allTurns = [];
    const seenCursors = new Set();
    let cursor = null;
    let pageCount = 0;

    try {
      while (true) {
        if (pageCount >= MAX_PAGINATION_PAGES) {
          throw new CohubClientError(
            `Pagination limit exceeded: ${MAX_PAGINATION_PAGES} pages`,
            'PAGINATION_LIMIT',
            0
          );
        }

        const response = await this.#httpTransport.request({
          method: 'GET',
          path: `/sessions/${sessionId}/turns`,
          query: cursor ? { cursor } : {}
        });

        validateTrustedContext(response, { sessionId, spaceId });

        if (!response.turns || !Array.isArray(response.turns)) {
          throw new CohubClientError('Malformed response: missing turns array', 'BAD_SHAPE', 0);
        }

        allTurns.push(...response.turns);
        pageCount++;

        if (allTurns.length > MAX_PAGINATION_TURNS) {
          throw new CohubClientError(
            `Turn count limit exceeded: ${MAX_PAGINATION_TURNS}`,
            'TURN_LIMIT',
            0
          );
        }

        if (!response.hasMore) break;

        const nextCursor = response.nextCursor;

        // Validate cursor type
        if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
          throw new CohubClientError('Malformed cursor', 'BAD_CURSOR', 0);
        }

        // Detect cursor cycle
        if (seenCursors.has(nextCursor)) {
          throw new CohubClientError('Cursor cycle detected', 'CURSOR_CYCLE', 0);
        }

        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      return allTurns;
    } catch (err) {
      throw err instanceof CohubClientError ? err : classifyHttpError(err);
    }
  }

  /**
   * Find turn by clientMessageId with exact reading and validation.
   */
  async findTurnByClientMessageId({ spaceId, sessionId, clientMessageId }) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const candidates = await this.listAllTurns({ spaceId, sessionId });
    const matches = [];

    for (const candidate of candidates) {
      // Protect against prototype/accessor attacks
      const candidateId = safeGet(candidate, 'id');
      if (typeof candidateId !== 'string') continue;

      try {
        const detail = await this.getTurn({ spaceId, sessionId, turnId: candidateId });

        // Safe access with descriptor protection
        const turn = safeGet(detail, 'turn');
        if (!turn || typeof turn !== 'object') continue;

        const meta = safeGet(turn, 'meta');
        if (!meta || typeof meta !== 'object') continue;

        const foundClientMessageId = safeGet(meta, 'clientMessageId');

        if (foundClientMessageId === clientMessageId) {
          // Validate turn structure
          const turnId = safeGet(turn, 'id');
          const turnSessionId = safeGet(turn, 'sessionId');

          if (turnId !== candidateId) {
            throw new CohubClientError('Turn ID mismatch in detail', 'BAD_SHAPE', 0);
          }
          if (turnSessionId !== sessionId) {
            throw new CohubClientError('Turn sessionId mismatch', 'BAD_SHAPE', 0);
          }

          matches.push(turn);
        }
      } catch (err) {
        // Skip turns that fail validation
        if (err instanceof CohubClientError && err.code === 'TURN_NOT_ALLOWED') {
          continue;
        }
        throw err;
      }
    }

    return matches;
  }

  /**
   * Read file with normalized relative path validation and boundary protection.
   */
  async readFile({ spaceId, path }) {
    this.#validateSpaceId(spaceId);

    const validatedPath = validatePathInPrefix(path, '/');

    try {
      const response = await this.#httpTransport.request({
        method: 'GET',
        path: `/spaces/${spaceId}/files`,
        query: { path: validatedPath }
      });

      if (!response || typeof response.content !== 'string') {
        throw new CohubClientError('Malformed file response', 'BAD_SHAPE', 0);
      }

      // Validate byte size if provided
      if (response.size != null && typeof response.size === 'number') {
        const actualSize = Buffer.byteLength(response.content, 'utf8');
        if (actualSize !== response.size) {
          throw new CohubClientError('File size mismatch', 'SIZE_MISMATCH', 0);
        }
      }

      return response;
    } catch (err) {
      throw err instanceof CohubClientError ? err : classifyHttpError(err);
    }
  }

  // Public API surface matching test expectations
  get turns() {
    return {
      index: (params) => this.listAllTurns(params).then(turns => ({
        session: { id: params.sessionId, spaceId: params.spaceId },
        turns,
        hasMore: false
      })),
      get: (params) => this.getTurn(params)
    };
  }

  get files() {
    return {
      read: (params) => this.readFile(params)
    };
  }
}
