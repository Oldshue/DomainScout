/**
 * Zone File Indexer
 *
 * Pre-indexes CZDS zone files into a persistent SQLite database so that
 * name research queries are instant SQL lookups instead of real-time greps.
 *
 * expireddomains.net works exactly this way — they maintain a pre-built index
 * of every name registered across every TLD zone file.
 *
 * Schema:
 *   zone_names(base_name, tld) — one row per registered (name, tld) pair
 *   zone_indexed_tlds(tld, file_date, record_count) — tracks what's been indexed
 *
 * .com (~12 GB decompressed) is indexed via streaming gunzip — the compressed
 * .zone.gz file is kept on disk (~3 GB) and piped directly through zlib without
 * ever writing the decompressed file. All other TLDs use plain .zone files.
 */

const path     = require('path');
const fs       = require('fs');
const zlib     = require('zlib');
const readline = require('readline');
const Database = require('better-sqlite3');

const DATA_BASE      = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const ZONE_INDEX_DB  = path.join(DATA_BASE, 'zone_index.db');
const ZONES_DIR      = path.join(DATA_BASE, 'zones');
const MAX_INDEX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB — skips decompressed files above this
const BATCH_SIZE     = 20_000;
const MAX_DIFF_NAMES = Number(process.env.CZDS_DIFF_RETURN_LIMIT || 50_000);
const MAX_TREND_NAMES = Number(process.env.CZDS_TREND_RETURN_LIMIT || 200_000);

let _db = null;

function cleanTld(tld) {
  return String(tld || '').toLowerCase().replace(/^\./, '');
}

function dotTld(tld) {
  return `.${cleanTld(tld)}`;
}

function reverseName(name) {
  return name.split('').reverse().join('');
}

function emptyIndexResult(tld, fileDate, status = 'skipped') {
  return {
    status,
    tld: cleanTld(tld),
    fileDate,
    count: 0,
    addedCount: 0,
    droppedCount: 0,
    addedNames: [],
    droppedNames: [],
    returnedAddedCount: 0,
    returnedDroppedCount: 0,
    hadPrevious: false,
  };
}

