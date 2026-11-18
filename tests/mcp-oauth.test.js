'use strict';

// The sign-in tool server: an app registers, the owner approves behind the
// login, the app gets a token it can renew, and the tools read data routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { installMcp, validRedirect } = require('../server/mcp-oauth');

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mcp-'));
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const state = { authed: false, session: {} };
  app.use((req, _res, next) => { req.session = state.session; next(); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  installMcp(app, {
    dataDir,
    port,
    safeReturnPath: value => value,
    sessionAuthed: () => state.authed,
    agentTokenOk: req => req.headers['x-domainscout-token'] === 'agent-token-agent-token',
  });
  app.get('/api/domains', (req, res) => res.json({
    total: 1,
    saved: req.query.saved,
    domains: [{ domain: 'example.ai', source: 'Namecheap', stream: 'namecheap-auction', auction_end: '2099-01-01T00:00:00Z', auction_price: 25, bid_count: 2, auction_url: 'https://x/example.ai' }],
  }));
  return { base: 'http://127.0.0.1:' + port, state, close: () => server.close() };
}
const post = (url, body, headers = {}, form = false) => fetch(url, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
  body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
});

test('redirect addresses must be https, or http on the machine itself', () => {
  assert.equal(validRedirect('https://app.example/callback'), true);
  assert.equal(validRedirect('http://127.0.0.1:9000/cb'), true);
  assert.equal(validRedirect('http://app.example/cb'), false);
  assert.equal(validRedirect('javascript:alert(1)'), false);
  assert.equal(validRedirect('https://app.example/cb#x'), false);
});

