/**
 * @fileoverview MCP server boundary with dependency injection (spec lines 210-280).
 * Exposes exactly four tools: cohub_goal_inspect, cohub_goal_submit,
 * cohub_goal_wait, cohub_goal_verify. Exact schemas, allowlist fields,
 * redacted responses, typed errors. Tool handlers call only injected functions.
 */

import { types } from 'node:util';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REDACTED_FIELDS = new Set([
  'accessToken', 'refreshToken', 'token', 'secret', 'password',
  'env', '_rawBody', '_httpHeaders', '_internal'
]);

const MAX_RESPONSE_SIZE = 512 * 1024; // 512KB
const MAX_ARRAY_LENGTH = 1000;
const MAX_STRING_LENGTH = 10000;
const MAX_DEPTH = 20;
const MAX_TOTAL_BYTES = 100 * 1024; // 100KB input limit

/**
 * Custom error with typed code
 */
class MCPValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'MCPValidationError';
  }
}

/**
 * Recursively validate and clone an object graph, checking descriptors at every level.
 * Only allows exact plain objects (Object.prototype only), dense ordinary arrays,
 * strings, numbers (finite only), booleans, null.
 * Rejects: proxies, getters/setters, symbols, cycles, sparse arrays, extra array props,
 * dangerous keys, null/custom prototypes, functions, BigInt, undefined, NaN/Infinity.
 */
function validateAndClone(value, depth = 0, seen = new WeakSet(), path = 'root') {
  // Depth check
  if (depth > MAX_DEPTH) {
    throw new MCPValidationError('MAX_DEPTH', `nesting depth exceeded at ${path}`);
  }

  // Primitives (allow only safe types)
  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === 'boolean') {
    return value;
  }

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new MCPValidationError('NONFINITE_NUMBER', `NaN or Infinity not allowed at ${path}`);
    }
    return value;
  }

  if (type === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new MCPValidationError('STRING_TOO_LONG', `string exceeds ${MAX_STRING_LENGTH} chars at ${path}`);
    }
    return value;
  }

  if (type === 'undefined') {
    throw new MCPValidationError('UNDEFINED_VALUE', `undefined not allowed at ${path}`);
  }

  if (type === 'bigint') {
    throw new MCPValidationError('BIGINT_VALUE', `BigInt not allowed at ${path}`);
  }

  if (type === 'function') {
    throw new MCPValidationError('FUNCTION_VALUE', `function not allowed at ${path}`);
  }

  if (type === 'symbol') {
    throw new MCPValidationError('SYMBOL_VALUE', `symbol not allowed at ${path}`);
  }

  if (type !== 'object') {
    throw new MCPValidationError('UNKNOWN_TYPE', `unknown type ${type} at ${path}`);
  }

  // Check for proxy BEFORE any property access
  if (types.isProxy(value)) {
    throw new MCPValidationError('PROXY_NOT_ALLOWED', `proxy not allowed at ${path}`);
  }

  // Cycle detection
  if (seen.has(value)) {
    throw new MCPValidationError('CYCLIC_REFERENCE', `cycle detected at ${path}`);
  }
  seen.add(value);

  // Arrays
  if (Array.isArray(value)) {
    // Check for sparse arrays (holes)
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new MCPValidationError('SPARSE_ARRAY', `sparse array not allowed at ${path}`);
      }
    }

    // Check for extra properties on array
    const ownKeys = Object.getOwnPropertyNames(value);
    for (const key of ownKeys) {
      if (key !== 'length' && !/^\d+$/.test(key)) {
        throw new MCPValidationError('ARRAY_EXTRA_PROPERTIES', `array with extra properties not allowed at ${path}`);
      }
    }

    // Check for symbol keys on array
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new MCPValidationError('SYMBOL_KEYS', `symbol keys not allowed at ${path}`);
    }

    // Length check
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new MCPValidationError('ARRAY_TOO_LONG', `array exceeds ${MAX_ARRAY_LENGTH} items at ${path}`);
    }

    // Recursively validate items
    const cloned = [];
    for (let i = 0; i < value.length; i++) {
      cloned[i] = validateAndClone(value[i], depth + 1, seen, `${path}[${i}]`);
    }

    seen.delete(value);
    return cloned;
  }

  // Objects - must have exactly Object.prototype
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype) {
    throw new MCPValidationError('INVALID_PROTOTYPE', `only plain objects allowed (Object.prototype) at ${path}`);
  }

  // Check for symbol keys
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MCPValidationError('SYMBOL_KEYS', `symbol keys not allowed at ${path}`);
  }

  // Get all own property names and check descriptors
  const ownKeys = Object.getOwnPropertyNames(value);
  const cloned = {};

  for (const key of ownKeys) {
    const keyPath = `${path}.${key}`;

    // Check for dangerous keys
    if (DANGEROUS_KEYS.has(key)) {
      throw new MCPValidationError('DANGEROUS_KEYS', `dangerous key "${key}" not allowed at ${keyPath}`);
    }

    // Check descriptor - must be plain data property
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new MCPValidationError('MISSING_DESCRIPTOR', `missing descriptor at ${keyPath}`);
    }

    if (descriptor.get || descriptor.set) {
      throw new MCPValidationError('ACCESSOR_PROPERTIES', `accessor properties not allowed at ${keyPath}`);
    }

    // Clone the value recursively
    cloned[key] = validateAndClone(descriptor.value, depth + 1, seen, keyPath);
  }

  seen.delete(value);
  return cloned;
}