function normalizeIndexResult(result, tld = '', fileDate = null) {
  if (typeof result === 'number') {
    return {
      ...emptyIndexResult(tld, fileDate, result === 0 ? 'current' : (result > 0 ? 'indexed' : 'error')),
      count: Math.max(0, result),
    };
  }
  return result || emptyIndexResult(tld, fileDate);
}

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(ZONE_INDEX_DB), { recursive: true });
  _db = new Database(ZONE_INDEX_DB);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -64000'); // 64 MB cache
  _db.pragma('temp_store = memory');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS zone_indexed_tlds (
      tld          TEXT PRIMARY KEY,
      file_date    TEXT NOT NULL,
      record_count INTEGER
    );

    -- Daily registration counts per TLD (for growth % trends)
    CREATE TABLE IF NOT EXISTS zone_daily_stats (
      tld           TEXT NOT NULL,
      stat_date     TEXT NOT NULL,
      total_count   INTEGER,
      new_count     INTEGER,
      dropped_count INTEGER,
      PRIMARY KEY (tld, stat_date)
    );

    -- Base names registered across multiple TLDs on the same day (trending keywords)
    CREATE TABLE IF NOT EXISTS zone_keyword_trends (
      keyword    TEXT NOT NULL,
      trend_date TEXT NOT NULL,
      tld_count  INTEGER,
      PRIMARY KEY (keyword, trend_date)
    );
    CREATE INDEX IF NOT EXISTS idx_kt_date ON zone_keyword_trends(trend_date, tld_count);

    -- Search summary: one row per base name. This is the fast lookup layer
    -- for research views; zone_names remains the source of truth.
    CREATE TABLE IF NOT EXISTS name_summary (
      base_name     TEXT PRIMARY KEY,
      base_name_rev TEXT NOT NULL,
      tld_count     INTEGER NOT NULL,
      tld_list      TEXT NOT NULL,
      has_com       INTEGER NOT NULL DEFAULT 0,
      has_ai        INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_ns_count
      ON name_summary(tld_count DESC, base_name);
    CREATE INDEX IF NOT EXISTS idx_ns_base_rev
      ON name_summary(base_name_rev);

    CREATE TABLE IF NOT EXISTS name_summary_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: if zone_names is missing base_name_rev (created before suffix support),
  // drop and recreate it — zone files on disk will be re-indexed automatically.
  const cols = _db.prepare("PRAGMA table_info(zone_names)").all().map(c => c.name);
  if (!cols.includes('base_name_rev')) {
    console.log('[ZoneIndex] Migrating zone_names table to add base_name_rev column — will reindex all zone files');
    _db.exec(`
      DROP TABLE IF EXISTS zone_names;
      DELETE FROM zone_indexed_tlds;
    `);
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS zone_names (
      base_name     TEXT NOT NULL,
      base_name_rev TEXT NOT NULL,
      tld           TEXT NOT NULL,
      PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_zn_base     ON zone_names(base_name);
    CREATE INDEX IF NOT EXISTS idx_zn_base_rev ON zone_names(base_name_rev);
    CREATE INDEX IF NOT EXISTS idx_zn_tld      ON zone_names(tld);
  `);
  _db.exec('DROP TABLE IF EXISTS zone_names_next');

  // If zone_names is empty but we have "indexed" TLD records, the previous run had
  // a parser bug (FQDN format) that produced 0 names. Clear tracking so files reindex.
  const nameCount = _db.prepare('SELECT COUNT(*) as n FROM zone_names').get().n;
  const tldCount  = _db.prepare('SELECT COUNT(*) as n FROM zone_indexed_tlds').get().n;
  if (nameCount === 0 && tldCount > 0) {
    console.log('[ZoneIndex] zone_names empty but indexed_tlds has records — clearing to force reindex with FQDN fix');
    _db.prepare('DELETE FROM zone_indexed_tlds').run();
  }

  return _db;
}

function createDirectInserter(db, tldWithDot) {
  const insertStmt = db.prepare('INSERT OR IGNORE INTO zone_names (base_name, base_name_rev, tld) VALUES (?, ?, ?)');
  return db.transaction((rows) => {
    let changes = 0;
    for (const [name, rev] of rows) changes += insertStmt.run(name, rev, tldWithDot).changes;
    return changes;
  });
}

function createStagingInserter(db) {
  const insertStmt = db.prepare('INSERT OR IGNORE INTO zone_names_next (base_name, base_name_rev) VALUES (?, ?)');
  return db.transaction((rows) => {
    let changes = 0;
    for (const [name, rev] of rows) changes += insertStmt.run(name, rev).changes;
    return changes;
  });
}

function prepareStagingTable(db) {
  db.exec(`
    DROP TABLE IF EXISTS zone_names_next;
    CREATE TABLE zone_names_next (
      base_name     TEXT PRIMARY KEY,
      base_name_rev TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

function prepareSummaryAffectedTable(db, tldWithDot) {
  db.exec(`
    DROP TABLE IF EXISTS name_summary_affected;
    CREATE TABLE name_summary_affected (
      base_name TEXT PRIMARY KEY
    ) WITHOUT ROWID;
  `);
  db.prepare(`
    INSERT OR IGNORE INTO name_summary_affected (base_name)
    SELECT base_name FROM zone_names WHERE tld = ?
  `).run(tldWithDot);
  db.prepare(`
    INSERT OR IGNORE INTO name_summary_affected (base_name)
    SELECT base_name FROM zone_names_next
  `).run();
}

function getSummaryMetaCounts(db) {
  const rows = db.prepare(`
    SELECT key, value FROM name_summary_meta
    WHERE key IN ('summary_names', 'summary_hits')
  `).all();
  const meta = Object.fromEntries(rows.map(r => [r.key, Number(r.value)]));
  if (!Number.isFinite(meta.summary_names) || !Number.isFinite(meta.summary_hits)) return null;
  return { names: meta.summary_names, hits: meta.summary_hits };
}

function setSummaryMetaCounts(db, names, hits) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO name_summary_meta (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
  `);
  stmt.run('summary_names', String(Math.max(0, Number(names) || 0)));
  stmt.run('summary_hits', String(Math.max(0, Number(hits) || 0)));
}

function bumpSummaryMetaCounts(db, namesDelta, hitsDelta) {
  const current = getSummaryMetaCounts(db);
  if (!current) return;
  setSummaryMetaCounts(
    db,
    current.names + (Number(namesDelta) || 0),
    current.hits + (Number(hitsDelta) || 0),
  );
}

function addNewTldToNameSummary(db, tldWithDot) {
  const hasCom = tldWithDot === '.com' ? 1 : 0;
  const hasAi = tldWithDot === '.ai' ? 1 : 0;
  const delta = db.prepare(`
    SELECT
      COUNT(*) AS hits,
      COALESCE(SUM(CASE WHEN s.base_name IS NULL THEN 1 ELSE 0 END), 0) AS names
    FROM zone_names_next n
    LEFT JOIN name_summary s ON s.base_name = n.base_name
  `).get();
  db.prepare(`
    INSERT INTO name_summary (base_name, base_name_rev, tld_count, tld_list, has_com, has_ai, updated_at)
    SELECT base_name, base_name_rev, 1, ?, ?, ?, datetime('now')
    FROM zone_names_next
    WHERE true
    ON CONFLICT(base_name) DO UPDATE SET
      tld_count = name_summary.tld_count +
        CASE WHEN instr(',' || name_summary.tld_list || ',', ',' || excluded.tld_list || ',') = 0 THEN 1 ELSE 0 END,
      tld_list = CASE
        WHEN instr(',' || name_summary.tld_list || ',', ',' || excluded.tld_list || ',') = 0
          THEN name_summary.tld_list || ',' || excluded.tld_list
        ELSE name_summary.tld_list
      END,
      has_com = CASE WHEN excluded.has_com = 1 THEN 1 ELSE name_summary.has_com END,
      has_ai = CASE WHEN excluded.has_ai = 1 THEN 1 ELSE name_summary.has_ai END,
      updated_at = datetime('now')
  `).run(tldWithDot, hasCom, hasAi);
  bumpSummaryMetaCounts(db, delta?.names || 0, delta?.hits || 0);
}

function addIndexedTldToNameSummary(db, tldWithDot) {
  const hasCom = tldWithDot === '.com' ? 1 : 0;
  const hasAi = tldWithDot === '.ai' ? 1 : 0;
  db.prepare(`
    INSERT INTO name_summary (base_name, base_name_rev, tld_count, tld_list, has_com, has_ai, updated_at)
    SELECT base_name, base_name_rev, 1, ?, ?, ?, datetime('now')
    FROM zone_names
    WHERE tld = ?
    ON CONFLICT(base_name) DO UPDATE SET
      tld_count = name_summary.tld_count +
        CASE WHEN instr(',' || name_summary.tld_list || ',', ',' || excluded.tld_list || ',') = 0 THEN 1 ELSE 0 END,
      tld_list = CASE
        WHEN instr(',' || name_summary.tld_list || ',', ',' || excluded.tld_list || ',') = 0
          THEN name_summary.tld_list || ',' || excluded.tld_list
        ELSE name_summary.tld_list
      END,
      has_com = CASE WHEN excluded.has_com = 1 THEN 1 ELSE name_summary.has_com END,
      has_ai = CASE WHEN excluded.has_ai = 1 THEN 1 ELSE name_summary.has_ai END,
      updated_at = datetime('now')
  `).run(tldWithDot, hasCom, hasAi, tldWithDot);
}

function refreshNameSummaryForAffected(db) {
  const before = db.prepare(`
    SELECT COUNT(*) AS names, COALESCE(SUM(tld_count), 0) AS hits
    FROM name_summary
    WHERE base_name IN (SELECT base_name FROM name_summary_affected)
  `).get();
  db.transaction(() => {
    db.prepare(`
      DELETE FROM name_summary
      WHERE base_name IN (SELECT base_name FROM name_summary_affected)
    `).run();
    db.prepare(`
      INSERT INTO name_summary (base_name, base_name_rev, tld_count, tld_list, has_com, has_ai, updated_at)
      SELECT
        base_name,
        MIN(base_name_rev) AS base_name_rev,
        COUNT(*) AS tld_count,
        GROUP_CONCAT(tld) AS tld_list,
        MAX(CASE WHEN tld = '.com' THEN 1 ELSE 0 END) AS has_com,
        MAX(CASE WHEN tld = '.ai' THEN 1 ELSE 0 END) AS has_ai,
        datetime('now') AS updated_at
      FROM (
        SELECT z.base_name, z.base_name_rev, z.tld
        FROM zone_names z
        JOIN name_summary_affected a ON a.base_name = z.base_name
        ORDER BY z.base_name, z.tld
      )
      GROUP BY base_name
    `).run();
    const after = db.prepare(`
      SELECT COUNT(*) AS names, COALESCE(SUM(tld_count), 0) AS hits
      FROM name_summary
      WHERE base_name IN (SELECT base_name FROM name_summary_affected)
    `).get();
    bumpSummaryMetaCounts(
      db,
      (after?.names || 0) - (before?.names || 0),
      (after?.hits || 0) - (before?.hits || 0),
    );
    db.prepare('DROP TABLE IF EXISTS name_summary_affected').run();
  })();
}

function collectDiffNames(db, direction, tldWithDot, limit) {
  if (direction === 'added') {
    return db.prepare(`
      SELECT n.base_name
      FROM zone_names_next n
      LEFT JOIN zone_names z
        ON z.base_name = n.base_name AND z.tld = ?
      WHERE z.base_name IS NULL
      ORDER BY n.base_name
      LIMIT ?
    `).all(tldWithDot, limit).map(r => r.base_name);
  }

  return db.prepare(`
    SELECT z.base_name
    FROM zone_names z
    LEFT JOIN zone_names_next n
      ON n.base_name = z.base_name
    WHERE z.tld = ? AND n.base_name IS NULL
    ORDER BY z.base_name
    LIMIT ?
  `).all(tldWithDot, limit).map(r => r.base_name);
}

async function streamZoneNames(input, tld, insertBatch, t0, slowLog = false) {
  const clean = cleanTld(tld);
  const suffix = `.${clean}`;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let batch = [];
  let inserted = 0;
  let parsed = 0;

  for await (const line of rl) {
    if (!line || line.charCodeAt(0) === 59 /* ; */ || line.charCodeAt(0) === 36 /* $ */) continue;
    const spaceIdx = line.indexOf(' ');
    const tabIdx   = line.indexOf('\t');
    const sepIdx   = spaceIdx < 0 ? tabIdx : (tabIdx < 0 ? spaceIdx : Math.min(spaceIdx, tabIdx));
    if (sepIdx < 1) continue;

    let name = line.slice(0, sepIdx).toLowerCase();
    if (name.charCodeAt(name.length - 1) === 46) name = name.slice(0, -1);
    if (name.endsWith(suffix)) name = name.slice(0, -(clean.length + 1));
    if (!name || name.includes('.') || name === clean) continue;

    batch.push([name, reverseName(name)]);
    parsed++;

    if (batch.length >= BATCH_SIZE) {
      inserted += insertBatch(batch);
      batch = [];
      await new Promise(r => setImmediate(r));
      if (slowLog && parsed % 5_000_000 === 0) {
        console.log(`[ZoneIndex] .${clean}: ${inserted.toLocaleString()} unique names so far (${((Date.now() - t0) / 60000).toFixed(1)} min)...`);
      }
    }
  }

  if (batch.length) inserted += insertBatch(batch);
  return inserted;
}

function finalizeStagedIndex(db, tld, fileDate, count, tldWithDot) {
  prepareSummaryAffectedTable(db, tldWithDot);

  const addedCount = db.prepare(`
    SELECT COUNT(*) AS n
    FROM zone_names_next n
    LEFT JOIN zone_names z
      ON z.base_name = n.base_name AND z.tld = ?
    WHERE z.base_name IS NULL
  `).get(tldWithDot).n;

  const droppedCount = db.prepare(`
    SELECT COUNT(*) AS n
    FROM zone_names z
    LEFT JOIN zone_names_next n
      ON n.base_name = z.base_name
    WHERE z.tld = ? AND n.base_name IS NULL
  `).get(tldWithDot).n;

  const addedNames = collectDiffNames(db, 'added', tldWithDot, Math.min(MAX_TREND_NAMES, addedCount));
  const droppedNames = collectDiffNames(db, 'dropped', tldWithDot, Math.min(MAX_DIFF_NAMES, droppedCount));

  db.transaction(() => {
    db.prepare('DELETE FROM zone_names WHERE tld = ?').run(tldWithDot);
    db.prepare(`INSERT INTO zone_names (base_name, base_name_rev, tld)
                SELECT base_name, base_name_rev, ? FROM zone_names_next`).run(tldWithDot);
    db.prepare('INSERT OR REPLACE INTO zone_indexed_tlds (tld, file_date, record_count) VALUES (?, ?, ?)').run(tld, fileDate, count);
    db.prepare(`
      INSERT OR REPLACE INTO zone_daily_stats (tld, stat_date, total_count, new_count, dropped_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(tld, fileDate, count, addedCount, droppedCount);
  })();
  refreshNameSummaryForAffected(db);
  db.prepare('DROP TABLE IF EXISTS zone_names_next').run();

  return {
    status: 'indexed',
    tld,
    fileDate,
    count,
    addedCount,
    droppedCount,
    addedNames,
    droppedNames,
    returnedAddedCount: addedNames.length,
    returnedDroppedCount: droppedNames.length,
    hadPrevious: true,
  };
}

function finalizeNewStagedIndex(db, tld, fileDate, count, tldWithDot) {
  db.transaction(() => {
    db.prepare('DELETE FROM zone_names WHERE tld = ?').run(tldWithDot);
    db.prepare(`INSERT INTO zone_names (base_name, base_name_rev, tld)
                SELECT base_name, base_name_rev, ? FROM zone_names_next`).run(tldWithDot);
    addNewTldToNameSummary(db, tldWithDot);
    db.prepare('INSERT OR REPLACE INTO zone_indexed_tlds (tld, file_date, record_count) VALUES (?, ?, ?)').run(tld, fileDate, count);
    db.prepare(`
      INSERT OR REPLACE INTO zone_daily_stats (tld, stat_date, total_count, new_count, dropped_count)
      VALUES (?, ?, ?, 0, 0)
    `).run(tld, fileDate, count);
    db.prepare('DROP TABLE IF EXISTS zone_names_next').run();
  })();

  return {
    ...emptyIndexResult(tld, fileDate, 'indexed'),
    count,
    hadPrevious: false,
  };
}

async function indexZoneStream(tldInput, filePath, { gzipped = false, maxPlainSize = false } = {}) {
  const tld = cleanTld(tldInput);
  const resultOnError = emptyIndexResult(tld, null, 'error');

  try {
    const stat = fs.statSync(filePath);
    if (maxPlainSize && stat.size > MAX_INDEX_SIZE) {
      console.log(`[ZoneIndex] .${tld} too large (${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB) - skipped`);
      return { ...resultOnError, status: 'skipped' };
    }

    const fileMatch = path.basename(filePath).match(gzipped
      ? /-(\d{4}-\d{2}-\d{2})\.zone\.gz$/
      : /-(\d{4}-\d{2}-\d{2})\.zone$/);
    const fileDate = fileMatch ? fileMatch[1] : null;
    if (!fileDate) return { ...resultOnError, status: 'skipped' };

    const db = getDb();
    const tldWithDot = dotTld(tld);
    const existing = db.prepare('SELECT file_date, record_count FROM zone_indexed_tlds WHERE tld = ?').get(tld);
    const hasRows = !!db.prepare('SELECT 1 FROM zone_names WHERE tld = ? LIMIT 1').get(tldWithDot);
    if (existing && existing.file_date === fileDate && (hasRows || existing.record_count === 0)) {
      return {
        ...emptyIndexResult(tld, fileDate, 'current'),
        count: existing.record_count || 0,
        hadPrevious: hasRows,
      };
    }

    const t0 = Date.now();
    const sizeLabel = gzipped
      ? `${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB compressed`
      : `${(stat.size / 1024 / 1024).toFixed(0)} MB`;
    console.log(`[ZoneIndex] Indexing .${tld} (${sizeLabel})${hasRows ? ' with indexed diff' : ''}...`);

    const useStaging = process.env.CZDS_UNSAFE_DIRECT_INDEX !== '1';
    let insertBatch;
    if (useStaging) {
      prepareStagingTable(db);
      insertBatch = createStagingInserter(db);
    } else {
      db.prepare('DELETE FROM zone_names WHERE tld = ?').run(tldWithDot);
      insertBatch = createDirectInserter(db, tldWithDot);
    }

    const input = gzipped
      ? fs.createReadStream(filePath).pipe(zlib.createGunzip())
      : fs.createReadStream(filePath);
    const count = await streamZoneNames(input, tld, insertBatch, t0, gzipped || stat.size > 512 * 1024 * 1024);

    let result;
    if (useStaging && hasRows && process.env.CZDS_DIFF_MODE !== 'off') {
      result = finalizeStagedIndex(db, tld, fileDate, count, tldWithDot);
      const clipped = result.droppedCount > result.returnedDroppedCount || result.addedCount > result.returnedAddedCount;
      console.log(
        `[ZoneIndex] .${tld}: ${count.toLocaleString()} names, ` +
        `${result.addedCount.toLocaleString()} added, ${result.droppedCount.toLocaleString()} dropped` +
        `${clipped ? ' (diff return capped)' : ''}`
      );
    } else if (useStaging) {
      result = finalizeNewStagedIndex(db, tld, fileDate, count, tldWithDot);
      console.log(`[ZoneIndex] .${tld}: ${count.toLocaleString()} unique names indexed`);
    } else {
      db.prepare('INSERT OR REPLACE INTO zone_indexed_tlds (tld, file_date, record_count) VALUES (?, ?, ?)').run(tld, fileDate, count);
      recordTldStats(tld, fileDate, count, 0, 0);
      result = {
        ...emptyIndexResult(tld, fileDate, 'indexed'),
        count,
        hadPrevious: false,
      };
      console.log(`[ZoneIndex] .${tld}: ${count.toLocaleString()} unique names indexed`);
    }

    console.log(`[ZoneIndex] .${tld}: done in ${((Date.now() - t0) / (gzipped ? 60000 : 1000)).toFixed(1)}${gzipped ? ' min' : 's'}`);
    try { fs.unlinkSync(filePath); console.log(`[ZoneIndex] .${tld}: zone file deleted to free disk space`); }
    catch (e) { console.warn(`[ZoneIndex] Could not delete ${filePath}:`, e.message); }
    return result;
  } catch (err) {
    console.error(`[ZoneIndex] Error indexing .${tld}:`, err.message);
    try { getDb().prepare('DROP TABLE IF EXISTS zone_names_next').run(); } catch (_) {}
    return resultOnError;
  }
}

/**
 * Index a single zone file. Idempotent and returns a structured result.
 */
async function indexZoneFile(tld, filePath) {
  return indexZoneStream(tld, filePath, { maxPlainSize: true });
}

/**
 * Index a gzipped zone file (.zone.gz) by streaming through gunzip, without
 * writing the decompressed file to disk.
 */
async function indexZoneFileGzipped(tld, gzPath) {
  return indexZoneStream(tld, gzPath, { gzipped: true });
}

// Prevent concurrent full-scan indexing runs
let _indexingRunning = false;

/**
 * Scan data/zones/ for zone files not yet in the index and index them.
 * Handles both plain .zone files and .zone.gz files (used for .com).
 * Designed to run in the background after server startup or after CZDS downloads.
 */
async function indexAllPendingZoneFiles() {
  if (_indexingRunning) return;
  _indexingRunning = true;

  try {
    if (!fs.existsSync(ZONES_DIR)) { return; }

    // Find latest file per TLD — handles both .zone and .zone.gz
    const filesByTld = {};
    for (const f of fs.readdirSync(ZONES_DIR)) {
      const m = f.match(/^([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})\.zone(\.gz)?$/);
      if (!m) continue;
      const [, tld, date, gz] = m;
      const isGzipped = !!gz;
      if (!filesByTld[tld] || date > filesByTld[tld].date)
        filesByTld[tld] = { date, path: path.join(ZONES_DIR, f), gzipped: isGzipped };
    }

    if (!Object.keys(filesByTld).length) {
      console.log('[ZoneIndex] No zone files found to index');
      return;
    }

    // Purge any old-date or non-latest zone files left on disk (e.g. from prior ENOSPC failures)
    for (const f of fs.readdirSync(ZONES_DIR)) {
      const m = f.match(/^([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})\.zone(\.gz)?$/);
      if (!m) continue;
      const [, tld, date] = m;
      const latest = filesByTld[tld];
      // If this file is not the latest for its TLD, delete it
      if (!latest || date !== latest.date) {
        const stale = path.join(ZONES_DIR, f);
        try { fs.unlinkSync(stale); console.log(`[ZoneIndex] Deleted stale zone file: ${f}`); }
        catch (e) { console.warn(`[ZoneIndex] Could not delete stale file ${f}:`, e.message); }
      }
    }

    const db = getDb();
    let newlyIndexed = 0;

    // Sort: plain .zone files first (small/fast), .gz files (large) last
    const entries = Object.entries(filesByTld).sort(([, a], [, b]) => {
      if (a.gzipped !== b.gzipped) return a.gzipped ? 1 : -1;
      try { return fs.statSync(a.path).size - fs.statSync(b.path).size; } catch (_) { return 0; }
    });

    for (const [tld, info] of entries) {
      const existing = db.prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
      if (existing && existing.file_date === info.date) continue;
      const result = normalizeIndexResult(info.gzipped
        ? await indexZoneFileGzipped(tld, info.path)
        : await indexZoneFile(tld, info.path), tld, info.date);
      if (result.status === 'indexed' && result.count > 0) newlyIndexed++;
    }

    const stats = getZoneIndexStats();
    console.log(`[ZoneIndex] Startup indexing done. ${stats.tlds} TLDs, ${stats.names.toLocaleString()} names total. Newly indexed: ${newlyIndexed}`);
  } catch (err) {
    console.error('[ZoneIndex] indexAllPendingZoneFiles error:', err.message);
  } finally {
    _indexingRunning = false;
  }
}

/**
 * Query the zone index for all base names starting with `prefix`.
 * Returns array of { base_name, tld_count } sorted by tld_count DESC.
 */
function queryZoneIndex(term, mode = 'prefix', options = {}) {
  try {
    const db = getDb();
    const t = term.toLowerCase();
    const upper = nextPrefix(t);
    const includeTldList = options.includeTldList !== false;
    const summaryFields = includeTldList
      ? 'base_name, tld_count, tld_list'
      : 'base_name, tld_count, NULL AS tld_list';
    const liveFields = includeTldList
      ? 'base_name, COUNT(*) AS tld_count, GROUP_CONCAT(tld) AS tld_list'
      : 'base_name, COUNT(*) AS tld_count, NULL AS tld_list';
    const summaryStatus = db.prepare("SELECT value FROM name_summary_meta WHERE key = 'status'").get()?.value;
    const summaryReady = summaryStatus === 'ready' && !!db.prepare('SELECT 1 FROM name_summary LIMIT 1').get();
    if (summaryReady) {
      if (mode === 'contains') {
        return db.prepare(`
          SELECT ${summaryFields}
          FROM name_summary
          WHERE base_name LIKE ?
          ORDER BY tld_count DESC, base_name ASC
        `).all(`%${t}%`);
      }
      if (mode === 'suffix') {
        const rev = t.split('').reverse().join('');
        const revUpper = nextPrefix(rev);
        return db.prepare(`
          SELECT ${summaryFields}
          FROM name_summary
          WHERE base_name_rev >= ? AND base_name_rev < ?
          ORDER BY tld_count DESC, base_name ASC
        `).all(rev, revUpper);
      }
      return db.prepare(`
        SELECT ${summaryFields}
        FROM name_summary
        WHERE base_name >= ? AND base_name < ?
        ORDER BY tld_count DESC, base_name ASC
      `).all(t, upper);
    }

    if (mode === 'contains') {
      return db.prepare(`
        SELECT ${liveFields}
        FROM zone_names
        WHERE base_name LIKE ?
        GROUP BY base_name
        ORDER BY tld_count DESC
      `).all(`%${t}%`);
    }
    if (mode === 'suffix') {
      const rev = t.split('').reverse().join('');
      const revUpper = nextPrefix(rev);
      return db.prepare(`
        SELECT ${liveFields}
        FROM zone_names
        WHERE base_name_rev >= ? AND base_name_rev < ?
        GROUP BY base_name
        ORDER BY tld_count DESC
      `).all(rev, revUpper);
    }
    return db.prepare(`
      SELECT ${liveFields}
      FROM zone_names
      WHERE base_name >= ? AND base_name < ?
      GROUP BY base_name
      ORDER BY tld_count DESC
    `).all(t, upper);
  } catch (err) {
    console.error('[ZoneIndex] queryZoneIndex error:', err.message);
    return [];
  }
}

function nextPrefix(s) {
  if (!s) return '\uffff';
  const chars = s.split('');
  chars[chars.length - 1] = String.fromCharCode(chars[chars.length - 1].charCodeAt(0) + 1);
  return chars.join('');
}

/**
 * Return counts of indexed TLDs and total names.
 */
function getZoneIndexStats() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS tlds, COALESCE(SUM(record_count), 0) AS names FROM zone_indexed_tlds').get();
    const summary = getSummaryMetaCounts(db) || { names: 0, hits: 0 };
    const tlds  = row?.tlds || 0;
    const names = row?.names || 0;
    return { tlds, names, summaryNames: summary.names || 0, summaryHits: summary.hits || 0 };
  } catch (_) {
    return { tlds: 0, names: 0, summaryNames: 0, summaryHits: 0 };
  }
}

let _summaryRebuildRunning = false;

function rebuildNameSummary() {
  if (_summaryRebuildRunning) return { ok: false, running: true };
  _summaryRebuildRunning = true;
  const db = getDb();
  const t0 = Date.now();
  try {
    console.log('[NameSummary] Rebuilding incrementally from indexed TLDs...');
    db.prepare(`
      INSERT OR REPLACE INTO name_summary_meta (key, value, updated_at)
      VALUES ('status', 'building', datetime('now'))
    `).run();
    db.prepare('DELETE FROM name_summary').run();
    setSummaryMetaCounts(db, 0, 0);

    const tlds = db.prepare(`
      SELECT tld, record_count FROM zone_indexed_tlds
      ORDER BY record_count ASC
    `).all();
    let processed = 0;
    let summaryNames = 0;
    let summaryHits = 0;
    for (const row of tlds) {
      const dot = dotTld(row.tld);
      db.transaction(() => {
        addIndexedTldToNameSummary(db, dot);
        db.prepare(`
          INSERT OR REPLACE INTO name_summary_meta (key, value, updated_at)
          VALUES ('processed_tlds', ?, datetime('now'))
        `).run(String(processed + 1));
      })();
      processed++;
      if (processed % 10 === 0 || processed === tlds.length) {
        const partial = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tld_count), 0) AS h FROM name_summary').get();
        summaryNames = Number(partial.n || 0);
        summaryHits = Number(partial.h || 0);
        console.log(`[NameSummary] ${processed}/${tlds.length} TLDs, ${summaryNames.toLocaleString()} names, ${summaryHits.toLocaleString()} hits`);
      }
    }

    db.transaction(() => {
      setSummaryMetaCounts(db, summaryNames, summaryHits);
      db.prepare(`
        INSERT OR REPLACE INTO name_summary_meta (key, value, updated_at)
        VALUES ('status', 'ready', datetime('now'))
      `).run();
      db.prepare(`
        INSERT OR REPLACE INTO name_summary_meta (key, value, updated_at)
        VALUES ('rebuilt_at', datetime('now'), datetime('now'))
      `).run();
    })();
    const stats = getZoneIndexStats();
    console.log(`[NameSummary] Ready: ${stats.summaryNames.toLocaleString()} names / ${stats.summaryHits.toLocaleString()} TLD hits in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ok: true, ...stats };
  } catch (err) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO name_summary_meta (key, value, updated_at)
        VALUES ('status', 'error', datetime('now'))
      `).run();
    } catch (_) {}
    console.error('[NameSummary] rebuild error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    _summaryRebuildRunning = false;
  }
}

