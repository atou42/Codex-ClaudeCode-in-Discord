import assert from 'node:assert/strict';
import test from 'node:test';

import { createChannelQueue } from '../src/channel-queue.js';
import { safeReply } from '../src/discord-reply-utils.js';

function fixture({ steeringError = null, rejected = false, deliveryFails = true } = {}) {
  const state = { running: true, queue: [], activeRun: { messageId: 'active' } };
  const warnings = [];
  let executions = 0;
  let steerCalls = 0;
  let deliveries = 0;
  const message = {
    id: 'follow-up',
    author: { id: 'requester' },
    channel: { id: 'channel' },
    reply: async () => {
      deliveries += 1;
      if (deliveryFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    },
  };
  const queue = createChannelQueue({
    getChannelState: () => state,
    getSession: () => ({ provider: 'codex', runtimeMode: 'long' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    resolveBusyPromptModeSetting: () => ({ mode: 'steer_if_possible', canSteer: true }),
    safeReply,
    safeError: (error) => error.message,
    logger: { warn: (text) => warnings.push(text) },
    steerPrompt: async () => {
      steerCalls += 1;
      if (steeringError) throw steeringError;
      return rejected ? { steered: false, reason: 'turn ended' } : { steered: true };
    },
    handlePrompt: async () => { executions += 1; return { ok: true }; },
  });
  return { queue, state, message, warnings, counts: () => ({ executions, steerCalls, deliveries }) };
}

test('accepted steering is not queued again when the real reply helper rejects delivery', async () => {
  const f = fixture();
  const result = await f.queue.enqueuePrompt(f.message, 'channel', 'adjust the task').catch((error) => ({ error }));
  assert.equal(f.state.queue.length, 0, 'accepted work must not be queued for a second execution');
  assert.equal(result.ok, true);
  assert.equal(result.steered, true);
  assert.equal(result.enqueued, false);
  assert.equal(result.notificationError, 'Missing Permissions');
  assert.equal(f.state.queue.length, 0);
  assert.deepEqual(f.counts(), { executions: 0, steerCalls: 1, deliveries: 1 });
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /steer accepted.*notification failed/i);
});

test('concurrent accepted follow-ups with failed acknowledgements never enter the queue', async () => {
  const f = fixture();
  const settled = await Promise.allSettled(['first', 'second'].map((content) => (
    f.queue.enqueuePrompt(f.message, 'channel', content)
  )));
  assert.equal(f.state.queue.length, 0, 'no accepted follow-up may be duplicated');
  assert.ok(settled.every((item) => item.status === 'fulfilled'));
  const outcomes = settled.map((item) => item.value);
  assert.ok(outcomes.every((item) => item.steered && !item.enqueued));
  assert.equal(f.state.queue.length, 0);
  assert.deepEqual(f.counts(), { executions: 0, steerCalls: 2, deliveries: 2 });
  assert.equal(f.warnings.length, 2);
});

for (const mode of ['rejected', 'throwing']) {
  test(`${mode} steering still falls back to exactly one queued task`, async () => {
    const f = fixture({
      rejected: mode === 'rejected',
      steeringError: mode === 'throwing' ? new Error('turn not found') : null,
      deliveryFails: false,
    });
    const result = await f.queue.enqueuePrompt(f.message, 'channel', 'adjust the task');
    assert.equal(result.enqueued, true);
    assert.equal(f.state.queue.length, 1);
    assert.equal(f.state.queue[0].content, 'adjust the task');
    assert.equal(f.warnings.length, 0);
    assert.deepEqual(f.counts(), { executions: 0, steerCalls: 1, deliveries: 1 });
  });
}
