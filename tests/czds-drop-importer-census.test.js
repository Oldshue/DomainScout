'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  ZONE_DIFF_SOURCE,
  importCzdsDropCandidates,
  reconcileCzdsCoverage,
} = require('../server/zone-drop-census');

function primaryDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      base_name TEXT,
      tld TEXT NOT NULL,
      stream TEXT NOT NULL,
      source TEXT,
      dns_available INTEGER,
      registration_available INTEGER,
      first_available_at TEXT,
      availability_checked_at TEXT,
      availability_source TEXT,
      availability_error TEXT,
      length INTEGER,
      has_numbers INTEGER DEFAULT 0,
      has_hyphens INTEGER DEFAULT 0,
      drop_date TEXT,
      tlds_taken INTEGER DEFAULT 0,
      tlds_checked_at TEXT,
      UNIQUE(domain, stream)
    );
    CREATE TABLE drop_events (
      domain TEXT NOT NULL,
      base_name TEXT NOT NULL,
      tld TEXT NOT NULL,
      source TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_event_at TEXT NOT NULL,
      prior_registered_evidence TEXT,
      released_at TEXT,
      registration_available INTEGER,
      availability_source TEXT,
      availability_checked_at TEXT,
      observed_at TEXT,
      UNIQUE(domain, source, source_event_at)
    );
  `);
  return database;
}

function zoneDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE zone_drop_candidates (
      domain TEXT NOT NULL,
      base_name TEXT NOT NULL,
      tld TEXT NOT NULL,
      drop_date TEXT NOT NULL,
      source_file_date TEXT NOT NULL,
      tld_count INTEGER NOT NULL DEFAULT 0,
      length INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT,
      PRIMARY KEY (domain, drop_date)
    );
    CREATE TABLE zone_daily_stats (
      tld TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      total_count INTEGER,
      new_count INTEGER,
      dropped_count INTEGER,
      had_previous INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tld, stat_date)
    );
  `);
  return database;
}

function services(database) {
  const receipts = new Map();
  const catalogs = new Map();
  const statuses = [];
  return {
    receipts,
    catalogs,
    statuses,
    recordDropEvent(input) {
      const baseName = input.domain.slice(0, -input.tld.length);
      return database.prepare(`
        INSERT INTO drop_events (
          domain, base_name, tld, source, source_kind, source_event_at,
          prior_registered_evidence, released_at, registration_available, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, source, source_event_at) DO UPDATE SET
          prior_registered_evidence = excluded.prior_registered_evidence
      `).run(
        input.domain, baseName, input.tld, input.source, input.sourceKind,
        input.sourceEventAt, input.priorRegisteredEvidence, input.releasedAt,
        input.registrationAvailable, new Date().toISOString(),
      );
    },
    recordCoverageReceipt(input) {
      receipts.set(`${input.tld}|${input.date}`, { ...input });
    },
    registerDropSource(input) {
      catalogs.set(input.tld, { ...input });
    },
    recordDropSourceStatus(input) {
      statuses.push({ ...input });
    },
  };
}

