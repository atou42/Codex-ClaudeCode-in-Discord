import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createRunnerExecutor } from '../src/runner-executor.js';
import { CODEX_GOAL_CONTINUATION_PROMPT } from '../src/codex-goal-flow.js';
import {
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from '../src/codex-event-utils.js';
import { normalizeProvider as testNormalizeProvider } from '../src/provider-metadata.js';

test('createRunnerExecutor builds Antigravity args instead of codex args', () => {
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'agy',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: session.model ? 'session override' : 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    provider: 'antigravity',
    session: {
      provider: 'antigravity',
      mode: 'dangerous',
      model: 'Claude Opus 4.6 (Thinking)',
      runnerSessionId: 'sess-agy-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'summarize the repo',
  });

  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--conversation',
    'sess-agy-1',
    '--prompt',
    'summarize the repo',
  ]);
});

test('createRunnerExecutor reads Antigravity stdout and conversation id', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'agy',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    readAntigravitySessionState: () => ({
      sessionId: 'agy-conversation-1',
      messages: [],
      finalAnswer: '',
      usage: null,
    }),
    spawnFn: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('Antigravity done\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'antigravity', mode: 'safe' },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'agy-conversation-1');
  assert.deepEqual(result.finalAnswerMessages, ['Antigravity done']);
});

test('createRunnerExecutor routes every OMP turn through the persistent interactive runner', async () => {
  const calls = [];
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'omp',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    createOmpInteractiveRunnerFn: () => ({
      async runTask(options) {
        calls.push(options);
        return { ok: true, threadId: 'omp-live-1', finalAnswerMessages: ['OMP_DONE'] };
      },
      closeSession: () => false,
      closeAll: () => 0,
      getSnapshot: () => [],
    }),
  });

  const result = await executor.runProviderTask({
    session: { provider: 'omp', mode: 'dangerous', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: '/goal set ship it',
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'omp-live-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, 'discord-thread-1');
  assert.equal(calls[0].prompt, '/goal set ship it');
});

test('createRunnerExecutor includes OMP in targeted and global runtime cleanup', () => {
  const closes = [];
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'omp',
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    createOmpInteractiveRunnerFn: () => ({
      runTask: async () => ({ ok: true }),
      closeSession(key, reason) {
        closes.push(['one', key, reason]);
        return true;
      },
      closeAll(reason) {
        closes.push(['all', reason]);
        return 2;
      },
      getSnapshot: () => [],
    }),
  });

  assert.equal(executor.closeRuntimeSession('thread-1', 'reset'), true);
  assert.equal(executor.closeAllRuntimeSessions('shutdown'), 2);
  assert.deepEqual(closes, [['one', 'thread-1', 'reset'], ['all', 'shutdown']]);
});

test('createRunnerExecutor completes a Cursor JSON turn and preserves its chat id', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  const spawnCalls = [];

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'agent',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    spawnFn: (bin, args) => {
      spawnCalls.push({ bin, args });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"system","subtype":"init","session_id":"cursor-session-1","model":"GPT-5.6 Sol"}',
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"CURSOR_DONE"}]},"session_id":"cursor-session-1"}',
          '{"type":"result","subtype":"success","is_error":false,"result":"CURSOR_DONE","session_id":"cursor-session-1","usage":{"inputTokens":2,"outputTokens":3}}',
          '',
        ].join('\n')));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'cursor', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'cursor-session-1');
  assert.deepEqual(result.finalAnswerMessages, ['CURSOR_DONE']);
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 });
  assert.equal(spawnCalls[0].bin, 'agent');
  assert.deepEqual(spawnCalls[0].args, [
    '--print',
    '--output-format', 'stream-json',
    '--trust',
    '--workspace', '/tmp/workspace',
    '--auto-review',
    '--sandbox', 'enabled',
    'hello',
  ]);
});

test('createRunnerExecutor surfaces Cursor authentication failure instead of a protocol fallback', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'agent',
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    spawnFn: () => {
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('Not logged in. Run agent login.\n'));
        child.emit('close', 1, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'cursor', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Not logged in/);
  assert.doesNotMatch(result.error, /missing result event/);
});

function createCursorProtocolTestExecutor({ stdout = '', stderr = '', code = 0, signal = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  return createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'agent',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveCompactStrategySetting: () => ({ strategy: 'off' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    spawnFn: () => {
      setImmediate(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code, signal);
      });
      return child;
    },
  });
}

