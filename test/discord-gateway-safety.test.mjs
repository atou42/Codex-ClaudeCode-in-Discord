import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { createGatewayBudget, createGatewayStrategy, GuardedWebSocketShard } from '../src/discord-gateway-safety.js';

const require = createRequire(import.meta.url);
const { WebSocketShard, WebSocketManager, DefaultWebSocketManagerOptions } = require('@discordjs/ws');
const { WebSocketServer } = require('ws');
const quiet = { log() {}, warn() {}, error() {} };

function budgetFixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-gateway-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, token: 'OFFLINE_TEST_ONLY', ...options };
  return { config, budget: createGatewayBudget(config) };
}

async function localGateway(t, budget, Shard = GuardedWebSocketShard) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  const sockets = [];
  const auth = [];
  const errors = [];
  server.on('connection', socket => {
    sockets.push(socket);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    socket.on('message', bytes => {
      const payload = JSON.parse(String(bytes));
      if (payload.op === 2 || payload.op === 6) {
        auth.push(payload.op);
        socket.send(JSON.stringify({ op: 0, t: payload.op === 2 ? 'READY' : 'RESUMED', s: 1,
          d: { session_id: 'offline-session', resume_gateway_url: url } }));
      }
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  let session = null;
  const shard = new Shard({
    options: { ...DefaultWebSocketManagerOptions, gatewayInformation: { url },
      token: 'OFFLINE_TEST_ONLY', intents: 0, shardCount: 1, helloTimeout: 1000, readyTimeout: 1000 },
    retrieveSessionInfo: async () => session,
    updateSessionInfo: async (_, value) => { session = value; },
    waitForIdentify: async () => {},
  }, 0, budget, quiet);
  shard.on('error', event => errors.push(event.error));
  t.after(async () => {
    // Also stop the unguarded control case's known reconnect leak.
    shard.internalConnect = async () => {};
    if (shard.stop) await shard.stop();
    else await shard.destroy();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return { shard, sockets, auth, errors, url };
}

test('guarded shards use the same proxy-patched CommonJS gateway as discord.js', () => {
  assert.equal(Object.getPrototypeOf(GuardedWebSocketShard.prototype), WebSocketShard.prototype);
});

test('IDENTIFY budget survives new clients and rejects attempt 11 before writing', t => {
  const { config, budget } = budgetFixture(t);
  for (let i = 0; i < 10; i++) budget.reserve('identify');
  const before = fs.readFileSync(budget.file, 'utf8');
  assert.throws(() => createGatewayBudget(config).reserve('identify'), { code: 'DISCORD_GATEWAY_BLOCKED' });
  assert.equal(fs.readFileSync(budget.file, 'utf8'), before);
});

test('daily budget survives short-window expiry and remains paused until manual restart', t => {
  let time = 1_800_000_000_000;
  const { config, budget } = budgetFixture(t, { now: () => time });
  for (let window = 0; window < 10; window++) {
    for (let i = 0; i < 10; i++) budget.reserve('identify');
    time += 15 * 60_000;
  }
  assert.throws(() => budget.reserve('identify'), /budget exhausted/);
  time += 24 * 60 * 60_000;
  assert.throws(() => budget.reserve('identify'), /budget exhausted/);
  assert.equal(createGatewayBudget(config).reserve('identify').daily, 1);
});

test('handshake attempts have a separate persistent limit', t => {
  const { config, budget } = budgetFixture(t);
  for (let i = 0; i < 30; i++) budget.reserve('connect');
  assert.throws(() => createGatewayBudget(config).reserve('connect'), /budget exhausted/);
});

for (const contents of ['{', '{}', '{"version":1,"records":[null]}', '{"version":1,"records":[{"kind":"identify","at":999999999999999}]}']) {
  test(`damaged or future budget is preserved and blocks login: ${contents}`, t => {
    const { budget } = budgetFixture(t);
    fs.mkdirSync(path.dirname(budget.file), { recursive: true });
    fs.writeFileSync(budget.file, contents);
    assert.throws(() => budget.reserve('identify'), { code: 'DISCORD_GATEWAY_BLOCKED' });
    assert.equal(fs.readFileSync(budget.file, 'utf8'), contents);
  });
}

test('an existing lock is not removed or bypassed', t => {
  const { budget } = budgetFixture(t);
  fs.mkdirSync(path.dirname(budget.file), { recursive: true });
  fs.writeFileSync(`${budget.file}.lock`, 'another writer');
  assert.throws(() => budget.reserve('identify'), { code: 'DISCORD_GATEWAY_BLOCKED' });
  assert.equal(fs.readFileSync(`${budget.file}.lock`, 'utf8'), 'another writer');
});

test('disk-full persistence failure preserves old budget and fails closed', t => {
  const io = { ...fs };
  const { budget } = budgetFixture(t, { fsImpl: io });
  budget.reserve('identify');
  const before = fs.readFileSync(budget.file, 'utf8');
  io.writeFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  assert.throws(() => budget.reserve('identify'), { code: 'DISCORD_GATEWAY_BLOCKED' });
  assert.equal(fs.readFileSync(budget.file, 'utf8'), before);
  io.writeFileSync = fs.writeFileSync;
  assert.throws(() => budget.reserve('identify'), { code: 'DISCORD_GATEWAY_BLOCKED' });
});

for (const Shard of [WebSocketShard, GuardedWebSocketShard]) {
  test(`${Shard.name}: disposal during reconnect delay ${Shard === WebSocketShard ? 'reproduces upstream leak' : 'prevents retired IDENTIFY'}`, { timeout: 5000 }, async t => {
    const { budget } = budgetFixture(t);
    const { shard, sockets, auth } = await localGateway(t, budget, Shard);
    await shard.connect();
    const closed = once(shard, 'closed');
    sockets[0].close(1000);
    await closed;
    await sleep(20);
    if (shard.stop) await shard.stop();
    else await shard.destroy();
    await sleep(750);
    assert.equal(sockets.length, Shard === WebSocketShard ? 2 : 1);
    assert.equal(auth.length, Shard === WebSocketShard ? 2 : 1);
  });
}

test('ordinary network disconnect resumes without consuming another IDENTIFY', { timeout: 5000 }, async t => {
  const { budget } = budgetFixture(t);
  const { shard, sockets, auth, errors } = await localGateway(t, budget);
  await shard.connect();
  const resumed = once(shard, 'resumed');
  sockets[0].terminate();
  await resumed;
  assert.deepEqual(auth, [2, 6]);
  assert.deepEqual(errors, []);
  const records = JSON.parse(fs.readFileSync(budget.file, 'utf8')).records;
  assert.equal(records.filter(record => record.kind === 'identify').length, 1);
});

test('automatic reconnect cannot bypass IDENTIFY budget', { timeout: 5000 }, async t => {
  const { budget } = budgetFixture(t);
  for (let i = 0; i < 9; i++) budget.reserve('identify');
  const { shard, sockets, auth, errors } = await localGateway(t, budget);
  await shard.connect();
  const failed = once(shard, 'error');
  sockets[0].close(1000);
  await failed;
  await sleep(650);
  assert.deepEqual(auth, [2]);
  assert.equal(sockets.length, 2);
  assert.equal(errors[0].code, 'DISCORD_GATEWAY_BLOCKED');
  assert.equal(shard.retired, true);
});

test('exhausted startup budget rejects login without sending credentials', { timeout: 5000 }, async t => {
  const { budget } = budgetFixture(t);
  for (let i = 0; i < 10; i++) budget.reserve('identify');
  const { shard, auth } = await localGateway(t, budget);
  await assert.rejects(shard.connect(), { code: 'DISCORD_GATEWAY_BLOCKED' });
  assert.deepEqual(auth, []);
});

test('production manager strategy disposes every shard before returning', { timeout: 5000 }, async t => {
  const { budget } = budgetFixture(t);
  const { url, sockets, auth } = await localGateway(t, budget);
  let session = null;
  const manager = new WebSocketManager({
    token: 'OFFLINE_TEST_ONLY', intents: 0, shardCount: 1, shardIds: [0],
    buildStrategy: createGatewayStrategy(budget, quiet),
    retrieveSessionInfo: () => session,
    updateSessionInfo: (_, value) => { session = value; },
    rest: { get: async route => {
      assert.equal(route, '/gateway/bot');
      return { url, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 86400000, max_concurrency: 1 } };
    } },
  });
  t.after(() => manager.destroy());
  await manager.connect();
  const shard = manager.strategy.shards.get(0);
  assert.ok(shard instanceof GuardedWebSocketShard);
  const closed = once(manager, 'closed');
  sockets[0].close(1000);
  await closed;
  await sleep(20);
  await manager.destroy();
  await sleep(700);
  assert.deepEqual(auth, [2]);
  assert.equal(sockets.length, 1);
  assert.equal(manager.strategy.shards.size, 0);
});
