/**
 * @fileoverview Adversarial tests for MCP server boundary (lines 210-280 spec).
 * Tests exact tool schemas, malformed messages, extra tools, response injection,
 * unknown/accessor/symbol/dangerous field rejection, redacted responses, bounded output.
 * RED phase: all tests must fail initially.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Mock dependencies for injection testing
const createMockDeps = () => ({
  inspect: async (goalInstance) => ({
    goalInstance,
    snapshotHash: 'abc123',
    localState: 'READY',
    unconsumedEvents: [],
    allowedDecisions: ['CONTINUE'],
    actionSlot: {
      actionSlotId: 'slot-1',
      continuationId: 'cont-1',
      expectedParentSequence: 1,
      expectedInputWatermark: 0
    }
  }),
  submit: async (params) => ({ success: true }),
  wait: async (params) => ({ snapshotHash: 'xyz789' }),
  verify: async (goalInstance) => ({ verdict: 'RUNNING' })
});

test('MCP server boundary - tool schema validation', async (t) => {
  await t.test('rejects inspect with missing goalInstance', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {}
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /goalInstance.*required/i);
  });

  await t.test('rejects inspect with extra unknown fields', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {
          goalInstance: 'test-goal',
          unknownField: 'should-fail',
          anotherExtra: 123
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /unknown field/i);
  });

  await t.test('rejects submit with missing required fields', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test-goal'
          // Missing: expectedSnapshotHash, actionSlotId, continuationId, decisionCode, evidenceRefs
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /required/i);
  });

  await t.test('rejects wait with missing watchSet', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test-goal',
          expectedSnapshotHash: 'abc123'
          // Missing watchSet
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /watchSet.*required/i);
  });
});

test('MCP server boundary - dangerous field rejection', async (t) => {
  await t.test('rejects __proto__ in arguments', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {
          goalInstance: 'test-goal',
          __proto__: { polluted: true }
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /dangerous.*proto/i);
  });

  await t.test('rejects constructor in arguments', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {
          goalInstance: 'test-goal',
          constructor: { polluted: true }
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /dangerous.*constructor/i);
  });

  await t.test('rejects prototype in arguments', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {
          goalInstance: 'test-goal',
          prototype: { polluted: true }
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /dangerous.*prototype/i);
  });
});

test('MCP server boundary - accessor and symbol rejection', async (t) => {
  await t.test('rejects arguments with getters', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const args = {
      goalInstance: 'test-goal'
    };
    Object.defineProperty(args, 'malicious', {
      get() { throw new Error('Getter executed!'); },
      enumerable: true
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: args
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /accessor.*not allowed/i);
  });

  await t.test('rejects arguments with setters', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const args = {
      goalInstance: 'test-goal'
    };
    Object.defineProperty(args, 'malicious', {
      set(v) { throw new Error('Setter executed!'); },
      enumerable: true
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: args
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /accessor.*not allowed/i);
  });

  await t.test('rejects arguments with symbol keys', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const sym = Symbol('malicious');
    const args = {
      goalInstance: 'test-goal',
      [sym]: 'should-fail'
    };

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: args
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /symbol.*not allowed/i);
  });
});

test('MCP server boundary - malformed MCP messages', async (t) => {
  await t.test('rejects request without method', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /method.*required/i);
  });

  await t.test('rejects tools/call without name', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /name.*required/i);
  });

  await t.test('rejects tools/call without arguments', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect'
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /arguments.*required/i);
  });
});

test('MCP server boundary - extra tools rejection', async (t) => {
  await t.test('rejects unknown tool name', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_extra_tool',
        arguments: {}
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /unknown tool/i);
  });

  await t.test('tools/list returns exactly 4 tools', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = { method: 'tools/list' };
    const response = await server.handleRequest(request);

    assert.equal(response.tools.length, 4);
    const names = response.tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'cohub_goal_inspect',
      'cohub_goal_submit',
      'cohub_goal_verify',
      'cohub_goal_wait'
    ]);
  });
});

test('MCP server boundary - response redaction', async (t) => {
  await t.test('redacts access tokens from responses', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        accessToken: 'secret-token-should-be-redacted',
        refreshToken: 'refresh-secret',
        localState: 'READY'
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    const responseText = JSON.stringify(response);

    assert.equal(responseText.includes('secret-token'), false);
    assert.equal(responseText.includes('refresh-secret'), false);
  });

  await t.test('redacts environment variables from responses', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        env: { SECRET_KEY: 'should-be-redacted' },
        localState: 'READY'
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    const responseText = JSON.stringify(response);

    assert.equal(responseText.includes('SECRET_KEY'), false);
    assert.equal(responseText.includes('should-be-redacted'), false);
  });

  await t.test('redacts raw HTTP body from responses', async () => {
    const mockDeps = {
      ...createMockDeps(),
      verify: async () => ({
        verdict: 'RUNNING',
        _rawBody: 'internal http response body',
        _httpHeaders: { 'x-secret': 'value' }
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_verify',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    const responseText = JSON.stringify(response);

    assert.equal(responseText.includes('_rawBody'), false);
    assert.equal(responseText.includes('_httpHeaders'), false);
  });
});

test('MCP server boundary - bounded output', async (t) => {
  await t.test('limits response size to prevent memory exhaustion', async () => {
    const hugeString = 'x'.repeat(10 * 1024 * 1024); // 10MB
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        hugeField: hugeString,
        localState: 'READY'
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    const responseText = JSON.stringify(response);

    // Response should be truncated or rejected, not 10MB
    assert.equal(responseText.length < 1024 * 1024, true, 'Response exceeds 1MB limit');
  });

  await t.test('limits array response lengths', async () => {
    const hugeArray = Array(100000).fill('item');
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        unconsumedEvents: hugeArray,
        localState: 'READY'
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);

    // Should truncate array or reject
    if (!response.isError) {
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.unconsumedEvents.length < 10000, true);
    }
  });
});

test('MCP server boundary - typed errors', async (t) => {
  await t.test('returned objects are deeply frozen and descriptor-safe', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    // Success response
    const successResponse = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    assert.equal(Object.isFrozen(successResponse), true, 'response must be frozen');
    assert.equal(Object.isFrozen(successResponse.content), true, 'content array must be frozen');
    assert.equal(Object.isFrozen(successResponse.content[0]), true, 'content items must be frozen');

    // No accessor descriptors anywhere in the response
    const checkDescriptors = (obj, path = 'response') => {
      if (obj === null || typeof obj !== 'object') return;
      for (const key of Object.getOwnPropertyNames(obj)) {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        assert.equal(desc.get, undefined, `${path}.${key} must not have getter`);
        assert.equal(desc.set, undefined, `${path}.${key} must not have setter`);
        checkDescriptors(obj[key], `${path}.${key}`);
      }
    };
    checkDescriptors(successResponse);

    // Mutation attempts must fail silently or throw, never succeed
    try { successResponse.isError = true; } catch { /* frozen throws in strict mode */ }
    assert.equal(successResponse.isError, undefined, 'mutation must not succeed');

    // Error response also frozen
    const errorResponse = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {}
      }
    });

    assert.equal(Object.isFrozen(errorResponse), true, 'error response must be frozen');
    assert.equal(Object.isFrozen(errorResponse.content[0]), true, 'error content must be frozen');
    checkDescriptors(errorResponse, 'errorResponse');
  });

  await t.test('validation errors use specific codes not INTERNAL_ERROR', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    // Test MISSING_FIELD
    const missingFieldRequest = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {}
      }
    };

    const missingFieldResponse = await server.handleRequest(missingFieldRequest);
    assert.equal(missingFieldResponse.isError, true);
    const missingFieldError = JSON.parse(missingFieldResponse.content[0].text);
    assert.equal(missingFieldError.code, 'MISSING_FIELD');
    assert.match(missingFieldError.message, /goalInstance.*required/i);

    // Test UNKNOWN_FIELD
    const unknownFieldRequest = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test', extraField: 'bad' }
      }
    };

    const unknownFieldResponse = await server.handleRequest(unknownFieldRequest);
    assert.equal(unknownFieldResponse.isError, true);
    const unknownFieldError = JSON.parse(unknownFieldResponse.content[0].text);
    assert.equal(unknownFieldError.code, 'UNKNOWN_FIELD');
    assert.match(unknownFieldError.message, /unknown field.*extraField/i);

    // Test INVALID_ARGUMENTS (non-plain object)
    const invalidArgsRequest = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: []  // Array instead of object
      }
    };

    const invalidArgsResponse = await server.handleRequest(invalidArgsRequest);
    assert.equal(invalidArgsResponse.isError, true);
    const invalidArgsError = JSON.parse(invalidArgsResponse.content[0].text);
    assert.equal(invalidArgsError.code, 'INVALID_ARGUMENTS');
    assert.match(invalidArgsError.message, /plain object/i);
  });

  await t.test('returns structured error for invalid schema', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { wrongField: 'test' }
      }
    };

    const response = await server.handleRequest(request);

    assert.equal(response.isError, true);
    assert.equal(typeof response.content[0].text, 'string');

    const error = JSON.parse(response.content[0].text);
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
    assert.equal(error.rawBody, undefined);
    assert.equal(error.token, undefined);
  });

  await t.test('returns structured error for dependency throw', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => {
        throw new Error('Simulated internal error');
      }
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);

    assert.equal(response.isError, true);
    const error = JSON.parse(response.content[0].text);
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.rawBody, undefined);
    assert.equal(error.stack, undefined); // No stack traces to Claude
  });
});

