const fs = require('fs');
const path = require('path');

const DATA_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');

const GODADDY_CACHE_FILES = {
  'godaddy-auction': 'godaddy-auction-cache.json',
  'godaddy-closeout': 'godaddy-closeout-cache.json',
};

const memoryCache = new Map();

function isGoDaddyInventoryStream(stream) {
  return Object.prototype.hasOwnProperty.call(GODADDY_CACHE_FILES, stream);
}

function cachePathForStream(stream) {
  const file = GODADDY_CACHE_FILES[stream];
  if (!file) return null;
  return path.join(DATA_BASE_PATH, file);
}

function cacheDomainRow(domain) {
  return {
    domain: domain.domain,
    tld: domain.tld,
    stream: domain.stream,
    source: domain.source,
    auction_price: domain.auction_price ?? null,
    auction_end: domain.auction_end ?? null,
    auction_url: domain.auction_url ?? null,
    age_years: domain.age_years ?? null,
    bid_count: domain.bid_count ?? 0,
    length: domain.length,
    has_numbers: domain.has_numbers ? 1 : 0,
    has_hyphens: domain.has_hyphens ? 1 : 0,
    expiry_date: null,
    drop_date: null,
    tlds_taken: null,
    wayback_snapshots: null,
  };
}

function writeGoDaddyInventoryCache(stream, domains) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath) return null;
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  const payload = {
    stream,
    generatedAt: new Date().toISOString(),
    count: domains.length,
    domains: domains.map(cacheDomainRow),
  };
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, cachePath);
  memoryCache.delete(stream);
  return cachePath;
}

function readGoDaddyInventoryCache(stream) {
  const cachePath = cachePathForStream(stream);
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  const stat = fs.statSync(cachePath);
  const cached = memoryCache.get(stream);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.payload;
  const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  memoryCache.set(stream, { mtimeMs: stat.mtimeMs, payload });
  return payload;
}

module.exports = {
  isGoDaddyInventoryStream,
  readGoDaddyInventoryCache,
  writeGoDaddyInventoryCache,
};
