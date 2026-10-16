'use strict';

// FASE 4: pruebas del rate limiting del proxy (sin red, sin dependencias).
// Ejecuta con: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert');
const createMapsRateLimiter = require('../middleware/mapsRateLimit');
const { RateLimitStore, readLimits, DEFAULT_LIMITS } = require('../middleware/mapsRateLimit');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeLimiter(env, now) {
  return createMapsRateLimiter({ env, now, logger: silentLogger });
}

function fakeRes() {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }
  };
  return res;
}

test('una identidad dentro del límite pasa al siguiente middleware', () => {
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '5' });
  const req = { user: { uid: 'u1' } };
  const res = fakeRes();
  let next = false;
  limiter.middleware('directions')(req, res, () => { next = true; });
  assert.equal(next, true);
  limiter.stop();
});

test('al alcanzar el límite → 429 con Retry-After', () => {
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '2' });
  const mw = limiter.middleware('directions');
  const req = { user: { uid: 'u2' } };
  assert.ok(callMw(mw, req).next);
  assert.ok(callMw(mw, req).next);
  const third = callMw(mw, req);
  assert.equal(third.next, false);
  assert.equal(third.res.statusCode, 429);
  assert.match(String(third.res.headers['Retry-After']), /^\d+$/);
  limiter.stop();
});

test('una identidad no consume el límite de otra', () => {
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '1' });
  const mw = limiter.middleware('directions');
  assert.ok(callMw(mw, { user: { uid: 'uA' } }).next);
  assert.ok(callMw(mw, { user: { uid: 'uB' } }).next);
  assert.equal(callMw(mw, { user: { uid: 'uA' } }).next, false);
  limiter.stop();
});

test('el servicio interno está sujeto a un límite agregado', () => {
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '10', MAPS_RATE_LIMIT_SERVICE: '3' });
  const mw = limiter.middleware('directions');
  const req = { mapsClient: { type: 'service' } };
  assert.ok(callMw(mw, req).next);
  assert.ok(callMw(mw, req).next);
  assert.ok(callMw(mw, req).next);
  assert.equal(callMw(mw, req).next, false);
  limiter.stop();
});

test('sin identidad verificada → 401 y no consume cuota', () => {
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '1' });
  const mw = limiter.middleware('directions');
  const r = callMw(mw, {});
  assert.equal(r.next, false);
  assert.equal(r.res.statusCode, 401);
  limiter.stop();
});

test('una petición bloqueada no debería llegar al proveedor (next no se llama)', () => {
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '1' });
  const mw = limiter.middleware('directions');
  const req = { user: { uid: 'u3' } };
  assert.ok(callMw(mw, req).next);
  assert.equal(callMw(mw, req).next, false);
  limiter.stop();
});

test('valores inválidos de entorno caen a los predeterminados seguros', () => {
  const fixed = readLimits({
    MAPS_RATE_LIMIT_DIRECTIONS: 'abc',
    MAPS_RATE_LIMIT_WINDOW_MS: '2000',
    MAPS_RATE_LIMIT_SERVICE: '999999',
    MAPS_RATE_LIMIT_GLOBAL: '0'
  });
  assert.equal(fixed.perIdentity.directions, DEFAULT_LIMITS.perIdentity.directions);
  assert.equal(fixed.windowMs, 2000);
  assert.equal(fixed.serviceAggregate, DEFAULT_LIMITS.serviceAggregate);
  assert.equal(fixed.globalBurst, DEFAULT_LIMITS.globalBurst);
});

test('la ventana temporal permite volver a solicitar tras expirar', () => {
  let t = 0;
  const limiter = makeLimiter({ MAPS_RATE_LIMIT_DIRECTIONS: '1', MAPS_RATE_LIMIT_WINDOW_MS: '1000' }, () => t);
  const mw = limiter.middleware('directions');
  const req = { user: { uid: 'u-win' } };
  assert.ok(callMw(mw, req).next);
  assert.equal(callMw(mw, req).next, false);
  t = 2000;
  assert.ok(callMw(mw, req).next);
  limiter.stop();
});

test('RateLimitStore limpia entradas expiradas con sweep()', () => {
  let t = 0;
  const store = new RateLimitStore({ now: () => t, sweepIntervalMs: 1000000 });
  store.stop();
  store.checkAll([{ key: 'k', limit: 10, windowMs: 1000 }]);
  assert.equal(store.size(), 1);
  t = 2000;
  store.sweep();
  assert.equal(store.size(), 0);
});

function callMw(mw, req) {
  const res = fakeRes();
  let next = false;
  mw(req, res, () => { next = true; });
  return { next, res };
}
