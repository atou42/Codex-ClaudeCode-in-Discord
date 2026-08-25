import { getSupportedReasoningEffortLevels } from './provider-metadata.js';
import {
  extractCodexAgentMessageForNarration,
  extractUnphasedCodexAgentMessage,
  isCodexTurnEndEvent,
  isCodexTurnStartEvent,
  isCodexTurnTerminalEvent,
  isCodexWorkEvent,
} from './codex-event-utils.js';

const HEARTBEAT_TICK_MS = 15_000;

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

function normalizeProgressEventType(value) {
  return String(value || '').trim().toLowerCase().replace(/[./-]/g, '_');
}

function normalizeProgressText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeDiscordDisplayText(value) {
  return String(value || '').replace(/\|\|/g, '｜｜');
}

function isLowSignalLatestStep(value) {
  const normalized = normalizeActivityKey(value);
  if (!normalized) return true;
  if (normalized === 'received event') return true;
  if (normalized === 'system') return true;
  if (normalized === 'turn started') return true;
  if (normalized === 'agent message started') return true;
  if (normalized === 'agent message delta') return true;
  if (normalized === 'message start') return true;
  if (normalized === 'message stop') return true;
  if (normalized === 'content block start') return true;
  if (normalized === 'content block stop') return true;
  if (normalized === 'task started, waiting for the first event') return true;
  if (normalized === '任务已开始，等待首个事件') return true;
  if (normalized.startsWith('waiting for workspace lock')) return true;
  if (normalized.startsWith('等待 workspace 锁')) return true;
  return false;
}

function isAgentNarrationStep(value) {
  return String(value || '').trim().startsWith('agent message');
}

function isUrgentLatestStep(value) {
  const normalized = normalizeActivityKey(value);
  return normalized.includes('api error')
    || normalized.includes('rate limit')
    || normalized.includes('429')
    || normalized.includes('failed');
}

// How long a piece of agent narration keeps the "latest activity" line before a
// mechanical tool label is allowed to take over. Long enough that a burst of tool
// calls cannot bury what the agent just said, short enough that the line never
// looks frozen while the run is still moving.
const AGENT_NARRATION_STICKY_MS = 30_000;

// Agent narration explains *why* the run is where it is, so it outranks the tool
// label that happens to arrive next. Errors outrank everything.
function shouldPromoteLatestStep(nextStep, currentStep, { currentStepAgeMs = Infinity } = {}) {
  const next = String(nextStep || '').trim();
  if (!next || isLowSignalLatestStep(next)) return false;
  if (isUrgentLatestStep(next)) return true;
  if (isAgentNarrationStep(next)) return true;
  if (!currentStep || isLowSignalLatestStep(currentStep)) return true;
  if (!isAgentNarrationStep(currentStep)) return true;
  return currentStepAgeMs >= AGENT_NARRATION_STICKY_MS;
}

function parseProgressJsonMaybe(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractProgressPayload(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.payload && typeof event.payload === 'object') return event.payload;
  if (event.message && typeof event.message === 'object') return event.message;
  return null;
}

function isOmpTextDeltaEvent(event) {
  if (normalizeProgressEventType(event?.type || '') !== 'message_update') return false;
  return normalizeProgressEventType(event?.assistantMessageEvent?.type || '') === 'text_delta';
}

