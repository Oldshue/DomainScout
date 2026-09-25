'use strict';

// GET /api/sale-watch/candidates -- the full weekly sale-candidate tape.
//
// The contract under test is that this tape shows EVERY departure in the window
// that survived the exclusions Sale Watch already applies, not the small
// pre-scored ledger slice. So the tests pin three things: the exclusions are the
// ledger's own (shared SQL, shared ingest receipts -- no second classifier),
// cohortSize/batches describe the window truthfully so a caller can collapse a
// single actor moving a block, and the cursor walks every row exactly once.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema } = require('../server/sale-watch-reconstruction');
const { SUFFIX_WEIGHTS } = require('../server/domain-signal-policy');
const {
  readSaleWatchCandidates,
  normalizeQuery,
  CandidateQueryError,
  SCHEMA,
  BATCH_MIN_NAMES,
} = require('../server/sale-watch-candidates');
const { registerSaleWatchRoutes } = require('../server/sale-watch');

const NOW = new Date('2026-09-25T12:00:00Z');
const ZERO_WEIGHT_SUFFIX = (Object.entries(SUFFIX_WEIGHTS).find(([, weight]) => weight === 0) || [])[0];

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return db;
}

function evidenceJson(day, destination, extra = {}) {
  const { homepage = null, rdap = null, buyerUse = null, buyerTitle = null } = extra;
  return JSON.stringify({
    tier: 'suspected',
    reportDate: day,
    sellerNameservers: ['ns1.dan.com', 'ns2.dan.com'],
    buyerNameservers: destination,
    ...(buyerTitle ? { buyerTitle } : {}),
    discovery: {
      movement: {
        day,
        prevDay: day,
        previousNameservers: ['ns1.dan.com', 'ns2.dan.com'],
        currentNameservers: destination,
        source: 'daily-zone-delegation-diff',
      },
      structurallyMoved: true,
      departureDate: day,
      ...(buyerUse === null ? {} : { buyerUse }),
      ...(homepage ? { homepage } : {}),
      ...(rdap ? { rdap } : {}),
    },
  });
}

function insertCandidate(db, row) {
  const {
    domain,
    day,
    destination = ['ns1.host.example'],
    state = 'exited',
    outcome = null,
    outcomeTier = null,
    probeCount = 0,
    evidence,
  } = row;
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state,
       next_probe_at, probe_count, outcome, outcome_tier, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    domain, day, day, day, state, day, probeCount, outcome, outcomeTier,
    evidence === undefined ? evidenceJson(day, destination, row.extra || {}) : evidence,
    `${day}T00:00:00Z`,
  );
}

function insertImport(db, day, summary) {
  db.prepare('INSERT OR REPLACE INTO sale_watch_movement_imports VALUES(?,?,?,?,?,?)')
    .run(day, `sig-${day}`, `${day}T01:00:00Z`, summary.departures, summary.queued || 0, JSON.stringify({ day, ...summary }));
}

