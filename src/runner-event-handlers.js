import { createClaudeProviderAdapter } from './providers/claude.js';
import { createCodexProviderAdapter } from './providers/codex.js';
import { createCursorProviderAdapter } from './providers/cursor.js';
import { createGrokProviderAdapter } from './providers/grok.js';
import { createAntigravityProviderAdapter } from './providers/antigravity.js';
import { createZCodeProviderAdapter } from './providers/zcode.js';
import { createPiProviderAdapter } from './providers/pi.js';
import { createOmpProviderAdapter } from './providers/omp.js';
import { createProviderAdapterRegistry } from './providers/index.js';
import {
  extractUnphasedCodexAgentMessage,
  isCodexTurnTerminalEvent,
  isCodexWorkEvent,
} from './codex-event-utils.js';

export function createRunnerEventParser({
  normalizeProvider = (value) => String(value || '').trim().toLowerCase(),
  extractAgentMessageText = () => '',
  isFinalAnswerLikeAgentMessage = () => true,
} = {}) {
  const providerAdapters = createProviderAdapterRegistry([
    createCodexProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleCodexRunnerEvent(event, state, ensureSessionBridge, {
        extractAgentMessageText,
        isFinalAnswerLikeAgentMessage,
      }),
    }),
    createClaudeProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleClaudeRunnerEvent(event, state, ensureSessionBridge),
    }),
    createCursorProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleCursorRunnerEvent(event, state, ensureSessionBridge),
    }),
    createGrokProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleGrokRunnerEvent(event, state, ensureSessionBridge),
    }),
    createAntigravityProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handleAntigravityRunnerEvent(event, state, ensureSessionBridge),
    }),
    createZCodeProviderAdapter({
      parseEvent: (event, state) => handleZCodeRunnerEvent(event, state),
    }),
    createPiProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handlePiFamilyRunnerEvent(event, state, ensureSessionBridge),
    }),
    createOmpProviderAdapter({
      parseEvent: (event, state, ensureSessionBridge) => handlePiFamilyRunnerEvent(event, state, ensureSessionBridge),
    }),
  ]);

  return function handleRunnerEvent(provider, event, state, ensureSessionBridge) {
    const adapter = providerAdapters.get(normalizeProvider(provider));
    adapter.runtime.parseEvent(event, state, ensureSessionBridge);
  };
}

export function handleCursorRunnerEvent(event, state, ensureSessionBridge = () => {}) {
  const eventType = String(event?.type || '').trim().toLowerCase();
  const sessionId = String(event?.session_id || event?.sessionId || '').trim();
  if (sessionId) {
    state.threadId = sessionId;
    ensureSessionBridge(sessionId);
  }

  if (eventType === 'system' && String(event?.subtype || '').trim().toLowerCase() === 'init') {
    state.meta.cursorSawInit = true;
    const model = String(event?.model || '').trim();
    if (model) state.meta.cursorModel = model;
    return;
  }

  if (eventType === 'assistant') {
    const text = extractCursorMessageText(event?.message);
    if (text) appendUniqueText(state.messages, text);
    return;
  }

  if (eventType !== 'result') return;
  state.meta.cursorSawResult = true;
  const subtype = String(event?.subtype || '').trim().toLowerCase();
  const isError = event?.is_error === true || subtype !== 'success';
  if (isError) {
    const error = String(event?.error || event?.result || event?.message || 'Cursor Agent returned an error').trim();
    state.meta.cursorError = error;
    state.logs.push(error);
    return;
  }

  const text = String(event?.result || '').trim();
  if (text) appendUniqueText(state.finalAnswerMessages, text);
  if (event?.usage && typeof event.usage === 'object') state.usage = event.usage;
}

function extractCursorMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (String(part?.type || '').trim().toLowerCase() !== 'text') continue;
    const text = String(part?.text || '').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

export function handleGrokRunnerEvent(event, state, ensureSessionBridge = () => {}) {
  const eventType = String(event?.type || '').trim().toLowerCase();
  if (eventType === 'text') {
    state.meta.grokCurrentTextBuffer = `${state.meta.grokCurrentTextBuffer || ''}${String(event?.data || '')}`;
    return;
  }
  if (eventType === 'thought') {
    const text = String(event?.data || '').trim();
    if (text) appendUniqueText(state.reasonings, text);
    return;
  }
  if (eventType === 'error') {
    const message = String(event?.message || event?.data || 'Grok runner returned an error').trim();
    state.meta.grokError = message;
    state.logs.push(message);
    return;
  }
  if (eventType === 'tool_call') {
    const commentary = String(state.meta.grokCurrentTextBuffer || '').trim();
    if (commentary) appendUniqueText(state.messages, commentary);
    state.meta.grokCurrentTextBuffer = '';
    state.meta.grokSawToolCall = true;
    return;
  }
  if (eventType !== 'end') return;

  state.meta.grokSawEnd = true;
  const sessionId = String(event?.sessionId || event?.session_id || '').trim();
  if (sessionId) {
    state.threadId = sessionId;
    ensureSessionBridge(sessionId);
  }
  const text = String(state.meta.grokCurrentTextBuffer || '').trim();
  const stopReason = String(event?.stopReason || event?.stop_reason || '').trim();
  if (text && isSuccessfulGrokStopReason(stopReason)) appendUniqueText(state.finalAnswerMessages, text);
  if (event?.usage && typeof event.usage === 'object') state.usage = event.usage;
  state.meta.grokStopReason = stopReason;
}

