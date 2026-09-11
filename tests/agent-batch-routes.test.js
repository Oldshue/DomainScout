'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentBatchRouter,
  parseBaseNames,
  parseDomains,
} = require('../server/agent-batch-routes');

// Pull the raw handler function out of an express.Router() instance without
// ever binding a port (this repo's sandbox cannot listen() on sockets).
function getHandler(router, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath);
  assert.ok(layer, `route ${routePath} not found on router`);
  return layer.route.stack[0].handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

const identityNormalize = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);

// ── parseBaseNames ──────────────────────────────────────────────────────────

test('parseBaseNames: empty input errors', () => {
  assert.equal(parseBaseNames('', identityNormalize).error, 'baseNames required');
  assert.equal(parseBaseNames(undefined, identityNormalize).error, 'baseNames required');
});

test('parseBaseNames: over 500 entries errors', () => {
  const raw = Array.from({ length: 501 }, (_, i) => 'n' + i).join(',');
  const result = parseBaseNames(raw, identityNormalize);
  assert.ok(result.error && result.error.includes('500'));
});

test('parseBaseNames: invalid entry (normalizes to empty) errors', () => {
  const result = parseBaseNames('***', identityNormalize);
  assert.ok(result.error);
});

test('parseBaseNames: duplicate entry errors', () => {
  const result = parseBaseNames('alpha,beta,alpha', identityNormalize);
  assert.ok(result.error && result.error.includes('duplicate'));
});

test('parseBaseNames: valid list preserves request order after normalization', () => {
  const result = parseBaseNames(' Alpha , Beta , Gamma ', identityNormalize);
  assert.deepEqual(result.baseNames, ['alpha', 'beta', 'gamma']);
  assert.equal(result.error, undefined);
});

// ── parseDomains ────────────────────────────────────────────────────────────

test('parseDomains: empty input errors', () => {
  assert.equal(parseDomains('').error, 'domains required');
});

test('parseDomains: over 200 entries errors', () => {
  const raw = Array.from({ length: 201 }, (_, i) => `n${i}.io`).join(',');
  const result = parseDomains(raw);
  assert.ok(result.error && result.error.includes('200'));
});

test('parseDomains: invalid shape (no dot) errors', () => {
  const result = parseDomains('notadomain');
  assert.ok(result.error && result.error.includes('invalid domain'));
});

test('parseDomains: valid list lowercased, order preserved', () => {
  const result = parseDomains('Example.IO,Foo.Co');
  assert.deepEqual(result.domains, ['example.io', 'foo.co']);
  assert.equal(result.error, undefined);
});

// ── router: GET /api/zone-tlds-batch ────────────────────────────────────────

test('zone-tlds-batch handler: 400 on invalid baseNames', () => {
  const fakeZoneTruth = { source: 'zone', asOf: '2026-09-11', nameZones: () => ({ exact: true, tlds: [] }) };
  const router = createAgentBatchRouter({
    getZoneTruth: () => fakeZoneTruth,
    normalizeBaseNameInput: identityNormalize,
  });
  const handler = getHandler(router, '/api/zone-tlds-batch');
  const res = makeRes();
  handler({ query: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
});

test('zone-tlds-batch handler: 200 with rows in request order using injected getZoneTruth', () => {
  const perName = { alpha: { exact: true, tlds: ['.com', '.io'] }, beta: { exact: false, tlds: [] } };
  const fakeZoneTruth = {
    source: 'zone-index',
    asOf: '2026-09-10',
    nameZones: baseName => perName[baseName] || { exact: false, tlds: [] },
  };
  const router = createAgentBatchRouter({
    getZoneTruth: () => fakeZoneTruth,
    normalizeBaseNameInput: identityNormalize,
  });
  const handler = getHandler(router, '/api/zone-tlds-batch');
  const res = makeRes();
  handler({ query: { baseNames: 'alpha,beta' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'zone-index');
  assert.equal(res.body.asOf, '2026-09-10');
  assert.deepEqual(res.body.rows, [
    { baseName: 'alpha', exact: true, count: 2, tlds: ['.com', '.io'] },
    { baseName: 'beta', exact: false, count: 0, tlds: [] },
  ]);
});

// ── router: GET /api/dns-taken-batch ────────────────────────────────────────

test('dns-taken-batch handler: 400 on invalid domains', async () => {
  const router = createAgentBatchRouter({
    getZoneTruth: () => ({ source: 's', asOf: 'a', nameZones: () => ({ exact: false, tlds: [] }) }),
    normalizeBaseNameInput: identityNormalize,
    resolveNs: async () => [],
  });
  const handler = getHandler(router, '/api/dns-taken-batch');
  const res = makeRes();
  await handler({ query: { domains: 'nope' } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
});

test('dns-taken-batch handler: taken/not-taken/unknown via injected resolveNs, no network', async () => {
  const fakeResolveNs = async domain => {
    if (domain === 'taken.io') return ['ns1.example.com', 'ns2.example.com'];
    if (domain === 'free.co') { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; }
    const e = new Error('server failure'); e.code = 'SERVFAIL'; throw e;
  };
  const router = createAgentBatchRouter({
    getZoneTruth: () => ({ source: 's', asOf: 'a', nameZones: () => ({ exact: false, tlds: [] }) }),
    normalizeBaseNameInput: identityNormalize,
    resolveNs: fakeResolveNs,
  });
  const handler = getHandler(router, '/api/dns-taken-batch');
  const res = makeRes();
  await handler({ query: { domains: 'taken.io,free.co,broken.net' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.body.checkedAt === 'string');
  assert.deepEqual(res.body.rows, [
    { domain: 'taken.io', taken: true, ns: 'ns1.example.com', error: null },
    { domain: 'free.co', taken: false, ns: null, error: null },
    { domain: 'broken.net', taken: null, ns: null, error: 'SERVFAIL' },
  ]);
});

test('createAgentBatchRouter throws without required deps', () => {
  assert.throws(() => createAgentBatchRouter({}));
  assert.throws(() => createAgentBatchRouter({ getZoneTruth: () => ({}) }));
});
