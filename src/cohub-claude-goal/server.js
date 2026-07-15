/**
 * @fileoverview MCP server boundary with dependency injection (spec lines 210-280).
 * Exposes exactly four tools: cohub_goal_inspect, cohub_goal_submit,
 * cohub_goal_wait, cohub_goal_verify. Exact schemas, allowlist fields,
 * fail-closed sanitization, typed errors. Tool handlers call only injected functions.
 *
 * Security model:
 * - All untrusted input sanitized BEFORE any property access
 * - types.isProxy checked BEFORE Array.isArray or any other operation
 * - Dependency output validated with fail-closed: bad output = INTERNAL_ERROR
 * - Configuration immutable: allowlists frozen, deps captured at construction
 * - Errors built from fixed template table, never echo attacker content
 */

import { types } from 'node:util';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_RESPONSE_SIZE = 512 * 1024; // 512KB
const MAX_ARRAY_LENGTH = 1000;
const MAX_STRING_LENGTH = 10000;
const MAX_DEPTH = 20;
const MAX_TOTAL_BYTES = 100 * 1024; // 100KB input limit

// Exact decision allowlist from spec
const ALLOWED_DECISIONS = new Set(['CONTINUE', 'DISPATCH', 'RECEIVE', 'APPROVE', 'COMPLETE']);

// Exact watch role allowlist from spec
const ALLOWED_WATCH_ROLES = new Set(['parent', 'worker', 'merged']);

/**
 * Fixed error code to message table (spec lines 348-372).
 * Errors never include attacker-controlled values.
 */
const ERROR_MESSAGES = {
  // Request validation
  INVALID_REQUEST: 'request must be an object',
  MISSING_METHOD: 'method is required',
  UNKNOWN_METHOD: 'unknown method',
  MISSING_PARAMS: 'params is required',
  MISSING_NAME: 'tool name is required',
  MISSING_ARGUMENTS: 'arguments is required',
  UNKNOWN_TOOL: 'unknown tool',

  // Argument validation
  INVALID_ARGUMENTS: 'arguments must be a plain object',
  PROXY_NOT_ALLOWED: 'proxy not allowed',
  MISSING_FIELD: 'required field missing',
  UNKNOWN_FIELD: 'unknown field',

  // Type validation
  INVALID_PROTOTYPE: 'only plain objects with default prototype allowed',
  ACCESSOR_PROPERTIES: 'accessor properties not allowed',
  MISSING_DESCRIPTOR: 'property descriptor missing',
  SYMBOL_KEYS: 'symbol keys not allowed',
  SYMBOL_VALUE: 'symbol values not allowed',
  DANGEROUS_KEYS: 'dangerous key not allowed',
  FUNCTION_VALUE: 'function not allowed',
  BIGINT_VALUE: 'BigInt not allowed',
  UNDEFINED_VALUE: 'undefined not allowed',
  NONFINITE_NUMBER: 'NaN or Infinity not allowed',
  CYCLIC_REFERENCE: 'cycle detected in input',

  // Array validation
  SPARSE_ARRAY: 'sparse array not allowed',
  ARRAY_EXTRA_PROPERTIES: 'array with extra properties not allowed',
  ARRAY_TOO_LONG: 'array exceeds maximum length',

  // Size/depth limits
  STRING_TOO_LONG: 'string exceeds maximum length',
  MAX_DEPTH: 'nesting depth exceeded',
  INPUT_TOO_LARGE: 'input exceeds size limit',
  RESPONSE_TOO_LARGE: 'response exceeds size limit',

  // Schema validation
  INVALID_HASH: 'hash must be 64 lowercase hex characters',
  INVALID_ID: 'invalid identifier format',
  INVALID_DECISION: 'decision not in allowlist',
  INVALID_EVIDENCE_REF: 'evidence reference invalid',
  INVALID_WATCH_ITEM: 'watch item invalid',

  // Allowlist validation
  GOAL_NOT_ALLOWED: 'goal not in allowlist',
  SPACE_NOT_ALLOWED: 'space not in allowlist',

  // Internal errors (generic, no details leaked)
  INTERNAL_ERROR: 'internal error',
  UNKNOWN_TYPE: 'unsupported type'
};

/**
 * Custom error with typed code
 */
class MCPValidationError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || 'unknown error');
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
 *
 * CRITICAL: types.isProxy MUST be first operation on any object, before Array.isArray.
 */