function extractOmpAssistantTurn(event) {
  if (normalizeProgressEventType(event?.type || '') !== 'message_end') return null;
  const message = event?.message;
  if (!message || normalizeProgressEventType(message.role || '') !== 'assistant') return null;
  const stopReason = normalizeProgressEventType(message.stopReason || message.stop_reason || '')
    .replace(/_/g, '');
  const text = Array.isArray(message.content)
    ? message.content
      .filter((part) => normalizeProgressEventType(part?.type || '') === 'text')
      .map((part) => String(part?.text || '').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
    : '';
  return {
    text,
    continuesWithTools: stopReason === 'tooluse',
  };
}

function parseSubagentNotificationFromText(rawText) {
  const text = String(rawText || '');
  if (!text.includes('<subagent_notification>')) return null;
  const match = text.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/i);
  if (!match?.[1]) return null;
  const parsed = parseProgressJsonMaybe(match[1].trim());
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function collectTextParts(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  collectTextParts(value.text, out);
  collectTextParts(value.message, out);
  collectTextParts(value.content, out);
  collectTextParts(value.output_text, out);
  collectTextParts(value.input_text, out);
  return out;
}

function createCodexSubagentDisplayNameTracker() {
  const displayNames = new Map();

  const remember = (agentId, nickname) => {
    const id = normalizeProgressText(agentId);
    const name = normalizeProgressText(nickname);
    if (!id || !name) return;
    displayNames.set(id, name);
  };

  const rememberOutput = (rawOutput) => {
    const output = typeof rawOutput === 'string'
      ? parseProgressJsonMaybe(rawOutput)
      : rawOutput;
    if (!output || typeof output !== 'object' || Array.isArray(output)) return;
    remember(output.agent_id || output.agent_path, output.nickname);
  };

  const rememberNotifications = (event, payload) => {
    for (const text of collectTextParts([event, payload])) {
      const notification = parseSubagentNotificationFromText(text);
      if (!notification) continue;
      remember(notification.agent_id || notification.agent_path, notification.nickname);
    }
  };

  const capture = (event) => {
    if (!event || typeof event !== 'object') return;
    const payload = extractProgressPayload(event);
    const candidates = [event, payload].filter((item) => item && typeof item === 'object');
    for (const item of candidates) {
      const type = normalizeProgressEventType(item.type || '');
      if (type === 'function_call_output') {
        rememberOutput(item.output ?? item.result ?? item.data);
      }
    }
    rememberNotifications(event, payload);
  };

  return {
    capture,
    snapshot() {
      return new Map(displayNames);
    },
  };
}

function formatClaudePathLabel(rawPath, truncateText, previewChars) {
  const filePath = normalizeProgressText(rawPath);
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const leaf = normalized.split('/').filter(Boolean).pop() || normalized;
  return truncateText(leaf, previewChars);
}

function summarizeClaudeShellIntent(command, truncateText, previewChars) {
  const text = normalizeProgressText(command);
  if (!text) return '';

  if (/\b(which|command\s+-v|type\s+-p)\b/.test(text)) return 'Check available tools';
  if (/\b(ls|find)\b/.test(text)) return 'Inspect project files';
  if (/\b(rg|ripgrep|grep)\b/.test(text)) return 'Search project files';
  if (/\b(cat|sed|head|tail|awk)\b/.test(text)) return 'Read file content';
  if (/\bgit\s+(status|diff|log|show)\b/.test(text)) return 'Check repository state';
  if (/\b(npm|pnpm|yarn)\s+(test|lint|build|typecheck)\b/.test(text)) return 'Run project checks';
  if (/\b(python|python3|node)\b/.test(text) && (/\s-c\b/.test(text) || /<<\s*['"]?[A-Z_]+['"]?/.test(text))) {
    return 'Run an analysis script';
  }

  return `Run shell command: ${truncateText(text, previewChars)}`;
}

function summarizeClaudeToolInput(input, truncateText, previewChars, toolName = '') {
  if (!input || typeof input !== 'object') return '';
  const normalizedTool = normalizeProgressEventType(toolName);

  const description = normalizeProgressText(input.description || input.reason || input.explanation || '');
  if (description) return truncateText(description, previewChars);

  if (normalizedTool === 'todowrite') {
    const todoCount = Array.isArray(input.todos)
      ? input.todos.length
      : Array.isArray(input.newTodos)
        ? input.newTodos.length
        : 0;
    return todoCount > 0 ? `Update plan (${todoCount} steps)` : 'Update plan';
  }

  const filePath = formatClaudePathLabel(input.file_path || input.path || '', truncateText, previewChars);
  if (normalizedTool === 'read') return filePath ? `Read ${filePath}` : 'Read file';
  if (normalizedTool === 'write') return filePath ? `Write ${filePath}` : 'Write file';
  if (normalizedTool === 'edit' || normalizedTool === 'multiedit') return filePath ? `Edit ${filePath}` : 'Edit file';
  if (normalizedTool === 'ls') return filePath ? `Inspect ${filePath}` : 'Inspect directory';
  if (normalizedTool === 'glob') {
    const pattern = normalizeProgressText(input.pattern || '');
    return pattern ? `Scan files: ${truncateText(pattern, previewChars)}` : 'Scan files';
  }
  if (normalizedTool === 'grep') {
    const pattern = normalizeProgressText(input.pattern || input.query || input.q || '');
    return pattern ? `Search files: ${truncateText(pattern, previewChars)}` : 'Search files';
  }
  if (normalizedTool === 'websearch') {
    const query = normalizeProgressText(input.query || input.q || '');
    return query ? `Search web: ${truncateText(query, previewChars)}` : 'Search web';
  }
  if (normalizedTool === 'webfetch') {
    const url = normalizeProgressText(input.url || '');
    return url ? `Open page: ${truncateText(url, previewChars)}` : 'Open page';
  }

  const command = normalizeProgressText(input.command || input.cmd || '');
  if (command) return summarizeClaudeShellIntent(command, truncateText, previewChars);

  const query = normalizeProgressText(input.query || input.q || '');
  if (query) return `Search: ${truncateText(query, previewChars)}`;

  if (filePath) return `File: ${filePath}`;

  const url = normalizeProgressText(input.url || '');
  if (url) return `URL: ${truncateText(url, previewChars)}`;

  const pattern = normalizeProgressText(input.pattern || '');
  if (pattern) return `Find: ${truncateText(pattern, previewChars)}`;

  return '';
}

function formatClaudeToolUseLabel(block, truncateText, previewChars) {
  const toolName = normalizeProgressText(block?.name || 'tool') || 'tool';
  const normalizedTool = normalizeProgressEventType(toolName);
  const detail = summarizeClaudeToolInput(block?.input, truncateText, previewChars, toolName);

  if (normalizedTool === 'todowrite') return detail || 'Update plan';
  if (['bash', 'read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep', 'websearch', 'webfetch'].includes(normalizedTool)) {
    return detail || toolName;
  }

  return detail ? `${toolName}: ${detail}` : `tool ${toolName}`;
}

function shouldSurfaceClaudeToolActivity(block) {
  return normalizeProgressEventType(block?.name || '') !== 'todowrite';
}

// Claude often emits no narration between tool calls, so tool_use labels must
// reach rawActivities to keep the thread visibly alive. TodoWrite stays on the
// card because its plan is already rendered there.
function createClaudeProgressTracker({ truncateText, previewChars }) {
  const activeBlocks = new Map();
  const finalizedBlocks = [];
  const toolUseLabelsById = new Map();
  const seenAssistantBlockKeys = new Set();
  const seenAssistantBlockKeyQueue = [];
  const consumedToolResultIds = new Set();
  const consumedToolResultIdQueue = [];
  let sawStreamEvents = false;

  function rememberBoundedKey(set, queue, key) {
    if (!key || set.has(key)) return false;
    set.add(key);
    queue.push(key);
    if (queue.length > 400) {
      const stale = queue.shift();
      if (stale) set.delete(stale);
    }
    return true;
  }

  function resetMessage() {
    activeBlocks.clear();
    finalizedBlocks.length = 0;
  }

  function finalizeBlock(index) {
    if (!activeBlocks.has(index)) return;
    const block = activeBlocks.get(index);
    activeBlocks.delete(index);
    if (!block) return;

    if (block.kind === 'text') {
      const text = normalizeProgressText(block.text);
      if (text) finalizedBlocks.push({ kind: 'text', text });
      return;
    }

    if (block.kind === 'tool_use') {
      let mergedInput = block.input && typeof block.input === 'object' ? { ...block.input } : {};
      const parsed = parseProgressJsonMaybe(block.partialInput);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mergedInput = { ...mergedInput, ...parsed };
      }
      const next = {
        kind: 'tool_use',
        id: normalizeProgressText(block.id),
        name: normalizeProgressText(block.name || 'tool') || 'tool',
        input: mergedInput,
      };
      finalizedBlocks.push(next);
      if (next.id) {
        toolUseLabelsById.set(next.id, formatClaudeToolUseLabel(next, truncateText, previewChars));
      }
    }
  }

  function consumeMessageBoundary(stopReason) {
    const normalizedStopReason = normalizeProgressEventType(stopReason);
    const summaryCandidates = [];
    const rawActivities = [];

    for (const block of finalizedBlocks.splice(0)) {
      if (block.kind === 'tool_use') {
        const label = formatClaudeToolUseLabel(block, truncateText, previewChars);
        summaryCandidates.push(label);
        if (shouldSurfaceClaudeToolActivity(block)) rawActivities.push(label);
        continue;
      }

      if (block.kind === 'text' && normalizedStopReason !== 'end_turn') {
        const text = truncateText(block.text, previewChars);
        if (text) {
          summaryCandidates.push(`agent message: ${text}`);
          rawActivities.push(text);
        }
      }
    }

    return {
      summaryStep: summaryCandidates[summaryCandidates.length - 1] || '',
      rawActivities,
      completedSteps: [],
    };
  }

  function consumeToolResult(event) {
    if (!event || typeof event !== 'object') return null;
    const parts = Array.isArray(event?.message?.content) ? event.message.content : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (normalizeProgressEventType(part.type || '') !== 'tool_result') continue;
      const toolUseId = normalizeProgressText(part.tool_use_id || '');
      if (!toolUseId) continue;
      const label = toolUseLabelsById.get(toolUseId);
      if (!label) continue;
      if (!rememberBoundedKey(consumedToolResultIds, consumedToolResultIdQueue, toolUseId)) continue;
      if (label === 'Update plan' || /^Update plan \(\d+ steps\)$/.test(label)) return null;
      return {
        summaryStep: `${label} completed`,
        rawActivities: [],
        completedSteps: [label],
      };
    }
    return null;
  }

  // Newer Claude CLI builds stopped emitting stream_event lines even with
  // --include-partial-messages; intermediate progress only exists as plain
  // assistant snapshots (one event per content block, stop_reason set on the
  // message). Derive commentary and tool activity from those snapshots so the
  // Discord progress surfaces keep streaming like Codex. Skipped entirely once
  // any stream_event arrives, so older CLIs never double-report.
  function consumeAssistantSnapshot(event) {
    if (sawStreamEvents) return null;
    const message = event?.message && typeof event.message === 'object' ? event.message : null;
    if (!message) return null;
    if (normalizeProgressEventType(message.role || '') !== 'assistant') return null;

    const stopReason = normalizeProgressEventType(message.stop_reason || message.stopReason || '');
    const content = Array.isArray(message.content) ? message.content : [];
    const messageId = normalizeProgressText(message.id || '');
    const summaryCandidates = [];
    const rawActivities = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const blockType = normalizeProgressEventType(block.type || '');

      if (blockType === 'tool_use') {
        const toolUseId = normalizeProgressText(block.id || '');
        const blockKey = toolUseId ? `tool_use|${toolUseId}` : '';
        if (blockKey && !rememberBoundedKey(seenAssistantBlockKeys, seenAssistantBlockKeyQueue, blockKey)) continue;
        const normalized = {
          kind: 'tool_use',
          id: toolUseId,
          name: normalizeProgressText(block.name || block.tool_name || 'tool') || 'tool',
          input: block.input && typeof block.input === 'object' ? block.input : {},
        };
        const label = formatClaudeToolUseLabel(normalized, truncateText, previewChars);
        if (normalized.id) toolUseLabelsById.set(normalized.id, label);
        summaryCandidates.push(label);
        if (shouldSurfaceClaudeToolActivity(normalized)) rawActivities.push(label);
        continue;
      }

      if (blockType !== 'text') continue;
      // end_turn text is the final answer (delivered separately); snapshots
      // without a stop_reason are pre-final partials from the stream path.
      if (!stopReason || stopReason === 'end_turn') continue;
      const text = normalizeProgressText(block.text);
      if (!text) continue;
      const blockKey = `text|${messageId}|${text}`;
      if (!rememberBoundedKey(seenAssistantBlockKeys, seenAssistantBlockKeyQueue, blockKey)) continue;
      const preview = truncateText(text, previewChars);
      if (!preview) continue;
      summaryCandidates.push(`agent message: ${preview}`);
      rawActivities.push(text);
    }

    if (!summaryCandidates.length && !rawActivities.length) return null;
    return {
      summaryStep: summaryCandidates[summaryCandidates.length - 1] || '',
      rawActivities,
      completedSteps: [],
    };
  }

  function capture(event) {
    const type = normalizeProgressEventType(event?.type || '');
    if (!type) return null;

    if (type === 'stream_event' && event.event && typeof event.event === 'object') {
      sawStreamEvents = true;
      const nestedType = normalizeProgressEventType(event.event.type || '');
      if (nestedType === 'message_start') {
        resetMessage();
        return null;
      }

      if (nestedType === 'content_block_start') {
        const index = Number(event.event.index);
        if (!Number.isFinite(index)) return null;
        const block = event.event.content_block && typeof event.event.content_block === 'object'
          ? event.event.content_block
          : {};
        const blockType = normalizeProgressEventType(block.type || '');
        if (blockType === 'text') {
          activeBlocks.set(index, {
            kind: 'text',
            text: String(block.text || ''),
          });
        } else if (blockType === 'tool_use') {
          activeBlocks.set(index, {
            kind: 'tool_use',
            id: block.id,
            name: block.name || block.tool_name || 'tool',
            input: block.input && typeof block.input === 'object' ? block.input : {},
            partialInput: '',
          });
        }
        return null;
      }

      if (nestedType === 'content_block_delta') {
        const index = Number(event.event.index);
        if (!Number.isFinite(index) || !activeBlocks.has(index)) return null;
        const block = activeBlocks.get(index);
        const delta = event.event.delta && typeof event.event.delta === 'object' ? event.event.delta : {};
        const deltaType = normalizeProgressEventType(delta.type || '');
        if (block.kind === 'text' && deltaType === 'text_delta' && typeof delta.text === 'string') {
          block.text = `${block.text || ''}${delta.text}`;
        } else if (block.kind === 'tool_use' && deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.partialInput = `${block.partialInput || ''}${delta.partial_json}`;
        }
        return null;
      }

      if (nestedType === 'content_block_stop') {
        finalizeBlock(Number(event.event.index));
        return null;
      }

      if (nestedType === 'message_delta') {
        return consumeMessageBoundary(
          event.event.delta?.stop_reason
          || event.event.delta?.stopReason
          || '',
        );
      }

      if (nestedType === 'message_stop') {
        resetMessage();
      }

      return null;
    }

    if (type === 'assistant') {
      return consumeAssistantSnapshot(event);
    }

    if (type === 'user') {
      return consumeToolResult(event);
    }

    return null;
  }

  return {
    capture,
  };
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

function formatFastModeSource(source, language = 'en') {
  const value = String(source || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'session override') return 'this channel';
    if (value === 'parent channel') return 'parent channel';
    if (value === 'config.toml') return 'global config';
    return value || 'unknown';
  }
  if (value === 'session override') return '当前频道';
  if (value === 'parent channel') return '父频道默认';
  if (value === 'config.toml') return '全局配置';
  return value || '未知';
}