test('createRunnerExecutor rejects malformed Cursor output on a zero exit', async () => {
  const executor = createCursorProtocolTestExecutor({
    stdout: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"unfinished"}]}}\n',
  });
  const result = await executor.runProviderTask({
    session: { provider: 'cursor', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid Cursor JSON stream: missing result event or session id');
  assert.deepEqual(result.finalAnswerMessages, []);
});

test('createRunnerExecutor treats a cancelled Cursor process as cancellation, not malformed output', async () => {
  const executor = createCursorProtocolTestExecutor({ signal: 'SIGTERM' });
  const result = await executor.runProviderTask({
    session: { provider: 'cursor', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'wait',
    wasCancelled: () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, 'cursor exited via signal SIGTERM');
  assert.doesNotMatch(result.error, /invalid Cursor JSON stream/);
});

test('createRunnerExecutor completes a Grok JSON turn and preserves its session id', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  const spawnCalls = [];
  const stagedPrompts = [];
  const cleanedPromptFiles = [];

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'grok',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    stageGrokPromptFileFn: async ({ prompt, inputImages }) => {
      stagedPrompts.push({ prompt, inputImages });
      return {
        path: '/tmp/grok-prompt.txt',
        cleanup: async () => cleanedPromptFiles.push('/tmp/grok-prompt.txt'),
      };
    },
    spawnFn: (bin, args) => {
      spawnCalls.push({ bin, args });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"text","data":"GROK_"}',
          '{"type":"text","data":"DONE"}',
          '{"type":"end","stopReason":"EndTurn","sessionId":"93ed097e-09c8-496b-9a45-1c7404101fee","requestId":"request-1"}',
          '',
        ].join('\n')));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'grok', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'x'.repeat(19_448),
    inputImages: ['/tmp/input.png'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, '93ed097e-09c8-496b-9a45-1c7404101fee');
  assert.deepEqual(result.finalAnswerMessages, ['GROK_DONE']);
  assert.equal(spawnCalls[0].bin, 'grok');
  assert.equal(spawnCalls[0].args.includes('--always-approve'), true);
  assert.equal(spawnCalls[0].args.includes('--permission-mode'), false);
  assert.equal(spawnCalls[0].args.includes('--sandbox'), true);
  assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('--prompt-file') + 1], '/tmp/grok-prompt.txt');
  assert.equal(spawnCalls[0].args.some((arg) => arg.length > 8192), false);
  assert.deepEqual(stagedPrompts, [{ prompt: 'x'.repeat(19_448), inputImages: ['/tmp/input.png'] }]);
  assert.deepEqual(cleanedPromptFiles, ['/tmp/grok-prompt.txt']);
});

test('createRunnerExecutor rejects a cancelled Grok turn and does not promote commentary to final output', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'grok',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    spawnFn: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"text","data":"I will inspect the workspace."}',
          '{"type":"tool_call","toolCallId":"call-1","toolName":"run_terminal_command","rawInput":{"command":"pwd"}}',
          '{"type":"tool_call_update","toolCallId":"call-1","status":"failed"}',
          '{"type":"end","stopReason":"cancelled","sessionId":"grok-cancelled-session"}',
          '',
        ].join('\n')));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'grok', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Grok turn ended with stop reason: cancelled');
  assert.deepEqual(result.messages, ['I will inspect the workspace.']);
  assert.deepEqual(result.finalAnswerMessages, []);
});

test('createRunnerExecutor rejects incomplete Grok output even when the CLI exits zero', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'grok',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    spawnFn: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('{"type":"text","data":"unfinished"}\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'grok', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid Grok JSON stream: missing end event or session id');
});

test('createRunnerExecutor rejects Pi-family model errors even when the CLI exits zero', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'pi',
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    spawnFn: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(
          '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"provider unavailable"}}\n',
        ));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'pi', mode: 'safe' },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider unavailable');
});

