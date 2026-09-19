'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');

const {
  ensureReconstructionSchema,
  persistUniverseDay,
  readDaySet,
  diffUniverseDays,
  enqueueExitCandidates,
  pruneUniverseDays,
  runDailyUniversePass,
  dayFilePath,
  selectDueCandidates,
  backfillProbePriority,
  movementProbePriority,
  probeCandidate,
  runProbeWave,
  readReconstructionEntries,
  markAdoptionKits,
  deriveKitKey,
  reassessStoredEvidence,
  ensureAssessmentVersion,
} = require('../server/sale-watch-reconstruction');
const { readSaleWatchLedger } = require('../server/sale-watch');

function buildDb() {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  return db;
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-recon-'));
}

async function* fixtureBatches(batches) {
  for (const batch of batches) yield batch;
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
  return db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get(row.domain);
}

// ── ensureReconstructionSchema ──────────────────────────────────────────────

test('ensureReconstructionSchema is idempotent (safe to run twice)', () => {
  const db = new Database(':memory:');
  ensureReconstructionSchema(db);
  ensureReconstructionSchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name).sort();
  assert.ok(tables.includes('sale_watch_candidates'));
  assert.ok(tables.includes('sale_watch_universe_days'));
});

// ── persistUniverseDay ───────────────────────────────────────────────────────

test('persistUniverseDay writes a sorted, deduped gz file and a correct registry row, atomically (no .tmp left)', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const enumerate = () => fixtureBatches([
    [{ domain: 'zeta.com' }, { domain: 'alpha.com' }, { domain: 'alpha.com' }],
    [{ domain: 'mid.com' }],
  ]);

  const result = await persistUniverseDay(db, { day: '2026-08-30', enumerate, dir });
  assert.equal(result.count, 3);

  const filePath = dayFilePath(dir, '2026-08-30');
  const raw = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['alpha.com', 'mid.com', 'zeta.com'], 'deduped and sorted');

  const row = db.prepare('SELECT * FROM sale_watch_universe_days WHERE day = ?').get('2026-08-30');
  assert.equal(row.domain_count, 3);
  assert.equal(row.file_path, filePath);

  const leftover = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
  assert.equal(leftover.length, 0, 'no tmp file left behind');
});

// ── readDaySet / diffUniverseDays ───────────────────────────────────────────

test('readDaySet/diffUniverseDays compute exits and entries correctly across two fixture days', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  await persistUniverseDay(db, {
    day: '2026-08-29',
    dir,
    enumerate: () => fixtureBatches([[{ domain: 'stays.com' }, { domain: 'leaves.com' }]]),
  });
  await persistUniverseDay(db, {
    day: '2026-08-30',
    dir,
    enumerate: () => fixtureBatches([[{ domain: 'stays.com' }, { domain: 'arrives.com' }]]),
  });

  const daySet = await readDaySet(dir, '2026-08-29');
  assert.deepEqual([...daySet].sort(), ['leaves.com', 'stays.com']);

  const { exits, entries } = await diffUniverseDays(db, { previousDay: '2026-08-29', day: '2026-08-30', dir });
  assert.deepEqual(exits.sort(), ['leaves.com']);
  assert.deepEqual(entries.sort(), ['arrives.com']);
});

test('readDaySet returns an empty set for a missing day file', async () => {
  const dir = mkTmpDir();
  const set = await readDaySet(dir, '2099-01-01');
  assert.equal(set.size, 0);
});

// ── enqueueExitCandidates ────────────────────────────────────────────────────

test('enqueueExitCandidates inserts new exits with state exited and exit_observed_day set', () => {
  const db = buildDb();
  const result = enqueueExitCandidates(db, { exits: ['a.com', 'b.com'], day: '2026-08-30' });
  assert.equal(result.queued, 2);
  const rows = db.prepare('SELECT * FROM sale_watch_candidates ORDER BY domain').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.state, 'exited');
    assert.equal(row.exit_observed_day, '2026-08-30');
    assert.equal(row.last_seen_day, '2026-08-30');
  }
});

test('enqueueExitCandidates respects maxPerDay cap and logs the dropped count', () => {
  const db = buildDb();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const result = enqueueExitCandidates(db, {
      exits: ['a.com', 'b.com', 'c.com'],
      day: '2026-08-30',
      maxPerDay: 2,
    });
    assert.equal(result.queued, 2);
    assert.equal(result.dropped, 1);
    assert.ok(warnings.some(w => w.includes('capped at 2') && w.includes('dropped 1')));
  } finally {
    console.warn = originalWarn;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n;
  assert.equal(count, 2);
});

