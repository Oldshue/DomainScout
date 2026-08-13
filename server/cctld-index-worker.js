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
  CREATE TABLE IF NOT EXISTS cctld_index_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    source_rows INTEGER NOT NULL DEFAULT 0,
    source_max_checked_at TEXT,
    rebuilt_at TEXT,
    refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const source = db.prepare(`
  SELECT SUM(rows) AS rows, MAX(max_checked_at) AS maxCheckedAt FROM (
    SELECT COUNT(*) AS rows, MAX(checked_at) AS max_checked_at FROM tld_check_cache
    UNION ALL
    SELECT COUNT(*) AS rows, MAX(checked_at) AS max_checked_at FROM sibling_tld_status
  )
`).get();
const prior = db.prepare('SELECT * FROM cctld_index_state WHERE singleton = 1').get();
const indexRows = db.prepare('SELECT COUNT(*) AS n FROM cctld_taken_idx').get().n;
const fullRebuildDue = !prior || indexRows === 0 || !prior.rebuilt_at ||
  (Date.now() - new Date(`${prior.rebuilt_at}Z`).getTime()) > 24 * 60 * 60 * 1000;

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
    db.prepare(`
      INSERT INTO cctld_index_state (
        singleton, source_rows, source_max_checked_at, rebuilt_at, refreshed_at
      ) VALUES (1, @rows, @maxCheckedAt, datetime('now'), datetime('now'))
      ON CONFLICT(singleton) DO UPDATE SET
        source_rows = excluded.source_rows,
        source_max_checked_at = excluded.source_max_checked_at,
        rebuilt_at = excluded.rebuilt_at,
        refreshed_at = excluded.refreshed_at
    `).run(source);
    return inserted + focusedInserted;
  }).immediate;
  const inserted = rebuild();
  console.log(JSON.stringify({ mode: 'full', sourceRows: source.rows, inserted }));
} else if (source.rows !== prior.source_rows || source.maxCheckedAt !== prior.source_max_checked_at) {
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
    db.prepare(`
      UPDATE cctld_index_state SET
        source_rows = @rows,
        source_max_checked_at = @maxCheckedAt,
        refreshed_at = datetime('now')
      WHERE singleton = 1
    `).run(source);
    return { changed, inserted: inserted + focusedInserted };
  }).immediate;
  console.log(JSON.stringify({ mode: 'incremental', sourceRows: source.rows, ...refresh() }));
} else {
  // A current materialized projection is a read-only success. The old five-minute
  // heartbeat write created needless contention with every unrelated inventory and
  // enrichment writer even though no projection data had changed.
  console.log(JSON.stringify({ mode: 'current', sourceRows: source.rows, indexRows }));
}

db.close();
