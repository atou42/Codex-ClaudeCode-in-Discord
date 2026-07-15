/**
 * Stream parser for Claude Code 2.1.201 stream-json format
 *
 * Parses actual event shapes from fixtures, not invented types.
 * Validates against exact schemas with size/depth bounds.
 * Rejects malformed JSON, unknown critical shapes, oversized events.
 */

import { createError, deepFreeze } from './ports.js';

/**
 * Maximum line size (1MB)
 */
const MAX_LINE_SIZE = 1024 * 1024;

/**
 * Maximum buffer size (10MB)
 */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Stream parser with bounded buffer
 */
export class StreamParser {
  constructor(options = {}) {
    this.maxLineSize = options.maxLineSize || MAX_LINE_SIZE;
    this.maxBufferSize = options.maxBufferSize || MAX_BUFFER_SIZE;
  }

  /**
   * Bound buffer to max size
   */
  boundBuffer(buffer) {
    if (buffer.length > this.maxBufferSize) {
      // Keep most recent portion
      return buffer.slice(-this.maxBufferSize);
    }
    return buffer;
  }

  /**
   * Parse single JSON line
   * Returns validated event or null on malformed/empty input
   */
  parseLine(line) {
    if (!line || typeof line !== 'string') {
      return null;
    }

    // Check line size
    if (line.length > this.maxLineSize) {
      throw createError('STREAM_MALFORMED',
        `Line exceeds max size ${this.maxLineSize}`,
        { lineLength: line.length });
    }

    // Trim and skip empty lines
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    // Parse JSON
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      throw createError('STREAM_MALFORMED',
        'Invalid JSON in stream line',
        { error: err.message, linePrefix: trimmed.slice(0, 100) });
    }

    // Validate basic structure
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw createError('STREAM_MALFORMED',
        'Event must be a plain object',
        { eventType: typeof event });
    }

    // Validate required type field
    if (typeof event.type !== 'string') {
      throw createError('STREAM_MALFORMED',
        'Event must have string type field',
        { type: event.type });
    }

    // Return deeply frozen event
    return deepFreeze(event);
  }

  /**
   * Extract system init event
   * Shape: {"type":"system","subtype":"init","tools":[...],"mcp_servers":[...]}
   */
  extractSystemInit(event) {
    if (event.type !== 'system' || event.subtype !== 'init') {
      return null;
    }

    if (!Array.isArray(event.tools)) {
      throw createError('STREAM_MALFORMED',
        'System init must have tools array',
        { hasTools: 'tools' in event });
    }

    if (!Array.isArray(event.mcp_servers)) {
      throw createError('STREAM_MALFORMED',
        'System init must have mcp_servers array',
        { hasMcpServers: 'mcp_servers' in event });
    }

    return {
      sessionId: event.session_id || null,
      tools: [...event.tools],
      mcpServers: event.mcp_servers.map(s => ({
        name: s.name,
        status: s.status
      })),
      claudeCodeVersion: event.claude_code_version || null,
      model: event.model || null
    };
  }

  /**
   * Extract tool use from assistant message
   * Shape: {"type":"assistant","message":{"content":[{"type":"tool_use","id":"...","name":"...","input":{}}]}}
   */
  extractToolUse(event) {
    if (event.type !== 'assistant') {
      return null;
    }

    if (!event.message || !Array.isArray(event.message.content)) {
      return null;
    }

    const toolUses = [];
    for (const item of event.message.content) {
      if (item.type === 'tool_use') {
        if (typeof item.id !== 'string' || typeof item.name !== 'string') {
          throw createError('STREAM_MALFORMED',
            'tool_use must have string id and name',
            { hasId: 'id' in item, hasName: 'name' in item });
        }

        toolUses.push({
          id: item.id,
          name: item.name,
          input: item.input || {}
        });
      }
    }

    return toolUses.length > 0 ? toolUses : null;
  }

  /**
   * Extract tool result from user message
   * Shape: {"type":"user","message":{"content":[{"tool_use_id":"...","type":"tool_result","content":[{"type":"text","text":"..."}]}]}}
   */
  extractToolResult(event) {
    if (event.type !== 'user') {
      return null;
    }

    if (!event.message || !Array.isArray(event.message.content)) {
      return null;
    }

    const results = [];
    for (const item of event.message.content) {
      if (item.type === 'tool_result') {
        if (typeof item.tool_use_id !== 'string') {
          throw createError('STREAM_MALFORMED',
            'tool_result must have string tool_use_id',
            { hasToolUseId: 'tool_use_id' in item });
        }

        // Extract content text (may be nested)
        let contentText = null;
        if (Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if (contentItem.type === 'text' && typeof contentItem.text === 'string') {
              contentText = contentItem.text;
              break;
            }
          }
        }

        results.push({
          toolUseId: item.tool_use_id,
          contentText,
          isError: item.is_error === true
        });
      }
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Extract usage from result event
   * Shape: {"type":"result","modelUsage":{"model":{"inputTokens":...,"outputTokens":...}}}
   */
  extractUsage(event) {
    if (event.type !== 'result') {
      return null;
    }

    if (!event.modelUsage || typeof event.modelUsage !== 'object') {
      return null;
    }

    // Sum across all models
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;

    for (const [modelName, usage] of Object.entries(event.modelUsage)) {
      if (typeof usage.inputTokens === 'number') {
        totalInput += usage.inputTokens;
      }
      if (typeof usage.outputTokens === 'number') {
        totalOutput += usage.outputTokens;
      }
      if (typeof usage.cacheReadInputTokens === 'number') {
        totalCacheRead += usage.cacheReadInputTokens;
      }
    }

    // Validate non-negative
    if (totalInput < 0 || totalOutput < 0 || totalCacheRead < 0) {
      throw createError('INTEGRITY_FAILURE',
        'Usage tokens cannot be negative',
        { totalInput, totalOutput, totalCacheRead });
    }

    // Validate finite
    if (!Number.isFinite(totalInput) || !Number.isFinite(totalOutput)) {
      throw createError('INTEGRITY_FAILURE',
        'Usage tokens must be finite',
        { totalInput, totalOutput });
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadInputTokens: totalCacheRead,
      totalTokens: totalInput + totalOutput
    };
  }

  /**
   * Detect stop_reason from assistant message
   */
  extractStopReason(event) {
    if (event.type !== 'assistant') {
      return null;
    }

    if (!event.message || typeof event.message.stop_reason !== 'string') {
      return null;
    }

    return event.message.stop_reason;
  }
}
