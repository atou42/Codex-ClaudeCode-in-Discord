/**
 * @fileoverview MCP server boundary with dependency injection (spec lines 210-280).
 * Exposes exactly four tools: cohub_goal_inspect, cohub_goal_submit,
 * cohub_goal_wait, cohub_goal_verify. Exact schemas, allowlist fields,
 * redacted responses, typed errors. Tool handlers call only injected functions.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REDACTED_FIELDS = new Set([
  'accessToken', 'refreshToken', 'token', 'secret', 'password',
  'env', '_rawBody', '_httpHeaders', '_internal'
]);

const MAX_RESPONSE_SIZE = 512 * 1024; // 512KB
const MAX_ARRAY_LENGTH = 1000;

/**
 * Check if value is a plain object (not array, null, or class instance)
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  // Accept both Object.prototype and null (from Object.create(null))
  // But also check if __proto__ was polluted with custom properties
  if (proto !== Object.prototype && proto !== null) {
    // If prototype has been set to something else, check if it's been polluted
    const protoKeys = Object.keys(proto);
    if (protoKeys.length > 0) {
      // This is suspicious - likely __proto__ pollution attempt
      throw new Error('dangerous __proto__ pollution detected');
    }
  }
  return true;
}

/**
 * Check for dangerous prototype pollution keys
 */
function hasDangerousKeys(obj) {
  // Check own property names
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) {
      return true;
    }
  }

  // Check if __proto__ was attempted (pollutes prototype chain)
  const ownPropertyNames = Object.getOwnPropertyNames(obj);
  for (const key of ownPropertyNames) {
    if (DANGEROUS_KEYS.has(key)) {
      return true;
    }
  }

  // Also check if prototype was actually polluted
  if (obj.__proto__ !== Object.prototype && obj.__proto__ !== null) {
    const protoKeys = Object.keys(obj.__proto__);
    if (protoKeys.length > 0 && protoKeys.some(k => !Object.prototype.hasOwnProperty(k))) {
      return true;
    }
  }

  return false;
}

/**
 * Check for accessor properties (getters/setters)
 */
function hasAccessors(obj) {
  const keys = Object.keys(obj);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor && (descriptor.get || descriptor.set)) {
      return true;
    }
  }
  return false;
}

/**
 * Check for symbol keys
 */
function hasSymbolKeys(obj) {
  return Object.getOwnPropertySymbols(obj).length > 0;
}

/**
 * Validate and sanitize tool arguments
 */
function validateArguments(toolName, args, schema) {
  if (!isPlainObject(args)) {
    throw new Error('arguments must be a plain object');
  }

  if (hasDangerousKeys(args)) {
    throw new Error('dangerous keys (__proto__, constructor, prototype) not allowed');
  }

  if (hasAccessors(args)) {
    throw new Error('accessor properties not allowed');
  }

  if (hasSymbolKeys(args)) {
    throw new Error('symbol keys not allowed');
  }

  // Check required fields
  for (const field of schema.required) {
    if (!(field in args)) {
      throw new Error(`${field} is required`);
    }
  }

  // Check for unknown fields
  const allowedFields = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(args)) {
    if (!allowedFields.has(field)) {
      throw new Error(`unknown field: ${field}`);
    }
  }

  return args;
}

/**
 * Redact sensitive fields from response
 */
function redactResponse(obj, depth = 0) {
  if (depth > 10) {
    return '[MAX_DEPTH]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_LENGTH) {
      return obj.slice(0, MAX_ARRAY_LENGTH).map(item => redactResponse(item, depth + 1))
        .concat([`[${obj.length - MAX_ARRAY_LENGTH} more items truncated]`]);
    }
    return obj.map(item => redactResponse(item, depth + 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip redacted fields
    if (REDACTED_FIELDS.has(key) || key.startsWith('_')) {
      continue;
    }

    result[key] = redactResponse(value, depth + 1);
  }

  return result;
}

/**
 * Bound response size
 */
function boundResponse(obj) {
  const json = JSON.stringify(obj);
  if (json.length > MAX_RESPONSE_SIZE) {
    throw new Error(`response exceeds ${MAX_RESPONSE_SIZE} byte limit`);
  }
  return obj;
}

/**
 * Create typed error response
 */
function createError(code, message) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        code,
        message: String(message).replace(/\n/g, ' ')
      })
    }]
  };
}

/**
 * Create success response
 */
function createSuccess(data) {
  const redacted = redactResponse(data);
  const bounded = boundResponse(redacted);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(bounded)
    }]
  };
}

/**
 * Tool schemas
 */
const TOOL_SCHEMAS = {
  cohub_goal_inspect: {
    required: ['goalInstance'],
    optional: []
  },
  cohub_goal_submit: {
    required: [
      'goalInstance',
      'expectedSnapshotHash',
      'actionSlotId',
      'continuationId',
      'decisionCode',
      'evidenceRefs'
    ],
    optional: []
  },
  cohub_goal_wait: {
    required: ['goalInstance', 'expectedSnapshotHash', 'watchSet'],
    optional: []
  },
  cohub_goal_verify: {
    required: ['goalInstance'],
    optional: ['expectedSnapshotHash']
  }
};

