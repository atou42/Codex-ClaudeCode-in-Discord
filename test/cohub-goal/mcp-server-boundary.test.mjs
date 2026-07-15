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
    assert.match(response.content[0].text, /required/i);
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
    assert.match(response.content[0].text, /required/i);
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
    assert.match(response.content[0].text, /(dangerous|invalid.*prototype)/i);
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
    assert.match(response.content[0].text, /dangerous/i);
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
    assert.match(response.content[0].text, /dangerous/i);
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
    assert.match(missingFieldError.message, /required/i);

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
    assert.match(unknownFieldError.message, /unknown field/i);

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
    assert.equal(error.message, 'internal error'); // Generic message, no leak
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
    assert.match(response.content[0].text, /(not allowed|not in allowlist)/i);
  });

  await t.test('enforces space allowlist', async () => {
    const mockDeps = {
      ...createMockDeps(),
      wait: async (params) => {
        return { snapshotHash: '0'.repeat(64) };
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
          expectedSnapshotHash: '0'.repeat(64),
          watchSet: [
            { role: 'parent', spaceId: 'disallowed-space', sessionId: 'sess-1', turnId: 'turn-1' }
          ]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /(space.*not allowed|not in allowlist)/i);
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

test('MCP server boundary - nested descriptor attacks', async (t) => {
  await t.test('rejects nested getters in evidenceRefs', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const nestedObj = {};
    Object.defineProperty(nestedObj, 'secret', {
      get() { throw new Error('Nested getter executed!'); },
      enumerable: true
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: [nestedObj]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /accessor.*not allowed/i);
  });

  await t.test('rejects nested dangerous keys in watchSet items', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          watchSet: [{
            spaceId: 'space-1',
            sessionId: 'sess-1',
            turnId: 'turn-1',
            __proto__: { polluted: true }
          }]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /(dangerous|proto)/i);
  });

  await t.test('rejects proxy objects in arguments', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const proxyObj = new Proxy({ goalInstance: 'test' }, {
      get(target, prop) {
        if (prop === 'goalInstance') return 'test';
        throw new Error('Proxy trap executed!');
      }
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: proxyObj
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /proxy.*not allowed/i);
  });

  await t.test('rejects nested proxies in arrays', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const proxyItem = new Proxy({ spaceId: 'space-1' }, {
      get() { throw new Error('Nested proxy trap!'); }
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          watchSet: [proxyItem]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /proxy.*not allowed/i);
  });

  await t.test('rejects null prototype objects', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const nullProtoObj = Object.create(null);
    nullProtoObj.goalInstance = 'test';

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: nullProtoObj
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /plain object/i);
  });

  await t.test('rejects custom prototype chains', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    class CustomClass {
      constructor() {
        this.goalInstance = 'test';
      }
    }
    const customObj = new CustomClass();

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: customObj
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /plain object/i);
  });

  await t.test('rejects sparse arrays', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const sparseArray = [];
    sparseArray[0] = { spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-1' };
    sparseArray[5] = { spaceId: 'space-2', sessionId: 'sess-2', turnId: 'turn-2' };

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          watchSet: sparseArray
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /sparse.*array/i);
  });

  await t.test('rejects arrays with extra properties', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const arrayWithProps = [{ spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-1' }];
    arrayWithProps.extraProp = 'malicious';

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          watchSet: arrayWithProps
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /extra.*properties/i);
  });

  await t.test('rejects cyclic references', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const cyclicObj = { goalInstance: 'test' };
    cyclicObj.self = cyclicObj;

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: cyclicObj
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /cycle/i);
  });

  await t.test('rejects functions in nested objects', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: [{ maliciousFunc: () => 'attack' }]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /function.*not allowed/i);
  });

  await t.test('rejects BigInt values', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: [{ bigNum: 12345678901234567890n }]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /bigint.*not allowed/i);
  });

  await t.test('rejects undefined values', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: [{ undef: undefined }]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /undefined.*not allowed/i);
  });

  await t.test('rejects NaN and Infinity', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: [{ bad: NaN }, { worse: Infinity }]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /(nan|infinity|nonfinite).*not allowed/i);
  });

  await t.test('enforces max nesting depth', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    // Create deeply nested object
    let deep = { value: 'deep' };
    for (let i = 0; i < 100; i++) {
      deep = { nested: deep };
    }

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: [deep]
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /depth.*exceeded/i);
  });

  await t.test('enforces bounded string length', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const hugeString = 'x'.repeat(100000);

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {
          goalInstance: hugeString
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /(string|too.long|exceeds)/i);
  });

  await t.test('enforces bounded array length in input', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const hugeArray = Array(10000).fill(null).map((_, i) => ({
      spaceId: `space-${i}`,
      sessionId: 'sess',
      turnId: 'turn'
    }));

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          watchSet: hugeArray
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /(array|too.long|exceeds)/i);
  });

  await t.test('enforces total byte size limit', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    // Create an object that's too large when serialized
    const largeArray = Array(10000).fill(null).map((_, i) => ({
      field1: 'x'.repeat(100),
      field2: 'y'.repeat(100),
      field3: `item-${i}`
    }));

    const request = {
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: 'abc',
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',
          evidenceRefs: largeArray
        }
      }
    };

    const response = await server.handleRequest(request);
    assert.equal(response.isError, true);
    // Will fail on array length first, which is also a valid size check
    assert.match(response.content[0].text, /(size|bytes|array|exceeds|too.large|too.long)/i);
  });
});

