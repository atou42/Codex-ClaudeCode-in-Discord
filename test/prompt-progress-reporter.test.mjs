import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProgressEventDedupeKey,
  createProgressEventDeduper,
} from '../src/codex-event-utils.js';
import { createPromptProgressReporterFactory } from '../src/prompt-progress-reporter.js';
import { createRuntimePresentation } from '../src/runtime-presentation.js';

function clonePlan(plan) {
  return plan ? JSON.parse(JSON.stringify(plan)) : null;
}

function appendUnique(list, value) {
  const text = String(value || '').trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function createRealPresentation() {
  return createRuntimePresentation({
    showReasoning: false,
    progressTextPreviewChars: 120,
    progressDoneStepsMax: 4,
    progressActivityMaxLines: 5,
    progressProcessLines: 5,
    humanAge: (ms) => `${ms}ms`,
    getSessionId: (session) => session?.runnerSessionId || null,
    getSessionProvider: (session) => session?.provider || 'codex',
    formatSessionIdLabel: (sessionId) => `\`${sessionId || 'auto'}\``,
  });
}

function createHarness(overrides = {}) {
  let currentNow = 10_000;
  const sent = [];
  const edits = [];
  const streamed = [];
  const intervals = [];
  const cleared = [];
  const channelState = {
    queue: ['queued-1'],
    activeRun: {
      phase: 'workspace',
      progressPlan: null,
      completedSteps: [],
      recentActivities: [],
    },
  };
  const message = { id: 'msg-1', author: { id: '12345' } };

  const createProgressReporter = createPromptProgressReporterFactory({
    defaultUiLanguage: 'zh',
    progressUpdatesEnabled: true,
    progressProcessLines: 2,
    progressUpdateIntervalMs: 5000,
    progressEventFlushMs: 0,
    progressEventDedupeWindowMs: 2500,
    progressIncludeStdout: true,
    progressIncludeStderr: false,
    progressTextPreviewChars: 120,
    progressProcessPushIntervalMs: 1000,
    progressMessageMaxChars: 1800,
    progressPlanMaxLines: 4,
    progressDoneStepsMax: 4,
    safeReply: async (_message, body) => {
      sent.push(body);
      return {
        id: 'progress-1',
        async edit(nextBody) {
          edits.push(nextBody);
        },
      };
    },
    normalizeUiLanguage: (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
    slashRef: (name) => `/bot-${name}`,
    resolveModelSetting: (session) => ({
      value: session?.model || 'gpt-5.4',
      source: session?.model ? 'session override' : 'config.toml',
    }),
    resolveReasoningEffortSetting: (session) => ({
      value: session?.effort || 'high',
      source: session?.effort ? 'session override' : 'config.toml',
    }),
    resolveFastModeSetting: (session) => ({
      enabled: Boolean(session?.fastMode),
      supported: session?.provider === 'codex',
      source: session?.fastMode ? 'session override' : 'config.toml',
    }),
    truncate: (text, max) => {
      const value = String(text || '');
      return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
    },
    humanElapsed: (ms) => `${ms}ms`,
    createProgressEventDeduper,
    buildProgressEventDedupeKey,
    presentation: {
      summarizeCodexEvent: (event) => event.summaryStep || '',
      extractRawProgressTextFromEvent: (event) => event.rawActivity || '',
      cloneProgressPlan: clonePlan,
      extractPlanStateFromEvent: (event) => clonePlan(event.planState),
      extractCompletedStepFromEvent: (event) => event.completedStep || '',
      appendCompletedStep: appendUnique,
      appendRecentActivity: appendUnique,
      formatProgressPlanSummary: (planState) => JSON.stringify(planState?.steps || []),
      renderProcessContentLines: (activities, _language, count) => (
        activities.slice(-count).map((line) => `process: ${line}`)
      ),
      localizeProgressLines: (lines) => lines,
      renderProgressPlanLines: (planState) => (
        Array.isArray(planState?.steps) && planState.steps.length
          ? [`plan: ${planState.steps.length}`]
          : []
      ),
      renderCompletedStepsLines: (steps) => steps.map((step) => `done: ${step}`),
      formatRuntimePhaseLabel: (phase) => String(phase || ''),
    },
    now: () => currentNow,
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle);
    },
    onStreamProcessMessage: async (text) => {
      streamed.push(text);
    },
    ...overrides.factoryOptions,
  });

  return {
    sent,
    edits,
    streamed,
    intervals,
    cleared,
    channelState,
    message,
    reporter: createProgressReporter({
      message,
      channelState,
      session: overrides.session || { provider: 'codex', fastMode: true },
      language: overrides.language || 'en',
      initialLatestStep: overrides.initialLatestStep || 'Waiting for workspace lock: /repo/demo',
    }),
    advance(ms) {
      currentNow += ms;
    },
  };
}