// One window holding: two independent buyers, a 12-name bulk move to a single
// destination, an earlier-day independent buyer, a row outside the window, and
// four rows that must never appear (rescored platform/expiry, a terminal state,
// and a zero-weight suffix the owner signal policy excludes).
function seedWindow(db) {
  insertCandidate(db, {
    domain: 'alpha.com',
    day: '2026-09-25',
    destination: ['ns1.alphahost.net'],
    probeCount: 2,
    outcomeTier: 'probable',
    extra: {
      buyerUse: true,
      buyerTitle: 'Alpha — payroll',
      homepage: { active: true, parked: false, placeholder: false, status: 200, title: 'Alpha — payroll' },
      rdap: { registrar: 'Example Registrar', transferAt: '2026-09-24T00:00:00Z' },
    },
  });
  insertCandidate(db, {
    domain: 'beta.io',
    day: '2026-09-25',
    destination: ['ns1.betahost.net'],
    probeCount: 1,
    extra: {
      buyerUse: false,
      homepage: { active: false, parked: true, placeholder: false, status: 200, title: 'parked' },
    },
  });
  for (let index = 0; index < 12; index += 1) {
    insertCandidate(db, {
      domain: `bulk${index}.com`,
      day: '2026-09-25',
      destination: ['ns1.bulkhost.net', 'ns2.bulkhost.net'],
    });
  }
  insertCandidate(db, { domain: 'gamma.com', day: '2026-09-24', destination: ['ns1.gammahost.net'] });
  insertCandidate(db, { domain: 'old.com', day: '2026-09-10', destination: ['ns1.oldhost.net'] });

  insertCandidate(db, { domain: 'rescored.com', day: '2026-09-25', outcome: 'platform-excluded' });
  insertCandidate(db, { domain: 'lapsed.com', day: '2026-09-25', outcome: 'expiry-excluded' });
  insertCandidate(db, { domain: 'settled.com', day: '2026-09-25', state: 'resolved' });
  insertCandidate(db, { domain: 'nulled.com', day: '2026-09-25', evidence: null });
  if (ZERO_WEIGHT_SUFFIX) {
    insertCandidate(db, { domain: `policy.${ZERO_WEIGHT_SUFFIX}`, day: '2026-09-25' });
  }

  insertImport(db, '2026-09-25', {
    departures: 900, platformExcluded: 700, expiryExcluded: 150, excludedByPolicy: 36, eligible: 14, cursorComplete: true,
  });
  insertImport(db, '2026-09-24', {
    departures: 800, platformExcluded: 600, expiryExcluded: 120, excludedByPolicy: 79, eligible: 1, cursorComplete: true,
  });
  insertImport(db, '2026-09-10', {
    departures: 500, platformExcluded: 400, expiryExcluded: 80, excludedByPolicy: 19, eligible: 1, cursorComplete: true,
  });
  return db;
}

function read(db, params = {}) {
  return readSaleWatchCandidates(db, { now: NOW, ...params });
}

// ── exclusions ──────────────────────────────────────────────────────────────

test('the tape applies the ledger\'s own exclusions: rescored platform/expiry, terminal states, and the owner signal policy never appear', () => {
  const db = seedWindow(buildDb());
  const domains = read(db).rows.map(row => row.domain);

  assert.ok(!domains.includes('rescored.com'), 'a rescored platform exclusion must stay out');
  assert.ok(!domains.includes('lapsed.com'), 'a rescored expiry exclusion must stay out');
  assert.ok(!domains.includes('settled.com'), 'a terminal (resolved) candidate is not a live departure');
  assert.ok(!domains.includes('nulled.com'), 'a row with no evidence has no departure to report');
  if (ZERO_WEIGHT_SUFFIX) {
    assert.ok(!domains.includes(`policy.${ZERO_WEIGHT_SUFFIX}`), 'the owner signal policy excludes zero-weight suffixes');
  }

  // Everything that DID survive ingest is present -- that is the whole point of
  // the tape, and is where it parts company with the pre-scored ledger view.
  assert.equal(domains.length, 15);
  assert.ok(domains.includes('gamma.com'), 'an unprobed departure is still a candidate');
  assert.ok(domains.includes('beta.io'), 'a probed-but-parked departure is still a candidate');
});

test('coverage reports the ingest receipts for the window, never a re-derived count', () => {
  const db = seedWindow(buildDb());
  const { coverage } = read(db);

  assert.equal(coverage.from, '2026-09-19');
  assert.equal(coverage.to, '2026-09-25');
  assert.equal(coverage.departures, 1700, 'only the two in-window import days are summed');
  assert.equal(coverage.eligible, 15, 'eligible is the rows this tape can actually return');
  assert.deepEqual(coverage.excludedByReason, {
    platformBatch: 1300,
    expiry: 270,
    signalPolicy: 115,
    rescoredPlatformOrExpiry: 2,
  });
});

