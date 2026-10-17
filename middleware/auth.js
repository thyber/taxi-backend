'use strict';

const logger = require('../logger');

// Autenticación de usuario para el proxy de mapas mediante Firebase ID token.
//
// IMPORTANTE (diseño/seguridad):
//   - firebase-admin se carga de forma PEREZOSA (lazy). Así, requerir el
//     router de mapas NUNCA provoca que el servidor entero falle al arrancar
//     si la credencial no está configurada: solo las peticiones con Bearer
//     fallarán (401), de forma cerrada.
//   - La credencial se lee EXCLUSIVAMENTE de process.env.FIREBASE_SERVICE_ACCOUNT
//     (JSON en una línea). No se lee ningún archivo de credenciales del repo.
//   - Se verifica con checkRevoked=true para invalidar tokens de sesiones revocadas.
//   - La respuesta al cliente es genérica; el detalle solo va al log del servidor.

let cachedAdmin = null;

function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  // require perezoso: evita dependencia dura en tiempo de carga/módulo.
  cachedAdmin = require('firebase-admin');
  return cachedAdmin;
}

function initFirebase(admin) {
  if (Array.isArray(admin.apps) && admin.apps.length > 0) {
    return admin;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    const err = new Error('FIREBASE_SERVICE_ACCOUNT_NOT_CONFIGURED');
    err.code = 'FIREBASE_SERVICE_ACCOUNT_NOT_CONFIGURED';
    throw err;
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (_e) {
    const err = new Error('FIREBASE_SERVICE_ACCOUNT_INVALID_JSON');
    err.code = 'FIREBASE_SERVICE_ACCOUNT_INVALID_JSON';
    throw err;
  }
  admin.initializeApp({ credential: admin.credential.cert(credentials) });
  return admin;
}

async function verifyIdToken(idToken) {
  const admin = initFirebase(getAdmin());
  // checkRevoked=true: consulta si el token fue revocado antes de su expiración.
  return admin.auth().verifyIdToken(idToken, true);
}

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      logger.warn('Maps auth: petición sin cabecera Bearer');
      return res.status(401).json({
        success: false,
        message: 'No se proporcionó token de autenticación'
      });
    }

    const idToken = authHeader.slice('Bearer '.length);
    const decodedToken = await verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      role: decodedToken.role || 'user',
      // Claim administrativo EXPLÍCITO: solo true si el token firmado por
      // Firebase lo incluye. Nunca se deriva de valores enviados por el cliente.
      isAdmin: decodedToken.admin === true
    };

    logger.info('Maps auth: token verificado', { uid: decodedToken.uid });
    return next();
  } catch (error) {
    // El detalle solo al log del servidor; la respuesta HTTP no revela internos.
    logger.warn('Maps auth: verificación de token fallida', {
      reason: error && error.code ? error.code : 'verify_failed'
    });
    return res.status(401).json({
      success: false,
      message: 'Token de autenticación inválido o expirado'
    });
  }
};

module.exports = authMiddleware;
module.exports.verifyIdToken = verifyIdToken;
module.exports.initFirebase = initFirebase;
