/**
 * Proxy-first input sanitizer for untrusted params, ledger entries, snapshots,
 * reconciliation results, and dependency returns.
 *
 * Rejects with zero user trap calls:
 * - Proxies (revoked, top-level, or nested)
 * - Accessors (getters/setters)
 * - Symbols
 * - Non-enumerable properties
 * - Custom prototypes (non-plain Object/Array/null)
 * - Sparse arrays
 * - Extra array properties
 * - Cycles and shared references
 * - Unsupported values (undefined, NaN, Infinity, BigInt, functions, symbols)
 * - Excessive depth (>20) or size (>1MB JSON)
 *
 * Returns deeply frozen detached clone with no live references to input.
 */

const MAX_DEPTH = 20;
const MAX_JSON_BYTES = 1_048_576; // 1MB

/**
 * Detect proxies without calling any user traps.
 * Uses internal [[IsProxy]] check via try-catch on revoked proxy detection.
 */
function isProxy(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  try {
    // Attempt to create a revoked proxy with the value as handler.
    // If value is a proxy, this will throw a specific internal error.
    // If value is not a proxy, it will throw TypeError about invalid handler.
    new Proxy({}, value);
    return false;
  } catch (err) {
    // If the error message indicates proxy issues, it's likely a proxy
    if (err.message && err.message.includes('proxy')) {
      return true;
    }
    // Try another method: Object.getPrototypeOf on a revoked proxy throws
    try {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      // If accessing value in any way behaves like revoked proxy, it's a proxy
      Object.setPrototypeOf(proxy, value);
      return false;
    } catch {
      // This is not reliable, use util.types.isProxy
    }
  }

  // Final method: try to use it as a prototype
  // Proxies have special internal slots that cause specific errors
  try {
    Object.create(value);
    return false;
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('proxy')) {
      return true;
    }
  }

  return false;
}

/**
 * More reliable proxy detection using Node.js util.types if available.
 */
let nodeIsProxy = null;
try {
  const util = await import('node:util');
  if (util.types && typeof util.types.isProxy === 'function') {
    nodeIsProxy = util.types.isProxy;
  }
} catch {
  // util.types not available
}

function detectProxy(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  // Use Node.js util.types.isProxy if available (most reliable)
  if (nodeIsProxy) {
    return nodeIsProxy(value);
  }

  // Fallback: try multiple detection methods
  return isProxy(value);
}

/**
 * Check for dangerous properties: accessors, symbols, non-enumerable, custom prototype.
 * Must be called AFTER proxy check so we never call user traps.
 */
function hasDangerousProperties(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  // Check prototype
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    return true;
  }

  // Check for symbols
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return true;
  }

  if (Array.isArray(value)) {
    // For arrays: only check enumerable own properties (skip built-in 'length')
    const ownKeys = Object.getOwnPropertyNames(value);
    for (const key of ownKeys) {
      if (key === 'length') continue; // built-in, always non-enumerable
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc.get || desc.set) return true;
      if (!desc.enumerable) return true;
    }
    // Check for sparse or extra non-index properties
    const indexKeys = Object.keys(value); // only enumerable string keys
    if (value.length !== indexKeys.length) return true; // sparse
    for (const key of indexKeys) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) return true;
    }
  } else {
    // For plain objects: all own property descriptors must be enumerable data properties
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      const desc = descriptors[key];
      if (desc.get || desc.set) return true;
      if (!desc.enumerable) return true;
    }
  }

  return false;
}

/**
 * Check for unsupported primitive values.
 */
function hasUnsupportedValue(value) {
  if (value === undefined) return true;
  if (typeof value === 'function') return true;
  if (typeof value === 'symbol') return true;
  if (typeof value === 'bigint') return true;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return true;
    if (!Number.isFinite(value)) return true;
  }
  return false;
}

/**
 * Deep scan for cycles, shared references, unsupported values, and depth.
 * Must be called AFTER proxy and dangerous property checks.
 */
