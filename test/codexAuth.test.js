const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexBridge } = require('../src/codexAuth.js');

function setup() {
  const calls = [];
  const provider = {
    authorize: async (...args) => calls.push(['authorize', ...args]),
    exchangeAuthorizationCode: async (...args) => {
      calls.push(['code', ...args]);
      return { access_token: 'upstream-token' };
    },
    exchangeRefreshToken: async (...args) => {
      calls.push(['refresh', ...args]);
      return { access_token: 'refreshed-token' };
    }
  };
  const upstreamClient = { client_id: '123', client_secret: 'server-secret' };
  const bridge = createCodexBridge({
    appId: '123',
    appSecret: 'server-secret',
    authDomain: 'https://auth.mercadolibre.com.ar',
    publicUrl: 'https://meliconexion.onrender.com',
    callbackUrl: 'http://127.0.0.1/callback/example',
    upstreamClient,
    provider
  });
  return { calls, provider, bridge, upstreamClient };
}

test('Codex authorization uses the registered HTTPS callback and returns to its loopback client', async () => {
  const { provider, bridge } = setup();
  let upstreamUrl;
  await provider.authorize(bridge.codexClient, {
    redirectUri: 'http://127.0.0.1:4321/callback/example',
    codeChallenge: 'challenge',
    state: 'original-state',
    scopes: ['read', 'offline_access']
  }, { redirect: (url) => { upstreamUrl = new URL(url); } });
  assert.equal(upstreamUrl.searchParams.get('client_id'), '123');
  assert.equal(upstreamUrl.searchParams.get('redirect_uri'), bridge.upstreamCallback);
  assert.equal(upstreamUrl.searchParams.get('code_challenge'), 'challenge');

  let returnedUrl;
  bridge.handleCallback({
    query: { state: upstreamUrl.searchParams.get('state'), code: 'meli-code' }
  }, {
    set: () => {},
    redirect: (url) => { returnedUrl = new URL(url); }
  });
  assert.equal(returnedUrl.origin, 'http://127.0.0.1:4321');
  assert.equal(returnedUrl.searchParams.get('code'), 'meli-code');
  assert.equal(returnedUrl.searchParams.get('state'), 'original-state');
});

test('Invalid state is rejected before redirecting', () => {
  const { bridge } = setup();
  let status;
  let redirected = false;
  bridge.handleCallback({ query: { state: 'invalid', code: 'meli-code' } }, {
    status: (code) => { status = code; return { send: () => {} }; },
    redirect: () => { redirected = true; }
  });
  assert.equal(status, 400);
  assert.equal(redirected, false);
});

test('Codex token requests use the upstream app credentials and HTTPS callback', async () => {
  const { calls, provider, bridge, upstreamClient } = setup();
  await provider.exchangeAuthorizationCode(
    bridge.codexClient, 'meli-code', 'verifier',
    'http://127.0.0.1:4321/callback/example'
  );
  assert.equal(calls[0][1], upstreamClient);
  assert.equal(calls[0][4], bridge.upstreamCallback);
  await provider.exchangeRefreshToken(bridge.codexClient, 'refresh-token');
  assert.equal(calls[1][1], upstreamClient);
});