/**
 * Check total serialized byte size
 */
function checkTotalSize(obj, maxBytes) {
  const json = JSON.stringify(obj);
  if (json.length > maxBytes) {
    throw new MCPValidationError('INPUT_TOO_LARGE', `input exceeds ${maxBytes} bytes`);
  }
}

/**
 * Validate and sanitize tool arguments using recursive descriptor validation
 */
function validateArguments(toolName, args, schema) {
  // First validate it's a plain object at top level
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new MCPValidationError('INVALID_ARGUMENTS', 'arguments must be a plain object');
  }

  // Check for proxy before any access
  if (types.isProxy(args)) {
    throw new MCPValidationError('PROXY_NOT_ALLOWED', 'proxy not allowed in arguments');
  }

  // Clone and validate the entire graph recursively
  const validated = validateAndClone(args, 0, new WeakSet(), 'arguments');

  // Check total size
  checkTotalSize(validated, MAX_TOTAL_BYTES);

  // Check required fields
  for (const field of schema.required) {
    if (!(field in validated)) {
      throw new MCPValidationError('MISSING_FIELD', `${field} is required`);
    }
  }

  // Check for unknown fields
  const allowedFields = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(validated)) {
    if (!allowedFields.has(field)) {
      throw new MCPValidationError('UNKNOWN_FIELD', `unknown field: ${field}`);
    }
  }

  return validated;
}

/**
 * Sanitize dependency output by walking descriptors without executing getters/toJSON/valueOf.
 * Creates a detached safe graph by reading descriptors only, never invoking traps.
 */
