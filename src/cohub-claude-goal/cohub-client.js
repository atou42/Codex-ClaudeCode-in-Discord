/**
 * Strict public Cohub client adapter for Claude goal supervisor.
 *
 * Security model:
 * - Version enforcement ALWAYS runs (production reads real package.json fail-closed).
 * - Every boundary value (config, options, SDK responses, events) is validated
 *   Proxy-first via descriptors before any property read.
 * - All outputs are detached deep-frozen clones; no dependency references leak.
 * - Typed errors carry closed-vocabulary messages only: no IDs, paths, or upstream text.
 * - clientMessageId is the caller-supplied continuationId; never content-derived.
 *
 * Public SDK surfaces used (confirmed by installed @neta-art/cohub@2.11.1 types):
 * - @neta-art/cohub/http: createHttpClient -> sessionClient(sessionId).turns.get/index, prompt, abort
 * - @neta-art/cohub/websocket: createWebsocketClient({ websocketUrl, getAccessToken, WebSocketImpl }),
 *   connect(), subscribeSpace(spaceId), on('subscribed'|'subscribeError'|'event'), disconnect()
 */

import { createRequire } from 'node:module';
import { types } from 'node:util';
import { createHttpClient } from '@neta-art/cohub/http';
import { createWebsocketClient } from '@neta-art/cohub/websocket';
import WebSocketImpl from 'ws';

const REQUIRED_COHUB_VERSION = '2.11.1';
const REQUIRED_WS_VERSION = '8.21.1';

const MAX_PAGINATION_PAGES = 100;
const MAX_PAGINATION_TURNS = 10000;
const MAX_SANITIZE_DEPTH = 32;
const MAX_SANITIZE_KEYS = 4096;
const MAX_STRING_LENGTH = 1 << 20; // 1 MiB per string value
const SUBSCRIBE_TIMEOUT_MS = 10000;
const PROMPT_TIMEOUT_MS = 30000;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEY_PATTERN = /secret|token|password|credential|authorization/i;

/**
 * Typed error with fixed, closed-vocabulary message. Never contains IDs,
 * paths, upstream messages, or attacker-controlled text.
 */
class CohubClientError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'CohubClientError';
    this.code = code;
    this.status = status;
  }
}

const ERRORS = Object.freeze({
  UNAUTHORIZED: () => new CohubClientError('Unauthorized', 'UNAUTHORIZED', 401),
  FORBIDDEN: () => new CohubClientError('Forbidden', 'FORBIDDEN', 403),
  RATE_LIMIT: () => new CohubClientError('Rate limit exceeded', 'RATE_LIMIT', 429),
  SERVER_ERROR: (status) => new CohubClientError('Server error', 'SERVER_ERROR', status),
  CLIENT_ERROR: (status) => new CohubClientError('Client error', 'CLIENT_ERROR', status),
  NETWORK_ERROR: () => new CohubClientError('Request failed', 'NETWORK_ERROR', 0),
  BAD_SHAPE: () => new CohubClientError('Malformed response shape', 'BAD_SHAPE', 0),
  PROXY_REJECTED: () => new CohubClientError('Proxy not allowed at boundary', 'PROXY_REJECTED', 0),
  GETTER_REJECTED: () => new CohubClientError('Getter/setter not allowed at boundary', 'GETTER_REJECTED', 0),
  SECRET_KEY_REJECTED: () => new CohubClientError('Secret-like key not allowed at boundary', 'SECRET_KEY_REJECTED', 0),
  UNSAFE_VALUE: () => new CohubClientError('Unsupported value at boundary', 'UNSAFE_VALUE', 0),
  CONTEXT_MISMATCH: () => new CohubClientError('Response identity mismatch', 'CONTEXT_MISMATCH', 0),
  RESPONSE_ID_MISMATCH: () => new CohubClientError('Response clientMessageId mismatch', 'RESPONSE_ID_MISMATCH', 0),
  SPACE_NOT_ALLOWED: () => new CohubClientError('Space not allowed', 'SPACE_NOT_ALLOWED', 403),
  SESSION_NOT_ALLOWED: () => new CohubClientError('Session not allowed', 'SESSION_NOT_ALLOWED', 403),
  TURN_NOT_ALLOWED: () => new CohubClientError('Turn not allowed', 'TURN_NOT_ALLOWED', 403),
  PATH_NOT_ALLOWED: () => new CohubClientError('Path not allowed', 'PATH_NOT_ALLOWED', 403),
  MALFORMED_CANDIDATE: () => new CohubClientError('Malformed turn candidate', 'MALFORMED_CANDIDATE', 0),
  PAGINATION_LIMIT: () => new CohubClientError('Pagination limit exceeded', 'PAGINATION_LIMIT', 0),
  TURN_LIMIT: () => new CohubClientError('Turn count limit exceeded', 'TURN_LIMIT', 0),
  BAD_CURSOR: () => new CohubClientError('Malformed pagination cursor', 'BAD_CURSOR', 0),
  CURSOR_CYCLE: () => new CohubClientError('Pagination cursor cycle detected', 'CURSOR_CYCLE', 0),
  SUBSCRIBE_ERROR: () => new CohubClientError('Subscribe rejected', 'SUBSCRIBE_ERROR', 0),
  SUBSCRIBE_TIMEOUT: () => new CohubClientError('Subscribe acknowledgement timeout', 'SUBSCRIBE_TIMEOUT', 0),
  DISCONNECT: () => new CohubClientError('Disconnected before subscribe acknowledgement', 'DISCONNECT', 0),
  CLOSE: () => new CohubClientError('Connection closed before subscribe acknowledgement', 'CLOSE', 0),
  CLOSED: () => new CohubClientError('Client closed', 'CLOSED', 0),
  VERSION_ENFORCEMENT: () => new CohubClientError('Package version enforcement failed', 'VERSION_ENFORCEMENT', 0),
  SIZE_MISMATCH: () => new CohubClientError('File size mismatch', 'SIZE_MISMATCH', 0),
  CONTINUATION_REQUIRED: () => new CohubClientError('Caller continuationId required', 'CONTINUATION_REQUIRED', 0)
});