// ── cohortSize and batches ──────────────────────────────────────────────────

test('cohortSize counts the window-wide destination set and batches expose the bulk move, not the independent buyers', () => {
  const db = seedWindow(buildDb());
  const result = read(db);
  const byDomain = new Map(result.rows.map(row => [row.domain, row]));

  assert.equal(byDomain.get('alpha.com').cohortSize, 1);
  assert.equal(byDomain.get('beta.io').cohortSize, 1);
  assert.equal(byDomain.get('gamma.com').cohortSize, 1);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(byDomain.get(`bulk${index}.com`).cohortSize, 12);
  }

  assert.equal(result.batches.length, 1, 'only the >=10-name destination set is a batch');
  assert.equal(result.batches[0].count, 12);
  assert.deepEqual(result.batches[0].destinationNameservers, ['ns1.bulkhost.net', 'ns2.bulkhost.net']);
  assert.ok(BATCH_MIN_NAMES <= 12);
});

test('order is newest departureDay first, then cohortSize ascending, then domain', () => {
  const db = seedWindow(buildDb());
  const rows = read(db).rows;

  assert.equal(rows[0].domain, 'alpha.com');
  assert.equal(rows[1].domain, 'beta.io');
  assert.equal(rows[2].domain, 'bulk0.com', 'the bulk cohort sorts after independent buyers on the same day');
  assert.equal(rows.at(-1).domain, 'gamma.com', 'the older day sorts last');

  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1];
    const row = rows[index];
    const ordered = prev.departureDay > row.departureDay
      || (prev.departureDay === row.departureDay && prev.cohortSize < row.cohortSize)
      || (prev.departureDay === row.departureDay && prev.cohortSize === row.cohortSize && prev.domain < row.domain);
    assert.ok(ordered, `${prev.domain} must sort before ${row.domain}`);
  }
});

test('a row carries the fields a research run needs to act without a second call', () => {
  const db = seedWindow(buildDb());
  const byDomain = new Map(read(db).rows.map(row => [row.domain, row]));

  const alpha = byDomain.get('alpha.com');
  assert.equal(alpha.tld, 'com');
  assert.equal(alpha.departureDay, '2026-09-25');
  assert.equal(alpha.departureDaySource, 'daily-zone-delegation-diff');
  assert.deepEqual(alpha.sellerNameservers, ['ns1.dan.com', 'ns2.dan.com']);
  assert.equal(alpha.marketplace, 'Dan', 'the seller nameservers name the marketplace it left');
  assert.deepEqual(alpha.destinationNameservers, ['ns1.alphahost.net']);
  assert.equal(alpha.probeState, 'probed');
  assert.equal(alpha.built, true);
  assert.equal(alpha.siteClass, 'built');
  assert.equal(alpha.buyerTitle, 'Alpha — payroll');
  assert.equal(alpha.registrar, 'Example Registrar');
  assert.equal(alpha.transferAt, '2026-09-24T00:00:00Z');
  assert.equal(alpha.ledgerTier, 'probable', 'a name already in the ledger says so');

  const beta = byDomain.get('beta.io');
  assert.equal(beta.built, false);
  assert.equal(beta.siteClass, 'parked');
  assert.equal(beta.ledgerTier, undefined, 'a name absent from the ledger carries no tier');

  const gamma = byDomain.get('gamma.com');
  assert.equal(gamma.probeState, 'unprobed');
  assert.equal(gamma.built, undefined, 'unprobed is unknown, never false');
});

// ── cursor ──────────────────────────────────────────────────────────────────

test('the cursor pages through every row exactly once, with no gaps and no repeats', () => {
  const db = seedWindow(buildDb());
  const expected = read(db).rows.map(row => row.domain);

  const walked = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = read(db, { limit: 4, cursor });
    pages += 1;
    assert.ok(page.rows.length <= 4);
    walked.push(...page.rows.map(row => row.domain));
    cursor = page.pagination.nextCursor;
    assert.ok(pages < 20, 'paging must terminate');
  } while (cursor);

  assert.equal(pages, 4);
  assert.deepEqual(walked, expected, 'the walk reproduces the full ordered tape');
  assert.equal(new Set(walked).size, walked.length, 'no row is served twice');
});