test('createPromptProgressReporterFactory seeds initial step and updates final progress card', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  assert.match(harness.sent[0].content, /Waiting for workspace lock: \/repo\/demo/);
  assert.deepEqual(harness.sent[0].components, []);
  assert.match(harness.sent[0].content, /effort: high/);
  assert.match(harness.sent[0].content, /fast mode: on \(this channel\)/);
  assert.match(harness.sent[0].content, /!c/);
  assert.doesNotMatch(harness.sent[0].content, /\/bot-status/);
  assert.doesNotMatch(harness.sent[0].content, /!cancel/);
  assert.equal(harness.channelState.activeRun.lastProgressText, 'Waiting for workspace lock: /repo/demo');
  assert.equal(harness.channelState.activeRun.progressMessageId, 'progress-1');

  harness.channelState.activeRun.phase = 'exec';
  harness.advance(50);
  harness.reporter.setLatestStep('Workspace lock acquired: /repo/demo');
  assert.match(harness.edits[0].content, /Workspace lock acquired: \/repo\/demo/);
  assert.deepEqual(harness.edits[0].components, []);

  await harness.reporter.finish({ ok: true });
  assert.match(harness.edits[harness.edits.length - 1].content, /✅ \*\*Task Completed\*\*/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• phase: done/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• latest activity: Final response sent/);
  assert.deepEqual(harness.edits[harness.edits.length - 1].components, []);
  assert.equal(harness.channelState.activeRun.phase, 'done');
  // card refresh, process-activity push, turn-marker heartbeat
  assert.equal(harness.cleared.length, 3);
});

test('createPromptProgressReporterFactory shows the side button only while running and notifies once for attention', async () => {
  const attentionEvents = [];
  const runningComponents = [{ type: 1, components: [{ type: 2, custom_id: 'cxs:ask:thread-1' }] }];
  const harness = createHarness({
    factoryOptions: {
      buildRunningTaskComponents: () => runningComponents,
      onParentAttention: async (input) => {
        attentionEvents.push(input.event);
      },
    },
  });

  await harness.reporter.start();
  assert.deepEqual(harness.sent[0].components, runningComponents);

  harness.reporter.onEvent({ type: 'turn.attention.required', kind: 'input' });
  harness.reporter.onEvent({ type: 'turn.attention.required', kind: 'approval' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attentionEvents, [{ type: 'turn.attention.required', kind: 'input' }]);

  await harness.reporter.finish({ ok: true });
  assert.deepEqual(harness.edits.at(-1).components, []);
});

test('createPromptProgressReporterFactory dedupes repeated events and keeps activity on the final card', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  const planState = {
    steps: [
      { step: 'Inspect code', status: 'completed' },
      { step: 'Edit code', status: 'in_progress' },
    ],
  };

  harness.reporter.onEvent({
    summaryStep: 'Searching files',
    rawActivity: 'rg src',
    planState,
  });
  harness.reporter.onEvent({
    summaryStep: 'Searching files',
    rawActivity: 'rg src',
    planState,
  });
  harness.reporter.onEvent({
    summaryStep: 'Updating tests',
    rawActivity: 'rg test',
    completedStep: 'Patch orchestrator',
  });

  assert.equal(harness.channelState.activeRun.progressEvents, 2);
  assert.deepEqual(harness.channelState.activeRun.completedSteps, ['Inspect code', 'Patch orchestrator']);
  assert.deepEqual(harness.channelState.activeRun.recentActivities, ['rg src', 'rg test']);

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /process: rg src/);
  assert.match(finalCard, /process: rg test/);
  assert.match(finalCard, /done: Inspect code/);
  assert.match(finalCard, /done: Patch orchestrator/);
});

test('createPromptProgressReporterFactory can stream deduped process messages while keeping the progress card', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    summaryStep: 'Inspecting repo',
    rawActivity: '我先检查一下这个仓库的入口文件。',
  });
  harness.reporter.onEvent({
    summaryStep: 'Inspecting repo',
    rawActivity: '我先检查一下这个仓库的入口文件。',
  });
  harness.advance(1200);
  harness.intervals.find((handle) => handle.ms === 1000)?.fn();

  assert.deepEqual(harness.streamed, ['我先检查一下这个仓库的入口文件。']);
  assert.match(harness.edits.at(-1).content, /process: 我先检查一下这个仓库的入口文件。/);
});

test('createPromptProgressReporterFactory turns OMP token deltas into readable stage messages', async () => {
  const harness = createHarness({
    session: { provider: 'omp' },
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  for (const delta of ['Using', ' agent', '-browser', ' to', ' inspect', ' the', ' live', ' site.']) {
    harness.reporter.onEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta },
    });
  }

  assert.deepEqual(harness.streamed, []);
  assert.equal(harness.channelState.activeRun.progressEvents, 0);

  harness.reporter.onEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Using agent-browser to inspect the live site.' },
        { type: 'toolCall', name: 'browser', arguments: { url: 'https://writes.atou.cc/' } },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.streamed, ['Using agent-browser to inspect the live site.']);
  assert.equal(harness.channelState.activeRun.progressEvents, 1);

  harness.reporter.onEvent({
    type: 'tool_execution_start',
    toolName: 'browser',
    args: { url: 'https://writes.atou.cc/' },
    intent: 'Inspecting the live site and repository workflow',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.streamed, ['Using agent-browser to inspect the live site.']);
  assert.match(harness.edits.at(-1).content, /latest activity: Inspecting the live site and repository workflow/);
  assert.doesNotMatch(harness.edits.at(-1).content, /latest activity: browser:/);

  harness.reporter.onEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'The site is healthy and the workflow is documented.' }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.streamed, ['Using agent-browser to inspect the live site.']);
});