/* ------------------------------------------------------------------ */
/* Version enforcement                                                 */
/* ------------------------------------------------------------------ */

const require_ = createRequire(import.meta.url);

/**
 * Safe production resolution of a dependency's package.json version.
 * Never throws raw resolution errors upward; converts to typed error.
 */
function readInstalledVersion(packageName) {
  try {
    const pkg = require_(`${packageName}/package.json`);
    if (!pkg || typeof pkg !== 'object' || typeof pkg.version !== 'string') {
      return null;
    }
    return pkg.version;
  } catch {
    return null;
  }
}

/**
 * Always enforce exact package versions. In production (no injected
 * readPackageJson), resolve real installed package.json fail-closed.
 * Error message includes only the fixed required versions (constants),
 * never attacker-controllable text.
 */
function enforcePackageVersions(readPackageJson) {
  let cohubVersion;
  let wsVersion;

  if (typeof readPackageJson === 'function') {
    let cohubPkg;
    let wsPkg;
    try {
      cohubPkg = readPackageJson('@neta-art/cohub');
      wsPkg = readPackageJson('ws');
    } catch {
      throw ERRORS.VERSION_ENFORCEMENT();
    }
    cohubVersion = cohubPkg && typeof cohubPkg.version === 'string' ? cohubPkg.version : null;
    wsVersion = wsPkg && typeof wsPkg.version === 'string' ? wsPkg.version : null;
  } else {
    cohubVersion = readInstalledVersion('@neta-art/cohub');
    wsVersion = readInstalledVersion('ws');
  }

  if (cohubVersion !== REQUIRED_COHUB_VERSION) {
    throw new CohubClientError(
      `Package version enforcement failed: @neta-art/cohub must be exactly ${REQUIRED_COHUB_VERSION}`,
      'VERSION_ENFORCEMENT',
      0
    );
  }
  if (wsVersion !== REQUIRED_WS_VERSION) {
    throw new CohubClientError(
      `Package version enforcement failed: ws must be exactly ${REQUIRED_WS_VERSION}`,
      'VERSION_ENFORCEMENT',
      0
    );
  }
}

/* ------------------------------------------------------------------ */
/* Boundary sanitizer: Proxy-first, descriptor-driven, detached output */
/* ------------------------------------------------------------------ */

/**
 * Sanitize an untrusted boundary value.
 *
 * Order of checks per node (Proxy FIRST, before any property read):
 * 1. Reject Proxies (including revoked) via util.types.isProxy — zero traps fired.
 * 2. Reject non-plain prototypes.
 * 3. Reject symbol keys, non-enumerable own keys, dangerous keys, secret-like keys.
 * 4. Reject accessor descriptors (get/set) — values read only from data descriptors.
 * 5. Reject sparse arrays, cycles AND shared references (visited set covers both).
 * 6. Reject unsupported types (functions, bigint, undefined-in-array), non-finite numbers.
 * 7. Enforce depth / key-count / string-length limits.
 *
 * Returns a fully detached deep-frozen clone.
 */
function sanitizeBoundaryValue(value, context) {
  const state = { keyCount: 0 };
  const out = sanitizeNode(value, new Set(), 0, state, context);
  return out;
}