test('MCP server boundary - output sanitization attacks', async (t) => {
  await t.test('never executes toJSON on dependency output', async () => {
    let toJSONCalled = false;

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        localState: 'READY',
        malicious: {
          toJSON() {
            toJSONCalled = true;
            return 'should-not-be-called';
          }
        }
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

    await server.handleRequest(request);
    assert.equal(toJSONCalled, false, 'toJSON must not be executed during sanitization');
  });

  await t.test('never executes valueOf on dependency output', async () => {
    let valueOfCalled = false;

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        localState: 'READY',
        malicious: {
          valueOf() {
            valueOfCalled = true;
            return 'should-not-be-called';
          }
        }
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

    await server.handleRequest(request);
    assert.equal(valueOfCalled, false, 'valueOf must not be executed during sanitization');
  });

  await t.test('never executes getter on dependency output', async () => {
    let getterCalled = false;

    const outputObj = {
      goalInstance: 'test',
      snapshotHash: 'abc',
      localState: 'READY'
    };
    Object.defineProperty(outputObj, 'malicious', {
      get() {
        getterCalled = true;
        return 'should-not-be-called';
      },
      enumerable: true
    });

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => outputObj
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

    await server.handleRequest(request);
    assert.equal(getterCalled, false, 'Getter must not be executed during sanitization');
  });

  await t.test('never executes proxy trap on dependency output', async () => {
    let trapCalled = false;

    const proxyOutput = new Proxy({
      goalInstance: 'test',
      snapshotHash: 'abc',
      localState: 'READY'
    }, {
      get(target, prop) {
        trapCalled = true;
        return target[prop];
      },
      getOwnPropertyDescriptor(target, prop) {
        trapCalled = true;
        return Object.getOwnPropertyDescriptor(target, prop);
      },
      ownKeys(target) {
        trapCalled = true;
        return Object.getOwnPropertyNames(target);
      }
    });

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => proxyOutput
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

    // Proxy in dependency output must cause INTERNAL_ERROR (fail-closed)
    const responseText = response.content[0].text;

    assert.ok(
      responseText.includes('INTERNAL_ERROR'),
      'Proxy in dependency output must cause INTERNAL_ERROR'
    );
  });

  await t.test('zero trap counter proves no traps executed', async () => {
    let trapCounter = 0;

    const createNestedProxy = (depth) => {
      if (depth === 0) {
        return { leaf: 'value' };
      }
      return new Proxy({ nested: createNestedProxy(depth - 1) }, {
        get(target, prop) {
          trapCounter++;
          return target[prop];
        },
        getOwnPropertyDescriptor(target, prop) {
          trapCounter++;
          return Object.getOwnPropertyDescriptor(target, prop);
        },
        ownKeys(target) {
          trapCounter++;
          return Object.getOwnPropertyNames(target);
        }
      });
    };

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        localState: 'READY',
        deepProxy: createNestedProxy(5)
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
    const responseText = response.content[0].text;

    // Proxy should be detected and redacted, preventing any trap execution during sanitization
    assert.ok(
      responseText.includes('[REDACTED:PROXY]') || trapCounter === 0,
      `Trap counter: ${trapCounter}. Proxy should be redacted or no traps executed.`
    );
  });

  await t.test('sentinel test - secrets never appear in output', async () => {
    const SECRET_SENTINEL = 'SECRET_NEVER_SHOW_THIS';

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: 'abc',
        localState: 'READY',
        accessToken: SECRET_SENTINEL,
        nested: {
          deep: {
            secret: SECRET_SENTINEL
          }
        },
        array: [{ token: SECRET_SENTINEL }]
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

    assert.equal(responseText.includes(SECRET_SENTINEL), false,
      `Secret sentinel must not appear anywhere in output`);
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

test('MCP server boundary - request/params proxy trap zero execution', async (t) => {
  await t.test('rejects proxy request before destructuring', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    let trapCount = 0;
    const proxyRequest = new Proxy({
      method: 'tools/call',
      params: { name: 'cohub_goal_inspect', arguments: { goalInstance: 'test' } }
    }, {
      get(target, prop) {
        trapCount++;
        return target[prop];
      }
    });

    const response = await server.handleRequest(proxyRequest);

    assert.equal(response.isError, true, 'must reject proxy request');
    assert.equal(trapCount, 0, 'must not execute any proxy traps on request');
  });

  await t.test('rejects proxy params before destructuring', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    let trapCount = 0;
    const proxyParams = new Proxy({
      name: 'cohub_goal_inspect',
      arguments: { goalInstance: 'test' }
    }, {
      get(target, prop) {
        trapCount++;
        return target[prop];
      }
    });

    const response = await server.handleRequest({
      method: 'tools/call',
      params: proxyParams
    });

    assert.equal(response.isError, true, 'must reject proxy params');
    assert.equal(trapCount, 0, 'must not execute proxy traps on params');
  });

  await t.test('checks types.isProxy before Array.isArray on arguments', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    // Create a proxy array that tracks which check happened first
    let checkOrder = [];
    const proxyArray = new Proxy([], {
      get(target, prop) {
        if (prop === Symbol.iterator || prop === 'length') {
          checkOrder.push('Array.isArray');
        }
        return target[prop];
      }
    });

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: proxyArray
      }
    });

    assert.equal(response.isError, true, 'must reject proxy arguments');
    assert.equal(checkOrder.length, 0, 'types.isProxy must run before Array.isArray');
  });
});

