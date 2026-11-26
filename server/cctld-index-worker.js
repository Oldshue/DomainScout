'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(__dirname, '../data');
// One projection step never holds the domains.db write lock for longer than a
// few hundred labels' worth of point lookups. Before 2026-11-26 the whole
// refresh was one IMMEDIATE transaction, and its tld_check_cache join was
// planned as a full scan of that table (about 290 MB in production) because the
// temp table of changed labels has no statistics. Every five minutes the write
// lock was held for the length of that scan (3 s with warm pages, far longer
// after the file-cache trim), and every other domains.db writer waiting behind
// it (FTS sync, the TLD worker, receipt enqueues) ran out its busy timeout and
// reported "database is locked". Two things keep the lock short now: the joins
// are driven from the small chunk table (CROSS JOIN pins that order), and the
// work is committed chunk by chunk with a pause between chunks so a waiting
// writer gets its turn.
const CHUNK_BASES = Math.max(1, parseInt(process.env.DOMAINSCOUT_CCTLD_INDEX_CHUNK || '500', 10) || 500);
const CHUNK_PAUSE_MS = Math.max(0, parseInt(process.env.DOMAINSCOUT_CCTLD_INDEX_PAUSE_MS || '15', 10) || 0);
const PROJECT_FROM_CHECK_CACHE_SQL = `
  INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
  SELECT je.value, tc.base_name
  FROM temp.cctld_chunk_bases chunk
  CROSS JOIN tld_check_cache tc ON tc.base_name = chunk.base_name,
       json_each(tc.taken_json) je
  WHERE je.value LIKE '.%'
`;
const PROJECT_FROM_SIBLING_STATUS_SQL = `
  INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
  SELECT s.tld, s.base_name
  FROM temp.cctld_chunk_bases chunk
  CROSS JOIN sibling_tld_status s ON s.base_name = chunk.base_name
  WHERE s.status = 'taken'
`;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const pause = ms => { if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms); };