/**
 * Record daily stats for a TLD (total registrations, new, dropped).
 * Called by czds.js after each zone file diff.
 */
function recordTldStats(tld, date, totalCount, newCount, droppedCount) {
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO zone_daily_stats (tld, stat_date, total_count, new_count, dropped_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(tld, date, totalCount, newCount, droppedCount);
  } catch (err) {
    console.error('[ZoneTrends] recordTldStats error:', err.message);
  }
}

/**
 * Record trending keywords from new registrations.
 * newRegMap: Map<baseName, Set<'.tld'>> — accumulated across all TLDs for one day.
 * Stores only base names registered in 2+ TLDs (genuine multi-TLD interest).
 */
function recordKeywordTrends(newRegMap, date) {
  try {
    const db = getDb();
    // Clear today's data before writing fresh (idempotent)
    db.prepare('DELETE FROM zone_keyword_trends WHERE trend_date = ?').run(date);

    const insert = db.prepare(
      'INSERT OR REPLACE INTO zone_keyword_trends (keyword, trend_date, tld_count) VALUES (?, ?, ?)'
    );
    const insertMany = db.transaction((rows) => {
      for (const [keyword, tldCount] of rows) insert.run(keyword, date, tldCount);
    });

    // Only keep names registered in 2+ TLDs, sorted by tld_count, top 5000
    const rows = [...newRegMap.entries()]
      .filter(([, tlds]) => tlds.size >= 2)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 5000)
      .map(([kw, tlds]) => [kw, tlds.size]);

    if (rows.length) insertMany(rows);
    console.log(`[ZoneTrends] ${rows.length} trending keywords recorded for ${date}`);
  } catch (err) {
    console.error('[ZoneTrends] recordKeywordTrends error:', err.message);
  }
}

