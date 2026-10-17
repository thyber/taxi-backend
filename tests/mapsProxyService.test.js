'use strict';

// FASE 4: pruebas del servicio proxy (lógica pura, sin red, sin dependencias).
// Ejecuta con: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert');
const {
  MapsProxyService,
  MapsProxyError,
  normalizeParams,
  isCoordinatePair,
  upstreamDataFromResponse,
  upstreamErrorFromError
} = require('../services/mapsProxyService');

test('isCoordinatePair acepta/niega coordenadas correctamente', () => {
  assert.equal(isCoordinatePair('-16.5,-68.15'), true);
  assert.equal(isCoordinatePair('0,0'), true);
  assert.equal(isCoordinatePair('91,0'), false);
  assert.equal(isCoordinatePair('0,181'), false);
  assert.equal(isCoordinatePair('abc'), false);
  assert.equal(isCoordinatePair('1,2,3'), false);
});

test('normalizeParams(directions) valida y filtra claves permitidas', () => {
  const out = normalizeParams('directions', {
    origin: '1,2', destination: '3,4', mode: 'driving',
    key: 'HACK', foo: 'bar'
  });
  assert.deepEqual(out, { origin: '1,2', destination: '3,4', mode: 'driving' });
});

test('normalizeParams(directions) rechaza modo no permitido', () => {
  assert.throws(
    () => normalizeParams('directions', { origin: '1,2', destination: '3,4', mode: 'teleport' }),
    (e) => e instanceof MapsProxyError && e.status === 400
  );
});

test('normalizeParams(geocode) exige latlng válido', () => {
  assert.deepEqual(normalizeParams('geocode', { latlng: '1,2' }), { latlng: '1,2' });
  assert.throws(() => normalizeParams('geocode', { latlng: 'bad' }), /Coordenadas inválidas/);
});

test('normalizeParams(placesAutocomplete) valida input, radio y components', () => {
  const out = normalizeParams('placesAutocomplete', {
    input: ' plaza ', location: '1,2', radius: '1000', components: 'country:BO', language: 'es'
  });
  assert.deepEqual(out, { input: 'plaza', location: '1,2', radius: '1000', components: 'country:BO', language: 'es' });
  assert.throws(() => normalizeParams('placesAutocomplete', { input: 'x', radius: '999999' }), /Radio inválido/);
  assert.throws(() => normalizeParams('placesAutocomplete', { input: 'x', components: 'country:ZZZ' }), /componentes/);
  assert.throws(() => normalizeParams('placesAutocomplete', { input: 'x'.repeat(201) }), /Consulta inválida/);
});

test('normalizeParams(placesDetails) valida place_id', () => {
  assert.deepEqual(normalizeParams('placesDetails', { place_id: 'ABC-123_xyz' }), { place_id: 'ABC-123_xyz' });
  assert.throws(() => normalizeParams('placesDetails', { place_id: 'bad id!' }), /place_id inválido/);
});

test('normalizeParams rechaza operación desconocida', () => {
  assert.throws(() => normalizeParams('elevation', { locations: '1,2' }), /no permitida/);
});

test('execute sin clave de servidor lanza 503 (no llama al proveedor)', async () => {
  let called = false;
  const svc = new MapsProxyService({
    getApiKey: () => undefined,
    requestJson: () => { called = true; return Promise.resolve({}); }
  });
  await assert.rejects(
    () => svc.execute('directions', { origin: '1,2', destination: '3,4' }),
    (e) => e instanceof MapsProxyError && e.status === 503
  );
  assert.equal(called, false);
});

test('execute construye la URL de Google y no filtra la clave en errores', async () => {
  const seen = [];
  const svc = new MapsProxyService({
    getApiKey: () => 'SERVER_KEY_SECRET',
    requestJson: (url) => { seen.push(url); return Promise.resolve({ status: 'OK' }); }
  });
  const data = await svc.execute('directions', { origin: '1,2', destination: '3,4', mode: 'driving' });
  assert.deepEqual(data, { status: 'OK' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith('https://maps.googleapis.com/maps/api/directions/json?'));
  assert.ok(seen[0].includes('origin=1%2C2'));
  assert.ok(seen[0].includes('key=SERVER_KEY_SECRET'));
});

test('upstreamDataFromResponse mapea errores HTTP/JSON a 502 seguro', () => {
  assert.deepEqual(upstreamDataFromResponse(200, '{"status":"OK"}'), { status: 'OK' });
  assert.throws(() => upstreamDataFromResponse(500, 'x'), (e) => e.status === 502);
  assert.throws(() => upstreamDataFromResponse(200, 'no-json'), (e) => e.code === 'MAPS_UPSTREAM_INVALID');
});

test('upstreamErrorFromError clasifica timeout/red sin filtrar detalles', () => {
  assert.equal(upstreamErrorFromError(new Error('timeout')).code, 'MAPS_UPSTREAM_TIMEOUT');
  assert.equal(upstreamErrorFromError(new Error('boom')).code, 'MAPS_UPSTREAM_NETWORK');
});

test('la clave del proveedor no aparece en el mensaje público de error', () => {
  const err = new MapsProxyError('GOOGLE_MAPS_SERVER_KEY_MISSING', 503, 'Servicio de mapas no configurado');
  assert.equal(JSON.stringify(err.publicMessage).includes('KEY'), false);
});
