const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.CZDS_DIFF_RETURN_LIMIT = '2';
process.env.CZDS_SKIP_SUMMARY_REFRESH = '1';
const { __test: { finalizeStagedIndex } } = require('../server/zone-indexer');

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE zone_names (
      base_name TEXT NOT NULL,
      base_name_rev TEXT NOT NULL,
      tld TEXT NOT NULL,
      PRIMARY KEY (base_name, tld)
    );
    CREATE TABLE name_summary (
      base_name TEXT PRIMARY KEY,
      base_name_rev TEXT NOT NULL,
      tld_count INTEGER NOT NULL,
      tld_list TEXT NOT NULL,
      has_com INTEGER NOT NULL DEFAULT 0,
      has_ai INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE zone_drop_candidates (
      domain TEXT NOT NULL,
      base_name TEXT NOT NULL,
      tld TEXT NOT NULL,
      drop_date TEXT NOT NULL,
      source_file_date TEXT NOT NULL,
      tld_count INTEGER NOT NULL DEFAULT 0,
      length INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain, drop_date)
    );
    CREATE TABLE zone_indexed_tlds (
      tld TEXT PRIMARY KEY,
      file_date TEXT NOT NULL,
      record_count INTEGER
    );
    CREATE TABLE zone_daily_stats (
      tld TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      total_count INTEGER,
      new_count INTEGER,
      dropped_count INTEGER,
      PRIMARY KEY (tld, stat_date)
    );
  `);
  return db;
}

function stage(db, tld, prior, current) {
  const insertPrior = db.prepare(
    'INSERT INTO zone_names (base_name, base_name_rev, tld) VALUES (?, ?, ?)',
  );
  for (const name of prior) insertPrior.run(name, [...name].reverse().join(''), tld);
  db.exec(`
    DROP TABLE IF EXISTS temp.zone_names_next;
    CREATE TEMP TABLE zone_names_next (
      base_name TEXT PRIMARY KEY,
      base_name_rev TEXT NOT NULL
    );
  `);
  const insertCurrent = db.prepare(
    'INSERT INTO temp.zone_names_next (base_name, base_name_rev) VALUES (?, ?)',
  );
  for (const name of current) insertCurrent.run(name, [...name].reverse().join(''));
}

function restageCurrent(db, current) {
  db.exec(`
    CREATE TEMP TABLE zone_names_next (
      base_name TEXT PRIMARY KEY,
      base_name_rev TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO temp.zone_names_next (base_name, base_name_rev) VALUES (?, ?)',
  );
  for (const name of current) insert.run(name, [...name].reverse().join(''));
}

test('persists the complete generic zone-deletion set while returning only ranked samples', () => {
  const db = database();
  db.prepare('INSERT INTO name_summary (base_name, base_name_rev, tld_count, tld_list) VALUES (?, ?, ?, ?)')
    .run('highest', 'tsehgih', 12, '[".bio",".com"]');
  db.prepare('INSERT INTO name_summary (base_name, base_name_rev, tld_count, tld_list) VALUES (?, ?, ?, ?)')
    .run('mid', 'dim', 5, '[".bio"]');

  stage(db, '.bio', ['highest', 'mid', 'raw', 'stay'], ['stay', 'added']);
  const first = finalizeStagedIndex(db, 'bio', '2026-08-04', 2, '.bio');
  assert.equal(first.droppedCount, 3);
  assert.equal(first.persistedDroppedCount, 3);
  assert.deepEqual(first.droppedNames, ['highest', 'mid']);
  assert.equal(first.returnedDroppedCount, 2);
  assert.deepEqual(db.prepare(`
    SELECT domain, tld_count, length FROM zone_drop_candidates ORDER BY domain
  `).all(), [
    { domain: 'highest.bio', tld_count: 12, length: 7 },
    { domain: 'mid.bio', tld_count: 5, length: 3 },
    { domain: 'raw.bio', tld_count: 0, length: 3 },
  ]);
  assert.equal(db.prepare("SELECT 1 FROM zone_drop_candidates WHERE domain IN ('stay.bio', 'added.bio')").get(), undefined);

  restageCurrent(db, ['stay', 'added']);
  const rerun = finalizeStagedIndex(db, 'bio', '2026-08-04', 2, '.bio');
  assert.equal(rerun.droppedCount, 0);
  assert.equal(rerun.persistedDroppedCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zone_drop_candidates').get().n, 3);

  stage(db, '.sh', ['gone', 'kept'], ['kept', 'new']);
  const unrelated = finalizeStagedIndex(db, 'sh', '2026-08-04', 2, '.sh');
  assert.equal(unrelated.droppedCount, 1);
  assert.equal(unrelated.persistedDroppedCount, 1);
  assert.deepEqual(unrelated.droppedNames, ['gone']);
  assert.equal(db.prepare("SELECT 1 FROM zone_drop_candidates WHERE domain = 'gone.sh'").get()[1], 1);
  assert.equal(db.prepare("SELECT 1 FROM zone_drop_candidates WHERE domain IN ('kept.sh', 'new.sh')").get(), undefined);

  db.close();
});