function getLatestTrendDate(db) {
  return db.prepare(`
    SELECT stat_date
    FROM zone_daily_stats
    ORDER BY stat_date DESC
    LIMIT 1
  `).get()?.stat_date || null;
}

function getPreviousTrendDate(db, latestDate) {
  if (!latestDate) return null;
  return db.prepare(`
    SELECT stat_date
    FROM zone_daily_stats
    WHERE stat_date < ?
    ORDER BY stat_date DESC
    LIMIT 1
  `).get(latestDate)?.stat_date || null;
}

/**
 * Get TLD growth trends from the latest available CZDS snapshot.
 * If there is no previous snapshot yet, return a baseline inventory so the UI
 * remains useful while making it clear that real growth starts on the next run.
 */
function getTldTrends(limit = 100) {
  try {
    const db = getDb();
    const latestDate = getLatestTrendDate(db);
    if (!latestDate) return [];

    const previousDate = getPreviousTrendDate(db, latestDate);
    if (!previousDate) {
      return db.prepare(`
        SELECT
          tld,
          record_count AS today_total,
          NULL AS yesterday_total,
          0 AS new_count,
          0 AS dropped_count,
          0.0 AS growth_pct,
          file_date AS stat_date,
          NULL AS comparison_date,
          1 AS baseline
        FROM zone_indexed_tlds
        WHERE record_count > 0
        ORDER BY record_count DESC, tld ASC
        LIMIT ?
      `).all(limit);
    }

    return db.prepare(`
      SELECT
        t.tld,
        t.total_count   AS today_total,
        y.total_count   AS yesterday_total,
        COALESCE(t.new_count, MAX(t.total_count - y.total_count, 0), 0) AS new_count,
        COALESCE(t.dropped_count, MAX(y.total_count - t.total_count, 0), 0) AS dropped_count,
        ROUND(100.0 * (CAST(t.total_count AS REAL) - y.total_count) / y.total_count, 2) AS growth_pct,
        t.stat_date,
        y.stat_date AS comparison_date,
        0 AS baseline
      FROM zone_daily_stats t
      JOIN zone_daily_stats y
        ON t.tld = y.tld AND y.stat_date = ?
      WHERE t.stat_date = ?
        AND y.total_count > 0
      ORDER BY growth_pct DESC, new_count DESC, today_total DESC
      LIMIT ?
    `).all(previousDate, latestDate, limit);
  } catch (err) {
    console.error('[ZoneTrends] getTldTrends error:', err.message);
    return [];
  }
}

