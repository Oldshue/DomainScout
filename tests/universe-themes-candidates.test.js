'use strict';

// GET /api/universe/themes?source=candidates -- theme convergence over the FULL
// Sale Watch candidate tape.
//
// The contract under test is the one a research run depends on: independence is a
// BUYER, not a name. A three-day window holds thousands of built candidates, so no
// caller can read the tape and judge convergence by eye; the server has to do it over
// every row. The fixture is therefore the adversarial case that a naive member-count
// ranking gets WRONG: one actor buying ten 'vault' names (a single destination
// nameserver set the candidate reader already reports as a batch) against five
// independent buyers each buying one 'longevity' name (five distinct destinations).
// The kit has twice the names and, by the vendored engine's own convergence score, a
// far higher raw score -- and it must still rank BELOW the theme several independent
// buyers converged on, with its names still listed and its collapse auditable.
//
// The candidate tape is supplied through an injected loader shaped exactly like
// readSaleWatchCandidates()'s return value (coverage / batches / batchThreshold /
// matched / rows / pagination with a working cursor). That is the same seam the cloud
// deployment fills with the off-main 'sale-watch.candidates' read lane, so these tests
// exercise the real engine, the real adapter and the real route handler -- only the
// SQLite store behind the reader is replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createUniverseThemeEngine, registerUniverseThemeRoutes } = require('../server/universe-themes');

function havePython3() {
  const r = spawnSync('python3', ['--version'], { timeout: 10000 });
  return !r.error && r.status === 0;
}

const RANGE = { from: '2026-09-23', to: '2026-09-25', refFrom: '2026-09-20', refTo: '2026-09-22' };
const KIT_NS = ['ns1.kithost.example', 'ns2.kithost.example'];
const BATCH_THRESHOLD = 10;

// Co-tokens chosen so the segmenter recognizes BOTH halves of every label: each is a
// real dictionary word or a term the candidates engine options add via the vendored
// script's generic `extraWords` option. They are also outside the engine's GENERIC
// stop set, so each contributes a co-token -- the convergence formula multiplies by
// log(1 + coTokens), so a theme whose co-tokens are all generic would score zero.
const CO_TOKENS = ['desk', 'payroll', 'custody', 'compliance', 'workflow',
  'telemetry', 'logistics', 'dispatch', 'scheduling', 'onboarding'];

// One actor: ten 'vault' names, every one landing on the SAME destination nameserver
// set. The candidate reader reports that set as a batch (>= 10 names in the window).
function vaultRows() {
  return CO_TOKENS.map((word, i) => ({
    domain: `vault${word}.com`,
    departureDay: RANGE.from,
    destinationNameservers: KIT_NS,
    built: true,
    buyerTitle: `Vault kit ${i + 1}`,
  }));
}

// Five independent buyers: one 'longevity' name each, each to its OWN destination.
function longevityRows() {
  return ['payroll', 'custody', 'compliance', 'workflow', 'telemetry'].map((word, i) => ({
    domain: `longevity${word}.com`,
    departureDay: RANGE.to,
    destinationNameservers: [`ns1.buyer${i + 1}.example`],
    built: true,
    buyerTitle: `Longevity buyer ${i + 1}`,
  }));
}

// An UNPROBED sixth longevity name (built: null). The reader treats unprobed as
// unknown, not false, so the default built-candidates input excludes it and
// builtOnly=false includes it. This is the row that proves builtOnly toggles the
// engine's input rather than merely filtering the output.
const UNPROBED_ROW = {
  domain: 'longevitydesk.com',
  departureDay: RANGE.to,
  destinationNameservers: ['ns1.buyer6.example'],
  built: null,
  buyerTitle: null,
};

// A distinct reference-span theme. theme-convergence.py treats an EMPTY reference
// dict exactly like "no reference at all", so the reference span must carry real,
// unrelated signal for rise-vs-reference to mean anything.
function referenceRows() {
  return ['payroll', 'custody', 'compliance', 'workflow'].map((word, i) => ({
    domain: `archive${word}.com`,
    departureDay: RANGE.refFrom,
    destinationNameservers: [`ns1.refbuyer${i + 1}.example`],
    built: true,
    buyerTitle: `Archive buyer ${i + 1}`,
  }));
}

function makeStore() {
  return {
    rows: [...vaultRows(), ...longevityRows(), UNPROBED_ROW, ...referenceRows()],
    // Stands in for the per-day ingest receipts the real reader reports verbatim.
    ingestEligible: 23000,
    calls: [],
  };
}