test('an app connects by sign-in, reads through tools, and renews its token', async () => {
  const { base, state, close } = await start();
  try {
    // With no token the server says where sign-in lives.
    const refused = await post(base + '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(refused.status, 401);
    const where = refused.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)[1];
    const resource = await (await fetch(where)).json();
    assert.equal(resource.resource, base + '/mcp');
    const meta = await (await fetch(resource.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);

    assert.equal((await post(meta.registration_endpoint, { redirect_uris: ['http://evil.example/cb'] })).status, 400);
    const redirect = 'https://agents.example/api/tools/callback';
    const client = await (await post(meta.registration_endpoint, { client_name: 'Agent <b>Host</b>', redirect_uris: [redirect] })).json();
    assert.match(client.client_id, /^ds_/);

    const verifier = crypto.randomBytes(32).toString('base64url');
    const ask = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      state: 'st4te',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    };
    const authorize = meta.authorization_endpoint + '?' + new URLSearchParams(ask);
    // Not logged in: sent to the login page, and back here afterwards.
    const wall = await fetch(authorize, { redirect: 'manual' });
    assert.equal(wall.status, 302);
    assert.match(wall.headers.get('location'), /^\/login\?next=%2Foauth%2Fauthorize/);
    assert.equal((await post(meta.authorization_endpoint, { ...ask, decision: 'allow' }, {}, true)).headers.get('location'), '/login');

    state.authed = true;
    state.session.authed = true;
    // A redirect address the app did not register is never followed.
    const forged = await fetch(meta.authorization_endpoint + '?' + new URLSearchParams({ ...ask, redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' });
    assert.equal(forged.status, 400);
    const consent = await (await fetch(authorize)).text();
    assert.match(consent, /Let Agent &lt;b&gt;Host&lt;\/b&gt; read your DomainScout\?/);
    assert.match(consent, /agents\.example/);
    const nonce = consent.match(/name="nonce" value="([^"]+)"/)[1];
    // The approval only counts from the page that was shown.
    assert.equal((await post(meta.authorization_endpoint, { ...ask, decision: 'allow', nonce: 'guess' }, {}, true)).status, 400);
    const again = await (await fetch(authorize)).text();
    const approved = await post(meta.authorization_endpoint, { ...ask, decision: 'allow', nonce: again.match(/name="nonce" value="([^"]+)"/)[1] }, {}, true);
    assert.notEqual(nonce, undefined);
    const back = new URL(approved.headers.get('location'));
    assert.equal(back.origin + back.pathname, redirect);
    assert.equal(back.searchParams.get('state'), 'st4te');
    const code = back.searchParams.get('code');

    const exchange = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id };
    assert.equal((await post(meta.token_endpoint, { ...exchange, code_verifier: 'wrong' }, {}, true)).status, 400);
    // The failed attempt used the code up.
    assert.equal((await post(meta.token_endpoint, { ...exchange, code_verifier: verifier }, {}, true)).status, 400);

    const second = await fetch(authorize).then(r => r.text());
    const approvedAgain = await post(meta.authorization_endpoint, { ...ask, decision: 'allow', nonce: second.match(/name="nonce" value="([^"]+)"/)[1] }, {}, true);
    const code2 = new URL(approvedAgain.headers.get('location')).searchParams.get('code');
    const tokens = await (await post(meta.token_endpoint, { ...exchange, code: code2, code_verifier: verifier }, {}, true)).json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.expires_in > 0 && tokens.refresh_token);

    const rpc = async (token, body, extra = {}) => (await post(base + '/mcp', { jsonrpc: '2.0', ...body }, { authorization: 'Bearer ' + token, ...extra })).json();
    assert.equal((await rpc(tokens.access_token, { id: 1, method: 'initialize', params: {} })).result.serverInfo.name, 'DomainScout');
    assert.equal((await post(base + '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: 'Bearer ' + tokens.access_token })).status, 202);
    const listed = (await rpc(tokens.access_token, { id: 2, method: 'tools/list' })).result.tools.map(t => t.name);
    assert.deepEqual(listed, ['flagged_names', 'describe_api', 'api_get']);
    const flagged = JSON.parse((await rpc(tokens.access_token, { id: 3, method: 'tools/call', params: { name: 'flagged_names', arguments: {} } })).result.content[0].text);
    assert.deepEqual(flagged.names[0], { domain: 'example.ai', venue: 'Namecheap', listing: 'namecheap-auction', endsAt: '2099-01-01T00:00:00Z', endsInFuture: true, price: 25, bids: 2, url: 'https://x/example.ai' });
    const read = await rpc(tokens.access_token, { id: 4, method: 'tools/call', params: { name: 'api_get', arguments: { path: '/api/domains', query: { saved: 1, token: 'x' } } } });
    assert.equal(JSON.parse(read.result.content[0].text).saved, '1');
    // Only data routes can be read.
    for (const bad of ['/oauth/token', '/api/../oauth/token', 'http://evil.example/api/x', '/api/login']) {
      const out = await rpc(tokens.access_token, { id: 5, method: 'tools/call', params: { name: 'api_get', arguments: { path: bad } } });
      assert.equal(out.result.isError, true, bad);
    }
    assert.match(JSON.stringify(await rpc(tokens.access_token, { id: 6, method: 'tools/call', params: { name: 'describe_api', arguments: {} } })), /\/api\/domains/);
    assert.equal((await rpc(tokens.access_token, { id: 7, method: 'nope' })).error.code, -32601);

    // Renewal replaces the token it was made with.
    const renewed = await (await post(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }, {}, true)).json();
    assert.ok(renewed.access_token && renewed.access_token !== tokens.access_token);
    assert.equal((await post(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }, {}, true)).status, 400);
    assert.equal((await rpc(renewed.access_token, { id: 8, method: 'ping' })).id, 8);

    // A made-up token is refused; the existing agent token still works.
    assert.equal((await post(base + '/mcp', { jsonrpc: '2.0', id: 9, method: 'ping' }, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post(base + '/mcp', { jsonrpc: '2.0', id: 9, method: 'ping' }, { 'x-domainscout-token': 'agent-token-agent-token' })).status, 200);
  } finally {
    close();
  }
});
