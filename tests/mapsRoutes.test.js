'use strict';

// FASE 4: pruebas del cableado de rutas /api/maps y de la conservación de las
// rutas originales de server.js. Sin red y sin dependencias (Express se simula).
// Ejecuta con: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Intercepta require('express') ANTES de cargar el router, para no necesitar la
// dependencia real instalada.
const fakeExpress = require('./helpers/fakeExpress');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return fakeExpress;
  return originalLoad.apply(this, arguments);
};

const createMapsRoutes = require('../routes/maps');
const { MapsProxyError } = require('../services/mapsProxyService');

const passThroughAuth = (req, res, next) => { req.user = { uid: 'test-user' }; next(); };
const passThroughRateLimit = { middleware: () => (req, res, next) => next() };

function fakeRes() {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  return res;
}

function buildRouter(service, mapsAuth, rateLimiter) {
  return createMapsRoutes({
    service,
    mapsAuth: mapsAuth || passThroughAuth,
    rateLimiter: rateLimiter || passThroughRateLimit
  });
}

function handlerFor(router, routePath) {
  const entry = router.stack.find((s) => s.method === 'get' && s.path === routePath);
  assert.ok(entry, `ruta ${routePath} no registrada`);
  // handlers = [rateLimit, asyncHandler]
  return entry.handlers[entry.handlers.length - 1];
}

test('el router registra exactamente las cuatro rutas esperadas', () => {
  const router = buildRouter({ execute: () => Promise.resolve({}) });
  const gets = router.stack.filter((s) => s.method === 'get').map((s) => s.path).sort();
  assert.deepEqual(gets, ['/directions', '/geocode', '/places/autocomplete', '/places/details'].sort());
  // No debe registrar rutas fuera del conjunto cerrado.
  assert.equal(router.stack.some((s) => s.method === 'get' && s.path === '/elevation'), false);
});

test('el router aplica autenticación a nivel de router (router.use)', () => {
  const router = buildRouter({ execute: () => Promise.resolve({}) });
  assert.ok(router.stack.some((s) => s.method === 'use'));
});

test('handler de /directions reenvía la operación y los parámetros al servicio', async () => {
  const calls = [];
  const service = { execute: (op, params) => { calls.push({ op, params }); return Promise.resolve({ status: 'OK' }); } };
  const router = buildRouter(service);
  const res = fakeRes();
  await handlerFor(router, '/directions')({ query: { origin: '1,2', destination: '3,4' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: 'OK' });
  assert.equal(calls[0].op, 'directions');
  assert.deepEqual(calls[0].params, { origin: '1,2', destination: '3,4' });
});

test('error de validación (400) se traduce con mensaje genérico', async () => {
  const service = { execute: () => Promise.reject(new MapsProxyError('MAPS_INVALID_PARAMS', 400, 'Parámetros de la solicitud inválidos')) };
  const router = buildRouter(service);
  const res = fakeRes();
  await handlerFor(router, '/directions')({ query: { origin: 'bad' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { success: false, message: 'Parámetros de la solicitud inválidos' });
});

test('clave ausente (503) no filtra detalles', async () => {
  const service = { execute: () => Promise.reject(new MapsProxyError('GOOGLE_MAPS_SERVER_KEY_MISSING', 503, 'Servicio de mapas no configurado')) };
  const router = buildRouter(service);
  const res = fakeRes();
  await handlerFor(router, '/geocode')({ query: { latlng: '1,2' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify(res.body).match(/KEY|key|key=/), null);
});

test('error inesperado (500) no filtra detalles internos', async () => {
  const service = { execute: () => Promise.reject(new Error('boom with KEY=abcdef')) };
  const router = buildRouter(service);
  const res = fakeRes();
  await handlerFor(router, '/directions')({ query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.stringify(res.body).includes('abcdef'), false);
});

test('sin autenticación no obtiene acceso (integración mapsAuth real)', async () => {
  const createMapsAuth = require('../middleware/mapsAuth');
  const mapsAuth = createMapsAuth({
    firebaseAuth: (req, res) => res.status(401).json({ success: false, message: 'No autorizado' }),
    env: {}
  });
  const router = buildRouter({ execute: () => Promise.resolve({}) }, mapsAuth, passThroughRateLimit);
  // El middleware de auth está en router.stack; lo invocamos para verificar 401.
  const authEntry = router.stack.find((s) => s.method === 'use');
  const res = fakeRes();
  let next = false;
  await authEntry.args[0]({ headers: {} }, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 401);
});

test('server.js conserva las rutas existentes y añade el montaje de /api/maps', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const preserved = [
    "/api/auth/register/driver",
    "/api/auth/register/passenger",
    "/api/auth/login/driver",
    "/api/auth/login/passenger",
    "/api/health",
    "/api/drivers",
    "/api/rides",
    "/api/stats",
    "/api/ride/estimate",
    "/api/ride/request"
  ];
  for (const route of preserved) {
    assert.ok(serverSrc.includes(route), `ruta original ausente en server.js: ${route}`);
  }
  assert.ok(serverSrc.includes("require('./routes/maps')"), 'falta el require del router de mapas');
  assert.ok(serverSrc.includes("app.use('/api/maps'"), 'falta el montaje de /api/maps');
});

test.after(() => {
  Module._load = originalLoad;
});
