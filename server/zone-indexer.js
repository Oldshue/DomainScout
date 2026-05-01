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

let _db = null;

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

/**
 * Index a single zone file. Idempotent — skips if already indexed for same date.
 * Returns: record count inserted, 0 if already up-to-date, -1 if skipped/error.
 */
async function indexZoneFile(tld, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_INDEX_SIZE) {
      console.log(`[ZoneIndex] .${tld} too large (${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB) — skipped`);
      return -1;
    }

    const m = path.basename(filePath).match(/-(\d{4}-\d{2}-\d{2})\.zone$/);
    const fileDate = m ? m[1] : null;
    if (!fileDate) return -1;

    const db = getDb();

    // Already indexed for this date?
    const existing = db.prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
    if (existing && existing.file_date === fileDate) return 0;

    const t0 = Date.now();
    console.log(`[ZoneIndex] Indexing .${tld} (${(stat.size / 1024 / 1024).toFixed(0)} MB)...`);

    // Remove stale data for this TLD
    db.prepare('DELETE FROM zone_names WHERE tld = ?').run('.' + tld);

    const insertStmt  = db.prepare('INSERT OR IGNORE INTO zone_names (base_name, base_name_rev, tld) VALUES (?, ?, ?)');
    const insertBatch = db.transaction((rows) => {
      for (const [name, rev, t] of rows) insertStmt.run(name, rev, t);
    });

    const dotTld = '.' + tld;
    let batch = [];
    let count = 0;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line || line.charCodeAt(0) === 59 /* ; */ || line.charCodeAt(0) === 36 /* $ */) continue;
      const spaceIdx = line.indexOf(' ');
      const tabIdx   = line.indexOf('\t');
      const sepIdx   = spaceIdx < 0 ? tabIdx : (tabIdx < 0 ? spaceIdx : Math.min(spaceIdx, tabIdx));
      if (sepIdx < 1) continue;
      let name = line.slice(0, sepIdx).toLowerCase();
      if (name.charCodeAt(name.length - 1) === 46) name = name.slice(0, -1); // strip trailing dot
      // CZDS files use FQDNs: "example.capital" → strip TLD suffix → "example"
      if (name.endsWith(`.${tld}`)) name = name.slice(0, -(tld.length + 1));
      if (!name || name.includes('.') || name === tld) continue;
      batch.push([name, name.split('').reverse().join(''), dotTld]);
      count++;
      if (batch.length >= BATCH_SIZE) {
        insertBatch(batch);
        batch = [];
        // Yield to event loop periodically to avoid blocking
        await new Promise(r => setImmediate(r));
      }
    }
    if (batch.length) insertBatch(batch);

    db.prepare('INSERT OR REPLACE INTO zone_indexed_tlds (tld, file_date, record_count) VALUES (?, ?, ?)').run(tld, fileDate, count);
    console.log(`[ZoneIndex] .${tld}: ${count.toLocaleString()} names indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Delete raw zone file — data is in SQLite, raw file is no longer needed
    try { fs.unlinkSync(filePath); console.log(`[ZoneIndex] .${tld}: zone file deleted to free disk space`); }
    catch (e) { console.warn(`[ZoneIndex] Could not delete ${filePath}:`, e.message); }
    return count;

  } catch (err) {
    console.error(`[ZoneIndex] Error indexing .${tld}:`, err.message);
    return -1;
  }
}

/**
 * Index a gzipped zone file (.zone.gz) by streaming through gunzip — never
 * writes the decompressed file to disk. Used for .com which is ~12 GB decompressed.
 * Idempotent — skips if already indexed for the same date.
 */
async function indexZoneFileGzipped(tld, gzPath) {
  try {
    const stat = fs.statSync(gzPath);
    const m = path.basename(gzPath).match(/-(\d{4}-\d{2}-\d{2})\.zone\.gz$/);
    const fileDate = m ? m[1] : null;
    if (!fileDate) return -1;

    const db = getDb();
    const existing = db.prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
    if (existing && existing.file_date === fileDate) return 0;

    const t0 = Date.now();
    console.log(`[ZoneIndex] Indexing .${tld} from gzip (${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB compressed) — this will take a while...`);

    db.prepare('DELETE FROM zone_names WHERE tld = ?').run('.' + tld);

    const insertStmt  = db.prepare('INSERT OR IGNORE INTO zone_names (base_name, base_name_rev, tld) VALUES (?, ?, ?)');
    const insertBatch = db.transaction((rows) => {
      for (const [name, rev, t] of rows) insertStmt.run(name, rev, t);
    });

    const dotTld = '.' + tld;
    let batch = [];
    let count = 0;

    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
      input: fs.createReadStream(gzPath).pipe(gunzip),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line || line.charCodeAt(0) === 59 /* ; */ || line.charCodeAt(0) === 36 /* $ */) continue;
      const spaceIdx = line.indexOf(' ');
      const tabIdx   = line.indexOf('\t');
      const sepIdx   = spaceIdx < 0 ? tabIdx : (tabIdx < 0 ? spaceIdx : Math.min(spaceIdx, tabIdx));
      if (sepIdx < 1) continue;
      let name = line.slice(0, sepIdx).toLowerCase();
      if (name.charCodeAt(name.length - 1) === 46) name = name.slice(0, -1);
      if (name.endsWith(`.${tld}`)) name = name.slice(0, -(tld.length + 1));
      if (!name || name.includes('.') || name === tld) continue;
      batch.push([name, name.split('').reverse().join(''), dotTld]);
      count++;
      if (batch.length >= BATCH_SIZE) {
        insertBatch(batch);
        batch = [];
        await new Promise(r => setImmediate(r));
        if (count % 5_000_000 === 0) {
          console.log(`[ZoneIndex] .${tld}: ${count.toLocaleString()} names so far (${((Date.now() - t0) / 60000).toFixed(1)} min)...`);
        }
      }
    }
    if (batch.length) insertBatch(batch);

    db.prepare('INSERT OR REPLACE INTO zone_indexed_tlds (tld, file_date, record_count) VALUES (?, ?, ?)').run(tld, fileDate, count);
    console.log(`[ZoneIndex] .${tld}: ${count.toLocaleString()} names indexed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    // Delete raw gz file — data is in SQLite, raw file is no longer needed
    try { fs.unlinkSync(gzPath); console.log(`[ZoneIndex] .${tld}: gz file deleted to free disk space`); }
    catch (e) { console.warn(`[ZoneIndex] Could not delete ${gzPath}:`, e.message); }
    return count;

  } catch (err) {
    console.error(`[ZoneIndex] Error indexing .${tld} gzip:`, err.message);
    return -1;
  }
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
      const count = info.gzipped
        ? await indexZoneFileGzipped(tld, info.path)
        : await indexZoneFile(tld, info.path);
      if (count > 0) newlyIndexed++;
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
function queryZoneIndex(term, mode = 'prefix') {
  try {
    const db = getDb();
    const t = term.toLowerCase();
    if (mode === 'suffix') {
      const rev = t.split('').reverse().join('');
      return db.prepare(`
        SELECT base_name, COUNT(*) AS tld_count, GROUP_CONCAT(tld) AS tld_list
        FROM zone_names
        WHERE base_name_rev LIKE ?
        GROUP BY base_name
        ORDER BY tld_count DESC
      `).all(`${rev}%`);
    }
    return db.prepare(`
      SELECT base_name, COUNT(*) AS tld_count, GROUP_CONCAT(tld) AS tld_list
      FROM zone_names
      WHERE base_name LIKE ?
      GROUP BY base_name
      ORDER BY tld_count DESC
    `).all(`${t}%`);
  } catch (err) {
    console.error('[ZoneIndex] queryZoneIndex error:', err.message);
    return [];
  }
}

/**
 * Return counts of indexed TLDs and total names.
 */
function getZoneIndexStats() {
  try {
    const db = getDb();
    const tlds  = db.prepare('SELECT COUNT(*) AS n FROM zone_indexed_tlds').get()?.n || 0;
    const names = db.prepare('SELECT COUNT(*) AS n FROM zone_names').get()?.n || 0;
    return { tlds, names };
  } catch (_) {
    return { tlds: 0, names: 0 };
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

/**
 * Get TLD growth trends: today vs yesterday, sorted by % growth.
 * Returns array of { tld, today_total, yesterday_total, growth_pct, new_count, dropped_count }.
 */
function getTldTrends(limit = 100) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT
        t.tld,
        t.total_count   AS today_total,
        y.total_count   AS yesterday_total,
        t.new_count,
        t.dropped_count,
        ROUND(100.0 * (CAST(t.total_count AS REAL) - y.total_count) / y.total_count, 2) AS growth_pct
      FROM zone_daily_stats t
      JOIN zone_daily_stats y
        ON t.tld = y.tld AND y.stat_date = DATE(t.stat_date, '-1 day')
      WHERE t.stat_date = DATE('now')
        AND y.total_count > 0
      ORDER BY growth_pct DESC
      LIMIT ?
    `).all(limit);
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
    if (!latest) return [];
    return db.prepare(`
      SELECT keyword, trend_date, tld_count
      FROM zone_keyword_trends
      WHERE trend_date = ?
      ORDER BY tld_count DESC
      LIMIT ?
    `).all(latest.trend_date, limit);
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
    return db.prepare('SELECT 1 FROM zone_daily_stats LIMIT 1').get() != null;
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

module.exports = {
  indexZoneFile, indexZoneFileGzipped, indexAllPendingZoneFiles, queryZoneIndex, getZoneIndexStats,
  recordTldStats, recordKeywordTrends, getTldTrends, getKeywordTrends, hasTrendData,
  getNameTlds, getIndexedTldSet,
};