test('createRunnerExecutor rejects incomplete or aborted Pi-family output even when the CLI exits zero', async () => {
  for (const { stdout, expectedError } of [
    {
      stdout: 'not-json\n',
      expectedError: /Pi JSON stream/,
    },
    {
      stdout: '{"type":"session","id":"pi-session","cwd":"/tmp/workspace"}\n',
      expectedError: /Pi JSON stream/,
    },
    {
      stdout: [
        '{"type":"session","id":"pi-aborted","cwd":"/tmp/workspace"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Partial output must not be delivered."}],"stopReason":"aborted"}}',
        '',
      ].join('\n'),
      expectedError: /Pi-family turn ended with stop reason: aborted/,
    },
  ]) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    const executor = createRunnerExecutor({
      spawnEnv: process.env,
      ensureDir: () => {},
      normalizeProvider: testNormalizeProvider,
      getSessionProvider: (session) => session.provider,
      getProviderBin: () => 'pi',
      getSessionId: (session) => session.runnerSessionId,
      resolveModelSetting: () => ({ value: null, source: 'provider' }),
      resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
      spawnFn: () => {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(stdout));
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    const result = await executor.runProviderTask({
      session: { provider: 'pi', mode: 'safe', runnerSessionId: null },
      workspaceDir: '/tmp/workspace',
      prompt: 'hello',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, expectedError);
    assert.deepEqual(result.finalAnswerMessages, []);
  }
});

test('createRunnerExecutor parses pretty-printed ZCode JSON and preserves its session', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  const bridgeStarts = [];
  const bridgeEvents = [];
  let bridgeStops = 0;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'zcode',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: (options) => {
      bridgeStarts.push(options);
      options.onEvent({
        type: 'tool_execution_start',
        model: 'GLM-5.3',
        toolName: 'Read',
        args: { description: 'Read project overview' },
      });
      return () => {
        bridgeStops += 1;
      };
    },
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    spawnFn: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          sessionId: 'sess_zcode_1',
          response: 'ZCODE_DONE',
          usage: { inputTokens: 42, outputTokens: 3, totalTokens: 45 },
          projection: { status: 'idle', contextUsed: 45, contextWindow: 1000000 },
        }, null, 2)));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'zcode', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    onEvent: (event) => bridgeEvents.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'sess_zcode_1');
  assert.deepEqual(result.finalAnswerMessages, ['ZCODE_DONE']);
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 3, totalTokens: 45 });
  assert.equal(bridgeStarts.length, 1);
  assert.equal(bridgeStarts[0]?.provider, 'zcode');
  assert.equal(bridgeStarts[0]?.threadId, '');
  assert.equal(bridgeStarts[0]?.workspaceDir, '/tmp/workspace');
  assert.equal(bridgeEvents[0]?.type, 'tool_execution_start');
  assert.equal(bridgeStops, 1);
});

test('createRunnerExecutor rejects malformed ZCode JSON even when the process exits zero', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'zcode',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
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
    spawnFn: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('{not-json}\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'zcode', mode: 'safe', runnerSessionId: null },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid ZCode JSON response/);
  assert.deepEqual(result.finalAnswerMessages, []);
});

test('createRunnerExecutor applies Antigravity model setting before spawning', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  const applied = [];
  let spawned = false;

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: testNormalizeProvider,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'agy',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: 'session override' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    applyProviderModelSetting(input) {
      assert.equal(spawned, false);
      applied.push(input);
    },
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    readAntigravitySessionState: () => null,
    spawnFn: () => {
      spawned = true;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('done\n'));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'antigravity', mode: 'safe', model: 'Claude Opus 4.6 (Thinking)' },
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });

  assert.equal(result.ok, true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].provider, 'antigravity');
  assert.equal(applied[0].modelSetting.value, 'Claude Opus 4.6 (Thinking)');
});

test('createRunnerExecutor routes Claude long runtime to the hot-session runner', async () => {
  let longRunInput = null;
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => value,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'claude',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: false, supported: false }),
    resolveRuntimeModeSetting: () => ({ mode: 'long', supported: true }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    createClaudeLongRunnerFn: () => ({
      runTask(input) {
        longRunInput = input;
        return Promise.resolve({
          ok: true,
          cancelled: false,
          timedOut: false,
          error: '',
          logs: [],
          messages: [],
          finalAnswerMessages: ['done'],
          reasonings: [],
          usage: null,
          threadId: 'claude-session-1',
        });
      },
      closeSession: () => false,
      closeAll: () => 0,
      getSnapshot: () => [],
    }),
  });

  const result = await executor.runProviderTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'claude-session-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'claude-session-1');
  assert.equal(longRunInput.sessionKey, 'discord-thread-1');
  assert.equal(longRunInput.prompt, 'hello');
  assert.equal(longRunInput.systemPrompt, '[Via agents-in-discord; discord_thread=thread-1]');
});

