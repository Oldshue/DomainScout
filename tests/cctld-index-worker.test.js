'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

test('ccTLD projection builds and incrementally replaces provider-neutral positive evidence', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-cctld-index-'));
  const dbPath = path.join(dataDir, 'domains.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL,
      source TEXT,
      checked_at TEXT
    );
    CREATE TABLE sibling_tld_status (
      base_name TEXT NOT NULL,
      tld TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;
    INSERT INTO tld_check_cache VALUES
      ('alpha', 1, '[".ai"]', 3, 'fixture', '2026-08-11 12:00:00'),
      ('beta', 1, '[".io"]', 3, 'fixture', '2026-08-11 12:00:00');
    INSERT INTO sibling_tld_status VALUES
      ('kiln', '.shop', 'taken', 'generic-fixture', '2026-08-11 12:00:00');
  `);
  db.close();

  const runWorker = () => spawnSync(process.execPath, ['server/cctld-index-worker.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: dataDir },
    encoding: 'utf8',
    timeout: 20_000,
  });

  const first = runWorker();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"mode":"full"/);

  const verify = new Database(dbPath);
  assert.deepEqual(
    verify.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY tld, base_name').all(),
    [{ tld: '.ai', base_name: 'alpha' }, { tld: '.io', base_name: 'beta' }, { tld: '.shop', base_name: 'kiln' }]
  );
  assert.equal(
    verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_cctld_taken_base'").get().n,
    1,
    'an unrelated .shop page can project concrete positives by base without scanning the TLD-first index',
  );
  verify.prepare(`
    UPDATE tld_check_cache
    SET taken_json = '[".shop"]', checked_at = '2026-08-11 12:00:01'
    WHERE base_name = 'beta'
  `).run();
  verify.close();

  const second = runWorker();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"mode":"incremental"/);

  const finalDb = new Database(dbPath, { readonly: true });
  assert.deepEqual(
    finalDb.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY tld, base_name').all(),
    [{ tld: '.ai', base_name: 'alpha' }, { tld: '.shop', base_name: 'beta' }, { tld: '.shop', base_name: 'kiln' }]
  );
  finalDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a current unrelated projection exits read-only while another writer owns SQLite', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-cctld-current-'));
  const dbPath = path.join(dataDir, 'domains.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER NOT NULL, taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL, source TEXT, checked_at TEXT
    );
    CREATE TABLE sibling_tld_status (
      base_name TEXT NOT NULL, tld TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;
    INSERT INTO tld_check_cache VALUES
      ('kiln', 1, '[".shop"]', 1, 'unrelated-fixture', '2026-08-13 12:00:00');
  `);
  db.close();

  const runWorker = () => spawnSync(process.execPath, ['server/cctld-index-worker.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: dataDir },
    encoding: 'utf8',
    // Allow cold process startup under desktop load, while remaining below
    // the worker's 60-second write-lock wait so accidental writes still fail.
    timeout: 15_000,
  });
  assert.equal(runWorker().status, 0);

  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare(`INSERT INTO sibling_tld_status VALUES ('loom', '.shop', 'taken', 'unrelated-writer', '2026-08-13 12:00:00')`).run();
  const current = runWorker();
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /"mode":"current"/);
  writer.exec('ROLLBACK');
  writer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('change detection reads the checked_at indexes, never the whole source tables', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domainscout-cctld-indexed-'));
  const dbPath = path.join(dataDir, 'domains.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // A database from before this change: populated tables, a projection and a
  // state row with no tail count, and no checked_at indexes.
  db.exec(`
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER NOT NULL, taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL, source TEXT, checked_at TEXT
    );
    CREATE TABLE sibling_tld_status (
      base_name TEXT NOT NULL, tld TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;
    CREATE TABLE cctld_taken_idx (tld TEXT NOT NULL, base_name TEXT NOT NULL, PRIMARY KEY (tld, base_name)) WITHOUT ROWID;
    CREATE TABLE cctld_index_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), source_rows INTEGER NOT NULL DEFAULT 0,
      source_max_checked_at TEXT, rebuilt_at TEXT, refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tld_check_cache VALUES ('alpha', 1, '[".ai"]', 3, 'fixture', '2026-08-11 12:00:00');
    INSERT INTO sibling_tld_status VALUES ('kiln', '.shop', 'taken', 'fixture', '2026-08-11 12:00:05');
    INSERT INTO cctld_taken_idx VALUES ('.ai', 'alpha'), ('.shop', 'kiln');
    INSERT INTO cctld_index_state (singleton, source_rows, source_max_checked_at, rebuilt_at)
      VALUES (1, 2, '2026-08-11 12:00:05', datetime('now'));
  `);
  db.close();
  const runWorker = () => spawnSync(process.execPath, ['server/cctld-index-worker.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, RAILWAY_VOLUME_MOUNT_PATH: dataDir },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const mode = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split('\n').pop()).mode; };
  const projection = () => {
    const read = new Database(dbPath, { readonly: true });
    try { return read.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY tld, base_name').all().map(row => `${row.base_name}${row.tld}`); }
    finally { read.close(); }
  };

  // The first run after the upgrade adds the indexes and the tail count, once.
  assert.equal(mode(runWorker()), 'incremental');
  assert.equal(mode(runWorker()), 'current');
  const check = new Database(dbPath);
  assert.deepEqual(
    check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%checked_at' ORDER BY name").pluck().all(),
    ['idx_sibling_tld_status_checked_at', 'idx_tld_check_cache_checked_at'],
  );
  assert.equal(check.prepare('SELECT source_tail_rows FROM cctld_index_state').pluck().get(), 1);
  for (const table of ['tld_check_cache', 'sibling_tld_status']) {
    for (const sql of [`SELECT MAX(checked_at) FROM ${table}`, `SELECT COUNT(*) FROM ${table} WHERE checked_at >= '2026-08-11 12:00:05'`, `SELECT base_name FROM ${table} WHERE checked_at >= '2026-08-11 12:00:05'`]) {
      const plan = check.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join(' | ');
      assert.match(plan, new RegExp(`SEARCH ${table} USING (COVERING )?INDEX idx_${table}_checked_at`), plan);
      assert.doesNotMatch(plan, /SCAN /, plan);
    }
  }

  // New evidence carrying the very timestamp already projected is still seen:
  // the newest time is unchanged, the number of rows at that time is not.
  check.prepare(`INSERT INTO sibling_tld_status VALUES ('loom', '.dev', 'taken', 'fixture', '2026-08-11 12:00:05')`).run();
  check.close();
  assert.equal(mode(runWorker()), 'incremental');
  assert.deepEqual(projection(), ['alpha.ai', 'loom.dev', 'kiln.shop']);
  assert.equal(mode(runWorker()), 'current');

  // Later evidence in either table is projected, then the worker is idle again.
  const later = new Database(dbPath);
  later.prepare(`UPDATE tld_check_cache SET taken_json = '[".io"]', checked_at = '2026-08-11 12:01:00' WHERE base_name = 'alpha'`).run();
  later.close();
  assert.equal(mode(runWorker()), 'incremental');
  assert.deepEqual(projection(), ['loom.dev', 'alpha.io', 'kiln.shop']);
  assert.equal(mode(runWorker()), 'current');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// 2026-11-26: the refresh used to be one IMMEDIATE transaction whose join was
// planned as a full scan of tld_check_cache, so every other domains.db writer
// waited out its busy timeout ("database is locked", about 50 an hour).
function lockFixture(prefix, { labels = 9, rebuiltAt = "datetime('now')" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dataDir, 'domains.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE tld_check_cache (
      base_name TEXT PRIMARY KEY, count INTEGER NOT NULL, taken_json TEXT NOT NULL,
      all_count INTEGER NOT NULL, source TEXT, checked_at TEXT
    );
    CREATE TABLE sibling_tld_status (
      base_name TEXT NOT NULL, tld TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;
    CREATE TABLE cctld_taken_idx (tld TEXT NOT NULL, base_name TEXT NOT NULL, PRIMARY KEY (tld, base_name)) WITHOUT ROWID;
    CREATE INDEX idx_cctld_taken_base ON cctld_taken_idx(base_name, tld);
    CREATE TABLE cctld_index_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), source_rows INTEGER NOT NULL DEFAULT 0,
      source_max_checked_at TEXT, source_tail_rows INTEGER, rebuilt_at TEXT,
      refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE other_writer_log (n INTEGER PRIMARY KEY);
  `);
  const cache = db.prepare("INSERT INTO tld_check_cache VALUES (?, 1, ?, 3, 'fixture', ?)");
  const sibling = db.prepare("INSERT INTO sibling_tld_status VALUES (?, '.shop', 'taken', 'fixture', ?)");
  const idx = db.prepare('INSERT INTO cctld_taken_idx VALUES (?, ?)');
  for (let i = 0; i < labels; i += 1) {
    const base = `label${String(i).padStart(3, '0')}`;
    cache.run(base, '[".ai"]', '2026-08-11 12:00:00');
    // One row carries the newest time, as a projected database always has.
    sibling.run(base, i === 0 ? '2026-08-11 12:00:05' : '2026-08-11 12:00:00');
    idx.run('.ai', base);
    idx.run('.shop', base);
  }
  db.prepare(`
    INSERT INTO cctld_index_state (singleton, source_rows, source_max_checked_at, source_tail_rows, rebuilt_at)
    VALUES (1, ?, '2026-08-11 12:00:05', 1, ${rebuiltAt})
  `).run(labels * 2);
  return { dataDir, dbPath, db };
}

// Another process's writer: zero busy timeout, so it fails at once if the
// refresh still owns the write lock when it gets its turn.
function impatientWriter(dbPath) {
  const writer = new Database(dbPath);
  writer.pragma('busy_timeout = 0');
  const insert = writer.prepare('INSERT INTO other_writer_log (n) VALUES (?)');
  let n = 0;
  return { write: () => insert.run(n += 1), count: () => n, close: () => writer.close() };
}

const projectionOf = db => db.prepare('SELECT tld, base_name FROM cctld_taken_idx ORDER BY base_name, tld').all()
  .map(row => `${row.base_name}${row.tld}`);

test('an incremental refresh commits in small chunks and lets other writers in between them', () => {
  const { refreshCctldIndex } = require('../server/cctld-index-worker');
  const { dataDir, dbPath, db } = lockFixture('domainscout-cctld-chunks-');
  // Seven labels change: .ai becomes .io.
  db.prepare(`
    UPDATE tld_check_cache SET taken_json = '[".io"]', checked_at = '2026-08-11 12:00:09'
    WHERE base_name < 'label007'
  `).run();
  const writer = impatientWriter(dbPath);
  const result = refreshCctldIndex(db, {
    chunkBases: 2,
    pauseMs: 0,
    onChunkCommitted: () => writer.write(),
  });
  assert.equal(result.mode, 'incremental');
  assert.equal(result.changed, 7);
  assert.equal(result.writeTransactions, 4, 'seven labels in chunks of two are four short write transactions');
  assert.equal(writer.count(), 4, 'a writer with no busy timeout got the lock after every chunk');
  const expected = [];
  for (let i = 0; i < 9; i += 1) {
    const base = `label${String(i).padStart(3, '0')}`;
    expected.push(`${base}${i < 7 ? '.io' : '.ai'}`, `${base}.shop`);
  }
  assert.deepEqual(projectionOf(db), expected.sort());
  assert.equal(refreshCctldIndex(db, { pauseMs: 0 }).mode, 'current', 'the state row covers what was projected');
  writer.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a source row written while the chunks run is projected by the next refresh', () => {
  const { refreshCctldIndex } = require('../server/cctld-index-worker');
  const { dataDir, dbPath, db } = lockFixture('domainscout-cctld-midrun-');
  db.prepare(`UPDATE tld_check_cache SET taken_json = '[".io"]', checked_at = '2026-08-11 12:00:09' WHERE base_name < 'label004'`).run();
  const other = new Database(dbPath);
  let wrote = false;
  refreshCctldIndex(db, {
    chunkBases: 1,
    pauseMs: 0,
    onChunkCommitted: () => {
      if (wrote) return;
      wrote = true;
      // Same timestamp as the newest row already seen, on a label not in this run.
      other.prepare(`UPDATE tld_check_cache SET taken_json = '[".dev"]', checked_at = '2026-08-11 12:00:09' WHERE base_name = 'label008'`).run();
    },
  });
  other.close();
  assert.ok(!projectionOf(db).includes('label008.dev'));
  assert.equal(refreshCctldIndex(db, { pauseMs: 0 }).mode, 'incremental');
  assert.ok(projectionOf(db).includes('label008.dev'));
  assert.ok(!projectionOf(db).includes('label008.ai'));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the daily full re-projection is chunked, never empties the index and removes labels that left the sources', () => {
  const { refreshCctldIndex } = require('../server/cctld-index-worker');
  const { dataDir, dbPath, db } = lockFixture('domainscout-cctld-full-', { rebuiltAt: "datetime('now', '-2 days')" });
  db.exec(`
    INSERT INTO cctld_taken_idx VALUES ('.ai', 'gone'), ('.io', 'zzgone');
    UPDATE tld_check_cache SET taken_json = '[".io"]' WHERE base_name = 'label003';
    INSERT INTO sibling_tld_status VALUES ('onlysibling', '.dev', 'taken', 'fixture', '2026-08-11 12:00:00');
  `);
  const writer = impatientWriter(dbPath);
  const reader = new Database(dbPath, { readonly: true });
  let smallest = Infinity;
  const result = refreshCctldIndex(db, {
    chunkBases: 3,
    pauseMs: 0,
    onChunkCommitted: () => {
      writer.write();
      smallest = Math.min(smallest, reader.prepare('SELECT COUNT(*) FROM cctld_taken_idx').pluck().get());
    },
  });
  reader.close();
  assert.equal(result.mode, 'full');
  assert.equal(result.writeTransactions, 4, '12 labels in chunks of three');
  assert.equal(writer.count(), 4);
  assert.ok(smallest >= 18, `readers always saw a populated index (smallest ${smallest})`);
  const expected = ['onlysibling.dev'];
  for (let i = 0; i < 9; i += 1) {
    const base = `label${String(i).padStart(3, '0')}`;
    expected.push(`${base}${i === 3 ? '.io' : '.ai'}`, `${base}.shop`);
  }
  assert.deepEqual(projectionOf(db), expected.sort());
  assert.equal(refreshCctldIndex(db, { pauseMs: 0 }).mode, 'current');
  writer.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the projection joins probe the source tables by label and never scan them', () => {
  const { PROJECT_FROM_CHECK_CACHE_SQL, PROJECT_FROM_SIBLING_STATUS_SQL } = require('../server/cctld-index-worker');
  // Large enough that SQLite prefers scanning tld_check_cache when the join
  // order is left to it (the temp table has no statistics): the production plan.
  const { dataDir, db } = lockFixture('domainscout-cctld-plan-', { labels: 3000 });
  db.exec('ANALYZE');
  db.exec('CREATE TEMP TABLE cctld_chunk_bases (base_name TEXT PRIMARY KEY) WITHOUT ROWID');
  const plan = sql => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail);
  const cachePlan = plan(PROJECT_FROM_CHECK_CACHE_SQL);
  assert.ok(cachePlan.some(step => /^SEARCH tc USING INDEX sqlite_autoindex_tld_check_cache_1 \(base_name=\?\)/.test(step)), cachePlan.join(' | '));
  assert.ok(!cachePlan.some(step => /^SCAN tc/.test(step)), cachePlan.join(' | '));
  const siblingPlan = plan(PROJECT_FROM_SIBLING_STATUS_SQL);
  assert.ok(siblingPlan.some(step => /^SEARCH s USING PRIMARY KEY \(base_name=\?\)/.test(step)), siblingPlan.join(' | '));
  assert.ok(!siblingPlan.some(step => /^SCAN s\b/.test(step)), siblingPlan.join(' | '));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
