/**
 * @fileoverview Strict descriptor-walking sanitizer for untrusted snapshot data.
 *
 * First operation on any object value is types.isProxy check.
 * Rejects: proxies (revoked/top/nested), accessors, symbols, dangerous keys,
 * custom prototypes, sparse/extra arrays, cycles, shared refs, unsupported values,
 * non-finite numbers, excessive depth/bytes.
 *
 * Never skips validation, never coerces, never uses JSON.stringify fallback,
 * never spreads untrusted data, never includes raw dependency error text.
 *
 * Output is detached plain data, recursively frozen.
 * Caller values remain unchanged/extensible.
 */

import { types } from 'node:util';

const MAX_DEPTH = 32;
const MAX_BYTES = 10 * 1024 * 1024; // 10MB serialized size limit

// Dangerous keys that must never appear in snapshot data
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'valueOf',
  'toString',
  'toJSON'
]);

/**
 * Sanitize and deep-clone untrusted snapshot data.
 *
 * @param {any} value - Untrusted value to sanitize
 * @param {object} [options] - Optional configuration
 * @returns {any} Sanitized, detached, recursively frozen value
 * @throws {TypeError} On any validation failure
 */
export function sanitize(value, options = {}) {
  const visited = new Map(); // Track refs for cycle/sharing detection
  let byteCount = 0;

  const result = sanitizeRecursive(value, 0, visited);

  // Final deep freeze
  deepFreeze(result);

  return result;

  function sanitizeRecursive(val, depth, visited) {
    // Depth check
    if (depth > MAX_DEPTH) {
      throw new TypeError(`Depth limit exceeded: maximum ${MAX_DEPTH} levels`);
    }

    // Primitives: null, undefined, boolean, number, string
    if (val === null || val === undefined) {
      return val;
    }

    const type = typeof val;

    if (type === 'boolean') {
      return val;
    }

    if (type === 'number') {
      if (!Number.isFinite(val)) {
        throw new TypeError('Non-finite numbers (Infinity, NaN) are not allowed');
      }
      return val;
    }

    if (type === 'string') {
      byteCount += val.length;
      if (byteCount > MAX_BYTES) {
        throw new TypeError(`Byte limit exceeded: maximum ${MAX_BYTES} bytes`);
      }
      return val;
    }

    if (type === 'symbol') {
      throw new TypeError('Symbol values are not allowed');
    }

    if (type === 'bigint') {
      throw new TypeError('BigInt values are not allowed');
    }

    if (type === 'function') {
      throw new TypeError('Function values are not allowed');
    }

    // From here, must be object
    if (type !== 'object') {
      throw new TypeError(`Unsupported type: ${type}`);
    }

    // FIRST object operation: check for Proxy (before ANY other operation)
    if (types.isProxy(val)) {
      throw new TypeError('Proxy objects are not allowed');
    }

    // Check for cycles and shared references
    if (visited.has(val)) {
      throw new TypeError('Circular references and shared references are not allowed');
    }
    visited.set(val, true);

    // Get prototype before any other operation
    const proto = Object.getPrototypeOf(val);
    const isArray = Array.isArray(val);
    const isPlainObject = proto === Object.prototype || proto === null;

    if (!isArray && !isPlainObject) {
      throw new TypeError('Custom prototypes are not allowed (only plain objects and arrays)');
    }

    if (isArray) {
      return sanitizeArray(val, depth, visited);
    } else {
      return sanitizeObject(val, depth, visited);
    }
  }

  function sanitizeArray(arr, depth, visited) {
    const cloned = [];

    // Check for sparse array (holes)
    for (let i = 0; i < arr.length; i++) {
      if (!(i in arr)) {
        throw new TypeError('Sparse arrays are not allowed');
      }

      const desc = Object.getOwnPropertyDescriptor(arr, i);
      if (!desc) {
        throw new TypeError(`Array element ${i} has no descriptor`);
      }

      if (desc.get || desc.set) {
        throw new TypeError(`Array element ${i} has accessor property`);
      }

      if (!desc.enumerable) {
        throw new TypeError(`Array element ${i} is not enumerable`);
      }

      cloned[i] = sanitizeRecursive(desc.value, depth + 1, visited);
    }

    // Check for extra non-index properties (except 'length')
    const ownKeys = Object.getOwnPropertyNames(arr);
    for (const key of ownKeys) {
      if (key === 'length') continue;
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
        throw new TypeError(`Array has extra non-index property: ${key}`);
      }
    }

    // Check for symbol keys
    const symbolKeys = Object.getOwnPropertySymbols(arr);
    if (symbolKeys.length > 0) {
      throw new TypeError('Symbol keys are not allowed on arrays');
    }

    return cloned;
  }

  function sanitizeObject(obj, depth, visited) {
    const cloned = {};

    // Get all own property names (excludes symbols by default)
    const ownKeys = Object.getOwnPropertyNames(obj);

    for (const key of ownKeys) {
      // Check for dangerous keys
      if (DANGEROUS_KEYS.has(key)) {
        throw new TypeError(`Dangerous key not allowed: ${key}`);
      }

      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) {
        throw new TypeError(`Property ${key} has no descriptor`);
      }

      if (desc.get || desc.set) {
        throw new TypeError(`Property ${key} has accessor property`);
      }

      if (!desc.enumerable) {
        throw new TypeError(`Property ${key} is not enumerable`);
      }

      cloned[key] = sanitizeRecursive(desc.value, depth + 1, visited);
    }

    // Check for symbol keys
    const symbolKeys = Object.getOwnPropertySymbols(obj);
    if (symbolKeys.length > 0) {
      throw new TypeError('Symbol keys are not allowed on objects');
    }

    return cloned;
  }
}

/**
 * Recursively freeze an object and all nested objects/arrays.
 */
function deepFreeze(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  // Freeze the object itself first
  Object.freeze(obj);

  // Recursively freeze all property values
  const values = Object.values(obj);
  for (const value of values) {
    if (value !== null && typeof value === 'object') {
      deepFreeze(value);
    }
  }

  return obj;
}

/**
 * Create frozen result object with descriptor-safe non-writable properties.
 * All nested values are also recursively frozen.
 *
 * @param {object} obj - Plain object with properties to freeze
 * @returns {object} Frozen object with non-writable, non-configurable properties
 */
export function freezeOutput(obj) {
  const frozen = {};

  for (const [key, value] of Object.entries(obj)) {
    Object.defineProperty(frozen, key, {
      value: value,
      writable: false,
      enumerable: true,
      configurable: false
    });
  }

  Object.freeze(frozen);

  // Deep freeze all nested structures
  for (const value of Object.values(frozen)) {
    if (value !== null && typeof value === 'object') {
      deepFreeze(value);
    }
  }

  return frozen;
}
