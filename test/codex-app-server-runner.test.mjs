import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { buildCodexLongConfig, createCodexAppServerRunner } from '../src/codex-app-server-runner.js';
import { CODEX_GOAL_CONTINUATION_PROMPT } from '../src/codex-goal-flow.js';

function waitFor(check, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function createFakeAppServerSpawn({
  autoComplete = true,
  failSteer = false,
  failInject = false,
  completedItems = null,
} = {}) {
  const calls = [];
  const writes = [];
  let activeThreadId = 'thread-1';
  let activeTurnId = 'turn-1';
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', 0, null));
    return true;
  };
  child.stdin = {
    write(chunk, callback) {
      writes.push(String(chunk));
      const request = JSON.parse(String(chunk));
      if (!Object.prototype.hasOwnProperty.call(request, 'id')) {
        callback?.();
        return true;
      }
      if (request.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { codexHome: '/tmp/codex' } })}\n`);
      } else if (request.method === 'thread/start') {
        activeThreadId = 'thread-1';
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'thread-1' } } })}\n`);
      } else if (request.method === 'thread/resume') {
        activeThreadId = request.params.threadId;
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId } } })}\n`);
      } else if (request.method === 'thread/fork') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'side-thread-1', forkedFromId: request.params.threadId } } })}\n`);
      } else if (request.method === 'thread/inject_items') {
        if (failInject) {
          child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'inject failed' } })}\n`);
        } else {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
        }
      } else if (request.method === 'thread/unsubscribe') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
      } else if (request.method === 'turn/interrupt') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
      } else if (request.method === 'turn/start') {
        activeThreadId = request.params.threadId;
        activeTurnId = 'turn-1';
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: activeTurnId, status: 'inProgress' } } })}\n`);
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: activeThreadId, turn: { id: activeTurnId, status: 'inProgress' } } })}\n`);
          if (autoComplete) completeTurn();
        });
      } else if (request.method === 'turn/steer') {
        if (failSteer) {
          child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'cannot steer a review turn' } })}\n`);
        } else {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: { turnId: request.params.expectedTurnId } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: 'message', id: 'steer-1', text: request.params.input[0]?.text || '', phase: 'commentary' } } })}\n`);
        }
      } else {
        child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: `unexpected ${request.method}` } })}\n`);
      }
      callback?.();
      return true;
    },
    end() {},
  };

  function completeTurn() {
    child.stdout.write(`${JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: activeThreadId, turnId: activeTurnId, tokenUsage: { last: { inputTokens: 12, totalTokens: 20, cachedInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 0 } } } })}\n`);
    const items = Array.isArray(completedItems) && completedItems.length
      ? completedItems
      : [{ type: 'agentMessage', id: 'item-1', text: 'done from app-server', phase: 'final_answer' }];
    for (const item of items) {
      child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: activeThreadId, turnId: activeTurnId, item } })}\n`);
    }
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: activeTurnId, status: 'completed' } } })}\n`);
  }

  function spawnFn(bin, args, options) {
    calls.push({ bin, args, options });
    return child;
  }

  return { spawnFn, calls, writes, child, completeTurn };
}

test('buildCodexLongConfig pins openai-curated marketplace to local cache when present', () => {
  const previous = process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
  process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = '/tmp';
  try {
    const config = buildCodexLongConfig({
      session: {},
      resolveFastModeSetting: () => ({ enabled: false, source: 'config.toml' }),
      resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
      resolveCompactEnabledSetting: () => ({ enabled: false }),
      resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    });

    assert.equal(config.marketplaces['openai-curated'].source_type, 'local');
    assert.equal(config.marketplaces['openai-curated'].source, '/tmp');
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE;
    else process.env.CODEX_OPENAI_CURATED_MARKETPLACE_SOURCE = previous;
  }
});

