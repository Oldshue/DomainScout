'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ensureReconstructionSchema,
  requeueFailedProbeEvidence,
  ensureReprobeFailedEvidence,
  DEFAULT_INTAKE_BACKFILL_FROM_DAY,
  INTAKE_RULES_VERSION,
  selectDueCandidates,
  probeCandidate,
} = require('../server/sale-watch-reconstruction');
const { PROBE_CLIENT_VERSION } = require('../server/sale-watch-discovery');

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return db;
}

function insertCandidateRow(db, overrides = {}) {
  const row = {
    domain: 'example.com',
    first_seen_day: '2026-09-17',
    last_seen_day: '2026-09-17',
    last_stream: 'zone-seller-departure',
    last_price: null,
    exit_observed_day: '2026-09-17',
    state: 'probing',
    next_probe_at: '2026-10-01',
    probe_count: 1,
    outcome: null,
    outcome_tier: null,
    evidence_json: null,
    updated_at: '2026-09-17T00:00:00Z',
    probe_priority: 3,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, outcome, outcome_tier, evidence_json, updated_at, probe_priority)
    VALUES (@domain, @first_seen_day, @last_seen_day, @last_stream, @last_price, @exit_observed_day, @state, @next_probe_at, @probe_count, @outcome, @outcome_tier, @evidence_json, @updated_at, @probe_priority)
  `).run(row);
  return db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(row.domain);
}

function failedProbeEvidence({ reasonMessage = 'This operation was aborted' } = {}) {
  return JSON.stringify({
    domain: 'placeholder',
    tier: 'suspected',
    classification: 'acquisition-candidate',
    discovery: {
      homepage: { error: reasonMessage },
      rdap: {},
    },
  });
}

function httpAnswerEvidence() {
  return JSON.stringify({
    domain: 'placeholder',
    tier: 'ruled-out',
    discovery: {
      homepage: { status: 404, answered: true, answerStatus: 404 },
      rdap: {},
    },
  });
}

// ── requeueFailedProbeEvidence ──────────────────────────────────────────────

test('requeueFailedProbeEvidence re-queues a timeout/network/rateLimited failure with priority above ordinary due rows', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'timedout.com',
    exit_observed_day: '2026-09-18',
    evidence_json: failedProbeEvidence({ reasonMessage: 'This operation was aborted' }),
    probe_priority: 3,
    next_probe_at: '2026-10-15',
  });

  const result = requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T00:00:00Z' });
  assert.equal(result.requeued, 1);
  assert.equal(result.byDay['2026-09-18'], 1);

  const row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('timedout.com');
  assert.equal(row.probe_priority, -1, 'priority set above every ordinary due-row priority (0-5)');
  assert.equal(row.next_probe_at, '2026-09-24T00:00:00.000Z');
  assert.equal(row.state, 'probing', 'state untouched — same adjudication path picks it up next wave');
  assert.equal(row.probe_count, 1, 'probe_count untouched by the requeue itself');
  const evidence = JSON.parse(row.evidence_json);
  assert.ok(evidence.discovery.reprobeRequeuedAt, 'non-destructive requeue marker recorded');

  const dayRow = db.prepare('SELECT * FROM sale_watch_reprobe_days WHERE day = ?').get('2026-09-18');
  assert.equal(dayRow.requeued, 1, 'requeuedForReprobe recorded per day');
});

test('requeueFailedProbeEvidence re-queues a rateLimited RDAP failure the same as a timeout', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'ratelimited.com',
    exit_observed_day: '2026-09-19',
    evidence_json: JSON.stringify({ discovery: { rdap: { error: 'Registry rate limit; retry scheduled' } } }),
  });
  const result = requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T00:00:00Z' });
  assert.equal(result.requeued, 1);
  const row = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain = ?').get('ratelimited.com');
  assert.equal(row.probe_priority, -1);
});

test('requeueFailedProbeEvidence does NOT re-queue an HTTP-answer row (401/403/404 is an answer, not a failure)', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'answered404.com',
    exit_observed_day: '2026-09-18',
    evidence_json: httpAnswerEvidence(),
    probe_priority: 3,
    next_probe_at: '2026-10-15',
  });
  const result = requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T00:00:00Z' });
  assert.equal(result.requeued, 0);
  assert.equal(result.skipped, 1);
  const row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('answered404.com');
  assert.equal(row.probe_priority, 3, 'priority untouched');
  assert.equal(row.next_probe_at, '2026-10-15', 'schedule untouched');
});

test('requeueFailedProbeEvidence does NOT re-queue an excluded/terminal row', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'dropped.com',
    exit_observed_day: '2026-09-18',
    state: 'dropped',
    outcome: 'platform-excluded',
    evidence_json: failedProbeEvidence(),
    probe_priority: 5,
    next_probe_at: null,
  });
  insertCandidateRow(db, {
    domain: 'resolved.com',
    exit_observed_day: '2026-09-18',
    state: 'resolved',
    evidence_json: failedProbeEvidence(),
    probe_priority: 3,
    next_probe_at: null,
  });
  insertCandidateRow(db, {
    domain: 'ownermigration.com',
    exit_observed_day: '2026-09-18',
    state: 'probing',
    outcome: 'owner-migration',
    evidence_json: failedProbeEvidence(),
    probe_priority: 3,
    next_probe_at: '2026-10-15',
  });
  const result = requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T00:00:00Z' });
  assert.equal(result.requeued, 0, 'dropped/resolved states are not in RESCORE_ELIGIBLE_STATES and owner-migration is excluded');
  for (const domain of ['dropped.com', 'resolved.com', 'ownermigration.com']) {
    const row = db.prepare('SELECT probe_priority, next_probe_at FROM sale_watch_candidates WHERE domain = ?').get(domain);
    assert.notEqual(row.probe_priority, -1);
  }
});

test('requeueFailedProbeEvidence is idempotent within the same window (reprobeRequeuedAt marker prevents double-count)', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'timedout2.com',
    exit_observed_day: '2026-09-18',
    evidence_json: failedProbeEvidence(),
  });
  const first = requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T00:00:00Z' });
  assert.equal(first.requeued, 1);
  const second = requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T01:00:00Z' });
  assert.equal(second.requeued, 0, 'already-marked row is skipped on a second call');
});

// ── selectDueCandidates ordering ────────────────────────────────────────────

test('a re-queued failed-probe row (priority -1) sorts above an ordinary due row (priority 0+) in selectDueCandidates', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'ordinary-due.com',
    exit_observed_day: '2026-09-20',
    state: 'exited',
    evidence_json: null,
    probe_priority: 0,
    next_probe_at: '2026-09-24T00:00:00.000Z',
    last_stream: 'zone-seller-departure',
  });
  insertCandidateRow(db, {
    domain: 'reprobed.com',
    exit_observed_day: '2026-09-18',
    state: 'probing',
    evidence_json: failedProbeEvidence(),
    probe_priority: 3,
    next_probe_at: '2026-10-15',
    last_stream: 'zone-seller-departure',
  });
  requeueFailedProbeEvidence(db, { fromDay: '2026-09-15', toDay: '2026-09-24', now: '2026-09-24T00:00:00Z' });

  const due = selectDueCandidates(db, { now: '2026-09-24T00:00:00.000Z', limit: 10 });
  const domains = due.map(r => r.domain);
  assert.ok(domains.includes('reprobed.com'), 'reprobed row is due');
  assert.ok(domains.includes('ordinary-due.com'), 'ordinary due row is due');
  assert.ok(domains.indexOf('reprobed.com') < domains.indexOf('ordinary-due.com'), 'reprobed row (priority -1) sorts before ordinary due row');
});

// ── ensureReprobeFailedEvidence (once-per-version guard) ────────────────────

test('ensureReprobeFailedEvidence runs once per (INTAKE_RULES_VERSION, PROBE_CLIENT_VERSION) pair and is a no-op on a second call', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'timedout3.com',
    exit_observed_day: '2026-09-18',
    evidence_json: failedProbeEvidence(),
  });

  const first = ensureReprobeFailedEvidence(db, { fromDay: '2026-09-15', now: '2026-09-24T00:00:00Z' });
  assert.equal(first.ran, true);
  assert.equal(first.version, `${INTAKE_RULES_VERSION}::${PROBE_CLIENT_VERSION}`);
  assert.equal(first.requeued, 1);

  const second = ensureReprobeFailedEvidence(db, { fromDay: '2026-09-15', now: '2026-09-24T01:00:00Z' });
  assert.equal(second.ran, false, 'no-op once the version guard matches');

  const versionRow = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get('reprobe_failed_version');
  assert.equal(versionRow.value, `${INTAKE_RULES_VERSION}::${PROBE_CLIENT_VERSION}`);
});

// ── backfill window ──────────────────────────────────────────────────────────

test('the intake backfill window now starts at 2026-09-15 (10 trailing days through 2026-09-24)', () => {
  assert.equal(DEFAULT_INTAKE_BACKFILL_FROM_DAY, '2026-09-15');
  const spanDays = Math.ceil((Date.parse('2026-09-24T00:00:00Z') - Date.parse(`${DEFAULT_INTAKE_BACKFILL_FROM_DAY}T00:00:00Z`)) / 86400000) + 1;
  assert.equal(spanDays, 10, 'backfill window covers 10 trailing days (2026-09-15..24)');
});

// ── re-probe adjudication reassessment (immediate, same path) ──────────────

test('after a re-probe succeeds via probeCandidate, buyerUse/built and the tier update immediately (same adjudication path, no classifier-version wait)', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, {
    domain: 'reprobe-success.com',
    exit_observed_day: '2026-09-18',
    state: 'probing',
    evidence_json: failedProbeEvidence(),
    probe_priority: -1,
    next_probe_at: '2026-09-24T00:00:00.000Z',
  });

  // Simulate the current, reliable probe client now succeeding where the
  // stored evidence previously recorded a homepage/RDAP probe failure.
  const inspect = async () => ({
    tier: 'probable',
    classification: 'acquisition-candidate',
    buyerNameservers: ['ns1.buyer.com'],
    discovery: { buyerUse: true, homepage: { active: true, title: 'Acme Rebuilt' }, rdap: { registrar: 'Example Registrar' } },
  });

  const outcome = await probeCandidate(db, row, { inspect, now: '2026-09-24T00:00:00Z' });
  assert.equal(outcome.state, 'detected');
  assert.equal(outcome.outcomeTier, 'probable');

  const persisted = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('reprobe-success.com');
  assert.equal(persisted.state, 'detected');
  assert.equal(persisted.outcome_tier, 'probable');
  const evidence = JSON.parse(persisted.evidence_json);
  assert.equal(evidence.discovery.buyerUse, true, 'buyerUse now reflects the successful re-probe immediately');
  assert.equal(evidence.tier, 'probable');
});
