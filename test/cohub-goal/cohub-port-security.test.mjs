import test from 'node:test';
import assert from 'node:assert/strict';

import { assertCohubPort, COHUB_PORT_METHODS } from '../../src/cohub-claude-goal/cohub-port.js';

function createValidImpl() {
  const impl = {};
  for (const name of COHUB_PORT_METHODS) {
    impl[name] = async () => ({ ok: true });
  }
  return impl;
}

test('PORT-SEC-01: Proxy implementation rejected', () => {
  const impl = createValidImpl();
  const proxy = new Proxy(impl, {});

  assert.throws(
    () => assertCohubPort(proxy),
    /proxy/i,
    'must reject Proxy implementation'
  );
});

test('PORT-SEC-02: accessor method rejected', () => {
  const impl = createValidImpl();
  Object.defineProperty(impl, 'connect', {
    get() { return async () => ({ ok: true }); }
  });

  assert.throws(
    () => assertCohubPort(impl),
    /accessor|getter/i,
    'must reject accessor properties'
  );
});

test('PORT-SEC-03: extra methods beyond contract rejected', () => {
  const impl = createValidImpl();
  impl.extraMethod = async () => {};

  assert.throws(
    () => assertCohubPort(impl),
    /extra|unexpected|unknown/i,
    'must reject implementations with extra methods'
  );
});

test('PORT-SEC-04: port methods captured once at construction', async () => {
  const impl = createValidImpl();
  let callCount = 0;
  impl.connect = async () => { callCount += 1; return { ok: true }; };

  const port = assertCohubPort(impl);

  // Change impl after port creation
  impl.connect = async () => { throw new Error('should not call this'); };

  // Port must use captured reference
  await port.connect();
  assert.equal(callCount, 1, 'must use captured method reference');
});

test('PORT-SEC-05: returned port is frozen', () => {
  const impl = createValidImpl();
  const port = assertCohubPort(impl);

  assert.throws(
    () => { port.newMethod = () => {}; },
    'returned port must be frozen'
  );

  assert.throws(
    () => { port.connect = () => {}; },
    'port methods must be immutable'
  );
});

test('PORT-SEC-06: impl mutation after validation does not affect port', async () => {
  const impl = createValidImpl();
  const port = assertCohubPort(impl);

  // Attacker mutates impl after validation
  impl.getTurn = async () => { throw new Error('malicious'); };

  // Port uses captured original
  const result = await port.getTurn();
  assert.deepEqual(result, { ok: true });
});

test('PORT-SEC-07: non-function method rejected', () => {
  const impl = createValidImpl();
  impl.connect = 'not-a-function';

  assert.throws(
    () => assertCohubPort(impl),
    /missing.*method|function/i,
    'must reject non-function methods'
  );
});

test('PORT-SEC-08: symbol properties rejected', () => {
  const impl = createValidImpl();
  impl[Symbol('hidden')] = async () => {};

  assert.throws(
    () => assertCohubPort(impl),
    /symbol|unexpected/i,
    'must reject symbol properties'
  );
});