test('createPromptProgressReporterFactory streams Codex command executions', async () => {
  const harness = createHarness({
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'item.completed',
    item: {
      id: 'item_42',
      type: 'command_execution',
      command: '/bin/zsh -lc "cohub search \'progress visibility\'"',
      aggregated_output: 'search results',
      exit_code: 0,
      status: 'completed',
    },
  });

  // Commands stay on the card and out of the thread. Streaming them put one
  // Discord message per command in front of the user — 179 tool calls against 3
  // agent messages in one observed session — which buried the task-level signal
  // a new thread message is supposed to carry.
  assert.deepEqual(harness.streamed, []);
  assert.deepEqual(harness.channelState.activeRun.recentActivities, ['search Cohub context']);
  assert.match(harness.edits.at(-1).content, /latest activity: command completed: search Cohub context/);
  assert.match(harness.edits.at(-1).content, /process content:/);

  // A later command pushes the earlier one down into completed milestones, so
  // tool progress stays readable without ever entering the narration stream.
  harness.reporter.onEvent({
    type: 'item.completed',
    item: {
      id: 'item_44',
      type: 'command_execution',
      command: '/bin/zsh -lc "lark-cli auth status"',
      aggregated_output: 'ok',
      exit_code: 0,
      status: 'completed',
    },
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.streamed, []);
  assert.match(harness.edits.at(-1).content, /latest activity: command completed: check Lark connection/);
  assert.match(harness.edits.at(-1).content, /process content:/);
});

test('createPromptProgressReporterFactory streams failed Codex commands', async () => {
  const harness = createHarness({
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'item.completed',
    item: {
      id: 'item_43',
      type: 'command_execution',
      command: '/bin/zsh -lc "npm test"',
      aggregated_output: 'AssertionError: expected 1 to equal 2',
      exit_code: 1,
      status: 'completed',
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  // A failure is usually followed by a retry of the same command, so streaming
  // it doubled the noise without adding a task-level signal. The card still
  // carries it on the latest-activity line.
  assert.deepEqual(harness.streamed, []);
  assert.match(harness.edits.at(-1).content, /latest activity: command failed/);
});

test('createPromptProgressReporterFactory streams Codex narration around a failing command', async () => {
  const harness = createHarness({
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  // Codex agent_message events carry no phase marker, so narration is buffered
  // until a work event proves the agent acted on it.
  harness.reporter.onEvent({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: '先确认这个命令是否存在。' },
  });
  assert.deepEqual(harness.streamed, []);

  harness.reporter.onEvent({
    type: 'item.started',
    item: {
      id: 'item_2',
      type: 'command_execution',
      command: "/bin/zsh -lc 'use Cohub'",
      exit_code: null,
      status: 'in_progress',
    },
  });
  harness.reporter.onEvent({
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'command_execution',
      command: "/bin/zsh -lc 'use Cohub'",
      aggregated_output: 'zsh:1: command not found: use',
      exit_code: 127,
      status: 'completed',
    },
  });

  // Narration reaches the channel; the command and its failure do not.
  assert.deepEqual(harness.streamed, ['先确认这个命令是否存在。']);
});

test('createPromptProgressReporterFactory streams native Codex reasoning summaries', async () => {
  const harness = createHarness({
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'reasoning.summary',
    item_id: 'reasoning-1',
    text: '正在核对 Discord bot 遗漏的原生过程事件。',
  });

  assert.deepEqual(harness.streamed, ['正在核对 Discord bot 遗漏的原生过程事件。']);
  assert.deepEqual(
    harness.channelState.activeRun.recentActivities,
    ['正在核对 Discord bot 遗漏的原生过程事件。'],
  );
  assert.match(
    harness.edits.at(-1).content,
    /正在核对 Discord bot 遗漏的原生过程事件。/,
  );
});

test('createPromptProgressReporterFactory streams unphased Codex 0.144 commentary only after work continues', async () => {
  const harness = createHarness({
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'agent_message',
      text: '准备检查当前目录的位置和其中的文件、文件夹，全程只读。',
    },
  });

  assert.deepEqual(harness.streamed, []);

  harness.reporter.onEvent({
    type: 'item.started',
    item: {
      id: 'item_3',
      type: 'command_execution',
      command: "/bin/zsh -lc 'pwd && ls'",
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    },
  });

  assert.deepEqual(harness.streamed, ['准备检查当前目录的位置和其中的文件、文件夹，全程只读。']);
  assert.deepEqual(harness.channelState.activeRun.recentActivities.slice(0, 1), [
    '准备检查当前目录的位置和其中的文件、文件夹，全程只读。',
  ]);

  harness.reporter.onEvent({
    type: 'item.completed',
    item: {
      id: 'item_4',
      type: 'agent_message',
      text: '当前目录是 `/private/tmp`。只读检查完成。',
    },
  });
  harness.reporter.onEvent({
    type: 'turn.completed',
    usage: { input_tokens: 100, output_tokens: 20 },
  });

  assert.doesNotMatch(
    harness.channelState.activeRun.recentActivities.join('\n'),
    /当前目录是 `\/private\/tmp`。只读检查完成。/,
  );
});

test('createPromptProgressReporterFactory streams during the run without dumping backlog on finish', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    summaryStep: 'Step 1',
    rawActivity: '过程消息 1',
  });
  harness.reporter.onEvent({
    summaryStep: 'Step 2',
    rawActivity: '过程消息 2',
  });
  harness.reporter.onEvent({
    summaryStep: 'Step 3',
    rawActivity: '过程消息 3',
  });

  assert.deepEqual(harness.streamed, ['过程消息 1']);
  assert.deepEqual(harness.channelState.activeRun.recentActivities, ['过程消息 1', '过程消息 2', '过程消息 3']);

  await new Promise((resolve) => setImmediate(resolve));
  harness.advance(1200);
  harness.intervals.find((handle) => handle.ms === 1000)?.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.streamed, ['过程消息 1', '过程消息 2']);

  await harness.reporter.finish({ ok: true });

  assert.deepEqual(harness.streamed, ['过程消息 1', '过程消息 2']);
  assert.match(harness.edits.at(-1).content, /process: 过程消息 3/);
});

