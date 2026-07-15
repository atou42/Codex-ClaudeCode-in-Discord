/**
 * Verifier result extractor for cohub_goal_verify tool
 *
 * Extracts verdict from actual tool_result.content[0].text JSON structure.
 * Validates against exact schema with closed verdict set.
 */

import { createError, deepFreeze } from './ports.js';

/**
 * Verdict values - closed set
 */
export const Verdict = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSED_USER: 'PAUSED_USER',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE'
});

/**
 * Verifier result extractor
 */
export class VerifierExtractor {
  /**
   * Extract verify result from tool_result content
   *
   * Expected shape from tool_result:
   * {
   *   toolUseId: "toolu_...",
   *   contentText: "{\"ok\":true,\"status\":\"ACHIEVED\",...}",
   *   isError: false
   * }
   *
   * The contentText is a JSON string containing the MCP tool's result.
   * For cohub_goal_verify, it contains:
   * - ok: boolean
   * - status: "ACHIEVED" (maps to DONE) | "RUNNING" | "PAUSED_USER" | "BLOCKED"
   * - Additional fields vary by status
   */
  extract(toolResult, toolName) {
    // Validate input
    if (!toolResult || typeof toolResult !== 'object') {
      throw createError('INVALID_INPUT', 'toolResult must be an object');
    }

    if (typeof toolResult.contentText !== 'string') {
      throw createError('VERIFY_MISSING',
        'tool_result has no contentText',
        { hasContentText: 'contentText' in toolResult });
    }

    // Check for error result
    if (toolResult.isError) {
      throw createError('VERIFY_MISSING',
        'tool_result indicates error',
        { contentText: toolResult.contentText.slice(0, 200) });
    }

    // Parse JSON content
    let parsed;
    try {
      parsed = JSON.parse(toolResult.contentText);
    } catch (err) {
      throw createError('STREAM_MALFORMED',
        'tool_result contentText is not valid JSON',
        { error: err.message, contentPrefix: toolResult.contentText.slice(0, 100) });
    }

    // Validate structure
    if (!parsed || typeof parsed !== 'object') {
      throw createError('STREAM_MALFORMED',
        'Parsed tool result must be an object',
        { type: typeof parsed });
    }

    // Extract status and map to verdict
    if (typeof parsed.status !== 'string') {
      throw createError('VERIFY_MISSING',
        'Verify result must have string status',
        { hasStatus: 'status' in parsed });
    }

    // Map status to verdict
    let verdict;
    if (parsed.status === 'ACHIEVED') {
      verdict = Verdict.DONE;
    } else if (parsed.status === 'RUNNING') {
      verdict = Verdict.RUNNING;
    } else if (parsed.status === 'PAUSED_USER') {
      verdict = Verdict.PAUSED_USER;
    } else if (parsed.status === 'BLOCKED') {
      verdict = Verdict.BLOCKED;
    } else {
      throw createError('VERIFY_MISSING',
        `Unknown verify status: ${parsed.status}`,
        { status: parsed.status });
    }

    // Extract required action (for RUNNING verdict)
    let requiredAction = null;
    if (verdict === Verdict.RUNNING && parsed.requiredAction) {
      if (typeof parsed.requiredAction === 'string') {
        requiredAction = parsed.requiredAction;
      }
    }

    // Extract snapshot hash if present
    const snapshotHash = parsed.snapshotHash || parsed.afterSnapshotHash || null;

    // Extract evidence refs if present
    const evidenceRefs = Array.isArray(parsed.evidenceRefs)
      ? [...parsed.evidenceRefs]
      : [];

    return deepFreeze({
      verdict,
      requiredAction,
      snapshotHash,
      evidenceRefs,
      rawResult: parsed
    });
  }

  /**
   * Check if verdict is settled (terminal for native goal)
   */
  isSettled(verdict) {
    return verdict === Verdict.DONE ||
           verdict === Verdict.PAUSED_USER ||
           verdict === Verdict.BLOCKED;
  }

  /**
   * Check if verdict is terminal for macro goal
   */
  isTerminal(verdict) {
    return verdict === Verdict.DONE;
  }
}
