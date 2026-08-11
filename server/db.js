const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// On Railway, use /data volume mount if available; otherwise local data/
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(__dirname, '../data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'domains.db');

// Resilient open. A crash can leave a wrong-sized `-shm` file (the WAL shared-
// memory INDEX), so switching to WAL fails with SQLITE_IOERR_SHMSIZE and the
// whole app crash-loops. The `-shm` is derived state — SQLite rebuilds it from
// the `-wal` on next open — so deleting ONLY `-shm` (never `-wal`, which can
// hold committed-but-uncheckpointed rows) is the documented, data-safe
// recovery. Retry once after clearing it.
function openDatabaseWithWal() {
  let database = new Database(dbPath);
  try {
    database.pragma('journal_mode = WAL');
    return database;
  } catch (err) {
    const recoverable = /SHMSIZE|disk I\/O error|database disk image is malformed/i.test(String(err && err.message));
    if (!recoverable) throw err;
    console.warn(`[DB] WAL switch failed (${err.message}); clearing stale -shm and retrying`);
    try { database.close(); } catch { /* already unusable */ }
    try { fs.rmSync(`${dbPath}-shm`, { force: true }); } catch (e) { console.warn('[DB] could not remove -shm:', e.message); }
    database = new Database(dbPath);
    try {
      database.pragma('journal_mode = WAL');
    } catch (err2) {
      // Last resort: keep the app alive in rollback-journal mode (no -shm needed).
      // Concurrent writers are rarer than total downtime; surface it loudly.
      console.error(`[DB] WAL still failing after -shm reset (${err2.message}); falling back to journal_mode=DELETE`);
      database.pragma('journal_mode = DELETE');
    }
    return database;
  }
}

const db = openDatabaseWithWal();

db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 15000');
db.pragma('cache_size = -32768'); // 32MB page cache
// Cap the WAL file size. On the Mac a watchdog process truncates the WAL, but on
// Railway (no watchdog) the WAL grew unbounded and FILLED the 5GB volume → "disk I/O
// error" on every write → healthcheck failed → crash-loop → 502s for the agents.
// journal_size_limit truncates the WAL back to this size after each checkpoint
// (auto-checkpoint fires every ~4MB), so the WAL can never balloon again.
db.pragma('journal_size_limit = 67108864'); // 64MB

if (process.env.DOMAINSCOUT_SKIP_DB_MAINTENANCE !== '1') {
db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    tld TEXT NOT NULL,
    stream TEXT NOT NULL,
    source TEXT,
    status TEXT DEFAULT 'active',
    auction_end TEXT,
    auction_price REAL,
    auction_url TEXT,
    age_years INTEGER,
    wayback_snapshots INTEGER,
    wayback_first TEXT,
    wayback_last TEXT,
    dns_available INTEGER DEFAULT NULL,
    registration_available INTEGER DEFAULT NULL,
    first_available_at TEXT,
    availability_checked_at TEXT,
    availability_source TEXT,
    availability_error TEXT,
    quality_score INTEGER DEFAULT 0,
    quality_reasons TEXT,
    length INTEGER,
    has_numbers INTEGER DEFAULT 0,
    has_hyphens INTEGER DEFAULT 0,
    drop_date TEXT,
    expiry_date TEXT,
    whois_checked TEXT,
    discovered_at TEXT DEFAULT (datetime('now')),
    seen INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    notes TEXT,
    UNIQUE(domain, stream)
  );

  CREATE INDEX IF NOT EXISTS idx_tld ON domains(tld);
  CREATE INDEX IF NOT EXISTS idx_domain ON domains(domain);
  CREATE INDEX IF NOT EXISTS idx_tld_domain ON domains(tld, domain);
  CREATE INDEX IF NOT EXISTS idx_stream ON domains(stream);
  CREATE INDEX IF NOT EXISTS idx_discovered ON domains(discovered_at);
  CREATE INDEX IF NOT EXISTS idx_saved ON domains(saved);
  CREATE INDEX IF NOT EXISTS idx_skipped ON domains(skipped);
  CREATE INDEX IF NOT EXISTS idx_stream_discovered ON domains(stream, discovered_at);
  CREATE INDEX IF NOT EXISTS idx_tld_discovered ON domains(tld, discovered_at);
  CREATE INDEX IF NOT EXISTS idx_tld_stream ON domains(tld, stream);
  CREATE INDEX IF NOT EXISTS idx_stream_domain ON domains(stream, domain);
  CREATE INDEX IF NOT EXISTS idx_stream_expiry ON domains(stream, expiry_date);
  CREATE INDEX IF NOT EXISTS idx_stream_auction_end ON domains(stream, auction_end);
  CREATE INDEX IF NOT EXISTS idx_stream_discovered_id ON domains(stream, discovered_at, id);
  CREATE INDEX IF NOT EXISTS idx_tld_auction_price ON domains(tld, auction_price);
  CREATE INDEX IF NOT EXISTS idx_tld_age_years ON domains(tld, age_years);
  CREATE INDEX IF NOT EXISTS idx_tld_length ON domains(tld, length);
  CREATE INDEX IF NOT EXISTS idx_tld_wayback ON domains(tld, wayback_snapshots);
  CREATE INDEX IF NOT EXISTS idx_tld_expiry ON domains(tld, expiry_date);
  CREATE INDEX IF NOT EXISTS idx_tld_auction_end ON domains(tld, auction_end);
  CREATE INDEX IF NOT EXISTS idx_tld_drop_date ON domains(tld, drop_date);
  CREATE INDEX IF NOT EXISTS idx_stream_auction_price ON domains(stream, auction_price);
  CREATE INDEX IF NOT EXISTS idx_stream_age_years ON domains(stream, age_years);
  CREATE INDEX IF NOT EXISTS idx_length ON domains(length);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON domains(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_drop_date ON domains(drop_date);
  CREATE INDEX IF NOT EXISTS idx_auction_end ON domains(auction_end);
  CREATE INDEX IF NOT EXISTS idx_auction_price ON domains(auction_price);
  CREATE INDEX IF NOT EXISTS idx_age_years ON domains(age_years);
  -- Partial index: wayback_snapshots>0 is extremely sparse (~100 of 1.6M). A plain
  -- index on the column is ignored by the planner (it walks idx_discovered scanning
  -- all rows = 33s). This partial index in discovered_at order serves the
  -- hasWayback filter + ORDER BY discovered_at directly = 0.02s.
  CREATE INDEX IF NOT EXISTS idx_wayback_disc ON domains(discovered_at DESC) WHERE wayback_snapshots > 0;
  -- Sort-by-wayback (ORDER BY wayback_snapshots DESC/ASC) is a real domainer signal but
  -- had NO usable index: idx_wayback_disc serves the FILTER (discovered_at order), not the
  -- SORT, so sorting the all view by wayback full-scanned + TEMP B-TREE'd 1.5M rows = 10s.
  -- A plain column index directly provides the wayback order and early-terminates at LIMIT
  -- (10s -> 5ms, both directions). It does NOT regress the hasWayback filter — the planner
  -- still picks idx_wayback_disc for 'WHERE wayback>0 ORDER BY discovered_at' (verified).
  CREATE INDEX IF NOT EXISTS idx_wayback ON domains(wayback_snapshots);
  -- Ordered-walk path for "scalar filter + ORDER BY discovered_at + LIMIT" queries.
  -- Leading discovered_at gives the sort order (no TEMP B-TREE) and the walk
  -- early-terminates at LIMIT; tlds_taken is carried so the most-filtered column
  -- (the "min TLDs taken" filter) is tested in-index. The planner adopts this as
  -- the preferred ordered path for age/length/price filters too, taking them from
  -- ~0.7-2.4s (composite-index + temp sort) to ~1-2ms. Pairs with sqlite_stat4.
  CREATE INDEX IF NOT EXISTS idx_disc_tlds ON domains(discovered_at DESC, tlds_taken);
  -- bid_count>0 is extremely sparse (~1.6k of 1.6M: only live auctions with bids).
  -- Partial index in discovered_at order serves the hasBids filter on the all view
  -- directly (5.6s walk -> 1ms), same shape as idx_wayback_disc.
  CREATE INDEX IF NOT EXISTS idx_disc_bids ON domains(discovered_at DESC) WHERE bid_count > 0;
  -- dns_available=1 is sparse (~43k of 1.5M). Filtering the all view by it walked the
  -- discovered index testing dns per row (full table fetches) = 12s. Partial index in
  -- discovered_at order serves the dnsAvailable filter directly (12s -> 60ms), same shape
  -- as idx_disc_bids / idx_wayback_disc. Tiny (only the matching rows are indexed).
  CREATE INDEX IF NOT EXISTS idx_dns_disc ON domains(discovered_at DESC) WHERE dns_available = 1;
  -- Sort/filter by age. minAge on the all view picked idx_age_years then TEMP B-TREE
  -- sorted all ~83k matches by discovered_at = 12s. Carrying age_years after the leading
  -- discovered_at lets the ordered walk test age in-index and early-terminate at LIMIT
  -- (12s -> 40ms), same idea as idx_disc_tlds for the minTlds filter.
  CREATE INDEX IF NOT EXISTS idx_disc_age ON domains(discovered_at DESC, age_years);
  -- Filter by name length. minLength/maxLength on the all view picked idx_tld_length
  -- then TEMP B-TREE sorted all ~100k matches by discovered_at = 3.3s. Carrying length
  -- after the leading discovered_at lets the ordered walk test the length range in-index
  -- and early-terminate at LIMIT (3.3s -> 39ms), same idea as idx_disc_age / idx_disc_tlds.
  CREATE INDEX IF NOT EXISTS idx_disc_length ON domains(discovered_at DESC, length);
  -- Covering index for unindexable substring/suffix search (base_name LIKE '%x').
  -- Leading discovered_at gives the sort order; base_name is carried so the LIKE is
  -- tested IN-INDEX during the ordered walk (index-only scan, no per-row table
  -- fetch). Suffix search "ends with ly" page 1.7s -> 24ms, count -> 117ms.
  CREATE INDEX IF NOT EXISTS idx_disc_base ON domains(discovered_at DESC, base_name);
  -- Global "sort by extensions" (tlds_taken) on the all view. idx_tlds_taken alone gives
  -- the tlds_taken DESC order but the ', domain ASC' tiebreak forced a TEMP B-TREE over
  -- the whole 684k-row tlds_taken>0 set (it must buffer every row sharing a value to
  -- order domain within it) = 6.8s. Carrying domain in the index satisfies the full
  -- 'tlds_taken DESC, domain ASC' order with no temp sort and early-terminates at LIMIT:
  -- 6.8s -> 71ms. Within-stream extension sorts already had idx_stream_tlds_taken_domain.
  CREATE INDEX IF NOT EXISTS idx_tlds_taken_domain ON domains(tlds_taken DESC, domain);

  CREATE TABLE IF NOT EXISTS base_tld_counts (
    base_name   TEXT PRIMARY KEY,
    tld_count   INTEGER NOT NULL DEFAULT 0,
    source      TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_base_tld_counts_count
    ON base_tld_counts(tld_count DESC, base_name);

  CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL,
    ran_at TEXT DEFAULT (datetime('now')),
    domains_found INTEGER DEFAULT 0,
    domains_new INTEGER DEFAULT 0,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS tld_check_cache (
    base_name  TEXT PRIMARY KEY,
    count      INTEGER NOT NULL,
    taken_json TEXT NOT NULL,
    all_count  INTEGER NOT NULL,
    source     TEXT,
    checked_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tld_check_cache_count ON tld_check_cache(count);

  CREATE TABLE IF NOT EXISTS sibling_tld_status (
    base_name  TEXT NOT NULL,
    tld        TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('taken', 'not_taken')),
    source     TEXT NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (base_name, tld)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_sibling_tld_status_tld_status
    ON sibling_tld_status(tld, status, base_name);

  CREATE TABLE IF NOT EXISTS market_sibling_scan (
    stream                TEXT NOT NULL,
    source_tlds           TEXT NOT NULL,
    target_tlds           TEXT NOT NULL,
    snapshot_sha256       TEXT NOT NULL,
    snapshot_generated_at TEXT,
    candidate_count       INTEGER NOT NULL DEFAULT 0,
    pair_count            INTEGER NOT NULL DEFAULT 0,
    checked_count         INTEGER NOT NULL DEFAULT 0,
    taken_count           INTEGER NOT NULL DEFAULT 0,
    unknown_count         INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    started_at            TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at          TEXT,
    error                 TEXT,
    PRIMARY KEY (stream, source_tlds, target_tlds)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS sibling_tld_queue (
    base_name       TEXT NOT NULL,
    tld             TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (base_name, tld)
  ) WITHOUT ROWID;

  -- Provider-neutral evidence ledger for actual releases. A domain is not an
  -- "expired" row merely because it happens to be available: it must have prior
  -- registration evidence plus an observed release event from a cataloged source.
  CREATE TABLE IF NOT EXISTS drop_events (
    domain                    TEXT NOT NULL,
    base_name                 TEXT NOT NULL,
    tld                       TEXT NOT NULL,
    source                    TEXT NOT NULL,
    source_kind               TEXT NOT NULL,
    source_event_at           TEXT NOT NULL,
    prior_registered_evidence TEXT NOT NULL,
    released_at               TEXT,
    registration_available    INTEGER,
    availability_source       TEXT,
    availability_checked_at   TEXT,
    observed_at               TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (domain, source, source_event_at)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_drop_events_release_tld
    ON drop_events(tld, released_at, domain);
  CREATE INDEX IF NOT EXISTS idx_drop_events_domain_release
    ON drop_events(domain, released_at);

  -- The catalog states which adapter owns completeness for each TLD. Coverage
  -- receipts are daily and explicit, including zero-event days, so absence of rows
  -- can never be confused with a complete day containing no drops.
  CREATE TABLE IF NOT EXISTS drop_source_catalog (
    tld                 TEXT NOT NULL,
    source              TEXT NOT NULL,
    source_kind         TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    coverage_started_on TEXT,
    metadata_json       TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tld, source)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS drop_source_coverage (
    tld               TEXT NOT NULL,
    coverage_date     TEXT NOT NULL,
    source            TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
    observed_count    INTEGER NOT NULL DEFAULT 0,
    available_count   INTEGER NOT NULL DEFAULT 0,
    unavailable_count INTEGER NOT NULL DEFAULT 0,
    unknown_count     INTEGER NOT NULL DEFAULT 0,
    completed_at      TEXT,
    error             TEXT,
    PRIMARY KEY (tld, coverage_date, source)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_drop_source_coverage_date
    ON drop_source_coverage(coverage_date, status, tld);
  CREATE INDEX IF NOT EXISTS idx_sibling_tld_queue_due
    ON sibling_tld_queue(next_attempt_at, requested_at);

  -- Live GoDaddy auction state (bids/price), fetched per-listing through a warmed
  -- browser (see live-listings.js). Keyed by listing id; overlaid onto rows so the UI
  -- shows practically-live bids instead of the once-a-day feed snapshot.
  CREATE TABLE IF NOT EXISTS live_listing_cache (
    listing_id  INTEGER PRIMARY KEY,
    domain      TEXT,
    bids        INTEGER,
    price       REAL,
    next_bid    REAL,
    status      TEXT,
    price_type  TEXT,
    end_time    TEXT,
    fetched_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_live_listing_cache_fetched_at
    ON live_listing_cache(fetched_at DESC);

  -- Freshness envelope advertised by an authoritative daily drop provider.
  -- Kept provider-neutral so a second deleted-domain feed can satisfy the same
  -- completeness contract without changing Expired view logic.
  CREATE TABLE IF NOT EXISTS drop_source_status (
    source          TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    last_update     TEXT,
    available_from  TEXT,
    checked_at      TEXT NOT NULL,
    status          TEXT NOT NULL,
    error           TEXT
  );

  CREATE TABLE IF NOT EXISTS app_cache (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate existing databases that predate added columns
const existing = db.prepare("PRAGMA table_info(domains)").all().map(c => c.name);
if (!existing.includes('expiry_date'))   db.exec("ALTER TABLE domains ADD COLUMN expiry_date TEXT");
if (!existing.includes('whois_checked')) db.exec("ALTER TABLE domains ADD COLUMN whois_checked TEXT");
if (!existing.includes('tlds_taken'))      db.exec("ALTER TABLE domains ADD COLUMN tlds_taken INTEGER DEFAULT 0");
if (!existing.includes('tlds_checked_at')) db.exec("ALTER TABLE domains ADD COLUMN tlds_checked_at TEXT");
if (!existing.includes('bid_count'))       db.exec("ALTER TABLE domains ADD COLUMN bid_count INTEGER DEFAULT 0");
if (!existing.includes('base_name'))        db.exec("ALTER TABLE domains ADD COLUMN base_name TEXT");
if (!existing.includes('registration_available')) db.exec("ALTER TABLE domains ADD COLUMN registration_available INTEGER DEFAULT NULL");
if (!existing.includes('first_available_at')) db.exec("ALTER TABLE domains ADD COLUMN first_available_at TEXT");
if (!existing.includes('availability_checked_at')) db.exec("ALTER TABLE domains ADD COLUMN availability_checked_at TEXT");
if (!existing.includes('availability_source')) db.exec("ALTER TABLE domains ADD COLUMN availability_source TEXT");
if (!existing.includes('availability_error')) db.exec("ALTER TABLE domains ADD COLUMN availability_error TEXT");
if (!existing.includes('quality_score')) db.exec("ALTER TABLE domains ADD COLUMN quality_score INTEGER DEFAULT 0");
if (!existing.includes('quality_reasons')) db.exec("ALTER TABLE domains ADD COLUMN quality_reasons TEXT");
// Registry expiry captured during the availability (RDAP) check — used by the Expired
// view to distinguish a dropping name (past expiry: redemption/pending-delete, shown)
// from one re-registered by a new owner after expiry (future expiry, hidden). Kept
// separate from expiry_date so it can't perturb the Expiring view's use of expiry_date.
if (!existing.includes('registry_expiry')) db.exec("ALTER TABLE domains ADD COLUMN registry_expiry TEXT");

const dropEventColumns = db.prepare("PRAGMA table_info(drop_events)").all().map(c => c.name);
if (!dropEventColumns.includes('registration_available')) {
  db.exec("ALTER TABLE drop_events ADD COLUMN registration_available INTEGER DEFAULT NULL");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tld_tlds_taken ON domains(tld, tlds_taken);
  CREATE INDEX IF NOT EXISTS idx_stream_tlds_taken ON domains(stream, tlds_taken);
  CREATE INDEX IF NOT EXISTS idx_stream_tlds_taken_domain ON domains(stream, tlds_taken DESC, domain);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_tlds_taken_domain ON domains(stream, tld, tlds_taken DESC, domain);
  CREATE INDEX IF NOT EXISTS idx_price_tlds ON domains(auction_price, tlds_taken);
  CREATE INDEX IF NOT EXISTS idx_tlds_taken ON domains(tlds_taken);
  CREATE INDEX IF NOT EXISTS idx_tld_tlds_taken_domain ON domains(tld, tlds_taken DESC, domain);
  CREATE INDEX IF NOT EXISTS idx_stream_bid_count ON domains(stream, bid_count DESC, domain);

  UPDATE domains
  SET base_name = LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1))
  WHERE base_name IS NULL OR base_name = '';

  CREATE INDEX IF NOT EXISTS idx_base_name ON domains(base_name);
  CREATE INDEX IF NOT EXISTS idx_base_tld_discovered ON domains(base_name, tld, discovered_at);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_base ON domains(stream, tld, base_name);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_expiry ON domains(stream, tld, expiry_date);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_drop_date ON domains(stream, tld, drop_date);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_discovered ON domains(stream, tld, discovered_at);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_auction_end ON domains(stream, tld, auction_end);
  CREATE INDEX IF NOT EXISTS idx_stream_expiry_date ON domains(stream, expiry_date);
  CREATE INDEX IF NOT EXISTS idx_stream_drop_date ON domains(stream, drop_date);
  CREATE INDEX IF NOT EXISTS idx_stream_auction_end ON domains(stream, auction_end);
  CREATE INDEX IF NOT EXISTS idx_stream_auction_end_domain ON domains(stream, auction_end, domain);
  CREATE INDEX IF NOT EXISTS idx_stream_expiry_date_domain ON domains(stream, expiry_date, domain);
  CREATE INDEX IF NOT EXISTS idx_stream_drop_date_domain ON domains(stream, drop_date, domain);
  CREATE INDEX IF NOT EXISTS idx_seen_skipped ON domains(seen, skipped);
  CREATE INDEX IF NOT EXISTS idx_registration_available ON domains(registration_available);
  CREATE INDEX IF NOT EXISTS idx_first_available_at ON domains(first_available_at);
  CREATE INDEX IF NOT EXISTS idx_availability_checked ON domains(availability_checked_at);
  CREATE INDEX IF NOT EXISTS idx_tld_available_checked ON domains(tld, registration_available, availability_checked_at);
  CREATE INDEX IF NOT EXISTS idx_tld_dns_checked ON domains(tld, dns_available, availability_checked_at);
  CREATE INDEX IF NOT EXISTS idx_stream_tld_available_checked ON domains(stream, tld, registration_available, availability_checked_at);
  CREATE INDEX IF NOT EXISTS idx_quality_score ON domains(quality_score DESC, domain);
  CREATE INDEX IF NOT EXISTS idx_tld_available_quality ON domains(tld, registration_available, quality_score DESC, domain);
  CREATE INDEX IF NOT EXISTS idx_drop_events_source_status
    ON drop_events(tld, source_event_at, source, registration_available);

  UPDATE domains
  SET first_available_at = availability_checked_at
  WHERE registration_available = 1
    AND first_available_at IS NULL
    AND availability_checked_at IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS domains_set_base_name_after_insert
  AFTER INSERT ON domains
  WHEN NEW.base_name IS NULL OR NEW.base_name = ''
  BEGIN
    UPDATE domains
    SET base_name = LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1))
    WHERE id = NEW.id;
  END;
`);

// Fix mistagged Namecheap records that were previously stored as godaddy-auction.
// Delete rows where a namecheap-auction row already exists (avoids UNIQUE conflict),
// then migrate the rest.
db.exec(`
  DELETE FROM domains
  WHERE source = 'Namecheap' AND stream = 'godaddy-auction'
    AND saved = 0 AND skipped = 0
    AND EXISTS (SELECT 1 FROM domains d2 WHERE d2.domain = domains.domain AND d2.stream = 'namecheap-auction')
`);
db.exec(`UPDATE OR IGNORE domains SET stream = 'namecheap-auction' WHERE source = 'Namecheap' AND stream = 'godaddy-auction'`);

// Fix wrong Namecheap auction URLs (old format: /market/auctions/domain/x → correct: /market/x)
db.exec(`UPDATE domains SET auction_url = 'https://www.namecheap.com/market/' || domain
  WHERE source = 'Namecheap' AND auction_url LIKE '%/market/auctions/domain/%'`);
}

// These tables are runtime compatibility schema, not expensive maintenance.
// Desktop services intentionally skip broad index creation/backfills at every
// launch, but newly introduced runtime modules must still be able to prepare
// their statements against an existing database.
db.exec(`
  CREATE TABLE IF NOT EXISTS cctld_taken_idx (
    tld       TEXT NOT NULL,
    base_name TEXT NOT NULL,
    PRIMARY KEY (tld, base_name)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS cctld_index_state (
    singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
    source_rows           INTEGER NOT NULL DEFAULT 0,
    source_max_checked_at TEXT,
    rebuilt_at            TEXT,
    refreshed_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS market_sibling_scan (
    stream                TEXT NOT NULL,
    source_tlds           TEXT NOT NULL,
    target_tlds           TEXT NOT NULL,
    snapshot_sha256       TEXT NOT NULL,
    snapshot_generated_at TEXT,
    candidate_count       INTEGER NOT NULL DEFAULT 0,
    pair_count            INTEGER NOT NULL DEFAULT 0,
    checked_count         INTEGER NOT NULL DEFAULT 0,
    taken_count           INTEGER NOT NULL DEFAULT 0,
    unknown_count         INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    started_at            TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at          TEXT,
    error                 TEXT,
    PRIMARY KEY (stream, source_tlds, target_tlds)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS drop_events (
    domain                    TEXT NOT NULL,
    base_name                 TEXT NOT NULL,
    tld                       TEXT NOT NULL,
    source                    TEXT NOT NULL,
    source_kind               TEXT NOT NULL,
    source_event_at           TEXT NOT NULL,
    prior_registered_evidence TEXT NOT NULL,
    released_at               TEXT,
    registration_available    INTEGER,
    availability_source       TEXT,
    availability_checked_at   TEXT,
    observed_at               TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (domain, source, source_event_at)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_drop_events_release_tld
    ON drop_events(tld, released_at, domain);
  CREATE INDEX IF NOT EXISTS idx_drop_events_domain_release
    ON drop_events(domain, released_at);
  CREATE INDEX IF NOT EXISTS idx_drop_events_source_status
    ON drop_events(tld, source_event_at, source, registration_available);

  CREATE TABLE IF NOT EXISTS drop_source_catalog (
    tld                 TEXT NOT NULL,
    source              TEXT NOT NULL,
    source_kind         TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    coverage_started_on TEXT,
    metadata_json       TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tld, source)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS drop_source_coverage (
    tld               TEXT NOT NULL,
    coverage_date     TEXT NOT NULL,
    source            TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
    observed_count    INTEGER NOT NULL DEFAULT 0,
    available_count   INTEGER NOT NULL DEFAULT 0,
    unavailable_count INTEGER NOT NULL DEFAULT 0,
    unknown_count     INTEGER NOT NULL DEFAULT 0,
    completed_at      TEXT,
    error             TEXT,
    PRIMARY KEY (tld, coverage_date, source)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_drop_source_coverage_date
    ON drop_source_coverage(coverage_date, status, tld);

  CREATE TABLE IF NOT EXISTS live_listing_cache (
    listing_id  INTEGER PRIMARY KEY,
    domain      TEXT,
    bids        INTEGER,
    price       REAL,
    next_bid    REAL,
    status      TEXT,
    price_type  TEXT,
    end_time    TEXT,
    fetched_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_live_listing_cache_fetched_at
    ON live_listing_cache(fetched_at DESC);
  CREATE TABLE IF NOT EXISTS drop_source_status (
    source          TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    last_update     TEXT,
    available_from  TEXT,
    checked_at      TEXT NOT NULL,
    status          TEXT NOT NULL,
    error           TEXT
  );
  CREATE TABLE IF NOT EXISTS app_cache (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

const operationalDropEventColumns = db.prepare("PRAGMA table_info(drop_events)").all().map(c => c.name);
if (!operationalDropEventColumns.includes('registration_available')) {
  db.exec("ALTER TABLE drop_events ADD COLUMN registration_available INTEGER DEFAULT NULL");
}

// ── Full-text substring search index (FTS5 trigram) ─────────────────────────
// Substring search (domain LIKE '%term%') can't use a btree index, so searching
// 1.6M domains was a 10-18s full scan (and the same for COUNT). An FTS5 trigram
// index makes both the page and the count ~15ms. External-content (content='domains',
// content_rowid='id') stores only the trigram index (~110MB), not a copy of the rows.
// Trigram matches substrings of length >= 3; the search route falls back to LIKE for
// 1-2 char terms and the starts/ends modes.
let _domainFtsReady = false;
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS domain_fts
    USING fts5(domain, content='domains', content_rowid='id', tokenize='trigram')`);
  _domainFtsReady = true;
} catch (err) {
  console.warn('[FTS] domain_fts unavailable (FTS5/trigram not compiled in?):', err.message);
}

// Incremental, trigger-free sync: domains.id is AUTOINCREMENT (monotonic), so new
// scraped rows always have a higher id than anything already indexed. We index only
// id > max-indexed — no per-write trigger overhead on bulk scrape inserts. (domain
// strings are immutable after insert and deletes are rare/harmless to leave indexed,
// so we don't need UPDATE/DELETE tracking for a discovery tool.)
function syncDomainFts() {
  if (!_domainFtsReady) return 0;
  try {
    const maxIndexed = db.prepare('SELECT COALESCE(MAX(rowid),0) AS m FROM domain_fts_docsize').get().m;
    const info = db.prepare(
      'INSERT INTO domain_fts(rowid, domain) SELECT id, domain FROM domains WHERE id > ?'
    ).run(maxIndexed);
    return info.changes;
  } catch (err) {
    console.warn('[FTS] sync failed:', err.message);
    return 0;
  }
}

// First-time build (e.g. fresh Railway volume): if the index is empty but rows exist,
// populate it once. ~30s for 1.6M rows; only happens when domain_fts has no entries.
if (_domainFtsReady) {
  try {
    const indexed = db.prepare('SELECT COUNT(*) AS n FROM domain_fts_docsize').get().n;
    if (indexed === 0) {
      const haveRows = db.prepare('SELECT 1 FROM domains LIMIT 1').get();
      if (haveRows) {
        console.log('[FTS] building domain_fts index (one-time)…');
        db.exec(`INSERT INTO domain_fts(domain_fts) VALUES('rebuild')`);
        console.log('[FTS] domain_fts build complete');
      }
    } else {
      syncDomainFts(); // catch up any rows added while the server was down
    }
  } catch (err) {
    console.warn('[FTS] initial build/sync skipped:', err.message);
  }
}

db.domainFtsReady = _domainFtsReady;
db.syncDomainFts = syncDomainFts;

// Keep the query planner's statistics current. Stale/missing stats caused the
// planner to pick idx_discovered full-scans for selective filters (minAge took
// 16s; after ANALYZE it was 0.11s). PRAGMA optimize is incremental and cheap —
// it only re-analyzes tables whose stats are missing or materially out of date —
// so it is safe to run on every startup. The wal-watchdog re-runs it periodically
// to track the continuously-growing table. Skipped in maintenance helpers.
if (!process.env.DOMAINSCOUT_SKIP_DB_MAINTENANCE) {
  try { db.pragma('optimize'); } catch (err) { console.warn('[DB] PRAGMA optimize skipped:', err.message); }
}

module.exports = db;
