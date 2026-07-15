// Stable CohubPort contract. Any transport (real SDK or fake test double) must
// implement exactly this surface. Nothing in this module ever talks to a real
// network or file system.

import { types } from 'node:util';

export const COHUB_PORT_METHODS = Object.freeze([
  'connect',
  'subscribe',
  'waitForSubscribeAck',
  'onEvent',
  'getSessionIndex',
  'getTurn',
  'readRunFile',
  'sendPrompt',
  'findTurnByClientMessageId',
  'getTrustedExecutionContext',
  'close',
]);

export class CohubPortContractError extends Error {
  constructor(missing) {
    super(`CohubPort implementation is missing required method(s): ${missing.join(', ')}`);
    this.name = 'CohubPortContractError';
    this.missing = missing;
  }
}

export class CohubPortNotImplementedError extends Error {
  constructor(method) {
    super(`CohubPort method "${method}" has no production implementation. Refusing to fake success.`);
    this.name = 'CohubPortNotImplementedError';
    this.method = method;
  }
}

/**
 * Validates that `impl` implements every method in the stable CohubPort
 * contract via exact own data descriptors, then returns a new object exposing
 * exactly that surface (no leaked private helpers). Never mutates `impl`.
 *
 * Security: Rejects Proxy, accessor properties, extra methods, symbol properties.
 * Captures each method once at construction and binds to impl to prevent
 * post-validation mutation from affecting the returned port.
 */
export function assertCohubPort(impl) {
  // Proxy check BEFORE any property access
  if (types.isProxy(impl)) {
    throw new CohubPortContractError(['Proxy implementations are not allowed']);
  }

  if (!impl || typeof impl !== 'object') {
    throw new CohubPortContractError(['implementation must be an object']);
  }

  // Check for symbol properties (fail-closed)
  const symbols = Object.getOwnPropertySymbols(impl);
  if (symbols.length > 0) {
    throw new CohubPortContractError(['implementation must not have symbol properties']);
  }

  // Get all own property names
  const ownKeys = Object.getOwnPropertyNames(impl);

  // Check for extra properties beyond the contract
  const extraKeys = ownKeys.filter(key => !COHUB_PORT_METHODS.includes(key));
  if (extraKeys.length > 0) {
    throw new CohubPortContractError([`unexpected properties: ${extraKeys.join(', ')}`]);
  }

  // Validate each required method exists and is a proper data property
  const missing = [];
  const captured = {};

  for (const name of COHUB_PORT_METHODS) {
    const desc = Object.getOwnPropertyDescriptor(impl, name);

    if (!desc) {
      missing.push(name);
      continue;
    }

    // Reject accessor properties
    if (desc.get || desc.set) {
      throw new CohubPortContractError([`${name} must be a data property, not an accessor`]);
    }

    // Must be a function
    if (typeof desc.value !== 'function') {
      missing.push(name);
      continue;
    }

    // Capture the method once and bind to impl
    captured[name] = desc.value.bind(impl);
  }

  if (missing.length > 0) {
    throw new CohubPortContractError(missing);
  }

  // Return frozen port with captured methods
  const port = {};
  for (const name of COHUB_PORT_METHODS) {
    port[name] = (...args) => captured[name](...args);
  }
  return Object.freeze(port);
}

/**
 * A CohubPort whose every method throws CohubPortNotImplementedError. Used as
 * an explicit placeholder so unsupported production calls fail loudly instead
 * of silently returning fake success.
 */
export function createUnimplementedCohubPort() {
  const impl = {};
  for (const name of COHUB_PORT_METHODS) {
    impl[name] = () => {
      throw new CohubPortNotImplementedError(name);
    };
  }
  return assertCohubPort(impl);
}
