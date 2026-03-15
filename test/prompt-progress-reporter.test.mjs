import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProgressEventDedupeKey,
  createProgressEventDeduper,
} from '../src/codex-event-utils.js';
import { createPromptProgressReporterFactory } from '../src/prompt-progress-reporter.js';

function clonePlan(plan) {
  return plan ? JSON.parse(JSON.stringify(plan)) : null;
}

function appendUnique(list, value) {
  const text = String(value || '').trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function createHarness(overrides = {}) {
  let currentNow = 10_000;
  const sent = [];
  const edits = [];
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
    buildRunningComponents: ({ message: progressMessage }) => (
      progressMessage?.author?.id
        ? [{ type: 'row', customId: `cmd:cancel:${progressMessage.author.id}` }]
        : []
    ),
    ...overrides.factoryOptions,
  });

  return {
    sent,
    edits,
    intervals,
    cleared,
    channelState,
    message,
    reporter: createProgressReporter({
      message,
      channelState,
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
  assert.deepEqual(harness.sent[0].components, [{ type: 'row', customId: 'cmd:cancel:12345' }]);
  assert.equal(harness.channelState.activeRun.lastProgressText, 'Waiting for workspace lock: /repo/demo');
  assert.equal(harness.channelState.activeRun.progressMessageId, 'progress-1');

  harness.channelState.activeRun.phase = 'exec';
  harness.advance(50);
  harness.reporter.setLatestStep('Workspace lock acquired: /repo/demo');
  assert.match(harness.edits[0].content, /Workspace lock acquired: \/repo\/demo/);
  assert.deepEqual(harness.edits[0].components, [{ type: 'row', customId: 'cmd:cancel:12345' }]);

  await harness.reporter.finish({ ok: true });
  assert.match(harness.edits[harness.edits.length - 1].content, /✅ \*\*Task Completed\*\*/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• phase: done/);
  assert.match(harness.edits[harness.edits.length - 1].content, /• latest activity: Final response sent/);
  assert.deepEqual(harness.edits[harness.edits.length - 1].components, []);
  assert.equal(harness.channelState.activeRun.phase, 'done');
  assert.equal(harness.cleared.length, 2);
});

test('createPromptProgressReporterFactory dedupes repeated events and drains buffered activity on finish', async () => {
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
  assert.deepEqual(harness.channelState.activeRun.recentActivities, ['rg src']);

  await harness.reporter.finish({ ok: true });

  const finalCard = harness.edits[harness.edits.length - 1].content;
  assert.match(finalCard, /process: rg src/);
  assert.match(finalCard, /process: rg test/);
  assert.match(finalCard, /done: Inspect code/);
  assert.match(finalCard, /done: Patch orchestrator/);
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
      progressMessageMaxChars: 120,
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