test('createRunnerExecutor routes Codex long runtime to the app-server runner', async () => {
  let codexLongInput = null;
  let codexLongOptions = null;
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveCodexProfileSetting: () => ({ value: null, source: 'provider default', valid: true, isExplicit: false }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: false, supported: true }),
    resolveRuntimeModeSetting: () => ({ mode: 'long', supported: true }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    codexAppServerDisabledMcpServers: ['flomo'],
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    createCodexAppServerRunnerFn: (options) => {
      codexLongOptions = options;
      return {
        runTask(input) {
          codexLongInput = input;
          return Promise.resolve({
            ok: true,
            cancelled: false,
            timedOut: false,
            error: '',
            logs: [],
            messages: [],
            finalAnswerMessages: ['done'],
            reasonings: [],
            usage: null,
            threadId: 'codex-thread-1',
            meta: {},
          });
        },
        closeSession: () => false,
        closeAll: () => 0,
        getSnapshot: () => [],
      };
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'codex-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'codex-thread-1');
  assert.equal(codexLongInput.sessionKey, 'discord-thread-1');
  assert.equal(codexLongInput.prompt, 'hello');
  assert.equal(codexLongInput.systemPrompt, '[Via agents-in-discord; discord_thread=thread-1]');
  assert.deepEqual(codexLongOptions.disabledMcpServers, ['flomo']);
});

test('createRunnerExecutor keeps explicit Codex profiles and raw config on the one-shot runner', async () => {
  for (const sessionOverrides of [
    { codexProfile: 'work' },
    { configOverrides: ['foo="bar"'] },
  ]) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const spawnCalls = [];
    let appServerRuns = 0;
    const executor = createRunnerExecutor({
      spawnEnv: process.env,
      ensureDir: () => {},
      normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
      getSessionProvider: (session) => session.provider,
      getProviderBin: () => 'codex',
      getSessionId: (session) => session.runnerSessionId,
      resolveModelSetting: () => ({ value: null, source: 'provider' }),
      resolveCodexProfileSetting: (session) => session.codexProfile
        ? { value: session.codexProfile, source: 'session override', valid: true, isExplicit: true }
        : { value: null, source: 'provider default', valid: true, isExplicit: false },
      resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
      resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
      resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
      resolveRuntimeModeSetting: () => ({ mode: 'long', supported: true }),
      resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
      resolveCompactEnabledSetting: () => ({ enabled: false }),
      resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
      normalizeTimeoutMs: (value) => Number(value || 0),
      safeError: (err) => String(err?.message || err),
      stopChildProcess: (target) => target.kill(),
      startSessionProgressBridge: () => () => {},
      extractAgentMessageText,
      isFinalAnswerLikeAgentMessage,
      spawnFn: (bin, args) => {
        spawnCalls.push({ bin, args });
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from([
            '{"type":"thread.started","thread_id":"codex-thread-1"}',
            '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"one-shot done"}}',
            '',
          ].join('\n')));
          child.emit('close', 0, null);
        });
        return child;
      },
      createCodexAppServerRunnerFn: () => ({
        runTask() {
          appServerRuns += 1;
          throw new Error('app-server should not run');
        },
        closeSession: () => false,
        closeAll: () => 0,
        getSnapshot: () => [],
      }),
    });

    const result = await executor.runProviderTask({
      session: {
        provider: 'codex',
        mode: 'safe',
        runnerSessionId: null,
        configOverrides: [],
        ...sessionOverrides,
      },
      sessionKey: 'discord-thread-1',
      workspaceDir: '/tmp/workspace',
      prompt: 'hello',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.finalAnswerMessages, ['one-shot done']);
    assert.equal(appServerRuns, 0);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].args[0], 'exec');
  }
});