function prepareChunkTables(db) {
  // Temp tables live in this connection's private temp database: filling them
  // takes no lock on domains.db.
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS cctld_chunk_bases (base_name TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS cctld_changed_bases (base_name TEXT PRIMARY KEY) WITHOUT ROWID;
    DELETE FROM temp.cctld_chunk_bases;
    DELETE FROM temp.cctld_changed_bases;
  `);
}

// Replaces the projection for every label the picker yields, one short write
// transaction per chunk. `pickChunk(cursor)` fills temp.cctld_chunk_bases with
// the next labels after `cursor` (read only on domains.db).
function projectInChunks(db, pickChunk, { pauseMs = CHUNK_PAUSE_MS, onChunkCommitted } = {}) {
  const lastInChunk = db.prepare('SELECT MAX(base_name) FROM temp.cctld_chunk_bases').pluck();
  const clearChunk = db.prepare('DELETE FROM temp.cctld_chunk_bases');
  const removeOld = db.prepare('DELETE FROM cctld_taken_idx WHERE base_name IN (SELECT base_name FROM temp.cctld_chunk_bases)');
  const fromCache = db.prepare(PROJECT_FROM_CHECK_CACHE_SQL);
  const fromSibling = db.prepare(PROJECT_FROM_SIBLING_STATUS_SQL);
  const apply = db.transaction(() => {
    removeOld.run();
    return fromCache.run().changes + fromSibling.run().changes;
  }).immediate;
  const totals = { bases: 0, inserted: 0, writeTransactions: 0, maxWriteMs: 0 };
  let cursor = '';
  for (;;) {
    clearChunk.run();
    const picked = pickChunk(cursor);
    if (!picked) break;
    cursor = lastInChunk.get();
    const started = Date.now();
    totals.inserted += apply();
    totals.maxWriteMs = Math.max(totals.maxWriteMs, Date.now() - started);
    totals.bases += picked;
    totals.writeTransactions += 1;
    if (onChunkCommitted) onChunkCommitted(totals);
    pause(pauseMs);
  }
  return totals;
}

function refreshCctldIndex(db, { chunkBases = CHUNK_BASES, pauseMs = CHUNK_PAUSE_MS, onChunkCommitted, nowMs = Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cctld_taken_idx (
      tld TEXT NOT NULL,
      base_name TEXT NOT NULL,
      PRIMARY KEY (tld, base_name)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_cctld_taken_base
      ON cctld_taken_idx(base_name, tld);
    CREATE TABLE IF NOT EXISTS cctld_index_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      source_rows INTEGER NOT NULL DEFAULT 0,
      source_max_checked_at TEXT,
      rebuilt_at TEXT,
      refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // This worker runs every five minutes. Its "has anything changed?" question
  // used to count both source tables and take MAX(checked_at) with no index on
  // that column: two full table scans of a multi-hundred-megabyte, scattered
  // region of domains.db on every run, which the container then carried (and was
  // billed for) as page cache. The two indexes below turn the question into a
  // handful of page reads. They are created here, in this child process, the
  // first time it runs; later runs find them and write nothing.
  const hasObject = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").pluck();
  if (!hasObject.get('index', 'idx_tld_check_cache_checked_at'))
    db.exec('CREATE INDEX IF NOT EXISTS idx_tld_check_cache_checked_at ON tld_check_cache(checked_at)');
  if (!hasObject.get('index', 'idx_sibling_tld_status_checked_at'))
    db.exec('CREATE INDEX IF NOT EXISTS idx_sibling_tld_status_checked_at ON sibling_tld_status(checked_at)');
  if (!db.prepare('PRAGMA table_info(cctld_index_state)').all().some(column => column.name === 'source_tail_rows'))
    db.exec('ALTER TABLE cctld_index_state ADD COLUMN source_tail_rows INTEGER');

  const prior = db.prepare('SELECT * FROM cctld_index_state WHERE singleton = 1').get();
  // The newest evidence time, and how many rows carry a time at or after the one
  // already projected. A row written later with that same timestamp changes the
  // count, so nothing new is missed; both reads use the checked_at indexes.
  const readSource = db.prepare(`
    SELECT MAX(max_checked_at) AS maxCheckedAt, SUM(tail_rows) AS tailRows FROM (
      SELECT (SELECT MAX(checked_at) FROM tld_check_cache) AS max_checked_at,
             (SELECT COUNT(*) FROM tld_check_cache WHERE checked_at >= @since) AS tail_rows
      UNION ALL
      SELECT (SELECT MAX(checked_at) FROM sibling_tld_status) AS max_checked_at,
             (SELECT COUNT(*) FROM sibling_tld_status WHERE checked_at >= @since) AS tail_rows
    )
  `);
  // Before the first projection there is no prior time to count from.
  const NO_TAIL = '\uffff';
  const source = readSource.get({ since: prior?.source_max_checked_at || NO_TAIL });
  const tailRowsAt = maxCheckedAt => readSource.get({ since: maxCheckedAt || NO_TAIL }).tailRows || 0;
  const indexEmpty = !db.prepare('SELECT 1 FROM cctld_taken_idx LIMIT 1').get();
  const fullRebuildDue = !prior || indexEmpty || !prior.rebuilt_at ||
    (nowMs - new Date(`${prior.rebuilt_at}Z`).getTime()) > 24 * 60 * 60 * 1000;
  // The whole-table row count is only taken where the tables are read anyway.
  const countSourceRows = () => db.prepare(`
    SELECT (SELECT COUNT(*) FROM tld_check_cache) + (SELECT COUNT(*) FROM sibling_tld_status) AS n
  `).get().n;

  const writeFullState = db.prepare(`
    INSERT INTO cctld_index_state (
      singleton, source_rows, source_max_checked_at, source_tail_rows, rebuilt_at, refreshed_at
    ) VALUES (1, @rows, @maxCheckedAt, @tailRows, datetime('now'), datetime('now'))
    ON CONFLICT(singleton) DO UPDATE SET
      source_rows = excluded.source_rows,
      source_max_checked_at = excluded.source_max_checked_at,
      source_tail_rows = excluded.source_tail_rows,
      rebuilt_at = excluded.rebuilt_at,
      refreshed_at = excluded.refreshed_at
  `);

  // The state is read BEFORE the projection starts. A source row written while
  // the chunks run carries a checked_at at or after this point, so it changes
  // either the newest time or the count at that time, and the next run projects
  // it. Nothing is missed by releasing the write lock between chunks.
  const before = readSource.get({ since: NO_TAIL });
  const stateAtStart = { maxCheckedAt: before.maxCheckedAt, tailRows: tailRowsAt(before.maxCheckedAt) };
  prepareChunkTables(db);

  if (fullRebuildDue && indexEmpty) {
    // First build only (fresh volume). Readers treat an extension as indexed as
    // soon as it has one row, so an empty index must become complete in one
    // step. The source tables are small or absent whenever this path runs.
    const rebuild = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
        SELECT je.value, tc.base_name
        FROM tld_check_cache tc, json_each(tc.taken_json) je
        WHERE je.value LIKE '.%'
      `).run().changes;
      const focusedInserted = db.prepare(`
        INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
        SELECT tld, base_name FROM sibling_tld_status WHERE status = 'taken'
      `).run().changes;
      const now = readSource.get({ since: NO_TAIL });
      const rows = countSourceRows();
      writeFullState.run({ rows, maxCheckedAt: now.maxCheckedAt, tailRows: tailRowsAt(now.maxCheckedAt) });
      return { rows, inserted: inserted + focusedInserted };
    }).immediate;
    const rebuilt = rebuild();
    return { mode: 'full', sourceRows: rebuilt.rows, inserted: rebuilt.inserted, writeTransactions: 1 };
  }

  if (fullRebuildDue) {
    // Daily re-projection of every label. It walks the labels of both sources
    // AND of the index itself in key order, so a label that has left both
    // sources loses its index rows too. The index is never emptied: readers
    // keep a complete projection throughout.
    const pickNext = db.prepare(`
      INSERT INTO temp.cctld_chunk_bases (base_name)
      SELECT base_name FROM (
        SELECT base_name FROM (SELECT base_name FROM tld_check_cache WHERE base_name > @cursor ORDER BY base_name LIMIT @limit)
        UNION
        SELECT base_name FROM (SELECT DISTINCT base_name FROM sibling_tld_status WHERE base_name > @cursor ORDER BY base_name LIMIT @limit)
        UNION
        SELECT base_name FROM (SELECT DISTINCT base_name FROM cctld_taken_idx INDEXED BY idx_cctld_taken_base WHERE base_name > @cursor ORDER BY base_name LIMIT @limit)
      ) ORDER BY base_name LIMIT @limit
    `);
    const totals = projectInChunks(db, cursor => pickNext.run({ cursor, limit: chunkBases }).changes, { pauseMs, onChunkCommitted });
    const rows = countSourceRows();
    writeFullState.run({ rows, ...stateAtStart });
    return { mode: 'full', sourceRows: rows, inserted: totals.inserted, writeTransactions: totals.writeTransactions, maxWriteMs: totals.maxWriteMs };
  }

  if (source.maxCheckedAt !== prior.source_max_checked_at || (source.tailRows || 0) !== prior.source_tail_rows) {
    const changed = db.prepare(`
      INSERT OR IGNORE INTO temp.cctld_changed_bases (base_name)
      SELECT base_name FROM tld_check_cache
      WHERE checked_at >= @since
      UNION
      SELECT base_name FROM sibling_tld_status
      WHERE checked_at >= @since
    `).run({ since: prior.source_max_checked_at || '1970-01-01 00:00:00' }).changes;
    const pickNext = db.prepare(`
      INSERT INTO temp.cctld_chunk_bases (base_name)
      SELECT base_name FROM temp.cctld_changed_bases WHERE base_name > @cursor ORDER BY base_name LIMIT @limit
    `);
    const totals = projectInChunks(db, cursor => pickNext.run({ cursor, limit: chunkBases }).changes, { pauseMs, onChunkCommitted });
    db.prepare(`
      UPDATE cctld_index_state SET
        source_max_checked_at = @maxCheckedAt,
        source_tail_rows = @tailRows,
        refreshed_at = datetime('now')
      WHERE singleton = 1
    `).run(stateAtStart);
    return { mode: 'incremental', sourceRows: prior.source_rows, changed, inserted: totals.inserted, writeTransactions: totals.writeTransactions, maxWriteMs: totals.maxWriteMs };
  }

  // A current materialized projection is a read-only success. The old five-minute
  // heartbeat write created needless contention with every unrelated inventory and
  // enrichment writer even though no projection data had changed.
  return { mode: 'current', sourceRows: prior.source_rows };
}

module.exports = { refreshCctldIndex, PROJECT_FROM_CHECK_CACHE_SQL, PROJECT_FROM_SIBLING_STATUS_SQL };

if (require.main === module) {
  const db = new Database(path.join(dataDir, 'domains.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 60000');
  try {
    console.log(JSON.stringify(refreshCctldIndex(db)));
  } finally {
    db.close();
  }
}
