const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// On Railway, use /data volume mount if available; otherwise local data/
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(__dirname, '../data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'domains.db'));

// WAL mode: readers don't block on writes (critical — tlds-worker does 500 concurrent DNS writes)
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 15000');
db.pragma('cache_size = -32768'); // 32MB page cache

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
  CREATE INDEX IF NOT EXISTS idx_stream_auction_price ON domains(stream, auction_price);
  CREATE INDEX IF NOT EXISTS idx_stream_age_years ON domains(stream, age_years);
  CREATE INDEX IF NOT EXISTS idx_length ON domains(length);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON domains(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_auction_end ON domains(auction_end);
  CREATE INDEX IF NOT EXISTS idx_auction_price ON domains(auction_price);
  CREATE INDEX IF NOT EXISTS idx_age_years ON domains(age_years);

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
  CREATE INDEX IF NOT EXISTS idx_stream_tld_base ON domains(stream, tld, base_name);

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
    AND EXISTS (SELECT 1 FROM domains d2 WHERE d2.domain = domains.domain AND d2.stream = 'namecheap-auction')
`);
db.exec(`UPDATE OR IGNORE domains SET stream = 'namecheap-auction' WHERE source = 'Namecheap' AND stream = 'godaddy-auction'`);

// Fix wrong Namecheap auction URLs (old format: /market/auctions/domain/x → correct: /market/x)
db.exec(`UPDATE domains SET auction_url = 'https://www.namecheap.com/market/' || domain
  WHERE source = 'Namecheap' AND auction_url LIKE '%/market/auctions/domain/%'`);
}

module.exports = db;