test('drains the complete observed zone census and fails closed until availability is decisive', async () => {
  const database = primaryDatabase();
  const zoneDb = zoneDatabase();
  const dropUniverse = services(database);
  zoneDb.prepare(`
    INSERT INTO zone_daily_stats (tld, stat_date, dropped_count, had_previous)
    VALUES (?, ?, ?, ?)
  `).run('bio', '2026-08-04', 5, 1);
  zoneDb.prepare(`
    INSERT INTO zone_daily_stats (tld, stat_date, dropped_count, had_previous)
    VALUES (?, ?, ?, ?)
  `).run('sh', '2026-08-04', 0, 1);
  zoneDb.prepare(`
    INSERT INTO zone_daily_stats (tld, stat_date, dropped_count, had_previous)
    VALUES (?, ?, ?, ?)
  `).run('md', '2026-08-04', 0, 0);
  const insertCandidate = zoneDb.prepare(`
    INSERT INTO zone_drop_candidates
      (domain, base_name, tld, drop_date, source_file_date, tld_count, length)
    VALUES (?, ?, '.bio', '2026-08-04', '2026-08-04', ?, ?)
  `);
  for (let index = 0; index < 5; index += 1) {
    insertCandidate.run(`name${index}.bio`, `name${index}`, index, 5);
  }
  database.prepare(`
    INSERT INTO domains (
      domain, base_name, tld, stream, source, dns_available, registration_available,
      first_available_at, availability_checked_at, availability_source, availability_error,
      length, drop_date, tlds_taken
    ) VALUES (
      'name0.bio', 'name0', '.bio', 'just-dropped', 'old', 1, 1,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'registrar', 'old',
      5, '2026-08-01', 0
    )
  `).run();

  const imported = await importCzdsDropCandidates({ zoneDb, database, dropUniverse, batchSize: 2 });
  assert.equal(imported.selected, 5);
  assert.equal(imported.imported, 5);
  assert.deepEqual(imported.byTld, { '.bio': 5 });
  assert.equal(zoneDb.prepare('SELECT COUNT(*) AS n FROM zone_drop_candidates WHERE imported_at IS NOT NULL').get().n, 5);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM drop_events').get().n, 5);
  assert.deepEqual(database.prepare(`
    SELECT dns_available, registration_available, first_available_at,
      availability_checked_at, availability_source, availability_error, drop_date
    FROM domains WHERE domain = 'name0.bio' AND stream = 'just-dropped'
  `).get(), {
    dns_available: null,
    registration_available: null,
    first_available_at: null,
    availability_checked_at: null,
    availability_source: null,
    availability_error: null,
    drop_date: '2026-08-04',
  });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM drop_events WHERE released_at IS NULL').get().n, 5);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM drop_events WHERE prior_registered_evidence IS NOT NULL').get().n, 5);
  assert.equal(dropUniverse.receipts.get('.bio|2026-08-04').status, 'pending');
  assert.equal(dropUniverse.receipts.get('.bio|2026-08-04').unknown, 5);
  assert.deepEqual(dropUniverse.receipts.get('.sh|2026-08-04'), {
    tld: '.sh',
    date: '2026-08-04',
    source: ZONE_DIFF_SOURCE,
    status: 'complete',
    observed: 0,
    available: 0,
    unavailable: 0,
    unknown: 0,
    error: null,
  });
  assert.equal(dropUniverse.catalogs.has('.md'), false);

  database.prepare(`
    UPDATE drop_events SET registration_available =
      CASE WHEN domain IN ('name0.bio', 'name2.bio', 'name4.bio') THEN 1 ELSE 0 END
  `).run();
  const reconciled = reconcileCzdsCoverage({ zoneDb, database, dropUniverse });
  assert.equal(reconciled.structuralErrors, 0);
  assert.deepEqual(dropUniverse.receipts.get('.bio|2026-08-04'), {
    tld: '.bio',
    date: '2026-08-04',
    source: ZONE_DIFF_SOURCE,
    status: 'complete',
    observed: 5,
    available: 3,
    unavailable: 2,
    unknown: 0,
    error: null,
  });
  assert.equal(dropUniverse.catalogs.get('.bio').coverageStartedOn, '2026-08-04');
  assert.equal(dropUniverse.catalogs.get('.sh').coverageStartedOn, '2026-08-04');

  const rerun = await importCzdsDropCandidates({ zoneDb, database, dropUniverse, batchSize: 2 });
  assert.equal(rerun.selected, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM drop_events').get().n, 5);
  assert.equal(zoneDb.prepare('SELECT COUNT(*) AS n FROM zone_drop_candidates WHERE imported_at IS NOT NULL').get().n, 5);

  zoneDb.close();
  database.close();
});
