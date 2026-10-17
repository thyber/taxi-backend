'use strict';

// Express falso mínimo para pruebas SIN instalar dependencias.
// Registra .use() y .get() para poder verificar el cableado de rutas y, luego,
// invocar directamente los handlers con objetos req/res simulados.

class FakeRouter {
  constructor() {
    this.stack = [];
  }
  use(...args) {
    this.stack.push({ method: 'use', args });
    return this;
  }
  get(path, ...handlers) {
    this.stack.push({ method: 'get', path, handlers });
    return this;
  }
}

module.exports = {
  Router: () => new FakeRouter()
};