function formatFastModeValue(setting, language = 'en') {
  if (!setting?.supported) return null;
  const enabled = setting.enabled
    ? (language === 'en' ? 'on' : '开启')
    : (language === 'en' ? 'off' : '关闭');
  return language === 'en'
    ? `${enabled} (${formatFastModeSource(setting.source, language)})`
    : `${enabled}（${formatFastModeSource(setting.source, language)}）`;
}

function formatEffortValue(setting, provider, language = 'en') {
  if (!getSupportedReasoningEffortLevels(provider).length) return null;

  const value = String(setting?.value || '').trim();
  const source = String(setting?.source || '').trim().toLowerCase();
  if (!value) return null;
  if (source === 'provider') {
    return language === 'en' ? 'provider default' : 'provider 默认';
  }
  return value;
}

function formatSettingSourceLabel(source, language = 'en') {
  if (source === 'session override') {
    return language === 'en' ? 'session override' : '频道覆盖';
  }
  if (source === 'parent channel') {
    return language === 'en' ? 'parent channel' : '父频道默认';
  }
  if (source === 'config.toml') {
    return 'config.toml';
  }
  if (source === 'env default') {
    return language === 'en' ? 'env default' : '环境默认';
  }
  if (source === 'runtime observed') {
    return language === 'en' ? 'runtime observed' : '实际运行';
  }
  return language === 'en' ? 'provider default' : 'provider 默认';
}

