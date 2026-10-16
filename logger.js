'use strict';

// Logger mínimo, sin dependencias externas (winston NO está disponible en este
// repositorio). Mantiene la misma interfaz usada por el proxy de mapas:
// logger.info / warn / error / debug.
//
// Objetivo de seguridad: NO registrar credenciales. Los llamadores solo pasan
// metadatos (operación, código, uid, requestId), nunca tokens ni claves.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel() {
  const raw = typeof process.env.LOG_LEVEL === 'string' ? process.env.LOG_LEVEL.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? raw : 'info';
}

let currentLevel = resolveLevel();

function log(level, message, meta) {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: 'taxi-backend',
    message
  };
  if (meta && typeof meta === 'object') {
    // Copia defensiva para no mutar lo recibido.
    Object.assign(line, meta);
  }
  const sink = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  sink(JSON.stringify(line));
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
  debug: (message, meta) => log('debug', message, meta),
  setLevel: (level) => {
    if (Object.prototype.hasOwnProperty.call(LEVELS, level)) currentLevel = level;
  }
};