test('buildCodexLongConfig forwards the configured model context window with native compaction', () => {
  const config = buildCodexLongConfig({
    session: {},
    modelContextWindow: 1_050_000,
    resolveFastModeSetting: () => ({ enabled: true, source: 'provider default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 400_000 }),
  });

  assert.equal(config.model_context_window, 1_050_000);
  assert.equal(config.model_auto_compact_token_limit, 400_000);
});

test('buildCodexLongConfig limits the context override to its target model', () => {
  const config = buildCodexLongConfig({
    session: { model: 'gpt-5.5' },
    modelContextWindow: 1_050_000,
    modelContextWindowModel: 'gpt-5.6-sol',
    resolveFastModeSetting: () => ({ enabled: true, source: 'provider default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 400_000 }),
  });

  assert.equal(config.model_context_window, undefined);
  assert.equal(config.model_auto_compact_token_limit, 400_000);
});

test('buildCodexLongConfig applies Luna native compaction independently from Sol', () => {
  const config = buildCodexLongConfig({
    session: { model: 'gpt-5.6-luna' },
    modelContextWindows: { 'gpt-5.6-sol': 1050000, 'gpt-5.6-luna': 1050000 },
    modelCompactTokenLimits: { 'gpt-5.6-sol': 400000, 'gpt-5.6-luna': 40000 },
    resolveFastModeSetting: () => ({ enabled: true, source: 'provider default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 400000, source: 'env default' }),
  });

  assert.equal(config.model_context_window, 1050000);
  assert.equal(config.model_auto_compact_token_limit, 40000);
});

test('createCodexAppServerRunner runs a turn over persistent app-server and closes after idle', async () => {
  const fake = createFakeAppServerSpawn();
  const events = [];
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 1,
    disabledMcpServers: ['flomo'],
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const result = await runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: 'developer context',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'thread-1');
  assert.deepEqual(result.finalAnswerMessages, ['done from app-server']);
  assert.equal(result.usage.last.inputTokens, 12);
  assert.deepEqual(fake.calls.map((call) => [call.bin, call.args]), [
    ['codex-test', ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers.flomo.enabled=false', '--enable', 'goals']],
  ]);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), [
    'initialize',
    'initialized',
    'thread/start',
    'turn/start',
  ]);
  const threadStart = JSON.parse(fake.writes.find((line) => JSON.parse(line).method === 'thread/start'));
  assert.equal(threadStart.params.approvalPolicy, 'on-request');
  assert.equal(threadStart.params.sandbox, 'workspace-write');
  assert.equal(threadStart.params.approvalsReviewer, 'auto_review');
  assert.equal(events.some((event) => event.type === 'item.completed'), true);

  await sleep(20);
  assert.equal(fake.child.killed, true);
});

test('createCodexAppServerRunner starts Codex with the configured model catalog', async () => {
  const fake = createFakeAppServerSpawn();
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: 'gpt-5.6-sol' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'provider default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'native' }),
    resolveCompactEnabledSetting: () => ({ enabled: true }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 400000 }),
    modelContextWindow: 1050000,
    modelContextWindowModel: 'gpt-5.6-sol',
    modelCatalogJson: '/tmp/codex-model-catalog.json',
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    stopChildProcess: (child) => child.kill(),
    log: () => {},
  });
  const result = await runner.runTask({
    session: { provider: 'codex', mode: 'safe' },
    sessionKey: 'catalog-session',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0].args, [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'model_catalog_json="/tmp/codex-model-catalog.json"',
    '--enable',
    'goals',
  ]);
  runner.closeAll('test done');
});

test('createCodexAppServerRunner forwards completed native reasoning summaries as progress events', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const events = [];
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: 'gpt-5.6-sol' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const resultPromise = runner.runTask({
    session: { provider: 'codex', mode: 'safe' },
    sessionKey: 'discord-thread-reasoning',
    workspaceDir: '/tmp/workspace',
    prompt: 'inspect the repository',
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  fake.child.stdout.write(`${JSON.stringify({
    method: 'turn/plan/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: '先定位事件链，再验证 Discord 输出。',
      plan: [
        { step: '定位事件链', status: 'completed' },
        { step: '验证 Discord 输出', status: 'inProgress' },
      ],
    },
  })}\n`);
  fake.child.stdout.write(`${JSON.stringify({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'command-1',
        command: 'rg reasoning src',
        status: 'inProgress',
      },
    },
  })}\n`);
  fake.child.stdout.write(`${JSON.stringify({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: '正在核对 Discord bot ',
    },
  })}\n`);
  fake.child.stdout.write(`${JSON.stringify({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: '遗漏的原生过程事件。',
    },
  })}\n`);
  fake.child.stdout.write(`${JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'reasoning', id: 'reasoning-1', summary: [] },
    },
  })}\n`);
  fake.completeTurn();

  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasonings, ['正在核对 Discord bot 遗漏的原生过程事件。']);
  assert.deepEqual(
    events.filter((event) => event.type === 'reasoning.summary'),
    [{
      type: 'reasoning.summary',
      item_id: 'reasoning-1',
      text: '正在核对 Discord bot 遗漏的原生过程事件。',
    }],
  );
  assert.deepEqual(
    events.find((event) => event.type === 'turn.plan.updated'),
    {
      type: 'turn.plan.updated',
      explanation: '先定位事件链，再验证 Discord 输出。',
      plan: [
        { step: '定位事件链', status: 'completed' },
        { step: '验证 Discord 输出', status: 'inProgress' },
      ],
    },
  );
  assert.equal(
    events.some((event) => event.type === 'item.started' && event.item?.id === 'command-1'),
    true,
  );
  runner.closeAll('test done');
});

test('createCodexAppServerRunner reports when the main task needs user attention', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const events = [];
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: () => null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const resultPromise = runner.runTask({
    session: { provider: 'codex', mode: 'safe' },
    sessionKey: 'discord-thread-attention',
    workspaceDir: '/tmp/workspace',
    prompt: 'ask before continuing',
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  fake.child.stdout.write(`${JSON.stringify({
    id: 99,
    method: 'item/tool/requestUserInput',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  })}\n`);
  await waitFor(() => events.some((event) => event.type === 'turn.attention.required'));

  assert.deepEqual(events.find((event) => event.type === 'turn.attention.required'), {
    type: 'turn.attention.required',
    kind: 'input',
    thread_id: 'thread-1',
  });
  fake.completeTurn();
  await resultPromise;
  runner.closeAll('test done');
});

test('createCodexAppServerRunner promotes commentary output only for Codex goal continuation', async () => {
  const completedItems = [
    { type: 'agentMessage', id: 'item-1', text: '本地加严验收通过。', phase: 'commentary' },
    { type: 'agentMessage', id: 'item-2', text: 'completion audit 已经能闭环，现在把 goal 标成完成。', phase: 'commentary' },
  ];
  const makeRunner = (fake) => createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const goalFake = createFakeAppServerSpawn({ completedItems });
  const goalRunner = makeRunner(goalFake);
  const goalResult = await goalRunner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-goal',
    workspaceDir: '/tmp/workspace',
    prompt: `${CODEX_GOAL_CONTINUATION_PROMPT}\n\n[Via agents-in-discord; discord_thread=thread-1]`,
  });
  assert.deepEqual(goalResult.messages, ['本地加严验收通过。', 'completion audit 已经能闭环，现在把 goal 标成完成。']);
  assert.deepEqual(goalResult.finalAnswerMessages, ['本地加严验收通过。', 'completion audit 已经能闭环，现在把 goal 标成完成。']);
  goalRunner.closeAll('test done');

  const normalFake = createFakeAppServerSpawn({ completedItems });
  const normalRunner = makeRunner(normalFake);
  const normalResult = await normalRunner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-normal',
    workspaceDir: '/tmp/workspace',
    prompt: 'ordinary task',
  });
  assert.deepEqual(normalResult.messages, ['本地加严验收通过。', 'completion audit 已经能闭环，现在把 goal 标成完成。']);
  assert.deepEqual(normalResult.finalAnswerMessages, []);
  normalRunner.closeAll('test done');
});

