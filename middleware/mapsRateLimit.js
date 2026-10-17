'use strict';

const logger = require('../logger');

// FASE 7F.8A.1: limitación de solicitudes del proxy de Google Maps.
//
// Se ejecuta DESPUÉS de mapsAuth (la identidad ya está verificada) y ANTES de
// que la ruta llame al proveedor. Nunca convierte una petición anónima en
// autenticada: sin identidad verificada responde 401 sin crear contadores.
//
// Almacenamiento EN MEMORIA y LOCAL AL PROCESO:
//   - No es un límite distribuido; con varias instancias cada una aplica su
//     propio cupo y un reinicio del proceso borra los contadores.
//   - No garantiza un techo de gasto total frente a Google; las cuotas y
//     restricciones de API en Google Cloud son la protección complementaria.
//
// Identidad:
//   - Firebase: UID verificado por el middleware de auth (req.user.uid). Nunca
//     se usa un UID enviado por el cliente ni X-Forwarded-For.
//   - Servicio interno (chatbot): tras validar x-internal-service-token, se usa
//     una identidad fija de servicio. El token NUNCA se usa como clave ni se
//     registra.

const OPERATIONS = ['directions', 'geocode', 'placesAutocomplete', 'placesDetails'];

// Valores predeterminados PROVISIONALES (no hay métricas reales de tráfico).
const DEFAULT_LIMITS = Object.freeze({
  windowMs: 60 * 1000,
  perIdentity: Object.freeze({
    directions: 30,
    geocode: 30,
    placesAutocomplete: 60,
    placesDetails: 60
  }),
  serviceAggregate: 180,
  globalBurst: 900
});

// Límites SUPERIORES seguros: una variable mal formada o fuera de rango NUNCA
// desactiva la protección, se usa el valor predeterminado.
const LIMIT_BOUNDS = Object.freeze({
  windowMs: { min: 1000, max: 600 * 1000 },
  perIdentity: { min: 1, max: 1000 },
  serviceAggregate: { min: 1, max: 5000 },
  globalBurst: { min: 1, max: 10000 }
});

const SWEEP_EVERY_CHECKS = 256;

function parseBoundedInt(raw, { min, max }, fallback) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

// Lee y valida la configuración por entorno. Cualquier valor inválido cae al
// predeterminado; nunca se desactiva el límite.
function readLimits(env) {
  const source = env || process.env;
  const perIdentity = {};
  for (const operation of OPERATIONS) {
    const envName = 'MAPS_RATE_LIMIT_' + operation.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
    perIdentity[operation] = parseBoundedInt(
      source[envName],
      LIMIT_BOUNDS.perIdentity,
      DEFAULT_LIMITS.perIdentity[operation]
    );
  }
  return {
    windowMs: parseBoundedInt(source.MAPS_RATE_LIMIT_WINDOW_MS, LIMIT_BOUNDS.windowMs, DEFAULT_LIMITS.windowMs),
    perIdentity,
    serviceAggregate: parseBoundedInt(
      source.MAPS_RATE_LIMIT_SERVICE,
      LIMIT_BOUNDS.serviceAggregate,
      DEFAULT_LIMITS.serviceAggregate
    ),
    globalBurst: parseBoundedInt(source.MAPS_RATE_LIMIT_GLOBAL, LIMIT_BOUNDS.globalBurst, DEFAULT_LIMITS.globalBurst)
  };
}

// Contador de ventana fija con limpieza automática de entradas expiradas.
class RateLimitStore {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
    this.checksSinceSweep = 0;
    const interval = options.sweepIntervalMs || 5 * 60 * 1000;
    this.timer = setInterval(() => this.sweep(), interval);
    if (this.timer.unref) this.timer.unref();
  }

  sweep() {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= t) this.entries.delete(key);
    }
  }

  // Evalúa todos los contadores; si alguno excedería, rechaza SIN consumir
  // ninguno. Si todos admiten, incrementa todos (evita consumo parcial).
  checkAll(checks) {
    const t = this.now();
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep >= SWEEP_EVERY_CHECKS) {
      this.checksSinceSweep = 0;
      this.sweep();
    }

    let retryAfterMs = 0;
    for (const { key, limit } of checks) {
      const entry = this.entries.get(key);
      const count = !entry || entry.resetAt <= t ? 0 : entry.count;
      if (count + 1 > limit) {
        const wait = Math.max(0, (entry ? entry.resetAt : t) - t);
        return { allowed: false, retryAfterMs: Math.max(wait, 1) };
      }
      if (entry && entry.resetAt > t) retryAfterMs = Math.max(retryAfterMs, entry.resetAt - t);
    }

    for (const { key, windowMs } of checks) {
      const entry = this.entries.get(key);
      if (!entry || entry.resetAt <= t) {
        this.entries.set(key, { count: 1, resetAt: t + windowMs });
      } else {
        entry.count += 1;
      }
    }
    return { allowed: true, retryAfterMs };
  }

  size() {
    return this.entries.size;
  }

  stop() {
    clearInterval(this.timer);
  }
}

function resolveChecks(req, operation, limits) {
  const perOpLimit = limits.perIdentity[operation] || LIMIT_BOUNDS.perIdentity.min;
  const checks = [];
  let clientType;

  const serviceClient = req.mapsClient;
  const user = req.user;

  if (serviceClient && serviceClient.type === 'service') {
    clientType = 'service';
    checks.push({ key: `service:${operation}`, limit: perOpLimit, windowMs: limits.windowMs });
    checks.push({ key: 'service:aggregate', limit: limits.serviceAggregate, windowMs: limits.windowMs });
  } else if (user && typeof user.uid === 'string' && user.uid.length > 0) {
    clientType = 'user';
    checks.push({ key: `user:${user.uid}:${operation}`, limit: perOpLimit, windowMs: limits.windowMs });
  } else {
    return null;
  }

  checks.push({ key: 'global:all', limit: limits.globalBurst, windowMs: limits.windowMs });
  return { clientType, checks };
}

function createMapsRateLimiter(options = {}) {
  const limits = readLimits(options.env);
  const store = options.store || new RateLimitStore({ now: options.now });
  const log = options.logger || logger;

  function middleware(operation) {
    return function mapsRateLimit(req, res, next) {
      const resolved = resolveChecks(req, operation, limits);
      if (!resolved) {
        // No debería ocurrir tras mapsAuth; se rechaza sin autenticar ni contar.
        return res.status(401).json({ success: false, message: 'No autorizado' });
      }

      const result = store.checkAll(resolved.checks);
      if (!result.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.set('Retry-After', String(retryAfterSec));
        log.warn('Maps proxy rate limit exceeded', { operation, clientType: resolved.clientType });
        return res.status(429).json({
          success: false,
          message: 'Demasiadas solicitudes. Inténtalo de nuevo más tarde.'
        });
      }
      return next();
    };
  }

  return {
    middleware,
    limits,
    store,
    stop: () => store.stop()
  };
}

module.exports = createMapsRateLimiter;
module.exports.readLimits = readLimits;
module.exports.RateLimitStore = RateLimitStore;
module.exports.DEFAULT_LIMITS = DEFAULT_LIMITS;
module.exports.LIMIT_BOUNDS = LIMIT_BOUNDS;
