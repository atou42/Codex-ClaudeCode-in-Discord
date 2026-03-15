function defaultNormalizeUiLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

function defaultTruncate(value, max) {
  const text = String(value || '');
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return `${text.slice(0, limit - 3)}...`;
}

function joinLinesWithinLimit(lines, maxChars, truncate = defaultTruncate) {
  const normalized = Array.isArray(lines)
    ? lines
      .map((line) => String(line || '').trimEnd())
      .filter(Boolean)
    : [];
  if (!normalized.length) return '';

  const limit = Math.max(1, Number(maxChars) || 0);
  const output = [];
  let used = 0;
  let overflowed = false;

  for (const line of normalized) {
    const nextLength = line.length + (output.length ? 1 : 0);
    if (used + nextLength > limit) {
      overflowed = true;
      break;
    }
    output.push(line);
    used += nextLength;
  }

  if (!output.length) {
    return truncate(normalized[0], limit);
  }

  if (overflowed) {
    const overflowLine = '...';
    if (used + overflowLine.length + 1 <= limit) {
      output.push(overflowLine);
    }
  }

  return output.join('\n');
}

function createNoopProgressReporter({
  channelState,
  initialLatestStep = '',
  now = () => Date.now(),
}) {
  let latestStep = String(initialLatestStep || '').trim();

  const sync = () => {
    if (!channelState?.activeRun) return;
    channelState.activeRun.lastProgressText = latestStep;
    channelState.activeRun.lastProgressAt = now();
  };

  return {
    async start() {
      sync();
    },
    sync,
    setLatestStep(value) {
      const next = String(value || '').trim();
      if (!next) return;
      latestStep = next;
      sync();
    },
    onEvent() {},
    onLog() {},
    async finish() {},
  };
}

function getDefaultLatestStep(language) {
  return language === 'en'
    ? 'Task started, waiting for the first event...'
    : '任务已开始，等待首个事件...';
}

function normalizeActivityKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getFinalLatestStep({
  ok = false,
  cancelled = false,
  timedOut = false,
  latestStep = '',
  language = 'en',
} = {}) {
  if (cancelled) {
    return language === 'en' ? 'Task cancelled' : '任务已中断';
  }
  if (timedOut) {
    return language === 'en' ? 'Task timed out' : '任务已超时';
  }
  if (ok) {
    return language === 'en' ? 'Final response sent' : '最终结果已发送';
  }
  return String(latestStep || '').trim() || (language === 'en' ? 'Task failed' : '任务失败');
}

