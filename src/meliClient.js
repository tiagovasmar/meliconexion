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
  if (!res.ok) {
    console.error(`[meli-mcp] Error de Mercado Libre en ${path}: status=${res.status} body=${JSON.stringify(body)}`);
    throw new MeliApiError(res.status, body);
  }
  return body;
}

/** Identidad del vendedor autenticado (usada también para verificar el token). */
async function getMe(accessToken) {
  return meliFetch('/users/me', accessToken);
}

/** Publicaciones (ítems) del vendedor. */
async function searchListings(accessToken, sellerId, { status, offset = 0, limit = 50 } = {}) {
  const params = { offset, limit: Math.min(limit, 50) };
  if (status) params.status = status;
  return meliFetch(`/users/${sellerId}/items/search`, accessToken, params);
}

/** Detalle de varios ítems de una vez (hasta 20). */
async function getItemsBulk(accessToken, ids) {
  if (!ids.length) return [];
  return meliFetch('/items', accessToken, { ids: ids.slice(0, 20).join(',') });
}

/** ID de anunciante de Mercado Ads (Product Ads) para esta cuenta. */
async function getAdvertiser(accessToken) {
  return meliFetch('/advertising/advertisers', accessToken, { product_id: 'PADS' });
}

/** Campañas de Mercado Ads con métricas sumarizadas de un período. */
async function getAdsCampaignsSummary(accessToken, siteId, advertiserId, { dateFrom, dateTo }) {
  const url = new URL(`${API_BASE}/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search`);
  url.searchParams.set('date_from', dateFrom);
  url.searchParams.set('date_to', dateTo);
  url.searchParams.set('metrics_summary', 'true');
  url.searchParams.set(
    'metrics',
    'clicks,prints,ctr,cost,cpc,acos,direct_amount,indirect_amount,total_amount,direct_units_quantity,indirect_units_quantity,units_quantity,roas,cvr'
  );
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, 'api-version': '2' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[meli-mcp] Error de Mercado Libre (ads) status=${res.status} body=${JSON.stringify(body)}`);
    throw new MeliApiError(res.status, body);
  }
  return body;
}

/** Períodos de facturación disponibles (últimos meses). */
async function getBillingPeriods(accessToken, { documentType = 'BILL', group = 'ML', limit = 3 } = {}) {
  return meliFetch('/billing/integration/monthly/periods', accessToken, { document_type: documentType, group, limit });
}

/** Resumen de cargos/bonificaciones de un período de facturación (incluye gasto en Ads, comisiones, envíos). */
async function getBillingSummary(accessToken, key, { documentType = 'BILL', group = 'ML' } = {}) {
  return meliFetch(`/billing/integration/periods/key/${key}/summary/details`, accessToken, {
    document_type: documentType,
    group
  });
}

/** Visitas totales a las publicaciones del vendedor en un rango de fechas. */
async function getUserVisits(accessToken, sellerId, { dateFrom, dateTo }) {
  return meliFetch(`/users/${sellerId}/items_visits`, accessToken, { date_from: dateFrom, date_to: dateTo });
}

/** Preguntas recibidas de compradores (más recientes primero). */
async function getReceivedQuestions(accessToken, { offset = 0, limit = 20, status } = {}) {
  const params = { offset, limit: Math.min(limit, 50) };
  if (status) params.status = status;
  return meliFetch('/my/received_questions/search', accessToken, params);
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

module.exports = {
  getMe,
  searchOrders,
  getOrder,
  searchListings,
  getItemsBulk,
  getAdvertiser,
  getAdsCampaignsSummary,
  getBillingPeriods,
  getBillingSummary,
  getUserVisits,
  getReceivedQuestions,
  MeliApiError
};