function sanitizeDependencyOutput(obj, depth = 0, seen = new WeakSet(), path = 'response') {
  if (depth > 10) {
    return '[MAX_DEPTH]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  const type = typeof obj;

  // Primitives pass through
  if (type === 'boolean' || type === 'number' || type === 'string') {
    return obj;
  }

  // Reject unsafe types
  if (type === 'function' || type === 'bigint' || type === 'symbol') {
    return '[REDACTED:UNSAFE_TYPE]';
  }

  if (type !== 'object') {
    return '[UNKNOWN_TYPE]';
  }

  // Check for proxy - this check itself may trigger traps on hostile proxies,
  // but we catch that below. For most proxies, types.isProxy() is safe.
  try {
    if (types.isProxy(obj)) {
      return '[REDACTED:PROXY]';
    }
  } catch {
    // If checking isProxy itself throws, it's hostile
    return '[REDACTED:PROXY]';
  }

  // Cycle detection
  if (seen.has(obj)) {
    return '[CIRCULAR]';
  }
  seen.add(obj);

  // Arrays
  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_LENGTH) {
      const truncated = [];
      for (let i = 0; i < MAX_ARRAY_LENGTH; i++) {
        truncated.push(sanitizeDependencyOutput(obj[i], depth + 1, seen, `${path}[${i}]`));
      }
      truncated.push(`[${obj.length - MAX_ARRAY_LENGTH} more items truncated]`);
      seen.delete(obj);
      return truncated;
    }

    const result = [];
    for (let i = 0; i < obj.length; i++) {
      result.push(sanitizeDependencyOutput(obj[i], depth + 1, seen, `${path}[${i}]`));
    }
    seen.delete(obj);
    return result;
  }

  // Objects - walk descriptors only, never access properties directly
  // Use try-catch in case getOwnPropertyNames itself triggers hostile behavior
  let ownKeys;
  try {
    ownKeys = Object.getOwnPropertyNames(obj);
  } catch {
    seen.delete(obj);
    return '[REDACTED:HOSTILE_OBJECT]';
  }

  const result = {};

  for (const key of ownKeys) {
    // Skip redacted fields
    if (REDACTED_FIELDS.has(key) || key.startsWith('_')) {
      continue;
    }

    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      // If getting descriptor throws, skip this property
      continue;
    }

    if (!descriptor) {
      continue;
    }

    // If it's an accessor, skip it (never execute getters)
    if (descriptor.get || descriptor.set) {
      continue;
    }

    // Only process data properties
    if ('value' in descriptor) {
      result[key] = sanitizeDependencyOutput(descriptor.value, depth + 1, seen, `${path}.${key}`);
    }
  }

  seen.delete(obj);
  return result;
}

/**
 * Bound response size
 */
function boundResponse(obj) {
  const json = JSON.stringify(obj);
  if (json.length > MAX_RESPONSE_SIZE) {
    throw new MCPValidationError('RESPONSE_TOO_LARGE', `response exceeds ${MAX_RESPONSE_SIZE} byte limit`);
  }
  return obj;
}

/**
 * Deep freeze an object and all nested objects/arrays.
 * Guarantees returned objects cannot be mutated and nested
 * descriptors are plain data (no getters/setters survive JSON round-trip).
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * Create typed error response
 */
function createError(code, message) {
  return deepFreeze({
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        code,
        message: String(message).replace(/\n/g, ' ')
      })
    }]
  });
}

/**
 * Create success response with sanitized dependency output
 */
function createSuccess(data) {
  const sanitized = sanitizeDependencyOutput(data);
  const bounded = boundResponse(sanitized);

  return deepFreeze({
    content: [{
      type: 'text',
      text: JSON.stringify(bounded)
    }]
  });
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
      throw new MCPValidationError('GOAL_NOT_ALLOWED', `goal ${goalInstance} not allowed`);
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
        throw new MCPValidationError('SPACE_NOT_ALLOWED', `space ${item.spaceId} not allowed`);
      }
    }
  }

  /**
   * Handle tool call
   */
  async function handleToolCall(name, args) {
    const schema = TOOL_SCHEMAS[name];
    if (!schema) {
      throw new MCPValidationError('UNKNOWN_TOOL', `unknown tool: ${name}`);
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
        throw new MCPValidationError('UNKNOWN_TOOL', `unknown tool: ${name}`);
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
      // Return validation errors with their specific codes (allowlisted templates)
      if (error instanceof MCPValidationError) {
        return createError(error.code, error.message);
      }
      // Unknown dependency exceptions: generic closed error, never leak raw message/stack
      return createError('INTERNAL_ERROR', 'internal error');
    }
  }

  return {
    handleRequest
  };
}