test('createRunnerExecutor routes Codex long steer and rejects exec steer', async () => {
  const steerInputs = [];
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveCodexProfileSetting: () => ({ value: null, source: 'provider default', valid: true, isExplicit: false }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: false, supported: true }),
    resolveRuntimeModeSetting: (session) => ({ mode: session.runtimeMode || 'normal', supported: true }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    createCodexAppServerRunnerFn: () => ({
      runTask() {
        throw new Error('should not run task');
      },
      steerTask(input) {
        steerInputs.push(input);
        return Promise.resolve({ ok: true, steered: true, threadId: 'thread-1', turnId: 'turn-1' });
      },
      closeSession: () => false,
      closeAll: () => 0,
      getSnapshot: () => [],
    }),
  });

  const steered = await executor.steerProviderTask({
    session: { provider: 'codex', runtimeMode: 'long', runnerSessionId: 'thread-1' },
    sessionKey: 'discord-thread-1',
    prompt: 'adjust',
  });
  assert.deepEqual(steered, { ok: true, steered: true, threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(steerInputs[0].sessionKey, 'discord-thread-1');
  assert.equal(steerInputs[0].prompt, 'adjust');

  const rejected = await executor.steerProviderTask({
    session: { provider: 'codex', runtimeMode: 'normal', runnerSessionId: 'thread-1' },
    sessionKey: 'discord-thread-1',
    prompt: 'adjust',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unsupported_runtime');
});

test('createRunnerExecutor starts and cleans Codex side conversations through app-server runner', async () => {
  const sideInputs = [];
  const runInputs = [];
  const closeInputs = [];
  const unsubscribeInputs = [];
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveCodexProfileSetting: () => ({ value: null, source: 'provider default', valid: true, isExplicit: false }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: false, supported: true }),
    resolveRuntimeModeSetting: (session) => ({ mode: session.runtimeMode || 'normal', supported: true }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    unsubscribeCodexThread: async (input) => {
      unsubscribeInputs.push(input);
      return { ok: true };
    },
    createCodexAppServerRunnerFn: () => ({
      runTask() {
        const input = arguments[0];
        runInputs.push(input);
        return Promise.resolve({ ok: true, threadId: input.targetThreadId, finalAnswerMessages: ['side'], logs: [], messages: [], reasonings: [], usage: null, meta: {} });
      },
      steerTask() {
        throw new Error('should not steer');
      },
      forkSideThread(input) {
        sideInputs.push(input);
        return Promise.resolve({ ok: true, parentThreadId: 'parent-1', sideThreadId: 'side-1' });
      },
      closeSideThread(input) {
        closeInputs.push(input);
        return Promise.resolve({ ok: true, reason: 'no_live_runner', threadId: input.threadId });
      },
      closeSession: () => false,
      closeAll: () => 0,
      getSnapshot: () => [],
    }),
  });

  const started = await executor.startCodexSideConversation({
    session: { provider: 'codex', runtimeMode: 'long', runnerSessionId: 'parent-1' },
    sessionKey: 'channel-1',
    workspaceDir: '/tmp/workspace',
    sideDeveloperInstructions: 'side rules',
    boundaryItems: [{ type: 'message' }],
  });
  assert.equal(started.sideThreadId, 'side-1');
  assert.equal(sideInputs[0].sessionKey, 'channel-1');
  assert.equal(sideInputs[0].boundaryItems.length, 1);

  const sideRun = await executor.runProviderTask({
    session: {
      provider: 'codex',
      runtimeMode: 'long',
      runnerSessionId: 'side-1',
      sideConversation: {
        status: 'open',
        parentChannelId: 'channel-1',
        sideSessionId: 'side-1',
      },
    },
    sessionKey: 'side-channel-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'side question',
  });
  assert.equal(sideRun.threadId, 'side-1');
  assert.equal(runInputs[0].sessionKey, 'channel-1');
  assert.equal(runInputs[0].targetThreadId, 'side-1');

  const closed = await executor.closeCodexSideConversation({
    session: { provider: 'codex', runnerSessionId: 'side-1' },
    sessionKey: 'side-channel-1',
    threadId: 'side-1',
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.reason, 'one_shot_unsubscribe');
  assert.equal(closeInputs[0].sessionKey, 'side-channel-1');
  assert.deepEqual(unsubscribeInputs, [{ threadId: 'side-1' }]);
});

test('createRunnerExecutor stops Codex goal continuation when official goal state becomes complete', async () => {
  let killed = false;
  const goalCalls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 1,
    async getCodexThreadGoal({ threadId }) {
      goalCalls.push(threadId);
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
          tokenBudget: 1000,
          tokensUsed: 900,
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","phase":"commentary","text":"先完成实现。"}}',
          '{"type":"item.completed","item":{"type":"agent_message","phase":"commentary","text":"再完成线上验收。"}}',
          '',
        ].join('\n')));
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.error, '');
  assert.equal(result.threadId, 'goal-thread-1');
  assert.deepEqual(result.finalAnswerMessages, ['先完成实现。', '再完成线上验收。']);
  assert.deepEqual(goalCalls, ['goal-thread-1']);
});

test('createRunnerExecutor stops Codex goal continuation when Codex reports a blocker', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 10_000,
    codexGoalCompletionGraceMs: 1,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'active',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"goal 还是 active。当前只差实体手机跑满 60 秒后的真实 JSON。没有这份记录，验收闭环不成立，所以现在不能交付，也不能关 goal。update_goal 未调用。"}}',
          '',
        ].join('\n')));
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.error, '');
  assert.deepEqual(result.finalAnswerMessages, [
    'goal 还是 active。当前只差实体手机跑满 60 秒后的真实 JSON。没有这份记录，验收闭环不成立，所以现在不能交付，也不能关 goal。update_goal 未调用。',
  ]);
  assert.ok(result.logs.includes('Codex goal reported a blocker; waiting 1ms for final output before stopping runner.'));
});

