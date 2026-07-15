// In-memory Cohub server + CohubPort test double.
//
// Server state (Spaces/Sessions/Turns/files/clientMessageId index/merged
// relations) lives independently of any single port connection's lifecycle,
// so disconnect/reconnect never loses authoritative state -- only live
// event delivery is connection-scoped, exactly like real Cohub: WebSocket
// is a wake signal, HTTP/file reads are the fact source.
//
// Event delivery is synchronous (no real timers, no queued microtask
// ambiguity) so adversarial race tests can inject an event at an exact,
// named point in the subscription control flow and get a deterministic
// result.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { assertCohubPort } from '../../src/cohub-claude-goal/cohub-port.js';

function deterministicUUID(prefix, seq) {
  const base = `${prefix}-${seq}`.padEnd(36, '0');
  return `${base.slice(0, 8)}-${base.slice(8, 12)}-${base.slice(12, 16)}-${base.slice(16, 20)}-${base.slice(20, 32)}`;
}

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export const TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'merged',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function cloneTurn(turn) {
  return { ...turn, artifacts: turn.artifacts ? { ...turn.artifacts } : null };
}

export function createFakeCohubServer() {
  const spaces = new Map();
  const eventLog = [];
  const connections = new Set();
  let eventSeq = 0;
  let turnSeq = 0;

  function ensureSpace(spaceId) {
    let space = spaces.get(spaceId);
    if (!space) {
      space = { sessions: new Map(), files: new Map() };
      spaces.set(spaceId, space);
    }
    return space;
  }

  function ensureSession(spaceId, sessionId) {
    const space = ensureSpace(spaceId);
    let session = space.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, spaceId, turns: new Map(), order: [], sequence: 0, clientMessageIndex: new Map() };
      space.sessions.set(sessionId, session);
    }
    return session;
  }

  function requireSession(spaceId, sessionId) {
    const space = spaces.get(spaceId);
    const session = space?.sessions.get(sessionId);
    if (!session) {
      const err = new Error(`unknown session ${spaceId}/${sessionId}`);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }
    return session;
  }

  function deliverLive(event) {
    for (const conn of connections) {
      if (conn.connected && conn.ackedSpaces.has(event.spaceId)) {
        for (const handler of conn.handlers) {
          handler({ kind: 'turn', ...event });
        }
      }
    }
  }

  function createTurn(spaceId, sessionId, { status = 'running', clientMessageId = null, artifacts = null } = {}) {
    const session = ensureSession(spaceId, sessionId);
    turnSeq += 1;
    const turn = {
      id: deterministicUUID('turn', turnSeq),
      sessionId,
      spaceId,
      seq: turnSeq,
      status,
      clientMessageId,
      mergedIntoTurnId: null,
      continuedByTurnId: null,
      artifacts,
    };
    session.turns.set(turn.id, turn);
    session.order.push(turn.id);
    session.sequence += 1;
    if (clientMessageId) {
      session.clientMessageIndex.set(clientMessageId, turn.id);
    }
    return cloneTurn(turn);
  }

  function finalizeTurn(spaceId, sessionId, turnId, status, { artifacts, eventId } = {}) {
    assert.ok(TERMINAL_STATUSES.includes(status), `unknown terminal status ${status}`);
    const session = requireSession(spaceId, sessionId);
    const turn = session.turns.get(turnId);
    if (!turn) {
      const err = new Error(`unknown turn ${spaceId}/${sessionId}/${turnId}`);
      err.code = 'TURN_NOT_FOUND';
      throw err;
    }
    turn.status = status;
    if (artifacts) turn.artifacts = artifacts;
    session.sequence += 1;
    eventSeq += 1;
    const event = {
      id: eventId && isValidUUID(eventId) ? eventId : deterministicUUID('evt', eventSeq),
      spaceId,
      sessionId,
      turnId,
      terminalStatus: status,
    };
    eventLog.push(event);
    deliverLive(event);
    return cloneTurn(turn);
  }

  function mergeTurn(spaceId, sessionId, turnId, intoTurnId, { eventId } = {}) {
    const session = requireSession(spaceId, sessionId);
    const turn = session.turns.get(turnId);
    if (!turn) {
      const err = new Error(`unknown turn ${spaceId}/${sessionId}/${turnId}`);
      err.code = 'TURN_NOT_FOUND';
      throw err;
    }
    turn.status = 'merged';
    turn.mergedIntoTurnId = intoTurnId;
    const target = session.turns.get(intoTurnId);
    if (target) target.continuedByTurnId = turnId;
    session.sequence += 1;
    eventSeq += 1;
    const event = {
      id: eventId && isValidUUID(eventId) ? eventId : deterministicUUID('evt', eventSeq),
      spaceId,
      sessionId,
      turnId,
      terminalStatus: 'merged',
    };
    eventLog.push(event);
    deliverLive(event);
    return cloneTurn(turn);
  }

  function replayEvent(spaceId, sessionId, turnId, terminalStatus, eventId) {
    eventSeq += 1;
    const event = {
      id: eventId && isValidUUID(eventId) ? eventId : deterministicUUID('evt', eventSeq),
      spaceId,
      sessionId,
      turnId,
      terminalStatus,
    };
    eventLog.push(event);
    deliverLive(event);
    return event;
  }

  function setFile(spaceId, filePath, content) {
    const space = ensureSpace(spaceId);
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    space.files.set(filePath, { content: serialized, hash: sha256(serialized) });
  }

  function getFile(spaceId, filePath) {
    const space = spaces.get(spaceId);
    const entry = space?.files.get(filePath);
    if (!entry) {
      const err = new Error(`unknown file ${spaceId}:${filePath}`);
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }
    return { ...entry };
  }

  function getSessionIndex(spaceId, sessionId) {
    const session = requireSession(spaceId, sessionId);
    return { sessionId, sequence: session.sequence, turnIds: [...session.order] };
  }

  function getTurn(spaceId, sessionId, turnId) {
    const session = requireSession(spaceId, sessionId);
    const turn = session.turns.get(turnId);
    if (!turn) {
      const err = new Error(`unknown turn ${spaceId}/${sessionId}/${turnId}`);
      err.code = 'TURN_NOT_FOUND';
      throw err;
    }
    return cloneTurn(turn);
  }

  function findByClientMessageId(spaceId, sessionId, clientMessageId) {
    const session = requireSession(spaceId, sessionId);
    const turnId = session.clientMessageIndex.get(clientMessageId);
    if (!turnId) return null;
    return cloneTurn(session.turns.get(turnId));
  }

  function promptIdempotent(spaceId, sessionId, clientMessageId, payload = {}) {
    const existing = findByClientMessageId(spaceId, sessionId, clientMessageId);
    if (existing) return { turn: existing, created: false };
    const turn = createTurn(spaceId, sessionId, { status: 'running', clientMessageId, artifacts: payload.artifacts ?? null });
    return { turn, created: true };
  }

  return {
    sha256,
    ensureSpace,
    ensureSession,
    createTurn,
    finalizeTurn,
    mergeTurn,
    replayEvent,
    setFile,
    getFile,
    getSessionIndex,
    getTurn,
    findByClientMessageId,
    promptIdempotent,
    eventLog,
    _registerConnection: (conn) => connections.add(conn),
    _unregisterConnection: (conn) => connections.delete(conn),
  };
}