test('createPromptProgressReporterFactory retries a process message after a transient send failure', async () => {
  const delivered = [];
  let attempts = 0;
  const harness = createHarness({
    factoryOptions: {
      onStreamProcessMessage: async (text) => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary Discord send failure');
        delivered.push(text);
      },
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    summaryStep: 'Inspecting repo',
    rawActivity: '过程消息需要重试',
  });
  await new Promise((resolve) => setImmediate(resolve));

  harness.advance(1200);
  harness.intervals.find((handle) => handle.ms === 1000)?.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
  assert.deepEqual(delivered, ['过程消息需要重试']);
});

test('createPromptProgressReporterFactory settles and retries an in-flight process message before finish', async () => {
  let attempts = 0;
  let rejectFirstAttempt = null;
  const delivered = [];
  const harness = createHarness({
    factoryOptions: {
      onStreamProcessMessage: async (text) => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise((_resolve, reject) => {
            rejectFirstAttempt = reject;
          });
          return;
        }
        delivered.push(text);
      },
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    summaryStep: 'Inspecting repo',
    rawActivity: '结束前仍在发送的过程消息',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const finishPromise = harness.reporter.finish({ ok: true });
  rejectFirstAttempt(new Error('temporary Discord send failure'));
  await finishPromise;

  assert.equal(attempts, 2);
  assert.deepEqual(delivered, ['结束前仍在发送的过程消息']);
});

test('createPromptProgressReporterFactory ignores stderr when disabled and keeps stdout progress', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onLog('warning', 'stderr');
  assert.equal(harness.channelState.activeRun.progressEvents, 0);

  harness.reporter.onLog('stdout line', 'stdout');
  assert.equal(harness.channelState.activeRun.progressEvents, 1);
  assert.equal(harness.channelState.activeRun.lastProgressText, 'stdout: stdout line');
  assert.match(harness.edits[harness.edits.length - 1].content, /stdout: stdout line/);
});

test('createPromptProgressReporterFactory truncates overflowing cards on line boundaries', async () => {
  const harness = createHarness({
    factoryOptions: {
      progressMessageMaxChars: 70,
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({ summaryStep: 'Locate regression', rawActivity: 'inspect dispatcher' });
  harness.reporter.onEvent({ summaryStep: 'Inspect renderer', rawActivity: 'inspect renderer' });
  harness.reporter.onEvent({ summaryStep: 'Inspect bridge', rawActivity: 'inspect bridge' });
  harness.reporter.onEvent({ summaryStep: 'Patch tests', rawActivity: 'patch tests' });

  const runningCard = harness.edits[harness.edits.length - 1].content;
  assert.match(runningCard, /\n\.\.\.$/);

  await harness.reporter.finish({ ok: true });
  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /\n\.\.\.$/);
});

test('createPromptProgressReporterFactory includes model line in running and final cards', async () => {
  const harness = createHarness({
    session: {
      provider: 'codex',
      model: 'gpt-5.3-codex',
    },
    factoryOptions: {
      resolveModelSetting: (session) => ({
        value: session?.model,
        source: session?.model ? 'session override' : 'provider',
      }),
    },
  });

  await harness.reporter.start();
  await harness.reporter.finish({ ok: true });

  assert.match(harness.sent[0].content, /• model: `gpt-5\.3-codex` \(session override\)/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• model: `gpt-5\.3-codex` \(session override\)/);
});

test('createPromptProgressReporterFactory replaces requested Claude model with the observed runtime model', async () => {
  const session = {
    provider: 'claude',
    model: 'opus',
  };
  const harness = createHarness({
    session,
    factoryOptions: {
      resolveModelSetting: (currentSession) => ({
        value: currentSession?.model,
        source: currentSession?.model ? 'session override' : 'provider',
      }),
    },
  });

  await harness.reporter.start();
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
    },
  });
  await harness.reporter.finish({ ok: true });

  assert.equal(session.lastObservedModel, 'claude-opus-5');
  assert.match(harness.edits[harness.edits.length - 1].content, /• model: `claude-opus-5` \(runtime observed\)/);
  assert.doesNotMatch(harness.edits[harness.edits.length - 1].content, /• model: `opus`/);
});