function extractObservedModel(event) {
  const directMessage = event?.message && typeof event.message === 'object' ? event.message : null;
  const nestedMessage = event?.event?.message && typeof event.event.message === 'object'
    ? event.event.message
    : null;
  const candidates = [
    directMessage?.model,
    nestedMessage?.model,
    event?.model,
    event?._meta?.modelId,
    event?.params?.update?._meta?.modelId,
  ];
  for (const candidate of candidates) {
    const value = candidate && typeof candidate === 'object'
      ? candidate.modelId || candidate.model_id || candidate.id || candidate.name
      : candidate;
    const model = String(value || '').trim();
    if (model) return model;
  }

  const modelUsageCandidates = [
    event?.modelUsage,
    event?.model_usage,
    event?.usage?.modelUsage,
    event?.usage?.model_usage,
  ];
  for (const modelUsage of modelUsageCandidates) {
    if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) continue;
    const models = Object.keys(modelUsage).map((model) => String(model || '').trim()).filter(Boolean);
    if (models.length === 1) return models[0];
  }
  return '';
}

const GROK_NORMALIZED_PROGRESS_EVENT = '__grokNormalizedProgressEvent';

function normalizeGrokToolArgs(event, tracked = {}) {
  const rawInput = event?.rawInput && typeof event.rawInput === 'object' && !Array.isArray(event.rawInput)
    ? event.rawInput
    : {};
  const metadataInput = event?._meta?.['x.ai/tool']?.input;
  const args = {
    ...(tracked.args && typeof tracked.args === 'object' ? tracked.args : {}),
    ...(metadataInput && typeof metadataInput === 'object' && !Array.isArray(metadataInput) ? metadataInput : {}),
    ...rawInput,
  };
  const locationPath = Array.isArray(event?.locations)
    ? String(event.locations.find((location) => String(location?.path || '').trim())?.path || '').trim()
    : '';
  const filePath = String(args.path || args.file_path || args.target_file || locationPath || '').trim();
  if (filePath && !args.path && !args.file_path) args.path = filePath;
  const title = String(event?.title || '').trim();
  const genericTitle = String(
    event?.toolName
      || event?.tool_name
      || event?._meta?.['x.ai/tool']?.name
      || tracked.toolName
      || '',
  ).trim();
  if (!args.description && title && title !== genericTitle && /[`/\\\s]/.test(title)) {
    args.description = title;
  }
  return args;
}

function normalizeGrokToolName(event, tracked = {}) {
  return String(
    event?.toolName
      || event?.tool_name
      || event?._meta?.['x.ai/tool']?.name
      || tracked.toolName
      || event?.title
      || 'tool',
  ).trim() || 'tool';
}

function hasMeaningfulGrokToolDetails(args) {
  if (!args || typeof args !== 'object') return false;
  return [
    args.description,
    args.command,
    args.cmd,
    args.path,
    args.file_path,
    args.target_file,
    args.query,
    args.q,
    args.url,
    args.pattern,
  ].some((value) => String(value || '').trim());
}

function summarizeGrokToolIntent(toolName, args) {
  const description = String(args?.description || '').trim();
  if (description) return description;
  const normalizedToolName = String(toolName || '').trim().toLowerCase();
  const filePath = String(args?.path || args?.file_path || args?.target_file || '').trim();
  if (filePath) {
    if (normalizedToolName.includes('read')) return `Read ${filePath}`;
    if (normalizedToolName.includes('list')) return `Inspect ${filePath}`;
    return `Use ${filePath}`;
  }
  const command = String(args?.command || args?.cmd || '').replace(/\s+/g, ' ').trim();
  if (command) return `Run ${command}`;
  const query = String(args?.query || args?.q || args?.pattern || '').replace(/\s+/g, ' ').trim();
  if (query) return `Search ${query}`;
  const url = String(args?.url || '').trim();
  if (url) return `Open ${url}`;
  return '';
}

function createNormalizedGrokEvent(event) {
  return {
    ...event,
    [GROK_NORMALIZED_PROGRESS_EVENT]: true,
  };
}

function takeGrokNarration(progressState) {
  const text = String(progressState.textBuffer || '').trim();
  progressState.textBuffer = '';
  if (!text) return null;
  return createNormalizedGrokEvent({
    type: 'assistant_message',
    message: text,
    phase: 'commentary',
  });
}

function normalizeGrokProgressEvents(event, progressState) {
  const type = String(event?.type || '').trim().toLowerCase();
  if (type === 'text') {
    progressState.textBuffer = `${progressState.textBuffer || ''}${String(event?.data || '')}`;
    return [];
  }
  if (type === 'thought' || type === 'usage' || type === 'available_commands' || type === 'end') {
    if (type === 'end') progressState.textBuffer = '';
    return [];
  }
  if (type === 'tool_call') {
    const toolCallId = String(event?.toolCallId || event?.tool_call_id || '').trim();
    const tracked = progressState.toolCalls.get(toolCallId) || {};
    const toolName = normalizeGrokToolName(event, tracked);
    const args = normalizeGrokToolArgs(event, tracked);
    const nextTracked = {
      ...tracked,
      toolName,
      args,
      intent: summarizeGrokToolIntent(toolName, args),
    };
    const normalized = [];
    const narration = takeGrokNarration(progressState);
    if (narration) normalized.push(narration);
    if (hasMeaningfulGrokToolDetails(args)) {
      nextTracked.reportedStart = true;
      normalized.push(createNormalizedGrokEvent({
        type: 'tool_execution_start',
        toolCallId,
        toolName,
        tool_name: toolName,
        args,
        intent: nextTracked.intent,
      }));
    }
    if (toolCallId) progressState.toolCalls.set(toolCallId, nextTracked);
    return normalized;
  }
  if (type === 'tool_call_update') {
    const toolCallId = String(event?.toolCallId || event?.tool_call_id || '').trim();
    const tracked = progressState.toolCalls.get(toolCallId) || {};
    const toolName = normalizeGrokToolName(event, tracked);
    const args = normalizeGrokToolArgs(event, tracked);
    const status = String(event?.status || '').trim().toLowerCase();
    const nextTracked = {
      ...tracked,
      toolName,
      args,
      intent: summarizeGrokToolIntent(toolName, args),
    };
    const normalized = [];
    if (!nextTracked.reportedStart && hasMeaningfulGrokToolDetails(args)) {
      nextTracked.reportedStart = true;
      normalized.push(createNormalizedGrokEvent({
        type: 'tool_execution_start',
        toolCallId,
        toolName,
        tool_name: toolName,
        args,
        intent: nextTracked.intent,
      }));
    }
    if (status) {
      normalized.push(createNormalizedGrokEvent({
        type: 'tool_result',
        toolCallId,
        toolName,
        tool_name: toolName,
        status,
        args,
        intent: nextTracked.intent,
      }));
    }
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(status)) {
      progressState.toolCalls.delete(toolCallId);
    } else if (toolCallId) {
      progressState.toolCalls.set(toolCallId, nextTracked);
    }
    return normalized;
  }
  if (type === 'error') {
    const narration = takeGrokNarration(progressState);
    return [
      ...(narration ? [narration] : []),
      createNormalizedGrokEvent(event),
    ];
  }
  return [];
}

function formatModelValue(modelSetting, language = 'en') {
  const value = String(modelSetting?.value || '').trim();
  const source = String(modelSetting?.source || 'provider').trim();
  if (!value) {
    return language === 'en' ? 'unknown model' : '未知 model';
  }
  if (source === 'config.toml') {
    return `\`${value}\` (config.toml)`;
  }
  if (source === 'provider') {
    return `\`${value}\``;
  }
  return `\`${value}\` (${formatSettingSourceLabel(source, language)})`;
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
  progressTurnMarkDelayMs = 90_000,
  progressHeartbeatIntervalMs = 240_000,
  safeReply = async () => null,
  normalizeUiLanguage = defaultNormalizeUiLanguage,
  slashRef = (name) => `/${name}`,
  resolveModelSetting = () => ({ value: null, source: 'provider' }),
  resolveReasoningEffortSetting = () => ({ value: '', source: 'provider' }),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  truncate = defaultTruncate,
  humanElapsed = (ms) => `${ms}ms`,
  createProgressEventDeduper = () => () => false,
  buildProgressEventDedupeKey = () => '',
  presentation = {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onStreamProcessMessage = null,
  buildRunningTaskComponents = () => [],
  onParentAttention = null,
} = {}) {
  const {
    summarizeCodexEvent = () => '',
    extractRawProgressTextFromEvent = () => '',
    extractProcessNarrationFromEvent = extractRawProgressTextFromEvent,
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
    sanitizeProgressDisplayText = sanitizeDiscordDisplayText,
  } = presentation;

  return function createProgressReporter({
    message,
    channelState,
    session = null,
    language = defaultUiLanguage,
    processLines = progressProcessLines,
    initialLatestStep = '',
    onStreamProcessMessage: onStreamProcessMessageForRun = onStreamProcessMessage,
  } = {}) {
    const lang = normalizeUiLanguage(language);
    const processLineLimit = Math.max(1, Math.min(5, Number(processLines || progressProcessLines)));
    const seededLatestStep = sanitizeProgressDisplayText(
      String(initialLatestStep || '').trim() || getDefaultLatestStep(lang),
    );

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
    let heartbeatTimer = null;
    let stopped = false;
    let lastEmitAt = 0;
    let lastRendered = '';
    let events = 0;
    let latestStep = seededLatestStep;
    let latestStepAt = startedAt;
    let planState = cloneProgressPlan(channelState?.activeRun?.progressPlan);
    const completedSteps = Array.isArray(channelState?.activeRun?.completedSteps)
      ? [...channelState.activeRun.completedSteps]
      : [];
    const recentActivities = Array.isArray(channelState?.activeRun?.recentActivities)
      ? [...channelState.activeRun.recentActivities]
      : [];
    const pendingStreamActivities = [];
    const pendingCodexAgentMessages = [];
    // Holds the newest `final_answer` so a later one can retire it into the
    // process stream. Reset per run, alongside the other per-run buffers.
    const codexFinalAnswerState = { pendingFinalAnswer: '' };
    let lastActivityPushAt = 0;
    let activityPushPromise = null;
    let failedStreamActivity = null;
    let isEmitting = false;
    let rerunEmit = false;
    let observedModel = '';
    const grokProgressState = {
      textBuffer: '',
      toolCalls: new Map(),
    };
    let lastOmpStageKey = '';
    let parentAttentionNotified = false;
    const isDuplicateProgressEvent = createProgressEventDeduper({
      ttlMs: progressEventDedupeWindowMs,
      maxKeys: 700,
    });
    const claudeProgressTracker = createClaudeProgressTracker({
      truncateText: truncate,
      previewChars: progressTextPreviewChars,
    });
    const codexSubagentDisplayNameTracker = createCodexSubagentDisplayNameTracker();

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
      const effort = formatEffortValue(resolveReasoningEffortSetting(session), session?.provider, lang);
      const fastMode = formatFastModeValue(resolveFastModeSetting(session), lang);
      const model = formatModelValue(
        observedModel
          ? { value: observedModel, source: 'runtime observed' }
          : resolveModelSetting(session),
        lang,
      );
      const hint = status === 'running'
        ? (lang === 'en'
          ? 'Use `!c` to interrupt.'
          : '可用 `!c` 中断。')
        : (lang === 'en'
          ? 'Send the next message when ready.'
          : '准备好后直接发送下一条消息。');
      const statusLine = status === 'running'
        ? (lang === 'en' ? '⏳ **Task Running**' : '⏳ **任务进行中**')
        : status;
      const lines = [
        statusLine,
        `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
        `${lang === 'en' ? '• phase' : '• 阶段'}: ${phase}`,
        `${lang === 'en' ? '• model' : '• model'}: ${model}`,
        effort ? `${lang === 'en' ? '• effort' : '• effort'}: ${effort}` : null,
        fastMode ? `${lang === 'en' ? '• fast mode' : '• fast mode'}: ${fastMode}` : null,
        `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
        `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${sanitizeProgressDisplayText(latestStep)}`,
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
      let components = [];
      if (status === 'running') {
        try {
          components = buildRunningTaskComponents({
            message,
            session,
            channelState,
            language: lang,
          }) || [];
        } catch {
          components = [];
        }
      }
      return {
        content: body,
        components,
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
      const payload = buildPayload(body);
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

    // The card and the thread carry different amounts of detail. Command and
    // tool activity belongs on the card, where it is a scrolling detail view
    // that costs the user nothing; in the thread each entry is a separate
    // message, so only narration is queued for streaming.
    const appendActivity = (activityText, { stream = true } = {}) => {
      const text = String(activityText || '').replace(/\s+/g, ' ').trim();
      if (!text) return false;
      const key = normalizeActivityKey(text);
      if (!key) return false;

      const latestVisible = normalizeActivityKey(recentActivities[recentActivities.length - 1]);
      if (latestVisible && latestVisible === key) return false;
      const latestQueued = normalizeActivityKey(pendingStreamActivities[pendingStreamActivities.length - 1]);
      if (latestQueued && latestQueued === key) return false;

      appendRecentActivity(recentActivities, text);
      if (!stream) return false;
      pendingStreamActivities.push(text);
      if (pendingStreamActivities.length > 80) {
        pendingStreamActivities.splice(0, pendingStreamActivities.length - 80);
      }
      return true;
    };

    // Turn markers exist because Codex has no dependable task-level signal of
    // its own: plan updates are absent from all but a handful of sessions, and
    // agent messages are rare next to tool calls. A marker is derived from the
    // turn boundary instead, so a new thread message always means a turn began,
    // is still alive, or ended.
    //
    // Nothing is announced until the turn outlives progressTurnMarkDelayMs.
    // Most turns finish in seconds — 83.6% of an observed 3026 came in under a
    // minute — and marking those would produce a start/end pair per trivial
    // question, which is the noise the markers are meant to remove.
    const turnState = {
      startedAt: 0,
      announced: false,
      lastMessageAt: 0,
      active: false,
    };

    const markThreadMessageSent = () => {
      turnState.lastMessageAt = now();
    };

    // Stage messages are sent in arrival order and never dropped, so a long run
    // reads as a sequence of completed stages rather than one final wall of text.
    let stageDeliveryChain = Promise.resolve();
    const deliverStageMessage = (text) => {
      if (typeof onStreamProcessMessageForRun !== 'function') return Promise.resolve();
      stageDeliveryChain = stageDeliveryChain.then(async () => {
        try {
          await onStreamProcessMessageForRun(text, {
            message,
            session,
            channelState,
            language: lang,
          });
          markThreadMessageSent();
        } catch {
          // A dropped stage message must not stall the ones behind it.
        }
      });
      return stageDeliveryChain;
    };

    const formatTurnMarker = (kind) => {
      const elapsed = humanElapsed(Math.max(0, now() - (turnState.active ? turnState.startedAt : startedAt)));
      const step = sanitizeProgressDisplayText(
        truncate(String(latestStep || '').replace(/\s+/g, ' ').trim(), progressTextPreviewChars),
      );
      if (kind === 'start') {
        return lang === 'en'
          ? `▶ working (${elapsed}) — ${step}`
          : `▶ 进行中（${elapsed}）— ${step}`;
      }
      return lang === 'en'
        ? `… still working (${elapsed}) — ${step}`
        : `… 仍在进行（${elapsed}）— ${step}`;
    };

    const sendTurnMarker = (kind) => {
      if (typeof onStreamProcessMessageForRun !== 'function') return Promise.resolve();
      markThreadMessageSent();
      return deliverStageMessage(formatTurnMarker(kind));
    };

    // The heartbeat measures silence in the thread, not time since the last
    // beat: a stage answer or streamed activity is already proof of life, so it
    // resets the clock and no keepalive is sent on top of it.
    const tickTurnMarkers = () => {
      if (stopped || !turnState.active) return;
      const currentTime = now();
      // turnState.active already means beginTurn ran, so startedAt is read
      // directly: treating a falsy timestamp as "not started" would pin age to
      // zero and silence every marker.
      const age = currentTime - turnState.startedAt;
      if (!turnState.announced) {
        if (age < progressTurnMarkDelayMs) return;
        turnState.announced = true;
        void sendTurnMarker('start');
        return;
      }
      if (currentTime - turnState.lastMessageAt < progressHeartbeatIntervalMs) return;
      void sendTurnMarker('heartbeat');
    };

    const beginTurn = () => {
      turnState.startedAt = now();
      turnState.lastMessageAt = turnState.startedAt;
      turnState.announced = false;
      turnState.active = true;
    };

    // Ending a turn is deliberately silent. The turn ends when the task
    // completes, which is also when the final @-mention reply goes out, so a
    // closing marker would be a second "done" message for the same event. The
    // markers exist to prove work is still running; finishing proves itself.
    const endTurn = () => {
      if (!turnState.active) return;
      turnState.active = false;
      turnState.announced = false;
    };

    const appendPendingCodexAgentMessage = (value) => {
      const text = normalizeProgressText(value);
      const key = normalizeActivityKey(text);
      if (!key) return;
      const previous = normalizeActivityKey(pendingCodexAgentMessages[pendingCodexAgentMessages.length - 1]);
      if (previous !== key) pendingCodexAgentMessages.push(text);
    };

    const removePendingCodexAgentMessage = (value) => {
      const key = normalizeActivityKey(value);
      if (!key) return;
      for (let index = pendingCodexAgentMessages.length - 1; index >= 0; index -= 1) {
        if (normalizeActivityKey(pendingCodexAgentMessages[index]) === key) {
          pendingCodexAgentMessages.splice(index, 1);
        }
      }
    };

    const takePendingCodexAgentMessages = () => pendingCodexAgentMessages.splice(0);

    const pushOneStreamActivity = ({ force = false } = {}) => {
      if (!pendingStreamActivities.length) return Promise.resolve(false);
      if (activityPushPromise) return Promise.resolve(false);
      const currentTime = now();
      if (!force && currentTime - lastActivityPushAt < progressProcessPushIntervalMs) {
        return Promise.resolve(false);
      }
      const next = pendingStreamActivities[0];
      if (!next) return Promise.resolve(false);

      const currentPushPromise = (async () => {
        if (typeof onStreamProcessMessageForRun === 'function') {
          try {
            await onStreamProcessMessageForRun(next, { message, session, channelState, language: lang });
          } catch {
            failedStreamActivity = next;
            return false;
          }
        }
        if (pendingStreamActivities[0] === next) pendingStreamActivities.shift();
        if (failedStreamActivity === next) failedStreamActivity = null;
        lastActivityPushAt = now();
        markThreadMessageSent();
        return true;
      })();
      activityPushPromise = currentPushPromise;
      const clearCurrentPush = () => {
        if (activityPushPromise === currentPushPromise) activityPushPromise = null;
      };
      void currentPushPromise.then(clearCurrentPush, clearCurrentPush);
      return currentPushPromise;
    };

    const setLatestStep = (value, { forceEmit = true } = {}) => {
      const next = String(value || '').trim();
      if (!next) return;
      latestStep = next;
      latestStepAt = now();
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
        progressMessage = await safeReply(message, buildPayload(body));
        lastEmitAt = now();
        lastRendered = body;
        syncActiveRun();
        timer = setIntervalFn(() => {
          void emit(true);
        }, progressUpdateIntervalMs);
        timer?.unref?.();
        activityTimer = setIntervalFn(() => {
          if (stopped) return;
          void pushOneStreamActivity().then((pushed) => {
            if (!pushed || stopped) return;
            syncActiveRun();
            void emit(false);
          });
        }, progressProcessPushIntervalMs);
        activityTimer?.unref?.();
        // The run itself counts as an open turn. Providers other than Codex emit
        // no turn boundaries at all, and even Codex can start work before its
        // first task_started reaches us, so the keepalive must not depend on one.
        beginTurn();
        heartbeatTimer = setIntervalFn(() => {
          tickTurnMarkers();
        }, HEARTBEAT_TICK_MS);
        heartbeatTimer?.unref?.();
      } catch {
        progressMessage = null;
      }
    };

    const onEvent = (event) => {
      if (stopped) return;
      if (event?.type === 'turn.attention.required' && !parentAttentionNotified) {
        parentAttentionNotified = true;
        if (typeof onParentAttention === 'function') {
          void onParentAttention({ message, session, channelState, language: lang, event });
        }
      }
      let observedModelChanged = false;
      const normalizedProvider = String(session?.provider || '').trim().toLowerCase();
      if (['claude', 'cursor', 'grok', 'zcode'].includes(normalizedProvider)) {
        const nextObservedModel = extractObservedModel(event);
        if (nextObservedModel && nextObservedModel !== observedModel) {
          observedModel = nextObservedModel;
          session.lastObservedModel = nextObservedModel;
          observedModelChanged = true;
        }
      }
      if (normalizedProvider === 'grok' && !event?.[GROK_NORMALIZED_PROGRESS_EVENT]) {
        const normalizedEvents = normalizeGrokProgressEvents(event, grokProgressState);
        if (!normalizedEvents.length) {
          if (observedModelChanged) {
            syncActiveRun();
            void emit(false);
          }
          return;
        }
        for (const normalizedEvent of normalizedEvents) onEvent(normalizedEvent);
        return;
      }
      if (session?.provider === 'omp') {
        // OMP emits one message_update event per token, followed by a complete
        // message_end before a tool run. Only the complete turn is readable.
        if (isOmpTextDeltaEvent(event)) return;
        const ompTurn = extractOmpAssistantTurn(event);
        if (ompTurn) {
          if (ompTurn.continuesWithTools && ompTurn.text) {
            const safe = sanitizeProgressDisplayText(ompTurn.text);
            const key = normalizeActivityKey(safe);
            if (safe && key && key !== lastOmpStageKey) {
              lastOmpStageKey = key;
              events += 1;
              appendActivity(safe, { stream: false });
              latestStep = truncate(normalizeProgressText(safe), progressTextPreviewChars);
              latestStepAt = now();
              void deliverStageMessage(safe);
              syncActiveRun();
              void emit(false);
            }
          }
          return;
        }
      }
      if (session?.provider === 'codex') {
        // A resumed session runs many turns under one reporter, so each
        // boundary restarts the marker clock instead of leaving the whole run
        // as a single turn that never closes.
        if (isCodexTurnStartEvent(event)) beginTurn();
        else if (isCodexTurnEndEvent(event)) endTurn();
        const unphasedAgentMessage = extractUnphasedCodexAgentMessage(event);
        if (unphasedAgentMessage) {
          appendPendingCodexAgentMessage(unphasedAgentMessage);
          return;
        }
        // Phased agent messages need no buffering: the phase already says
        // whether this is narration, so stream it as soon as it arrives.
        const phasedNarration = extractCodexAgentMessageForNarration(
          event,
          codexFinalAnswerState,
        );
        if (phasedNarration) {
          const safe = sanitizeProgressDisplayText(phasedNarration);
          if (safe) {
            events += 1;
            // A retired final_answer is a completed stage of the task, not a
            // one-line activity: send it whole and unthrottled instead of
            // routing it through the process stream, which collapses newlines
            // and drops entries under its rate limit and queue cap.
            void deliverStageMessage(safe);
            latestStep = truncate(safe.replace(/\s+/g, ' ').trim(), progressTextPreviewChars);
            latestStepAt = now();
            syncActiveRun();
            void emit(false);
          }
          return;
        }
      }
      const providerProgress = session?.provider === 'claude'
        ? (claudeProgressTracker.capture(event) || null)
        : null;
      if (session?.provider !== 'claude') {
        codexSubagentDisplayNameTracker.capture(event);
      }
      const codexProgressOptions = {
        provider: normalizedProvider,
        subagentDisplayNames: codexSubagentDisplayNameTracker.snapshot(),
      };
      const summaryStep = providerProgress?.summaryStep || summarizeCodexEvent(event, codexProgressOptions);
      // The card takes the unfiltered text; the narration extractor decides only
      // whether the same entry also earns a thread message. Blocked entries are
      // tracked by text rather than by a flag, so buffered agent commentary
      // prepended below still streams even when the event carrying it does not.
      const cardOnlyActivities = new Set();
      let rawActivities = providerProgress?.rawActivities?.length
        ? providerProgress.rawActivities
        : (() => {
          const raw = extractRawProgressTextFromEvent(event, codexProgressOptions);
          if (!raw) return [];
          const narration = extractProcessNarrationFromEvent(event, codexProgressOptions);
          if (!narration) cardOnlyActivities.add(sanitizeProgressDisplayText(raw));
          return [raw];
        })();
      if (session?.provider === 'codex') {
        for (const rawActivity of rawActivities) removePendingCodexAgentMessage(rawActivity);
        if (isCodexWorkEvent(event)) {
          rawActivities = [...takePendingCodexAgentMessages(), ...rawActivities];
        } else if (isCodexTurnTerminalEvent(event)) {
          pendingCodexAgentMessages.length = 0;
        }
      }
      const nextPlan = extractPlanStateFromEvent(event);
      const completedStepsFromEvent = providerProgress?.completedSteps?.length
        ? providerProgress.completedSteps
        : (() => {
          const step = extractCompletedStepFromEvent(event, codexProgressOptions);
          return step ? [step] : [];
        })();
      const safeSummaryStep = sanitizeProgressDisplayText(summaryStep);
      const safeRawActivities = rawActivities
        .map((item) => sanitizeProgressDisplayText(item))
        .filter(Boolean);
      const safeCompletedStepsFromEvent = completedStepsFromEvent
        .map((item) => sanitizeProgressDisplayText(item))
        .filter(Boolean);
      const dedupeKey = buildProgressEventDedupeKey({
        summaryStep: safeSummaryStep,
        rawActivity: safeRawActivities.join(' || '),
        completedStep: safeCompletedStepsFromEvent.join(' || '),
        planSummary: formatProgressPlanSummary(nextPlan),
      });
      if (isDuplicateProgressEvent(dedupeKey)) {
        if (observedModelChanged) {
          syncActiveRun();
          void emit(false);
        }
        return;
      }

      events += 1;
      const promoteOptions = { currentStepAgeMs: Math.max(0, now() - latestStepAt) };
      if (shouldPromoteLatestStep(safeSummaryStep, latestStep, promoteOptions)) {
        latestStep = safeSummaryStep;
        latestStepAt = now();
      } else if (!latestStep && safeSummaryStep) {
        latestStep = safeSummaryStep;
        latestStepAt = now();
      }
      for (const rawActivity of safeRawActivities) {
        if (!rawActivity) continue;
        const appended = appendActivity(rawActivity, {
          stream: !cardOnlyActivities.has(rawActivity),
        });
        if (appended) {
          if (lastActivityPushAt === 0) {
            void pushOneStreamActivity({ force: true });
          } else {
            void pushOneStreamActivity();
          }
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
      for (const completedStep of safeCompletedStepsFromEvent) {
        if (completedStep) appendCompletedStep(completedSteps, completedStep);
      }
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
      latestStep = sanitizeProgressDisplayText(
        `${sourceLabel}: ${truncate(String(line || '').replace(/\s+/g, ' ').trim(), progressTextPreviewChars)}`,
      );
      latestStepAt = now();
      syncActiveRun();
      void emit(false);
    };

    const finish = async ({ ok = false, cancelled = false, timedOut = false, error = '' } = {}) => {
      if (stopped) return;
      if (timer) clearIntervalFn(timer);
      if (activityTimer) clearIntervalFn(activityTimer);
      if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
      // The run ends here, so the open turn is closed before the final card. A
      // turn that was never announced stays silent (see endTurn).
      turnState.active = false;
      turnState.announced = false;
      const inFlightPush = activityPushPromise;
      if (inFlightPush) {
        await inFlightPush;
        if (activityPushPromise === inFlightPush) activityPushPromise = null;
      }
      if (failedStreamActivity && pendingStreamActivities[0] === failedStreamActivity) {
        await pushOneStreamActivity({ force: true });
      }
      // Let queued stage messages land before the final card, so they cannot be
      // reordered after the reply or lost when the run ends.
      await stageDeliveryChain;
      stopped = true;
      pendingStreamActivities.length = 0;
      pendingCodexAgentMessages.length = 0;
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
        `${lang === 'en' ? '• model' : '• model'}: ${formatModelValue(
          observedModel
            ? { value: observedModel, source: 'runtime observed' }
            : resolveModelSetting(session),
          lang,
        )}`,
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
        await progressMessage.edit(buildPayload(safeBody, 'finished'));
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