test('MCP server boundary - dependency output must fail-closed', async (t) => {
  await t.test('dependency returning proxy causes INTERNAL_ERROR not success', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => new Proxy({
        goalInstance: 'test',
        snapshotHash: 'abc'
      }, {
        get() { throw new Error('trap executed'); }
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    assert.equal(response.isError, true, 'must be error response');
    const error = JSON.parse(response.content[0].text);
    assert.equal(error.code, 'INTERNAL_ERROR', 'proxy output must cause INTERNAL_ERROR');
  });

  await t.test('dependency output with getter causes INTERNAL_ERROR not success', async () => {
    const outputObj = { goalInstance: 'test' };
    Object.defineProperty(outputObj, 'dangerous', {
      get() { throw new Error('getter executed'); },
      enumerable: true
    });

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => outputObj
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    assert.equal(response.isError, true, 'must be error response');
    const error = JSON.parse(response.content[0].text);
    assert.equal(error.code, 'INTERNAL_ERROR', 'getter output must cause INTERNAL_ERROR');
  });

  await t.test('dependency output with cycle causes INTERNAL_ERROR not success', async () => {
    const cyclicObj = { goalInstance: 'test' };
    cyclicObj.self = cyclicObj;

    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => cyclicObj
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    assert.equal(response.isError, true, 'must be error response');
    const error = JSON.parse(response.content[0].text);
    assert.equal(error.code, 'INTERNAL_ERROR', 'cyclic output must cause INTERNAL_ERROR');
  });

  await t.test('dependency output with secret field causes INTERNAL_ERROR', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => ({
        goalInstance: 'test',
        snapshotHash: '0'.repeat(64),
        accessToken: 'secret-should-not-appear',
        localState: 'READY'
      })
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    assert.equal(response.isError, true, 'must be error response');
    const error = JSON.parse(response.content[0].text);
    assert.equal(error.code, 'INTERNAL_ERROR', 'secret-bearing output must cause INTERNAL_ERROR');
  });
});