/**
 * Create MCP server with dependency injection
 */
export function createServer(deps, options = {}) {
  const {
    inspect,
    submit,
    wait,
    verify
  } = deps;

  const {
    allowedGoals = null,
    allowedSpaces = null
  } = options;

  if (!inspect || !submit || !wait || !verify) {
    throw new Error('Missing required dependencies: inspect, submit, wait, verify');
  }

  /**
   * Enforce goal allowlist
   */
  function checkGoalAllowed(goalInstance) {
    if (allowedGoals && !allowedGoals.includes(goalInstance)) {
      throw new Error(`goal ${goalInstance} not allowed`);
    }
  }

  /**
   * Enforce space allowlist
   */
  function checkSpacesAllowed(watchSet) {
    if (!allowedSpaces) {
      return;
    }

    for (const item of watchSet) {
      if (item.spaceId && !allowedSpaces.includes(item.spaceId)) {
        throw new Error(`space ${item.spaceId} not allowed`);
      }
    }
  }

  /**
   * Handle tool call
   */
  async function handleToolCall(name, args) {
    const schema = TOOL_SCHEMAS[name];
    if (!schema) {
      throw new Error(`unknown tool: ${name}`);
    }

    const validatedArgs = validateArguments(name, args, schema);

    switch (name) {
      case 'cohub_goal_inspect': {
        checkGoalAllowed(validatedArgs.goalInstance);
        const result = await inspect(validatedArgs.goalInstance);
        return createSuccess(result);
      }

      case 'cohub_goal_submit': {
        checkGoalAllowed(validatedArgs.goalInstance);
        const result = await submit(validatedArgs);
        return createSuccess(result);
      }

      case 'cohub_goal_wait': {
        checkGoalAllowed(validatedArgs.goalInstance);
        checkSpacesAllowed(validatedArgs.watchSet);
        const result = await wait(validatedArgs);
        return createSuccess(result);
      }

      case 'cohub_goal_verify': {
        checkGoalAllowed(validatedArgs.goalInstance);
        const result = await verify(validatedArgs.goalInstance, validatedArgs.expectedSnapshotHash);
        return createSuccess(result);
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  /**
   * Handle MCP request
   */
  async function handleRequest(request) {
    try {
      if (!request || typeof request !== 'object') {
        return createError('INVALID_REQUEST', 'request must be an object');
      }

      const { method, params } = request;

      if (!method) {
        return createError('MISSING_METHOD', 'method is required');
      }

      if (method === 'tools/list') {
        return {
          tools: [
            {
              name: 'cohub_goal_inspect',
              description: 'Inspect current goal state and snapshot',
              inputSchema: {
                type: 'object',
                properties: {
                  goalInstance: { type: 'string' }
                },
                required: ['goalInstance']
              }
            },
            {
              name: 'cohub_goal_submit',
              description: 'Submit continuation to Cohub parent',
              inputSchema: {
                type: 'object',
                properties: {
                  goalInstance: { type: 'string' },
                  expectedSnapshotHash: { type: 'string' },
                  actionSlotId: { type: 'string' },
                  continuationId: { type: 'string' },
                  decisionCode: { type: 'string' },
                  evidenceRefs: { type: 'array' }
                },
                required: [
                  'goalInstance',
                  'expectedSnapshotHash',
                  'actionSlotId',
                  'continuationId',
                  'decisionCode',
                  'evidenceRefs'
                ]
              }
            },
            {
              name: 'cohub_goal_verify',
              description: 'Verify goal completion state',
              inputSchema: {
                type: 'object',
                properties: {
                  goalInstance: { type: 'string' },
                  expectedSnapshotHash: { type: 'string' }
                },
                required: ['goalInstance']
              }
            },
            {
              name: 'cohub_goal_wait',
              description: 'Wait for Cohub events',
              inputSchema: {
                type: 'object',
                properties: {
                  goalInstance: { type: 'string' },
                  expectedSnapshotHash: { type: 'string' },
                  watchSet: { type: 'array' }
                },
                required: ['goalInstance', 'expectedSnapshotHash', 'watchSet']
              }
            }
          ]
        };
      }

      if (method === 'tools/call') {
        if (!params) {
          return createError('MISSING_PARAMS', 'params is required');
        }

        const { name, arguments: args } = params;

        if (!name) {
          return createError('MISSING_NAME', 'tool name is required');
        }

        if (args === undefined) {
          return createError('MISSING_ARGUMENTS', 'arguments is required');
        }

        return await handleToolCall(name, args);
      }

      return createError('UNKNOWN_METHOD', `unknown method: ${method}`);
    } catch (error) {
      return createError('INTERNAL_ERROR', error.message);
    }
  }

  return {
    handleRequest
  };
}
