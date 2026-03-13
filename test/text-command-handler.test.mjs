import test from 'node:test';
import assert from 'node:assert/strict';

import { createTextCommandHandler } from '../src/text-command-handler.js';

function createMessage() {
  return {
    channel: { id: 'channel-1' },
  };
}

test('createTextCommandHandler replies for unknown commands', async () => {
  const replies = [];
  const session = { provider: 'codex' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!wat');

  assert.deepEqual(replies, ['未知命令。发 `!help` 看命令列表。']);
});

test('createTextCommandHandler updates mode through shared command actions', async () => {
  const replies = [];
  const session = { provider: 'codex', mode: 'safe' };
  let saveCount = 0;

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    commandActions: {
      setMode(currentSession, mode) {
        currentSession.mode = mode;
        saveCount += 1;
        return { mode: currentSession.mode };
      },
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!mode dangerous');

  assert.equal(session.mode, 'dangerous');
  assert.equal(saveCount, 1);
  assert.deepEqual(replies, ['✅ mode = dangerous']);
});

test('createTextCommandHandler switches to a fresh session without retry hint', async () => {
  const replies = [];
  const session = { provider: 'codex', runnerSessionId: 'sess-1', codexThreadId: 'sess-1', lastInputTokens: 42 };
  let startCalls = 0;

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    commandActions: {
      startNewSession(currentSession) {
        currentSession.runnerSessionId = null;
        currentSession.codexThreadId = null;
        currentSession.lastInputTokens = null;
        startCalls += 1;
      },
    },
    cancelChannelWork: () => ({ cancelledRunning: false, clearedQueued: 0 }),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!new');

  assert.equal(startCalls, 1);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(session.lastInputTokens, null);
  assert.deepEqual(replies, ['🆕 已切换到新会话。\n下一条普通消息会开启新的上下文。']);
});

test('createTextCommandHandler rejects compact for non-codex providers', async () => {
  const replies = [];
  const session = { provider: 'gemini' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getProviderDisplayName: (provider) => provider === 'gemini' ? 'Gemini CLI' : provider,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!compact status');

  assert.deepEqual(replies, ['⚠️ 当前 provider = `gemini` (Gemini CLI)，`!compact` 仅支持 Codex CLI。']);
});