test('MCP server boundary - exact schema validation', async (t) => {
  await t.test('validates hash is exactly 64 lowercase hex chars', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const invalidHashes = [
      'ABC123',  // uppercase
      'short',   // too short
      'z' + '0'.repeat(63),  // invalid hex
      '0'.repeat(65),  // too long
      '',  // empty
    ];

    for (const hash of invalidHashes) {
      const response = await server.handleRequest({
        method: 'tools/call',
        params: {
          name: 'cohub_goal_submit',
          arguments: {
            goalInstance: 'test',
            expectedSnapshotHash: hash,
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
            decisionCode: 'CONTINUE',
            evidenceRefs: []
          }
        }
      });

      assert.equal(response.isError, true, `hash ${hash} should be rejected`);
    }
  });

  await t.test('validates decisionCode against exact allowlist', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const invalidDecisions = ['INVALID', 'continue', 'WAIT', ''];

    for (const decision of invalidDecisions) {
      const response = await server.handleRequest({
        method: 'tools/call',
        params: {
          name: 'cohub_goal_submit',
          arguments: {
            goalInstance: 'test',
            expectedSnapshotHash: '0'.repeat(64),
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
            decisionCode: decision,
            evidenceRefs: []
          }
        }
      });

      assert.equal(response.isError, true, `decision ${decision} should be rejected`);
    }
  });

  await t.test('validates evidenceRefs structure', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    // Invalid evidence refs - not exact {id, hash} structure
    const invalidEvidenceRefs = [
      [{ id: 'evt-1' }],  // missing hash
      [{ hash: '0'.repeat(64) }],  // missing id
      [{ id: 'evt-1', hash: '0'.repeat(64), extra: 'field' }],  // extra field
      ['string'],  // not object
    ];

    for (const evidenceRefs of invalidEvidenceRefs) {
      const response = await server.handleRequest({
        method: 'tools/call',
        params: {
          name: 'cohub_goal_submit',
          arguments: {
            goalInstance: 'test',
            expectedSnapshotHash: '0'.repeat(64),
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
            decisionCode: 'CONTINUE',
            evidenceRefs
          }
        }
      });

      assert.equal(response.isError, true, `evidenceRefs ${JSON.stringify(evidenceRefs)} should be rejected`);
    }
  });

  await t.test('validates watchSet item provenance', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps(), {
      allowedSpaces: ['space-1']
    });

    // Invalid watch items - missing role, wrong structure
    const invalidWatchSets = [
      [{ spaceId: 'space-1', sessionId: 'sess-1' }],  // missing role
      [{ spaceId: 'space-1', role: 'invalid' }],  // role not in [parent, worker, merged]
      [{ spaceId: 'space-1', role: 'parent', extra: 'field' }],  // extra field
    ];

    for (const watchSet of invalidWatchSets) {
      const response = await server.handleRequest({
        method: 'tools/call',
        params: {
          name: 'cohub_goal_wait',
          arguments: {
            goalInstance: 'test',
            expectedSnapshotHash: '0'.repeat(64),
            watchSet
          }
        }
      });

      assert.equal(response.isError, true, `watchSet ${JSON.stringify(watchSet)} should be rejected`);
    }
  });
});