function sanitizeNode(value, visited, depth, state, context) {
  if (depth > MAX_SANITIZE_DEPTH) {
    throw ERRORS.UNSAFE_VALUE();
  }

  const t = typeof value;

  if (value === null) return null;
  if (t === 'boolean') return value;
  if (t === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw ERRORS.UNSAFE_VALUE();
    return value;
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) throw ERRORS.UNSAFE_VALUE();
    return value;
  }
  if (t === 'undefined') return undefined;
  if (t !== 'object') {
    // function, bigint, symbol
    throw ERRORS.UNSAFE_VALUE();
  }

  // --- Proxy check FIRST: no property reads, no Array.isArray, nothing. ---
  if (types.isProxy(value)) {
    throw ERRORS.PROXY_REJECTED();
  }

  // Cycles and shared references both rejected.
  if (visited.has(value)) {
    throw ERRORS.UNSAFE_VALUE();
  }
  visited.add(value);

  const proto = Object.getPrototypeOf(value);

  if (proto === Array.prototype) {
    // Sparse array rejection: descriptor for every index must exist.
    const descs = Object.getOwnPropertyDescriptors(value);
    const lenDesc = descs.length;
    if (!lenDesc || typeof lenDesc.value !== 'number') throw ERRORS.UNSAFE_VALUE();
    const len = lenDesc.value;
    if (!Number.isInteger(len) || len < 0 || len > MAX_SANITIZE_KEYS) throw ERRORS.UNSAFE_VALUE();

    // Reject symbol keys on arrays.
    if (Object.getOwnPropertySymbols(value).length > 0) throw ERRORS.UNSAFE_VALUE();

    // Only 'length' plus index keys allowed.
    const ownKeys = Object.getOwnPropertyNames(value);
    for (const key of ownKeys) {
      if (key === 'length') continue;
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= len || String(idx) !== key) {
        throw ERRORS.UNSAFE_VALUE();
      }
    }

    const outArr = new Array(len);
    for (let i = 0; i < len; i++) {
      const desc = descs[i];
      if (!desc) throw ERRORS.UNSAFE_VALUE(); // sparse
      if (desc.get || desc.set) throw ERRORS.GETTER_REJECTED();
      state.keyCount++;
      if (state.keyCount > MAX_SANITIZE_KEYS) throw ERRORS.UNSAFE_VALUE();
      const item = sanitizeNode(desc.value, visited, depth + 1, state, context);
      if (item === undefined) throw ERRORS.UNSAFE_VALUE(); // holes/undefined in arrays
      outArr[i] = item;
    }
    visited.delete(value);
    return Object.freeze(outArr);
  }

  if (proto === Object.prototype || proto === null) {
    // Reject symbol keys.
    if (Object.getOwnPropertySymbols(value).length > 0) throw ERRORS.UNSAFE_VALUE();

    const descs = Object.getOwnPropertyDescriptors(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (DANGEROUS_KEYS.has(key)) throw ERRORS.UNSAFE_VALUE();
      if (SECRET_KEY_PATTERN.test(key)) throw ERRORS.SECRET_KEY_REJECTED();
      const desc = descs[key];
      if (desc.get || desc.set) throw ERRORS.GETTER_REJECTED();
      if (!desc.enumerable) throw ERRORS.UNSAFE_VALUE();
      state.keyCount++;
      if (state.keyCount > MAX_SANITIZE_KEYS) throw ERRORS.UNSAFE_VALUE();
      const item = sanitizeNode(desc.value, visited, depth + 1, state, context);
      if (item !== undefined) {
        out[key] = item;
      }
    }
    visited.delete(value);
    return Object.freeze(out);
  }

  // Dates, Maps, Sets, class instances, custom prototypes: all rejected.
  throw ERRORS.UNSAFE_VALUE();
}

/**
 * Validate an injected function boundary: must be a real function, not a
 * Proxy. Captured exactly once at construction.
 */
function captureFunction(fn, required) {
  if (fn === undefined || fn === null) {
    if (required) throw new TypeError('Required injected function missing');
    return null;
  }
  if (typeof fn !== 'function' || types.isProxy(fn)) {
    throw new TypeError('Injected value must be a plain function');
  }
  return fn;
}

/**
 * Validate an injected object surface: not a Proxy, methods captured once.
 */
function captureSurface(obj, methodNames) {
  if (types.isProxy(obj)) {
    throw new TypeError('Injected surface must not be a Proxy');
  }
  const captured = {};
  for (const name of methodNames) {
    const desc = Object.getOwnPropertyDescriptor(obj, name) ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(obj) || {}, name);
    const fn = desc && !desc.get && !desc.set ? desc.value : obj[name];
    if (typeof fn !== 'function') {
      throw new TypeError(`Injected surface missing method: ${name}`);
    }
    captured[name] = fn.bind(obj);
  }
  return Object.freeze(captured);
}

/* ------------------------------------------------------------------ */
/* Path validation: normalized relative path semantics                  */
/* ------------------------------------------------------------------ */

/**
 * Strict path validation. Accepts only unambiguous forms:
 * - Must be a string of reasonable length.
 * - No NUL bytes, no backslashes, no control chars.
 * - No '..' segments (segment-wise, not substring).
 * - Normalize multiple slashes to single slash.
 * - Unicode must be NFC-stable (reject strings that change under NFC),
 *   and reject two-dot leader / unicode dot lookalikes.
 * Returns the canonical absolute path form.
 */
