'use strict';

const crypto = require('crypto');
const logger = require('../logger');
const defaultAuthMiddleware = require('./auth');

// FASE 7F.8A: autenticación del proxy de mapas.
//
// Modalidades EXCLUYENTES y separadas:
//   1) Apps móviles: Firebase ID token en `Authorization: Bearer <token>`,
//      verificado por el middleware de auth (verifyIdToken con checkRevoked).
//   2) Servidor-a-servidor (chatbot): secreto compartido en la cabecera
//      `x-internal-service-token`, comparado en tiempo constante.
//
// Sin credencial válida la petición se rechaza (401). La cabecera de servicio no
// concede privilegios administrativos ni se mezcla con la identidad de usuario.
//
// Nota de integración: este backend también expone login propio con JWT
// (jsonwebtoken) para sus usuarios. El proxy de mapas NO acepta ese JWT: solo
// Firebase ID tokens (apps) o el token de servicio (chatbot). Ver informe.

const SERVICE_TOKEN_HEADER = 'x-internal-service-token';
const MIN_SERVICE_TOKEN_LENGTH = 16;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getConfiguredServiceToken(env) {
  const source = env || process.env;
  const token = source.MAPS_PROXY_SERVICE_TOKEN;
  if (typeof token !== 'string') return null;
  if (token.trim().length < MIN_SERVICE_TOKEN_LENGTH) return null;
  return token;
}

function createMapsAuth(options = {}) {
  const firebaseAuth = options.firebaseAuth || defaultAuthMiddleware;
  const getServiceToken = options.getServiceToken || (() => getConfiguredServiceToken(options.env));

  return async function mapsAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    // Modalidad 1: Firebase ID token de las apps.
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return firebaseAuth(req, res, next);
    }

    // Modalidad 2: token de servicio del chatbot, solo si está configurado.
    const provided = req.headers[SERVICE_TOKEN_HEADER];
    const expected = getServiceToken();
    if (typeof provided === 'string' && expected && safeEqual(provided, expected)) {
      req.mapsClient = { type: 'service' };
      return next();
    }

    if (typeof provided === 'string' && provided.length > 0 && !expected) {
      logger.warn('Maps proxy: se recibió token de servicio pero MAPS_PROXY_SERVICE_TOKEN no está configurado');
    }

    return res.status(401).json({
      success: false,
      message: 'No autorizado'
    });
  };
}

module.exports = createMapsAuth;
module.exports.getConfiguredServiceToken = getConfiguredServiceToken;
module.exports.SERVICE_TOKEN_HEADER = SERVICE_TOKEN_HEADER;
