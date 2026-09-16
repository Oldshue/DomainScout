'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureReconstructionSchema } = require('../server/sale-watch-reconstruction');
const { runSaleWatchRetention } = require('../server/sale-watch-retention');

const NOW = new Date('2026-09-16T00:00:00Z');

function daysAgo(now, n) {
  return new Date(now.getTime() - n * 86400000).toISOString();
}

function insertCandidate(db, overrides = {}) {
  const row = {
    domain: 'example.com',
    first_seen_day: '2026-08-01',
    last_seen_day: '2026-08-01',
    last_stream: 'godaddy-auction',
    last_price: null,
    exit_observed_day: '2026-08-01',
    state: 'exited',
    next_probe_at: '2026-08-01',
    probe_count: 0,
    outcome: null,
    outcome_tier: null,
    evidence_json: null,
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, outcome, outcome_tier, evidence_json, updated_at)
    VALUES (@domain, @first_seen_day, @last_seen_day, @last_stream, @last_price, @exit_observed_day, @state, @next_probe_at, @probe_count, @outcome, @outcome_tier, @evidence_json, @updated_at)
  `).run(row);
}

function insertObservation(db, { domain, observedAt, kind, digest, evidenceJson = '{}' }) {
  db.prepare('INSERT INTO sale_watch_observations(domain,observed_at,kind,digest,evidence_json) VALUES(?,?,?,?,?)')
    .run(domain, observedAt, kind, digest, evidenceJson);
}

// Seeds one row/observation for every branch the policy must exercise:
//  - fresh-dropped.com: state='dropped', updated_at 5 days old -> survives (a)
//  - old-dropped.com: state='dropped', updated_at 40 days old -> deleted (a)
//  - old-exhausted.com: state='parked-watch', next_probe_at NULL, outcome
//    exhausted, updated_at 130 days old -> deleted (b)
//  - old-detected.com: state='detected', updated_at 200 days old -> survives
//    (state excluded from the (a)/(b) filters entirely)
//  - old-acquisition-candidate.com: state='probing', next_probe_at NULL,
//    outcome='no-evidence', updated_at 130 days old, but evidence_json
//    classification='acquisition-candidate' -> survives (b)'s exclusion
//  - probing-domain.com: state='probing', next_probe_at NOT NULL (never
//    exhausted) -> survives as a candidate; carries an old probe
//    observation that must be deleted (c)
//  - movement-domain.com: state='probing', next_probe_at NOT NULL ->
//    survives as a candidate; carries an old (200d, <365d) movement
//    observation that must survive (c)
//  - no-such-domain.com: an observation with no matching candidate row at
//    all -> deleted regardless of age/kind (d)
function seedDb(now) {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);

  insertCandidate(db, {
    domain: 'fresh-dropped.com',
    state: 'dropped',
    next_probe_at: null,
    updated_at: daysAgo(now, 5),
  });
  insertCandidate(db, {
    domain: 'old-dropped.com',
    state: 'dropped',
    next_probe_at: null,
    updated_at: daysAgo(now, 40),
  });
  insertCandidate(db, {
    domain: 'old-exhausted.com',
    state: 'parked-watch',
    next_probe_at: null,
    outcome: 'sale-or-parking-destination',
    updated_at: daysAgo(now, 130),
  });
  insertCandidate(db, {
    domain: 'old-detected.com',
    state: 'detected',
    next_probe_at: null,
    updated_at: daysAgo(now, 200),
  });
  insertCandidate(db, {
    domain: 'old-acquisition-candidate.com',
    state: 'probing',
    next_probe_at: null,
    outcome: 'no-evidence',
    evidence_json: JSON.stringify({ classification: 'acquisition-candidate' }),
    updated_at: daysAgo(now, 130),
  });
  insertCandidate(db, {
    domain: 'probing-domain.com',
    state: 'probing',
    next_probe_at: daysAgo(now, -7),
    updated_at: daysAgo(now, 5),
  });
  insertCandidate(db, {
    domain: 'movement-domain.com',
    state: 'probing',
    next_probe_at: daysAgo(now, -7),
    updated_at: daysAgo(now, 5),
  });

  insertObservation(db, {
    domain: 'probing-domain.com',
    observedAt: daysAgo(now, 200),
    kind: 'probe',
    digest: 'probe-old',
  });
  insertObservation(db, {
    domain: 'movement-domain.com',
    observedAt: daysAgo(now, 200),
    kind: 'movement',
    digest: 'movement-old-under-365',
  });
  insertObservation(db, {
    domain: 'no-such-domain.com',
    observedAt: daysAgo(now, 10),
    kind: 'probe',
    digest: 'orphan-1',
  });

  return db;
}

function remainingDomains(db) {
  return db.prepare('SELECT domain FROM sale_watch_candidates ORDER BY domain').all().map(r => r.domain);
}

function remainingObservations(db) {
  return db.prepare('SELECT domain, kind, digest FROM sale_watch_observations ORDER BY domain, digest').all();
}

test('runSaleWatchRetention deletes exactly the aged-out rows per branch and preserves everything else', () => {
  const db = seedDb(NOW);

  const result = runSaleWatchRetention(db, { now: NOW });

  assert.equal(result.candidatesDropped, 1);
  assert.equal(result.candidatesExhausted, 1);
  assert.equal(result.probeObservations, 1);
  assert.equal(result.movementObservations, 0);
  assert.equal(result.orphanObservations, 1);
  assert.equal(typeof result.ms, 'number');

  assert.deepEqual(remainingDomains(db), [
    'fresh-dropped.com',
    'movement-domain.com',
    'old-acquisition-candidate.com',
    'old-detected.com',
    'probing-domain.com',
  ].sort());

  assert.deepEqual(remainingObservations(db), [
    { domain: 'movement-domain.com', kind: 'movement', digest: 'movement-old-under-365' },
  ]);
});

test('runSaleWatchRetention with batch=1 produces identical results to the default batch', () => {
  const db = seedDb(NOW);

  const result = runSaleWatchRetention(db, { now: NOW, batch: 1 });

  assert.equal(result.candidatesDropped, 1);
  assert.equal(result.candidatesExhausted, 1);
  assert.equal(result.probeObservations, 1);
  assert.equal(result.movementObservations, 0);
  assert.equal(result.orphanObservations, 1);

  assert.deepEqual(remainingDomains(db), [
    'fresh-dropped.com',
    'movement-domain.com',
    'old-acquisition-candidate.com',
    'old-detected.com',
    'probing-domain.com',
  ].sort());

  assert.deepEqual(remainingObservations(db), [
    { domain: 'movement-domain.com', kind: 'movement', digest: 'movement-old-under-365' },
  ]);
});
