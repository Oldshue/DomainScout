'use strict';

// Regression test for the hourly-wave-write vs interactive-read timeout
// hotfix: sale_watch.db must run in WAL mode (journal_mode=delete lets a
// writer's transaction block every reader until commit; WAL readers see the
// last committed snapshot instead). configureSaleWatchDb() is the single
// helper both getSaleWatchReconDb() (server/index.js) and any other
// sale_watch.db-opening connection must call so the pragma set never drifts
// out of sync between writer and reader connections.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { configureSaleWatchDb } = require('../server/sale-watch-reconstruction');

function mkTmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-watch-db-mode-'));
  return path.join(dir, 'sale_watch.db');
}

test('configureSaleWatchDb switches a sale_watch.db connection to WAL', () => {
  const dbPath = mkTmpDbPath();
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 30000');
  configureSaleWatchDb(db);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
  db.close();
});

test('a WAL reader is not blocked by an open, uncommitted writer transaction', () => {
  const dbPath = mkTmpDbPath();
  const writer = new Database(dbPath);
  writer.pragma('busy_timeout = 30000');
  configureSaleWatchDb(writer);
  writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');

  // Readonly connection standing in for a dbReadQuery worker: same pragma
  // discipline (short busy_timeout so a real block would fail fast/loud
  // instead of silently passing by waiting out a long timeout).
  const reader = new Database(dbPath, { readonly: true });
  reader.pragma('busy_timeout = 2000');

  writer.exec('BEGIN IMMEDIATE');
  writer.prepare('INSERT INTO t (val) VALUES (?)').run('written-not-yet-committed');

  assert.doesNotThrow(() => {
    const row = reader.prepare('SELECT COUNT(*) AS c FROM t').get();
    assert.equal(typeof row.c, 'number');
  }, 'reader SELECT must not raise SQLITE_BUSY while the writer transaction is still open');

  writer.exec('COMMIT');

  const after = reader.prepare('SELECT COUNT(*) AS c FROM t').get();
  assert.equal(after.c, 1);

  writer.close();
  reader.close();
});