// A loader with the same observable contract as readSaleWatchCandidates: window-wide
// coverage/batches/matched computed over the whole census BEFORE any paging, plus
// cursor paging with no offset ceiling. Deliberately paginates in small pages so the
// adapter's cursor walk is genuinely exercised rather than trivially satisfied.
function makeLoader(store, { pageSize = 4 } = {}) {
  return async params => {
    store.calls.push({ from: params.from, to: params.to, built: params.built, limit: params.limit });
    const inWindow = store.rows.filter(r => r.departureDay >= params.from && r.departureDay <= params.to);

    // batches are a window-wide fact, independent of the built filter.
    const counts = new Map();
    for (const row of inWindow) {
      const key = [...row.destinationNameservers].sort().join(',');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const batches = [...counts.entries()]
      .filter(([key, count]) => key && count >= BATCH_THRESHOLD)
      .map(([key, count]) => ({ nsKey: key, destinationNameservers: key.split(','), count }));

    const matchingRows = params.built === null || params.built === undefined
      ? inWindow
      : inWindow.filter(r => r.built === params.built);
    const ordered = [...matchingRows].sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

    const start = params.cursor ? Number(params.cursor) : 0;
    const limit = Math.min(Number(params.limit) || pageSize, pageSize);
    const page = ordered.slice(start, start + limit);
    const nextIndex = start + page.length;
    const nextCursor = nextIndex < ordered.length ? String(nextIndex) : null;

    return {
      schema: 'domainscout.sale-watch-candidates/v1',
      generatedAt: new Date().toISOString(),
      query: { from: params.from, to: params.to, built: params.built, limit: params.limit },
      coverage: {
        from: params.from,
        to: params.to,
        departures: inWindow.length * 40,
        eligible: inWindow.length,
        eligibleAtIngest: store.ingestEligible,
        excludedByReason: { platformBatch: 700, expiry: 150, signalPolicy: 36, rescoredPlatformOrExpiry: 0 },
        days: [{ day: params.from, departures: inWindow.length * 40, eligible: inWindow.length, cursorComplete: true }],
      },
      batches,
      batchThreshold: BATCH_THRESHOLD,
      matched: ordered.length,
      rows: page,
      pagination: { limit, returned: page.length, remaining: Math.max(0, ordered.length - nextIndex), nextCursor },
    };
  };
}

async function makeEngine(t, store, extra = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'domainscout-candidate-themes-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const lane = {
    directory,
    listDays: async () => [{ day: RANGE.to, zones: ['com'] }],
  };
  const engine = createUniverseThemeEngine({
    lane,
    log: { warn() {}, log() {}, error() {} },
    candidateTapeLoader: makeLoader(store),
    ...extra,
  });
  return { engine, directory };
}

async function computeCandidates(engine, opts = {}) {
  const first = await engine.getOrCompute(RANGE, 'candidates', opts);
  if (first.status === 'ready') return first.result;
  await first.job.promise;
  const second = await engine.getOrCompute(RANGE, 'candidates', opts);
  assert.equal(second.status, 'ready', 'the range must be ready once its background job resolves');
  return second.result;
}

test('five independent longevity buyers outrank one actor\'s ten-name vault kit; batch names are listed but never counted as independent', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }
  const store = makeStore();
  const { engine } = await makeEngine(t, store);

  const result = await computeCandidates(engine);
  const themes = result.themes || [];
  const names = themes.map(theme => theme.theme);
  assert.ok(names.includes('vault'), `expected a "vault" theme, got: ${names.join(', ')}`);
  assert.ok(names.includes('longevity'), `expected a "longevity" theme, got: ${names.join(', ')}`);

  const vault = themes.find(theme => theme.theme === 'vault');
  const longevity = themes.find(theme => theme.theme === 'longevity');

  assert.equal(longevity.independentBuyers, 5, 'five distinct destination nameserver sets are five independent buyers');
  assert.equal(vault.independentBuyers, 0,
    'every vault name shares one destination set the reader reported as a batch, so the kit contributes NO independent buyers');

  assert.equal(vault.names.length, 10, 'the batch names must still be listed under the theme, not dropped');
  assert.equal(vault.batchesCollapsed.length, 1, 'the collapsed batch must be reported so the collapse is auditable');
  assert.equal(vault.batchesCollapsed[0].namesInTheme, 10);
  assert.ok(vault.batchesCollapsed[0].windowCount >= BATCH_THRESHOLD);

  const vaultRank = themes.findIndex(theme => theme.theme === 'vault');
  const longevityRank = themes.findIndex(theme => theme.theme === 'longevity');
  assert.ok(longevityRank < vaultRank,
    `longevity (independentBuyers ${longevity.independentBuyers}) must rank above the vault kit (independentBuyers ${vault.independentBuyers}), got order: ${names.join(' > ')}`);

  for (const row of longevity.examples) {
    assert.ok(row.domain && row.departureDay, 'each example row carries domain and departureDay');
    assert.ok(Array.isArray(row.destination), 'each example row carries its destination nameserver set');
    assert.ok('buyerTitle' in row, 'each example row carries buyerTitle');
  }
  assert.ok(longevity.builtNames.length >= 5, 'built longevity names must be reported');
  assert.ok('rise' in longevity, 'each theme reports rise versus the reference span');
  assert.equal(result.source, 'candidates');
  assert.equal(result.builtOnly, true, 'the default input is built candidates');
});