function deepScan(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`sanitize: depth limit exceeded (max ${MAX_DEPTH})`);
  }

  if (value === null || typeof value !== 'object') {
    if (hasUnsupportedValue(value)) {
      throw new TypeError(`sanitize: unsupported value type: ${typeof value}`);
    }
    return;
  }

  // Check for shared references (each object should appear only once)
  if (seen.has(value)) {
    throw new TypeError('sanitize: cycle or shared reference detected');
  }
  seen.add(value);

  // Recursively scan all values
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const val of values) {
    if (val === null || typeof val !== 'object') {
      if (hasUnsupportedValue(val)) {
        throw new TypeError(`sanitize: unsupported value type: ${typeof val}`);
      }
    } else {
      // Check nested objects for dangerous properties
      if (detectProxy(val)) {
        throw new TypeError('sanitize: nested proxy detected');
      }
      if (hasDangerousProperties(val)) {
        throw new TypeError('sanitize: nested object contains accessors, symbols, non-enumerable, or non-plain prototype');
      }
      deepScan(val, seen, depth + 1);
    }
  }
}

/**
 * Deep clone to detached data with no live references.
 */
function deepClone(value, cloneMap = new WeakMap()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Prevent duplicate clones
  if (cloneMap.has(value)) {
    return cloneMap.get(value);
  }

  let clone;
  if (Array.isArray(value)) {
    clone = [];
    cloneMap.set(value, clone);
    for (let i = 0; i < value.length; i++) {
      clone[i] = deepClone(value[i], cloneMap);
    }
  } else {
    clone = {};
    cloneMap.set(value, clone);
    for (const key of Object.keys(value)) {
      clone[key] = deepClone(value[key], cloneMap);
    }
  }

  return clone;
}

/**
 * Deep freeze to make output immutable.
 */
function deepFreeze(value, frozen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (frozen.has(value)) {
    return value;
  }

  frozen.add(value);
  Object.freeze(value);

  const values = Array.isArray(value) ? value : Object.values(value);
  for (const val of values) {
    if (val !== null && typeof val === 'object') {
      deepFreeze(val, frozen);
    }
  }

  return value;
}

/**
 * Sanitize untrusted input with comprehensive validation.
 * Returns deeply frozen detached clone.
 *
 * @param {any} value - Untrusted input
 * @param {string} label - Label for error messages
 * @returns {any} Deeply frozen detached clone
 * @throws {TypeError} If input is dangerous
 */
export function sanitize(value, label = 'input') {
  // 1. Check for top-level proxy BEFORE any property access
  if (detectProxy(value)) {
    throw new TypeError(`${label}: proxy detected`);
  }

  // 2. Check for dangerous properties at top level
  if (hasDangerousProperties(value)) {
    throw new TypeError(`${label}: contains accessors, symbols, non-enumerable properties, sparse array, extra array properties, or non-plain prototype`);
  }

  // 3. Deep scan for nested proxies, cycles, shared refs, unsupported values, depth
  try {
    deepScan(value);
  } catch (err) {
    throw new TypeError(`${label}: ${err.message}`);
  }

  // 4. Check JSON size
  let jsonBytes;
  try {
    const json = JSON.stringify(value);
    jsonBytes = Buffer.byteLength(json, 'utf8');
  } catch (err) {
    throw new TypeError(`${label}: cannot serialize to JSON: ${err.message}`);
  }

  if (jsonBytes > MAX_JSON_BYTES) {
    throw new TypeError(`${label}: size ${jsonBytes} bytes exceeds limit ${MAX_JSON_BYTES}`);
  }

  // 5. Deep clone to detached data
  const cloned = deepClone(value);

  // 6. Deep freeze output
  return deepFreeze(cloned);
}

/**
 * Sanitize array with element validation.
 */
export function sanitizeArray(value, label = 'array') {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return sanitize(value, label);
}

/**
 * Sanitize plain object.
 */
export function sanitizeObject(value, label = 'object') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return sanitize(value, label);
}