/**
 * Get trending keywords for today (or most recent date available).
 * Returns array of { keyword, trend_date, tld_count }.
 */
function getKeywordTrends(limit = 200) {
  try {
    const db = getDb();
    // Use most recent date that has data
    const latest = db.prepare(
      'SELECT trend_date FROM zone_keyword_trends ORDER BY trend_date DESC LIMIT 1'
    ).get();
    if (latest) {
      return db.prepare(`
        SELECT keyword, trend_date, tld_count, 'daily-diff' AS source
        FROM zone_keyword_trends
        WHERE trend_date = ?
        ORDER BY tld_count DESC, keyword ASC
        LIMIT ?
      `).all(latest.trend_date, limit);
    }

    // Baseline fallback: until a second CZDS run exists, show the terms with
    // the broadest current TLD coverage from the name summary.
    const summaryReady = db.prepare("SELECT value FROM name_summary_meta WHERE key = 'status'").get()?.value === 'ready';
    if (!summaryReady) return [];
    const latestStatDate = getLatestTrendDate(db) || new Date().toISOString().slice(0, 10);
    return db.prepare(`
      SELECT base_name AS keyword, ? AS trend_date, tld_count, 'coverage-baseline' AS source
      FROM name_summary
      WHERE tld_count >= 2
        AND LENGTH(base_name) BETWEEN 2 AND 48
        AND base_name NOT LIKE '%--%'
      ORDER BY tld_count DESC, base_name ASC
      LIMIT ?
    `).all(latestStatDate, limit);
  } catch (err) {
    console.error('[ZoneTrends] getKeywordTrends error:', err.message);
    return [];
  }
}