export function normalizeGrokStopReason(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function isSuccessfulGrokStopReason(value) {
  return ['endturn', 'stop', 'complete', 'completed'].includes(normalizeGrokStopReason(value));
}

export function handlePiFamilyRunnerEvent(event, state, ensureSessionBridge = () => {}) {
  const eventType = String(event?.type || '').trim().toLowerCase();
  if (eventType === 'session') {
    const sessionId = String(event?.id || event?.sessionId || event?.session_id || '').trim();
    if (sessionId) {
      state.threadId = sessionId;
      state.meta.piFamilySawSession = true;
      ensureSessionBridge(sessionId);
    }
    return;
  }

  if (eventType !== 'message_end') return;
  const message = event?.message;
  if (!message || String(message.role || '').trim().toLowerCase() !== 'assistant') return;
  state.meta.piFamilyAssistantEnded = true;

  const stopReason = normalizePiFamilyStopReason(message.stopReason || message.stop_reason);
  state.meta.piFamilyStopReason = stopReason;
  const continuesWithTools = stopReason === 'tooluse';
  if (!continuesWithTools) state.meta.piFamilySawTerminalAssistant = true;
  if (stopReason === 'error') {
    const error = String(message.errorMessage || message.error_message || 'Pi-family model request failed').trim();
    state.meta.piFamilyError = error;
    state.logs.push(error);
  }

  const textParts = [];
  const thinkingParts = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    const type = String(part?.type || '').trim().toLowerCase();
    if (type === 'text') {
      const text = String(part?.text || '').trim();
      if (text) textParts.push(text);
    } else if (type === 'thinking') {
      const thinking = String(part?.thinking || part?.text || '').trim();
      if (thinking) thinkingParts.push(thinking);
    }
  }
  for (const thinking of thinkingParts) appendUniqueText(state.reasonings, thinking);
  const text = textParts.join('\n\n').trim();
  if (text && continuesWithTools) appendUniqueText(state.messages, text);
  else if (text && stopReason === 'stop') appendUniqueText(state.finalAnswerMessages, text);
  else if (text) appendUniqueText(state.messages, text);
  if (message.usage && typeof message.usage === 'object') state.usage = message.usage;
}

