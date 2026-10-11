'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentBatchRouter,
  parseBaseNames,
  parseDomains,
  parseGroupedBaseNames,
  parseGroupedTlds,
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

// ── router: GET /api/dns-taken-batch (grouped compact mode) ────────────────

function makeGroupedRouter(fakeResolveNs) {
  return createAgentBatchRouter({
    getZoneTruth: () => ({ source: 's', asOf: 'a', nameZones: () => ({ exact: false, tlds: [] }) }),
    normalizeBaseNameInput: identityNormalize,
    resolveNs: fakeResolveNs,
  });
}

test('dns-taken-batch grouped mode: compact rows in input order, empty arrays omitted, counts over whole request', async () => {
  const fakeResolveNs = async domain => {
    if (domain === 'zeta.ai') return ['ns1.example.com'];
    if (domain === 'zeta.io') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    if (domain === 'alpha.ai' || domain === 'alpha.io') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    return ['ns1.example.com']; // beta.ai, beta.io
  };
  const handler = getHandler(makeGroupedRouter(fakeResolveNs), '/api/dns-taken-batch');
  const res = makeRes();
  await handler({ query: { baseNames: 'zeta,alpha,beta', tlds: 'ai,io' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.body.checkedAt === 'string');
  assert.deepEqual(res.body.tlds, ['ai', 'io']);
  assert.deepEqual(res.body.counts, { baseNames: 3, lookups: 6, delegated: 3, undelegated: 3, errors: 0 });
  assert.deepEqual(res.body.rows, [
    { base: 'zeta', delegated: ['ai'], undelegated: ['io'] },
    { base: 'alpha', undelegated: ['ai', 'io'] },
    { base: 'beta', delegated: ['ai', 'io'] },
  ]);
});

test('dns-taken-batch grouped mode: errored lookups listed per tld and counted separately', async () => {
  const fakeResolveNs = async domain => {
    if (domain === 'a.ai') return ['ns1.example.com'];
    if (domain === 'a.io') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    if (domain === 'a.dev') { const e = new Error('fail'); e.code = 'SERVFAIL'; throw e; }
    const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; // b.*
  };
  const handler = getHandler(makeGroupedRouter(fakeResolveNs), '/api/dns-taken-batch');
  const res = makeRes();
  await handler({ query: { baseNames: 'a,b', tlds: 'ai,io,dev' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.counts, { baseNames: 2, lookups: 6, delegated: 1, undelegated: 4, errors: 1 });
  assert.deepEqual(res.body.rows, [
    { base: 'a', delegated: ['ai'], undelegated: ['io'], errors: ['dev'] },
    { base: 'b', undelegated: ['ai', 'io', 'dev'] },
  ]);
});

test('dns-taken-batch grouped mode: only= filters rows while counts stay whole-request', async () => {
  const fakeResolveNs = async domain => {
    if (domain.startsWith('alldelegated.')) return ['ns1.example.com'];
    if (domain === 'hasundelegated.ai') return ['ns1.example.com'];
    if (domain === 'hasundelegated.io') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    if (domain === 'haserror.ai') { const e = new Error('fail'); e.code = 'SERVFAIL'; throw e; }
    if (domain === 'haserror.io') return ['ns1.example.com'];
    if (domain === 'mixed.ai') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    if (domain === 'mixed.io') { const e = new Error('fail'); e.code = 'SERVFAIL'; throw e; }
    throw new Error('unexpected domain ' + domain);
  };
  const router = makeGroupedRouter(fakeResolveNs);
  const handler = getHandler(router, '/api/dns-taken-batch');
  const query = { baseNames: 'alldelegated,hasundelegated,haserror,mixed', tlds: 'ai,io' };

  const whole = makeRes();
  await handler({ query }, whole);
  assert.equal(whole.statusCode, 200);
  assert.deepEqual(whole.body.counts, { baseNames: 4, lookups: 8, delegated: 4, undelegated: 2, errors: 2 });
  assert.deepEqual(whole.body.rows.map(r => r.base), ['alldelegated', 'hasundelegated', 'haserror', 'mixed']);

  const undelegated = makeRes();
  await handler({ query: { ...query, only: 'undelegated' } }, undelegated);
  assert.deepEqual(undelegated.body.rows.map(r => r.base), ['hasundelegated', 'mixed']);
  assert.deepEqual(undelegated.body.counts, whole.body.counts);

  const delegated = makeRes();
  await handler({ query: { ...query, only: 'delegated' } }, delegated);
  assert.deepEqual(delegated.body.rows.map(r => r.base), ['alldelegated']);
  assert.deepEqual(delegated.body.counts, whole.body.counts);

  const errors = makeRes();
  await handler({ query: { ...query, only: 'errors' } }, errors);
  assert.deepEqual(errors.body.rows.map(r => r.base), ['haserror', 'mixed']);
  assert.deepEqual(errors.body.counts, whole.body.counts);
});

test('dns-taken-batch grouped mode: validation and limit 400s name the offending entry or limit', async () => {
  const router = makeGroupedRouter(async () => { throw new Error('should not resolve'); });
  const handler = getHandler(router, '/api/dns-taken-batch');
  const badCases = [
    [{}, 'domains required'],
    [{ baseNames: 'a' }, 'tlds required'],
    [{ tlds: 'ai' }, 'baseNames required'],
    [{ baseNames: 'a,,b', tlds: 'ai' }, 'baseNames contains an empty entry'],
    [{ baseNames: 'a', tlds: 'ai,,dev' }, 'tlds contains an empty entry'],
    [{ baseNames: 'UPPER', tlds: 'ai' }, 'invalid baseName: UPPER'],
    [{ baseNames: '-lead', tlds: 'ai' }, 'invalid baseName: -lead'],
    [{ baseNames: 'trail-', tlds: 'ai' }, 'invalid baseName: trail-'],
    [{ baseNames: 'x'.repeat(64), tlds: 'ai' }, 'invalid baseName:'],
    [{ baseNames: 'a.b', tlds: 'ai' }, 'invalid baseName: a.b'],
    [{ baseNames: 'dup,dup', tlds: 'ai' }, 'duplicate baseName: dup'],
    [{ baseNames: 'a', tlds: '-lead' }, 'invalid tld: -lead'],
    [{ baseNames: 'a', tlds: 'co..uk' }, 'invalid tld: co..uk'],
    [{ baseNames: 'a', tlds: 'ai,ai' }, 'duplicate tld: ai'],
    [{ baseNames: Array.from({ length: 1001 }, (_, i) => 'n' + i).join(','), tlds: 'ai' }, 'baseNames must be 1..1000 entries'],
    [{ baseNames: 'a', tlds: Array.from({ length: 13 }, (_, i) => 't' + i).join(',') }, 'tlds must be 1..12 entries'],
    [{ baseNames: Array.from({ length: 1000 }, (_, i) => 'n' + i).join(','), tlds: 'ai,io,dev,co' }, 'at most 3000'],
    [{ baseNames: 'a', tlds: 'ai', only: 'bogus' }, 'invalid only: bogus'],
  ];
  for (const [query, expected] of badCases) {
    const res = makeRes();
    await handler({ query }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.ok(res.body && typeof res.body.error === 'string' && res.body.error.includes(expected),
      `${JSON.stringify(res.body)} should include "${expected}"`);
  }
});

test('dns-taken-batch grouped mode: retries a timed-out lookup once, never retries other failures', async () => {
  const calls = new Map();
  const fakeResolveNs = async domain => {
    calls.set(domain, (calls.get(domain) || 0) + 1);
    const n = calls.get(domain);
    if (domain === 'slow.ai') {
      if (n === 1) { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; }
      return ['ns1.example.com'];
    }
    if (domain === 'slow.io') return ['ns1.example.com'];
    if (domain === 'stillslow.ai') { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; }
    if (domain === 'stillslow.io') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    if (domain === 'noretry.ai') { const e = new Error('fail'); e.code = 'SERVFAIL'; throw e; }
    if (domain === 'noretry.io') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
    throw new Error('unexpected domain ' + domain);
  };
  const handler = getHandler(makeGroupedRouter(fakeResolveNs), '/api/dns-taken-batch');
  const res = makeRes();
  await handler({ query: { baseNames: 'slow,stillslow,noretry', tlds: 'ai,io' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.get('slow.ai'), 2);
  assert.equal(calls.get('slow.io'), 1);
  assert.equal(calls.get('stillslow.ai'), 2);
  assert.equal(calls.get('stillslow.io'), 1);
  assert.equal(calls.get('noretry.ai'), 1);
  assert.equal(calls.get('noretry.io'), 1);
  assert.deepEqual(res.body.counts, { baseNames: 3, lookups: 6, delegated: 2, undelegated: 2, errors: 2 });
  assert.deepEqual(res.body.rows, [
    { base: 'slow', delegated: ['ai', 'io'] },
    { base: 'stillslow', undelegated: ['io'], errors: ['ai'] },
    { base: 'noretry', undelegated: ['io'], errors: ['ai'] },
  ]);
});

test('dns-taken-batch grouped mode: dotted-suffix tlds are supported', async () => {
  const fakeResolveNs = async domain => {
    if (domain === 'alpha.co.uk') return ['ns1.example.com'];
    const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e;
  };
  const handler = getHandler(makeGroupedRouter(fakeResolveNs), '/api/dns-taken-batch');
  const res = makeRes();
  await handler({ query: { baseNames: 'alpha,beta', tlds: 'co.uk,ai' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.tlds, ['co.uk', 'ai']);
  assert.deepEqual(res.body.counts, { baseNames: 2, lookups: 4, delegated: 1, undelegated: 3, errors: 0 });
  assert.deepEqual(res.body.rows, [
    { base: 'alpha', delegated: ['co.uk'], undelegated: ['ai'] },
    { base: 'beta', undelegated: ['co.uk', 'ai'] },
  ]);
});
