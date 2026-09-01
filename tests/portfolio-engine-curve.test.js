'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  ensureEngineSchema,
  checkAvailability,
  inspectCell,
  refreshGridState,
  classSignals,
  buildBoard,
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

function seedCells(db, cls, rows) {
  const upsert = db.prepare(`
    INSERT INTO portfolio_grid_state (class_id, domain, status, checked_at, registered_at)
    VALUES (@classId, @domain, @status, @checkedAt, @registeredAt)
  `);
  const now = new Date().toISOString();
  for (const r of rows) {
    upsert.run({
      classId: cls.id,
      domain: cls.candidates[r.idx],
      status: r.status,
      checkedAt: now,
      registeredAt: r.registeredAt || null,
    });
  }
}

// ── inspectCell / checkAvailability ─────────────────────────────────────────

test('inspectCell returns taken with registeredAt on HTTP 200 with a registration event', async () => {
  const fetchStub = async () => ({
    status: 200,
    json: async () => ({ events: [{ eventAction: 'registration', eventDate: '2026-08-29T00:00:00Z' }] }),
  });
  const result = await inspectCell('example.com', { fetch: fetchStub });
  assert.deepEqual(result, { status: 'taken', registeredAt: '2026-08-29T00:00:00Z' });
});

test('inspectCell returns available on HTTP 404', async () => {
  const fetchStub = async () => ({ status: 404 });
  const result = await inspectCell('example.com', { fetch: fetchStub });
  assert.deepEqual(result, { status: 'available', registeredAt: null });
});

test('inspectCell returns unknown when fetch throws', async () => {
  const fetchStub = async () => { throw new Error('network down'); };
  const result = await inspectCell('example.com', { fetch: fetchStub });
  assert.deepEqual(result, { status: 'unknown', registeredAt: null });
});

test('checkAvailability still returns the plain status string', async () => {
  const fetchStub = async () => ({ status: 404 });
  const result = await checkAvailability('example.com', { fetch: fetchStub });
  assert.equal(result, 'available');
});

// ── ensureEngineSchema ───────────────────────────────────────────────────────

