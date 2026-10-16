'use strict';

// FASE 4: pruebas de la autenticación del proxy (sin red, sin Firebase real).
// Ejecuta con: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert');
const createMapsAuth = require('../middleware/mapsAuth');

const SERVICE_TOKEN = 'integrated-service-token-1234567890';

function fakeReq(headers = {}) {
  return { headers };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  return res;
}

test('sin credenciales → 401', async () => {
  const auth = createMapsAuth({ firebaseAuth: (rq, rs) => rs.status(401).json({ success: false }) });
  const res = fakeRes();
  let nextCalled = false;
  await auth(fakeReq(), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('token de servicio incorrecto → 401', async () => {
  const auth = createMapsAuth({
    firebaseAuth: (rq, rs) => rs.status(401).json({ success: false }),
    env: { MAPS_PROXY_SERVICE_TOKEN: SERVICE_TOKEN }
  });
  const res = fakeRes();
  let nextCalled = false;
  await auth(fakeReq({ 'x-internal-service-token': 'wrong-token-000000000' }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('token de servicio correcto → next() con identidad de servicio', async () => {
  const auth = createMapsAuth({
    firebaseAuth: (rq, rs) => rs.status(401).json({ success: false }),
    env: { MAPS_PROXY_SERVICE_TOKEN: SERVICE_TOKEN }
  });
  const req = fakeReq({ 'x-internal-service-token': SERVICE_TOKEN });
  const res = fakeRes();
  let nextCalled = false;
  await auth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.mapsClient, { type: 'service' });
});

test('token de servicio no configurado → 401 (falla cerrado)', async () => {
  const auth = createMapsAuth({
    firebaseAuth: (rq, rs) => rs.status(401).json({ success: false }),
    env: {}
  });
  const res = fakeRes();
  let nextCalled = false;
  await auth(fakeReq({ 'x-internal-service-token': SERVICE_TOKEN }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('token de servicio demasiado corto se ignora (mínimo 16)', () => {
  const getConfiguredServiceToken = require('../middleware/mapsAuth').getConfiguredServiceToken;
  assert.equal(getConfiguredServiceToken({ MAPS_PROXY_SERVICE_TOKEN: 'short' }), null);
  assert.equal(getConfiguredServiceToken({ MAPS_PROXY_SERVICE_TOKEN: '1234567890123456' }), '1234567890123456');
});

test('Bearer delega en la verificación de Firebase (identidad de usuario)', async () => {
  let delegated = false;
  const fakeFirebaseAuth = (req, res, next) => { delegated = true; req.user = { uid: 'u1' }; return next(); };
  const auth = createMapsAuth({ firebaseAuth: fakeFirebaseAuth, env: {} });
  const req = fakeReq({ authorization: 'Bearer some-id-token' });
  const res = fakeRes();
  let nextCalled = false;
  await auth(req, res, () => { nextCalled = true; });
  assert.equal(delegated, true);
  assert.equal(nextCalled, true);
  assert.equal(req.user.uid, 'u1');
});