test('createRunnerExecutor stops a regular Codex goal run when Codex reports a blocker', async () => {
  let killed = false;
  let goalCalls = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 1,
    async getCodexThreadGoal() {
      goalCalls += 1;
      return {
        goal: {
          objective: 'ship goal mode',
          status: 'active',
        },
      };
    },
    spawnFn: () => {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"目标未完成。实体手机 60 秒真实 JSON 仍缺。没有这份验收记录，不能关闭 goal。update_goal 未调用。"}}',
          '',
        ].join('\n')));
      }, 5);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: '看看 goal 的状态，继续推进 goal 直到可以交付',
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(goalCalls, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalAnswerMessages, [
    '目标未完成。实体手机 60 秒真实 JSON 仍缺。没有这份验收记录，不能关闭 goal。update_goal 未调用。',
  ]);
});

test('createRunnerExecutor lets Codex goal completion emit its final summary before stopping', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 50,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '',
        ].join('\n')));
      });
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"完整总结：验证细节和剩余事项都在这里。"}}',
          '',
        ].join('\n')));
        child.emit('close', 0, null);
      }, 10);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalAnswerMessages, ['完整总结：验证细节和剩余事项都在这里。']);
});

test('createRunnerExecutor extends Codex goal completion grace while final output is still arriving', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 20,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '',
        ].join('\n')));
      });
      setTimeout(() => {
        if (child.killed) return;
        child.stdout.emit('data', Buffer.from([
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"第一段总结已经出来。"}}',
          '',
        ].join('\n')));
      }, 10);
      setTimeout(() => {
        if (child.killed) return;
        child.stdout.emit('data', Buffer.from([
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"第二段验证结果也完整出来。"}}',
          '',
        ].join('\n')));
      }, 25);
      setTimeout(() => {
        if (!child.killed) child.emit('close', 0, null);
      }, 80);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  // The grace period still let both segments arrive; the newest is the reply
  // and the one it superseded is kept as progress.
  assert.deepEqual(result.finalAnswerMessages, ['第二段验证结果也完整出来。']);
  assert.ok(result.messages.includes('第一段总结已经出来。'));
});

test('createRunnerExecutor lets Codex finish a blocker final answer before stopping', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 10_000,
    codexGoalCompletionGraceMs: 20,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'active',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '',
        ].join('\n')));
      });
      setTimeout(() => {
        if (child.killed) return;
        child.stdout.emit('data', Buffer.from([
          '{"type":"item.delta","item":{"type":"agent_message","phase":"final_answer","text":"目标未完成。实体手机 60 秒真实 JSON 仍缺，不能关闭 goal。"}}',
          '',
        ].join('\n')));
      }, 5);
      setTimeout(() => {
        if (child.killed) return;
        child.stdout.emit('data', Buffer.from([
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"目标未完成。实体手机 60 秒真实 JSON 仍缺，不能关闭 goal。还需要补上这份验收记录后再交付。"}}',
          '',
        ].join('\n')));
      }, 15);
      setTimeout(() => {
        if (!child.killed) child.emit('close', 0, null);
      }, 70);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  // Here the second message extends the first, so keeping only the newest also
  // avoids emitting the truncated version alongside the complete one.
  assert.deepEqual(result.finalAnswerMessages, [
    '目标未完成。实体手机 60 秒真实 JSON 仍缺，不能关闭 goal。还需要补上这份验收记录后再交付。',
  ]);
});

test('createRunnerExecutor collects Codex goal final output from bridged session events', async () => {
  let killed = false;
  let bridgeOnEvent = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: ({ onEvent: nextOnEvent }) => {
      bridgeOnEvent = nextOnEvent;
      return () => {};
    },
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 20,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '',
        ].join('\n')));
      });
      setTimeout(() => {
        bridgeOnEvent?.({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: '桥接总结：过程、验证和结果都在这里。',
            phase: 'final_answer',
          },
        });
        bridgeOnEvent?.({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: '桥接总结：过程、验证和结果都在这里。',
          },
        });
      }, 5);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalAnswerMessages, ['桥接总结：过程、验证和结果都在这里。']);
});