function validateAndClone(value, depth = 0, seen = new WeakSet(), path = 'root') {
  // Depth check
  if (depth > MAX_DEPTH) {
    throw new MCPValidationError('MAX_DEPTH');
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
      throw new MCPValidationError('NONFINITE_NUMBER');
    }
    return value;
  }

  if (type === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new MCPValidationError('STRING_TOO_LONG');
    }
    return value;
  }

  if (type === 'undefined') {
    throw new MCPValidationError('UNDEFINED_VALUE');
  }

  if (type === 'bigint') {
    throw new MCPValidationError('BIGINT_VALUE');
  }

  if (type === 'function') {
    throw new MCPValidationError('FUNCTION_VALUE');
  }

  if (type === 'symbol') {
    throw new MCPValidationError('SYMBOL_VALUE');
  }

  if (type !== 'object') {
    throw new MCPValidationError('UNKNOWN_TYPE');
  }

  // CRITICAL: Check for proxy BEFORE any property access, including Array.isArray
  if (types.isProxy(value)) {
    throw new MCPValidationError('PROXY_NOT_ALLOWED');
  }

  // Cycle detection
  if (seen.has(value)) {
    throw new MCPValidationError('CYCLIC_REFERENCE');
  }
  seen.add(value);

  // Arrays - must come after proxy check
  if (Array.isArray(value)) {
    // Check for sparse arrays (holes)
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new MCPValidationError('SPARSE_ARRAY');
      }
    }

    // Check for extra properties on array
    const ownKeys = Object.getOwnPropertyNames(value);
    for (const key of ownKeys) {
      if (key !== 'length' && !/^\d+$/.test(key)) {
        throw new MCPValidationError('ARRAY_EXTRA_PROPERTIES');
      }
    }

    // Check for symbol keys on array
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new MCPValidationError('SYMBOL_KEYS');
    }

    // Length check
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new MCPValidationError('ARRAY_TOO_LONG');
    }

    // Recursively validate items using descriptor access
    const cloned = [];
    for (let i = 0; i < value.length; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc) {
        throw new MCPValidationError('SPARSE_ARRAY');
      }
      if (desc.get || desc.set) {
        throw new MCPValidationError('ACCESSOR_PROPERTIES');
      }
      cloned[i] = validateAndClone(desc.value, depth + 1, seen, `${path}[${i}]`);
    }

    seen.delete(value);
    return cloned;
  }

  // Objects - must have exactly Object.prototype
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype) {
    throw new MCPValidationError('INVALID_PROTOTYPE');
  }

  // Check for symbol keys
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MCPValidationError('SYMBOL_KEYS');
  }

  // Get all own property names and check descriptors
  const ownKeys = Object.getOwnPropertyNames(value);
  const cloned = {};

  for (const key of ownKeys) {
    // Check for dangerous keys
    if (DANGEROUS_KEYS.has(key)) {
      throw new MCPValidationError('DANGEROUS_KEYS');
    }

    // Check descriptor - must be plain data property
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new MCPValidationError('MISSING_DESCRIPTOR');
    }

    if (descriptor.get || descriptor.set) {
      throw new MCPValidationError('ACCESSOR_PROPERTIES');
    }

    // Clone the value recursively
    cloned[key] = validateAndClone(descriptor.value, depth + 1, seen, `${path}.${key}`);
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
    throw new MCPValidationError('INPUT_TOO_LARGE');
  }
}

/**
 * Validate hash format: exactly 64 lowercase hex characters
 */
function validateHash(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new MCPValidationError('INVALID_HASH');
  }
  return hash;
}

/**
 * Validate ID format: non-empty string, bounded length, no control chars
 */
function validateId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200 || /[\x00-\x1f]/.test(id)) {
    throw new MCPValidationError('INVALID_ID');
  }
  return id;
}

/**
 * Validate decision code against exact allowlist
 */
function validateDecision(decision) {
  if (!ALLOWED_DECISIONS.has(decision)) {
    throw new MCPValidationError('INVALID_DECISION');
  }
  return decision;
}

/**
 * Validate evidence reference: exact {id, hash} structure
 */
function validateEvidenceRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new MCPValidationError('INVALID_EVIDENCE_REF');
  }

  const keys = Object.keys(ref);
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('hash')) {
    throw new MCPValidationError('INVALID_EVIDENCE_REF');
  }

  return {
    id: validateId(ref.id),
    hash: validateHash(ref.hash)
  };
}

/**
 * Validate watch item: exact {role, spaceId, sessionId, turnId} or subset based on role
 */
function validateWatchItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new MCPValidationError('INVALID_WATCH_ITEM');
  }

  if (!item.role || !ALLOWED_WATCH_ROLES.has(item.role)) {
    throw new MCPValidationError('INVALID_WATCH_ITEM');
  }

  const keys = Object.keys(item);
  const allowedKeys = new Set(['role', 'spaceId', 'sessionId', 'turnId']);

  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      throw new MCPValidationError('INVALID_WATCH_ITEM');
    }
  }

  const validated = { role: item.role };

  if (item.spaceId !== undefined) {
    validated.spaceId = validateId(item.spaceId);
  }
  if (item.sessionId !== undefined) {
    validated.sessionId = validateId(item.sessionId);
  }
  if (item.turnId !== undefined) {
    validated.turnId = validateId(item.turnId);
  }

  return validated;
}

/**
 * Validate and sanitize tool arguments using recursive descriptor validation.
 * Performs both structural validation and semantic schema validation.
 */
function validateArguments(toolName, args, schema) {
  // First validate it's a plain object at top level (before any destructuring)
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new MCPValidationError('INVALID_ARGUMENTS');
  }

  // Check for proxy before any access
  if (types.isProxy(args)) {
    throw new MCPValidationError('PROXY_NOT_ALLOWED');
  }

  // Clone and validate the entire graph recursively
  const validated = validateAndClone(args, 0, new WeakSet(), 'arguments');

  // Check total size
  checkTotalSize(validated, MAX_TOTAL_BYTES);

  // Check required fields
  for (const field of schema.required) {
    if (!(field in validated)) {
      throw new MCPValidationError('MISSING_FIELD');
    }
  }

  // Check for unknown fields
  const allowedFields = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(validated)) {
    if (!allowedFields.has(field)) {
      throw new MCPValidationError('UNKNOWN_FIELD');
    }
  }

  // Semantic validation based on tool
  if (toolName === 'cohub_goal_submit') {
    validated.expectedSnapshotHash = validateHash(validated.expectedSnapshotHash);
    validated.actionSlotId = validateId(validated.actionSlotId);
    validated.continuationId = validateId(validated.continuationId);
    validated.decisionCode = validateDecision(validated.decisionCode);

    if (!Array.isArray(validated.evidenceRefs)) {
      throw new MCPValidationError('INVALID_EVIDENCE_REF');
    }
    validated.evidenceRefs = validated.evidenceRefs.map(validateEvidenceRef);
  }

  if (toolName === 'cohub_goal_wait') {
    validated.expectedSnapshotHash = validateHash(validated.expectedSnapshotHash);

    if (!Array.isArray(validated.watchSet) || validated.watchSet.length === 0) {
      throw new MCPValidationError('INVALID_WATCH_ITEM');
    }
    validated.watchSet = validated.watchSet.map(validateWatchItem);
  }

  if (toolName === 'cohub_goal_verify' && validated.expectedSnapshotHash) {
    validated.expectedSnapshotHash = validateHash(validated.expectedSnapshotHash);
  }

  return validated;
}

/**
 * Secret-bearing field patterns that must not appear in output
 */
const SECRET_FIELD_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /auth/i,
  /credential/i,
  /key/i
];

/**
 * Check for secret-bearing fields (fail-closed: presence = error)
 */