/**
 * Check whether any trend data exists yet.
 */
function hasTrendData() {
  try {
    const db = getDb();
    return db.prepare('SELECT 1 FROM zone_daily_stats LIMIT 1').get() != null ||
      db.prepare('SELECT 1 FROM zone_indexed_tlds LIMIT 1').get() != null ||
      db.prepare('SELECT 1 FROM name_summary LIMIT 1').get() != null;
  } catch (_) {
    return false;
  }
}

/**
 * Return the Set of TLDs currently covered by the zone index (with leading dot).
 * Used to compute the "gap" — TLDs that need live DNS checks because zone files
 * haven't been approved/downloaded yet.
 */
function getIndexedTldSet() {
  try {
    const rows = getDb().prepare('SELECT tld FROM zone_indexed_tlds').all();
    // zone_indexed_tlds.tld stores without dot (e.g. 'xyz'), zone_names.tld stores with dot
    return new Set(rows.map(r => '.' + r.tld));
  } catch (_) {
    return new Set();
  }
}

/**
 * Return the list of TLDs a base name is registered in (from zone index).
 * Returns array of tld strings like ['.xyz', '.design', '.ai'] sorted alpha.
 */
function getNameTlds(baseName) {
  try {
    const db = getDb();
    return db.prepare('SELECT tld FROM zone_names WHERE base_name = ? ORDER BY tld')
      .all(baseName.toLowerCase())
      .map(r => r.tld);
  } catch (err) {
    console.error('[ZoneIndex] getNameTlds error:', err.message);
    return [];
  }
}

function isTldIndexedForDate(tld, fileDate) {
  try {
    const row = getDb().prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
    return !!row && row.file_date === fileDate;
  } catch (_) {
    return false;
  }
}

module.exports = {
  indexZoneFile, indexZoneFileGzipped, indexAllPendingZoneFiles, queryZoneIndex, getZoneIndexStats,
  recordTldStats, recordKeywordTrends, getTldTrends, getKeywordTrends, hasTrendData,
  getNameTlds, getIndexedTldSet, isTldIndexedForDate, rebuildNameSummary,
};