test('builtOnly=false widens the engine input to every eligible candidate, including unprobed rows', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }
  const store = makeStore();
  const { engine } = await makeEngine(t, store);

  const builtOnly = await computeCandidates(engine, { builtOnly: true });
  const builtTheme = (builtOnly.themes || []).find(theme => theme.theme === 'longevity');
  assert.ok(builtTheme, 'the longevity theme must be present in the built-only input');
  assert.ok(!builtTheme.names.includes(UNPROBED_ROW.domain),
    'an unprobed candidate is unknown, not built, so the default input must exclude it');

  const everything = await computeCandidates(engine, { builtOnly: false });
  assert.equal(everything.builtOnly, false, 'the result records which input it was computed over');
  const wideTheme = (everything.themes || []).find(theme => theme.theme === 'longevity');
  assert.ok(wideTheme, 'the longevity theme must still be present over the full eligible input');
  assert.ok(wideTheme.names.includes(UNPROBED_ROW.domain),
    'builtOnly=false must feed every eligible candidate, including the unprobed one, to the engine');

  const builtCalls = store.calls.filter(call => call.built === true).length;
  const wideCalls = store.calls.filter(call => call.built === null).length;
  assert.ok(builtCalls > 0 && wideCalls > 0, 'builtOnly must change the filter the candidate reader is asked for');
});

test('a stored result is reused for an unchanged tape and invalidated when the candidate reader\'s input digest changes', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }
  const store = makeStore();
  const { engine } = await makeEngine(t, store);

  const first = await computeCandidates(engine);
  assert.ok(first.inputDigest, 'a candidates result records the input digest it was computed under');

  const cached = await engine.getOrCompute(RANGE, 'candidates', {});
  assert.equal(cached.status, 'ready', 'an unchanged tape must serve the stored result, not recompute');
  assert.equal(cached.result.inputDigest, first.inputDigest);
  assert.equal(cached.result.computedAt, first.computedAt, 'the stored result must be reused verbatim');

  // New ingest lands: another independent buyer of a longevity name, and the ingest
  // receipts change accordingly. The reader's window-wide facts now differ, so the
  // digest must differ and the stored result must no longer be served.
  store.rows.push({
    domain: 'longevitylogistics.com',
    departureDay: RANGE.to,
    destinationNameservers: ['ns1.buyer7.example'],
    built: true,
    buyerTitle: 'Longevity buyer 7',
  });
  store.ingestEligible += 1;

  const afterIngest = await engine.getOrCompute(RANGE, 'candidates', {});
  assert.equal(afterIngest.status, 'pending',
    'new ingest changes the input digest, so the stored result for the same range must be invalidated rather than served stale');
  const recomputed = await computeCandidates(engine);
  assert.notEqual(recomputed.inputDigest, first.inputDigest, 'the input digest must change when the tape changes');
  const longevity = (recomputed.themes || []).find(theme => theme.theme === 'longevity');
  assert.equal(longevity.independentBuyers, 6, 'the newly ingested independent buyer must be counted');
});

// Mounts the real route handler on a minimal fake Express app and drives it with
// req/res doubles: this sandbox refuses real TCP listen() calls, and the handler
// registered by registerUniverseThemeRoutes runs here unmodified.
function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (key, value) => { res.headers[key] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test('GET /api/universe/themes?source=candidates answers 202 while computing, then 200 with the ranked themes', async t => {
  if (!havePython3()) { t.skip('python3 is not available in this sandbox'); return; }
  const store = makeStore();
  const { engine } = await makeEngine(t, store);

  let handler = null;
  const fakeApp = { get(routePath, h) { if (routePath === '/api/universe/themes') handler = h; } };
  registerUniverseThemeRoutes(fakeApp, engine);
  assert.ok(handler, 'registerUniverseThemeRoutes must register a GET /api/universe/themes handler');

  const query = { source: 'candidates', from: RANGE.from, to: RANGE.to, refFrom: RANGE.refFrom, refTo: RANGE.refTo };

  const badBuilt = mockRes();
  await handler({ query: { ...query, builtOnly: 'maybe' } }, badBuilt);
  assert.equal(badBuilt.statusCode, 400, 'an invalid builtOnly value is the caller\'s 400');

  const pending = mockRes();
  await handler({ query }, pending);
  assert.equal(pending.statusCode, 202, 'an uncomputed range answers 202 rather than blocking the request thread');
  assert.equal(pending.body.status, 'pending');
  assert.ok(pending.body.startedAt, '202 reports when the deduplicated background job started');

  const jobs = [...engine._jobs.values()];
  assert.equal(jobs.length, 1, 'the handler invocation must start exactly one tracked background job');
  await jobs[0].promise;

  const ready = mockRes();
  await handler({ query }, ready);
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.source, 'candidates');
  assert.equal(ready.body.builtOnly, true);
  assert.ok(ready.body.inputDigest, '200 reports the input digest the result is keyed by');
  const order = ready.body.themes.map(theme => theme.theme);
  assert.ok(order.indexOf('longevity') < order.indexOf('vault'),
    `the route must serve independent-buyer ranking, got: ${order.join(' > ')}`);

  const filtered = mockRes();
  await handler({ query: { ...query, q: 'longev' } }, filtered);
  assert.equal(filtered.statusCode, 200);
  assert.ok(filtered.body.themes.length >= 1);
  assert.ok(filtered.body.themes.every(theme => theme.theme.includes('longev')), 'q must filter themes by substring');
});
