'use strict';

// Cold-boot contract: when the off-main sale-watch read lane is slow (boot catch-up) or
// a lane read fails transiently (db-read-worker-timeout / -retired), the candidates
// themes route and the Sale Watch reconstruction page answer 202 while the read
// completes -- never a 500. These tests need no python3: they never reach the engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createUniverseThemeEngine, registerUniverseThemeRoutes } = require('../server/universe-themes');
const { registerSaleWatchRoutes } = require('../server/sale-watch');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

async function themesHandler(t, loader) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'domainscout-cold-themes-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const engine = createUniverseThemeEngine({
    lane: { directory, listDays: async () => [{ day: '2026-10-21', zones: ['com'] }] },
    log: { warn() {}, log() {}, error() {} },
    candidateTapeLoader: loader,
    candidatesContextWaitMs: 20,
  });
  let handler = null;
  registerUniverseThemeRoutes({ get(p, h) { if (p === '/api/universe/themes') handler = h; } }, engine);
  return { handler, engine };
}

const QUERY = { source: 'candidates', builtOnly: 'true', from: '2026-10-08', to: '2026-10-21' };

test('candidates themes answer 202 while a slow cold-lane input probe runs, sharing one probe', async t => {
  const gate = deferred();
  let calls = 0;
  const { handler } = await themesHandler(t, () => { calls += 1; return gate.promise; });
  const first = mockRes();
  await handler({ query: QUERY }, first);
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.phase, 'input-probe');
  const second = mockRes();
  await handler({ query: { ...QUERY, q: 'agent' } }, second);
  assert.equal(second.statusCode, 202, 'q= shares the same pending probe');
  assert.equal(calls, 1, 'concurrent polls must not stack probes on the lane');
  gate.reject(new Error('test-finished'));
});

test('a transient lane failure during the candidates probe answers 202 with lastError, then retries', async t => {
  let calls = 0;
  const { handler } = await themesHandler(t, async () => { calls += 1; throw new Error('db-read-worker-timeout'); });
  const first = mockRes();
  await handler({ query: QUERY }, first);
  assert.equal(first.statusCode, 202, 'a lane timeout must never surface as a 500');
  assert.match(first.body.lastError, /db-read-worker-timeout/);
  const second = mockRes();
  await handler({ query: QUERY }, second);
  assert.equal(second.statusCode, 202);
  assert.ok(calls >= 2, 'the next poll retries the probe');
});

function ledgerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-cold-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ entries: [] }), 'utf8');
  return { ledgerPath, discoveryPath: path.join(dir, 'discovery.json') };
}

test('Sale Watch awaits the stored page (no 202 in steady state); 202 only while the stored assessment is missing', async () => {
  const gate = deferred();
  let calls = 0;
  const coverageGate = deferred();
  const routes = new Map();
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
    ...ledgerFixture(),
    reconstructionWaitMs: 20,
    coverageWaitMs: 20,
    reconstructionLoader: () => { calls += 1; return gate.promise; },
    reconstructionCoverage: () => coverageGate.promise,
  });
  const handler = routes.get('/api/sale-watch');
  const req = { query: { view: 'leads', surface: 'interactive' } };
  const first = mockRes();
  const firstRead = handler(req, first);
  const again = mockRes();
  const secondRead = handler(req, again);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(first.body, null, 'a slow stored read is awaited, never answered 202');
  gate.resolve({ status: 'ready', entries: [] });
  await Promise.all([firstRead, secondRead]);
  assert.equal(first.statusCode, 200);
  assert.equal(again.statusCode, 200);
  assert.ok(Array.isArray(first.body.entries));
  assert.equal(first.body.coverage.reconstruction.pending, true, 'slow coverage never blocks the page');
  assert.equal(calls, 1, 'concurrent requests share one lane read');
  coverageGate.resolve(null);

  // First boot: the store reports pending -> 202, and the answer is not cached.
  let bootCalls = 0;
  let built = false;
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
    ...ledgerFixture(),
    reconstructionLoader: async () => { bootCalls += 1; return built ? { status: 'ready', entries: [] } : { status: 'pending', entries: [] }; },
  });
  const boot = mockRes();
  await routes.get('/api/sale-watch')({ query: { view: 'focus', days: '7' } }, boot);
  assert.equal(boot.statusCode, 202);
  assert.equal(boot.body.status, 'pending');
  assert.ok(boot.body.retryAfterMs > 0);
  built = true;
  const after = mockRes();
  await routes.get('/api/sale-watch')({ query: { view: 'focus', days: '7' } }, after);
  assert.equal(after.statusCode, 200, 'once stored, the next poll is served');
  assert.equal(bootCalls, 2);
});