test('createPromptProgressReporterFactory shows the observed ZCode model from progress events', async () => {
  const session = {
    provider: 'zcode',
    model: null,
  };
  const harness = createHarness({ session });

  await harness.reporter.start();
  harness.reporter.onEvent({
    type: 'tool_execution_start',
    model: 'GLM-5.3',
    toolName: 'Read',
    args: { description: 'Read project overview' },
  });
  await harness.reporter.finish({ ok: true });

  assert.equal(session.lastObservedModel, 'GLM-5.3');
  assert.match(harness.edits[harness.edits.length - 1].content, /• model: `GLM-5\.3` \(runtime observed\)/);
  assert.match(harness.edits[harness.edits.length - 1].content, /event count: 1/);
});

test('createPromptProgressReporterFactory shows Grok tool lifecycle and observed model', async () => {
  const session = {
    provider: 'grok',
    model: null,
  };
  const harness = createHarness({
    session,
    factoryOptions: {
      presentation: createRealPresentation(),
      resolveModelSetting: () => ({ value: null, source: 'provider' }),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'tool_call',
    toolCallId: 'call-grok-1',
    toolName: 'run_terminal_command',
    status: 'pending',
    rawInput: { command: 'pwd', description: 'Inspect current directory' },
  });
  harness.reporter.onEvent({
    type: 'tool_call_update',
    toolCallId: 'call-grok-1',
    status: 'completed',
  });
  harness.reporter.onEvent({
    type: 'end',
    stopReason: 'end_turn',
    modelUsage: {
      'grok-4.6-build': { inputTokens: 20, outputTokens: 5 },
    },
  });
  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits.at(-1).content;
  assert.equal(session.lastObservedModel, 'grok-4.6-build');
  assert.match(finalCard, /• model: `grok-4\.6-build` \(runtime observed\)/);
  assert.match(finalCard, /Inspect current directory/);
  assert.doesNotMatch(finalCard, /tool run_terminal_command/);
  assert.match(finalCard, /Task Completed/);
});

test('createPromptProgressReporterFactory streams Grok pre-tool narration without exposing thought events', async () => {
  const harness = createHarness({
    session: { provider: 'grok', model: null },
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'thought',
    data: 'The user wants me to inspect the related context before answering.',
  });
  harness.reporter.onEvent({ type: 'text', data: '先把 Codex 会话、个人 wiki ' });
  harness.reporter.onEvent({ type: 'text', data: '和组织上下文对上，确认 agents weekly 实际在做什么。' });

  assert.deepEqual(harness.streamed, []);

  harness.reporter.onEvent({
    type: 'tool_call',
    toolCallId: 'call-grok-read-1',
    toolName: 'read_file',
    title: 'Read',
    kind: 'read',
    status: 'in_progress',
    rawInput: {
      target_file: '/Users/atou/personal-wiki/_meta/index.md',
      limit: 150,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.streamed, [
    '先把 Codex 会话、个人 wiki 和组织上下文对上，确认 agents weekly 实际在做什么。',
  ]);
  assert.doesNotMatch(harness.edits.at(-1).content, /latest activity: thought/);
  assert.doesNotMatch(harness.edits.at(-1).content, /process content:\n\s+· thought/);
  assert.match(harness.edits.at(-1).content, /personal-wiki\/_meta\/index\.md/);

  harness.reporter.onEvent({
    type: 'tool_call_update',
    toolCallId: 'call-grok-read-1',
    status: 'completed',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(harness.edits.at(-1).content, /tool read_file/);

  harness.reporter.onEvent({ type: 'text', data: '这是最终回答，不应进入过程消息。' });
  harness.reporter.onEvent({
    type: 'end',
    stopReason: 'end_turn',
    sessionId: 'grok-session-real-shape',
  });
  await harness.reporter.finish({ ok: true });

  assert.deepEqual(harness.streamed, [
    '先把 Codex 会话、个人 wiki 和组织上下文对上，确认 agents weekly 实际在做什么。',
  ]);
});

test('createPromptProgressReporterFactory enriches Grok tools from update metadata and exposes failures', async () => {
  const harness = createHarness({
    session: { provider: 'grok', model: null },
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'tool_call',
    toolCallId: 'call-grok-shell-1',
    title: 'run_terminal_command',
    status: 'pending',
    rawInput: {},
  });
  harness.reporter.onEvent({
    type: 'tool_call_update',
    toolCallId: 'call-grok-shell-1',
    title: 'Execute `npm test`',
    kind: 'execute',
    rawInput: {
      variant: 'Bash',
      command: 'npm test',
      description: 'Run the project test suite',
    },
  });
  harness.reporter.onEvent({
    type: 'tool_call_update',
    toolCallId: 'call-grok-shell-1',
    status: 'failed',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const card = harness.edits.at(-1).content;
  assert.match(card, /Run the project test suite/);
  assert.match(card, /failed/);
  assert.doesNotMatch(card, /tool run_terminal_command/);
  assert.deepEqual(harness.streamed, []);
});

test('createPromptProgressReporterFactory ignores unknown and known low-signal Grok events', async () => {
  const harness = createHarness({
    session: { provider: 'grok', model: null },
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({ type: 'available_commands', tools: [], commands: [] });
  harness.reporter.onEvent({ type: 'usage', stopReason: 'tool_use', usage: { input_tokens: 10 } });
  harness.reporter.onEvent({ type: 'phase_changed', phase: 'waiting_for_model' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.channelState.activeRun.progressEvents, 0);
  assert.deepEqual(harness.channelState.activeRun.recentActivities, []);
  assert.deepEqual(harness.streamed, []);
  assert.deepEqual(harness.edits, []);
});

test('createPromptProgressReporterFactory shows resolved default model instead of provider default text', async () => {
  const harness = createHarness({
    session: {
      provider: 'codex',
    },
  });

  await harness.reporter.start();

  assert.match(harness.sent[0].content, /• model: `gpt-5\.4` \(config\.toml\)/);
  assert.doesNotMatch(harness.sent[0].content, /provider default|provider 默认/);
});

test('createPromptProgressReporterFactory derives Claude commentary and tool progress from stream events', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'message_start',
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: '我来查看',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: '当前目录。',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 0,
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'call_pwd',
        name: 'Bash',
        input: {},
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"command":"pwd","description":"Show current working directory"}',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 1,
    },
  });
  harness.reporter.onEvent({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: 'tool_use',
      },
    },
  });
  harness.reporter.onEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_pwd',
          content: '/tmp/demo',
        },
      ],
    },
  });

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  // Claude often emits no narration between tool calls, so both its commentary
  // and its tool label belong in the process stream.
  assert.match(finalCard, /process: 我来查看当前目录。/);
  assert.match(finalCard, /process: Show current working directory/);
  assert.match(finalCard, /done: Show current working directory/);
});