test('ensureEngineSchema adds registered_at to a pre-stage-3 portfolio_grid_state table and is idempotent', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE portfolio_grid_state (
      class_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      status TEXT,
      PRIMARY KEY (class_id, domain)
    ) WITHOUT ROWID;
  `);
  ensureEngineSchema(db);
  ensureEngineSchema(db);
  const cols = db.prepare('PRAGMA table_info(portfolio_grid_state)').all().map((c) => c.name);
  assert.ok(cols.includes('registered_at'));
  assert.equal(cols.filter((c) => c === 'registered_at').length, 1);
});

// ── refreshGridState ─────────────────────────────────────────────────────────

test('refreshGridState persists registered_at from an object-returning check stub', async () => {
  const db = buildEngineDb();
  const cls = CLASSES[0];
  const domain = cls.candidates[0];
  const objCheck = async () => ({ status: 'taken', registeredAt: '2026-08-29T00:00:00Z' });
  await refreshGridState(db, { budget: 1, check: objCheck });
  const row = db.prepare('SELECT status, registered_at FROM portfolio_grid_state WHERE class_id = ? AND domain = ?').get(cls.id, domain);
  assert.equal(row.status, 'taken');
  assert.equal(row.registered_at, '2026-08-29T00:00:00Z');
});

test('refreshGridState leaves registered_at NULL for a string-returning check stub', async () => {
  const db = buildEngineDb();
  const cls = CLASSES[0];
  const domain = cls.candidates[0];
  const strCheck = async () => 'taken';
  await refreshGridState(db, { budget: 1, check: strCheck });
  const row = db.prepare('SELECT status, registered_at FROM portfolio_grid_state WHERE class_id = ? AND domain = ?').get(cls.id, domain);
  assert.equal(row.status, 'taken');
  assert.equal(row.registered_at, null);
});

// ── classSignals ──────────────────────────────────────────────────────────────

test('classSignals flags a single-day burst and suppresses slope', () => {
  const zoneDb = buildZoneDb();
  const insertToken = [redacted] INTO zone_daily_tokens (report_date, tld, token, word_count, reg_count) VALUES (?, 'com', 'homebattery', 2, ?)");
  const insertStat = zoneDb.prepare("INSERT INTO zone_daily_stats (stat_date, tld, new_count) VALUES (?, 'com', 100)");
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    const regs = i === 15 ? 29 : 1;
    insertToken.run(date, regs);
    insertStat.run(date);
  }
  const signals = classSignals(zoneDb, 'metro-homebattery');
  assert.ok(Math.abs(signals.maxDayShare - 0.5) < 1e-9);
  assert.equal(signals.burstFlag, true);
  assert.equal(signals.slope, 0);
  assert.equal(signals.demandBasis, 'burst-suppressed');
});

test('classSignals reports unsuppressed multi-day demand for an even spread with no dominant day', () => {
  const zoneDb = buildZoneDb();
  const insertToken = [redacted] INTO zone_daily_tokens (report_date, tld, token, word_count, reg_count) VALUES (?, 'com', 'homebattery', 2, 2)");
  const insertStat = zoneDb.prepare("INSERT INTO zone_daily_stats (stat_date, tld, new_count) VALUES (?, 'com', 100)");
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    insertToken.run(date);
    insertStat.run(date);
  }
  const signals = classSignals(zoneDb, 'metro-homebattery');
  assert.equal(signals.burstFlag, false);
  assert.equal(signals.demandBasis, 'multi-day');
});

// ── buildBoard curve position / stage labels / scoring ─────────────────────────

test('buildBoard computes curve position, refines stage labels, and scores FORMING-HOT 1.2x a plain FORMING cell with identical factors', () => {
  const db = buildEngineDb();
  const zoneDb = buildZoneDb();
  const day = '2026-09-01';

  const curveCls = CLASSES.find((c) => c.id === 'metro-batterystorage');
  const hotCls = CLASSES.find((c) => c.id === 'metro-evcharger');
  const plainCls = CLASSES.find((c) => c.id === 'metro-heatpumps');

  seedCells(db, curveCls, [
    { idx: 0, status: 'taken', registeredAt: '2026-08-01T00:00:00Z' },
    { idx: 1, status: 'taken', registeredAt: '2026-08-05T00:00:00Z' },
    { idx: 2, status: 'taken', registeredAt: '2026-08-10T00:00:00Z' },
    { idx: 3, status: 'taken', registeredAt: '2025-01-01T00:00:00Z' },
    { idx: 4, status: 'taken', registeredAt: '2025-02-01T00:00:00Z' },
    { idx: 5, status: 'taken', registeredAt: null },
    { idx: 6, status: 'available' },
    { idx: 7, status: 'available' },
  ]);

  seedCells(db, hotCls, [
    { idx: 0, status: 'taken', registeredAt: '2026-08-15T00:00:00Z' },
    { idx: 2, status: 'taken', registeredAt: '2026-08-20T00:00:00Z' },
    { idx: 1, status: 'available' },
    { idx: 3, status: 'available' },
    { idx: 4, status: 'available' },
    { idx: 5, status: 'available' },
    { idx: 6, status: 'available' },
    { idx: 7, status: 'available' },
    { idx: 8, status: 'available' },
    { idx: 9, status: 'available' },
  ]);

  seedCells(db, plainCls, [
    { idx: 0, status: 'taken', registeredAt: null },
    { idx: 2, status: 'taken', registeredAt: null },
    { idx: 1, status: 'available' },
    { idx: 3, status: 'available' },
    { idx: 4, status: 'available' },
    { idx: 5, status: 'available' },
    { idx: 6, status: 'available' },
    { idx: 7, status: 'available' },
    { idx: 8, status: 'available' },
    { idx: 9, status: 'available' },
  ]);

  const board = buildBoard(db, zoneDb, { day, minCheckedFraction: 0.5 });
  const byId = Object.fromEntries(board.classes.map((c) => [c.id, c]));

  const curve = byId[curveCls.id].curve;
  assert.equal(curve.takenTotal, 6);
  assert.equal(curve.takenLast180d, 3);
  assert.equal(curve.activeFront, 0.5);
  assert.equal(byId[curveCls.id].stage, 'LATE-ACTIVE');

  assert.equal(byId[hotCls.id].stage, 'FORMING-HOT');
  assert.equal(byId[plainCls.id].stage, 'FORMING');

  const byKey = Object.fromEntries(board.buys.concat(board.carry).map((b) => [`${b.class}:${b.domain}`, b]));
  const hotCell = byKey[`${hotCls.id}:${hotCls.candidates[1]}`];
  const plainCell = byKey[`${plainCls.id}:${plainCls.candidates[1]}`];
  assert.ok(hotCell && plainCell, 'both comparison domains are present on the board');
  assert.ok(Math.abs(hotCell.score - plainCell.score * 1.2) < 1e-9, 'FORMING-HOT scores 1.2x an identical plain FORMING cell');
});

// ── CLASSES ──────────────────────────────────────────────────────────────────

test('CLASSES includes the stage-3 classes with the expected candidate counts and no duplicate domains', () => {
  const byId = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
  assert.equal(byId['humanoid-ops'].candidates.length, 27);
  assert.equal(byId['datacenter-land'].candidates.length, 32);
  assert.equal(byId['power-siting'].candidates.length, 18);
  const allDomains = CLASSES.flatMap((c) => c.candidates);
  assert.equal(new Set(allDomains).size, allDomains.length, 'no duplicate domains across all classes');
});