function normalizePiFamilyStopReason(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function handleZCodeRunnerEvent(event, state) {
  const sessionId = String(event?.sessionId || '').trim();
  if (sessionId) state.threadId = sessionId;

  const response = String(event?.response || '').trim();
  if (response) appendUniqueText(state.finalAnswerMessages, response);
  if (event?.usage && typeof event.usage === 'object') state.usage = event.usage;
  if (event?.projection && typeof event.projection === 'object') {
    state.meta.zcodeProjection = event.projection;
  }
}

export function handleCodexRunnerEvent(event, state, ensureSessionBridge, {
  extractAgentMessageText = () => '',
  isFinalAnswerLikeAgentMessage = () => true,
} = {}) {
  const eventType = String(event?.type || '').trim();
  if ((eventType === 'event_msg' || eventType === 'response_item') && event?.payload && typeof event.payload === 'object') {
    return handleCodexRunnerEvent(event.payload, state, ensureSessionBridge, {
      extractAgentMessageText,
      isFinalAnswerLikeAgentMessage,
    });
  }

  if (isCodexWorkEvent(event)) {
    flushPendingCodexAgentMessages(state, state.messages);
  }

  switch (event.type) {
    case 'thread.started':
    case 'thread.created':
    case 'thread.resumed':
      state.threadId = event.thread_id || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'item.completed':
    case 'item.delta':
    case 'item.updated': {
      const item = event.item;
      const itemType = String(item?.type || '').trim().toLowerCase();
      if (itemType === 'reasoning') {
        const text = String(item?.text || item?.summary || '').trim();
        if (text) state.reasonings.push(text);
        break;
      }
      if (!['agent_message', 'assistant_message', 'message'].includes(itemType)) break;
      const text = extractAgentMessageText(item);
      if (!text) break;
      const unphasedText = extractUnphasedCodexAgentMessage(event);
      if (unphasedText) {
        appendPendingCodexAgentMessage(state, unphasedText);
        break;
      }
      if (isFinalAnswerLikeAgentMessage(item)) appendCodexFinalAnswer(state, text);
      else appendUniqueText(state.messages, text);
      break;
    }
    case 'assistant.message.delta':
    case 'assistant.message': {
      const text = extractAgentMessageText(event);
      if (!text) break;
      if (isFinalAnswerLikeAgentMessage(event)) appendUniqueText(state.finalAnswerMessages, text);
      else appendUniqueText(state.messages, text);
      break;
    }
    case 'agent_message':
    case 'assistant_message':
    case 'message': {
      // `response_item/message` replays the whole conversation, user turns
      // included (observed: 127 user + 8 developer entries in one session).
      // Only assistant turns are the agent speaking; without this the reply
      // could end up being the user's own prompt echoed back.
      const role = String(event?.role || '').trim().toLowerCase();
      if (role && role !== 'assistant') break;
      const text = extractAgentMessageText(event);
      if (!text) break;
      if (isFinalAnswerLikeAgentMessage(event)) appendCodexFinalAnswer(state, text);
      else appendUniqueText(state.messages, text);
      break;
    }
    case 'task_complete': {
      const text = String(event.last_agent_message || '').trim();
      if (matchesAnyComparableText(state.messages, text)) break;
      if (text) appendCodexFinalAnswer(state, text);
      break;
    }
    case 'reasoning.delta':
    case 'reasoning': {
      const text = String(event.text || '').trim();
      if (text) state.reasonings.push(text);
      break;
    }
    case 'usage':
      state.usage = event;
      break;
    case 'turn.completed':
      flushPendingCodexAgentMessages(state, state.finalAnswerMessages);
      state.usage = event;
      break;
    case 'turn.failed':
    case 'turn.cancelled':
      flushPendingCodexAgentMessages(state, state.messages);
      break;
    default:
      if (isCodexTurnTerminalEvent(event)) clearPendingCodexAgentMessages(state);
      break;
  }
}

export function handleAntigravityRunnerEvent(event, state, ensureSessionBridge) {
  switch (String(event?.type || '').trim().toLowerCase()) {
    case 'init':
      state.threadId = event.session_id || event.sessionId || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'message': {
      if (String(event.role || '').trim().toLowerCase() !== 'assistant') break;
      const text = String(event.content || '');
      if (!text) break;
      if (event.delta === true) {
        state.meta.antigravityDeltaBuffer = `${state.meta.antigravityDeltaBuffer || ''}${text}`;
      } else {
        state.messages.push(text.trim());
      }
      break;
    }
    case 'result':
      state.usage = event.stats && typeof event.stats === 'object' ? event.stats : event;
      break;
    default:
      break;
  }
}

export function handleClaudeRunnerEvent(event, state, ensureSessionBridge) {
  switch (event.type) {
    case 'stream_event': {
      const block = event.event?.content_block;
      if (event.event?.type === 'content_block_start' && block?.type === 'tool_use') {
        const toolName = String(block.name || '').trim().toLowerCase();
        if (toolName === 'agent') state.meta.claudeSawAgentToolUse = true;
      }
      break;
    }
    case 'session.created':
    case 'session.resumed':
      state.threadId = event.session_id || event.sessionId || state.threadId;
      if (state.threadId) ensureSessionBridge(state.threadId);
      break;
    case 'user': {
      appendClaudeToolResultText(state, event);
      const nextThreadId = event.session_id || event.sessionId || state.threadId;
      if (nextThreadId && nextThreadId !== state.threadId) {
        state.threadId = nextThreadId;
        ensureSessionBridge(state.threadId);
      }
      break;
    }
    case 'message':
    case 'assistant': {
      appendClaudeToolResultText(state, event);
      const text = extractClaudeText(event);
      if (!text) break;
      if (isClaudeFinalAnswerEvent(event)) appendUniqueText(state.finalAnswerMessages, text);
      else appendUniqueText(state.messages, text);
      const nextThreadId = event.session_id || event.sessionId || state.threadId;
      if (nextThreadId && nextThreadId !== state.threadId) {
        state.threadId = nextThreadId;
        ensureSessionBridge(state.threadId);
      }
      break;
    }
    case 'result': {
      const text = extractClaudeText(event);
      if (text) appendUniqueText(state.finalAnswerMessages, text);
      state.meta.claudeStopReason = extractClaudeStopReason(event);
      const nextThreadId = event.session_id || event.sessionId || state.threadId;
      if (nextThreadId) {
        state.threadId = nextThreadId;
        ensureSessionBridge(state.threadId);
      }
      if (event.usage) state.usage = event.usage;
      break;
    }
    default:
      break;
  }
}

function appendUniqueText(list, text) {
  const next = String(text || '').trim();
  if (!next) return;
  const previous = String(list?.[list.length - 1] || '').trim();
  if (normalizeComparableText(previous) === normalizeComparableText(next)) return;
  list.push(next);
}

// Long `codex exec resume` sessions label nearly every agent_message
// `phase: "final_answer"` — 118 of them in one observed 1h21m run. Appending
// each one built a 69k-character reply that concatenated the whole session
// transcript. Only the newest is the actual answer; the ones it supersedes were
// mid-task updates, so they move to `messages` (progress) instead.
function appendCodexFinalAnswer(state, text) {
  const next = String(text || '').trim();
  if (!next) return;
  const list = Array.isArray(state.finalAnswerMessages) ? state.finalAnswerMessages : [];
  const previous = String(list[list.length - 1] || '').trim();
  if (previous && normalizeComparableText(previous) === normalizeComparableText(next)) return;
  if (previous) {
    list.pop();
    appendUniqueText(state.messages, previous);
  }
  list.push(next);
  state.finalAnswerMessages = list;
}

function appendPendingCodexAgentMessage(state, text) {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!Array.isArray(state.meta.pendingCodexAgentMessages)) {
    state.meta.pendingCodexAgentMessages = [];
  }
  appendUniqueText(state.meta.pendingCodexAgentMessages, text);
}