test('createPromptProgressReporterFactory derives Claude progress from assistant snapshots when stream events are absent', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-a',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: '我先用 ls 看一下当前目录。' }],
    },
  });
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-a',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'toolu_ls',
        name: 'Bash',
        input: { command: 'ls -la', description: 'List current directory' },
      }],
    },
  });
  harness.reporter.onEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.txt' }],
    },
  });
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-b',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '最终答案：目录里有 a.txt。' }],
    },
  });

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /process: 我先用 ls 看一下当前目录。/);
  assert.match(finalCard, /process: List current directory/);
  assert.match(finalCard, /done: List current directory/);
  assert.doesNotMatch(finalCard, /最终答案/);
});

test('createPromptProgressReporterFactory streams Claude tool snapshots into the thread', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-tool-only',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'toolu_ls',
        name: 'Bash',
        input: { command: 'ls -la', description: 'List current directory' },
      }],
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.streamed, ['List current directory']);
  await harness.reporter.finish({ ok: true });
});

test('createPromptProgressReporterFactory does not duplicate Claude progress when assistant snapshots repeat', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
    factoryOptions: {
      progressEventDedupeWindowMs: 0,
      createProgressEventDeduper: () => () => false,
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  const toolSnapshot = {
    type: 'assistant',
    message: {
      id: 'msg-a',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'toolu_dup',
        name: 'Bash',
        input: { command: 'pwd', description: 'Show working directory' },
      }],
    },
  };
  harness.reporter.onEvent(toolSnapshot);
  harness.reporter.onEvent(toolSnapshot);
  const toolResult = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_dup', content: '/tmp' }],
    },
  };
  harness.reporter.onEvent(toolResult);
  harness.reporter.onEvent(toolResult);

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  const processMatches = finalCard.match(/process: Show working directory/g) || [];
  assert.equal(processMatches.length, 1);
  const doneMatches = finalCard.match(/done: Show working directory/g) || [];
  assert.equal(doneMatches.length, 1);
  assert.deepEqual(harness.streamed, ['Show working directory']);
});

test('createPromptProgressReporterFactory keeps Claude narration on the latest activity line through a tool burst', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
    factoryOptions: {
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-a',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: '先把三个来源并行拉一遍。' }],
    },
  });

  for (let index = 0; index < 5; index += 1) {
    harness.reporter.onEvent({
      type: 'assistant',
      message: {
        id: `msg-tool-${index}`,
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          id: `toolu_${index}`,
          name: 'Bash',
          input: { command: `echo ${index}`, description: `Fetch source ${index}` },
        }],
      },
    });
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.edits.at(-1).content, /latest activity: agent message: 先把三个来源并行拉一遍。/);

  // Once the narration is stale, mechanical tool labels may take the line again
  // so it never looks frozen mid-run.
  harness.advance(31_000);
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-tool-late',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'toolu_late',
        name: 'Bash',
        input: { command: 'echo late', description: 'Fetch final source' },
      }],
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.edits.at(-1).content, /latest activity: Fetch final source/);
});