export function createPromptProgressReporterFactory({
  defaultUiLanguage = 'zh',
  progressUpdatesEnabled = true,
  progressProcessLines = 2,
  progressUpdateIntervalMs = 15000,
  progressEventFlushMs = 5000,
  progressEventDedupeWindowMs = 2500,
  progressIncludeStdout = true,
  progressIncludeStderr = false,
  progressTextPreviewChars = 140,
  progressProcessPushIntervalMs = 1100,
  progressMessageMaxChars = 1800,
  progressPlanMaxLines = 4,
  progressDoneStepsMax = 4,
  safeReply = async () => null,
  normalizeUiLanguage = defaultNormalizeUiLanguage,
  slashRef = (name) => `/${name}`,
  truncate = defaultTruncate,
  humanElapsed = (ms) => `${ms}ms`,
  createProgressEventDeduper = () => () => false,
  buildProgressEventDedupeKey = () => '',
  presentation = {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  buildRunningComponents = () => [],
} = {}) {
  const {
    summarizeCodexEvent = () => '',
    extractRawProgressTextFromEvent = () => '',
    cloneProgressPlan = (plan) => plan,
    extractPlanStateFromEvent = () => null,
    extractCompletedStepFromEvent = () => null,
    appendCompletedStep = () => {},
    appendRecentActivity = () => {},
    formatProgressPlanSummary = () => '',
    renderProcessContentLines = () => [],
    localizeProgressLines = (lines) => lines,
    renderProgressPlanLines = () => [],
    renderCompletedStepsLines = () => [],
    formatRuntimePhaseLabel = (phase) => String(phase || ''),
  } = presentation;

  return function createProgressReporter({
    message,
    channelState,
    language = defaultUiLanguage,
    processLines = progressProcessLines,
    initialLatestStep = '',
  } = {}) {
    const lang = normalizeUiLanguage(language);
    const processLineLimit = Math.max(1, Math.min(5, Number(processLines || progressProcessLines)));
    const seededLatestStep = String(initialLatestStep || '').trim() || getDefaultLatestStep(lang);

    if (!progressUpdatesEnabled) {
      return createNoopProgressReporter({
        channelState,
        initialLatestStep: seededLatestStep,
        now,
      });
    }

    const startedAt = now();
    let progressMessage = null;
    let timer = null;
    let activityTimer = null;
    let stopped = false;
    let lastEmitAt = 0;
    let lastRendered = '';
    let events = 0;
    let latestStep = seededLatestStep;
    let planState = cloneProgressPlan(channelState?.activeRun?.progressPlan);
    const completedSteps = Array.isArray(channelState?.activeRun?.completedSteps)
      ? [...channelState.activeRun.completedSteps]
      : [];
    const recentActivities = Array.isArray(channelState?.activeRun?.recentActivities)
      ? [...channelState.activeRun.recentActivities]
      : [];
    const pendingActivities = [];
    let lastActivityPushAt = 0;
    let isEmitting = false;
    let rerunEmit = false;
    const isDuplicateProgressEvent = createProgressEventDeduper({
      ttlMs: progressEventDedupeWindowMs,
      maxKeys: 700,
    });

    const syncActiveRun = () => {
      if (!channelState?.activeRun) return;
      channelState.activeRun.progressEvents = events;
      channelState.activeRun.lastProgressText = latestStep;
      channelState.activeRun.lastProgressAt = now();
      channelState.activeRun.progressPlan = cloneProgressPlan(planState);
      channelState.activeRun.completedSteps = [...completedSteps];
      channelState.activeRun.recentActivities = [...recentActivities];
      if (progressMessage?.id) {
        channelState.activeRun.progressMessageId = progressMessage.id;
      }
    };

    const render = (status = 'running') => {
      const elapsed = humanElapsed(Math.max(0, now() - startedAt));
      const phase = formatRuntimePhaseLabel(channelState?.activeRun?.phase || 'starting', lang);
      const hint = status === 'running'
        ? (lang === 'en'
          ? `Use \`!abort\` / \`${slashRef('cancel')}\` to interrupt, and \`!progress\` for details.`
          : `可用 \`!abort\` / \`${slashRef('cancel')}\` 中断，\`!progress\` 查看详情。`)
        : (lang === 'en'
          ? 'You can continue with a new message, or check remaining backlog with `!queue`.'
          : '可继续发送新消息，或用 `!queue` 查看是否还有排队任务。');
      const statusLine = status === 'running'
        ? (lang === 'en' ? '⏳ **Task Running**' : '⏳ **任务进行中**')
        : status;
      const lines = [
        statusLine,
        `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
        `${lang === 'en' ? '• phase' : '• 阶段'}: ${phase}`,
        `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
        `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${latestStep}`,
        ...renderProcessContentLines(recentActivities, lang, processLineLimit),
        ...localizeProgressLines(renderProgressPlanLines(planState, progressPlanMaxLines), lang),
        ...localizeProgressLines(renderCompletedStepsLines(completedSteps, {
          planState,
          latestStep,
          maxSteps: progressDoneStepsMax,
        }), lang),
        `${lang === 'en' ? '• queued prompts' : '• 排队任务'}: ${channelState?.queue?.length || 0}`,
        `${lang === 'en' ? '• hint' : '• 提示'}: ${hint}`,
      ].filter(Boolean);
      return joinLinesWithinLimit(lines, progressMessageMaxChars, truncate);
    };

    const buildPayload = (body, status = 'running') => {
      if (status === 'running') {
        const components = buildRunningComponents({
          message,
          channelState,
          language: lang,
        });
        if (Array.isArray(components) && components.length) {
          return {
            content: body,
            components,
          };
        }
      }

      return {
        content: body,
        components: [],
      };
    };

    const emit = async (force = false) => {
      if (!progressMessage || stopped) return;
      if (isEmitting) {
        rerunEmit = true;
        return;
      }

      const currentTime = now();
      if (!force && currentTime - lastEmitAt < progressEventFlushMs) return;
      const body = render('running');
      const payload = buildPayload(body, 'running');
      if (!force && body === lastRendered) return;

      isEmitting = true;
      try {
        await progressMessage.edit(payload);
        lastEmitAt = now();
        lastRendered = body;
        syncActiveRun();
      } catch {
        // ignore edit failures
      } finally {
        isEmitting = false;
        if (rerunEmit && !stopped) {
          rerunEmit = false;
          void emit(false);
        }
      }
    };

    const enqueueActivity = (activityText) => {
      const text = String(activityText || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const key = normalizeActivityKey(text);
      if (!key) return;

      const latestVisible = normalizeActivityKey(recentActivities[recentActivities.length - 1]);
      if (latestVisible && latestVisible === key) return;
      const latestQueued = normalizeActivityKey(pendingActivities[pendingActivities.length - 1]);
      if (latestQueued && latestQueued === key) return;

      pendingActivities.push(text);
      if (pendingActivities.length > 80) {
        pendingActivities.splice(0, pendingActivities.length - 80);
      }
    };

    const pushOneActivity = ({ force = false } = {}) => {
      if (!pendingActivities.length) return false;
      const currentTime = now();
      if (!force && currentTime - lastActivityPushAt < progressProcessPushIntervalMs) return false;
      const next = pendingActivities.shift();
      if (!next) return false;
      appendRecentActivity(recentActivities, next);
      lastActivityPushAt = currentTime;
      return true;
    };

    const setLatestStep = (value, { forceEmit = true } = {}) => {
      const next = String(value || '').trim();
      if (!next) return;
      latestStep = next;
      syncActiveRun();
      if (!stopped) {
        void emit(forceEmit);
      }
    };

    const sync = ({ forceEmit = false } = {}) => {
      syncActiveRun();
      if (!stopped) {
        void emit(forceEmit);
      }
    };

    const start = async () => {
      syncActiveRun();
      try {
        const body = render('running');
        progressMessage = await safeReply(message, buildPayload(body, 'running'));
        lastEmitAt = now();
        lastRendered = body;
        syncActiveRun();
        timer = setIntervalFn(() => {
          void emit(true);
        }, progressUpdateIntervalMs);
        timer?.unref?.();
        activityTimer = setIntervalFn(() => {
          if (stopped) return;
          if (!pushOneActivity()) return;
          syncActiveRun();
          void emit(false);
        }, progressProcessPushIntervalMs);
        activityTimer?.unref?.();
      } catch {
        progressMessage = null;
      }
    };

    const onEvent = (event) => {
      if (stopped) return;
      const summaryStep = summarizeCodexEvent(event);
      const rawActivity = extractRawProgressTextFromEvent(event);
      const nextPlan = extractPlanStateFromEvent(event);
      const completedStep = extractCompletedStepFromEvent(event);
      const dedupeKey = buildProgressEventDedupeKey({
        summaryStep,
        rawActivity,
        completedStep,
        planSummary: formatProgressPlanSummary(nextPlan),
      });
      if (isDuplicateProgressEvent(dedupeKey)) return;

      events += 1;
      if (summaryStep && !summaryStep.startsWith('agent message')) {
        latestStep = summaryStep;
      } else if (!latestStep) {
        latestStep = summaryStep;
      }
      if (rawActivity) {
        enqueueActivity(rawActivity);
        if (recentActivities.length === 0) {
          pushOneActivity({ force: true });
        } else {
          pushOneActivity();
        }
      }
      if (nextPlan) {
        planState = nextPlan;
        for (const item of nextPlan.steps) {
          if (item.status === 'completed') {
            appendCompletedStep(completedSteps, item.step);
          }
        }
      }
      if (completedStep) appendCompletedStep(completedSteps, completedStep);
      syncActiveRun();
      void emit(false);
    };

    const onLog = (line, source) => {
      if (stopped) return;
      if (source === 'stderr' && !progressIncludeStderr) return;
      if (source === 'stdout' && !progressIncludeStdout) return;

      events += 1;
      const sourceLabel = lang === 'en'
        ? source
        : (source === 'stderr' ? '标准错误' : '标准输出');
      latestStep = `${sourceLabel}: ${truncate(String(line || '').replace(/\s+/g, ' ').trim(), progressTextPreviewChars)}`;
      syncActiveRun();
      void emit(false);
    };

    const finish = async ({ ok = false, cancelled = false, timedOut = false, error = '' } = {}) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearIntervalFn(timer);
      if (activityTimer) clearIntervalFn(activityTimer);
      while (pushOneActivity({ force: true })) {
        // Drain buffered activity lines into the final card.
      }
      latestStep = getFinalLatestStep({
        ok,
        cancelled,
        timedOut,
        latestStep,
        language: lang,
      });
      if (channelState?.activeRun) {
        channelState.activeRun.phase = 'done';
      }
      syncActiveRun();
      if (!progressMessage) return;

      const elapsed = humanElapsed(Math.max(0, now() - startedAt));
      const status = cancelled
        ? (lang === 'en' ? '🛑 **Task Cancelled**' : '🛑 **任务已中断**')
        : ok
          ? (lang === 'en' ? '✅ **Task Completed**' : '✅ **任务已完成**')
          : timedOut
            ? (lang === 'en' ? '⏱️ **Task Timed Out**' : '⏱️ **任务超时**')
            : (lang === 'en' ? '❌ **Task Failed**' : '❌ **任务失败**');
      const lines = [
        status,
        `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
        `${lang === 'en' ? '• phase' : '• 阶段'}: ${formatRuntimePhaseLabel(channelState?.activeRun?.phase || 'done', lang)}`,
        `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
        `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${latestStep}`,
        ...renderProcessContentLines(recentActivities, lang, processLineLimit),
        ...localizeProgressLines(renderProgressPlanLines(planState, progressPlanMaxLines), lang),
        ...localizeProgressLines(renderCompletedStepsLines(completedSteps, {
          planState,
          latestStep,
          maxSteps: progressDoneStepsMax,
        }), lang),
        !ok && !cancelled && error ? `${lang === 'en' ? '• error' : '• 错误'}: ${truncate(String(error), 260)}` : null,
      ].filter(Boolean);
      const safeBody = joinLinesWithinLimit(lines, progressMessageMaxChars, truncate);

      try {
        await progressMessage.edit(buildPayload(safeBody, 'done'));
      } catch {
        // ignore
      }
    };

    return {
      start,
      sync,
      setLatestStep,
      onEvent,
      onLog,
      finish,
    };
  };
}
