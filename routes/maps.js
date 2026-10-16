'use strict';

const express = require('express');
const logger = require('../logger');
const createMapsAuth = require('../middleware/mapsAuth');
const createMapsRateLimiter = require('../middleware/mapsRateLimit');
const { MapsProxyService, MapsProxyError } = require('../services/mapsProxyService');

// FASE 7F.8A / 7F.8A.1: rutas del proxy de mapas.
//
// Prefijo de montaje: /api/maps (ver server.js). Todas las rutas exigen
// autenticación (Firebase ID token de las apps o token de servicio del chatbot)
// y limitación de solicitudes (mapsRateLimit) ANTES de llamar al proveedor.
//
// Orden por ruta: auth → rate limit → proveedor. Una petición bloqueada NUNCA
// alcanza service.execute, por lo que no consume cuota de Google.

const ROUTES = [
  { path: '/directions', operation: 'directions' },
  { path: '/geocode', operation: 'geocode' },
  { path: '/places/autocomplete', operation: 'placesAutocomplete' },
  { path: '/places/details', operation: 'placesDetails' }
];

function createMapsRoutes(options = {}) {
  const router = express.Router();
  const service = options.service || new MapsProxyService();
  const mapsAuth = options.mapsAuth || createMapsAuth();
  const rateLimiter = options.rateLimiter || createMapsRateLimiter();

  router.use(mapsAuth);

  for (const { path, operation } of ROUTES) {
    router.get(path, rateLimiter.middleware(operation), async (req, res) => {
      try {
        const data = await service.execute(operation, req.query);
        return res.json(data);
      } catch (error) {
        if (error instanceof MapsProxyError) {
          if (error.status >= 500) {
            logger.error('Maps proxy request failed', {
              operation,
              code: error.code,
              requestId: req.requestId || 'unknown'
            });
          }
          return res.status(error.status).json({
            success: false,
            message: error.publicMessage
          });
        }
        logger.error('Maps proxy unexpected error', {
          operation,
          requestId: req.requestId || 'unknown',
          error: error && error.message
        });
        return res.status(500).json({
          success: false,
          message: 'Error interno al procesar la solicitud de mapas'
        });
      }
    });
  }

  return router;
}

module.exports = createMapsRoutes;
module.exports.ROUTES = ROUTES;
