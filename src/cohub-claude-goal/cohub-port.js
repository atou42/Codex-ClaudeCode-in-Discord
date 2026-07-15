// Stable CohubPort contract. Any transport (real SDK or fake test double) must
// implement exactly this surface. Nothing in this module ever talks to a real
// network or file system.

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
 * contract, then returns a new object exposing exactly that surface (no
 * leaked private helpers). Never mutates `impl`.
 */
export function assertCohubPort(impl) {
  const missing = COHUB_PORT_METHODS.filter((name) => typeof impl?.[name] !== 'function');
  if (missing.length > 0) {
    throw new CohubPortContractError(missing);
  }

  const port = {};
  for (const name of COHUB_PORT_METHODS) {
    port[name] = (...args) => impl[name](...args);
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
