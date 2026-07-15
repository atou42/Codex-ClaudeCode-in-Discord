/**
 * Test helpers for launcher tests
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

/**
 * Real system init event from fixtures
 */
export const REAL_INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  session_id: 'test-session-uuid',
  tools: [
    'mcp__cohub_goal__cohub_goal_inspect',
    'mcp__cohub_goal__cohub_goal_submit',
    'mcp__cohub_goal__cohub_goal_wait',
    'mcp__cohub_goal__cohub_goal_verify'
  ],
  mcp_servers: [{ name: 'cohub_goal', status: 'connected' }],
  claude_code_version: '2.1.201',
  model: 'claude-sonnet-4-6',
  permissionMode: 'dontAsk'
};

/**
 * Make fake child process with controllable streams
 */
export function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = Math.floor(Math.random() * 90000) + 10000;

  child.kill = (signal) => {
    child.killed = true;
    return true;
  };

  child.emitExit = (code, signal) => {
    child.emit('exit', code, signal);
  };

  child.once('spawn', () => {}); // ensure spawn event is supported

  return child;
}

/**
 * Feed stream events to child stdout as newline-delimited JSON
 */
export function feedStream(child, events) {
  // Emit spawn immediately
  setImmediate(() => child.emit('spawn'));

  // Feed events
  for (const event of events) {
    const line = JSON.stringify(event) + '\n';
    child.stdout.emit('data', Buffer.from(line));
  }
}

/**
 * Make fake ports for testing
 */
export function makeFakePorts(options = {}) {
  const goalDir = options.goalDir || `/tmp/test-goal-${randomUUID()}`;
  const sessionIdHolder = { value: randomUUID() };

  // Fake state in memory
  const stateStore = { exists: false, data: null };
  const ledgerStore = [];
  const leaseStore = { acquired: false, metadata: null };

  let spawnRecorder = null;

  const ports = {
    goalDir,
    sessionIdHolder,

    state: {
      async write(state) {
        stateStore.exists = true;
        stateStore.data = JSON.parse(JSON.stringify(state));
      },
      async read() {
        if (!stateStore.exists) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return JSON.parse(JSON.stringify(stateStore.data));
      },
      async exists() {
        return stateStore.exists;
      }
    },

    ledger: {
      async init() {},
      async append(entry) {
        const record = {
          seq: ledgerStore.length + 1,
          timestamp: new Date().toISOString(),
          ...entry,
          entryHash: randomUUID()
        };
        ledgerStore.push(record);
        return Object.freeze(record);
      },
      async read() {
        return [...ledgerStore];
      },
      async getLatest() {
        return ledgerStore.length > 0 ? ledgerStore[ledgerStore.length - 1] : null;
      }
    },

    lease: {
      async acquire(goalInstance, metadata) {
        if (leaseStore.acquired && !options.allowConcurrent) {
          const err = new Error('Lease conflict');
          err.code = 'LEASE_CONFLICT';
          throw err;
        }
        leaseStore.acquired = true;
        leaseStore.metadata = metadata;
      },
      async release() {
        leaseStore.acquired = false;
      }
    },

    spawn(command, args, opts) {
      if (spawnRecorder) {
        spawnRecorder(command, args, opts);
      }

      const child = makeChild();

      // Call driver if provided
      const driver = options.driveChild || opts.driveChild;
      if (driver) {
        setImmediate(() => driver(child));
      } else {
        // Default: emit spawn and exit immediately
        setImmediate(() => {
          child.emit('spawn');
          child.emitExit(0, null);
        });
      }

      return child;
    },

    streamParser: options.streamParser || null,
    verifier: options.verifier || null,
    renderer: options.renderer || {
      render(goalInstance) {
        return `Monitor goalInstance=${goalInstance}. Use cohub_goal inspect/submit/wait/verify tools only.`;
      }
    },

    clock: options.clock || Date,

    recordSpawn(fn) {
      spawnRecorder = fn;
    },

    getState() {
      return {
        stateStore,
        ledgerStore,
        leaseStore
      };
    }
  };

  // Build constructor options
  ports.options = {
    goalDir,
    state: ports.state,
    ledger: ports.ledger,
    lease: ports.lease,
    spawn: ports.spawn.bind(ports),
    streamParser: ports.streamParser,
    verifier: ports.verifier,
    renderer: ports.renderer,
    clock: ports.clock
  };

  return ports;
}
