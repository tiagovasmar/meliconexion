const crypto = require('node:crypto');

const CODEX_CALLBACK_PATH = '/codex/callback';
const MAX_STATE_AGE_MS = 10 * 60 * 1000;

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function readState(value, secret) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(payload.issuedAt) ||
        payload.issuedAt > Date.now() ||
        Date.now() - payload.issuedAt > MAX_STATE_AGE_MS) return null;
    if (typeof payload.redirectUri !== 'string' || typeof payload.state !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

function createCodexBridge({ appId, appSecret, authDomain, publicUrl, callbackUrl, upstreamClient, provider }) {
  const codexClientId = `${appId}-codex`;
  const upstreamCallback = new URL(CODEX_CALLBACK_PATH, publicUrl).href;
  const codexClient = {
    client_id: codexClientId,
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  };

  const authorizeUpstream = provider.authorize.bind(provider);
  const exchangeCodeUpstream = provider.exchangeAuthorizationCode.bind(provider);
  const exchangeRefreshUpstream = provider.exchangeRefreshToken.bind(provider);

  provider.authorize = async (client, params, res) => {
    if (client.client_id !== codexClientId) return authorizeUpstream(client, params, res);
    const state = signState({
      issuedAt: Date.now(),
      redirectUri: params.redirectUri,
      state: params.state || ''
    }, appSecret);
    const url = new URL('/authorization', authDomain);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: appId,
      redirect_uri: upstreamCallback,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state
    }).toString();
    if (params.scopes?.length) url.searchParams.set('scope', params.scopes.join(' '));
    res.redirect(url.href);
  };

  provider.exchangeAuthorizationCode = (client, code, verifier, redirectUri, resource) =>
    exchangeCodeUpstream(
      client.client_id === codexClientId ? upstreamClient : client,
      code,
      verifier,
      client.client_id === codexClientId ? upstreamCallback : redirectUri,
      resource
    );

  provider.exchangeRefreshToken = (client, refreshToken, scopes, resource) =>
    exchangeRefreshUpstream(
      client.client_id === codexClientId ? upstreamClient : client,
      refreshToken,
      scopes,
      resource
    );

  function handleCallback(req, res) {
    const payload = readState(req.query.state, appSecret);
    if (!payload) return res.status(400).send('Estado de autorización inválido o vencido.');
    const redirect = new URL(payload.redirectUri);
    for (const name of ['code', 'error', 'error_description']) {
      if (typeof req.query[name] === 'string') redirect.searchParams.set(name, req.query[name]);
    }
    if (!redirect.searchParams.has('code') && !redirect.searchParams.has('error')) {
      return res.status(400).send('Mercado Libre no devolvió un resultado de autorización.');
    }
    if (payload.state) redirect.searchParams.set('state', payload.state);
    res.set('Cache-Control', 'no-store');
    return res.redirect(redirect.href);
  }

  return { codexClient, codexClientId, upstreamCallback, handleCallback };
}

module.exports = { createCodexBridge, CODEX_CALLBACK_PATH };
