const SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'access_token',
  'refresh_token',
  'id_token',
  'authorization',
  'cookie',
  'set-cookie',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const JWT_PATTERN = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const MAX_OBJECT_SIZE = 5000; // max keys across all objects
const MAX_STRING_LENGTH = 500 * 1024; // 500KB

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key).toLowerCase());
}

/**
 * Recursively redact secrets from plain objects, arrays and native Errors.
 * Proxy-first: validates descriptors before reading any property.
 * Fail closed: throws on accessor, function, symbol, dangerous key, cycle,
 * shared reference, sparse array, extra array property, or unsupported type.
 * Returns deep-frozen detached objects with null prototype.
 * Never invokes user code (getters, constructors, or functions).
 */
export function redactSecrets(value, options = {}) {
  // Validate options Proxy-first
  if (options && Object.prototype.hasOwnProperty.call(options, 'sentinels')) {
    const sentinelsDesc = Object.getOwnPropertyDescriptor(options, 'sentinels');
    if (!sentinelsDesc || sentinelsDesc.get || sentinelsDesc.set) {
      throw new TypeError('redactSecrets: options.sentinels must be a data property');
    }
    if (!Array.isArray(sentinelsDesc.value)) {
      throw new TypeError('redactSecrets: sentinels must be an array');
    }
  }

  const { sentinels = [] } = options;

  const cleanSentinels = sentinels.filter((s) => typeof s === 'string' && s.length > 0);

  const seen = new WeakMap();
  const seenForSharing = new WeakMap();
  let totalKeys = 0;

  function redactString(str) {
    if (str.length > MAX_STRING_LENGTH) {
      throw new TypeError('redactSecrets: string exceeds maximum length');
    }
    let result = str;
    result = result.replace(JWT_PATTERN, '[REDACTED_TOKEN]');
    result = result.replace(BEARER_PATTERN, '[REDACTED_TOKEN]');
    for (const sentinel of cleanSentinels) {
      result = result.split(sentinel).join('[REDACTED]');
    }
    return result;
  }

  function redactKeyName(key) {
    let result = key;
    for (const sentinel of cleanSentinels) {
      if (result.includes(sentinel)) {
        result = result.split(sentinel).join('[REDACTED]');
      }
    }
    return result;
  }

  function redactKeyedEntry(key, desc, copy, usedKeys) {
    if (desc.get || desc.set) {
      // Never include the actual key name - it might contain secrets
      throw new TypeError('redactSecrets: refusing to invoke accessor property');
    }
    if (!('value' in desc)) {
      throw new TypeError('redactSecrets: unsupported property descriptor');
    }

    if (typeof key === 'symbol') {
      throw new TypeError('redactSecrets: symbol properties are not supported');
    }

    if (DANGEROUS_KEYS.has(key)) {
      throw new TypeError(`redactSecrets: dangerous key not allowed`);
    }

    const outKey = typeof key === 'string' ? redactKeyName(key) : key;

    if (usedKeys.has(outKey)) {
      throw new TypeError('redactSecrets: key collision after redaction');
    }
    usedKeys.add(outKey);

    copy[outKey] = isSecretKey(key) ? '[REDACTED]' : redact(desc.value);
  }

  function cloneOwnProperties(source, copy) {
    const usedKeys = new Set();
    const keys = Object.keys(source);
    const symbols = Object.getOwnPropertySymbols(source);

    if (symbols.length > 0) {
      throw new TypeError('redactSecrets: symbol properties are not supported');
    }

    for (const key of keys) {
      totalKeys++;
      if (totalKeys > MAX_OBJECT_SIZE) {
        throw new TypeError('redactSecrets: object size exceeds maximum');
      }
      const desc = Object.getOwnPropertyDescriptor(source, key);
      redactKeyedEntry(key, desc, copy, usedKeys);
    }
  }

  function redactErrorLike(val) {
    // Accept native Error types and custom Error subclasses
    const proto = Object.getPrototypeOf(val);

    // Check if it's in the Error prototype chain
    let current = proto;
    let isErrorType = false;
    let depth = 0;
    while (current !== null && depth < 10) {
      if (current === Error.prototype) {
        isErrorType = true;
        break;
      }
      current = Object.getPrototypeOf(current);
      depth++;
    }

    if (!isErrorType) {
      throw new TypeError('redactSecrets: only Error types are supported');
    }

    const redactedErr = Object.create(proto);
    seen.set(val, redactedErr);
    seenForSharing.set(val, true);

    // Read name through own property descriptor to avoid invoking user-defined getters
    const nameDesc = Object.getOwnPropertyDescriptor(val, 'name');
    if (nameDesc) {
      if (nameDesc.get || nameDesc.set) {
        throw new TypeError('redactSecrets: Error.name is a user-defined accessor');
      }
      redactedErr.name = nameDesc.value;
    } else {
      // Not an own property, read from prototype (standard Error.name behavior)
      redactedErr.name = val.name;
    }

    const messageDesc = Object.getOwnPropertyDescriptor(val, 'message');
    if (messageDesc) {
      if (messageDesc.get || messageDesc.set) {
        throw new TypeError('redactSecrets: Error.message is a user-defined accessor');
      }
      redactedErr.message = redactString(String(messageDesc.value));
    } else {
      redactedErr.message = redactString(String(val.message));
    }

    // Stack: check if it's an own property with accessor
    const stackDesc = Object.getOwnPropertyDescriptor(val, 'stack');
    if (stackDesc) {
      if (stackDesc.get || stackDesc.set) {
        // Check if it's enumerable - user-defined accessors are typically enumerable
        if (stackDesc.enumerable) {
          throw new TypeError('redactSecrets: Error.stack is a user-defined accessor');
        }
        // Native Error.stack accessor (non-enumerable) - safe to read
        if (typeof val.stack === 'string') {
          redactedErr.stack = redactString(val.stack);
        }
      } else if (typeof stackDesc.value === 'string') {
        redactedErr.stack = redactString(stackDesc.value);
      }
    } else if (typeof val.stack === 'string') {
      // Stack is inherited or auto-generated - safe to read
      redactedErr.stack = redactString(val.stack);
    }

    if (Object.prototype.hasOwnProperty.call(val, 'cause')) {
      const causeDesc = Object.getOwnPropertyDescriptor(val, 'cause');
      if (causeDesc.get || causeDesc.set) {
        throw new TypeError('redactSecrets: Error.cause is a user-defined accessor');
      }
      redactedErr.cause = redact(causeDesc.value);
    }

    const usedKeys = new Set(['name', 'message', 'stack', 'cause']);
    const keys = Object.keys(val);
    const symbols = Object.getOwnPropertySymbols(val);

    if (symbols.length > 0) {
      throw new TypeError('redactSecrets: symbol properties on Error are not supported');
    }

    for (const key of keys) {
      if (key === 'message' || key === 'name' || key === 'stack' || key === 'cause') continue;
      totalKeys++;
      if (totalKeys > MAX_OBJECT_SIZE) {
        throw new TypeError('redactSecrets: object size exceeds maximum');
      }
      const desc = Object.getOwnPropertyDescriptor(val, key);
      redactKeyedEntry(key, desc, redactedErr, usedKeys);
    }

    return Object.freeze(redactedErr);
  }

  function redact(val) {
    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val === 'string') {
      return redactString(val);
    }

    if (typeof val === 'function') {
      throw new TypeError('redactSecrets: function values are not supported');
    }

    if (typeof val === 'symbol') {
      throw new TypeError('redactSecrets: symbol values are not supported');
    }

    if (typeof val === 'bigint') {
      throw new TypeError('redactSecrets: BigInt values are not supported');
    }

    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw new TypeError('redactSecrets: non-finite numbers are not supported');
      }
      return val;
    }

    if (typeof val !== 'object') {
      return val;
    }

    // Reject cycles: if seen, it's a cycle
    if (seen.has(val)) {
      throw new TypeError('redactSecrets: cycles are not allowed');
    }

    // Reject shared references: if seen for sharing check, it's shared
    if (seenForSharing.has(val)) {
      throw new TypeError('redactSecrets: shared references are not allowed');
    }
    seenForSharing.set(val, true);

    if (val instanceof Error) {
      return redactErrorLike(val);
    }

    if (Array.isArray(val)) {
      const copy = [];
      seen.set(val, copy);

      // Check for non-numeric own properties
      const keys = Object.keys(val);
      for (const key of keys) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= val.length) {
          throw new TypeError('redactSecrets: array has non-numeric own property');
        }
      }

      // Check for symbols
      const symbols = Object.getOwnPropertySymbols(val);
      if (symbols.length > 0) {
        throw new TypeError('redactSecrets: symbol properties on array are not supported');
      }

      for (let i = 0; i < val.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(val, i);
        if (!desc) {
          throw new TypeError(`redactSecrets: array has a hole at index ${i}`);
        }
        if (desc.get || desc.set) {
          throw new TypeError('redactSecrets: refusing to invoke accessor property');
        }
        if (!('value' in desc)) {
          throw new TypeError('redactSecrets: unsupported property descriptor for array index');
        }
        copy.push(redact(desc.value));
      }

      seenForSharing.delete(val); // Remove before returning
      return Object.freeze(copy);
    }

    // Check if plain object (Object.prototype or null prototype only)
    const proto = Object.getPrototypeOf(val);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('redactSecrets: cannot safely redact unsupported object type');
    }

    const copy = Object.create(null);
    seen.set(val, copy);
    cloneOwnProperties(val, copy);

    seenForSharing.delete(val); // Remove before returning
    return Object.freeze(copy);
  }

  return redact(value);
}