test('createCodexAppServerRunner resumes an existing thread before starting a turn', async () => {
  const fake = createFakeAppServerSpawn();
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const result = await runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'existing-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello again',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), [
    'initialize',
    'initialized',
    'thread/resume',
    'turn/start',
  ]);
  assert.equal(JSON.parse(fake.writes.find((line) => JSON.parse(line).method === 'thread/resume')).params.threadId, 'existing-thread-1');
  runner.closeAll('test done');
});

test('createCodexAppServerRunner forks side thread as ephemeral and injects boundary items', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const parentRun = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'long parent task',
    systemPrompt: 'parent instructions',
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const result = await runner.forkSideThread({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    systemPrompt: 'different caller context',
    sideDeveloperInstructions: 'side rules',
    boundaryItems: [{ type: 'message', role: 'user', content: [] }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.parentThreadId, 'parent-thread-1');
  assert.equal(result.sideThreadId, 'side-thread-1');
  const methods = fake.writes.map((line) => JSON.parse(line).method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/resume', 'turn/start', 'thread/fork', 'thread/inject_items']);
  const forkRequest = fake.writes.map((line) => JSON.parse(line)).find((request) => request.method === 'thread/fork');
  assert.equal(forkRequest.params.threadId, 'parent-thread-1');
  assert.equal(forkRequest.params.ephemeral, true);
  assert.equal(forkRequest.params.approvalPolicy, 'never');
  assert.equal(forkRequest.params.approvalsReviewer, 'user');
  assert.equal(forkRequest.params.sandbox, 'read-only');
  assert.match(forkRequest.params.developerInstructions, /parent instructions/);
  assert.match(forkRequest.params.developerInstructions, /side rules/);
  const injectRequest = fake.writes.map((line) => JSON.parse(line)).find((request) => request.method === 'thread/inject_items');
  assert.equal(injectRequest.params.threadId, 'side-thread-1');
  assert.equal(injectRequest.params.items.length, 1);

  const sideRun = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'side-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'side hello',
    targetThreadId: 'side-thread-1',
  });
  await waitFor(() => fake.writes.filter((line) => JSON.parse(line).method === 'turn/start').length === 2);
  fake.completeTurn();
  const sideResult = await sideRun;
  assert.equal(sideResult.ok, true);
  assert.equal(sideResult.threadId, 'side-thread-1');
  fake.child.stdout.write(`${JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'side-thread-1', tokenUsage: { totalTokens: 1 } } })}\n`);
  await sleep(5);
  const turnRequest = fake.writes.map((line) => JSON.parse(line)).filter((request) => request.method === 'turn/start').pop();
  assert.equal(turnRequest.params.threadId, 'side-thread-1');
  assert.equal(runner.getSnapshot()[0].threadId, 'parent-thread-1');
  const cleanup = await runner.closeSideThread({
    sessionKey: 'discord-thread-1',
    threadId: 'side-thread-1',
  });
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.unsubscribed, true);
  assert.equal(cleanup.interrupted, false);
  assert.equal(fake.child.killed, false);
  assert.equal(runner.getSnapshot()[0].threadId, 'parent-thread-1');
  fake.child.stdout.write(`${JSON.stringify({
    method: 'turn/completed',
    params: { threadId: 'parent-thread-1', turn: { id: 'turn-parent', status: 'completed' } },
  })}\n`);
  await parentRun;
  runner.closeAll('test done');
});