test('MCP server boundary - immutable configuration', async (t) => {
  await t.test('mutating allowedGoals after createServer has no effect', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');

    const allowedGoals = ['goal-1'];
    const server = createServer(createMockDeps(), { allowedGoals });

    // Attacker mutates the array
    allowedGoals.push('goal-2');

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'goal-2' }
      }
    });

    assert.equal(response.isError, true, 'mutated allowedGoals must not affect server');
  });

  await t.test('mutating allowedSpaces after createServer has no effect', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');

    const allowedSpaces = ['space-1'];
    const server = createServer(createMockDeps(), { allowedSpaces });

    // Attacker mutates the array
    allowedSpaces.push('space-2');

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test',
          expectedSnapshotHash: '0'.repeat(64),
          watchSet: [{ role: 'parent', spaceId: 'space-2', sessionId: 'sess', turnId: 'turn' }]
        }
      }
    });

    assert.equal(response.isError, true, 'mutated allowedSpaces must not affect server');
  });

  await t.test('mutating dependency functions after createServer has no effect', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');

    const deps = createMockDeps();
    const server = createServer(deps);

    let attackerCalled = false;
    deps.inspect = async () => {
      attackerCalled = true;
      return { malicious: true };
    };

    await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    assert.equal(attackerCalled, false, 'mutated deps must not be called');
  });
});

test('MCP server boundary - tools/list exact schema', async (t) => {
  await t.test('tools/list has additionalProperties:false on all schemas', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const response = await server.handleRequest({ method: 'tools/list' });

    assert.equal(response.tools.length, 4);

    for (const tool of response.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false,
        `${tool.name} schema must have additionalProperties:false`);

      // Check nested properties also have exact schemas
      if (tool.inputSchema.properties.evidenceRefs) {
        const evidenceSchema = tool.inputSchema.properties.evidenceRefs;
        assert.ok(evidenceSchema.items, 'evidenceRefs must have items schema');
        assert.equal(evidenceSchema.items.additionalProperties, false,
          'evidenceRefs items must have additionalProperties:false');
      }

      if (tool.inputSchema.properties.watchSet) {
        const watchSchema = tool.inputSchema.properties.watchSet;
        assert.ok(watchSchema.items, 'watchSet must have items schema');
        assert.equal(watchSchema.items.additionalProperties, false,
          'watchSet items must have additionalProperties:false');
      }
    }
  });

  await t.test('tools/list is deep frozen and immutable', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const response = await server.handleRequest({ method: 'tools/list' });

    assert.ok(Object.isFrozen(response), 'response must be frozen');
    assert.ok(Object.isFrozen(response.tools), 'tools array must be frozen');
    assert.ok(Object.isFrozen(response.tools[0]), 'tool objects must be frozen');
    assert.ok(Object.isFrozen(response.tools[0].inputSchema), 'schemas must be frozen');
  });
});

test('MCP server boundary - error responses never leak attacker content', async (t) => {
  await t.test('validation error does not include attacker field name', async () => {
    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(createMockDeps());

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: {
          goalInstance: 'test',
          '__ATTACKER_SENTINEL__': 'malicious'
        }
      }
    });

    const responseText = JSON.stringify(response);
    assert.equal(responseText.includes('__ATTACKER_SENTINEL__'), false,
      'error must not echo attacker field names');
  });

  await t.test('error never includes raw dependency error message', async () => {
    const mockDeps = {
      ...createMockDeps(),
      inspect: async () => {
        const err = new Error('SENSITIVE_DATABASE_PATH=/var/secrets/db');
        err.stack = 'at sensitiveFunction (/internal/path/file.js:42)';
        throw err;
      }
    };

    const { createServer } = await import('../../src/cohub-claude-goal/server.js');
    const server = createServer(mockDeps);

    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test' }
      }
    });

    const responseText = JSON.stringify(response);
    assert.equal(responseText.includes('SENSITIVE_DATABASE_PATH'), false);
    assert.equal(responseText.includes('/internal/path'), false);
    assert.equal(responseText.includes('sensitiveFunction'), false);

    const error = JSON.parse(response.content[0].text);
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.message, 'internal error');
  });
});
