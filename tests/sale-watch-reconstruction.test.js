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
  probeCandidate,
  runProbeWave,
  readReconstructionEntries,
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
 const queued=db.prepare('SELECT * FROM sale_watch_candidates WHERE domain=?').get(row.domain);const origin=JSON.parse(queued.evidence_json);assert.deepEqual(origin.sellerNameservers,row.prev_ns);assert.equal(origin.discovery.movement.cohortSize,1);assert.equal(reconstructionCoverage(db).movement.zones,1071);assert.equal(readReconstructionEntries(db).length,0,'unprobed queue must not masquerade as reconstructed sales');
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
