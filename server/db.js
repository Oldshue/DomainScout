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
db.pragma('cache_size = -32768'); // 32MB page cache

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
  CREATE INDEX IF NOT EXISTS idx_stream ON domains(stream);
  CREATE INDEX IF NOT EXISTS idx_discovered ON domains(discovered_at);
  CREATE INDEX IF NOT EXISTS idx_saved ON domains(saved);
  CREATE INDEX IF NOT EXISTS idx_skipped ON domains(skipped);
  CREATE INDEX IF NOT EXISTS idx_stream_discovered ON domains(stream, discovered_at);
  CREATE INDEX IF NOT EXISTS idx_length ON domains(length);
  CREATE INDEX IF NOT EXISTS idx_tlds_taken ON domains(tlds_taken);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON domains(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_auction_end ON domains(auction_end);
  CREATE INDEX IF NOT EXISTS idx_auction_price ON domains(auction_price);
  CREATE INDEX IF NOT EXISTS idx_age_years ON domains(age_years);

  CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL,
    ran_at TEXT DEFAULT (datetime('now')),
    domains_found INTEGER DEFAULT 0,
    domains_new INTEGER DEFAULT 0,
    error TEXT
  );
`);

// Migrate existing databases that predate added columns
const existing = db.prepare("PRAGMA table_info(domains)").all().map(c => c.name);
if (!existing.includes('expiry_date'))   db.exec("ALTER TABLE domains ADD COLUMN expiry_date TEXT");
if (!existing.includes('whois_checked')) db.exec("ALTER TABLE domains ADD COLUMN whois_checked TEXT");
if (!existing.includes('tlds_taken'))      db.exec("ALTER TABLE domains ADD COLUMN tlds_taken INTEGER DEFAULT 0");
if (!existing.includes('tlds_checked_at')) db.exec("ALTER TABLE domains ADD COLUMN tlds_checked_at TEXT");

// Fix mistagged Namecheap records that were previously stored as godaddy-auction
db.exec(`UPDATE domains SET stream = 'namecheap-auction' WHERE source = 'Namecheap' AND stream = 'godaddy-auction'`);

// Fix wrong Namecheap auction URLs (old format: /market/auctions/domain/x → correct: /market/x)
db.exec(`UPDATE domains SET auction_url = 'https://www.namecheap.com/market/' || domain
  WHERE source = 'Namecheap' AND auction_url LIKE '%/market/auctions/domain/%'`);

module.exports = db;
