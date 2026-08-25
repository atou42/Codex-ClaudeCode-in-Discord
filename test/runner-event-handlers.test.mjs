import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleClaudeRunnerEvent,
  handleCodexRunnerEvent,
  handleCursorRunnerEvent,
  handleGrokRunnerEvent,
  handleAntigravityRunnerEvent,
  handleZCodeRunnerEvent,
  handlePiFamilyRunnerEvent,
} from '../src/runner-event-handlers.js';
import {
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from '../src/codex-event-utils.js';

test('handleCursorRunnerEvent captures the native session and decisive result event', () => {
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
  handleCursorRunnerEvent({
    type: 'system',
    subtype: 'init',
    session_id: 'cursor-session-1',
    model: 'GPT-5.6 Sol',
  }, state, (sessionId) => bridges.push(sessionId));
  handleCursorRunnerEvent({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    session_id: 'cursor-session-1',
  }, state, () => {});
  handleCursorRunnerEvent({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'CURSOR_DONE',
    session_id: 'cursor-session-1',
    usage: { inputTokens: 2, outputTokens: 3 },
  }, state, () => {});

  assert.equal(state.threadId, 'cursor-session-1');
  assert.deepEqual(bridges, ['cursor-session-1']);
  assert.deepEqual(state.messages, ['working']);
  assert.deepEqual(state.finalAnswerMessages, ['CURSOR_DONE']);
  assert.deepEqual(state.usage, { inputTokens: 2, outputTokens: 3 });
  assert.equal(state.meta.cursorSawInit, true);
  assert.equal(state.meta.cursorSawResult, true);
  assert.equal(state.meta.cursorModel, 'GPT-5.6 Sol');
});

test('handleCursorRunnerEvent preserves native result errors', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };
  handleCursorRunnerEvent({
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: 'Cursor authentication expired',
    session_id: 'cursor-session-2',
  }, state, () => {});
  assert.equal(state.meta.cursorError, 'Cursor authentication expired');
  assert.deepEqual(state.logs, ['Cursor authentication expired']);
  assert.deepEqual(state.finalAnswerMessages, []);
});

test('handlePiFamilyRunnerEvent captures session header, reasoning, final text, and usage', () => {
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

  handlePiFamilyRunnerEvent({
    type: 'session',
    id: '019abc-session',
    cwd: '/tmp/workspace',
  }, state, (sessionId) => bridges.push(sessionId));
  handlePiFamilyRunnerEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'checked the repository' },
        { type: 'text', text: 'PI_FAMILY_OK' },
      ],
      usage: { input: 12, output: 3, totalTokens: 15 },
      stopReason: 'stop',
    },
  }, state, () => {});

  assert.equal(state.threadId, '019abc-session');
  assert.deepEqual(bridges, ['019abc-session']);
  assert.deepEqual(state.reasonings, ['checked the repository']);
  assert.deepEqual(state.finalAnswerMessages, ['PI_FAMILY_OK']);
  assert.deepEqual(state.usage, { input: 12, output: 3, totalTokens: 15 });
});

test('handlePiFamilyRunnerEvent keeps tool narration out of final answers', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };

  handlePiFamilyRunnerEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Source files are ready. Building the renderer.' }],
      stopReason: 'toolUse',
    },
  }, state, () => {});
  handlePiFamilyRunnerEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Cleaning up an obsolete code block.' }],
      stopReason: 'tool_use',
    },
  }, state, () => {});
  handlePiFamilyRunnerEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
    },
  }, state, () => {});

  assert.deepEqual(state.messages, [
    'Source files are ready. Building the renderer.',
    'Cleaning up an obsolete code block.',
  ]);
  assert.deepEqual(state.finalAnswerMessages, []);
});

test('handleGrokRunnerEvent assembles streaming text and requires the end session', () => {
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
  handleGrokRunnerEvent({ type: 'thought', data: 'checking' }, state, () => {});
  handleGrokRunnerEvent({ type: 'text', data: 'GROK_' }, state, () => {});
  handleGrokRunnerEvent({ type: 'text', data: 'OK' }, state, () => {});
  handleGrokRunnerEvent({
    type: 'end',
    stopReason: 'EndTurn',
    sessionId: 'grok-session-1',
    usage: { inputTokens: 10, outputTokens: 2 },
  }, state, (sessionId) => bridges.push(sessionId));

  assert.deepEqual(state.reasonings, ['checking']);
  assert.deepEqual(state.finalAnswerMessages, ['GROK_OK']);
  assert.equal(state.threadId, 'grok-session-1');
  assert.deepEqual(bridges, ['grok-session-1']);
  assert.equal(state.meta.grokSawEnd, true);
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 2 });
});

