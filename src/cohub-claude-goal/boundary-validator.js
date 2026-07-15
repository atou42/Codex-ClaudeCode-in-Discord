/**
 * @fileoverview STRICT BOUNDARY VALIDATOR for Cohub goal controller.
 *
 * All outer dependencies and inputs must be:
 * - Proxy-first validated (util.types.isProxy before ANY property access)
 * - Descriptor-validated (no getters/setters)
 * - Exact schema match (unknown keys rejected, not filtered)
 * - Captured once, detached, deeply frozen before use
 * - Depth/size/string/number bounded
 * - No Array.isArray, destructure, optional chain, String(), JSON, callback, or property read before proven safe
 *
 * Errors must NOT leak key names, types, prototype details, or attacker text.
 */

import util from 'node:util';

const MAX_DEPTH = 100;
const MAX_ARRAY_LENGTH = 5000;
const MAX_STRING_LENGTH = 500_000;
const MAX_OBJECT_KEYS = 2000;

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate input is EXACTLY safe plain data matching allowedKeys schema.
 * NO silent filtering — unknown keys cause rejection.
 * Returns deeply frozen detached clone or throws.
 */
export function validateAndFreeze(value, allowedKeys = null, depth = 0, seen = new Map()) {
  // Depth limit
  if (depth > MAX_DEPTH) {
    throw new TypeError('DEPTH_LIMIT_EXCEEDED');
  }

  // Primitives
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    throw new TypeError('UNDEFINED_NOT_ALLOWED');
  }

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new TypeError('STRING_TOO_LONG');
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('INVALID_NUMBER');
    }
    return value;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  // Only object/array types remain
  if (typeof value !== 'object') {
    throw new TypeError('UNSUPPORTED_TYPE');
  }

  // CRITICAL: Detect Proxy BEFORE any property access
  if (util.types.isProxy(value)) {
    throw new TypeError('PROXY_NOT_ALLOWED');
  }

  // Cycle detection
  if (seen.has(value)) {
    throw new TypeError('CIRCULAR_REFERENCE');
  }
  seen.set(value, true);

  try {
    // Check prototype before Array.isArray (which might trigger traps)
    const proto = Object.getPrototypeOf(value);
    const isArrayValue = (proto === Array.prototype);

    if (!isArrayValue && proto !== Object.prototype && proto !== null) {
      throw new TypeError('INVALID_PROTOTYPE');
    }

    // Get all own property keys using Reflect
    const ownKeys = Reflect.ownKeys(value);

    // Reject symbol properties
    const symbols = ownKeys.filter(k => typeof k === 'symbol');
    if (symbols.length > 0) {
      throw new TypeError('SYMBOL_PROPERTIES_NOT_ALLOWED');
    }

    // Get all descriptors at once
    const descriptors = Object.getOwnPropertyDescriptors(value);

    // Check for accessor properties (getter/setter) without invoking
    for (const key of Object.keys(descriptors)) {
      const desc = descriptors[key];
      if (desc.get || desc.set) {
        throw new TypeError('ACCESSOR_PROPERTY_NOT_ALLOWED');
      }
    }

    // Check for pollution keys
    for (const key of Object.keys(descriptors)) {
      if (POLLUTION_KEYS.has(key)) {
        throw new TypeError('POLLUTION_KEY_NOT_ALLOWED');
      }
    }

    // Arrays
    if (isArrayValue) {
      if (value.length > MAX_ARRAY_LENGTH) {
        throw new TypeError('SIZE_LIMIT_EXCEEDED');
      }

      // Detect sparse arrays
      const numericKeys = Object.keys(descriptors).filter(k => !isNaN(parseInt(k, 10)));
      if (value.length !== numericKeys.length) {
        throw new TypeError('SPARSE_ARRAY_NOT_ALLOWED');
      }

      const cloned = [];
      for (let i = 0; i < value.length; i++) {
        cloned[i] = validateAndFreeze(value[i], null, depth + 1, seen);
      }
      seen.delete(value);
      return Object.freeze(cloned);
    }

    // Objects
    const keys = Object.keys(descriptors);

    if (keys.length > MAX_OBJECT_KEYS) {
      throw new TypeError('SIZE_LIMIT_EXCEEDED');
    }

    // If allowedKeys specified, reject unknown keys (do NOT filter silently)
    if (allowedKeys !== null) {
      for (const key of keys) {
        if (!allowedKeys.includes(key)) {
          throw new TypeError('UNKNOWN_FIELD_REJECTED');
        }
      }
    }

    const cloned = Object.create(null);
    const keysToProcess = allowedKeys ? keys.filter(k => allowedKeys.includes(k)) : keys;

    for (const key of keysToProcess) {
      cloned[key] = validateAndFreeze(value[key], null, depth + 1, seen);
    }

    seen.delete(value);
    return Object.freeze(cloned);
  } finally {
    seen.delete(value);
  }
}

/**
 * Validate required identity string - exact non-empty string, NO fallbacks.
 */
export function requireIdentityString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new TypeError('IDENTITY_MUST_BE_STRING');
  }
  if (value.trim() === '') {
    throw new TypeError('IDENTITY_MUST_NOT_BE_EMPTY');
  }
  return value;
}

/**
 * Create safe integrity error without leaking sensitive details.
 * NO key names, types, prototype names, or attacker text in error output.
 */
export function createIntegrityError(code, category = 'validation') {
  return Object.freeze({
    code,
    category
  });
}

/**
 * Validate outer boundary inputs BEFORE any property access.
 * Returns validation result with structured errors.
 */
export function validateOuterBoundary(localState, cohubReader, ledger) {
  const errors = [];

  // Validate localState
  try {
    if (!localState || typeof localState !== 'object') {
      errors.push(createIntegrityError('LOCALSTATE_INVALID', 'input'));
    } else if (util.types.isProxy(localState)) {
      errors.push(createIntegrityError('LOCALSTATE_PROXY_DETECTED', 'security'));
    }
  } catch (err) {
    errors.push(createIntegrityError('LOCALSTATE_VALIDATION_FAILED', 'input'));
  }

  // Validate cohubReader
  try {
    if (!cohubReader || typeof cohubReader !== 'object') {
      errors.push(createIntegrityError('READER_INVALID', 'input'));
    } else if (util.types.isProxy(cohubReader)) {
      errors.push(createIntegrityError('READER_PROXY_DETECTED', 'security'));
    }
  } catch (err) {
    errors.push(createIntegrityError('READER_VALIDATION_FAILED', 'input'));
  }

  // Validate ledger
  try {
    if (!ledger || typeof ledger !== 'object') {
      errors.push(createIntegrityError('LEDGER_INVALID', 'input'));
    } else if (util.types.isProxy(ledger)) {
      errors.push(createIntegrityError('LEDGER_PROXY_DETECTED', 'security'));
    }
  } catch (err) {
    errors.push(createIntegrityError('LEDGER_VALIDATION_FAILED', 'input'));
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors)
  };
}

/**
 * Deep freeze helper that ensures complete immutability.
 */
export function deepFreeze(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  Object.freeze(obj);

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }

  return obj;
}
