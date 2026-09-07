import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Match discord.js and the runtime proxy patch, which both use the CommonJS build.
const require = createRequire(import.meta.url);
const {
  SimpleContextFetchingStrategy,
  SimpleShardingStrategy,
  WebSocketShard,
  WebSocketShardEvents,
  managerToFetchingStrategyOptions,
} = require('@discordjs/ws');

const DAY_MS = 24 * 60 * 60_000;
const WINDOW_MS = 15 * 60_000;

function blocked(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: 'DISCORD_GATEWAY_BLOCKED' });
}

// Shared by all clients using this token, including across process restarts.
export function createGatewayBudget({ dataDir, token, now = Date.now, fsImpl = fs } = {}) {
  const key = createHash('sha256').update(token).digest('hex');
  const directory = path.join(dataDir, 'discord-gateway');
  const file = path.join(directory, `${key}.json`);
  let failure = null;

  function reserve(kind) {
    if (failure) throw failure;
    try {
      if (!['connect', 'identify'].includes(kind)) throw new Error('Invalid gateway budget operation');
      return persistReservation(kind);
    } catch (err) {
      failure = blocked(`Discord gateway paused: ${err.message}`, err);
      throw failure;
    }
  }

  function persistReservation(kind) {
    let lock;
    try {
      fsImpl.mkdirSync(directory, { recursive: true });
      // Never remove someone else's lock, even if it looks stale. Fail closed.
      lock = fsImpl.openSync(`${file}.lock`, 'wx', 0o600);
      let records = [];
      try {
        const state = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        if (state?.version !== 1 || !Array.isArray(state.records)
          || state.records.some(record => !['connect', 'identify'].includes(record?.kind)
            || !Number.isSafeInteger(record.at) || record.at < 0)) {
          throw new Error('Invalid gateway budget data');
        }
        records = state.records;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid gateway budget clock');
      if (records.some(record => record.at > at)) throw new Error('Clock moved backwards; gateway budget cannot be verified');
      records = records.filter(record => record.at > at - DAY_MS);
      const matching = records.filter(record => record.kind === kind);
      const recent = matching.filter(record => record.at > at - WINDOW_MS).length;
      const limit = kind === 'identify' ? 10 : 30;
      if (recent >= limit || (kind === 'identify' && matching.length >= 100)) {
        throw new Error(`Gateway ${kind} budget exhausted (${recent}/15min, ${matching.length}/24h); fix the connection and restart after the budget window expires`);
      }
      records.push({ kind, at });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const fd = fsImpl.openSync(temporary, 'wx', 0o600);
      try {
        fsImpl.writeFileSync(fd, `${JSON.stringify({ version: 1, records })}\n`);
        fsImpl.fsyncSync(fd);
      } finally {
        fsImpl.closeSync(fd);
      }
      fsImpl.renameSync(temporary, file);
      return { at, recent: recent + 1, daily: matching.length + 1 };
    } finally {
      if (lock !== undefined) {
        fsImpl.closeSync(lock);
        fsImpl.unlinkSync(`${file}.lock`);
      }
    }
  }

  return { reserve, file };
}

// @discordjs/ws 1.2.3 does not cancel its pending 500ms reconnect on destroy.
// Guard the shard itself so automatic recovery cannot bypass disposal or budgets.
export class GuardedWebSocketShard extends WebSocketShard {
  retired = false;
  pendingConnections = new Set();
  disposal = null;

  constructor(strategy, id, budget, logger = console) {
    super(strategy, id);
    this.budget = budget;
    this.logger = logger;
  }

  async internalConnect() {
    if (this.retired) return;
    const task = this.connectGuarded();
    this.pendingConnections.add(task);
    try {
      await task;
    } finally {
      this.pendingConnections.delete(task);
    }
  }

  async connectGuarded() {
    try {
      const attempt = this.budget.reserve('connect');
      this.logger.log(`[${new Date(attempt.at).toISOString()}] Discord gateway connect shard=${this.id} attempts15m=${attempt.recent}`);
      await super.internalConnect();
    } catch (error) {
      if (!this.retired) {
        await this.destroy();
        this.emit(WebSocketShardEvents.Error, { error });
      }
    } finally {
      // Also close a socket created by an already-in-flight internalConnect.
      if (this.retired) await super.destroy();
    }
  }

  async send(payload) {
    if (this.retired) return;
    if (payload.op === 2) {
      const attempt = this.budget.reserve('identify');
      this.logger.log(`[${new Date(attempt.at).toISOString()}] Discord gateway IDENTIFY shard=${this.id} attempts15m=${attempt.recent} attempts24h=${attempt.daily}`);
    }
    return super.send(payload);
  }

  async onMessage(...args) {
    if (!this.retired) return super.onMessage(...args);
  }

  async onClose(code) {
    if (this.retired) return;
    this.logger.warn(`[${new Date().toISOString()}] Discord gateway close shard=${this.id} code=${code}`);
    return super.onClose(code);
  }

  async heartbeat(...args) {
    if (this.retired) {
      clearInterval(this.heartbeatInterval);
      return;
    }
    return super.heartbeat(...args);
  }

  async destroy(options = {}) {
    if (options.recover !== undefined && !this.retired) return super.destroy(options);
    this.retired = true;
    if (!this.disposal) {
      const connection = this.connection;
      this.disposal = super.destroy({ ...options, recover: undefined });
      // The upstream implementation only closes OPEN sockets, not CONNECTING ones.
      if (connection?.readyState === 0) {
        connection.on('error', () => {});
        connection.terminate();
      }
    }
    return this.disposal;
  }

  async stop() {
    await this.destroy();
    await Promise.all(this.pendingConnections);
    await super.destroy();
  }
}

class GuardedShardingStrategy extends SimpleShardingStrategy {
  constructor(manager, budget, logger) {
    super(manager);
    this.budget = budget;
    this.logger = logger;
  }

  async spawn(shardIds) {
    const options = await managerToFetchingStrategyOptions(this.manager);
    for (const id of shardIds) {
      const context = new SimpleContextFetchingStrategy(this.manager, options);
      const shard = new GuardedWebSocketShard(context, id, this.budget, this.logger);
      for (const event of Object.values(WebSocketShardEvents)) {
        shard.on(event, payload => this.manager.emit(event, { ...payload, shardId: id }));
      }
      this.shards.set(id, shard);
    }
  }

  async destroy() {
    await Promise.all([...this.shards.values()].map(shard => shard.stop()));
    this.shards.clear();
  }
}

export function createGatewayStrategy(budget, logger = console) {
  return manager => new GuardedShardingStrategy(manager, budget, logger);
}
