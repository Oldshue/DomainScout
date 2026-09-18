'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ensureReconstructionSchema,
  runProbeWave,
  reconstructionCoverage,
} = require('../server/sale-watch-reconstruction');

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return db;
}

function insertCandidateRow(db, overrides = {}) {
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

// ── Deliverable 1: per-probe deadline ───────────────────────────────────────

test('a never-resolving probeCandidate yields an error outcome and the wave completes within the probe deadline', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'never-settles.com', state: 'exited', next_probe_at: '2026-08-01' });

  const neverResolves = () => new Promise(() => {});
  const start = Date.now();
  const summary = await runProbeWave(db, {
    probeCandidate: neverResolves,
    now: '2026-08-10',
    skipMovementImport: true,
    probeTimeoutMs: 30,
  });
  const elapsed = Date.now() - start;

  assert.equal(summary.probed, 1);
  assert.ok(elapsed < 5000, `wave should complete quickly once the probe deadline (30ms) fires, took ${elapsed}ms`);

  const row = db.prepare('SELECT next_probe_at, probe_count FROM sale_watch_candidates WHERE domain=?').get('never-settles.com');
  assert.equal(row.probe_count, 0, 'probe_count is left unchanged on timeout');
  assert.equal(new Date(row.next_probe_at).getTime() > new Date('2026-08-10').getTime(), true, 'row is rescheduled roughly 1 hour out');
});

// ── Deliverable 2: per-stage deadline ───────────────────────────────────────

test('a stage that never resolves is abandoned after its deadline and the wave still returns a summary', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'stage-timeout.com', state: 'exited', next_probe_at: '2026-08-01' });

  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });
  const hangingRdapSweep = () => new Promise(() => {});

  const start = Date.now();
  const summary = await runProbeWave(db, {
    inspect,
    now: '2026-08-10',
    skipMovementImport: true,
    rdapSweep: hangingRdapSweep,
    stageTimeouts: { rdapSweep: 30 },
  });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 5000, `wave should proceed past the stuck stage quickly, took ${elapsed}ms`);
  assert.equal(summary.rdapSweep, null, 'the abandoned stage resolves to null so the wave proceeds');
  assert.equal(summary.probed, 1, 'later stages (probing) still ran despite the earlier stage timing out');
});

// ── Deliverable 3: stuck-wave watchdog ──────────────────────────────────────

test('a guard older than the wave ceiling is abandoned and the new wave runs, while a younger one still reports reason overlap', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'stuck-wave.com', state: 'exited', next_probe_at: '2026-08-01' });
  insertCandidateRow(db, { domain: 'second-wave.com', state: 'exited', next_probe_at: '2026-08-01' });

  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const hangingInspect = async () => { await gate; return { tier: 'probable', buyerNameservers: [], discovery: {} }; };

  // First wave hangs on the probe stage forever (until we release it at the end).
  const firstWave = runProbeWave(db, { inspect: hangingInspect, now: '2026-08-10', skipMovementImport: true });

  // A concurrent overlap call within the ceiling still skips as today.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const overlapResult = await runProbeWave(db, { inspect: hangingInspect, now: '2026-08-10', skipMovementImport: true, waveMaxMs: 60000 });
  assert.equal(overlapResult.ran, false);
  assert.equal(overlapResult.reason, 'overlap');

  // Wait past a tiny wave ceiling, then a new wave call abandons the stuck one and runs.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const inspect2 = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });
  const secondWave = await runProbeWave(db, {
    inspect: inspect2,
    now: '2026-08-10',
    skipMovementImport: true,
    waveMaxMs: 1,
    selectDueCandidates: (dbArg, opts) => dbArg.prepare("SELECT * FROM sale_watch_candidates WHERE domain='second-wave.com'").all(),
  });
  assert.equal(secondWave.ran, undefined, 'the abandoning wave ran to completion (not the overlap short-circuit)');
  assert.equal(secondWave.probed, 1);

  releaseFirst();
  await firstWave;
});

// ── Deliverable 4: persisted wave health ────────────────────────────────────

test('sale_watch_wave_runs rows are written and reconstructionCoverage reports wave.stale correctly for a fresh and a 3-hour-old completion', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'fresh-wave.com', state: 'exited', next_probe_at: '2026-08-01' });

  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });

  await runProbeWave(db, { inspect, now: '2026-08-10', skipMovementImport: true });

  const runs = db.prepare('SELECT * FROM sale_watch_wave_runs ORDER BY id').all();
  assert.equal(runs.length, 1);
  assert.ok(runs[0].started_at);
  assert.ok(runs[0].finished_at);
  assert.ok(runs[0].summary_json);

  const freshCoverage = reconstructionCoverage(db);
  assert.equal(freshCoverage.wave.stale, false, 'a just-finished wave is not stale');
  assert.equal(freshCoverage.wave.lastReason, null);
  assert.ok(freshCoverage.wave.lastSummary);

  // Rewrite the finished_at to 3 hours ago and confirm staleness flips.
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE sale_watch_wave_runs SET finished_at = ? WHERE id = ?').run(threeHoursAgo, runs[0].id);
  const staleCoverage = reconstructionCoverage(db);
  assert.equal(staleCoverage.wave.stale, true, 'a wave that finished 3 hours ago is stale (threshold is 2 hours)');

  // No wave at all is also stale.
  const emptyDb = buildDb();
  assert.equal(reconstructionCoverage(emptyDb).wave.stale, true);
});
