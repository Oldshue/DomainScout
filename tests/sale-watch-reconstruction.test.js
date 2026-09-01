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
} = require('../server/sale-watch-reconstruction');

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