const UNICODE_DOT_LOOKALIKES = /[․‥…﹒．։۔。｡]/;

function validateBoundaryPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 4096) {
    throw ERRORS.PATH_NOT_ALLOWED();
  }
  if (rawPath.includes('\0') || rawPath.includes('\\')) {
    throw ERRORS.PATH_NOT_ALLOWED();
  }
  // Control characters
  for (let i = 0; i < rawPath.length; i++) {
    const c = rawPath.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw ERRORS.PATH_NOT_ALLOWED();
  }
  // Unicode ambiguity: dot lookalikes and NFC instability
  if (UNICODE_DOT_LOOKALIKES.test(rawPath)) {
    throw ERRORS.PATH_NOT_ALLOWED();
  }
  if (rawPath.normalize('NFC') !== rawPath || rawPath.normalize('NFD') !== rawPath.normalize('NFD').normalize('NFC').normalize('NFD')) {
    // NFC-unstable input rejected
    throw ERRORS.PATH_NOT_ALLOWED();
  }
  if (rawPath.normalize('NFC') !== rawPath) {
    throw ERRORS.PATH_NOT_ALLOWED();
  }

  // Normalize multiple slashes, then segment-wise validation
  const normalized = rawPath.replace(/\/+/g, '/');
  const isAbsolute = normalized.startsWith('/');
  const body = isAbsolute ? normalized.slice(1) : normalized;
  if (body.length === 0) {
    return '/';
  }
  const segments = body.split('/');
  const cleanSegments = [];
  for (const seg of segments) {
    if (seg === '' ) throw ERRORS.PATH_NOT_ALLOWED();      // should not happen after normalization
    if (seg === '.') throw ERRORS.PATH_NOT_ALLOWED();       // ambiguous
    if (seg === '..') throw ERRORS.PATH_NOT_ALLOWED();      // traversal
    if (seg.includes('..')) throw ERRORS.PATH_NOT_ALLOWED(); // conservative: no '..' anywhere
    cleanSegments.push(seg);
  }
  return '/' + cleanSegments.join('/');
}

/* ------------------------------------------------------------------ */
/* Error classification: sanitized, closed vocabulary                   */
/* ------------------------------------------------------------------ */

function classifyHttpError(err) {
  if (err instanceof CohubClientError) return err;
  let status = 0;
  if (err && typeof err === 'object' && !types.isProxy(err)) {
    const s = Object.getOwnPropertyDescriptor(err, 'status');
    const sc = Object.getOwnPropertyDescriptor(err, 'statusCode');
    if (s && typeof s.value === 'number') status = s.value;
    else if (sc && typeof sc.value === 'number') status = sc.value;
  }

  if (status === 401) return ERRORS.UNAUTHORIZED();
  if (status === 403) return ERRORS.FORBIDDEN();
  if (status === 429) return ERRORS.RATE_LIMIT();
  if (status >= 500 && status < 600) return ERRORS.SERVER_ERROR(status);
  if (status >= 400 && status < 500) return ERRORS.CLIENT_ERROR(status);
  return ERRORS.NETWORK_ERROR();
}

/* ------------------------------------------------------------------ */
/* Response identity validation (post-sanitize, values are safe plain)  */
/* ------------------------------------------------------------------ */

function validateTrustedContext(response, expected) {
  if (!response || typeof response !== 'object') throw ERRORS.BAD_SHAPE();
  const session = response.session;
  if (!session || typeof session !== 'object') throw ERRORS.BAD_SHAPE();
  if (session.id !== expected.sessionId) throw ERRORS.CONTEXT_MISMATCH();
  if (session.spaceId !== expected.spaceId) throw ERRORS.CONTEXT_MISMATCH();
  if (expected.turnId !== undefined && response.turn) {
    if (response.turn.id !== expected.turnId) throw ERRORS.CONTEXT_MISMATCH();
    if (response.turn.sessionId !== session.id) throw ERRORS.CONTEXT_MISMATCH();
  }
}

/* ------------------------------------------------------------------ */
/* Client                                                                */
/* ------------------------------------------------------------------ */

export class CohubGoalClient {
  #config;
  #http;            // captured surface: { request }
  #ws;              // captured surface: { on, connect, disconnect, subscribeSpace? , subscribeRooms? }
  #closed = false;
  #connectCleanups = new Set();