test('a cursor minted for a different query is rejected rather than silently paging the wrong set', () => {
  const db = seedWindow(buildDb());
  const cursor = read(db, { limit: 2 }).pagination.nextCursor;
  assert.ok(cursor);

  // Same cursor, different filters: each must refuse it.
  for (const params of [{ tld: 'com' }, { q: 'alpha' }, { built: 'true' }, { from: '2026-09-01', to: '2026-09-25' }]) {
    assert.throws(
      () => read(db, { ...params, limit: 2, cursor }),
      error => error instanceof CandidateQueryError && error.status === 400,
      `cursor must be rejected for ${JSON.stringify(params)}`,
    );
  }

  // The same query still accepts it.
  assert.doesNotThrow(() => read(db, { limit: 2, cursor }));
  assert.throws(() => read(db, { limit: 2, cursor: 'not-a-cursor' }), CandidateQueryError);
});

// ── filters ─────────────────────────────────────────────────────────────────

test('days, from/to, tld, q and built each narrow the tape', () => {
  const db = seedWindow(buildDb());

  assert.equal(read(db, { days: 1 }).rows.length, 14, 'days=1 keeps only the newest day');
  assert.deepEqual(read(db, { from: '2026-09-01', to: '2026-09-15' }).rows.map(r => r.domain), ['old.com']);
  assert.deepEqual(read(db, { tld: 'io' }).rows.map(r => r.domain), ['beta.io']);
  assert.deepEqual(read(db, { tld: '.io' }).rows.map(r => r.domain), ['beta.io'], 'a leading dot is tolerated');
  assert.deepEqual(read(db, { q: 'alpha' }).rows.map(r => r.domain), ['alpha.com']);
  assert.deepEqual(read(db, { built: 'true' }).rows.map(r => r.domain), ['alpha.com']);
  assert.deepEqual(read(db, { built: 'false' }).rows.map(r => r.domain), ['beta.io'],
    'built=false means a probe decided it, so unprobed rows are not swept in');

  // cohortSize stays a window-wide fact even when a filter hides the cohort.
  assert.equal(read(db, { q: 'bulk3' }).rows[0].cohortSize, 12);
  assert.equal(read(db, { q: 'bulk3' }).batches[0].count, 12);
});

test('invalid queries are refused with a 400-shaped error', () => {
  for (const params of [
    { days: 0 }, { days: 15 }, { days: 'many' },
    { from: '2026-09-01' }, { from: '09/01/2026', to: '2026-09-25' }, { from: '2026-09-25', to: '2026-09-01' },
    { tld: 'not a tld' }, { built: 'maybe' }, { limit: 0 }, { limit: 1001 },
    { q: 'x'.repeat(101) },
  ]) {
    assert.throws(
      () => normalizeQuery(params, { now: NOW }),
      error => error instanceof CandidateQueryError && error.status === 400,
      `must reject ${JSON.stringify(params)}`,
    );
  }
  assert.equal(normalizeQuery({}, { now: NOW }).days, 7, 'days defaults to 7');
  assert.equal(normalizeQuery({}, { now: NOW }).limit, 500, 'limit defaults to 500');
});

// ── response size ───────────────────────────────────────────────────────────