test('createPromptProgressReporterFactory ignores Claude assistant snapshots once stream events are active', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'stream_event',
    event: { type: 'message_start' },
  });
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-a',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: '流模式下的快照解说。' }],
    },
  });

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.doesNotMatch(finalCard, /process: 流模式下的快照解说。/);
});

test('createPromptProgressReporterFactory does not let Claude system noise hide API errors', async () => {
  const harness = createHarness({
    session: { provider: 'claude' },
    factoryOptions: {
      presentation: createRealPresentation(),
      progressProcessLines: 5,
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
  });
  assert.equal(harness.channelState.activeRun.lastProgressText, 'Waiting for workspace lock: /repo/demo');

  // Fresh narration normally holds the line; an API error must still displace it.
  harness.reporter.onEvent({
    type: 'assistant',
    message: {
      id: 'msg-narration',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: '继续拉取剩下的材料。' }],
    },
  });
  assert.equal(harness.channelState.activeRun.lastProgressText, 'agent message: 继续拉取剩下的材料。');

  harness.reporter.onEvent({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'API Error: 429 {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"},"request_id":"req_123"}',
      }],
    },
  });

  assert.equal(harness.channelState.activeRun.lastProgressText, 'API error 429: 您的账户已达到速率限制，请您控制请求频率');
  await new Promise((resolve) => setImmediate(resolve));
  const runningCard = harness.edits[harness.edits.length - 1].content;
  assert.match(runningCard, /latest activity: API error 429: 您的账户已达到速率限制，请您控制请求频率/);
  assert.doesNotMatch(runningCard, /latest activity: system/);
});

test('createPromptProgressReporterFactory renders codex subagent lifecycle events on the live card', async () => {
  const harness = createHarness({
    factoryOptions: {
      progressProcessLines: 5,
      presentation: createRealPresentation(),
    },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({
        agent_type: 'worker',
        message: 'Verify the Discord progress card shows sub tasks in real time.',
      }),
      call_id: 'call_spawn_1',
    },
  });
  assert.match(harness.edits[0].content, /subagent worker starting: Verify the Discord progress card shows sub tasks in real time\./);

  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_spawn_1',
      output: JSON.stringify({
        agent_id: '019d5809-05fe-7b90-a4d5-c76249a0be23',
        nickname: 'Harvey',
      }),
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'send_input',
      arguments: JSON.stringify({
        target: '019d5809-05fe-7b90-a4d5-c76249a0be23',
        interrupt: true,
        message: 'Re-check the sub flow after the parent task changed.',
      }),
      call_id: 'call_send_1',
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      arguments: JSON.stringify({
        targets: ['019d5809-05fe-7b90-a4d5-c76249a0be23'],
        timeout_ms: 1000,
      }),
      call_id: 'call_wait_1',
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_wait_1',
      output: JSON.stringify({
        status: {},
        timed_out: true,
      }),
    },
  });
  harness.reporter.onEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '<subagent_notification>\n{"agent_path":"019d5809-05fe-7b90-a4d5-c76249a0be23","status":{"completed":"Subagent finished the verification run and attached evidence."}}\n</subagent_notification>',
        },
      ],
    },
  });

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /subagent started: Harvey \(019d5809-05fe\)/);
  assert.match(finalCard, /subagent update Harvey \(019d5809-05fe\): Re-check the sub flow after the parent task changed\./);
  assert.match(finalCard, /waiting for subagent Harvey \(019d5809-05fe\)/);
  assert.match(finalCard, /subagent wait timed out/);
  assert.match(finalCard, /subagent report Harvey \(019d5809-05fe\): Subagent finished the verification run and attached evidence\./);
  assert.match(finalCard, /subagent completed: Harvey \(019d5809-05fe\)/);
});

test('createPromptProgressReporterFactory sanitizes Discord spoiler markers in surfaced progress text', async () => {
  const harness = createHarness();

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  harness.reporter.onEvent({
    summaryStep: 'Checking cache || fallback',
    rawActivity: 'command || true',
    completedStep: 'verified || done',
  });

  const runningCard = harness.edits[harness.edits.length - 1].content;
  assert.doesNotMatch(runningCard, /\|\|/);
  assert.match(runningCard, /Checking cache ｜｜ fallback/);

  await harness.reporter.finish({ ok: true });
  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.doesNotMatch(finalCard, /\|\|/);
  assert.match(finalCard, /command ｜｜ true/);
  assert.match(finalCard, /verified ｜｜ done/);
});