test('createCodexAppServerRunner refuses a side fork when the parent task is not running', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  await assert.rejects(
    runner.forkSideThread({
      session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
      sessionKey: 'discord-thread-1',
      workspaceDir: '/tmp/workspace',
    }),
    /main Codex task is no longer running/,
  );
  assert.deepEqual(fake.calls, []);
});

test('createCodexAppServerRunner runs parent and side turns concurrently without mixing output', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const parentRun = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'long parent task',
  });
  await waitFor(() => fake.writes.filter((line) => JSON.parse(line).method === 'turn/start').length === 1);

  const fork = await runner.forkSideThread({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
  });
  const sideRun = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: fork.sideThreadId },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'read-only side question',
    targetThreadId: fork.sideThreadId,
  });
  await waitFor(() => fake.writes.filter((line) => JSON.parse(line).method === 'turn/start').length === 2);
  assert.equal(runner.getSnapshot()[0].activeTurnCount, 2);

  fake.child.stdout.write(`${JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'side-thread-1',
      turnId: 'turn-side',
      item: { type: 'agentMessage', id: 'side-answer', text: 'side answer', phase: 'final_answer' },
    },
  })}\n`);
  fake.child.stdout.write(`${JSON.stringify({
    method: 'turn/completed',
    params: { threadId: 'side-thread-1', turn: { id: 'turn-side', status: 'completed' } },
  })}\n`);
  const sideResult = await sideRun;
  assert.deepEqual(sideResult.finalAnswerMessages, ['side answer']);
  assert.equal(runner.getSnapshot()[0].activeTurnCount, 1);

  fake.child.stdout.write(`${JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'parent-thread-1',
      turnId: 'turn-parent',
      item: { type: 'agentMessage', id: 'parent-answer', text: 'parent answer', phase: 'final_answer' },
    },
  })}\n`);
  fake.child.stdout.write(`${JSON.stringify({
    method: 'turn/completed',
    params: { threadId: 'parent-thread-1', turn: { id: 'turn-parent', status: 'completed' } },
  })}\n`);
  const parentResult = await parentRun;
  assert.deepEqual(parentResult.finalAnswerMessages, ['parent answer']);
  assert.equal(parentResult.finalAnswerMessages.includes('side answer'), false);
  runner.closeAll('test done');
});