test('MCP server boundary - goal/config allowlists', async (t) => {
  await t.test('enforces goal allowlist', async () => {
    const mockDeps = createMockDeps();
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps, {
      allowedGoals: ['allowed-goal-1', 'allowed-goal-2']
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'disallowed-goal' }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /not allowed/i);
  });

  await t.test('enforces space allowlist', async () => {
    const mockDeps = {
      ...createMockDeps(),
      wait: async (params) => {
        return { snapshotHash: 'abc' };
      }
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps, {
      allowedSpaces: ['space-1', 'space-2']
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          watchSet: [
            { spaceId: 'disallowed-space', sessionId: 'sess-1', turnId: 'turn-1' }
          ]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /space.*not allowed/i);
  });
});

test('MCP server boundary - dependency injection enforcement', async (t) => {
  await t.test('tool handlers only call injected functions', async () => {
    let inspectCalled = false;
    let submitCalled = false;
    let waitCalled = false;
    let verifyCalled = false;

    const trackingDeps = {
      inspect: async (...args) => {
        inspectCalled = true;
        return createMockDeps().inspect(...args);
      },
      submit: async (...args) => {
        submitCalled = true;
        return createMockDeps().submit(...args);
      },
      wait: async (...args) => {
        waitCalled = true;
        return createMockDeps().wait(...args);
      },
      verify: async (...args) => {
        verifyCalled = true;
        return createMockDeps().verify(...args);
      }
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(trackingDeps);

    // Test each tool
    await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });
    assert.equal(inspectCalled, true);

    await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_verify',
        arguments: { goalInstance: 'test' }
      }
    });
    assert.equal(verifyCalled, true);
  });
});

test('MCP server boundary - response injection attacks', async (t) => {
  await t.test('sanitizes newlines in error messages', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => {
        throw new Error('Error\ninjected\nlines');
      }
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);
    const text = response.content[0].text;

    // Should not contain raw newlines that could inject content
    assert.equal(text.includes('\ninjected\n'), false);
  });

  await t.test('escapes JSON in responses', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc"}</script><script>alert(1)</script>',
        localState: 'READY'
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    };

    const response = await server.handleRequest(request);

    // Should be valid JSON with escaped characters
    assert.doesNotThrow(() => {
      JSON.parse(response.content[0].text);
    });
  });
});