test('a full limit=500 page stays well under 1 MB', () => {
  const db = buildDb();
  for (let index = 0; index < 600; index += 1) {
    const label = `candidate-name-${String(index).padStart(4, '0')}`;
    insertCandidate(db, {
      domain: `${label}.com`,
      day: '2026-09-25',
      destination: [`ns1.destination-${index}.example`, `ns2.destination-${index}.example`],
      probeCount: 2,
      outcomeTier: 'suspected',
      extra: {
        buyerUse: true,
        buyerTitle: `${label} — a reasonably long buyer page title for sizing`,
        homepage: { active: true, parked: false, placeholder: false, status: 200, title: `${label} — a reasonably long buyer page title for sizing` },
        rdap: { registrar: 'Some Registrar With A Long Name, LLC', transferAt: '2026-09-24T00:00:00Z' },
      },
    });
  }
  insertImport(db, '2026-09-25', { departures: 5000, platformExcluded: 3000, expiryExcluded: 900, excludedByPolicy: 500, eligible: 600, cursorComplete: true });

  const result = read(db, { limit: 500 });
  assert.equal(result.rows.length, 500);
  assert.ok(result.pagination.nextCursor, 'a 600-row window still has a next page');
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.ok(bytes < 1024 * 1024, `response must stay under 1 MB, got ${bytes} bytes`);
});

// ── route ───────────────────────────────────────────────────────────────────

async function callRoute(options, query = {}) {
  const routes = new Map();
  const stubApp = { get(path, handler) { routes.set(path, handler); } };
  registerSaleWatchRoutes(stubApp, options);
  const handler = routes.get('/api/sale-watch/candidates');
  assert.ok(handler, 'the route must be registered');
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  // Behave as the cloud deployment does (Railway is the system of record), so
  // the route reads its own store instead of forwarding to itself.
  const priorProject = process.env.RAILWAY_PROJECT_ID;
  process.env.RAILWAY_PROJECT_ID = 'test-project';
  try {
    await handler({ query }, res);
  } finally {
    if (priorProject === undefined) delete process.env.RAILWAY_PROJECT_ID;
    else process.env.RAILWAY_PROJECT_ID = priorProject;
  }
  return res;
}

test('the route serves the tape with Cache-Control: no-store', async () => {
  const db = seedWindow(buildDb());
  const res = await callRoute({ candidateLoader: params => readSaleWatchCandidates(db, { ...params, now: NOW }) }, { days: '7' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.schema, SCHEMA);
  assert.equal(res.body.rows.length, 15);
  assert.equal(res.body.batches[0].count, 12);
});

test('a failing store returns 503 with detail, never an empty list', async () => {
  const failing = await callRoute({
    candidateLoader: () => { throw new Error('reconstruction store is offline'); },
  }, { days: '7' });

  assert.equal(failing.statusCode, 503);
  assert.equal(failing.headers['Cache-Control'], 'no-store');
  assert.equal(failing.body.schema, SCHEMA);
  assert.match(failing.body.detail, /offline/);
  assert.equal(failing.body.rows, undefined, 'an outage must not look like "no sales this week"');

  // A deployment with no reconstruction store configured is also an outage.
  const unconfigured = await callRoute({}, { days: '7' });
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.body.rows, undefined);

  // As is a loader that answers with something that is not a tape.
  const malformed = await callRoute({ candidateLoader: () => null }, { days: '7' });
  assert.equal(malformed.statusCode, 503);
  assert.equal(malformed.body.rows, undefined);
});

test('the route answers 400 for a bad query or a mismatched cursor, distinct from a store outage', async () => {
  const db = seedWindow(buildDb());
  const loader = params => readSaleWatchCandidates(db, { ...params, now: NOW });

  const badDays = await callRoute({ candidateLoader: loader }, { days: '99' });
  assert.equal(badDays.statusCode, 400);
  assert.match(badDays.body.detail, /days/);

  const first = await callRoute({ candidateLoader: loader }, { days: '7', limit: '2' });
  const cursor = first.body.pagination.nextCursor;
  assert.ok(cursor);
  const mismatched = await callRoute({ candidateLoader: loader }, { days: '7', limit: '2', tld: 'com', cursor });
  assert.equal(mismatched.statusCode, 400);
  assert.match(mismatched.body.detail, /different query/);
});