function flushPendingCodexAgentMessages(state, target) {
  const pending = Array.isArray(state?.meta?.pendingCodexAgentMessages)
    ? state.meta.pendingCodexAgentMessages
    : [];
  for (const text of pending) appendUniqueText(target, text);
  clearPendingCodexAgentMessages(state);
}

function clearPendingCodexAgentMessages(state) {
  if (!state?.meta || typeof state.meta !== 'object') return;
  delete state.meta.pendingCodexAgentMessages;
}

function normalizeComparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesAnyComparableText(list, text) {
  const normalized = normalizeComparableText(text);
  if (!normalized) return false;
  if (!Array.isArray(list)) return false;
  return list.some((item) => normalizeComparableText(item) === normalized);
}

function appendClaudeToolResultText(state, event) {
  const text = extractClaudeToolResultText(event);
  if (!text) return;
  if (!state.meta || typeof state.meta !== 'object') {
    state.meta = {};
  }
  if (!Array.isArray(state.meta.claudeToolResultMessages)) {
    state.meta.claudeToolResultMessages = [];
  }
  appendUniqueText(state.meta.claudeToolResultMessages, text);
}

function extractClaudeToolResultText(event) {
  const parts = collectClaudeToolResultParts([
    event?.message,
    event?.content,
    event?.result,
  ]);
  return parts.join('\n\n').trim();
}

function collectClaudeToolResultParts(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectClaudeToolResultParts(item));
  if (typeof value !== 'object') return [];

  const type = String(value.type || '').trim().toLowerCase();
  const parts = [];

  if (type === 'tool_result') {
    parts.push(...collectClaudeTextParts([
      value.content,
      value.text,
      value.output_text,
      value.input_text,
      value.stdout,
      value.stderr,
      value.message,
    ]));
  }

  if (value.message && typeof value.message === 'object') {
    parts.push(...collectClaudeToolResultParts(value.message));
  }
  if (Array.isArray(value.content)) {
    parts.push(...collectClaudeToolResultParts(value.content));
  }
  if (value.result && typeof value.result === 'object') {
    parts.push(...collectClaudeToolResultParts(value.result));
  }

  return parts;
}

function collectClaudeTextParts(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectClaudeTextParts(item));
  }
  if (typeof value !== 'object') return [];

  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'tool_use' || type === 'tool_result' || type === 'server_tool_use' || type === 'thinking') {
    return [];
  }

  const parts = [
    ...collectClaudeTextParts(value.text),
    ...collectClaudeTextParts(value.output_text),
    ...collectClaudeTextParts(value.input_text),
    ...collectClaudeTextParts(value.reasoning_text),
  ];

  if (typeof value.message === 'string') {
    parts.push(...collectClaudeTextParts(value.message));
  } else if (value.message && typeof value.message === 'object') {
    parts.push(...collectClaudeTextParts(value.message));
  }

  if (Array.isArray(value.content)) {
    parts.push(...collectClaudeTextParts(value.content));
  }

  return parts;
}

function extractClaudeStopReason(event) {
  const candidates = [
    event?.stop_reason,
    event?.stopReason,
    event?.message?.stop_reason,
    event?.message?.stopReason,
    event?.result?.stop_reason,
    event?.result?.stopReason,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  return '';
}

function isClaudeFinalAnswerEvent(event) {
  return extractClaudeStopReason(event).toLowerCase() === 'end_turn';
}

function extractClaudeText(event) {
  if (!event || typeof event !== 'object') return '';
  const parts = collectClaudeTextParts([
    event.text,
    event.message,
    event.content,
    event.result,
  ]);
  return parts.join('\n\n').trim();
}
