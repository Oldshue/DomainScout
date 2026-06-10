const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const db = require('./db');

const DATA_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const ZONE_INDEX_DB = path.join(DATA_BASE, 'zone_index.db');

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function openZoneDb() {
  if (!fs.existsSync(ZONE_INDEX_DB)) return null;
  const zdb = new Database(ZONE_INDEX_DB);
  zdb.pragma('busy_timeout = 30000');
  zdb.exec(`
    CREATE TABLE IF NOT EXISTS zone_drop_candidates (
      domain           TEXT NOT NULL,
      base_name        TEXT NOT NULL,
      tld              TEXT NOT NULL,
      drop_date        TEXT NOT NULL,
      source_file_date TEXT NOT NULL,
      tld_count        INTEGER NOT NULL DEFAULT 0,
      length           INTEGER NOT NULL DEFAULT 0,
      imported_at      TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain, drop_date)
    );
    CREATE INDEX IF NOT EXISTS idx_zdc_import
      ON zone_drop_candidates(imported_at, tld, tld_count DESC, length ASC, domain);
    CREATE INDEX IF NOT EXISTS idx_zdc_rank
      ON zone_drop_candidates(tld_count DESC, length ASC, domain);
  `);
  return zdb;
}

const upsertDroppedDomain = db.prepare(`
  INSERT INTO domains (
    domain, base_name, tld, stream, source,
    length, has_numbers, has_hyphens, drop_date,
    tlds_taken, tlds_checked_at
  )
  VALUES (
    @domain, @base_name, @tld, 'just-dropped', 'CZDS Zone Diff',
    @length, @has_numbers, @has_hyphens, @drop_date,
    @tlds_taken, @tlds_checked_at
  )
  ON CONFLICT(domain, stream) DO UPDATE SET
    source = excluded.source,
    drop_date = excluded.drop_date,
    length = excluded.length,
    has_numbers = excluded.has_numbers,
    has_hyphens = excluded.has_hyphens,
    tlds_taken = MAX(COALESCE(domains.tlds_taken, 0), COALESCE(excluded.tlds_taken, 0)),
    tlds_checked_at = COALESCE(domains.tlds_checked_at, excluded.tlds_checked_at)
`);

function importCzdsDropCandidates(options = {}) {
  const limit = positiveInt(options.limit || process.env.DOMAINSCOUT_CZDS_DROP_IMPORT_LIMIT, 20000, 1, 200000);
  const zdb = openZoneDb();
  if (!zdb) return { imported: 0, selected: 0, byTld: {}, error: 'zone_index.db not found' };

  try {
    const rows = zdb.prepare(`
      SELECT domain, base_name, tld, drop_date, tld_count, length
      FROM zone_drop_candidates
      WHERE imported_at IS NULL
      ORDER BY tld_count DESC, length ASC, domain ASC
      LIMIT @limit
    `).all({ limit });

    if (rows.length === 0) return { imported: 0, selected: 0, byTld: {} };

    let imported = 0;
    const byTld = {};
    const checkedAt = new Date().toISOString();
    db.transaction((items) => {
      for (const row of items) {
        const base = String(row.base_name || '').toLowerCase();
        const tld = String(row.tld || '').toLowerCase();
        imported += upsertDroppedDomain.run({
          domain: String(row.domain || '').toLowerCase(),
          base_name: base,
          tld,
          length: Number(row.length || base.length),
          has_numbers: /[0-9]/.test(base) ? 1 : 0,
          has_hyphens: base.includes('-') ? 1 : 0,
          drop_date: row.drop_date,
          tlds_taken: Number(row.tld_count || 0),
          tlds_checked_at: checkedAt,
        }).changes;
        byTld[tld] = (byTld[tld] || 0) + 1;
      }
    })(rows);

    const mark = zdb.prepare(`
      UPDATE zone_drop_candidates
      SET imported_at = datetime('now')
      WHERE domain = @domain AND drop_date = @drop_date
    `);
    zdb.transaction((items) => {
      for (const row of items) mark.run({ domain: row.domain, drop_date: row.drop_date });
    })(rows);

    return { imported, selected: rows.length, byTld };
  } finally {
    zdb.close();
  }
}

if (require.main === module) {
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? limitArg.split('=')[1] : undefined;
  console.log(JSON.stringify(importCzdsDropCandidates({ limit }), null, 2));
}

module.exports = {
  importCzdsDropCandidates,
};
