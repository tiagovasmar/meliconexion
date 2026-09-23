const express = require('express');
const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { ProxyOAuthServerProvider } = require('@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const meli = require('./meliClient.js');
const tokenCache = require('./tokenCache.js');
const { buildMcpServer } = require('./mcpTools.js');
const { createCodexBridge, CODEX_CALLBACK_PATH } = require('./codexAuth.js');

const {
  MELI_APP_ID,
  MELI_APP_SECRET,
  MELI_AUTH_DOMAIN = 'https://auth.mercadolibre.com.ar',
  PUBLIC_URL,
  CODEX_CALLBACK_URL,
  ALLOWED_SELLER_ID,
  PORT = 3000
} = process.env;

for (const [name, val] of Object.entries({ MELI_APP_ID, MELI_APP_SECRET, PUBLIC_URL })) {
  if (!val) {
    console.error(`Falta la variable de entorno ${name}. Revisá .env / las env vars del hosting.`);
    process.exit(1);
  }
}

const issuerUrl = new URL(PUBLIC_URL);
const mcpUrl = new URL('/mcp', PUBLIC_URL);
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

// --- Cliente OAuth único: es literalmente la app de Mercado Libre.
// Claude va a usar el mismo App ID / Secret Key como sus credenciales de conector.
const meliClientInfo = {
  client_id: MELI_APP_ID,
  client_secret: MELI_APP_SECRET,
  redirect_uris: [CLAUDE_CALLBACK],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code']
};

async function verifyAccessToken(token) {
  const cached = tokenCache.get(token);
  if (cached) return cached;

  const me = await meli.getMe(token); // si el token es inválido, esto tira y cae en el catch del middleware
  if (ALLOWED_SELLER_ID && String(me.id) !== String(ALLOWED_SELLER_ID)) {
    throw new Error(`Token válido pero pertenece a otra cuenta de Mercado Libre (id ${me.id}), no a la autorizada.`);
  }
  const authInfo = {
    token,
    clientId: MELI_APP_ID,
    scopes: ['read', 'offline_access'],
    // requireBearerAuth exige que el token tenga fecha de expiración numérica.
    // No conocemos la expiración real del token de Mercado Libre acá (solo tenemos el string),
    // así que usamos una ventana conservadora; si el token real ya expiró, meli.getMe()
    // de todos modos va a fallar en la próxima verificación (cuando venza el cache de 2 min).
    expiresAt: Math.floor(Date.now() / 1000) + 3000,
    extra: { sellerId: me.id, nickname: me.nickname }
  };
  tokenCache.set(token, authInfo);
  if (!ALLOWED_SELLER_ID) {
    console.log(
      `[meli-mcp] Primer login detectado: seller_id=${me.id} (${me.nickname}). ` +
        `Te recomiendo setear ALLOWED_SELLER_ID=${me.id} en las env vars del hosting y redeployar.`
    );
  }
  return authInfo;
}

const provider = new ProxyOAuthServerProvider({
  endpoints: {
    authorizationUrl: `${MELI_AUTH_DOMAIN}/authorization`,
    tokenUrl: 'https://api.mercadolibre.com/oauth/token'
  },
  verifyAccessToken,
  getClient: async (clientId) => {
    if (clientId === MELI_APP_ID) return meliClientInfo;
    if (codexBridge && clientId === codexBridge.codexClientId) return codexBridge.codexClient;
    return undefined;
  }
});
provider.skipLocalPkceValidation = true; // Mercado Libre valida PKCE (si está habilitado) del lado suyo

// Codex usa un cliente público con PKCE. El secret de Mercado Libre permanece
// solamente en este servidor; Mercado Libre recibe un callback HTTPS fijo.
const codexBridge = CODEX_CALLBACK_URL
  ? createCodexBridge({
      appId: MELI_APP_ID,
      appSecret: MELI_APP_SECRET,
      authDomain: MELI_AUTH_DOMAIN,
      publicUrl: PUBLIC_URL,
      callbackUrl: CODEX_CALLBACK_URL,
      upstreamClient: meliClientInfo,
      provider
    })
  : null;

const app = express();
// '1' = confiar solo en el primer proxy (el balanceador del hosting). Necesario para que
// el rate limiting interno del router de auth identifique IPs reales correctamente.
app.set('trust proxy', 1);
app.use(express.json());
if (codexBridge) app.get(CODEX_CALLBACK_PATH, codexBridge.handleCallback);

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: mcpUrl,
    resourceName: 'Ventas de Mercado Libre',
    scopesSupported: ['read', 'offline_access']
  })
);

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
const bearerAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

app.all('/mcp', bearerAuth, async (req, res) => {
  try {
    const { token, extra } = req.auth;
    const server = buildMcpServer({ accessToken: token, sellerId: extra.sellerId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error('[meli-mcp] Error manejando request MCP:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, allowed_seller_id_configured: Boolean(ALLOWED_SELLER_ID) });
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('meli-mcp-connector activo. Endpoint MCP: /mcp');
});

app.listen(PORT, () => {
  console.log(`meli-mcp-connector escuchando en :${PORT}`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`MCP endpoint: ${mcpUrl.href}`);
  console.log(`Callback que debe estar registrado en la app de Mercado Libre: ${CLAUDE_CALLBACK}`);
  if (codexBridge) {
    console.log(`Callback adicional que debe estar registrado en Mercado Libre: ${codexBridge.upstreamCallback}`);
  }
});