test('enqueueExitCandidates does not clobber an existing in-flight candidate row', () => {
  const db = buildDb();
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, updated_at)
    VALUES ('inflight.com', '2026-08-01', '2026-08-01', 'godaddy-auction', 12.5, '2026-08-01', 'probing', '2026-08-05', 3, '2026-08-01T00:00:00Z')
  `).run();

  enqueueExitCandidates(db, { exits: ['inflight.com'], day: '2026-08-30' });

  const row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('inflight.com');
  assert.equal(row.state, 'probing', 'in-flight state untouched');
  assert.equal(row.last_seen_day, '2026-08-01', 'in-flight last_seen_day untouched');
  assert.equal(row.exit_observed_day, '2026-08-01', 'in-flight exit_observed_day untouched');
  assert.equal(row.next_probe_at, '2026-08-05', 'in-flight next_probe_at untouched');
  assert.equal(row.probe_count, 3, 'in-flight probe_count untouched');
});

test('enqueueExitCandidates DOES refresh a terminal-state row (resolved/abandoned/expired)', () => {
  const db = buildDb();
  db.prepare(`
    INSERT INTO sale_watch_candidates
      (domain, first_seen_day, last_seen_day, last_stream, last_price, exit_observed_day, state, next_probe_at, probe_count, updated_at)
    VALUES ('resolved.com', '2026-08-01', '2026-08-01', NULL, NULL, '2026-08-01', 'resolved', NULL, 5, '2026-08-01T00:00:00Z')
  `).run();

  enqueueExitCandidates(db, { exits: ['resolved.com'], day: '2026-08-30' });

  const row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('resolved.com');
  assert.equal(row.state, 'exited', 'terminal row re-queued to exited');
  assert.equal(row.exit_observed_day, '2026-08-30');
});

// ── pruneUniverseDays ────────────────────────────────────────────────────────

test('pruneUniverseDays removes only rows/files older than keepDays', () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const oldDay = '2020-01-01';
  const freshDay = new Date().toISOString().slice(0, 10);
  const oldFile = dayFilePath(dir, oldDay);
  const freshFile = dayFilePath(dir, freshDay);
  fs.writeFileSync(oldFile, zlib.gzipSync('old.com\n'));
  fs.writeFileSync(freshFile, zlib.gzipSync('fresh.com\n'));
  db.prepare("INSERT INTO sale_watch_universe_days (day, domain_count, file_path, created_at) VALUES (?, 1, ?, datetime('now'))").run(oldDay, oldFile);
  db.prepare("INSERT INTO sale_watch_universe_days (day, domain_count, file_path, created_at) VALUES (?, 1, ?, datetime('now'))").run(freshDay, freshFile);

  const result = pruneUniverseDays(db, { dir, keepDays: 14 });
  assert.equal(result.deletedRows, 1);
  assert.equal(result.deletedFiles, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_universe_days').get().n, 1);
});

// ── runDailyUniversePass ─────────────────────────────────────────────────────

test('runDailyUniversePass happy path over two consecutive days yields expected exit candidates', async () => {
  const db = buildDb();
  const dir = mkTmpDir();

  const day1 = await runDailyUniversePass(db, {
    today: '2026-08-29',
    dir,
    enumerate: () => fixtureBatches([[{ domain: 'stays.com' }, { domain: 'leaves.com' }]]),
  });
  assert.equal(day1.ran, true);
  assert.equal(day1.previousDay, null);

  const day2 = await runDailyUniversePass(db, {
    today: '2026-08-30',
    dir,
    enumerate: () => fixtureBatches([[{ domain: 'stays.com' }, { domain: 'arrives.com' }]]),
  });
  assert.equal(day2.ran, true);
  assert.equal(day2.previousDay, '2026-08-29');
  assert.equal(day2.exits, 1);
  assert.equal(day2.entries, 1);
  assert.equal(day2.enqueue.queued, 1);

  const candidate = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('leaves.com');
  assert.ok(candidate, 'leaves.com queued as an exit candidate');
  assert.equal(candidate.state, 'exited');
  assert.equal(candidate.exit_observed_day, '2026-08-30');
});

test('runDailyUniversePass skips (reason exposed) when today is already persisted', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const opts = {
    today: '2026-08-30',
    dir,
    enumerate: () => fixtureBatches([[{ domain: 'a.com' }]]),
  };
  const first = await runDailyUniversePass(db, opts);
  assert.equal(first.ran, true);

  const second = await runDailyUniversePass(db, opts);
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'already-persisted');
});

test('runDailyUniversePass skips (reason exposed) under injected disk pressure, and does not run prune in that branch', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  // Seed an over-retention universe day row to prove prune was NOT invoked —
  // the module returns before pruneUniverseDays when diskPressure is true.
  const oldDay = '2020-01-01';
  db.prepare("INSERT INTO sale_watch_universe_days (day, domain_count, file_path, created_at) VALUES (?, 1, ?, datetime('now'))").run(oldDay, dayFilePath(dir, oldDay));

  let enumerateCalled = false;
  const result = await runDailyUniversePass(db, {
    today: '2026-08-30',
    dir,
    freeDiskMb: () => 1, // far below the default 400MB floor
    enumerate: () => { enumerateCalled = true; return fixtureBatches([[{ domain: 'a.com' }]]); },
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'disk-pressure');
  assert.equal(typeof result.freeMb, 'number');
  assert.equal(enumerateCalled, false, 'enumerate must not run under disk pressure');
  // Truthful assertion of actual module behavior: the disk-pressure branch
  // returns before pruneUniverseDays runs, so the stale row still exists.
  const staleRow = db.prepare('SELECT 1 FROM sale_watch_universe_days WHERE day = ?').get(oldDay);
  assert.ok(staleRow, 'prune did not run under disk pressure (module returns early)');
});

test('runDailyUniversePass never invokes the real network enumerateForSaleUniverse (always injected in tests)', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  // Every call in this suite supplies opts.enumerate explicitly; this test just
  // documents/guards that a missing dir short-circuits before any enumeration.
  const result = await runDailyUniversePass(db, { today: '2026-08-30' });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'missing-dir');
});

// ── probeCandidate ───────────────────────────────────────────────────────────

test('probable acquisition remains scheduled for continuing observation', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, { domain: 'probable.com' });
  const inspect = async () => ({ tier: 'probable', buyerNameservers: ['ns1.buyer.com'], discovery: {} });
  const outcome = await probeCandidate(db, row, { inspect, now: '2026-08-10' });
  assert.equal(outcome.state, 'detected');
  assert.equal(outcome.outcome, 'likely-sale');
  assert.equal(outcome.outcomeTier, 'probable');
  assert.equal(outcome.nextProbeAt, '2026-08-11T00:00:00.000Z');

  const persisted = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('probable.com');
  assert.equal(persisted.state, 'detected');
  assert.equal(persisted.outcome, 'likely-sale');
  assert.equal(persisted.outcome_tier, 'probable');
  assert.equal(persisted.next_probe_at, '2026-08-11T00:00:00.000Z');
  assert.ok(persisted.evidence_json);
  const evidence = JSON.parse(persisted.evidence_json);
  assert.equal(evidence.tier, 'probable');
});

test('suspected movement remains probing rather than becoming a completed sale', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, { domain: 'suspected.com' });
  const inspect = async () => ({ tier: 'suspected', buyerNameservers: ['ns1.other.com'], discovery: {} });
  const outcome = await probeCandidate(db, row, { inspect, now: '2026-08-10' });
  assert.equal(outcome.state, 'probing');
  assert.equal(outcome.outcome, 'unconfirmed-move');
  assert.equal(outcome.outcomeTier, 'suspected');
  assert.equal(outcome.nextProbeAt, '2026-08-11T00:00:00.000Z');
});

test('probeCandidate expiration classification schedules a single 45-day recheck instead of the ladder', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, { domain: 'expiring.com' });
  const inspect = async () => ({
    tier: 'excluded',
    classification: 'expiration',
    buyerNameservers: ['expired1.namebrightdns.com'],
    discovery: {},
  });
  const outcome = await probeCandidate(db, row, { inspect, now: '2026-08-10T00:00:00Z' });
  assert.equal(outcome.state, 'parked-watch');
  assert.equal(outcome.outcome, 'expiration');
  assert.equal(outcome.outcomeTier, null);
  assert.equal(outcome.nextProbeAt, new Date(Date.parse('2026-08-10T00:00:00Z') + 45 * 86400000).toISOString());

  const persisted = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('expiring.com');
  assert.equal(persisted.state, 'parked-watch');
  assert.equal(persisted.outcome, 'expiration');
  assert.equal(persisted.outcome_tier, null);
  assert.equal(persisted.next_probe_at, outcome.nextProbeAt);
  assert.equal(persisted.probe_priority, 5);
});

test('probeCandidate registry-hold classification also schedules the single 45-day recheck', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, { domain: 'held.com' });
  const inspect = async () => ({
    tier: 'excluded',
    classification: 'registry-hold',
    buyerNameservers: ['failed-whois-verification.namecheap.com'],
    discovery: {},
  });
  const outcome = await probeCandidate(db, row, { inspect, now: '2026-08-10T00:00:00Z' });
  assert.equal(outcome.state, 'parked-watch');
  assert.equal(outcome.outcome, 'registry-hold');
  assert.equal(outcome.nextProbeAt, new Date(Date.parse('2026-08-10T00:00:00Z') + 45 * 86400000).toISOString());
  const persisted = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain = ?').get('held.com');
  assert.equal(persisted.probe_priority, 5);
});

test('probeCandidate stream-exit limbo guard downgrades suspected tier when all buyer nameservers are domaincontrol.com', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, { domain: 'limbo.com' });
  const inspect = async () => ({
    tier: 'suspected',
    buyerNameservers: ['ns17.domaincontrol.com', 'ns18.domaincontrol.com'],
    discovery: {},
  });
  const outcome = await probeCandidate(db, row, { inspect, now: '2026-08-10' });
  assert.notEqual(outcome.state, 'detected');
  assert.equal(outcome.state, 'parked-watch');

  const persisted = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('limbo.com');
  assert.notEqual(persisted.state, 'detected');
  const evidence = JSON.parse(persisted.evidence_json);
  assert.equal(evidence.discovery.streamExitLimbo, true);
});

test('probeCandidate parkingInfrastructure ruled-out keeps following persistent parking without inferring a flip', async () => {
  const db = buildDb();
  let row = insertCandidateRow(db, { domain: 'parked.com', probe_count: 0 });
  const inspect = async () => ({ tier: 'ruled-out', discovery: { parkingInfrastructure: true } });
  const referenceDay = '2026-08-10';

  const outcome1 = await probeCandidate(db, row, { inspect, now: referenceDay });
  assert.equal(outcome1.state, 'parked-watch');
  const expected1 = new Date(`${referenceDay}T00:00:00Z`);
  expected1.setUTCDate(expected1.getUTCDate() + 7);
  assert.equal(outcome1.nextProbeAt, expected1.toISOString().slice(0, 10));
  assert.equal(outcome1.outcome, null);

  row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('parked.com');
  for (let i = 0; i < 3; i += 1) {
    const outcome = await probeCandidate(db, row, { inspect, now: referenceDay });
    assert.equal(outcome.state, 'parked-watch');
    assert.ok(outcome.nextProbeAt);
    row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('parked.com');
  }

  const finalOutcome = await probeCandidate(db, row, { inspect, now: referenceDay });
  assert.equal(finalOutcome.state, 'parked-watch');
  assert.equal(finalOutcome.outcome, 'sale-or-parking-destination');
  assert.equal(finalOutcome.nextProbeAt, '2026-09-09T00:00:00.000Z');
});

test('probeCandidate nameserver-less ruled-out results in dropped state and outcome', async () => {
  const db = buildDb();
  const row = insertCandidateRow(db, { domain: 'nons.com' });
  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: {
      parentDelegation: { nameservers: [] },
      recursiveNameservers: [],
    },
  });
  const outcome = await probeCandidate(db, row, { inspect, now: '2026-08-10' });
  assert.equal(outcome.state, 'dropped');
  assert.equal(outcome.outcome, 'dropped');

  const persisted = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('nons.com');
  assert.equal(persisted.state, 'dropped');
  assert.equal(persisted.outcome, 'dropped');
});

test('probeCandidate other ruled-out schedules probing ladder then exhausts to no-evidence', async () => {
  const db = buildDb();
  let row = insertCandidateRow(db, { domain: 'probing.com', probe_count: 0 });
  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: {
      parentDelegation: { nameservers: ['ns1.something.com'] },
      recursiveNameservers: ['ns1.something.com'],
    },
  });
  const referenceDay = '2026-08-10';

  const firstOutcome = await probeCandidate(db, row, { inspect, now: referenceDay });
  assert.equal(firstOutcome.state, 'probing');
  const expectedFirst = new Date(`${referenceDay}T00:00:00Z`);
  expectedFirst.setUTCDate(expectedFirst.getUTCDate() + 7);
  assert.equal(firstOutcome.nextProbeAt, expectedFirst.toISOString().slice(0, 10));

  row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('probing.com');
  for (let i = 1; i < 4; i += 1) {
    const outcome = await probeCandidate(db, row, { inspect, now: referenceDay });
    assert.equal(outcome.state, 'probing');
    assert.ok(outcome.nextProbeAt);
    row = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain = ?').get('probing.com');
  }

  const finalOutcome = await probeCandidate(db, row, { inspect, now: referenceDay });
  assert.equal(finalOutcome.state, 'probing');
  assert.equal(finalOutcome.outcome, 'no-evidence');
  assert.equal(finalOutcome.nextProbeAt, null);
});

// ── selectDueCandidates ──────────────────────────────────────────────────────

test('selectDueCandidates returns only due non-terminal rows ordered by next_probe_at', () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'due-early.com', state: 'exited', next_probe_at: '2026-08-01' });
  insertCandidateRow(db, { domain: 'due-later.com', state: 'probing', next_probe_at: '2026-08-05' });
  insertCandidateRow(db, { domain: 'not-due-yet.com', state: 'parked-watch', next_probe_at: '2026-08-20' });
  insertCandidateRow(db, { domain: 'terminal-resolved.com', state: 'resolved', next_probe_at: '2026-08-01' });
  insertCandidateRow(db, { domain: 'no-next-probe.com', state: 'exited', next_probe_at: null });

  const due = selectDueCandidates(db, { now: '2026-08-10' });
  const domains = due.map(r => r.domain);
  assert.deepEqual(domains, ['due-early.com', 'due-later.com']);
});

test('movementProbePriority table: first match wins across the rule set including cohort boundaries', () => {
  const cases = [
    { name: 'transferring wins over any evidence', evidence: { buyerNameservers: ['expired1.namebrightdns.com'] }, state: 'transferring', expected: 0 },
    { name: 'transferring with null evidence', evidence: null, state: 'transferring', expected: 0 },
    { name: 'expiration evidence', evidence: { buyerNameservers: ['expired1.namebrightdns.com'] }, state: 'exited', expected: 5 },
    { name: 'suspended evidence', evidence: { buyerNameservers: ['failed-whois-verification.namecheap.com'] }, state: 'exited', expected: 5 },
    { name: 'parking evidence', evidence: { buyerNameservers: ['ns1.bodis.com'] }, state: 'exited', expected: 5 },
    { name: 'operating destination already seen (buyerUse, no homepage error)', evidence: { discovery: { buyerUse: true, homepage: {} } }, state: 'exited', expected: 1 },
    { name: 'buyerUse with homepage error does not short-circuit to 1', evidence: { discovery: { buyerUse: true, homepage: { error: 'timeout' } } }, state: 'exited', expected: 3 },
    { name: 'movement cohort=1 hosting', evidence: { discovery: { movement: { cohortSize: 1, currentClass: 'hosting' } } }, state: 'exited', expected: 1 },
    { name: 'movement cohort=9 hosting (boundary <10)', evidence: { discovery: { movement: { cohortSize: 9, currentClass: 'hosting' } } }, state: 'exited', expected: 1 },
    { name: 'movement cohort=9 other', evidence: { discovery: { movement: { cohortSize: 9, currentClass: 'other' } } }, state: 'exited', expected: 2 },
    { name: 'movement cohort=10 hosting (boundary >=10)', evidence: { discovery: { movement: { cohortSize: 10, currentClass: 'hosting' } } }, state: 'exited', expected: 2 },
    { name: 'movement cohort=99 hosting (boundary <100)', evidence: { discovery: { movement: { cohortSize: 99, currentClass: 'hosting' } } }, state: 'exited', expected: 2 },
    { name: 'movement cohort=100 hosting (boundary >=100)', evidence: { discovery: { movement: { cohortSize: 100, currentClass: 'hosting' } } }, state: 'exited', expected: 4 },
    { name: 'movement cohort=100 other', evidence: { discovery: { movement: { cohortSize: 100, currentClass: 'other' } } }, state: 'exited', expected: 4 },
    { name: 'legacy no-movement sellerOrigin+destinationObserved ranks with the bulk cohort tier', evidence: { sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.host.example'] }, state: 'exited', expected: 4 },
    { name: 'classification expiration ranks worst regardless of delegation shape', evidence: { classification: 'expiration', sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.host.example'] }, state: 'exited', expected: 5 },
    { name: 'assessment.classification registry-hold ranks worst', evidence: { assessment: { classification: 'registry-hold' }, sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.host.example'] }, state: 'exited', expected: 5 },
    { name: 'movement present but currentClass unmatched and cohort<100 falls through', evidence: { discovery: { movement: { cohortSize: 9, currentClass: 'registrar' } } }, state: 'exited', expected: 3 },
    { name: 'unparsable evidence string', evidence: 'not-an-object', state: 'exited', expected: 3 },
    { name: 'null evidence, non-transferring state', evidence: null, state: 'exited', expected: 3 },
  ];
  for (const { name, evidence, state, expected } of cases) {
    assert.equal(movementProbePriority(evidence, state), expected, name);
  }
});

test('deriveKitKey strips generic brand-stripped residue (Home -, Home |, HTML entities) but keeps real kit keys', () => {
  assert.equal(deriveKitKey('faxly.com', { buyerTitle: 'Home - Faxly' }), null);
  assert.equal(deriveKitKey('acme.com', { buyerTitle: 'Home | Acme' }), null);
  assert.equal(deriveKitKey('faxly.com', { buyerTitle: 'Faxly &ndash; Send faxes' }), 'send faxes');
  assert.equal(deriveKitKey('koreantalent.com', { buyerTitle: 'koreantalent.com - Sell Direct (UK)' }), 'sell direct (uk)');
  assert.equal(deriveKitKey('unrelated-brand.com', { buyerTitle: '— lion domain' }), 'lion domain');
  assert.equal(deriveKitKey('example.com', { buyerTitle: 'steht zum verkauf' }), 'steht zum verkauf');
  assert.equal(deriveKitKey('welcome.com', { buyerTitle: 'Welcome' }), null);
  assert.equal(deriveKitKey('untitled.com', { buyerTitle: '--- ...' }), null, 'punctuation-only residue is rejected');
});

test('selectDueCandidates orders fresh strong-shape departures ahead of the bulk cohort within priority, newest first', () => {
  const db = buildDb();
  const evidenceFor = (previousClass, currentClass, cohortSize, day) => JSON.stringify({
    domain: 'x',
    tier: 'suspected',
    sellerNameservers: ['ns1.dan.com'],
    buyerNameservers: ['ns1.example.net'],
    reportDate: day,
    discovery: {
      movement: {
        day,
        prevDay: '2026-09-09',
        previousNameservers: ['ns1.dan.com'],
        currentNameservers: ['ns1.example.net'],
        previousClass,
        currentClass,
        cohortSize,
      },
      structurallyMoved: true,
      departureDate: day,
    },
  });

  insertCandidateRow(db, { domain: 'bulk-registrar.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-10', evidence_json: evidenceFor('seller', 'registrar', 500, '2026-09-10') });
  insertCandidateRow(db, { domain: 'fresh-hosting-15.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-15', evidence_json: evidenceFor('seller', 'hosting', 1, '2026-09-15') });
  insertCandidateRow(db, { domain: 'fresh-hosting-16.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-16', evidence_json: evidenceFor('seller', 'hosting', 1, '2026-09-16') });
  insertCandidateRow(db, { domain: 'parking-hosting-14.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-14', evidence_json: evidenceFor('parking', 'hosting', 1, '2026-09-14') });
  insertCandidateRow(db, { domain: 'other-3-16.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-16', evidence_json: evidenceFor('seller', 'other', 3, '2026-09-16') });

  const top4 = selectDueCandidates(db, { now: '2026-09-16T12:00:00Z', limit: 4 }).map(r => r.domain);
  assert.deepEqual(top4, ['fresh-hosting-16.com', 'fresh-hosting-15.com', 'parking-hosting-14.com', 'other-3-16.com']);

  const top5 = selectDueCandidates(db, { now: '2026-09-16T12:00:00Z', limit: 5 }).map(r => r.domain);
  assert.equal(top5.length, 5);
  assert.equal(top5.at(-1), 'bulk-registrar.com');
});

test('probe_priority is persisted after ingest and a probe, matching movementProbePriority for the stored state/evidence', async () => {
  const { ingestMovementCandidates } = require('../server/sale-watch-reconstruction');
  const db = buildDb();
  const dir = mkTmpDir(), day = '2026-09-16', folder = path.join(dir, day, 'ns');
  fs.mkdirSync(folder, { recursive: true });
  const depRow = { domain: 'priority-flow.com', selection: 'departures', prev_class: 'seller', today_class: 'hosting', prev_ns: ['ns1.dan.com'], today_ns: ['ns1.example.net'] };
  fs.writeFileSync(path.join(folder, 'movement.jsonl'), JSON.stringify(depRow) + '\n');
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ day, prevDay: '2026-09-15', zones: 1, departures: 1 }));
  await ingestMovementCandidates(db, { directory: dir });
  const afterIngest = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain=?').get('priority-flow.com');
  assert.equal(afterIngest.probe_priority, 1, 'fresh small-cohort seller->hosting move ingests at priority 1');

  const queued = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('priority-flow.com');
  const inspect = async () => ({ tier: 'suspected', buyerNameservers: ['ns1.example.net'], discovery: {} });
  await probeCandidate(db, queued, { inspect, now: '2026-09-16T12:00:00Z' });
  const afterProbe = db.prepare('SELECT probe_priority, evidence_json, state FROM sale_watch_candidates WHERE domain=?').get('priority-flow.com');
  assert.equal(afterProbe.probe_priority, movementProbePriority(JSON.parse(afterProbe.evidence_json), afterProbe.state));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('backfillProbePriority fills NULL probe_priority rows (bounded per call) and a second call reports 0 backfilled', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'null-priority-a.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-16',
    evidence_json: JSON.stringify({ discovery: { movement: { cohortSize: 1, currentClass: 'hosting' } } }),
  });
  insertCandidateRow(db, { domain: 'null-priority-b.com', state: 'transferring', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-09' });
  const before = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain=?').get('null-priority-a.com');
  assert.equal(before.probe_priority, null, 'rows written before this migration start with a NULL priority');

  const first = backfillProbePriority(db);
  assert.equal(first.backfilled, 2);

  const afterA = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain=?').get('null-priority-a.com');
  const afterB = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain=?').get('null-priority-b.com');
  assert.equal(afterA.probe_priority, 1, 'small-cohort hosting move backfilled to priority 1');
  assert.equal(afterB.probe_priority, 0, 'transferring state backfilled to priority 0');

  const second = backfillProbePriority(db);
  assert.equal(second.backfilled, 0, 'a second call finds nothing left to backfill');
});

test('selectDueCandidates never writes: works on a readonly-opened database connection and still returns due rows via the COALESCE fallback', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'readonly-probe.db');
  const seedDb = new Database(file);
  ensureReconstructionSchema(seedDb);
  insertCandidateRow(seedDb, {
    domain: 'readonly-due.com', state: 'exited', next_probe_at: '2026-09-10', exit_observed_day: '2026-09-16',
    evidence_json: JSON.stringify({ discovery: { movement: { cohortSize: 1, currentClass: 'hosting' } } }),
  });
  insertCandidateRow(seedDb, { domain: 'readonly-not-due.com', state: 'exited', next_probe_at: '2026-09-20', exit_observed_day: '2026-09-16' });
  seedDb.close();

  const roDb = new Database(file, { readonly: true });
  try {
    const rows = selectDueCandidates(roDb, { now: '2026-09-16T12:00:00Z', limit: 10 });
    assert.deepEqual(rows.map(r => r.domain), ['readonly-due.com']);
  } finally {
    roDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runProbeWave backfills probe_priority on its own writable db before selecting due candidates, and the wave completes', async () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'wave-backfill.com', state: 'exited', next_probe_at: '2026-08-01', exit_observed_day: '2026-08-01',
    evidence_json: JSON.stringify({ discovery: { movement: { cohortSize: 1, currentClass: 'hosting' } } }),
  });
  const before = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain=?').get('wave-backfill.com');
  assert.equal(before.probe_priority, null);

  let dueSeenRows = null;
  const selectDueSpy = (dbArg, opts) => {
    dueSeenRows = dbArg.prepare('SELECT domain, probe_priority FROM sale_watch_candidates').all();
    return selectDueCandidates(dbArg, opts);
  };
  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });

  const summary = await runProbeWave(db, { inspect, now: '2026-08-10', skipMovementImport: true, selectDueCandidates: selectDueSpy });

  assert.equal(summary.probed, 1);
  assert.equal(summary.backfilled, 1, 'the wave backfilled the one stale-priority row before selecting due candidates');
  assert.ok(dueSeenRows, 'selectDueCandidates was invoked');
  assert.equal(dueSeenRows.find(r => r.domain === 'wave-backfill.com').probe_priority, 1, 'row already carries its backfilled priority by the time selectDueCandidates runs');

  const after = db.prepare('SELECT probe_priority FROM sale_watch_candidates WHERE domain=?').get('wave-backfill.com');
  assert.equal(after.probe_priority, 1);
});

// ── runProbeWave ───────────────────────────────────��─────────────────────────

test('runProbeWave processes a due batch via injected inspect stub and returns summary counts', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'wave-detected.com', state: 'exited', next_probe_at: '2026-08-01' });
  insertCandidateRow(db, { domain: 'wave-dropped.com', state: 'exited', next_probe_at: '2026-08-01' });

  const inspect = async (candidate) => {
    if (candidate.domain === 'wave-detected.com') {
      return { tier: 'probable', buyerNameservers: [], discovery: {} };
    }
    return {
      tier: 'ruled-out',
      discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
    };
  };

  const summary = await runProbeWave(db, { inspect, now: '2026-08-10' });
  assert.equal(summary.probed, 2);
  assert.equal(summary.detected, 1);
  assert.equal(summary.dropped, 1);
});

test('runProbeWave overlap guard makes a concurrent second call return without probing', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'overlap.com', state: 'exited', next_probe_at: '2026-08-01' });

  let releaseInspect;
  const gate = new Promise((resolve) => { releaseInspect = resolve; });
  const inspect = async () => {
    await gate;
    return { tier: 'probable', buyerNameservers: [], discovery: {} };
  };

  const firstCall = runProbeWave(db, { inspect, now: '2026-08-10' });
  const secondCall = await runProbeWave(db, { inspect, now: '2026-08-10' });
  assert.equal(secondCall.ran, false);
  assert.equal(secondCall.reason, 'overlap');

  releaseInspect();
  const firstResult = await firstCall;
  assert.equal(firstResult.probed, 1);
});

test('runProbeWave summary carries transferScreen from an injected stub, and a throwing stub does not fail the wave', async () => {
  const db = buildDb();
  db.prepare(`INSERT INTO sale_watch_movement_imports (day, source_signature, imported_at, departures, queued, summary_json) VALUES (?,?,?,?,?,?)`)
    .run('2026-09-15', 'sig', '2026-09-15T00:00:00Z', 0, 0, '{}');
  const rulingOut = async () => ({ tier: 'ruled-out', discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] } });

  insertCandidateRow(db, { domain: 'wave-ts-a.com', state: 'exited', next_probe_at: '2026-08-01' });
  let screenCalledWithDay = null;
  const screenStub = async (dbArg, opts) => { screenCalledWithDay = opts.day; return { day: opts.day, admitted: 3 }; };
  const summary = await runProbeWave(db, { inspect: rulingOut, now: '2026-08-10', skipMovementImport: true, screenWentLiveTransfers: screenStub });
  assert.equal(screenCalledWithDay, '2026-09-15');
  assert.deepEqual(summary.transferScreen, { day: '2026-09-15', admitted: 3 });
  assert.equal(summary.probed, 1);

  insertCandidateRow(db, { domain: 'wave-ts-b.com', state: 'exited', next_probe_at: '2026-08-01' });
  const throwingStub = async () => { throw new Error('boom'); };
  const summary2 = await runProbeWave(db, { inspect: rulingOut, now: '2026-08-10', skipMovementImport: true, screenWentLiveTransfers: throwingStub });
  assert.equal(summary2.probed, 1);
  assert.equal(summary2.transferScreen, null);
});

// ── runProbeWave rdap sweep wiring ───────────────────────────────────────────

test('runProbeWave calls an injected rdapSweep stub before selectDueCandidates and records its result on summary.rdapSweep', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'rdap-wave.com', state: 'exited', next_probe_at: '2026-08-01' });
  const callLog = [];
  const rdapSweepStub = async () => {
    callLog.push('rdapSweep');
    return { checked: 1, transfers: 1 };
  };
  const selectDueSpy = (dbArg, opts) => {
    callLog.push('selectDueCandidates');
    return selectDueCandidates(dbArg, opts);
  };
  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });

  const summary = await runProbeWave(db, {
    inspect,
    now: '2026-08-10',
    skipMovementImport: true,
    rdapSweep: rdapSweepStub,
    selectDueCandidates: selectDueSpy,
  });

  assert.deepEqual(callLog, ['rdapSweep', 'selectDueCandidates']);
  assert.deepEqual(summary.rdapSweep, { checked: 1, transfers: 1 });
  assert.equal(summary.probed, 1);
});

test('runProbeWave does not fail the wave when the injected rdapSweep stub throws', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'rdap-throw.com', state: 'exited', next_probe_at: '2026-08-01' });
  const rdapSweepStub = async () => { throw new Error('rdap boom'); };
  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });

  const summary = await runProbeWave(db, {
    inspect,
    now: '2026-08-10',
    skipMovementImport: true,
    rdapSweep: rdapSweepStub,
  });

  assert.equal(summary.ran, undefined, 'the wave itself must not report a top-level failure');
  assert.equal(summary.rdapSweep, null, 'a throwing sweep leaves rdapSweep unset');
  assert.equal(summary.probed, 1);
});

test('runProbeWave skipRdapSweep true skips the sweep entirely', async () => {
  const db = buildDb();
  insertCandidateRow(db, { domain: 'rdap-skip.com', state: 'exited', next_probe_at: '2026-08-01' });
  let sweepCalled = false;
  const rdapSweepStub = async () => { sweepCalled = true; return { checked: 1 }; };
  const inspect = async () => ({
    tier: 'ruled-out',
    discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] },
  });

  const summary = await runProbeWave(db, {
    inspect,
    now: '2026-08-10',
    skipMovementImport: true,
    skipRdapSweep: true,
    rdapSweep: rdapSweepStub,
  });

  assert.equal(sweepCalled, false, 'the stub must never be invoked when skipRdapSweep is true');
  assert.equal(summary.rdapSweep, null);
  assert.equal(summary.probed, 1);
});

// ── markAdoptionKits ─────────────────────────────────────────────────────────

test('markAdoptionKits groups 4 shared-title rows into a kit, clears members that fall out, and ignores rows outside the 30-day window', () => {
  const db = buildDb();
  const sellDomains = ['sella.com', 'sellb.com', 'sellc.com', 'selld.com'];
  for (const domain of sellDomains) {
    insertCandidateRow(db, {
      domain,
      state: 'probing',
      probe_count: 1,
      exit_observed_day: '2026-09-15',
      evidence_json: JSON.stringify({ classification: 'acquisition-candidate', buyerTitle: `${domain} - Sell Direct (UK)` }),
    });
  }
  insertCandidateRow(db, {
    domain: 'faxly.com',
    state: 'probing',
    probe_count: 1,
    exit_observed_day: '2026-09-15',
    evidence_json: JSON.stringify({ classification: 'acquisition-candidate', buyerTitle: 'Faxly — Send faxes instantly online' }),
  });
  insertCandidateRow(db, {
    domain: 'hotelversilia.com',
    state: 'probing',
    probe_count: 1,
    exit_observed_day: '2026-09-15',
    evidence_json: JSON.stringify({ classification: 'acquisition-candidate', buyerTitle: 'Hotel Versilia alberghi' }),
  });
  insertCandidateRow(db, {
    domain: 'sellold.com',
    state: 'probing',
    probe_count: 1,
    exit_observed_day: '2026-08-01',
    evidence_json: JSON.stringify({ classification: 'acquisition-candidate', buyerTitle: 'sellold.com - Sell Direct (UK)' }),
  });

  const result = markAdoptionKits(db, { now: '2026-09-16T00:00:00Z' });
  assert.equal(result.kits, 1);
  assert.equal(result.members, 4);
  assert.equal(result.scanned, 6, 'the 30-day-old row is excluded from the population');

  for (const domain of sellDomains) {
    const row = db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain = ?').get(domain);
    const evidence = JSON.parse(row.evidence_json);
    assert.equal(evidence.discovery.kit.basis, 'title');
    assert.equal(evidence.discovery.kit.size, 4);
    assert.ok(evidence.discovery.kit.key.includes('sell direct'), evidence.discovery.kit.key);
    assert.equal(evidence.discovery.kit.markedAt, '2026-09-16T00:00:00.000Z');
  }

  const faxly = JSON.parse(db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain = ?').get('faxly.com').evidence_json);
  assert.equal(faxly.discovery, undefined);
  const hotel = JSON.parse(db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain = ?').get('hotelversilia.com').evidence_json);
  assert.equal(hotel.discovery, undefined);
  const old = JSON.parse(db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain = ?').get('sellold.com').evidence_json);
  assert.equal(old.discovery, undefined);

  db.prepare('DELETE FROM sale_watch_candidates WHERE domain IN (?, ?)').run('sellc.com', 'selld.com');
  const secondResult = markAdoptionKits(db, { now: '2026-09-16T00:00:00Z' });
  assert.equal(secondResult.cleared, 2);

  for (const domain of ['sella.com', 'sellb.com']) {
    const row = db.prepare('SELECT evidence_json FROM sale_watch_candidates WHERE domain = ?').get(domain);
    const evidence = JSON.parse(row.evidence_json);
    assert.equal(evidence.discovery?.kit, undefined, `${domain} kit cleared once its group falls below 3`);
  }
});

test('runProbeWave summary includes a kits field from markAdoptionKits', async () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'wave-kit-a.com', state: 'exited', next_probe_at: '2026-08-01',
    evidence_json: JSON.stringify({ classification: 'acquisition-candidate', buyerTitle: 'wave-kit-a.com - Sell Direct (UK)' }),
  });
  const inspect = async () => ({ tier: 'ruled-out', discovery: { parentDelegation: { nameservers: [] }, recursiveNameservers: [] } });
  const summary = await runProbeWave(db, { inspect, now: '2026-08-10', skipMovementImport: true });
  assert.ok('kits' in summary);
  assert.equal(summary.kits.scanned, 0, 'wave-kit-a.com was dropped before markAdoptionKits ran in this synchronous test wave');
});

// ── readReconstructionEntries / ledger merge ─────────────────────────────────

test('readReconstructionEntries maps a detected row to the ledger entry shape', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'detected-entry.com',
    state: 'detected',
    outcome: 'end-user-sale',
    outcome_tier: 'probable',
    exit_observed_day: '2026-08-01',
    first_seen_day: '2026-07-01',
    probe_count: 2,
    evidence_json: JSON.stringify({
      tier: 'probable',
      buyer: 'Acme Corp',
      buyerNameservers: ['ns1.acme.com'],
      sellerNameservers: ['ns1.godaddy.com'],
      rationale: 'strong buyer signal',
      discovery: { parkingInfrastructure: false },
    }),
    updated_at: '2026-08-15T00:00:00Z',
  });

  const entries = readReconstructionEntries(db);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.domain, 'detected-entry.com');
  assert.equal(entry.tier, 'probable');
  assert.equal(entry.buyer, 'Acme Corp');
  assert.deepEqual(entry.buyerNameservers, ['ns1.acme.com']);
  assert.equal(entry.observationStatus, 'reconstruction');
  assert.equal(entry.observationCount, 2);
  assert.equal(entry.firstObservedAt, '2026-07-01');
  assert.equal(entry.lastObservedAt, '2026-08-15T00:00:00Z');
});

test('readReconstructionEntries flows through the real readSaleWatchLedger third-source parameter: merged, recency-sorted, curated row wins domain conflict', () => {
  const db = buildDb();
  insertCandidateRow(db, {
    domain: 'conflict.com',
    state: 'detected',
    outcome: 'end-user-sale',
    outcome_tier: 'suspected',
    exit_observed_day: '2026-06-01',
    updated_at: '2026-06-01T00:00:00Z',
    evidence_json: JSON.stringify({ tier: 'suspected', buyer: 'Reconstruction Buyer', reportDate: '2026-06-01' }),
  });
  insertCandidateRow(db, {
    domain: 'recon-only.com',
    state: 'detected',
    outcome: 'end-user-sale',
    outcome_tier: 'probable',
    exit_observed_day: '2026-08-20',
    updated_at: '2026-08-20T00:00:00Z',
    evidence_json: JSON.stringify({ tier: 'probable', buyer: 'Recon Only Buyer', reportDate: '2026-08-20' }),
  });

  const reconstructionEntries = readReconstructionEntries(db);

  const dir = mkTmpDir();
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    generatedAt: '2026-08-25T00:00:00Z',
    entries: [
      {
        domain: 'conflict.com',
        tier: 'verified',
        buyer: 'Curated Buyer',
        sourceUrl: 'https://reports.example/transaction',
        reportDate: '2026-08-25',
      },
    ],
  }));
  const discoveryPath = path.join(dir, 'missing-discovery.json');

  const ledger = readSaleWatchLedger(ledgerPath, discoveryPath, reconstructionEntries);

  assert.equal(ledger.entries.length, 2);
  const conflictEntry = ledger.entries.find(e => e.domain === 'conflict.com');
  assert.equal(conflictEntry.buyer, 'Curated Buyer', 'curated ledger row wins the conflict');
  assert.equal(conflictEntry.tier, 'verified');

  const domains = ledger.entries.map(e => e.domain);
  assert.deepEqual(domains, ['conflict.com', 'recon-only.com'], 'recency-sorted descending by reportDate');
});

// ── persistUniverseDay zoneNsHits (bounded SQLite union) ─────────────────────

test('persistUniverseDay with zoneNsHits unions provider domains and SQLite zone hits, sorted/deduped, counts correct, temp table dropped', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const { ensureZoneNsUniverseSchema } = require('../server/zone-ns-universe');
  ensureZoneNsUniverseSchema(db);
  const day = '2026-08-31';
  const insertHit = db.prepare('INSERT INTO zone_ns_universe_hits (day, domain, provider) VALUES (?, ?, ?)');
  insertHit.run(day, 'zoneonly.com', 'Sedo');
  insertHit.run(day, 'shared.com', 'Sedo');
  insertHit.run(day, 'anotherzone.com', 'Bodis');

  const enumerate = () => fixtureBatches([
    [{ domain: 'provideronly.com' }, { domain: 'shared.com' }],
  ]);

  const result = await persistUniverseDay(db, { day, enumerate, dir, zoneNsHits: { database: db, day } });

  assert.equal(result.providerCount, 2);
  assert.equal(result.zoneCount, 3);
  assert.equal(result.count, 4);

  const filePath = dayFilePath(dir, day);
  const raw = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['anotherzone.com', 'provideronly.com', 'shared.com', 'zoneonly.com']);

  const sources = db.prepare('SELECT source, count FROM sale_watch_universe_sources WHERE day = ? ORDER BY source').all(day);
  assert.deepEqual(sources, [
    { source: 'provider-scan', count: 2 },
    { source: 'zone-ns', count: 3 },
  ]);

  const tempTables = db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all();
  assert.equal(tempTables.length, 0, 'temp table dropped after persist');
});

test('persistUniverseDay without zoneNsHits or zoneNsUniverse remains provider-only (unchanged behavior)', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const day = '2026-08-31';
  const enumerate = () => fixtureBatches([[{ domain: 'b.com' }, { domain: 'a.com' }]]);
  const result = await persistUniverseDay(db, { day, enumerate, dir });
  assert.equal(result.count, 2);
  assert.equal(result.zoneCount, 0);
  const sourcesCount = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_universe_sources WHERE day = ?').get(day).n;
  assert.equal(sourcesCount, 0, 'no source rows written when neither zone path used');
});

// ── runDailyUniversePass zone ns worker wiring ────────────────────────────────

test('runDailyUniversePass does not spawn the zone ns universe worker when DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED is unset', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const originalEnv = process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED;
  delete process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED;
  let spawnCalled = false;
  try {
    const result = await runDailyUniversePass(db, {
      today: '2026-08-30',
      dir,
      enumerate: () => fixtureBatches([[{ domain: 'a.com' }]]),
      spawn: () => { spawnCalled = true; throw new Error('spawn must not be called'); },
    });
    assert.equal(result.ran, true);
    assert.equal(spawnCalled, false, 'child worker must not be spawned when opt-in env is unset');
    assert.equal(result.persisted.zoneCount, 0);
    const sourcesCount = db.prepare('SELECT COUNT(*) AS n FROM sale_watch_universe_sources WHERE day = ?').get('2026-08-30').n;
    assert.equal(sourcesCount, 0);
  } finally {
    if (originalEnv === undefined) delete process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED;
    else process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED = originalEnv;
  }
});

test('runDailyUniversePass spawns the zone ns universe worker and unions its SQLite hits when DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED=1', async () => {
  const db = buildDb();
  const dir = mkTmpDir();
  const { ensureZoneNsUniverseSchema } = require('../server/zone-ns-universe');
  ensureZoneNsUniverseSchema(db);
  const day = '2026-08-30';
  db.prepare('INSERT INTO zone_ns_universe_hits (day, domain, provider) VALUES (?, ?, ?)').run(day, 'zonehit.com', 'Sedo');

  const originalEnv = process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED;
  process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED = '1';
  let spawnCalled = false;
  const { EventEmitter } = require('node:events');
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  const spawnStub = () => {
    spawnCalled = true;
    process.nextTick(() => {
      fakeChild.stdout.emit('data', Buffer.from(JSON.stringify({ ran: true, day, hits: 1 }) + '\n'));
      fakeChild.emit('exit', 0);
    });
    return fakeChild;
  };

  try {
    const result = await runDailyUniversePass(db, {
      today: day,
      dir,
      enumerate: () => fixtureBatches([[{ domain: 'provider.com' }]]),
      spawn: spawnStub,
    });
    assert.equal(spawnCalled, true, 'worker must be spawned when opt-in env is 1');
    assert.equal(result.ran, true);
    assert.equal(result.persisted.zoneCount, 1);
    assert.equal(result.persisted.count, 2);
  } finally {
    if (originalEnv === undefined) delete process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED;
    else process.env.DOMAINSCOUT_ZONE_NS_UNIVERSE_ENABLED = originalEnv;
  }
});

test('daily zone departures are durably queued with original seller DNS and idempotent import receipts', async()=>{
 const {ingestMovementCandidates,reconstructionCoverage}=require('../server/sale-watch-reconstruction');const db=buildDb();const dir=mkTmpDir(),day='2026-09-05',folder=path.join(dir,day,'ns');fs.mkdirSync(folder,{recursive:true});const row={domain:'coppercove.com',selection:'departures',prev_class:'seller',today_class:'hosting',prev_provider:'Dan',prev_ns:['ns1.dan.com','ns2.dan.com'],today_ns:['new.ns.example'],probe:{state:'built'}};fs.writeFileSync(path.join(folder,'summary.json'),JSON.stringify({day,prevDay:'2026-09-04',zones:1071,departures:1}));fs.writeFileSync(path.join(folder,'movement.jsonl'),JSON.stringify(row)+'\n');
 assert.equal((await ingestMovementCandidates(db,{directory:dir})).queued,1);assert.equal((await ingestMovementCandidates(db,{directory:dir})).queued,0);
 const queued=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(row.domain);const origin=JSON.parse(queued.evidence_json);assert.deepEqual(origin.sellerNameservers,row.prev_ns);assert.equal(origin.discovery.movement.cohortSize,1);assert.equal(reconstructionCoverage(db).movement.zones,1071);const early = readReconstructionEntries(db);assert.equal(early.length,1);assert.equal(require('../server/sale-watch-evidence').assessSaleEntry(early[0]).classification,'unconfirmed-move','dated departures surface as leads without claiming a sale');
 let received;await probeCandidate(db,queued,{now:'2026-09-05T12:00:00Z',inspect:async(candidate)=>{received=candidate;return {tier:'transfer',buyerNameservers:row.today_ns,discovery:{rdap:{statuses:['pending transfer']}}}}});assert.deepEqual(received.sellerNameservers,row.prev_ns);const after=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(row.domain);assert.equal(after.state,'transferring');assert.equal(after.next_probe_at,'2026-09-05T18:00:00.000Z');assert.equal(readReconstructionEntries(db)[0].reconstruction.observations.length,2);
 fs.rmSync(dir,{recursive:true});db.close();
});

test('reconstruction follows pending transfer through later use change and excludes owner lander regression',async()=>{
 const db=buildDb();let row=insertCandidateRow(db,{domain:'coppercove.com',last_stream:'zone-seller-departure',evidence_json:JSON.stringify({sellerNameservers:['ns1.dan.com'],venue:'Dan',discovery:{movement:{day:'2026-09-05',prevDay:'2026-09-04',previousNameservers:['ns1.dan.com'],sourceUrl:'/api/universe/ns-movement'}}})});
 await probeCandidate(db,row,{now:'2026-09-05T10:00:00Z',inspect:async()=>({tier:'transfer',buyerNameservers:['new.ns.example'],discovery:{rdap:{registrar:'Before',registrarId:'1',statuses:['pending transfer']}}})});
 row=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(row.domain);let prior;
 await probeCandidate(db,row,{now:'2026-09-06T10:00:00Z',inspect:async(c,options)=>{prior=options.previous;return {tier:'probable',classification:'likely-sale',buyerNameservers:['new.ns.example'],discovery:{rdap:{registrar:'After',registrarId:'2',statuses:['active']},homepage:{title:'Copper Cove business',active:true}}};}});assert.equal(prior.discovery.rdap.registrarId,'1');
 row=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(row.domain);assert.ok(row.next_probe_at);assert.equal(row.outcome,'likely-sale');
 await probeCandidate(db,row,{now:'2026-09-07T10:00:00Z',inspect:async()=>({tier:'excluded',classification:'lander-migration',buyerNameservers:['new.ns.example'],discovery:{homepage:{parked:true,finalUrl:'https://ivylake.com/domains/coppercove-com'}}})});row=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(row.domain);assert.equal(row.state,'parked-watch');const history=readReconstructionEntries(db)[0].reconstruction.observations;assert.equal(history.length,3);assert.equal(history[0].rdap.registrar,'Before');assert.equal(history[2].classification,'lander-migration');db.close();
});

test('existing unreported discoveries enter durable follow-up once with their prior registrar observation',()=>{
 const {ingestDiscoveryCandidates}=require('../server/sale-watch-reconstruction');const db=buildDb(),dir=mkTmpDir(),file=path.join(dir,'discovery.json');
 const entry={domain:'retained.example',reportDate:'2026-09-01',lastObservedAt:'2026-09-02T00:00:00Z',sellerNameservers:['ns1.dan.com'],discovery:{rdap:{registrarId:'100',statuses:['pending transfer']}}};
 fs.writeFileSync(file,JSON.stringify({entries:[entry,{domain:'reported.example',sourceUrl:'https://reports.example'}]}));
 assert.equal(ingestDiscoveryCandidates(db,{file}).queued,1);assert.equal(ingestDiscoveryCandidates(db,{file}).queued,0);
 const row=db.prepare('SELECT * FROM sale_watch_candidates').get();assert.equal(row.state,'transferring');assert.ok(row.next_probe_at);assert.ok(readReconstructionEntries(db).find(e=>e.domain===entry.domain)?.reconstruction.nextProbeAt);assert.equal(JSON.parse(row.evidence_json).discovery.rdap.registrarId,'100');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_observations').get().n,1);db.close();fs.rmSync(dir,{recursive:true});
});

 test('reconstruction pages reach beyond 1000 in departure chronology, without evidence-tier starvation', () => {
  const db = buildDb();
  db.transaction(() => {
    for (let i = 0; i < 1005; i++) insertCandidateRow(db, {
      domain: `lead-${String(i).padStart(4,'0')}.com`, state: 'probing', probe_count: 1,
      exit_observed_day: '2026-09-10', evidence_json: JSON.stringify({tier:'suspected'}),
    });
    insertCandidateRow(db, {domain:'old-transfer.com', state:'transferring', exit_observed_day:'2026-09-01', evidence_json:'{"tier":"transfer"}'});
  })();
  const first = readReconstructionEntries(db);
  const second = readReconstructionEntries(db, {offset:1000});
  assert.equal(first.length,1000);
  assert.equal(second.length,6);
  assert.equal(second.at(-1).domain,'old-transfer.com');
  assert.equal(new Set([...first,...second].map(r=>r.domain)).size,1006);
  assert.deepEqual(readReconstructionEntries(db,{q:'lead-1004'}).map(r=>r.domain),['lead-1004.com']);
  db.close();
});

test('movement admission preserves raw totals but excludes zero-weight suffixes before queueing', async () => {
  const { ingestMovementCandidates, reconstructionCoverage } = require('../server/sale-watch-reconstruction');
  const db = buildDb(), directory = mkTmpDir(), day = '2026-09-15';
  const folder = path.join(directory, day, 'ns');
  fs.mkdirSync(folder, { recursive: true });
  const domains = ['agent.xyz', 'garden.shop', 'copper.info', 'orchard.com', 'harbor.net'];
  const tape = domains.map(domain => JSON.stringify({ domain, selection: 'departures', prev_class: 'seller', today_class: 'hosting', prev_ns: ['ns1.dan.com'], today_ns: ['ns1.example.net'] })).join('\n') + '\n';
  fs.writeFileSync(path.join(folder, 'movement.jsonl'), tape);
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ day, prevDay: '2026-09-11', zones: 1071, departures: 5 }));
  assert.equal((await ingestMovementCandidates(db, { directory })).queued, 2);
  assert.deepEqual(readReconstructionEntries(db).map(row => row.domain), ['harbor.net', 'orchard.com']);
  const coverage = reconstructionCoverage(db).movement;
  assert.equal(coverage.departures, 5);
  assert.equal(coverage.excludedByPolicy, 3);
  assert.equal(coverage.queued, 2);
  assert.equal(fs.readFileSync(path.join(folder, 'movement.jsonl'), 'utf8'), tape);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('legacy zero-weight candidates cannot consume reading or probe limits and retain their evidence', () => {
  const db = buildDb();
  for (const domain of ['aaa.xyz', 'aab.shop', 'aac.info', 'orchard.com', 'river.net']) {
    insertCandidateRow(db, { domain, last_stream: 'zone-seller-departure', evidence_json: JSON.stringify({ tier: 'suspected', reportDate: '2026-09-15' }) });
  }
  // Both rows tie on date and evidence rank (no classification -> rank 7);
  // the shorter label (river.net, 9 chars) now sorts first under the
  // length(domain) ASC tiebreak added for the alpha view's ORDER BY.
  assert.deepEqual(readReconstructionEntries(db, { limit: 1 }).map(row => row.domain), ['river.net']);
  assert.deepEqual(readReconstructionEntries(db, { limit: 1, offset: 1 }).map(row => row.domain), ['orchard.com']);
  assert.deepEqual(selectDueCandidates(db, { now: '2026-09-16', limit: 2 }).map(row => row.domain).sort(), ['orchard.com', 'river.net']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n, 5);
  const coverage = require('../server/sale-watch-reconstruction').reconstructionCoverage(db);
  assert.equal(coverage.following, 2, 'queue total is independent of the requested page limit and excludes zero-weight suffixes');
  assert.equal(coverage.due, 2);
  db.close();
});

test('retained discovery cannot re-admit excluded suffix signals into the working ledger', () => {
  const dir = mkTmpDir(), seed = path.join(dir, 'seed.json'), discovery = path.join(dir, 'discovery.json');
  fs.writeFileSync(seed, JSON.stringify({ entries: [] }));
  const entries = ['orchard.com', 'orchard.xyz', 'river.shop', 'copper.info'].map(domain => ({ domain, tier: 'suspected', reportDate: '2026-09-15', sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.host.example'], discovery: { structurallyMoved: true, departureDate: '2026-09-15' } }));
  const raw = JSON.stringify({ entries }); fs.writeFileSync(discovery, raw);
  const ledger = readSaleWatchLedger(seed, discovery);
  assert.deepEqual(ledger.entries.map(row => row.domain), ['orchard.com']);
  assert.equal(ledger.excludedEntries.length, 3);
  assert.ok(ledger.excludedEntries.every(row => row.classification === 'policy-excluded' && row.sellerNameservers[0] === 'ns1.dan.com'));
  assert.equal(fs.readFileSync(discovery, 'utf8'), raw);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a newer movement supersedes old verdicts and retained discovery without erasing follow-up on replay', async () => {
  const { ingestMovementCandidates } = require('../server/sale-watch-reconstruction');
  const db=buildDb(), directory=mkTmpDir(), day='2026-09-15', domain='orchard.com';
  const folder=path.join(directory,day,'ns'); fs.mkdirSync(folder,{recursive:true});
  const old={domain,tier:'transfer',reportDate:'2026-09-11',lastObservedAt:'2026-09-14T00:00:00Z',discovery:{rdap:{statuses:['pending transfer']}}};
  insertCandidateRow(db,{domain,state:'transferring',outcome:'transfer',outcome_tier:'transfer',exit_observed_day:'2026-09-11',updated_at:old.lastObservedAt,evidence_json:JSON.stringify(old)});
  fs.writeFileSync(path.join(folder,'summary.json'),JSON.stringify({day,prevDay:'2026-09-11',zones:1071,departures:1}));
  const tape=path.join(folder,'movement.jsonl');
  fs.writeFileSync(tape,JSON.stringify({domain,selection:'departures',prev_class:'seller',today_class:'hosting',prev_ns:['ns1.dan.com'],today_ns:['ns1.example.net']})+'\n');
  await ingestMovementCandidates(db,{directory});
  const row=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(domain);
  assert.equal(row.state,'exited'); assert.equal(row.outcome_tier,null); assert.equal(row.outcome,null);
  assert.ok(row.updated_at>old.lastObservedAt);
  const seed=path.join(directory,'seed.json'),discovery=path.join(directory,'discovery.json');
  fs.writeFileSync(seed,JSON.stringify({entries:[]})); fs.writeFileSync(discovery,JSON.stringify({entries:[old]}));
  const entry=readSaleWatchLedger(seed,discovery,readReconstructionEntries(db)).entries[0];
  assert.equal(entry.reportDate,day); assert.ok(['seller-departure','unconfirmed-move'].includes(entry.classification));
  db.prepare("UPDATE sale_watch_candidates SET state='probing',outcome_tier='suspected',updated_at='2026-09-16T23:00:00Z' WHERE domain=?").run(domain);
  fs.appendFileSync(tape,'\n'); await ingestMovementCandidates(db,{directory});
  const replay=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(domain);
  assert.equal(replay.state,'probing'); assert.equal(replay.outcome_tier,'suspected'); assert.equal(replay.updated_at,'2026-09-16T23:00:00Z');
  db.close(); fs.rmSync(directory,{recursive:true,force:true});
});

test('lead admission happens before pagination and probing prioritizes evidence without starving noise',()=>{
 const db=buildDb(),stamp=new Date().toISOString(),day=stamp.slice(0,10);
 for(let i=0;i<30;i++) {
  const domain=`a${String(i).padStart(2,'0')}.com`;
  insertCandidateRow(db,{domain,last_stream:'zone-seller-departure',updated_at:stamp,evidence_json:JSON.stringify({domain,reportDate:day,sellerNameservers:['ns1.dan.com'],buyerNameservers:['expired1.namebrightdns.com'],discovery:{structurallyMoved:true}})});
 }
 for(let i=0;i<10;i++) {
  const domain=`z${i}.com`;
  insertCandidateRow(db,{domain,last_stream:'zone-seller-departure',updated_at:stamp,evidence_json:JSON.stringify({domain,reportDate:day,sellerNameservers:['ns1.dan.com'],buyerNameservers:['custom.host.example'],discovery:{structurallyMoved:true,departureDate:day}})});
 }
 assert.deepEqual(readReconstructionEntries(db,{view:'leads',limit:2}).map(e=>e.domain),['z0.com','z1.com']);
 assert.deepEqual(readReconstructionEntries(db,{view:'leads',after:{date:day,rank:7,domain:'z1.com'},limit:2}).map(e=>e.domain),['z2.com','z3.com']);
 const due=selectDueCandidates(db,{limit:10});assert.equal(due.filter(e=>e.domain.startsWith('z')).length,9);assert.equal(due.at(-1).domain,'a00.com');
 assert.equal(db.prepare('SELECT count(*) AS n FROM sale_watch_candidates').get().n,40);
 db.close();
});

test('shared read worker serves adjudicated Sale Watch pages from a read-only evidence database',async()=>{
 const {Worker}=require('node:worker_threads');
 const dir=mkTmpDir(),file=path.join(dir,'sale_watch.db'),db=new Database(file);
 ensureReconstructionSchema(db);const now=new Date().toISOString();
 insertCandidateRow(db,{domain:'orchard.com',last_stream:'zone-seller-departure',updated_at:now,evidence_json:JSON.stringify({domain:'orchard.com',reportDate:now.slice(0,10),sellerNameservers:['ns1.dan.com'],buyerNameservers:['independent.host.example'],discovery:{structurallyMoved:true}})});db.close();
 const worker=new Worker(path.join(__dirname,'../server/db-read-worker.js'),{workerData:{dbPath:file}});
 try {
  const message=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.postMessage({id:1,operation:'sale-watch.entries',params:{view:'leads',limit:1}});});
  assert.equal(message.ok,true, message.error);assert.equal(message.rows[0].domain,'orchard.com');
 }finally{await worker.terminate();fs.rmSync(dir,{recursive:true,force:true});}
});

test('indexed stronger-evidence page retains each transfer representation and operating adoption',()=>{
 const db=buildDb(),stamp=new Date().toISOString(),day=stamp.slice(0,10);
 const evidence=[{rdap:{statuses:['pending transfer']}},{rdap:{events:[{eventAction:'transfer',eventDate:day}]}},{transferEvidence:{registrarChanged:true,observedAt:stamp}},{buyerUse:true,homepage:{title:'Coppercove — team planning',finalUrl:'https://coppercove.com',status:200}}];
 evidence.forEach((d,i)=>{const domain=i===3?'coppercove.com':`test${i}.com`;insertCandidateRow(db,{domain,last_stream:'zone-seller-departure',updated_at:stamp,evidence_json:JSON.stringify({domain,reportDate:day,sellerNameservers:['ns1.dan.com'],buyerNameservers:['independent.host.example'],discovery:{...d,structurallyMoved:true,departureDate:day}})});});
 assert.equal(readReconstructionEntries(db,{view:'focus'}).length,4);
 const indexes=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sale_watch_%departure_v2'").all();assert.equal(indexes.length,2);
 db.close();
});

// ── ingestMovementCandidates follow-up hop (non-departure rows) ─────────────

test('ingestMovementCandidates follow-up hop: registrar->hosting went-live updates live candidates, skips unknown domain, does not revive dropped, keeps detected due', async () => {
 const { ingestMovementCandidates } = require('../server/sale-watch-reconstruction');
 const db = buildDb();
 const dir = mkTmpDir(), day = '2026-09-16', folder = path.join(dir, day, 'ns');
 fs.mkdirSync(folder, { recursive: true });
 const hostingNs = ['ns1.hostingco.com', 'ns2.hostingco.com'];
 insertCandidateRow(db, { domain: 'probing-buyer.com', state: 'probing', next_probe_at: '2026-10-16', exit_observed_day: '2026-08-01', evidence_json: JSON.stringify({ sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.domaincontrol.com'], reportDate: '2026-08-01', discovery: { movement: { day: '2026-08-01' } } }) });
 insertCandidateRow(db, { domain: 'dropped-buyer.com', state: 'dropped', next_probe_at: null, evidence_json: JSON.stringify({ sellerNameservers: ['ns1.dan.com'] }) });
 insertCandidateRow(db, { domain: 'detected-buyer.com', state: 'detected', next_probe_at: '2026-10-16', evidence_json: JSON.stringify({ sellerNameservers: ['ns1.dan.com'], buyerNameservers: ['ns1.domaincontrol.com'] }) });
 const rows = ['probing-buyer.com', 'dropped-buyer.com', 'detected-buyer.com', 'unknown-buyer.com'].map(domain => JSON.stringify({ domain, selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', prev_ns: ['ns1.domaincontrol.com'], today_ns: hostingNs, prev_provider: 'GoDaddy', today_provider: 'HostingCo' })).join('\n') + '\n';
 fs.writeFileSync(path.join(folder, 'movement.jsonl'), rows);
 fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ day, prevDay: '2026-09-15', zones: 1, departures: 0 }));

 const result = await ingestMovementCandidates(db, { directory: dir });
 assert.equal(result.followUps, 2, 'only the two live-state candidates are followed up');

 const unknown = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('unknown-buyer.com');
 assert.equal(unknown, undefined, 'unknown domain inserts nothing');

 const probing = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('probing-buyer.com');
 assert.equal(probing.state, 'exited');
 assert.equal(probing.next_probe_at, day);
 const pe = JSON.parse(probing.evidence_json);
 assert.deepEqual(pe.buyerNameservers, hostingNs);
 assert.equal(pe.discovery.followUpMovement, true);
 assert.equal(pe.discovery.movement.hop, 'follow-up');
 assert.equal(pe.discovery.movement.cohortSize, 4);
 assert.equal(pe.sellerNameservers[0], 'ns1.dan.com', 'sellerNameservers untouched');
 assert.equal(pe.reportDate, '2026-08-01', 'reportDate untouched');

 const dropped = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('dropped-buyer.com');
 assert.equal(dropped.state, 'dropped', 'dropped candidate not revived');

 const detected = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('detected-buyer.com');
 assert.equal(detected.state, 'detected', 'detected state left alone');
 assert.equal(detected.next_probe_at, day, 'but becomes due');

 const obsCount = db.prepare("SELECT COUNT(*) AS n FROM sale_watch_observations WHERE domain=? AND kind='movement'").get('probing-buyer.com').n;
 assert.equal(obsCount, 1);

 db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('selectDueCandidates ranks a followed-up small-cohort hosting move ahead of an older large-cohort bulk row', () => {
 const db = buildDb();
 insertCandidateRow(db, {
 domain: 'followed-up.com', state: 'exited', next_probe_at: '2026-09-16', exit_observed_day: '2026-09-16',
 evidence_json: JSON.stringify({ discovery: { movement: { cohortSize: 4, currentClass: 'hosting', hop: 'follow-up' }, followUpMovement: true } }),
 });
 insertCandidateRow(db, {
 domain: 'bulk-old.com', state: 'exited', next_probe_at: '2026-08-01', exit_observed_day: '2026-08-01',
 evidence_json: JSON.stringify({ discovery: { movement: { cohortSize: 500, currentClass: 'hosting' } } }),
 });
 const due = selectDueCandidates(db, { now: '2026-09-16T12:00:00Z', limit: 2 }).map(r => r.domain);
 assert.deepEqual(due, ['followed-up.com', 'bulk-old.com']);
 db.close();
});

test('reassessStoredEvidence rescores stale-version rows to the current adjudicator; leaves curated/too-old rows untouched; ensureAssessmentVersion converges', () => {
  const { assessSaleEntry, VERSION } = require('../server/sale-watch-evidence');
  const db = buildDb();
  const now = new Date('2026-09-16T00:00:00Z');

  function expectedMapping(assessed, priorState) {
    const LEAVE = new Set(['expiration', 'registry-hold', 'lander-migration', 'portfolio-kit']);
    if (LEAVE.has(assessed.classification)) return { outcome: assessed.classification, outcomeTier: null, state: priorState };
    if (assessed.tier === 'probable') return { outcome: 'likely-sale', outcomeTier: 'probable', state: 'detected' };
    if (assessed.tier === 'transfer') return { outcome: 'registrar-transfer', outcomeTier: 'transfer', state: 'transferring' };
    if (assessed.tier === 'suspected') return { outcome: 'unconfirmed-move', outcomeTier: 'suspected', state: (priorState === 'exited' || priorState === 'parked-watch') ? priorState : 'probing' };
    return { outcome: assessed.classification || null, outcomeTier: null, state: priorState };
  }

  const evTransfer = {
    domain: 'mkt-transfer.com',
    sellerNameservers: ['ns1.dan.com'],
    buyerNameservers: ['ns1.bodis.com'],
    reportDate: '2026-09-01',
    lastObservedAt: '2026-09-15T00:00:00Z',
    discovery: {
      structurallyMoved: true,
      departureDate: '2026-09-01',
      rdap: { pendingTransfer: false, transferAt: '2026-09-01', registrar: 'NewRegistrar', checkedAt: '2026-09-15T00:00:00Z' },
      homepage: { title: 'Domain For Sale', finalUrl: 'https://ns1.bodis.com/', status: 200 },
    },
    assessment: { version: 'sale-evidence-v0' },
  };

  const evBuilt = {
    domain: 'built-op.com',
    sellerNameservers: ['ns1.dan.com'],
    buyerNameservers: ['ns1.hosted-example.net'],
    reportDate: '2026-09-01',
    lastObservedAt: '2026-09-15T00:00:00Z',
    discovery: {
      structurallyMoved: true,
      departureDate: '2026-09-01',
      buyerUse: true,
      rdap: { registrar: 'NewRegistrar', registrarId: '99', checkedAt: '2026-09-15T00:00:00Z' },
      homepage: { title: 'Built Op Company', finalUrl: 'https://built-op.com/', status: 200 },
    },
    assessment: { version: 'sale-evidence-v0' },
  };

  const evExpired = {
    domain: 'expired-row.com',
    sellerNameservers: ['ns1.dan.com'],
    buyerNameservers: ['expired1.namebrightdns.com'],
    reportDate: '2026-09-01',
    lastObservedAt: '2026-09-15T00:00:00Z',
    discovery: { structurallyMoved: true, departureDate: '2026-09-01' },
    assessment: { version: 'sale-evidence-v0' },
  };

  const evCurated = {
    domain: 'curated.com',
    tier: 'probable',
    buyer: 'Curated Buyer',
    reportDate: '2026-09-10',
    assessment: { version: 'sale-evidence-v0' },
  };

  const evOld = {
    domain: 'old.com',
    sellerNameservers: ['ns1.dan.com'],
    buyerNameservers: ['ns1.bodis.com'],
    reportDate: '2026-06-01',
    lastObservedAt: '2026-06-01T00:00:00Z',
    discovery: { structurallyMoved: true, departureDate: '2026-06-01' },
    assessment: { version: 'sale-evidence-v0' },
  };

  insertCandidateRow(db, { domain: evTransfer.domain, state: 'exited', exit_observed_day: '2026-09-01', evidence_json: JSON.stringify(evTransfer), updated_at: '2026-09-15T00:00:00Z' });
  insertCandidateRow(db, { domain: evBuilt.domain, state: 'exited', exit_observed_day: '2026-09-01', evidence_json: JSON.stringify(evBuilt), updated_at: '2026-09-15T00:00:00Z' });
  insertCandidateRow(db, { domain: evExpired.domain, state: 'exited', exit_observed_day: '2026-09-01', evidence_json: JSON.stringify(evExpired), updated_at: '2026-09-15T00:00:00Z' });
  insertCandidateRow(db, { domain: evCurated.domain, state: 'detected', outcome: 'end-user-sale', outcome_tier: 'probable', exit_observed_day: '2026-09-10', evidence_json: JSON.stringify(evCurated), updated_at: '2026-09-10T00:00:00Z' });
  insertCandidateRow(db, { domain: evOld.domain, state: 'exited', exit_observed_day: '2026-06-01', evidence_json: JSON.stringify(evOld), updated_at: '2026-06-01T00:00:00Z' });

  const result = reassessStoredEvidence(db, { sinceDays: 30, now });
  assert.equal(result.scanned, 4, 'the too-old row falls outside sinceDays and is excluded by the SQL filter');
  assert.equal(result.rewritten, 3, 'the curated row has no discovery object and is skipped');

  const expectTransfer = assessSaleEntry({ ...evTransfer }, { now });
  const rowTransfer = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(evTransfer.domain);
  const storedTransfer = JSON.parse(rowTransfer.evidence_json);
  assert.equal(storedTransfer.assessment.version, VERSION);
  assert.equal(storedTransfer.classification, expectTransfer.classification);
  assert.equal(storedTransfer.tier, expectTransfer.tier);
  const mapTransfer = expectedMapping(expectTransfer, 'exited');
  assert.equal(rowTransfer.outcome, mapTransfer.outcome);
  assert.equal(rowTransfer.outcome_tier, mapTransfer.outcomeTier);
  assert.equal(rowTransfer.state, mapTransfer.state);

  const expectBuilt = assessSaleEntry({ ...evBuilt }, { now });
  const rowBuilt = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(evBuilt.domain);
  const storedBuilt = JSON.parse(rowBuilt.evidence_json);
  assert.equal(storedBuilt.assessment.version, VERSION);
  assert.equal(storedBuilt.classification, expectBuilt.classification);
  assert.equal(storedBuilt.tier, expectBuilt.tier);
  const mapBuilt = expectedMapping(expectBuilt, 'exited');
  assert.equal(rowBuilt.outcome, mapBuilt.outcome);
  assert.equal(rowBuilt.outcome_tier, mapBuilt.outcomeTier);
  assert.equal(rowBuilt.state, mapBuilt.state);

  const rowExpired = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(evExpired.domain);
  const storedExpired = JSON.parse(rowExpired.evidence_json);
  assert.equal(storedExpired.assessment.version, VERSION);
  assert.equal(rowExpired.outcome, 'expiration');
  assert.equal(rowExpired.outcome_tier, null);
  assert.equal(rowExpired.state, 'exited', 'state is left as-is for excluded classifications');

  const rowCurated = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(evCurated.domain);
  assert.equal(JSON.parse(rowCurated.evidence_json).assessment.version, 'sale-evidence-v0', 'curated row without discovery is untouched');
  assert.equal(rowCurated.outcome, 'end-user-sale');
  assert.equal(rowCurated.state, 'detected');

  const rowOld = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(evOld.domain);
  assert.equal(JSON.parse(rowOld.evidence_json).assessment.version, 'sale-evidence-v0', 'row older than sinceDays is not scanned');

  const second = reassessStoredEvidence(db, { sinceDays: 30, now });
  assert.equal(second.rewritten, 0, 'a second call rewrites 0 rows');

  const versionResult = ensureAssessmentVersion(db);
  assert.equal(versionResult.ran, true);
  assert.equal(versionResult.version, VERSION);
  const noop = ensureAssessmentVersion(db);
  assert.equal(noop.ran, false);
  const meta = db.prepare("SELECT value FROM sale_watch_meta WHERE key='assessment_version'").get();
  assert.equal(meta.value, VERSION);

  db.close();
});

test('alpha view: buyer-built alpha rows only, rank order, cursor round-trips',()=>{
 const db=buildDb(),day='2026-09-15',now=new Date(day+'T13:00:00Z');
  const base=domain=>({domain,tier:'probable',classification:'acquisition-candidate',reportDate:day,lastObservedAt:day+'T12:00:00Z',sellerNameservers:['ns1.dan.com'],buyerUrl:'https://'+domain,discovery:{structurallyMoved:true,buyerUse:true,departureDate:day,homepage:{active:true,status:200,title:domain.split('.')[0]+' team',finalUrl:'https://'+domain},rdap:{lastChangedAt:day+'T00:00:00Z',statuses:['client transfer prohibited'],checkedAt:day+'T12:00:00Z'}}});
 for(const d of ['workbench.com','faxly.com','orchard.com']) insertCandidateRow(db,{domain:d,last_stream:'zone-seller-departure',updated_at:day+'T12:00:00Z',evidence_json:JSON.stringify(base(d))});
 insertCandidateRow(db,{domain:'zqxjklw.com',last_stream:'zone-seller-departure',updated_at:day+'T12:00:00Z',evidence_json:JSON.stringify(base('zqxjklw.com'))});
 const kit=base('kitmember.com');kit.discovery.kit={size:3};
 insertCandidateRow(db,{domain:'kitmember.com',last_stream:'zone-seller-departure',updated_at:day+'T12:00:00Z',evidence_json:JSON.stringify(kit)});
 const good=['faxly.com','orchard.com','workbench.com'];
 assert.deepEqual(readReconstructionEntries(db,{view:'alpha',limit:5000,now}).map(r=>r.domain),good);
 assert.deepEqual(readReconstructionEntries(db,{view:'alpha',limit:1,now}).map(r=>r.domain),['faxly.com']);
 assert.deepEqual(readReconstructionEntries(db,{view:'alpha',limit:1,now,after:{date:day,rank:2,domain:'faxly.com'}}).map(r=>r.domain),['orchard.com']);
 assert.deepEqual(readReconstructionEntries(db,{view:'alpha',limit:1,now,after:{date:day,rank:2,domain:'orchard.com'}}).map(r=>r.domain),['workbench.com']);
 db.close();
});

test('ingestMovementCandidates day-refinement: a same-day daily tape rewrites a multi-day-window departure to its true day, a later day still supersedes, and an unrelated row outside the window is not refined', async () => {
  const { ingestMovementCandidates } = require('../server/sale-watch-reconstruction');
  const db = buildDb();
  const dir = mkTmpDir();

  const writeTape = (day, prevDay, rows) => {
    const folder = path.join(dir, day, 'ns');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ day, prevDay, zones: 1, departures: rows.length }));
    fs.writeFileSync(path.join(folder, 'movement.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  const departureRow = domain => ({ domain, selection: 'departures', prev_class: 'seller', today_class: 'hosting', prev_ns: ['ns1.dan.com'], today_ns: ['ns1.example.net'] });

  // Recovered multi-day window: prevDay 2026-09-11 -> day 2026-09-15 stamps every departure with 09-15.
  writeTape('2026-09-15', '2026-09-11', [departureRow('refined.com')]);
  const first = await ingestMovementCandidates(db, { directory: dir });
  assert.equal(first.refined, 0);

  const beforeRow = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('refined.com');
  assert.equal(beforeRow.exit_observed_day, '2026-09-15');

  // A same-day daily tape for 09-13 (a day actually inside the recovered window) arrives later.
  writeTape('2026-09-13', '2026-09-12', [departureRow('refined.com')]);
  const second = await ingestMovementCandidates(db, { directory: dir });
  assert.equal(second.refined, 1, 'the earlier-day tape is a refinement, not a new departure');

  const refinedRow = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('refined.com');
  assert.equal(refinedRow.exit_observed_day, '2026-09-13');
  assert.equal(refinedRow.state, beforeRow.state, 'state is untouched by a refinement');
  assert.equal(refinedRow.probe_count, beforeRow.probe_count, 'probe_count is untouched by a refinement');
  assert.equal(refinedRow.next_probe_at, beforeRow.next_probe_at, 'next_probe_at is untouched by a refinement');
  const refinedEvidence = JSON.parse(refinedRow.evidence_json);
  assert.equal(refinedEvidence.reportDate, '2026-09-13');
  assert.equal(refinedEvidence.discovery.departureDate, '2026-09-13');
  assert.equal(refinedEvidence.discovery.movement.day, '2026-09-13');
  assert.equal(refinedEvidence.discovery.movement.prevDay, '2026-09-12');
  assert.equal(refinedEvidence.discovery.movement.refinedFrom, '2026-09-15');

  // A genuinely later day still supersedes as a new departure, not a refinement.
  writeTape('2026-09-16', '2026-09-15', [departureRow('refined.com')]);
  const third = await ingestMovementCandidates(db, { directory: dir });
  assert.equal(third.refined, 0, 'a later day is a normal supersede, not a refinement');
  const laterRow = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('refined.com');
  assert.equal(laterRow.exit_observed_day, '2026-09-16');

  // An unrelated row whose stored window does not cover the incoming earlier day is left alone.
  insertCandidateRow(db, {
    domain: 'unrelated.com', last_stream: 'zone-seller-departure', exit_observed_day: '2026-09-10',
    evidence_json: JSON.stringify({ domain: 'unrelated.com', reportDate: '2026-09-10', sellerNameservers: ['ns1.dan.com'], discovery: { structurallyMoved: true, departureDate: '2026-09-10', movement: { day: '2026-09-10', prevDay: '2026-09-09' } } }),
  });
  writeTape('2026-09-08', '2026-09-07', [departureRow('unrelated.com')]);
  const fourth = await ingestMovementCandidates(db, { directory: dir });
  assert.equal(fourth.refined, 0, 'the incoming day falls outside the stored movement window, so it is not a refinement');
  const unrelatedRow = db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get('unrelated.com');
  assert.equal(unrelatedRow.exit_observed_day, '2026-09-10', 'unrelated row exit_observed_day is untouched');

  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
