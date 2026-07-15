// Input sanitizer for untrusted config/event/dependency data.
//
// Fail-closed validation: reject Proxy (revoked or active), accessor
// properties, symbols, custom prototypes, sparse arrays, cycles, excessive
// sizes, and any unsupported value type. Return detached deep-frozen copies so
// subsequent mutation cannot affect business logic.
//
// Check types.isProxy BEFORE Array.isArray/Object.getPrototypeOf/property
// access to prevent attacker traps from running during validation.

import { types } from 'node:util';

const MAX_ARRAY_LENGTH = 10000;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 10000;

export class InputSanitizerError extends Error {
  constructor(message, path = []) {
    const fullMessage = path.length > 0
      ? `${message} at path: ${path.join('.')}`
      : message;
    super(fullMessage);
    this.name = 'InputSanitizerError';
    this.path = path;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function detectCycles(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  if (seen.has(value)) return true;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (detectCycles(item, seen)) return true;
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (detectCycles(value[key], seen)) return true;
    }
  }
  return false;
}

/**
 * Sanitize untrusted input with fail-closed validation. Returns a deeply
 * frozen, detached copy with no Proxy, accessor, symbol, prototype, cycle, or
 * excessive-size concerns.
 *
 * Options:
 *   allowedTypes: Set of allowed primitive type names (default: string, number, boolean, null)
 *   maxArrayLength: max array length (default: 10000)
 *   maxObjectKeys: max object key count (default: 100)
 *   maxStringLength: max string length (default: 10000)
 */
export function sanitizeInput(value, options = {}, path = []) {
  const {
    allowedTypes = new Set(['string', 'number', 'boolean', 'null']),
    maxArrayLength = MAX_ARRAY_LENGTH,
    maxObjectKeys = MAX_OBJECT_KEYS,
    maxStringLength = MAX_STRING_LENGTH,
  } = options;

  // Proxy check MUST come before any property access or type check that could trigger traps
  if (types.isProxy(value)) {
    throw new InputSanitizerError('Proxy objects are not allowed', path);
  }

  // null
  if (value === null) {
    if (!allowedTypes.has('null')) {
      throw new InputSanitizerError('null is not allowed', path);
    }
    return null;
  }

  // undefined
  if (value === undefined) {
    throw new InputSanitizerError('undefined is not allowed', path);
  }

  // primitives
  const valueType = typeof value;
  if (valueType === 'string') {
    if (!allowedTypes.has('string')) {
      throw new InputSanitizerError('string is not allowed', path);
    }
    if (value.length > maxStringLength) {
      throw new InputSanitizerError(`string exceeds max length ${maxStringLength}`, path);
    }
    return value;
  }

  if (valueType === 'number') {
    if (!allowedTypes.has('number')) {
      throw new InputSanitizerError('number is not allowed', path);
    }
    if (!Number.isFinite(value)) {
      throw new InputSanitizerError('non-finite numbers are not allowed', path);
    }
    return value;
  }

  if (valueType === 'boolean') {
    if (!allowedTypes.has('boolean')) {
      throw new InputSanitizerError('boolean is not allowed', path);
    }
    return value;
  }

  if (valueType === 'bigint') {
    if (!allowedTypes.has('bigint')) {
      throw new InputSanitizerError('bigint is not allowed', path);
    }
    return value;
  }

  if (valueType === 'symbol') {
    throw new InputSanitizerError('symbols are not allowed', path);
  }

  if (valueType === 'function') {
    throw new InputSanitizerError('functions are not allowed', path);
  }

  // Must be object or array at this point
  if (valueType !== 'object') {
    throw new InputSanitizerError(`unsupported type: ${valueType}`, path);
  }

  // Check for cycles BEFORE recursion
  if (detectCycles(value)) {
    throw new InputSanitizerError('circular references are not allowed', path);
  }

  // Array validation
  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      throw new InputSanitizerError(`array size excessive: max ${maxArrayLength}`, path);
    }

    // Reject sparse arrays
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        throw new InputSanitizerError('sparse arrays are not allowed', path);
      }
    }

    // Recursively sanitize elements
    const sanitized = value.map((item, idx) =>
      sanitizeInput(item, options, [...path, `[${idx}]`])
    );
    return Object.freeze(sanitized);
  }

  // Object validation
  if (!isPlainObject(value)) {
    throw new InputSanitizerError('objects must have Object.prototype or null prototype', path);
  }

  // Check for symbol properties
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new InputSanitizerError('objects with symbol properties are not allowed', path);
  }

  // Get all own property names
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > maxObjectKeys) {
    throw new InputSanitizerError(`object size excessive: max ${maxObjectKeys} keys`, path);
  }

  // Check for accessor properties
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) {
      throw new InputSanitizerError(`missing descriptor for key: ${key}`, path);
    }
    if (desc.get || desc.set) {
      throw new InputSanitizerError(`accessor properties are not allowed (key: ${key})`, path);
    }
    if (!desc.enumerable) {
      throw new InputSanitizerError(`non-enumerable properties are not allowed (key: ${key})`, path);
    }
  }

  // Recursively sanitize object properties
  const sanitized = {};
  for (const key of keys) {
    sanitized[key] = sanitizeInput(value[key], options, [...path, key]);
  }
  return Object.freeze(sanitized);
}

/**
 * Deep freeze helper that works recursively through arrays and objects.
 * Assumes input is already sanitized (no Proxy, cycles, etc).
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }

  return value;
}

/**
 * Validate and sanitize a config array (spaceIds, watchSet, etc).
 * Returns detached deep-frozen array.
 */
export function sanitizeConfigArray(arr, itemSchema, name = 'array') {
  if (types.isProxy(arr)) {
    throw new InputSanitizerError(`${name} must not be a Proxy`);
  }
  if (!Array.isArray(arr)) {
    throw new InputSanitizerError(`${name} must be an array`);
  }
  if (arr.length === 0) {
    throw new InputSanitizerError(`${name} must not be empty`);
  }

  const sanitized = sanitizeInput(arr, {
    allowedTypes: new Set(['string', 'number', 'boolean', 'null', 'object']),
  });

  // Additional item-level validation if schema provided
  if (itemSchema) {
    for (let i = 0; i < sanitized.length; i += 1) {
      itemSchema(sanitized[i], i);
    }
  }

  return sanitized;
}

/**
 * Validate and sanitize an optional hooks object.
 * Returns detached deep-frozen object or undefined if not provided.
 */
export function sanitizeHooks(hooks) {
  if (hooks === undefined) {
    return undefined;
  }
  if (types.isProxy(hooks)) {
    throw new InputSanitizerError('hooks must not be a Proxy');
  }
  if (typeof hooks !== 'object' || hooks === null) {
    throw new InputSanitizerError('hooks must be an object');
  }

  const sanitized = sanitizeInput(hooks, {
    allowedTypes: new Set(['function', 'null', 'undefined']),
    maxObjectKeys: 20,
  });

  return sanitized;
}