test('a failed Sale Watch lane read is reported (503, never 500) and retried on the next poll', async () => {
  let calls = 0;
  const routes = new Map();
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
    ...ledgerFixture(),
    reconstructionWaitMs: 200,
    reconstructionLoader: async () => { calls += 1; if (calls === 1) throw new Error('db-read-worker-retired'); return []; },
  });
  const handler = routes.get('/api/sale-watch');
  const failed = mockRes();
  await handler({ query: {} }, failed);
  assert.equal(failed.statusCode, 503);
  const ok = mockRes();
  await handler({ query: {} }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(calls, 2);
});

test('a Sale Watch q search never answers 202 pending: it waits for the shared read', async () => {
  let calls = 0;
  const routes = new Map();
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
    ...ledgerFixture(),
    reconstructionWaitMs: 5,
    coverageWaitMs: 5,
    reconstructionLoader: () => { calls += 1; return new Promise(resolve => setTimeout(() => resolve([]), 60)); },
  });
  const handler = routes.get('/api/sale-watch');
  const res = mockRes();
  await handler({ query: { q: 'inference', days: '1' } }, res);
  assert.equal(res.statusCode, 200, 'q searches must not return the pending state');
  assert.notEqual(res.body.status, 'pending');
  assert.ok(Array.isArray(res.body.entries));
  assert.equal(calls, 1);
  // Without q the stored page is awaited too: no 202 in steady state.
  const plain = mockRes();
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
    ...ledgerFixture(), reconstructionWaitMs: 5, coverageWaitMs: 5,
    reconstructionLoader: () => new Promise(resolve => setTimeout(() => resolve({ status: 'ready', entries: [] }), 60)),
  });
  await routes.get('/api/sale-watch')({ query: { view: 'leads' } }, plain);
  assert.equal(plain.statusCode, 200);
});

test('while the read-time path serves (first stored pass running), non-q pages keep the f3c6494 bounded wait + 202; q and stored pages are awaited', async () => {
  let mode = 'read-time';
  let slow = false;
  let calls = 0;
  const routes = new Map();
  const page = () => ({ status: 'ready', source: mode, entries: [], version: null, ledgerStore: { version: null, complete: mode === 'stored', serving: mode } });
  registerSaleWatchRoutes({ get(p, h) { routes.set(p, h); } }, {
    ...ledgerFixture(), reconstructionWaitMs: 10, coverageWaitMs: 5,
    reconstructionLoader: () => { calls += 1; return slow ? new Promise(resolve => setTimeout(() => resolve(page()), 50)) : page(); },
  });
  const handler = routes.get('/api/sale-watch');
  const first = mockRes();
  await handler({ query: { view: 'all' } }, first);
  assert.equal(first.statusCode, 200, 'a fast read-time page is served');
  slow = true;
  const polled = mockRes();
  await handler({ query: { view: 'leads' } }, polled);
  assert.equal(polled.statusCode, 202, 'a slow read-time page answers the f3c6494 202 poll');
  const searched = mockRes();
  await handler({ query: { view: 'leads', q: 'inference' } }, searched);
  assert.equal(searched.statusCode, 200, 'a q search is awaited even on the read-time path');
  await new Promise(resolve => setTimeout(resolve, 60));
  const ready = mockRes();
  await handler({ query: { view: 'leads' } }, ready);
  assert.equal(ready.statusCode, 200, 'the polled read-time page is then served');
  mode = 'stored';
  const switching = mockRes();
  await handler({ query: { view: 'focus' } }, switching);
  // The first stored answer is still bounded by the prior read-time mode; once seen, stored pages are awaited.
  await new Promise(resolve => setTimeout(resolve, 60));
  const settle = mockRes();
  await handler({ query: { view: 'focus' } }, settle);
  assert.equal(settle.statusCode, 200);
  assert.equal(settle.body.coverage.reconstruction, null);
  const stored = mockRes();
  await handler({ query: { view: 'transfer' } }, stored);
  assert.equal(stored.statusCode, 200, 'once the stored path serves, slow pages are awaited (no 202)');
  assert.ok(calls >= 5);
});
