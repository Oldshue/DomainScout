'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ensureEngineSchema,
  refreshGridState,
  classSignals,
  buildBoard,
  runDailyEngine,
  readBoard,
  CLASSES,
} = require('../server/portfolio-engine');

function buildEngineDb() {
  const db = new Database(':memory:');
  ensureEngineSchema(db);
  return db;
}

function buildZoneDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE zone_daily_tokens (
      report_date TEXT NOT NULL, tld TEXT NOT NULL, token TEXT NOT NULL,
      word_count INTEGER NOT NULL, reg_count INTEGER NOT NULL
    );
    CREATE TABLE zone_daily_stats (
      stat_date TEXT NOT NULL, tld TEXT NOT NULL, new_count INTEGER NOT NULL
    );
  `);
  return db;
}

const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

function seedByIndex(db, cls, takenIdx, availableIdx) {
  const upsert = db.prepare(`
    INSERT INTO portfolio_grid_state (class_id, domain, status, checked_at)
    VALUES (@classId, @domain, @status, @checkedAt)
  `);
  const now = new Date().toISOString();
  for (const i of takenIdx) upsert.run({ classId: cls.id, domain: cls.candidates[i], status: 'taken', checkedAt: now });
  for (const i of availableIdx) upsert.run({ classId: cls.id, domain: cls.candidates[i], status: 'available', checkedAt: now });
}

// ── ensureEngineSchema ───────────────────────────────────────────────────────

test('ensureEngineSchema is idempotent (safe to run twice)', () => {
  const db = new Database(':memory:');
  ensureEngineSchema(db);
  ensureEngineSchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('portfolio_grid_state'));
  assert.ok(tables.includes('portfolio_boards'));
});

// ── refreshGridState ───────────────────���─────────────────────────────────────

test('refreshGridState never spends more than the given budget', async () => {
  const db = buildEngineDb();
  let calls = 0;
  const check = async () => { calls += 1; return 'available'; };
  const summary = await refreshGridState(db, { budget: 7, check });
  assert.equal(calls, 7);
  assert.equal(summary.checked, 7);
});

test('refreshGridState upserts statuses from the injected check stub with correct summary counts', async () => {
  const db = buildEngineDb();
  const statuses = ['available', 'taken', 'unknown', 'available', 'taken'];
  let i = 0;
  const check = async () => statuses[i++];
  const summary = await refreshGridState(db, { budget: statuses.length, check });
  assert.equal(summary.checked, 5);
  assert.equal(summary.available, 2);
  assert.equal(summary.taken, 2);
  assert.equal(summary.unknown, 1);
  const rows = db.prepare('SELECT status FROM portfolio_grid_state').all();
  assert.equal(rows.length, 5);
});

test('refreshGridState checks the only never-checked cell before any already-checked cell', async () => {
  const db = buildEngineDb();
  const cls = CLASSES[0];
  const target = cls.candidates[0];
  const upsert = db.prepare(`
    INSERT INTO portfolio_grid_state (class_id, domain, status, checked_at)
    VALUES (@classId, @domain, 'available', @checkedAt)
  `);
  const recent = new Date().toISOString();
  for (const c of CLASSES) {
    for (const domain of c.candidates) {
      if (c.id === cls.id && domain === target) continue;
      upsert.run({ classId: c.id, domain, checkedAt: recent });
    }
  }
  const checked = [];
  const check = async (domain) => { checked.push(domain); return 'taken'; };
  const summary = await refreshGridState(db, { budget: 1, check });
  assert.equal(summary.checked, 1);
  assert.equal(checked[0], target, 'the only never-checked cell is refreshed first');
});

test('refreshGridState re-checks the oldest checked_at cells first once every cell has been checked', async () => {
  const db = buildEngineDb();
  const upsert = db.prepare(`
    INSERT INTO portfolio_grid_state (class_id, domain, status, checked_at)
    VALUES (@classId, @domain, 'available', @checkedAt)
  `);
  const recent = new Date().toISOString();
  for (const c of CLASSES) for (const domain of c.candidates) upsert.run({ classId: c.id, domain, checkedAt: recent });
  const oldCls = CLASSES[1];
  const oldest = oldCls.candidates[0];
  const older = oldCls.candidates[1];
  db.prepare('UPDATE portfolio_grid_state SET checked_at = ? WHERE class_id = ? AND domain = ?').run('2000-01-01T00:00:00.000Z', oldCls.id, oldest);
  db.prepare('UPDATE portfolio_grid_state SET checked_at = ? WHERE class_id = ? AND domain = ?').run('2010-01-01T00:00:00.000Z', oldCls.id, older);
  const checked = [];
  const check = async (domain) => { checked.push(domain); return 'available'; };
  const summary = await refreshGridState(db, { budget: 2, check });
  assert.equal(summary.checked, 2);
  assert.deepEqual(checked.sort(), [oldest, older].sort());
});

test('refreshGridState never throws when the check stub throws', async () => {
  const db = buildEngineDb();
  const check = async () => { throw new Error('boom'); };
  const summary = await refreshGridState(db, { budget: 3, check });
  assert.equal(summary.checked, 3);
  assert.equal(summary.unknown, 3);
});

// ── classSignals ──────────────────────────────────────────────────────────────

test('classSignals computes totals/activeDays/burst/slope from fixture zone_daily_tokens rows', () => {
  const zoneDb = buildZoneDb();
  const insertToken = zoneDb.prepare('INSERT INTO zone_daily_tokens (report_date, tld, token, word_count, reg_count) VALUES (?, ?, ?, 2, ?)');
  insertToken.run('2026-08-01', 'com', 'homebattery', 2);
  insertToken.run('2026-08-25', 'com', 'homebattery', 10);
  insertToken.run('2026-08-30', 'com', 'unrelatedtoken', 1);
  const insertStat = zoneDb.prepare('INSERT INTO zone_daily_stats (stat_date, tld, new_count) VALUES (?, ?, ?)');
  insertStat.run('2026-08-01', 'com', 20);
  insertStat.run('2026-08-25', 'com', 20);

  const signals = classSignals(zoneDb, 'metro-homebattery');
  assert.equal(signals.totalRegs, 12);
  assert.equal(signals.activeDays, 2);
  assert.ok(Math.abs(signals.maxDayShare - 10 / 12) < 1e-9, 'burst = max single day / class total');
  assert.equal(signals.burstFlag, true);
  assert.equal(signals.slope, 0, 'slope suppressed when one day dominates');
  assert.equal(signals.demandBasis, 'burst-suppressed');
});

test('classSignals reports multi-day demand with an unsuppressed slope when no day dominates', () => {
  const zoneDb = buildZoneDb();
  const insertToken = zoneDb.prepare("INSERT INTO zone_daily_tokens (report_date, tld, token, word_count, reg_count) VALUES (?, 'com', 'homebattery', 2, ?)");
  const insertStat = zoneDb.prepare("INSERT INTO zone_daily_stats (stat_date, tld, new_count) VALUES (?, 'com', 20)");
  const today = new Date();
  for (let back = 1; back <= 28; back += 1) {
    const day = new Date(today.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    insertToken.run(day, back <= 10 ? 4 : 2); // last 10 days run hotter than the first
    insertStat.run(day);
  }
  const signals = classSignals(zoneDb, 'metro-homebattery');
  assert.equal(signals.activeDays, 28);
  assert.ok(signals.maxDayShare < 0.2);
  assert.equal(signals.burstFlag, false);
  assert.equal(signals.demandBasis, 'multi-day');
  assert.ok(signals.slope > 0);
});

test('classSignals returns zeroed signals for an unknown class id', () => {
  const zoneDb = buildZoneDb();
  assert.deepEqual(classSignals(zoneDb, 'not-a-real-class'), { totalRegs: 0, activeDays: 0, maxDayShare: 0, slope: 0, burstFlag: false, demandBasis: 'multi-day' });
});

// ── buildBoard ───────────────────────────────────────────────────────────────

test('buildBoard excludes classes below minCheckedFraction and stages FORMING/MID/LATE by consumption', () => {
  const db = buildEngineDb();
  const zoneDb = buildZoneDb();
  const below = CLASSES.find(c => c.id === 'metro-homebattery');
  const forming = CLASSES.find(c => c.id === 'metro-batterystorage');
  const mid = CLASSES.find(c => c.id === 'money-form');
  const late = CLASSES.find(c => c.id === 'metro-evcharging');

  seedByIndex(db, below, [0], [1]); // 2/15 checked, below the 0.6 threshold
  seedByIndex(db, forming, range(0, 4), range(5, 14)); // 5/15 = 0.33 (< 0.4)
  seedByIndex(db, mid, range(0, 17), range(18, 35)); // 18/36 = 0.5
  seedByIndex(db, late, range(0, 12), range(13, 14)); // 13/15 = 0.87 (> 0.75)

  const board = buildBoard(db, zoneDb, { day: '2026-09-01', minCheckedFraction: 0.6 });
  const byId = Object.fromEntries(board.classes.map(c => [c.id, c]));
  assert.equal(byId[below.id], undefined, 'below-threshold class excluded');
  assert.equal(byId[forming.id].stage, 'FORMING');
  assert.equal(byId[mid.id].stage, 'MID');
  assert.equal(byId[late.id].stage, 'LATE');
});

test('buildBoard scoring prefers demand-confirmed FORMING and 2-word-factor names; board is persisted and readBoard returns it', () => {
  const db = buildEngineDb();
  const zoneDb = buildZoneDb();
  const insertToken = zoneDb.prepare("INSERT INTO zone_daily_tokens (report_date, tld, token, word_count, reg_count) VALUES (?, 'com', 'batterystorage', 2, ?)");
  const insertStat = zoneDb.prepare("INSERT INTO zone_daily_stats (stat_date, tld, new_count) VALUES (?, 'com', 100)");
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    insertToken.run(date, i >= 20 ? 10 : 1);
    insertStat.run(date);
  }

  const classA = CLASSES.find(c => c.id === 'metro-batterystorage'); // FORMING + confirmed demand
  const classB = CLASSES.find(c => c.id === 'metro-evcharger'); // MID
  const classC = CLASSES.find(c => c.id === 'metro-evcharging'); // LATE
  const classD = CLASSES.find(c => c.id === 'metro-heatpumps'); // plain FORMING, same word factor as A/B/C
  const classE = CLASSES.find(c => c.id === 'aiautomationfor'); // plain FORMING, 3+-word factor

  seedByIndex(db, classA, range(1, 3), [0, ...range(4, 14)]); // consumption 0.2
  seedByIndex(db, classB, range(1, 8), [0, ...range(9, 14)]); // consumption 0.53
  seedByIndex(db, classC, range(2, 14), [0, 1]); // consumption 0.87
  seedByIndex(db, classD, range(1, 3), [0, ...range(4, 14)]); // consumption 0.2
  seedByIndex(db, classE, [1], [0, 2, 3, 4, 5, 6, 7]); // consumption 0.125

  const board = buildBoard(db, zoneDb, { day: '2026-09-01' });
  const key = (cls) => `${cls.id}:${cls.candidates[0]}`;
  const byKey = Object.fromEntries(board.buys.map(b => [`${b.class}:${b.domain}`, b]));
  const [a, b, c, d, e] = [classA, classB, classC, classD, classE].map(cls => byKey[key(cls)]);
  assert.ok(a && b && c && d && e, 'all sample domains are present on the board');
  assert.ok(a.score > b.score, 'confirmed-demand FORMING outscores MID');
  assert.ok(b.score > d.score, 'MID outscores plain FORMING at equal word/length factor');
  assert.ok(d.score > e.score, '2-word metro factor outscores the 3+-word aiautomationfor factor at equal stage');
  assert.ok(e.score > c.score, 'plain FORMING outscores LATE');

  const persisted = readBoard(db, { day: '2026-09-01' });
  assert.ok(persisted);
  assert.equal(persisted.day, '2026-09-01');
  assert.equal(persisted.buys.length, board.buys.length);
});

// ── runDailyEngine ───────────────────────────────────────────────────────────

test('runDailyEngine happy path builds a board and skips a second run for the same day', async () => {
  const db = buildEngineDb();
  const zoneDb = buildZoneDb();
  const check = async () => 'available';

  const first = await runDailyEngine(db, zoneDb, { day: '2026-09-01', budget: 10, check });
  assert.equal(first.ran, true);
  assert.equal(first.day, '2026-09-01');
  assert.ok(first.summary);
  assert.ok(readBoard(db, { day: '2026-09-01' }));

  const second = await runDailyEngine(db, zoneDb, { day: '2026-09-01', budget: 10, check });
  assert.equal(second.ran, false);
});

test('runDailyEngine never throws with a throwing check stub, producing unknown statuses', async () => {
  const db = buildEngineDb();
  const zoneDb = buildZoneDb();
  const check = async () => { throw new Error('boom'); };
  const result = await runDailyEngine(db, zoneDb, { day: '2026-09-02', budget: 5, check });
  assert.equal(result.ran, true);
  assert.equal(typeof result.summary, 'string');
});
