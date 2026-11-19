'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(__dirname, '../data');
const db = new Database(path.join(dataDir, 'domains.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 60000');

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
  (Date.now() - new Date(`${prior.rebuilt_at}Z`).getTime()) > 24 * 60 * 60 * 1000;
// The whole-table row count is only taken where the tables are read anyway.
const countSourceRows = () => db.prepare(`
  SELECT (SELECT COUNT(*) FROM tld_check_cache) + (SELECT COUNT(*) FROM sibling_tld_status) AS n
`).get().n;

if (fullRebuildDue) {
  const rebuild = db.transaction(() => {
    db.exec('DELETE FROM cctld_taken_idx');
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
    // Read inside the write transaction: the state describes exactly the rows
    // this rebuild projected.
    const now = readSource.get({ since: NO_TAIL });
    const rows = countSourceRows();
    db.prepare(`
      INSERT INTO cctld_index_state (
        singleton, source_rows, source_max_checked_at, source_tail_rows, rebuilt_at, refreshed_at
      ) VALUES (1, @rows, @maxCheckedAt, @tailRows, datetime('now'), datetime('now'))
      ON CONFLICT(singleton) DO UPDATE SET
        source_rows = excluded.source_rows,
        source_max_checked_at = excluded.source_max_checked_at,
        source_tail_rows = excluded.source_tail_rows,
        rebuilt_at = excluded.rebuilt_at,
        refreshed_at = excluded.refreshed_at
    `).run({ rows, maxCheckedAt: now.maxCheckedAt, tailRows: tailRowsAt(now.maxCheckedAt) });
    return { rows, inserted: inserted + focusedInserted };
  }).immediate;
  const rebuilt = rebuild();
  console.log(JSON.stringify({ mode: 'full', sourceRows: rebuilt.rows, inserted: rebuilt.inserted }));
} else if (source.maxCheckedAt !== prior.source_max_checked_at || (source.tailRows || 0) !== prior.source_tail_rows) {
  const refresh = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS temp.cctld_changed_bases');
    db.exec('CREATE TEMP TABLE cctld_changed_bases (base_name TEXT PRIMARY KEY) WITHOUT ROWID');
    db.prepare(`
      INSERT OR IGNORE INTO cctld_changed_bases (base_name)
      SELECT base_name FROM tld_check_cache
      WHERE checked_at >= @since
      UNION
      SELECT base_name FROM sibling_tld_status
      WHERE checked_at >= @since
    `).run({ since: prior.source_max_checked_at || '1970-01-01 00:00:00' });
    const changed = db.prepare('SELECT COUNT(*) AS n FROM cctld_changed_bases').get().n;
    db.exec('DELETE FROM cctld_taken_idx WHERE base_name IN (SELECT base_name FROM cctld_changed_bases)');
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
      SELECT je.value, tc.base_name
      FROM tld_check_cache tc
      JOIN cctld_changed_bases changed ON changed.base_name = tc.base_name,
           json_each(tc.taken_json) je
      WHERE je.value LIKE '.%'
    `).run().changes;
    const focusedInserted = db.prepare(`
      INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
      SELECT s.tld, s.base_name
      FROM sibling_tld_status s
      JOIN cctld_changed_bases changed ON changed.base_name = s.base_name
      WHERE s.status = 'taken'
    `).run().changes;
    const now = readSource.get({ since: NO_TAIL });
    db.prepare(`
      UPDATE cctld_index_state SET
        source_max_checked_at = @maxCheckedAt,
        source_tail_rows = @tailRows,
        refreshed_at = datetime('now')
      WHERE singleton = 1
    `).run({ maxCheckedAt: now.maxCheckedAt, tailRows: tailRowsAt(now.maxCheckedAt) });
    return { changed, inserted: inserted + focusedInserted };
  }).immediate;
  console.log(JSON.stringify({ mode: 'incremental', sourceRows: prior.source_rows, ...refresh() }));
} else {
  // A current materialized projection is a read-only success. The old five-minute
  // heartbeat write created needless contention with every unrelated inventory and
  // enrichment writer even though no projection data had changed.
  console.log(JSON.stringify({ mode: 'current', sourceRows: prior.source_rows }));
}

db.close();
