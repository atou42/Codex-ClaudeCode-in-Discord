/**
 * Tests for stream parser using actual Claude 2.1.201 fixtures
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamParser } from '../../src/cohub-claude-goal/stream-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to actual fixtures
const FIXTURE_BASE = '/Users/atou/agents-in-discord/workspaces/1526545136463515648/deliverables/cohub-goal-capability-evidence/CAP-GOAL-01-02';

describe('StreamParser with real fixtures', { timeout: 10000 }, () => {

  it('should parse actual bootstrap-stream.jsonl', async () => {
    const content = await readFile(path.join(FIXTURE_BASE, 'bootstrap-stream.jsonl'), 'utf8');
    const lines = content.trim().split('\n');

    const parser = new StreamParser();
    const events = [];

    for (const line of lines) {
      const event = parser.parseLine(line);
      if (event) events.push(event);
    }

    assert.ok(events.length > 0, 'Should parse at least one event');

    // First event should be system init
    const init = parser.extractSystemInit(events[0]);
    assert.ok(init, 'First event should be system init');
    assert.strictEqual(init.sessionId, '0db97e8e-1ade-4862-9c48-7566958980f7');
    assert.ok(Array.isArray(init.tools), 'Should have tools array');
    assert.ok(init.tools.length > 0, 'Should have at least one tool');
  });

  it('should extract tool_use from assistant message', async () => {
    const content = await readFile(path.join(FIXTURE_BASE, 'bootstrap-stream.jsonl'), 'utf8');
    const lines = content.trim().split('\n');

    const parser = new StreamParser();
    let foundToolUse = false;

    for (const line of lines) {
      const event = parser.parseLine(line);
      if (!event) continue;

      const toolUses = parser.extractToolUse(event);
      if (toolUses && toolUses.length > 0) {
        foundToolUse = true;
        assert.strictEqual(typeof toolUses[0].id, 'string');
        assert.strictEqual(typeof toolUses[0].name, 'string');
        assert.ok(toolUses[0].name.startsWith('mcp__fixture__'));
        break;
      }
    }

    assert.ok(foundToolUse, 'Should find at least one tool_use');
  });

  it('should extract tool_result from user message', async () => {
    const content = await readFile(path.join(FIXTURE_BASE, 'bootstrap-stream.jsonl'), 'utf8');
    const lines = content.trim().split('\n');

    const parser = new StreamParser();
    let foundToolResult = false;

    for (const line of lines) {
      const event = parser.parseLine(line);
      if (!event) continue;

      const results = parser.extractToolResult(event);
      if (results && results.length > 0) {
        foundToolResult = true;
        assert.strictEqual(typeof results[0].toolUseId, 'string');
        assert.strictEqual(typeof results[0].contentText, 'string');
        break;
      }
    }

    assert.ok(foundToolResult, 'Should find at least one tool_result');
  });

  it('should extract usage from result event', async () => {
    const content = await readFile(path.join(FIXTURE_BASE, 'resume-stream.jsonl'), 'utf8');
    const lines = content.trim().split('\n');

    const parser = new StreamParser();
    let foundUsage = false;

    for (const line of lines) {
      const event = parser.parseLine(line);
      if (!event) continue;

      const usage = parser.extractUsage(event);
      if (usage) {
        foundUsage = true;
        assert.ok(usage.inputTokens >= 0, 'Input tokens should be non-negative');
        assert.ok(usage.outputTokens >= 0, 'Output tokens should be non-negative');
        assert.ok(Number.isFinite(usage.totalTokens), 'Total tokens should be finite');
        break;
      }
    }

    assert.ok(foundUsage, 'Should find usage in result event');
  });

  it('should reject malformed JSON', () => {
    const parser = new StreamParser();

    assert.throws(() => {
      parser.parseLine('{invalid json}');
    }, (err) => {
      return err.code === 'STREAM_MALFORMED';
    });
  });

  it('should reject oversized lines', () => {
    const parser = new StreamParser({ maxLineSize: 100 });
    const longLine = '{"type":"test","data":"' + 'x'.repeat(200) + '"}';

    assert.throws(() => {
      parser.parseLine(longLine);
    }, /exceeds max size/);
  });

  it('should bound buffer size', () => {
    const parser = new StreamParser({ maxBufferSize: 1000 });
    const largeBuffer = 'x'.repeat(2000);

    const bounded = parser.boundBuffer(largeBuffer);
    assert.strictEqual(bounded.length, 1000);
    assert.strictEqual(bounded, largeBuffer.slice(-1000));
  });

  it('should return null for empty lines', () => {
    const parser = new StreamParser();

    assert.strictEqual(parser.parseLine(''), null);
    assert.strictEqual(parser.parseLine('   '), null);
    assert.strictEqual(parser.parseLine('\n'), null);
  });

  it('should deep freeze parsed events', () => {
    const parser = new StreamParser();
    const event = parser.parseLine('{"type":"test","data":{"nested":"value"}}');

    assert.ok(Object.isFrozen(event), 'Event should be frozen');
    assert.ok(Object.isFrozen(event.data), 'Nested data should be frozen');

    assert.throws(() => {
      event.type = 'modified';
    }, /Cannot assign/);
  });

  it('should extract verify tool result from resume stream', async () => {
    const content = await readFile(path.join(FIXTURE_BASE, 'resume-stream.jsonl'), 'utf8');
    const lines = content.trim().split('\n');

    const parser = new StreamParser();
    let foundVerifyResult = false;

    for (const line of lines) {
      const event = parser.parseLine(line);
      if (!event) continue;

      const results = parser.extractToolResult(event);
      if (!results) continue;

      for (const result of results) {
        if (result.contentText && result.contentText.includes('ACHIEVED')) {
          foundVerifyResult = true;

          // Parse the content to verify structure
          const parsed = JSON.parse(result.contentText);
          assert.strictEqual(parsed.ok, true);
          assert.strictEqual(parsed.status, 'ACHIEVED');
          assert.ok(parsed.macroGoalHash);
          break;
        }
      }

      if (foundVerifyResult) break;
    }

    assert.ok(foundVerifyResult, 'Should find verify result with ACHIEVED status');
  });
});