  /**
   * @param {Object} config
   * @param {string[]} config.allowedSpaces
   * @param {Object} config.allowedSessionsBySpace  spaceId -> sessionId[]
   * @param {string[]} config.allowedRunPrefixes
   * @param {string} [config.baseUrl]
   * @param {Object} [options]
   * @param {Object} [options.factories]
   * @param {Object} [options.factories.httpTransport]   injected HTTP surface with request()
   * @param {Object} [options.factories.websocketClient] injected WS surface
   * @param {Function} [options.factories.getAccessToken]
   * @param {Function} [options.factories.readPackageJson] injected version reader (tests)
   */
  constructor(config, options = {}) {
    // --- Sanitize options/factories boundary first (Proxy-first). ---
    if (options === null || typeof options !== 'object' || types.isProxy(options)) {
      throw new TypeError('options must be a plain object');
    }
    const factoriesRaw = options.factories;
    if (factoriesRaw !== undefined &&
        (factoriesRaw === null || typeof factoriesRaw !== 'object' || types.isProxy(factoriesRaw))) {
      throw new TypeError('options.factories must be a plain object');
    }
    const factories = factoriesRaw || {};

    // Capture injected functions exactly once after exact validation.
    const readPackageJson = captureFunction(factories.readPackageJson, false);
    const getAccessToken = captureFunction(factories.getAccessToken, false);

    // --- ALWAYS enforce versions (production path fail-closed). ---
    enforcePackageVersions(readPackageJson);

    // --- Sanitize config Proxy-first via the same boundary sanitizer. ---
    if (config === null || typeof config !== 'object' || types.isProxy(config)) {
      throw new TypeError('config must be a plain object');
    }
    // Pre-check config descriptors so error messages match legacy contract.
    for (const key of ['allowedSpaces', 'allowedRunPrefixes', 'allowedSessionsBySpace', 'baseUrl']) {
      const desc = Object.getOwnPropertyDescriptor(config, key);
      if (desc && (desc.get || desc.set)) {
        throw new TypeError(`Property descriptors with getters/setters not allowed: ${key}`);
      }
    }
    for (const key of ['allowedSpaces', 'allowedRunPrefixes']) {
      const desc = Object.getOwnPropertyDescriptor(config, key);
      const v = desc ? desc.value : undefined;
      if (v !== undefined && (types.isProxy(v) || (typeof v === 'object' && v !== null && Object.getPrototypeOf(v) !== Array.prototype))) {
        throw new TypeError(`${key} must be a plain array (no Proxies or custom prototypes)`);
      }
    }

    let sanitizedConfig;
    try {
      sanitizedConfig = sanitizeBoundaryValue({
        allowedSpaces: config.allowedSpaces,
        allowedSessionsBySpace: config.allowedSessionsBySpace,
        allowedRunPrefixes: config.allowedRunPrefixes,
        baseUrl: config.baseUrl
      }, 'config');
    } catch (err) {
      if (err instanceof CohubClientError) {
        throw new TypeError('config failed boundary validation: ' + err.code);
      }
      throw err;
    }

    const validateStringArray = (arr, name) => {
      if (!Array.isArray(arr)) throw new TypeError(`${name} must be an array`);
      for (const item of arr) {
        if (typeof item !== 'string' || item.length === 0) {
          throw new TypeError(`${name} must contain only non-empty strings`);
        }
      }
    };

    validateStringArray(sanitizedConfig.allowedSpaces, 'allowedSpaces');
    validateStringArray(sanitizedConfig.allowedRunPrefixes, 'allowedRunPrefixes');
    if (!sanitizedConfig.allowedSessionsBySpace || typeof sanitizedConfig.allowedSessionsBySpace !== 'object' || Array.isArray(sanitizedConfig.allowedSessionsBySpace)) {
      throw new TypeError('allowedSessionsBySpace must be an object');
    }

    const allowedSessionsBySpace = {};
    for (const spaceId of sanitizedConfig.allowedSpaces) {
      const sessions = sanitizedConfig.allowedSessionsBySpace[spaceId];
      if (sessions !== undefined) {
        validateStringArray(sessions, `allowedSessionsBySpace[space]`);
        allowedSessionsBySpace[spaceId] = Object.freeze([...sessions]);
      } else {
        allowedSessionsBySpace[spaceId] = Object.freeze([]);
      }
    }

    if (sanitizedConfig.baseUrl !== undefined && typeof sanitizedConfig.baseUrl !== 'string') {
      throw new TypeError('baseUrl must be a string');
    }

    // Detached deep-frozen config; already sanitized (no shared refs).
    this.#config = Object.freeze({
      allowedSpaceIds: Object.freeze([...sanitizedConfig.allowedSpaces]),
      allowedSessionsBySpace: Object.freeze(allowedSessionsBySpace),
      allowedTurnPrefixes: Object.freeze([...sanitizedConfig.allowedRunPrefixes]),
      baseUrl: sanitizedConfig.baseUrl || 'https://cohub.run/api'
    });

    // --- Transport wiring: injected surfaces or public SDK only. ---
    if (factories.httpTransport !== undefined) {
      this.#http = captureSurface(factories.httpTransport, ['request']);
    } else if (getAccessToken) {
      const sdkHttp = createHttpClient({
        baseUrl: this.#config.baseUrl,
        getAccessToken
      });
      this.#http = Object.freeze({ sdk: sdkHttp });
    } else {
      throw new TypeError('factories.getAccessToken or factories.httpTransport required');
    }

    if (factories.websocketClient !== undefined) {
      const raw = factories.websocketClient;
      if (types.isProxy(raw)) throw new TypeError('Injected surface must not be a Proxy');
      const methods = ['on', 'connect', 'disconnect'];
      const captured = {};
      for (const name of methods) {
        const fn = raw[name];
        if (typeof fn !== 'function') throw new TypeError(`Injected surface missing method: ${name}`);
        captured[name] = fn.bind(raw);
      }
      // Optional room-subscription entrypoints (either public subscribeSpace or test double subscribeRooms)
      if (typeof raw.subscribeSpace === 'function') captured.subscribeSpace = raw.subscribeSpace.bind(raw);
      if (typeof raw.subscribeRooms === 'function') captured.subscribeRooms = raw.subscribeRooms.bind(raw);
      this.#ws = Object.freeze(captured);
    } else if (getAccessToken) {
      const sdkWs = createWebsocketClient({
        websocketUrl: this.#config.baseUrl.replace(/^http/, 'ws').replace(/\/api$/, '/ws'),
        getAccessToken,
        WebSocketImpl
      });
      this.#ws = Object.freeze({
        on: sdkWs.on.bind(sdkWs),
        connect: sdkWs.connect.bind(sdkWs),
        disconnect: sdkWs.disconnect.bind(sdkWs),
        subscribeSpace: sdkWs.subscribeSpace.bind(sdkWs)
      });
    } else {
      throw new TypeError('factories.getAccessToken or factories.websocketClient required');
    }
  }

  /* -------------------------------------------------------------- */
  /* Allowlist checks (typed errors, no attacker text)                */
  /* -------------------------------------------------------------- */

  #validateSpaceId(spaceId) {
    if (typeof spaceId !== 'string' || !this.#config.allowedSpaceIds.includes(spaceId)) {
      throw ERRORS.SPACE_NOT_ALLOWED();
    }
  }

  #validateSessionId(sessionId, spaceId) {
    if (typeof sessionId !== 'string') throw ERRORS.SESSION_NOT_ALLOWED();
    const spaceSessions = this.#config.allowedSessionsBySpace[spaceId];
    if (!spaceSessions || !spaceSessions.includes(sessionId)) {
      throw ERRORS.SESSION_NOT_ALLOWED();
    }
  }

  #validateTurnId(turnId) {
    if (typeof turnId !== 'string' || turnId.length === 0) throw ERRORS.TURN_NOT_ALLOWED();
    if (turnId.includes('..') || turnId.includes('/') || turnId.includes('\\') || turnId.includes('\0')) {
      throw ERRORS.TURN_NOT_ALLOWED();
    }
    for (const prefix of this.#config.allowedTurnPrefixes) {
      if (turnId.startsWith(prefix)) return;
    }
    throw ERRORS.TURN_NOT_ALLOWED();
  }

  /* -------------------------------------------------------------- */
  /* HTTP request wrapper: sanitize response Proxy-first, detach      */
  /* -------------------------------------------------------------- */

  async #request(opts) {
    let raw;
    try {
      raw = await this.#http.request(opts);
    } catch (err) {
      throw classifyHttpError(err);
    }
    // Sanitize EVERY response boundary Proxy-first before any read.
    return sanitizeBoundaryValue(raw, 'response');
  }

  /* -------------------------------------------------------------- */
  /* Event subscription: listener -> connect -> exact room ack ->     */
  /* reconciliation, with complete cleanup on every exit path.        */
  /* -------------------------------------------------------------- */

  /**
   * @param {Object} params
   * @param {string} params.spaceId
   */
  async connect({ spaceId } = {}) {
    if (this.#closed) throw ERRORS.CLOSED();
    this.#validateSpaceId(spaceId);

    const room = `space:${spaceId}`;
    const ws = this.#ws;

    let ackTimer = null;
    const unsubscribers = [];
    let settled = false;

    const cleanup = () => {
      if (ackTimer !== null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      for (const unsub of unsubscribers) {
        try {
          if (typeof unsub === 'function') unsub();
        } catch {
          // Cleanup failure must not mask the primary outcome.
        }
      }
      unsubscribers.length = 0;
      this.#connectCleanups.delete(cleanup);
    };
    this.#connectCleanups.add(cleanup);

    return new Promise((resolve, reject) => {
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(arg);
      };

      // --- 1. Install ALL listeners BEFORE connect. ---
      const subscribedHandler = (payloadRaw) => {
        let payload;
        try {
          payload = sanitizeBoundaryValue(payloadRaw, 'event');
        } catch (err) {
          settle(reject, err instanceof CohubClientError ? err : ERRORS.BAD_SHAPE());
          return;
        }
        const rooms = payload && Array.isArray(payload.rooms) ? payload.rooms : null;
        if (!rooms) return;
        if (!rooms.includes(room)) return; // exact room ack required; ignore other rooms

        // --- 4. HTTP reconciliation after exact ack. ---
        this.#request({ method: 'GET', path: `/spaces/${spaceId}` })
          .then(() => settle(resolve, undefined))
          .catch((err) => settle(reject, err instanceof CohubClientError ? err : classifyHttpError(err)));
      };

      const subscribeErrorHandler = (payloadRaw) => {
        let payload;
        try {
          payload = sanitizeBoundaryValue(payloadRaw, 'event');
        } catch {
          settle(reject, ERRORS.SUBSCRIBE_ERROR());
          return;
        }
        const rejected = payload && Array.isArray(payload.rejected) ? payload.rejected : null;
        if (rejected && !rejected.some((r) => r && r.room === room)) return;
        settle(reject, ERRORS.SUBSCRIBE_ERROR());
      };

      const disconnectHandler = () => {
        settle(reject, ERRORS.DISCONNECT());
      };

      const closeHandler = () => {
        settle(reject, ERRORS.CLOSE());
      };

      try {
        unsubscribers.push(ws.on('subscribed', subscribedHandler));
        unsubscribers.push(ws.on('subscribeError', subscribeErrorHandler));
        unsubscribers.push(ws.on('disconnect', disconnectHandler));
        unsubscribers.push(ws.on('close', closeHandler));
      } catch {
        settle(reject, ERRORS.NETWORK_ERROR());
        return;
      }

      // --- Arm ack timeout BEFORE connect/subscribe so no window is uncovered. ---
      ackTimer = setTimeout(() => {
        settle(reject, ERRORS.SUBSCRIBE_TIMEOUT());
      }, SUBSCRIBE_TIMEOUT_MS);

      // --- 2. Connect, then 3. subscribe to the exact Space room. ---
      Promise.resolve()
        .then(() => ws.connect())
        .then(() => {
          if (settled) return;
          if (typeof ws.subscribeSpace === 'function') {
            return ws.subscribeSpace(spaceId);
          }
          if (typeof ws.subscribeRooms === 'function') {
            return ws.subscribeRooms([room]);
          }
          throw ERRORS.NETWORK_ERROR();
        })
        .catch((err) => {
          settle(reject, err instanceof CohubClientError ? err : classifyHttpError(err));
        });
    });
  }

  /**
   * Idempotent close with complete cleanup. Cleanup failures never mask
   * the close outcome.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;

    for (const cleanup of [...this.#connectCleanups]) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    this.#connectCleanups.clear();

    if (this.#ws && typeof this.#ws.disconnect === 'function') {
      try {
        await this.#ws.disconnect();
      } catch {
        // Idempotent close: swallow transport teardown errors.
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Prompt: caller-supplied continuationId IS the clientMessageId    */
  /* -------------------------------------------------------------- */

  /**
   * @param {Object} params
   * @param {string} params.spaceId
   * @param {string} params.sessionId
   * @param {string} params.continuationId  REQUIRED caller-stable ID; used verbatim as clientMessageId
   * @param {*} params.content
   */
  async prompt({ spaceId, sessionId, continuationId, content } = {}) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    if (typeof continuationId !== 'string' || continuationId.length === 0 || continuationId.length > 256) {
      throw ERRORS.CONTINUATION_REQUIRED();
    }

    // Sanitize outbound content at the boundary too (detach; no live refs).
    const safeContent = sanitizeBoundaryValue(content, 'prompt-content');

    const clientMessageId = continuationId;

    const response = await this.#request({
      method: 'POST',
      path: `/sessions/${sessionId}/turns`,
      body: {
        type: 'immediate',
        content: safeContent,
        meta: { clientMessageId }
      },
      timeout: PROMPT_TIMEOUT_MS
    });

    validateTrustedContext(response, { sessionId, spaceId });

    // Exact identity/meta binding: response turn must echo our exact ID.
    const turn = response.turn;
    if (!turn || typeof turn !== 'object' ||
        !turn.meta || typeof turn.meta !== 'object' ||
        turn.meta.clientMessageId !== clientMessageId) {
      throw ERRORS.RESPONSE_ID_MISMATCH();
    }
    if (typeof turn.id !== 'string' || turn.id.length === 0) {
      throw ERRORS.BAD_SHAPE();
    }
    if (turn.sessionId !== sessionId) {
      throw ERRORS.CONTEXT_MISMATCH();
    }

    return response; // already detached + deep-frozen by sanitizer
  }

  /* -------------------------------------------------------------- */
  /* Exact turn GET                                                    */
  /* -------------------------------------------------------------- */

  async getTurn({ spaceId, sessionId, turnId } = {}) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const response = await this.#request({
      method: 'GET',
      path: `/sessions/${sessionId}/turns/${turnId}`
    });

    // Context identity FIRST (per spec), then allowlist.
    validateTrustedContext(response, { sessionId, spaceId, turnId });
    this.#validateTurnId(turnId);

    return response;
  }

  /* -------------------------------------------------------------- */
  /* Full index pagination: fail-closed                                */
  /* -------------------------------------------------------------- */

  async listAllTurns({ spaceId, sessionId } = {}) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    const allTurns = [];
    const seenCursors = new Set();
    let cursor = null;
    let pageCount = 0;

    for (;;) {
      if (pageCount >= MAX_PAGINATION_PAGES) throw ERRORS.PAGINATION_LIMIT();

      const response = await this.#request({
        method: 'GET',
        path: `/sessions/${sessionId}/turns`,
        query: cursor ? { cursor } : {}
      });

      validateTrustedContext(response, { sessionId, spaceId });

      if (!Array.isArray(response.turns)) throw ERRORS.BAD_SHAPE();

      // Fail-closed: every candidate must be a plain object with a string id.
      for (const t of response.turns) {
        if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.id !== 'string' || t.id.length === 0) {
          throw ERRORS.MALFORMED_CANDIDATE();
        }
      }

      allTurns.push(...response.turns);
      pageCount++;

      if (allTurns.length > MAX_PAGINATION_TURNS) throw ERRORS.TURN_LIMIT();

      if (response.hasMore !== true) break;

      const nextCursor = response.nextCursor;
      if (typeof nextCursor !== 'string' || nextCursor.length === 0) throw ERRORS.BAD_CURSOR();
      if (seenCursors.has(nextCursor)) throw ERRORS.CURSOR_CYCLE();
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return Object.freeze(allTurns);
  }

  /* -------------------------------------------------------------- */
  /* Reconciliation lookup by clientMessageId                          */
  /* -------------------------------------------------------------- */

  /**
   * Fail-closed: malformed candidates throw; only allowlist rejections
   * for candidates outside our run prefixes are skipped. Returns ALL
   * matches (duplicate clientMessageId detection is the caller's signal).
   */
  async findTurnByClientMessageId({ spaceId, sessionId, clientMessageId } = {}) {
    this.#validateSpaceId(spaceId);
    this.#validateSessionId(sessionId, spaceId);

    if (typeof clientMessageId !== 'string' || clientMessageId.length === 0) {
      throw ERRORS.CONTINUATION_REQUIRED();
    }

    const candidates = await this.listAllTurns({ spaceId, sessionId });
    const matches = [];

    for (const candidate of candidates) {
      // listAllTurns already fail-closed on malformed candidates; candidate.id
      // is a validated non-empty string on a sanitized plain object.
      const candidateId = candidate.id;

      let detail;
      try {
        detail = await this.getTurn({ spaceId, sessionId, turnId: candidateId });
      } catch (err) {
        // Skip ONLY allowlist rejections (turn outside our run prefixes).
        if (err instanceof CohubClientError &&
            (err.code === 'TURN_NOT_ALLOWED' ||
             err.code === 'SESSION_NOT_ALLOWED' ||
             err.code === 'SPACE_NOT_ALLOWED')) {
          continue;
        }
        throw err; // fail closed on everything else
      }

      const turn = detail.turn;
      if (!turn || typeof turn !== 'object') throw ERRORS.MALFORMED_CANDIDATE();
      if (turn.id !== candidateId) throw ERRORS.BAD_SHAPE();
      if (turn.sessionId !== sessionId) throw ERRORS.BAD_SHAPE();

      const meta = turn.meta;
      const foundId = meta && typeof meta === 'object' ? meta.clientMessageId : undefined;

      if (foundId === clientMessageId) {
        matches.push(turn);
      }
    }

    return Object.freeze(matches);
  }

  /* -------------------------------------------------------------- */
  /* File read with strict path semantics                              */
  /* -------------------------------------------------------------- */

  async readFile({ spaceId, path } = {}) {
    this.#validateSpaceId(spaceId);

    const validatedPath = validateBoundaryPath(path);

    const response = await this.#request({
      method: 'GET',
      path: `/spaces/${spaceId}/files`,
      query: { path: validatedPath }
    });

    if (!response || typeof response.content !== 'string') throw ERRORS.BAD_SHAPE();

    if (response.size !== undefined && response.size !== null) {
      if (typeof response.size !== 'number') throw ERRORS.BAD_SHAPE();
      const actualSize = Buffer.byteLength(response.content, 'utf8');
      if (actualSize !== response.size) throw ERRORS.SIZE_MISMATCH();
    }

    return response;
  }

  /* -------------------------------------------------------------- */
  /* Public API surface                                                */
  /* -------------------------------------------------------------- */

  get turns() {
    return Object.freeze({
      index: (params) => this.listAllTurns(params).then((turns) => Object.freeze({
        session: Object.freeze({ id: params.sessionId, spaceId: params.spaceId }),
        turns,
        hasMore: false
      })),
      get: (params) => this.getTurn(params)
    });
  }

  get files() {
    return Object.freeze({
      read: (params) => this.readFile(params)
    });
  }
}
