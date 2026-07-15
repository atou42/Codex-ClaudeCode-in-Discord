import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeCohubServer, createFakeCohubPort } from './fake-cohub-port.mjs';

test('fake server state survives port disconnect/reconnect', async () => {
  const server = createFakeCohubServer();
  const turn = server.createTurn('space-1', 'session-1', { status: 'running' });

  const { port, control } = createFakeCohubPort(server);
  port.onEvent(() => {});
  await port.connect();
  await port.subscribe(['space-1']);
  await port.waitForSubscribeAck('space-1');

  control.disconnect();
  // server state must be untouched by connection lifecycle
  const readBack = await (async () => {
    const { port: port2 } = createFakeCohubPort(server);
    port2.onEvent(() => {});
    await port2.connect();
    return server.getTurn('space-1', 'session-1', turn.id);
  })();
  assert.equal(readBack.status, 'running');
});

test('live event only delivered to connections that acked that space', async () => {
  const server = createFakeCohubServer();
  const turn = server.createTurn('space-1', 'session-1', { status: 'running' });

  const { port, control } = createFakeCohubPort(server);
  const received = [];
  port.onEvent((e) => received.push(e));
  await port.connect();
  await port.subscribe(['space-1']);
  // no ack yet -> should not receive
  server.finalizeTurn('space-1', 'session-1', turn.id, 'completed');
  assert.equal(received.length, 0);

  await port.waitForSubscribeAck('space-1');
  const turn2 = server.createTurn('space-1', 'session-1', { status: 'running' });
  server.finalizeTurn('space-1', 'session-1', turn2.id, 'completed');
  assert.equal(received.length, 1);
  assert.equal(received[0].turnId, turn2.id);
  assert.equal(control.metrics.liveEventDeliveredCount, 1);
});

test('connect before onEvent throws', async () => {
  const server = createFakeCohubServer();
  const { port } = createFakeCohubPort(server);
  await assert.rejects(() => port.connect(), /before a listener was installed/);
});

test('merged turn relation resolves to true terminal', async () => {
  const server = createFakeCohubServer();
  const original = server.createTurn('space-1', 'session-1', { status: 'running' });
  const replacement = server.createTurn('space-1', 'session-1', { status: 'running' });
  server.finalizeTurn('space-1', 'session-1', replacement.id, 'completed', { artifacts: { hash: 'abc' } });
  server.mergeTurn('space-1', 'session-1', original.id, replacement.id);

  const merged = server.getTurn('space-1', 'session-1', original.id);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.mergedIntoTurnId, replacement.id);
  const target = server.getTurn('space-1', 'session-1', merged.mergedIntoTurnId);
  assert.equal(target.status, 'completed');
});

test('sendPrompt is idempotent by clientMessageId', async () => {
  const server = createFakeCohubServer();
  server.ensureSession('space-1', 'session-1');
  const { port } = createFakeCohubPort(server);
  port.onEvent(() => {});
  await port.connect();

  const first = await port.sendPrompt({ spaceId: 'space-1', sessionId: 'session-1', clientMessageId: 'cid-1', payload: {} });
  const second = await port.sendPrompt({ spaceId: 'space-1', sessionId: 'session-1', clientMessageId: 'cid-1', payload: {} });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.turn.id, second.turn.id);
});
