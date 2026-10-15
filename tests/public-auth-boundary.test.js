'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// The extracted server/index.js functions use server-relative requires.
const serverRequire = createRequire(path.join(__dirname, '..', 'server', 'index.js'));

function loadAgentTokenAllowed(env) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = source.indexOf('function agentTokenAllowed');
  const end = source.indexOf('\n}\n\nfunction requireAuth', start) + 2;
  const body = source.slice(start, end);
  return Function('require', 'process', `${body}; return agentTokenAllowed;`)(serverRequire, { env });
}

function loadRequireAuth(env) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

  const normalizeStart = source.indexOf('function normalizeRemoteIp');
  const isLocalEnd = source.indexOf('\n}\n\n// Read-only agent access', normalizeStart) + 2;
  const isLocalBody = source.slice(normalizeStart, isLocalEnd);

  const agentStart = source.indexOf('function agentTokenAllowed');
  const agentEnd = source.indexOf('\n}\n\nfunction requireAuth', agentStart) + 2;
  const agentBody = source.slice(agentStart, agentEnd);

  const requireAuthStart = source.indexOf('function requireAuth');
  const requireAuthEnd = source.indexOf('\n}\n\n// ── Login page', requireAuthStart) + 2;
  const requireAuthBody = source.slice(requireAuthStart, requireAuthEnd);

  const body = `${isLocalBody}\n${agentBody}\n${requireAuthBody}\nreturn requireAuth;`;
  return Function('require', 'process', body)(serverRequire, { env });
}

test('universe import POST admits the dedicated import token', () => {
  const importToken = 'universe-import-token-0001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: importToken,
    DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/universe/import',
    headers: { 'x-domainscout-token': importToken },
    query: {},
  }), true);
});

test('universe summary import POST admits the dedicated import token', () => {
  const importToken = 'universe-import-token-0001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: importToken,
    DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/universe/summary/import',
    headers: { 'x-domainscout-token': importToken },
    query: {},
  }), true);
});

test('universe pull POST admits the dedicated import token', () => {
  const importToken = 'universe-import-token-0001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: importToken,
    DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/universe/pull',
    headers: { 'x-domainscout-token': importToken },
    query: {},
  }), true);
});

test('agent tokens do not admit other POST routes', () => {
  const agentToken = 'agent-read-token-0000001';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: 'universe-import-token-0001',
    DOMAINSCOUT_AGENT_TOKEN: agentToken,
  });
  assert.equal(agentTokenAllowed({
    method: 'POST',
    path: '/api/czds-sync',
    headers: { 'x-domainscout-token': agentToken },
    query: {},
  }), false);
});

test('hosted private proxy addresses never bypass the public login boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = source.indexOf('function isLocalRequest');
  const end = source.indexOf('\n}\n\n// Read-only agent access', start) + 2;
  const body = source.slice(start, end);
  assert.match(body, /socket\?\.remoteAddress/);
  assert.match(body, /includes\(host\) && socketIp === '127\.0\.0\.1'/);
  assert.doesNotMatch(body, /req\.ip/);
  assert.doesNotMatch(source, /function isTrustedPrivateIp/);
});

test('GET /api/nope with a wrong token is not admitted by agentTokenAllowed', () => {
  const agentToken = 'agent-token-abcdefghijklmnop';
  const agentTokenAllowed = loadAgentTokenAllowed({
    DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: 'import-token-0123456789abcdef',
    DOMAINSCOUT_AGENT_TOKEN: agentToken,
  });
  assert.equal(agentTokenAllowed({
    method: 'GET',
    path: '/api/nope',
    headers: { 'x-domainscout-token': 'wrong-token-0123456789abcdef' },
    query: {},
  }), false);
});

test('GET /api/health is admitted by requireAuth without a session or token', () => {
  const requireAuth = loadRequireAuth({
    DOMAINSCOUT_AGENT_TOKEN: 'agent-token-abcdefghijklmnop',
  });
  let nextCalled = false;
  let statusCalled = null;
  let redirected = null;
  const req = {
    path: '/api/health',
    originalUrl: '/api/health',
    headers: {},
    query: {},
    session: null,
    socket: {},
  };
  const res = {
    status(code) { statusCalled = code; return this; },
    json() { return this; },
    redirect(url) { redirected = url; return this; },
  };
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(statusCalled, null);
  assert.equal(redirected, null);
});

for (const publicPath of ['/openapi.json', '/api/openapi.json', '/llms.txt']) {
  test(`GET ${publicPath} is admitted by requireAuth without a session or token`, () => {
    const requireAuth = loadRequireAuth({
      DOMAINSCOUT_AGENT_TOKEN: 'agent-token-abcdefghijklmnop',
    });
    let nextCalled = false;
    let statusCalled = null;
    let redirected = null;
    const req = {
      path: publicPath,
      originalUrl: publicPath,
      headers: {},
      query: {},
      session: null,
      socket: {},
    };
    const res = {
      status(code) { statusCalled = code; return this; },
      json() { return this; },
      redirect(url) { redirected = url; return this; },
    };
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(statusCalled, null);
    assert.equal(redirected, null);
  });
}

// Real requireAuth -> agentTokenAllowed chain for token-admitted universe POSTs.
function runRequireAuth(env, { method = 'POST', path: reqPath, token, query = {} }) {
  const requireAuth = loadRequireAuth(env);
  const out = { next: false, status: null, body: null, redirected: null };
  const headers = token === undefined ? {} : { 'x-domainscout-token': token };
  const req = { method, path: reqPath, originalUrl: reqPath, headers, query, session: null, socket: {} };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
    redirect(url) { out.redirected = url; return this; },
  };
  requireAuth(req, res, () => { out.next = true; });
  return out;
}

const AUTH_ENV = {
  DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN: 'universe-import-token-0001',
  DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
};

test('shared token path list contains every token-admitted universe POST', () => {
  const { UNIVERSE_TOKEN_POST_PATHS } = require('../server/universe-token-paths');
  assert.deepEqual([...UNIVERSE_TOKEN_POST_PATHS].sort(), [
    '/api/universe/import',
    '/api/universe/observed/run',
    '/api/universe/ns-movement/import',
    '/api/universe/pull',
    '/api/universe/summary/import',
  ].sort());
});

for (const [label, token] of [['import token', AUTH_ENV.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN], ['agent token', AUTH_ENV.DOMAINSCOUT_AGENT_TOKEN]]) {
  test(`POST /api/universe/observed/run?tld=si is admitted by requireAuth with the ${label}`, () => {
    const out = runRequireAuth(AUTH_ENV, { path: '/api/universe/observed/run', query: { tld: 'si' }, token });
    assert.equal(out.next, true);
    assert.equal(out.status, null);
  });
}

test('POST /api/universe/observed/run is 401 with a wrong or missing token', () => {
  for (const token of ['wrong-token-0000000000000000', undefined]) {
    const out = runRequireAuth(AUTH_ENV, { path: '/api/universe/observed/run', query: { tld: 'si' }, token });
    assert.equal(out.next, false);
    assert.equal(out.status, 401);
    assert.deepEqual(out.body, { error: 'Unauthorized' });
  }
});

test('an unrelated POST with a valid token is still rejected by requireAuth', () => {
  for (const token of Object.values(AUTH_ENV)) {
    for (const p of ['/api/czds-sync', '/api/universe/observed/other', '/api/universe/observed/run/extra']) {
      const out = runRequireAuth(AUTH_ENV, { path: p, token });
      assert.equal(out.next, false, p);
      assert.equal(out.status, 401, p);
    }
  }
});
