const API_BASE = 'https://api.mercadolibre.com';

class MeliApiError extends Error {
  constructor(status, body) {
    super(`Mercado Libre API error ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function meliFetch(path, accessToken, searchParams) {
  const url = new URL(API_BASE + path);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new MeliApiError(res.status, body);
  return body;
}

/** Identidad del vendedor autenticado (usada también para verificar el token). */
async function getMe(accessToken) {
  return meliFetch('/users/me', accessToken);
}

/**
 * Busca órdenes del vendedor con filtros de fecha/estado, con paginado.
 * Usa order.date_closed (fecha de confirmación/pago) salvo que se pida por date_created.
 */
async function searchOrders(accessToken, sellerId, { dateFrom, dateTo, dateField = 'date_closed', status, offset = 0, limit = 50, sort = 'date_desc' } = {}) {
  const params = {
    seller: sellerId,
    offset,
    limit: Math.min(limit, 50),
    sort
  };
  if (dateFrom) params[`order.${dateField}.from`] = dateFrom;
  if (dateTo) params[`order.${dateField}.to`] = dateTo;
  if (status) params['order.status'] = status;
  return meliFetch('/orders/search', accessToken, params);
}

async function getOrder(accessToken, orderId) {
  return meliFetch(`/orders/${encodeURIComponent(orderId)}`, accessToken);
}

module.exports = { getMe, searchOrders, getOrder, MeliApiError };
