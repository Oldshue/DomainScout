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
 * Zone files larger than MAX_INDEX_SIZE (2 GB) are skipped to manage disk usage.
 * .com (~12 GB decompressed) is skipped; .net, .org, .xyz and all smaller TLDs
 * are indexed. tld_count from the index reflects coverage across indexed TLDs.
 */

const path    = require('path');
const fs      = require('fs');
const readline = require('readline');
const Database = require('better-sqlite3');

const ZONE_INDEX_DB  = path.join(__dirname, '../data/zone_index.db');
const ZONES_DIR      = path.join(__dirname, '../data/zones');
const MAX_INDEX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB — skips .com but includes .net/.org
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
    CREATE TABLE IF NOT EXISTS zone_names (
      base_name TEXT NOT NULL,
      tld       TEXT NOT NULL,
      PRIMARY KEY (base_name, tld)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_zn_base ON zone_names(base_name);

    CREATE TABLE IF NOT EXISTS zone_indexed_tlds (
      tld          TEXT PRIMARY KEY,
      file_date    TEXT NOT NULL,
      record_count INTEGER
    );
  `);
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

    const insertStmt  = db.prepare('INSERT OR IGNORE INTO zone_names (base_name, tld) VALUES (?, ?)');
    const insertBatch = db.transaction((rows) => {
      for (const [name, t] of rows) insertStmt.run(name, t);
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
      if (!name || name.includes('.') || name === tld) continue;
      batch.push([name, dotTld]);
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
    return count;

  } catch (err) {
    console.error(`[ZoneIndex] Error indexing .${tld}:`, err.message);
    return -1;
  }
}

// Prevent concurrent full-scan indexing runs
let _indexingRunning = false;

/**
 * Scan data/zones/ for zone files not yet in the index and index them.
 * Designed to run in the background after server startup or after CZDS downloads.
 */
async function indexAllPendingZoneFiles() {
  if (_indexingRunning) return;
  _indexingRunning = true;

  try {
    if (!fs.existsSync(ZONES_DIR)) { return; }

    // Find latest file per TLD
    const filesByTld = {};
    for (const f of fs.readdirSync(ZONES_DIR)) {
      const m = f.match(/^([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})\.zone$/);
      if (!m) continue;
      const [, tld, date] = m;
      if (!filesByTld[tld] || date > filesByTld[tld].date)
        filesByTld[tld] = { date, path: path.join(ZONES_DIR, f) };
    }

    if (!Object.keys(filesByTld).length) {
      console.log('[ZoneIndex] No zone files found to index');
      return;
    }

    const db = getDb();
    let newlyIndexed = 0;

    // Sort smallest files first so fast TLDs complete early
    const entries = Object.entries(filesByTld).sort(([, a], [, b]) => {
      try { return fs.statSync(a.path).size - fs.statSync(b.path).size; } catch (_) { return 0; }
    });

    for (const [tld, info] of entries) {
      const existing = db.prepare('SELECT file_date FROM zone_indexed_tlds WHERE tld = ?').get(tld);
      if (existing && existing.file_date === info.date) continue;
      const count = await indexZoneFile(tld, info.path);
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
function queryZoneIndex(prefix, limit = 4000) {
  try {
    const db = getDb();
    const p = prefix.toLowerCase();
    return db.prepare(`
      SELECT base_name, COUNT(*) AS tld_count
      FROM zone_names
      WHERE base_name LIKE ?
      GROUP BY base_name
      ORDER BY tld_count DESC
      LIMIT ?
    `).all(`${p}%`, limit);
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

module.exports = { indexZoneFile, indexAllPendingZoneFiles, queryZoneIndex, getZoneIndexStats };