test('createCodexAppServerRunner unsubscribes side thread when boundary injection fails', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false, failInject: true });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const parentRun = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'long parent task',
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  await assert.rejects(
    () => runner.forkSideThread({
      session: { provider: 'codex', mode: 'safe', runnerSessionId: 'parent-thread-1' },
      sessionKey: 'discord-thread-1',
      workspaceDir: '/tmp/workspace',
      boundaryItems: [{ type: 'message', role: 'user', content: [] }],
    }),
    /inject failed; side thread unsubscribed/,
  );
  const requests = fake.writes.map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), [
    'initialize',
    'initialized',
    'thread/resume',
    'turn/start',
    'thread/fork',
    'thread/inject_items',
    'thread/unsubscribe',
  ]);
  assert.equal(requests.at(-1).params.threadId, 'side-thread-1');
  fake.completeTurn();
  await parentRun;
  runner.closeAll('test done');
});

test('createCodexAppServerRunner interrupts and unsubscribes active side thread before closing', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: null }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: null }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const run = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'side-thread-1' },
    sessionKey: 'side-channel-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'side question',
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const cleanup = await runner.closeSideThread({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'side-thread-1' },
    sessionKey: 'side-channel-1',
    threadId: 'side-thread-1',
  });

  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.interrupted, true);
  assert.equal(cleanup.unsubscribed, true);
  const methods = fake.writes.map((line) => JSON.parse(line).method);
  assert.deepEqual(methods.slice(-2), ['turn/interrupt', 'thread/unsubscribe']);
  const result = await run;
  assert.equal(result.ok, false);
});

test('createCodexAppServerRunner steers an active Codex turn', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false });
  const events = [];
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const run = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'start',
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const steer = await runner.steerTask({
    sessionKey: 'discord-thread-1',
    prompt: 'adjust current work',
  });
  assert.deepEqual(steer, {
    ok: true,
    steered: true,
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
  const steerRequest = fake.writes.map((line) => JSON.parse(line)).find((request) => request.method === 'turn/steer');
  assert.equal(steerRequest.params.threadId, 'thread-1');
  assert.equal(steerRequest.params.expectedTurnId, 'turn-1');
  assert.deepEqual(steerRequest.params.input, [{ type: 'text', text: 'adjust current work', text_elements: [] }]);
  assert.equal(events.some((event) => event.type === 'turn.steer'), true);

  fake.completeTurn();
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(result.meta.steerCount, 1);
});

test('createCodexAppServerRunner reports failed steer without completing the active turn', async () => {
  const fake = createFakeAppServerSpawn({ autoComplete: false, failSteer: true });
  const runner = createCodexAppServerRunner({
    spawnEnv: { HOME: '/tmp/home' },
    getProviderBin: () => 'codex-test',
    getSessionId: (session) => session.runnerSessionId || null,
    resolveModelSetting: () => ({ value: 'gpt-5.5' }),
    resolveCodexProfileSetting: () => ({ value: null, isExplicit: false, valid: true }),
    resolveReasoningEffortSetting: () => ({ value: 'high' }),
    resolveFastModeSetting: () => ({ enabled: false, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    idleMs: 0,
    spawnFn: fake.spawnFn,
    log: () => {},
  });

  const run = runner.runTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: null },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'start',
  });
  await waitFor(() => fake.writes.some((line) => JSON.parse(line).method === 'turn/start'));

  const steer = await runner.steerTask({
    sessionKey: 'discord-thread-1',
    prompt: 'adjust current work',
  });
  assert.equal(steer.ok, false);
  assert.equal(steer.steered, false);
  assert.equal(steer.reason, 'steer_failed');
  assert.match(steer.error, /cannot steer a review turn/);

  fake.completeTurn();
  const result = await run;
  assert.equal(result.ok, true);
  assert.match(result.logs.join('\n'), /cannot steer a review turn/);
});