/**
 * Attach one CohubPort connection to a shared fake server. Returns
 * { port, control }. `port` is what production code (subscription.js,
 * reconcile.js) is handed. `control` is test-only: injection, failure
 * simulation, disconnect/reconnect, metrics, trace.
 */
export function createFakeCohubPort(server, { id = `conn-${Math.random().toString(36).slice(2)}` } = {}) {
  const trace = [];
  const metrics = {
    connectCount: 0,
    subscribeRequestCount: 0,
    subscribeAckCount: 0,
    businessReadCount: 0,
    promptSendCount: 0,
    disconnectCount: 0,
    reconnectCount: 0,
    liveEventDeliveredCount: 0,
    closeCallCount: 0,
  };

  const conn = {
    id,
    connected: false,
    handlers: [],
    listenerInstalled: false,
    subscribedSpaces: new Set(),
    ackedSpaces: new Set(),
  };
  server._registerConnection(conn);

  let failNextConnect = 0;
  let failNextHttp = 0;
  let httpFailureError = null;
  let failNextAck = 0;
  let ackFailureError = null;
  let closed = false;

  // "Pause the next call to this method" seam: the registered callback runs
  // synchronously at the moment the call would normally do its work (i.e.
  // while it is nominally "in flight" from the caller's point of view), so a
  // test can fire a live event exactly inside a named critical window before
  // the call resolves.
  const pauseQueues = new Map();

  async function maybePause(methodName) {
    const queue = pauseQueues.get(methodName);
    if (!queue || queue.length === 0) return;
    const callback = queue.shift();
    record('paused', { method: methodName });
    await callback();
  }

  function record(event, extra) {
    trace.push({ event, at: trace.length, ...(extra ?? {}) });
  }

  const impl = {
    onEvent(handler) {
      conn.listenerInstalled = true;
      const wrapped = (event) => {
        if (event.kind === 'turn') {
          metrics.liveEventDeliveredCount += 1;
          record('event-delivered', { eventId: event.id, turnId: event.turnId, terminalStatus: event.terminalStatus });
        } else {
          record(`connection-${event.kind}`);
        }
        handler(event);
      };
      conn.handlers.push(wrapped);
      record('listener-installed');
      return () => {
        const idx = conn.handlers.indexOf(wrapped);
        if (idx >= 0) conn.handlers.splice(idx, 1);
      };
    },

    async connect() {
      if (!conn.listenerInstalled) {
        throw new Error('CohubPort.connect called before a listener was installed via onEvent');
      }
      await maybePause('connect');
      if (failNextConnect > 0) {
        failNextConnect -= 1;
        record('connect-failed');
        throw Object.assign(new Error('simulated connect failure'), { code: 'CONNECT_FAILED' });
      }
      conn.connected = true;
      metrics.connectCount += 1;
      record('connected');
    },

    async subscribe(spaceIds) {
      await maybePause('subscribe');
      metrics.subscribeRequestCount += 1;
      for (const spaceId of spaceIds) {
        conn.subscribedSpaces.add(spaceId);
      }
      record('subscribe-requested', { spaceIds: [...spaceIds] });
    },

    async waitForSubscribeAck(spaceId) {
      if (!conn.subscribedSpaces.has(spaceId)) {
        throw new Error(`waitForSubscribeAck called for unsubscribed space ${spaceId}`);
      }
      await maybePause('waitForSubscribeAck');
      if (failNextAck > 0) {
        failNextAck -= 1;
        record('ack-failed', { spaceId });
        throw ackFailureError ?? Object.assign(new Error('simulated subscribe ack failure'), { code: 'ACK_FAILED' });
      }
      conn.ackedSpaces.add(spaceId);
      metrics.subscribeAckCount += 1;
      record('subscribe-ack', { spaceId });
    },

    async getSessionIndex(spaceId, sessionId) {
      await maybePause('getSessionIndex');
      metrics.businessReadCount += 1;
      if (failNextHttp > 0) {
        failNextHttp -= 1;
        record('http-failed', { op: 'getSessionIndex' });
        throw httpFailureError ?? Object.assign(new Error('simulated http failure'), { code: 'HTTP_FAILURE' });
      }
      record('getSessionIndex', { spaceId, sessionId });
      return server.getSessionIndex(spaceId, sessionId);
    },

    async getTurn(spaceId, sessionId, turnId) {
      metrics.businessReadCount += 1;
      if (failNextHttp > 0) {
        failNextHttp -= 1;
        record('http-failed', { op: 'getTurn' });
        throw httpFailureError ?? Object.assign(new Error('simulated http failure'), { code: 'HTTP_FAILURE' });
      }
      record('getTurn', { spaceId, sessionId, turnId });
      return server.getTurn(spaceId, sessionId, turnId);
    },

    async readRunFile(spaceId, filePath) {
      metrics.businessReadCount += 1;
      if (failNextHttp > 0) {
        failNextHttp -= 1;
        record('http-failed', { op: 'readRunFile' });
        throw httpFailureError ?? Object.assign(new Error('simulated http failure'), { code: 'HTTP_FAILURE' });
      }
      record('readRunFile', { spaceId, filePath });
      return server.getFile(spaceId, filePath);
    },

    async sendPrompt({ spaceId, sessionId, clientMessageId, payload }) {
      metrics.promptSendCount += 1;
      record('prompt-sent', { spaceId, sessionId, clientMessageId });
      const { turn, created } = server.promptIdempotent(spaceId, sessionId, clientMessageId, payload ?? {});
      return { turn, created };
    },

    async findTurnByClientMessageId(spaceId, sessionId, clientMessageId) {
      metrics.businessReadCount += 1;
      record('findTurnByClientMessageId', { spaceId, sessionId, clientMessageId });
      return server.findByClientMessageId(spaceId, sessionId, clientMessageId);
    },

    async getTrustedExecutionContext() {
      record('getTrustedExecutionContext');
      return { turnId: conn.trustedTurnId ?? null };
    },

    async close() {
      if (closed) return;
      closed = true;
      metrics.closeCallCount += 1;
      conn.connected = false;
      conn.handlers = [];
      server._unregisterConnection(conn);
      record('closed');
    },
  };

  const port = assertCohubPort(impl);

  const control = {
    trace,
    metrics,
    disconnect() {
      conn.connected = false;
      conn.subscribedSpaces.clear();
      conn.ackedSpaces.clear();
      metrics.disconnectCount += 1;
      record('disconnected');
      for (const handler of [...conn.handlers]) handler({ kind: 'disconnected' });
    },
    reconnect() {
      conn.connected = true;
      metrics.reconnectCount += 1;
      record('reconnected');
      for (const handler of [...conn.handlers]) handler({ kind: 'reconnected' });
    },
    emitEvent(spaceId, sessionId, turnId, terminalStatus, { eventId } = {}) {
      return server.replayEvent(spaceId, sessionId, turnId, terminalStatus, eventId);
    },
    failNextConnect(times = 1) {
      failNextConnect += times;
    },
    failNextHttp(times = 1, error = null) {
      failNextHttp += times;
      httpFailureError = error;
    },
    failNextAck(times = 1, error = null) {
      failNextAck += times;
      ackFailureError = error;
    },
    // Deliver an arbitrary raw payload directly to every acked handler,
    // bypassing the server's well-formed event construction entirely. Used
    // to simulate a structurally malformed/corrupt event on the wire so
    // subscription.js's fail-closed validation can be exercised.
    emitRaw(rawEvent) {
      for (const handler of [...conn.handlers]) handler(rawEvent);
    },
    pauseNextCall(methodName, callback) {
      if (!pauseQueues.has(methodName)) pauseQueues.set(methodName, []);
      pauseQueues.get(methodName).push(callback);
    },
    setTrustedTurnId(turnId) {
      conn.trustedTurnId = turnId;
    },
    isSubscribedAndAcked(spaceId) {
      return conn.ackedSpaces.has(spaceId);
    },
  };

  return { port, control };
}
