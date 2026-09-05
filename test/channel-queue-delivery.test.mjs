import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelQueue } from '../src/channel-queue.js';

function setup({ steerPrompt, safeReply }) {
  const state = { running: true, queue: [], activeRun: { messageId: 'active' } };
  const warnings = [];
  const queue = createChannelQueue({
    getChannelState: () => state,
    getSession: () => ({ provider: 'codex' }),
    resolveSecurityContext: () => ({ maxQueuePerChannel: 10 }),
    resolveBusyPromptModeSetting: () => ({ mode: 'steer_if_possible', canSteer: true }),
    safeError: (error) => error.message,
    safeReply,
    steerPrompt,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    handlePrompt: async () => { throw new Error('accepted steer must not run again'); },
  });
  return { state, warnings, queue };
}

const message = { id: 'followup', channel: { id: 'channel' }, author: { id: 'user' } };

test('an accepted steer is not queued again when its Discord confirmation fails', async () => {
  let steerCalls = 0;
  let replyCalls = 0;
  const { state, warnings, queue } = setup({
    steerPrompt: async () => { steerCalls += 1; return { steered: true }; },
    safeReply: async () => {
      replyCalls += 1;
      if (replyCalls === 1) throw new Error('confirmation delivery failed');
    },
  });
  const result = await queue.enqueuePrompt(message, 'channel', 'do this once');
  assert.equal(result.steered, true);
  assert.equal(result.enqueued, false);
  assert.equal(state.queue.length, 0);
  assert.equal(state.running, true);
  assert.equal(state.activeRun.messageId, 'active');
  assert.equal(steerCalls, 1);
  assert.equal(replyCalls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /confirmation delivery failed/);
  assert.match(warnings[0], /not requeued/);
});

test('a thrown steer failure still queues once and reports the real failure', async () => {
  const replies = [];
  const { state, warnings, queue } = setup({
    steerPrompt: async () => { throw new Error('steer rejected'); },
    safeReply: async (_message, text) => replies.push(text),
  });
  const result = await queue.enqueuePrompt(message, 'channel', 'try after active task');
  assert.equal(result.enqueued, true);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].content, 'try after active task');
  assert.match(replies[0], /steer rejected/);
  assert.equal(warnings.length, 0);
});

test('an ordinary accepted steer confirms once without changing queue or active run', async () => {
  const replies = [];
  const { state, warnings, queue } = setup({
    steerPrompt: async () => ({ steered: true }),
    safeReply: async (_message, text) => replies.push(text),
  });
  assert.deepEqual(await queue.enqueuePrompt(message, 'channel', 'followup'), {
    ok: true, enqueued: false, steered: true,
  });
  assert.equal(state.queue.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(warnings.length, 0);
});
