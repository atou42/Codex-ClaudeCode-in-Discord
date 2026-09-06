import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelQueue } from '../src/channel-queue.js';
import { createSlashCommandRouter, parseCommandActionButtonId } from '../src/slash-command-router.js';
import { createDiscordEntryHandlers } from '../src/discord-entry-handlers.js';
import { safeReply } from '../src/discord-reply-utils.js';

function fixture({ accepted = true, ackFails = false, full = false, steer, sessionError = null } = {}) {
  const key = 'channel-1';
  const owner = '123456789';
  const state = { running: true, queue: full ? [{ content: 'already waiting' }] : [], activeRun: {} };
  const acknowledgements = [];
  let steerCalls = 0;
  let executions = 0;
  const message = { id: 'failed-input', author: { id: owner }, channel: { id: key },
    reply: async (text) => {
      acknowledgements.push(text);
      if (ackFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    } };
  const original = { message, key, content: 'continue the failed task', authorId: owner };
  let failed = original;
  const queue = createChannelQueue({
    getChannelState: () => state,
    getSession: () => { if (sessionError) throw sessionError; return { provider: 'codex', runtimeMode: 'long' }; },
    resolveSecurityContext: () => ({ maxQueuePerChannel: full ? 1 : 10 }),
    resolveBusyPromptModeSetting: () => ({ mode: 'steer_if_possible', canSteer: true }),
    safeReply, safeError: (error) => error.message, logger: { warn() {} },
    steerPrompt: async () => { steerCalls += 1; return steer ? steer() : { steered: accepted }; },
    handlePrompt: async () => { executions += 1; return { ok: true }; },
    getLastFailedPrompt: () => failed,
    clearLastFailedPrompt: () => { failed = null; },
    rememberFailedPrompt: (_key, record) => { failed = record; },
  });
  return { queue, key, owner, state, original, acknowledgements,
    failed: () => failed, setFailure: (record) => { failed = record; },
    counts: () => ({ steerCalls, executions }) };
}

for (const ackFails of [false, true]) {
  test(`retry consumes accepted steering once even when acknowledgement fails=${ackFails}`, async () => {
    const f = fixture({ ackFails });
    const first = await f.queue.retryLastPrompt(f.key, f.owner);
    assert.equal(first.ok, true);
    assert.equal(first.steered, true);
    assert.equal(first.enqueued, false);
    assert.equal(Boolean(first.notificationError), ackFails);
    assert.equal(f.failed(), null);
    const second = await f.queue.retryLastPrompt(f.key, f.owner);
    assert.equal(second.reason, 'missing_failed_prompt');
    assert.deepEqual(f.counts(), { steerCalls: 1, executions: 0 });
    assert.equal(f.state.queue.length, 0);
    assert.equal(f.acknowledgements.length, 1);
  });
}

test('simultaneous retries cannot claim the same failed input twice', async () => {
  let accept;
  const barrier = new Promise((resolve) => { accept = resolve; });
  const f = fixture({ steer: () => barrier });
  const first = f.queue.retryLastPrompt(f.key, f.owner);
  assert.equal((await f.queue.retryLastPrompt(f.key, f.owner)).reason, 'missing_failed_prompt');
  accept({ steered: true });
  assert.equal((await first).steered, true);
  assert.equal(f.failed(), null);
  assert.equal(f.counts().steerCalls, 1);
});

test('another user cannot claim or execute the failed input', async () => {
  const f = fixture();
  assert.equal((await f.queue.retryLastPrompt(f.key, '987654321')).reason, 'missing_failed_prompt');
  assert.equal(f.failed(), f.original);
  assert.equal(f.counts().steerCalls, 0);
});

for (const ackFails of [false, true]) {
  test(`retry consumes a queued fallback once with acknowledgement fails=${ackFails}`, async () => {
    const f = fixture({ accepted: false, ackFails });
    const result = await f.queue.retryLastPrompt(f.key, f.owner);
    assert.equal(result.ok, true);
    assert.equal(result.enqueued, true);
    assert.equal(result.queuedAhead, 1);
    assert.equal(Boolean(result.notificationError), ackFails);
    assert.equal(f.failed(), null);
    assert.equal((await f.queue.retryLastPrompt(f.key, f.owner)).reason, 'missing_failed_prompt');
    assert.equal(f.state.queue.length, 1);
    assert.equal(f.state.queue[0].content, f.original.content);
    assert.equal(f.counts().steerCalls, 1);
  });
}

test('a rejected steer and full queue retain the original retry record', async () => {
  const f = fixture({ accepted: false, full: true });
  assert.deepEqual(await f.queue.retryLastPrompt(f.key, f.owner), {
    ok: false, enqueued: false, reason: 'queue_full', maxQueue: 1,
  });
  assert.equal(f.failed(), f.original);
  assert.equal(f.state.queue.length, 1);
});

test('an error before acceptance retains the original retry record', async () => {
  const f = fixture({ sessionError: new Error('session unavailable') });
  await assert.rejects(f.queue.retryLastPrompt(f.key, f.owner), /session unavailable/);
  assert.equal(f.failed(), f.original);
  assert.equal(f.counts().steerCalls, 0);
});

for (const mode of ['accepted', 'queue-full', 'notification-error']) {
  test(`old retry must not overwrite a newer failure after ${mode}`, async () => {
    let finish;
    const barrier = new Promise((resolve) => { finish = resolve; });
    const f = fixture({ steer: () => barrier, full: mode !== 'accepted', ackFails: mode === 'notification-error' });
    const pending = f.queue.retryLastPrompt(f.key, f.owner);
    const newer = { ...f.original, content: 'newer failed task' };
    f.setFailure(newer);
    finish({ steered: mode === 'accepted' });
    if (mode === 'notification-error') await assert.rejects(pending, /Missing Permissions/);
    else assert.equal((await pending).ok, mode === 'accepted');
    assert.equal(f.failed(), newer);
    assert.equal(f.counts().steerCalls, 1);
  });
}

function entryFixture(f, { kind, requester = f.owner, responseFails = false } = {}) {
  const replies = [];
  const router = createSlashCommandRouter({ getSession: () => ({ provider: 'codex' }), retryLastPrompt: f.queue.retryLastPrompt });
  const entry = createDiscordEntryHandlers({
    logger: { log() {}, warn() {}, error() {} },
    withDiscordNetworkRetry: async (action) => action(),
    parseCommandActionButtonId,
    isWorkspaceBusyComponentId: () => false, isWorkspaceBrowserComponentId: () => false,
    isOnboardingButtonId: () => false, isSettingsPanelComponentId: () => false,
    normalizeSlashCommandName: () => 'retry', routeSlashCommand: router,
  });
  const interaction = {
    customId: `cmd:retry:${f.owner}`, commandName: 'retry', channelId: f.key, channel: { id: f.key }, user: { id: requester },
    isButton: () => kind === 'button', isStringSelectMenu: () => false, isChatInputCommand: () => kind === 'slash',
    deferReply: async () => { interaction.deferred = true; },
    reply: async (payload) => { if (responseFails) throw new Error('interaction delivery failed'); replies.push(payload); },
    editReply: async (payload) => { if (responseFails) throw new Error('interaction delivery failed'); replies.push(payload); },
  };
  return { replies, run: () => entry.handleInteractionCreate(interaction) };
}

for (const kind of ['slash', 'button']) {
  for (const accepted of [true, false]) {
    test(`${kind} retry reports ${accepted ? 'inserted' : 'queued'} acceptance through real entry and router`, async () => {
      const f = fixture({ accepted });
      const entry = entryFixture(f, { kind });
      await entry.run();
      assert.match(entry.replies[0].content, accepted ? /已插入当前 Codex 任务/ : /已重新加入队列/);
      assert.equal(f.failed(), null);
      await entryFixture(f, { kind }).run();
      assert.equal(f.counts().steerCalls, 1);
      assert.equal(f.state.queue.length, accepted ? 0 : 1);
    });
  }
  test(`${kind} response failure after acceptance cannot re-submit the input`, async () => {
    const f = fixture();
    await assert.rejects(entryFixture(f, { kind, responseFails: true }).run(), /interaction delivery failed/);
    assert.equal(f.failed(), null);
    await entryFixture(f, { kind }).run();
    assert.equal(f.counts().steerCalls, 1);
  });
  test(`${kind} retry from another user never reaches execution`, async () => {
    const f = fixture();
    await entryFixture(f, { kind, requester: '987654321' }).run();
    assert.equal(f.failed(), f.original);
    assert.equal(f.counts().steerCalls, 0);
  });
}