test('handleGrokRunnerEvent separates pre-tool commentary from the final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };

  handleGrokRunnerEvent({ type: 'text', data: 'I will inspect the workspace.' }, state, () => {});
  handleGrokRunnerEvent({
    type: 'tool_call',
    toolCallId: 'call-1',
    toolName: 'run_terminal_command',
    rawInput: { command: 'pwd' },
  }, state, () => {});
  handleGrokRunnerEvent({ type: 'text', data: 'GROK_TOOL_OK' }, state, () => {});
  handleGrokRunnerEvent({
    type: 'end',
    stopReason: 'end_turn',
    sessionId: 'grok-session-2',
  }, state, () => {});

  assert.deepEqual(state.messages, ['I will inspect the workspace.']);
  assert.deepEqual(state.finalAnswerMessages, ['GROK_TOOL_OK']);
});

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

test('handleCodexRunnerEvent classifies unphased Codex 0.144 agent messages by event order', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };
  const options = {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  };

  handleCodexRunnerEvent({
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'agent_message',
      text: '准备检查当前目录的位置和其中的文件、文件夹，全程只读。',
    },
  }, state, () => {}, options);

  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.finalAnswerMessages, []);

  handleCodexRunnerEvent({
    type: 'item.started',
    item: {
      id: 'item_3',
      type: 'command_execution',
      command: "/bin/zsh -lc 'pwd && ls'",
      status: 'in_progress',
    },
  }, state, () => {}, options);

  assert.deepEqual(state.messages, ['准备检查当前目录的位置和其中的文件、文件夹，全程只读。']);
  assert.deepEqual(state.finalAnswerMessages, []);

  handleCodexRunnerEvent({
    type: 'item.completed',
    item: {
      id: 'item_4',
      type: 'agent_message',
      text: '当前目录是 `/private/tmp`。只读检查完成。',
    },
  }, state, () => {}, options);

  assert.deepEqual(state.finalAnswerMessages, []);

  handleCodexRunnerEvent({
    type: 'turn.completed',
    usage: { input_tokens: 100, output_tokens: 20 },
  }, state, () => {}, options);

  assert.deepEqual(state.messages, ['准备检查当前目录的位置和其中的文件、文件夹，全程只读。']);
  assert.deepEqual(state.finalAnswerMessages, ['当前目录是 `/private/tmp`。只读检查完成。']);
});

test('handleCodexRunnerEvent captures final answer from bridged session events', () => {
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
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: '桥接来的最终总结。',
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'response item 最终总结。' },
      ],
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: 'task complete 最终总结。',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  // Each superseded final answer is demoted to progress, so the reply is the
  // newest one rather than every phase concatenated. Accumulating them all
  // produced a 69k-character reply on a real 1h21m session.
  assert.deepEqual(state.finalAnswerMessages, ['task complete 最终总结。']);
  assert.deepEqual(state.messages, [
    '桥接来的最终总结。',
    'response item 最终总结。',
  ]);
});

test('handleCodexRunnerEvent does not promote task_complete commentary to final answer', () => {
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
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: '先看工作区和现有文档，确认 cohub 指的是项目还是产品设想。',
      phase: 'commentary',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: '',
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: '先看工作区和现有文档，确认 cohub 指的是项目还是产品设想。',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(state.messages, ['先看工作区和现有文档，确认 cohub 指的是项目还是产品设想。']);
  assert.deepEqual(state.finalAnswerMessages, []);
});

test('handleCodexRunnerEvent does not surface subagent notification blocks as final answer', () => {
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
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: [
        '第一段正常总结。',
        '<subagent_notification>',
        '{"agent_path":"019d5809","status":{"completed":"Sub 输出原文很多很多。"}}',
        '</subagent_notification>',
        '第二段正常总结。',
      ].join('\n'),
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: '<subagent_notification>{"agent_path":"019d5809"}</subagent_notification>',
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(state.finalAnswerMessages, ['第一段正常总结。\n\n第二段正常总结。']);
});

test('handleAntigravityRunnerEvent captures init, delta messages, and result stats', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      antigravityDeltaBuffer: '',
    },
  };
  const bridges = [];

  handleAntigravityRunnerEvent({
    type: 'init',
    session_id: 'agy-session-123',
  }, state, (threadId) => bridges.push(threadId));

  handleAntigravityRunnerEvent({
    type: 'message',
    role: 'assistant',
    content: 'I will inspect the repo.',
    delta: true,
  }, state, () => {});

  handleAntigravityRunnerEvent({
    type: 'result',
    stats: {
      input_tokens: 18,
      output_tokens: 7,
    },
  }, state, () => {});

  assert.deepEqual(bridges, ['agy-session-123']);
  assert.equal(state.threadId, 'agy-session-123');
  assert.equal(state.meta.antigravityDeltaBuffer, 'I will inspect the repo.');
  assert.deepEqual(state.usage, {
    input_tokens: 18,
    output_tokens: 7,
  });
});

