const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const meli = require('./meliClient.js');

const ORDER_STATUSES = [
  'confirmed',
  'payment_required',
  'payment_in_process',
  'partially_paid',
  'paid',
  'partially_refunded',
  'pending_cancel',
  'cancelled'
];

function summarizeOrder(o) {
  return {
    id: o.id,
    status: o.status,
    date_created: o.date_created,
    date_closed: o.date_closed,
    total_amount: o.total_amount,
    currency_id: o.currency_id,
    pack_id: o.pack_id || null,
    items: (o.order_items || []).map((it) => ({
      item_id: it.item?.id,
      title: it.item?.title,
      variation_id: it.item?.variation_id || null,
      quantity: it.quantity,
      unit_price: it.unit_price,
      sale_fee: it.sale_fee,
      gross_price: it.gross_price
    })),
    tags: o.tags || []
  };
}

/**
 * Crea un McpServer con las herramientas de consulta de ventas.
 * accessToken y sellerId vienen del contexto de la request (ya autenticada).
 */
function buildMcpServer({ accessToken, sellerId }) {
  const server = new McpServer(
    { name: 'meli-ventas', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'meli_seller_info',
    {
      title: 'Datos de la cuenta vendedora',
      description: 'Devuelve identificación básica de la cuenta de Mercado Libre conectada (id, nickname, país).',
      inputSchema: {}
    },
    async () => {
      const me = await meli.getMe(accessToken);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { id: me.id, nickname: me.nickname, site_id: me.site_id, permalink: me.permalink },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    'meli_search_orders',
    {
      title: 'Buscar ventas por período',
      description:
        'Busca órdenes del vendedor en un rango de fechas (por defecto sobre date_closed, la fecha de confirmación/pago). ' +
        'Devuelve hasta 50 resultados por llamada; usá "offset" para paginar si el total supera eso. ' +
        'Recordá que Mercado Libre solo conserva hasta 12 meses de órdenes.',
      inputSchema: {
        date_from: z.string().describe('Fecha/hora ISO8601 de inicio, ej: 2026-09-01T00:00:00.000-03:00'),
        date_to: z.string().describe('Fecha/hora ISO8601 de fin, ej: 2026-09-30T23:59:59.000-03:00'),
        date_field: z
          .enum(['date_closed', 'date_created'])
          .default('date_closed')
          .describe('Sobre qué fecha filtrar. date_closed = cuándo se confirmó/pagó la orden.'),
        status: z.enum(ORDER_STATUSES).optional().describe('Filtrar por estado de la orden, ej: "paid".'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(50)
      }
    },
    async ({ date_from, date_to, date_field, status, offset, limit }) => {
      const result = await meli.searchOrders(accessToken, sellerId, {
        dateFrom: date_from,
        dateTo: date_to,
        dateField: date_field,
        status,
        offset,
        limit
      });
      const orders = (result.results || []).map(summarizeOrder);
      const total = result.paging?.total ?? orders.length;
      const returned = offset + orders.length;
      const payload = {
        total_matching: total,
        returned_so_far: returned,
        truncated: returned < total,
        note:
          returned < total
            ? `Hay más resultados (${total} en total). Volvé a llamar con offset=${returned} para seguir paginando.`
            : 'Se devolvieron todos los resultados del filtro.',
        orders
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
  );

  server.registerTool(
    'meli_get_order',
    {
      title: 'Detalle de una orden',
      description: 'Trae el detalle completo de una orden puntual por su ID.',
      inputSchema: { order_id: z.string().describe('ID numérico de la orden') }
    },
    async ({ order_id }) => {
      const order = await meli.getOrder(accessToken, order_id);
      return { content: [{ type: 'text', text: JSON.stringify(order, null, 2) }] };
    }
  );

  server.registerTool(
    'meli_sales_summary',
    {
      title: 'Resumen de ventas de un período',
      description:
        'Suma ventas pagas (status=paid) en un rango de fechas: monto total, cantidad de órdenes y unidades. ' +
        'Pagina automáticamente hasta 500 órdenes; si el período tiene más, avisa que el resumen es parcial.',
      inputSchema: {
        date_from: z.string().describe('Fecha/hora ISO8601 de inicio'),
        date_to: z.string().describe('Fecha/hora ISO8601 de fin')
      }
    },
    async ({ date_from, date_to }) => {
      const MAX_ORDERS = 500;
      let offset = 0;
      let total = Infinity;
      const seenIds = new Set();
      let sumAmount = 0;
      let sumUnits = 0;
      let currency = null;

      while (offset < total && offset < MAX_ORDERS) {
        const result = await meli.searchOrders(accessToken, sellerId, {
          dateFrom: date_from,
          dateTo: date_to,
          dateField: 'date_closed',
          status: 'paid',
          offset,
          limit: 50,
          sort: 'date_desc'
        });
        total = result.paging?.total ?? 0;
        const results = result.results || [];
        for (const o of results) {
          if (seenIds.has(o.id)) continue; // evita duplicar si la paginación se solapa
          seenIds.add(o.id);
          sumAmount += o.total_amount || 0;
          currency = currency || o.currency_id;
          for (const it of o.order_items || []) sumUnits += it.quantity || 0;
        }
        offset += results.length || 50;
        if (results.length === 0) break;
      }

      const truncated = total > seenIds.size && offset >= MAX_ORDERS;
      const payload = {
        date_from,
        date_to,
        status_filter: 'paid',
        orders_counted: seenIds.size,
        orders_total_matching: total,
        units_sold: sumUnits,
        total_amount: Number(sumAmount.toFixed(2)),
        currency_id: currency,
        truncated,
        note: truncated
          ? `El período tiene ${total} órdenes pagas y solo se sumaron las primeras ${seenIds.size}. El resumen es PARCIAL.`
          : 'Resumen completo: se contaron todas las órdenes pagas del período.'
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
  );

  return server;
}

module.exports = { buildMcpServer };
