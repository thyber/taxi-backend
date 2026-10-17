'use strict';

// FASE 7F.8A: Servicio proxy de Google Maps.
//
// Objetivo: concentrar en el backend las llamadas REST a las Web Service APIs
// de Google Maps (Directions, Geocoding, Places Autocomplete, Places Details)
// para que las apps móviles y el chatbot NO necesiten una clave de Google con
// APIs de servidor habilitadas (que no pueden restringirse por app Android).
//
// Principios de seguridad:
//   - La clave se lee EXCLUSIVAMENTE de process.env.GOOGLE_MAPS_SERVER_KEY.
//     Sin valor por defecto, sin fallback, sin literal en el código.
//   - Solo se puede invocar un conjunto CERRADO de operaciones; cada operación
//     mapea a un path fijo de maps.googleapis.com. No es un proxy genérico: no
//     se aceptan URLs, hosts ni paths suministrados por el cliente.
//   - Toda entrada se valida (tipo, formato, tamaño) antes de reenviarse.
//   - Los errores hacia el cliente son genéricos y nunca incluyen la clave,
//     la URL construida ni detalles internos.

const https = require('https');

const GOOGLE_MAPS_HOST = 'maps.googleapis.com';

// Conjunto cerrado de operaciones permitidas y sus endpoints Google fijos.
const OPERATIONS = Object.freeze({
  directions: Object.freeze({
    path: '/maps/api/directions/json',
    required: ['origin', 'destination']
  }),
  geocode: Object.freeze({
    path: '/maps/api/geocode/json',
    required: ['latlng']
  }),
  placesAutocomplete: Object.freeze({
    path: '/maps/api/place/autocomplete/json',
    required: ['input']
  }),
  placesDetails: Object.freeze({
    path: '/maps/api/place/details/json',
    required: ['place_id']
  })
});

// Coordenada "lat,lng" con rangos válidos.
const COORDINATE_RE = /^-?\d{1,3}(?:\.\d{1,10})?,-?\d{1,3}(?:\.\d{1,10})?$/;
// Place ID de Google: alfanumérico con guiones/guiones bajos.
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const LANGUAGE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;
const COUNTRY_COMPONENT_RE = /^country:[A-Z]{2}$/;
const DIRECTIONS_MODES = ['driving', 'walking', 'bicycling', 'transit'];

const MAX_INPUT_LENGTH = 200;
const MAX_RADIUS_METERS = 50000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB

class MapsProxyError extends Error {
  constructor(code, status, publicMessage) {
    super(publicMessage);
    this.name = 'MapsProxyError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function invalid(message) {
  return new MapsProxyError('MAPS_INVALID_PARAMS', 400, message || 'Parámetros de la solicitud inválidos');
}

function isCoordinatePair(value) {
  if (typeof value !== 'string' || !COORDINATE_RE.test(value)) return false;
  const [latRaw, lngRaw] = value.split(',');
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

function isSingleString(value) {
  return typeof value === 'string';
}

// Normaliza y valida los parámetros según la operación. Devuelve un objeto con
// SOLO las claves permitidas, o lanza MapsProxyError(400).
function normalizeParams(operation, raw) {
  const op = OPERATIONS[operation];
  if (!op) {
    throw new MapsProxyError('MAPS_UNKNOWN_OPERATION', 400, 'Operación de mapas no permitida');
  }
  const params = raw && typeof raw === 'object' ? raw : {};

  for (const key of op.required) {
    const value = params[key];
    if (!isSingleString(value) || value.trim().length === 0) {
      throw invalid('Falta un parámetro obligatorio');
    }
  }

  if (operation === 'directions') {
    if (!isCoordinatePair(params.origin)) throw invalid('Origen inválido');
    if (!isCoordinatePair(params.destination)) throw invalid('Destino inválido');
    const out = { origin: params.origin, destination: params.destination };
    if (params.mode !== undefined) {
      if (!isSingleString(params.mode) || !DIRECTIONS_MODES.includes(params.mode)) {
        throw invalid('Modo de viaje no permitido');
      }
      out.mode = params.mode;
    }
    return out;
  }

  if (operation === 'geocode') {
    if (!isCoordinatePair(params.latlng)) throw invalid('Coordenadas inválidas');
    const out = { latlng: params.latlng };
    if (params.language !== undefined) {
      if (!isSingleString(params.language) || !LANGUAGE_RE.test(params.language)) throw invalid('Idioma inválido');
      out.language = params.language;
    }
    return out;
  }

  if (operation === 'placesAutocomplete') {
    const input = params.input;
    if (input.length > MAX_INPUT_LENGTH || /[\u0000-\u001f]/.test(input)) throw invalid('Consulta inválida');
    const out = { input: input.trim() };
    if (params.location !== undefined) {
      if (!isCoordinatePair(params.location)) throw invalid('Ubicación inválida');
      out.location = params.location;
    }
    if (params.radius !== undefined) {
      if (!isSingleString(params.radius) || !/^\d{1,5}$/.test(params.radius)) throw invalid('Radio inválido');
      const radius = Number(params.radius);
      if (radius < 1 || radius > MAX_RADIUS_METERS) throw invalid('Radio inválido');
      out.radius = params.radius;
    }
    if (params.components !== undefined) {
      if (!isSingleString(params.components) || !COUNTRY_COMPONENT_RE.test(params.components)) {
        throw invalid('Filtro de componentes inválido');
      }
      out.components = params.components;
    }
    if (params.language !== undefined) {
      if (!isSingleString(params.language) || !LANGUAGE_RE.test(params.language)) throw invalid('Idioma inválido');
      out.language = params.language;
    }
    return out;
  }

  if (operation === 'placesDetails') {
    if (!isSingleString(params.place_id) || !PLACE_ID_RE.test(params.place_id)) throw invalid('place_id inválido');
    const out = { place_id: params.place_id };
    if (params.language !== undefined) {
      if (!isSingleString(params.language) || !LANGUAGE_RE.test(params.language)) throw invalid('Idioma inválido');
      out.language = params.language;
    }
    return out;
  }

  // Inalcanzable por el conjunto cerrado anterior.
  throw new MapsProxyError('MAPS_UNKNOWN_OPERATION', 400, 'Operación de mapas no permitida');
}

// Traduce una respuesta HTTP aguas arriba a datos o a MapsProxyError seguro.
// Función pura para poder probar los caminos de error sin red.
function upstreamDataFromResponse(statusCode, body) {
  if (statusCode < 200 || statusCode >= 300) {
    throw new MapsProxyError('MAPS_UPSTREAM_HTTP', 502, 'El servicio de mapas no está disponible');
  }
  try {
    return JSON.parse(body);
  } catch (_e) {
    throw new MapsProxyError('MAPS_UPSTREAM_INVALID', 502, 'El servicio de mapas devolvió una respuesta inválida');
  }
}

// Clasifica un error de red/timeout del cliente HTTPS sin exponer detalles.
function upstreamErrorFromError(error) {
  const message = error && error.message;
  if (message === 'timeout') {
    return new MapsProxyError('MAPS_UPSTREAM_TIMEOUT', 502, 'El servicio de mapas no está disponible');
  }
  if (message === 'response too large') {
    return new MapsProxyError('MAPS_UPSTREAM_INVALID', 502, 'El servicio de mapas devolvió una respuesta inválida');
  }
  return new MapsProxyError('MAPS_UPSTREAM_NETWORK', 502, 'El servicio de mapas no está disponible');
}

// GET JSON por HTTPS con timeout y sin exponer la URL en errores.
function httpsRequestJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('response too large'));
        }
      });
      res.on('end', () => {
        try {
          resolve(upstreamDataFromResponse(res.statusCode, body));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', (error) => {
      reject(upstreamErrorFromError(error));
    });
  });
}

class MapsProxyService {
  constructor(options = {}) {
    this.getApiKey = options.getApiKey || (() => process.env.GOOGLE_MAPS_SERVER_KEY);
    this.requestJson = options.requestJson || ((url) => httpsRequestJson(url, this.timeoutMs));
    this.timeoutMs = options.timeoutMs || 8000;
  }

  // Ejecuta una operación permitida y devuelve la respuesta JSON de Google tal
  // cual (los clientes ya parsean los campos de Google). Lanza MapsProxyError
  // con un `status` HTTP sugerido ante cualquier fallo.
  async execute(operation, rawParams) {
    if (!OPERATIONS[operation]) {
      throw new MapsProxyError('MAPS_UNKNOWN_OPERATION', 400, 'Operación de mapas no permitida');
    }

    const apiKey = this.getApiKey();
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new MapsProxyError('GOOGLE_MAPS_SERVER_KEY_MISSING', 503, 'Servicio de mapas no configurado');
    }

    const params = normalizeParams(operation, rawParams);
    const op = OPERATIONS[operation];
    const query = new URLSearchParams(params);
    query.set('key', apiKey);
    const url = `https://${GOOGLE_MAPS_HOST}${op.path}?${query.toString()}`;

    return this.requestJson(url);
  }
}

module.exports = {
  MapsProxyService,
  MapsProxyError,
  OPERATIONS,
  normalizeParams,
  isCoordinatePair,
  upstreamDataFromResponse,
  upstreamErrorFromError
};