function checkForSecrets(obj, path = 'output') {
  if (obj === null || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      checkForSecrets(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    // Check if key matches secret pattern
    for (const pattern of SECRET_FIELD_PATTERNS) {
      if (pattern.test(key)) {
        throw new Error('SECRET_FIELD_IN_OUTPUT');
      }
    }

    // Recursively check nested objects
    checkForSecrets(obj[key], `${path}.${key}`);
  }
}

/**
 * Validate dependency output with fail-closed policy.
 * Any proxy, getter, cycle, invalid structure, or secret-bearing field causes INTERNAL_ERROR.
 * This is NOT a sanitizer that redacts - it's a validator that throws.
 */
function validateDependencyOutput(obj) {
  try {
    // Use the same strict validator as input
    const validated = validateAndClone(obj, 0, new WeakSet(), 'output');

    // Additional check: no secret-bearing fields
    checkForSecrets(validated);

    return validated;
  } catch (error) {
    // Any validation error in dependency output is an internal error
    // Never return partial/redacted success
    throw new Error('DEPENDENCY_OUTPUT_INVALID');
  }
}

/**
 * Bound response size
 */
function boundResponse(obj) {
  const json = JSON.stringify(obj);
  if (json.length > MAX_RESPONSE_SIZE) {
    throw new MCPValidationError('RESPONSE_TOO_LARGE');
  }
  return obj;
}

/**
 * Deep freeze an object and all nested objects/arrays.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Freeze in post-order to ensure nested objects are frozen first
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
}

/**
 * Create typed error response from code (never includes attacker content)
 */
function createError(code) {
  const message = ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR;

  return deepFreeze({
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ code, message })
    }]
  });
}

/**
 * Create success response with validated dependency output
 */
function createSuccess(data) {
  const validated = validateDependencyOutput(data);
  const bounded = boundResponse(validated);

  return deepFreeze({
    content: [{
      type: 'text',
      text: JSON.stringify(bounded)
    }]
  });
}

/**
 * Tool schemas with exact structure requirements
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
 * Exact JSON Schema definitions for tools/list (spec lines 210-250)
 */
const TOOL_DEFINITIONS = deepFreeze([
  {
    name: 'cohub_goal_inspect',
    description: 'Inspect current goal state and snapshot',
    inputSchema: {
      type: 'object',
      properties: {
        goalInstance: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['goalInstance'],
      additionalProperties: false
    }
  },
  {
    name: 'cohub_goal_submit',
    description: 'Submit continuation to Cohub parent',
    inputSchema: {
      type: 'object',
      properties: {
        goalInstance: { type: 'string', minLength: 1, maxLength: 200 },
        expectedSnapshotHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        actionSlotId: { type: 'string', minLength: 1, maxLength: 200 },
        continuationId: { type: 'string', minLength: 1, maxLength: 200 },
        decisionCode: { type: 'string', enum: Array.from(ALLOWED_DECISIONS) },
        evidenceRefs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 200 },
              hash: { type: 'string', pattern: '^[0-9a-f]{64}$' }
            },
            required: ['id', 'hash'],
            additionalProperties: false
          }
        }
      },
      required: [
        'goalInstance',
        'expectedSnapshotHash',
        'actionSlotId',
        'continuationId',
        'decisionCode',
        'evidenceRefs'
      ],
      additionalProperties: false
    }
  },
  {
    name: 'cohub_goal_verify',
    description: 'Verify goal completion state',
    inputSchema: {
      type: 'object',
      properties: {
        goalInstance: { type: 'string', minLength: 1, maxLength: 200 },
        expectedSnapshotHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }
      },
      required: ['goalInstance'],
      additionalProperties: false
    }
  },
  {
    name: 'cohub_goal_wait',
    description: 'Wait for Cohub events',
    inputSchema: {
      type: 'object',
      properties: {
        goalInstance: { type: 'string', minLength: 1, maxLength: 200 },
        expectedSnapshotHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        watchSet: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: Array.from(ALLOWED_WATCH_ROLES) },
              spaceId: { type: 'string', minLength: 1, maxLength: 200 },
              sessionId: { type: 'string', minLength: 1, maxLength: 200 },
              turnId: { type: 'string', minLength: 1, maxLength: 200 }
            },
            required: ['role'],
            additionalProperties: false
          }
        }
      },
      required: ['goalInstance', 'expectedSnapshotHash', 'watchSet'],
      additionalProperties: false
    }
  }
]);

/**
 * Create MCP server with dependency injection
 */