test('createPromptProgressReporterFactory streams phased Codex final_answer narration', async () => {
  const harness = createHarness({
    factoryOptions: { presentation: createRealPresentation() },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  const send = (message) => harness.reporter.onEvent({
    type: 'item.completed',
    item: { id: `m_${message}`, type: 'agent_message', phase: 'final_answer', message },
  });

  // Observed in a real 1h21m `codex exec resume` run: 116 of 121 agent messages
  // were labelled final_answer, so treating each as final left the card empty.
  send('第一阶段：读完了配置。');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.streamed, []);

  send('第二阶段：改完了代码。');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.streamed, ['第一阶段：读完了配置。']);

  // Stage messages are not rate limited, so no clock advance is needed here.
  send('全部完成。');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.streamed, ['第一阶段：读完了配置。', '第二阶段：改完了代码。']);

  // The newest stays out of the stream so the reply is not duplicated.
  assert.ok(!harness.streamed.includes('全部完成。'));
});

test('createPromptProgressReporterFactory sends Codex stage messages whole and in order', async () => {
  const harness = createHarness({
    factoryOptions: { presentation: createRealPresentation() },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  const send = (message) => harness.reporter.onEvent({
    type: 'item.completed',
    item: { id: `m_${message.slice(0, 6)}`, type: 'agent_message', phase: 'final_answer', message },
  });

  // Multi-paragraph stages must keep their structure: the process stream would
  // have flattened these newlines into spaces.
  send('阶段一完成。\n\n- 改了 A\n- 改了 B');
  send('阶段二完成。\n\n```js\nconst x = 1;\n```');
  send('全部结束。');
  await harness.reporter.finish({ ok: true });

  assert.deepEqual(harness.streamed, [
    '阶段一完成。\n\n- 改了 A\n- 改了 B',
    '阶段二完成。\n\n```js\nconst x = 1;\n```',
  ]);
});

test('createPromptProgressReporterFactory keeps every Codex stage past the stream queue cap', async () => {
  const harness = createHarness({
    factoryOptions: { presentation: createRealPresentation() },
  });

  await harness.reporter.start();
  harness.channelState.activeRun.phase = 'exec';

  // The process stream caps its queue at 80 entries and drops the oldest. A long
  // run can retire far more stages than that, and none may be silently lost.
  for (let index = 0; index < 95; index += 1) {
    harness.reporter.onEvent({
      type: 'item.completed',
      item: { id: `m_${index}`, type: 'agent_message', phase: 'final_answer', message: `阶段 ${index}` },
    });
  }
  await harness.reporter.finish({ ok: true });

  // 95 sent, the newest held back as the reply.
  assert.equal(harness.streamed.length, 94);
  assert.equal(harness.streamed[0], '阶段 0');
  assert.equal(harness.streamed.at(-1), '阶段 93');
});

async function settleStreamQueue() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('createPromptProgressReporterFactory stays silent for turns that finish before the mark delay', async () => {
  const harness = createHarness({
    factoryOptions: { presentation: createRealPresentation() },
  });

  await harness.reporter.start();
  const tick = () => harness.intervals.find((handle) => handle.ms === 15_000)?.fn();

  // 83.6% of an observed 3026 turns ran under a minute. Marking those would put
  // a start/end pair in the thread for every trivial question, which is the
  // noise the markers are meant to replace.
  harness.advance(80_000);
  tick();
  await settleStreamQueue();
  await harness.reporter.finish({ ok: true });

  assert.deepEqual(harness.streamed, []);
});

test('createPromptProgressReporterFactory announces a long turn once and then keeps it alive', async () => {
  const harness = createHarness({
    factoryOptions: { presentation: createRealPresentation() },
  });

  await harness.reporter.start();
  const tick = () => harness.intervals.find((handle) => handle.ms === 15_000)?.fn();

  harness.advance(95_000);
  tick();
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 1);
  assert.match(harness.streamed[0], /▶ working/);

  // Ticks inside the heartbeat window add nothing: the marker is not a per-tick
  // announcement, it is a statement that the thread has been quiet too long.
  harness.advance(60_000);
  tick();
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 1);

  harness.advance(200_000);
  tick();
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 2);
  assert.match(harness.streamed[1], /still working/);

  await harness.reporter.finish({ ok: true });
  // Finishing is its own proof of completion — the reply goes out here, so no
  // closing marker is added on top of it.
  assert.equal(harness.streamed.length, 2);
});

test('createPromptProgressReporterFactory lets real Codex output reset the keepalive', async () => {
  const harness = createHarness({
    factoryOptions: { presentation: createRealPresentation() },
  });

  await harness.reporter.start();
  const tick = () => harness.intervals.find((handle) => handle.ms === 15_000)?.fn();

  harness.advance(95_000);
  tick();
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 1);

  // A stage answer is already proof of life. The heartbeat measures silence in
  // the thread, so genuine output must postpone the next keepalive rather than
  // arriving alongside it.
  harness.advance(180_000);
  harness.reporter.onEvent({
    type: 'item.completed',
    item: { id: 'm_1', type: 'agent_message', phase: 'commentary', message: '查完了第一批表。' },
  });
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 2);
  assert.equal(harness.streamed[1], '查完了第一批表。');

  harness.advance(120_000);
  tick();
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 2);

  harness.advance(150_000);
  tick();
  await settleStreamQueue();
  assert.equal(harness.streamed.length, 3);
  assert.match(harness.streamed[2], /still working/);

  await harness.reporter.finish({ ok: true });
});
