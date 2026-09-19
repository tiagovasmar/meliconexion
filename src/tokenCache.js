// Cache simple en memoria (no persiste entre reinicios, y no hace falta que lo haga:
// es solo para no pegarle a /users/me en cada llamada dentro de una misma sesión corta).
const TTL_MS = 2 * 60 * 1000; // 2 minutos
const cache = new Map(); // token -> { value, expiresAt }

function get(token) {
  const hit = cache.get(token);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(token);
    return undefined;
  }
  return hit.value;
}

function set(token, value) {
  cache.set(token, { value, expiresAt: Date.now() + TTL_MS });
}

module.exports = { get, set };