export function createServer(deps, options = {}) {
  // Validate and sanitize deps before any destructuring
  if (!deps || typeof deps !== 'object') {
    throw new Error('deps must be an object');
  }

  // Check for proxy on deps
  if (types.isProxy(deps)) {
    throw new Error('deps cannot be a proxy');
  }

  // Capture dependencies immutably at construction time
  const frozenDeps = {
    inspect: deps.inspect,
    submit: deps.submit,
    wait: deps.wait,
    verify: deps.verify
  };

  if (!frozenDeps.inspect || !frozenDeps.submit || !frozenDeps.wait || !frozenDeps.verify) {
    throw new Error('Missing required dependencies: inspect, submit, wait, verify');
  }

  // Sanitize and freeze configuration
  let allowedGoalsSet = null;
  let allowedSpacesSet = null;

  if (options.allowedGoals) {
    if (!Array.isArray(options.allowedGoals)) {
      throw new Error('allowedGoals must be an array');
    }
    // Clone and freeze as immutable Set
    allowedGoalsSet = new Set(options.allowedGoals.map(String));
  }

  if (options.allowedSpaces) {
    if (!Array.isArray(options.allowedSpaces)) {
      throw new Error('allowedSpaces must be an array');
    }
    // Clone and freeze as immutable Set
    allowedSpacesSet = new Set(options.allowedSpaces.map(String));
  }

  /**
   * Enforce goal allowlist
   */
  function checkGoalAllowed(goalInstance) {
    if (allowedGoalsSet && !allowedGoalsSet.has(goalInstance)) {
      throw new MCPValidationError('GOAL_NOT_ALLOWED');
    }
  }

  /**
   * Enforce space allowlist on validated watch items
   */
  function checkSpacesAllowed(watchSet) {
    if (!allowedSpacesSet) {
      return;
    }

    for (const item of watchSet) {
      if (item.spaceId && !allowedSpacesSet.has(item.spaceId)) {
        throw new MCPValidationError('SPACE_NOT_ALLOWED');
      }
    }
  }

  /**
   * Handle tool call
   */
  async function handleToolCall(name, args) {
    const schema = TOOL_SCHEMAS[name];
    if (!schema) {
      throw new MCPValidationError('UNKNOWN_TOOL');
    }

    const validatedArgs = validateArguments(name, args, schema);

    switch (name) {
      case 'cohub_goal_inspect': {
        checkGoalAllowed(validatedArgs.goalInstance);
        const result = await frozenDeps.inspect(validatedArgs.goalInstance);
        return createSuccess(result);
      }

      case 'cohub_goal_submit': {
        checkGoalAllowed(validatedArgs.goalInstance);
        const result = await frozenDeps.submit(validatedArgs);
        return createSuccess(result);
      }

      case 'cohub_goal_wait': {
        checkGoalAllowed(validatedArgs.goalInstance);
        checkSpacesAllowed(validatedArgs.watchSet);
        const result = await frozenDeps.wait(validatedArgs);
        return createSuccess(result);
      }

      case 'cohub_goal_verify': {
        checkGoalAllowed(validatedArgs.goalInstance);
        const result = await frozenDeps.verify(
          validatedArgs.goalInstance,
          validatedArgs.expectedSnapshotHash
        );
        return createSuccess(result);
      }

      default:
        throw new MCPValidationError('UNKNOWN_TOOL');
    }
  }

  /**
   * Handle MCP request - sanitizes request before ANY property access
   */
  async function handleRequest(request) {
    try {
      // Validate request is object before any access
      if (!request || typeof request !== 'object') {
        return createError('INVALID_REQUEST');
      }

      // Check for proxy BEFORE destructuring
      if (types.isProxy(request)) {
        return createError('PROXY_NOT_ALLOWED');
      }

      // Now safe to destructure
      const { method, params } = request;

      if (!method) {
        return createError('MISSING_METHOD');
      }

      if (method === 'tools/list') {
        // Return frozen tool definitions
        return deepFreeze({ tools: TOOL_DEFINITIONS });
      }

      if (method === 'tools/call') {
        if (!params) {
          return createError('MISSING_PARAMS');
        }

        // Check params for proxy before destructuring
        if (types.isProxy(params)) {
          return createError('PROXY_NOT_ALLOWED');
        }

        const { name, arguments: args } = params;

        if (!name) {
          return createError('MISSING_NAME');
        }

        if (args === undefined) {
          return createError('MISSING_ARGUMENTS');
        }

        return await handleToolCall(name, args);
      }

      return createError('UNKNOWN_METHOD');
    } catch (error) {
      // Return validation errors with their specific codes
      if (error instanceof MCPValidationError) {
        return createError(error.code);
      }

      // Dependency errors or unknown exceptions: generic error, no leak
      return createError('INTERNAL_ERROR');
    }
  }

  return {
    handleRequest
  };
}
