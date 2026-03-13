import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRunnerExecutor,
  buildClaudeRecoveryPrompt,
  handleCodexRunnerEvent,
  handleGeminiRunnerEvent,
  shouldAutoRecoverClaudeResult,
} from '../src/runner-executor.js';
import {
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from '../src/codex-event-utils.js';

test('handleCodexRunnerEvent captures codex 0.111 item.completed final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };
  const bridges = [];

  handleCodexRunnerEvent({
    type: 'thread.started',
    thread_id: 'thread-123',
  }, state, (threadId) => bridges.push(threadId), {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: '你好',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'turn.completed',
    usage: {
      input_tokens: 13200,
      output_tokens: 28,
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(bridges, ['thread-123']);
  assert.equal(state.threadId, 'thread-123');
  assert.deepEqual(state.finalAnswerMessages, ['你好']);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.usage, {
    type: 'turn.completed',
    usage: {
      input_tokens: 13200,
      output_tokens: 28,
    },
  });
});

test('handleCodexRunnerEvent keeps commentary item.completed out of final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };

  handleCodexRunnerEvent({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'agent_message',
      text: '我先看一下代码结构。',
      phase: 'commentary',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(state.messages, ['我先看一下代码结构。']);
  assert.deepEqual(state.finalAnswerMessages, []);
});

test('handleGeminiRunnerEvent captures init, delta messages, and result stats', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      geminiDeltaBuffer: '',
    },
  };
  const bridges = [];

  handleGeminiRunnerEvent({
    type: 'init',
    session_id: 'gemini-session-123',
  }, state, (threadId) => bridges.push(threadId));

  handleGeminiRunnerEvent({
    type: 'message',
    role: 'assistant',
    content: 'I will inspect the repo.',
    delta: true,
  }, state, () => {});

  handleGeminiRunnerEvent({
    type: 'result',
    stats: {
      input_tokens: 18,
      output_tokens: 7,
    },
  }, state, () => {});

  assert.deepEqual(bridges, ['gemini-session-123']);
  assert.equal(state.threadId, 'gemini-session-123');
  assert.equal(state.meta.geminiDeltaBuffer, 'I will inspect the repo.');
  assert.deepEqual(state.usage, {
    input_tokens: 18,
    output_tokens: 7,
  });
});

test('createRunnerExecutor builds gemini args instead of codex args', () => {
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => value,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'gemini',
    getSessionId: (session) => session.runnerSessionId,
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  const args = executor.buildSessionRunnerArgs({
    provider: 'gemini',
    session: {
      provider: 'gemini',
      mode: 'dangerous',
      model: 'gemini-2.5-pro',
      runnerSessionId: 'sess-gm-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'summarize the repo',
  });

  assert.deepEqual(args, [
    '--output-format',
    'stream-json',
    '--yolo',
    '--model',
    'gemini-2.5-pro',
    '--resume',
    'sess-gm-1',
    '--prompt',
    'summarize the repo',
  ]);
});

test('shouldAutoRecoverClaudeResult detects agent handoff early exit', () => {
  const shouldRecover = shouldAutoRecoverClaudeResult({
    ok: true,
    cancelled: false,
    timedOut: false,
    messages: ['我来深入研究一下这个仓库，看看对你们有什么价值。'],
    finalAnswerMessages: ['我来深入研究一下这个仓库，看看对你们有什么价值。'],
    meta: {
      claudeSawAgentToolUse: true,
      claudeStopReason: null,
    },
  });

  assert.equal(shouldRecover, true);
});

test('shouldAutoRecoverClaudeResult ignores normal Claude completion', () => {
  const shouldRecover = shouldAutoRecoverClaudeResult({
    ok: true,
    cancelled: false,
    timedOut: false,
    messages: ['我先查一下。'],
    finalAnswerMessages: ['结论：这个仓库更适合作为交互样例。'],
    meta: {
      claudeSawAgentToolUse: true,
      claudeStopReason: 'end_turn',
    },
  });

  assert.equal(shouldRecover, false);
});

test('buildClaudeRecoveryPrompt asks for a final answer instead of preamble', () => {
  const prompt = buildClaudeRecoveryPrompt();
  assert.match(prompt, /继续刚才的同一任务/);
  assert.match(prompt, /请直接完成任务并输出最终答案/);
  assert.match(prompt, /不要只输出一句开场白/);
});