test('handleClaudeRunnerEvent captures tool use session id and final result text', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      claudeSawAgentToolUse: false,
      claudeStopReason: '',
    },
  };
  const bridges = [];

  handleClaudeRunnerEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: {
        type: 'tool_use',
        name: 'agent',
      },
    },
  }, state, () => {});

  handleClaudeRunnerEvent({
    type: 'session.created',
    session_id: 'claude-session-1',
  }, state, (threadId) => bridges.push(threadId));

  handleClaudeRunnerEvent({
    type: 'result',
    session_id: 'claude-session-1',
    stop_reason: 'end_turn',
    usage: { input_tokens: 21, output_tokens: 8 },
    content: [
      { type: 'text', text: '结论：可以继续推进。' },
    ],
  }, state, (threadId) => bridges.push(threadId));

  assert.equal(state.meta.claudeSawAgentToolUse, true);
  assert.equal(state.meta.claudeStopReason, 'end_turn');
  assert.equal(state.threadId, 'claude-session-1');
  assert.deepEqual(state.finalAnswerMessages, ['结论：可以继续推进。']);
  assert.deepEqual(state.usage, { input_tokens: 21, output_tokens: 8 });
  assert.deepEqual(bridges, ['claude-session-1', 'claude-session-1']);
});

test('handleClaudeRunnerEvent reads real Claude assistant session messages and separates final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      claudeSawAgentToolUse: false,
      claudeStopReason: '',
    },
  };
  const bridges = [];

  handleClaudeRunnerEvent({
    type: 'assistant',
    sessionId: 'claude-session-2',
    message: {
      role: 'assistant',
      type: 'message',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先检查一下这个问题的复现路径。' },
        { type: 'tool_use', name: 'Bash' },
      ],
    },
  }, state, (threadId) => bridges.push(threadId));

  handleClaudeRunnerEvent({
    type: 'assistant',
    sessionId: 'claude-session-2',
    message: {
      role: 'assistant',
      type: 'message',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: '结论：问题出在 Claude session 最终答案被误判成过程内容。' },
      ],
    },
  }, state, (threadId) => bridges.push(threadId));

  handleClaudeRunnerEvent({
    type: 'result',
    session_id: 'claude-session-2',
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: '结论：问题出在 Claude session 最终答案被误判成过程内容。' },
    ],
  }, state, (threadId) => bridges.push(threadId));

  assert.deepEqual(state.messages, ['我先检查一下这个问题的复现路径。']);
  assert.deepEqual(state.finalAnswerMessages, ['结论：问题出在 Claude session 最终答案被误判成过程内容。']);
  assert.equal(state.threadId, 'claude-session-2');
  assert.deepEqual(bridges, ['claude-session-2', 'claude-session-2']);
});

test('handleClaudeRunnerEvent captures visible tool_result text from Claude session user events', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      claudeSawAgentToolUse: false,
      claudeStopReason: '',
    },
  };

  handleClaudeRunnerEvent({
    type: 'user',
    sessionId: 'claude-session-3',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: '## 角色卡 #1\n\n完整正文',
        },
      ],
    },
  }, state, () => {});

  assert.equal(state.threadId, 'claude-session-3');
  assert.deepEqual(state.meta.claudeToolResultMessages, ['## 角色卡 #1\n\n完整正文']);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.finalAnswerMessages, []);
});

test('handleZCodeRunnerEvent captures the aggregate headless response', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };

  handleZCodeRunnerEvent({
    sessionId: 'sess_zcode_1',
    response: 'ZCODE_DONE',
    usage: { inputTokens: 42, outputTokens: 3, totalTokens: 45 },
    projection: { status: 'idle', contextUsed: 45, contextWindow: 1000000 },
  }, state);

  assert.equal(state.threadId, 'sess_zcode_1');
  assert.deepEqual(state.finalAnswerMessages, ['ZCODE_DONE']);
  assert.deepEqual(state.usage, { inputTokens: 42, outputTokens: 3, totalTokens: 45 });
  assert.deepEqual(state.meta.zcodeProjection, { status: 'idle', contextUsed: 45, contextWindow: 1000000 });
});
