#!/usr/bin/env node
/**
 * Keep domains.tlds_taken (the indexed column the EXTENSION list sorts by) equal to
 * what the page DISPLAYS — MAX(zone name_summary.tld_count, tld_check_cache.count) —
 * for ACTIVE auction rows. The server only materializes this at startup / CZDS
 * completion (gated by a "looks fresh" guard), so continuous cache+zone growth (the
 * focus-cctld service, scrapes, zone sync) leaves the sort column stale at 0 while the
 * display shows the real number. Sorting by extensions then sees all-equal 0 and falls
 * back to the alphabetical tiebreak — i.e. "sorting is wrong".
 *
 * Batched by rowid so each write transaction is short (does NOT hold the WAL writer
 * for minutes against the live worker / focus service). MATERIALIZE_LOOP=1 keeps it
 * resident, re-sweeping on an interval so the column stays fresh as enrichment fills in.
 */
const db = require('../server/db');
db.pragma('busy_timeout = 60000');
db.prepare('ATTACH DATABASE ? AS zi').run(require('path').join(__dirname, '../data/zone_index.db'));

const BATCH = Math.max(1000, parseInt(process.env.MATERIALIZE_BATCH || '20000', 10));
const LOOP = process.env.MATERIALIZE_LOOP === '1';
const LOOP_SLEEP_MS = Math.max(60000, parseInt(process.env.MATERIALIZE_LOOP_SLEEP_MS || '1200000', 10));

const zoneExpr = `COALESCE((SELECT tld_count FROM zi.name_summary WHERE base_name = domains.base_name), 0)`;
const cacheExpr = `COALESCE((SELECT count FROM tld_check_cache WHERE base_name = domains.base_name), 0)`;
const liveExpr = `MAX(${zoneExpr}, ${cacheExpr})`;

// Only active auctions (the rows the extension sort is used on), and only where the
// stored value actually disagrees with the live value — so re-runs are cheap no-ops.
const updateBatch = db.prepare(`
  UPDATE domains
  SET tlds_taken = ${liveExpr}, tlds_checked_at = datetime('now')
  WHERE rowid IN (
    SELECT rowid FROM domains
    WHERE stream IN ('godaddy-auction','godaddy-closeout','namecheap-auction')
      AND auction_end > datetime('now')
      AND base_name IS NOT NULL AND base_name != ''
      AND COALESCE(tlds_taken, -1) != ${liveExpr}
      AND rowid > @cursor
    ORDER BY rowid
    LIMIT @batch
  )
`);
// Advance the cursor over the candidate set (rowid is monotonic, stable for paging).
const nextCursor = db.prepare(`
  SELECT MAX(rowid) AS m FROM (
    SELECT rowid FROM domains
    WHERE stream IN ('godaddy-auction','godaddy-closeout','namecheap-auction')
      AND auction_end > datetime('now')
      AND base_name IS NOT NULL AND base_name != ''
      AND rowid > @cursor
    ORDER BY rowid LIMIT @batch
  )
`);

// Inverted (tld -> base_name) index of tld_check_cache. Drives ccTLD takenIn filters
// (e.g. "taken in .ai") via a JOIN instead of the 60k-window cache probe. Rebuilt each
// sweep from the live cache so newly-enriched names become filterable. INSERT OR IGNORE
// is additive; a periodic full rebuild (when stale entries could linger) keeps it exact.
db.exec(`CREATE TABLE IF NOT EXISTS cctld_taken_idx (tld TEXT, base_name TEXT, PRIMARY KEY (tld, base_name)) WITHOUT ROWID`);
// The DELETE + 2M-row INSERT…SELECT holds the single SQLite write lock ~7s, during which
// the server's synchronous writes block the event loop and the whole UI freezes (this is
// what stalled the TLD-extensions modal). The focus-cctld service already keeps the index
// fresh INCREMENTALLY on every write, so the full rebuild is only needed occasionally to
// drop rare stale entries (a ccTLD that flipped taken→available). Run it every Nth sweep,
// not every sweep — cutting the heavy lock-hold from every ~20min to every ~2h.
const CCTLD_REBUILD_EVERY = Math.max(1, parseInt(process.env.MATERIALIZE_CCTLD_REBUILD_EVERY || '6', 10));
let _sweepCount = 0;
function refreshCctldIndex(force) {
  if (!force && (_sweepCount % CCTLD_REBUILD_EVERY) !== 0) return;
  const t = Date.now();
  db.exec('DELETE FROM cctld_taken_idx');
  const n = db.prepare(`INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name)
    SELECT je.value, tc.base_name FROM tld_check_cache tc, json_each(tc.taken_json) je`).run().changes;
  console.log(`[materialize] cctld_taken_idx rebuilt: ${n} rows in ${((Date.now()-t)/1000).toFixed(1)}s`);
}

const BATCH_PAUSE_MS = Math.max(0, parseInt(process.env.MATERIALIZE_BATCH_PAUSE_MS || '60', 10));
async function sweep() {
  const t0 = Date.now();
  let cursor = 0, totalChanged = 0, batches = 0;
  for (;;) {
    const nc = nextCursor.get({ cursor, batch: BATCH });
    if (!nc || nc.m == null) break;
    const changed = updateBatch.run({ cursor, batch: BATCH }).changes;
    totalChanged += changed;
    cursor = nc.m;
    if (++batches % 10 === 0) console.log(`[materialize] ${batches} batches, ${totalChanged} updated, cursor=${cursor}`);
    // Yield the single SQLite write lock between batches so the interactive server (and
    // the focus service) aren't starved — a tight no-yield loop monopolizes the writer
    // and blocks the server's event loop, freezing the UI (e.g. the TLD modal).
    if (BATCH_PAUSE_MS > 0) await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
  }
  console.log(`[materialize] sweep done: ${totalChanged} rows updated in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  refreshCctldIndex(); // gated: full rebuild on first sweep, then every CCTLD_REBUILD_EVERY
  _sweepCount++;
  // This loop is the heaviest writer; checkpoint+truncate so the WAL doesn't grow
  // unbounded (a multi-GB WAL slows every reader's page lookups — observed 12-18s API
  // stalls at 3.5GB). TRUNCATE returns the file to 0 bytes when no reader pins old frames.
  try { const r = db.pragma('wal_checkpoint(TRUNCATE)'); console.log(`[materialize] wal checkpoint: ${JSON.stringify(r)}`); }
  catch (e) { console.warn('[materialize] checkpoint failed:', e.message); }
}

(async () => {
  if (!LOOP) { await sweep(); process.exit(0); }
  for (;;) {
    try { await sweep(); } catch (e) { console.error('[materialize] sweep error:', e.message); }
    console.log(`[materialize] sleeping ${(LOOP_SLEEP_MS/60000).toFixed(0)}m`);
    await new Promise(r => setTimeout(r, LOOP_SLEEP_MS));
  }
})();
