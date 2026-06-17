require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.DOMAINSCOUT_SKIP_DB_MAINTENANCE = process.env.DOMAINSCOUT_SKIP_DB_MAINTENANCE || '1';

const db = require('./db');
const { endedAuctionWhere } = require('./auction-cleanup');
const { getRegistrarRequiredAvailableTlds } = require('../enrichment');

// 7-day default (was 24h) — keep in sync with server/index.js. A 24h gate hid ~40%
// of the genuinely-available expired pool because the availability worker can't
// re-confirm every dropped name daily, shrinking the "past N days" universes.
const EXPIRED_VISIBLE_MAX_AGE_HOURS = Math.max(
  1,
  Math.min(24 * 30, parseInt(process.env.DOMAINSCOUT_EXPIRED_VISIBLE_MAX_AGE_HOURS || '168', 10) || 168)
);

function visibleDroppedCandidateWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `(
    ${p}stream != 'just-dropped'
    OR ${p}registration_available IS NULL
    OR ${p}registration_available = 1
  )`;
}

// MUST stay in sync with server/index.js recentExpiredWhere. The "Expired" universe
// is every domain seen to drop/expire in the window (full expireddomains.net-style
// firehose), not the tiny DNS-confirmed subset. Index-friendly raw date comparisons
// (drop_date stored as 'YYYY-MM-DD') + positive stream IN (...).
function recentExpiredWhere(days = 30, prefix = '') {
  const n = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const p = prefix ? `${prefix}.` : '';
  const tomorrow = `date('now','+1 day')`;
  const cutoffDate = `date('now','-${n} days')`;
  // drop_date-only — see server/index.js recentExpiredWhere. Keeps the page query on
  // idx_stream_drop_date (no temp B-tree); the old expiry_date fallback was ~120
  // lower-confidence NULL-drop_date rows. Must stay in sync with index.js.
  return `(
    ${p}stream IN ('just-dropped','pending-delete','discovered')
    AND ${p}drop_date IS NOT NULL
    AND ${p}drop_date >= ${cutoffDate}
    AND ${p}drop_date < ${tomorrow}
    -- Show the drop pipeline (redemption/pending-delete = original owner, past expiry);
    -- hide only re-registered (reg=0 with FUTURE registry expiry) + live (dns=0). Must
    -- stay in sync with server/index.js recentExpiredWhere.
    AND NOT (${p}registration_available = 0 AND ${p}registry_expiry IS NOT NULL AND datetime(${p}registry_expiry) > datetime('now'))
    AND (${p}dns_available IS NULL OR ${p}dns_available = 1)
  )`;
}

function registrarConfirmedAvailableWhere(prefix = '') {
  const tlds = getRegistrarRequiredAvailableTlds();
  if (!tlds.length) return '1=1';
  const p = prefix ? `${prefix}.` : '';
  const quoted = tlds.map(tld => `'${String(tld).replace(/'/g, "''")}'`).join(',');
  return `(
    ${p}tld NOT IN (${quoted})
    OR ${p}availability_source = 'registrar'
    OR ${p}availability_source LIKE 'registrar+%'
  )`;
}

function recentExpiringDomainUnionSql(days = 90, extraWhere = '') {
  const n = Math.min(365, Math.max(1, parseInt(days, 10) || 90));
  const nowIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const cutoffIso = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${n} days')`;
  const today = `date('now')`;
  const cutoffDate = `date('now','+${n} days')`;
  const extra = extraWhere ? ` AND (${extraWhere})` : '';
  return `
    SELECT domain
    FROM domains
    WHERE stream IN ('godaddy-auction','namecheap-auction')
      AND auction_end IS NOT NULL
      AND auction_end > ${nowIso}
      AND auction_end <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'discovered'
      AND domain NOT IN (SELECT domain FROM domains WHERE stream = 'pending-delete')
      AND expiry_date IS NOT NULL
      AND expiry_date > ${nowIso}
      AND expiry_date <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'pending-delete'
      AND expiry_date IS NOT NULL
      AND expiry_date > ${nowIso}
      AND expiry_date <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'pending-delete'
      AND expiry_date IS NULL
      AND auction_end IS NOT NULL
      AND auction_end > ${nowIso}
      AND auction_end <= ${cutoffIso}
      ${extra}
    UNION
    SELECT domain
    FROM domains
    WHERE stream = 'pending-delete'
      AND expiry_date IS NULL
      AND auction_end IS NULL
      AND drop_date IS NOT NULL
      AND date(drop_date) >= ${today}
      AND date(drop_date) <= ${cutoffDate}
      ${extra}
  `;
}

function activeStatsCount(where = '1=1') {
  const visibleWhere = `(${where}) AND ${visibleDroppedCandidateWhere()}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM domains WHERE ${visibleWhere}`).get().n;
  const ended = db.prepare(`SELECT COUNT(*) AS n FROM domains WHERE ${visibleWhere} AND ${endedAuctionWhere()}`).get().n;
  return total - ended;
}

function activeGroupedStats(field) {
  const visibleWhere = visibleDroppedCandidateWhere();
  const rows = db.prepare(`SELECT ${field} AS value, COUNT(*) AS n FROM domains WHERE ${visibleWhere} GROUP BY ${field}`).all();
  const endedRows = db.prepare(`
    SELECT ${field} AS value, COUNT(*) AS n
    FROM domains
    WHERE ${visibleWhere} AND ${endedAuctionWhere()}
    GROUP BY ${field}
  `).all();
  const endedByValue = new Map(endedRows.map(row => [row.value, row.n]));

  return rows
    .map(row => ({ [field]: row.value, n: row.n - (endedByValue.get(row.value) || 0) }))
    .filter(row => row.n > 0);
}

function buildStats() {
  const total = activeStatsCount();
  // Saved is a curated watchlist — count every saved row regardless of auction
  // status/visibility (consistent with the saved view), so the badge never reads
  // 0 while saved names exist whose auctions have already ended.
  const saved = db.prepare('SELECT COUNT(*) AS n FROM domains WHERE saved = 1').get().n;
  const unseen = activeStatsCount('seen = 0 AND skipped = 0');
  const byStream = activeGroupedStats('stream');
  const byTld = activeGroupedStats('tld').sort((a, b) => b.n - a.n);
  const lastRun = db.prepare(`
    SELECT ran_at, stream, domains_found, domains_new FROM scrape_log
    ORDER BY ran_at DESC LIMIT 8
  `).all();

  // COUNT(*) (dups ~0.04%) so the ~700k expired universe uses the drop_date index
  // range instead of a multi-second DISTINCT temp B-tree. Matches server/index.js.
  const expiredCount = (days) => db.prepare(`SELECT COUNT(*) as n FROM domains WHERE ${recentExpiredWhere(days)}`).get().n;
  const expiryCount = (days) => db.prepare(`
    SELECT COUNT(*) AS n
    FROM (${recentExpiringDomainUnionSql(days)})
  `).get().n;

  return {
    total, saved, unseen,
    expired1: expiredCount(1),
    expired7: expiredCount(7),
    expired14: expiredCount(14),
    expired30: expiredCount(30),
    expired60: expiredCount(60),
    expired90: expiredCount(90),
    byStream,
    byTld,
    lastRun,
    expiring1: expiryCount(1),
    expiring7: expiryCount(7),
    expiring14: expiryCount(14),
    expiring30: expiryCount(30),
    expiring60: expiryCount(60),
    expiring90: expiryCount(90),
  };
}

function setPersistentCache(key, value) {
  db.prepare(`
    INSERT INTO app_cache (key, value_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

function refreshStatsCache() {
  const started = Date.now();
  const stats = buildStats();
  setPersistentCache('stats', stats);
  return { ...stats, elapsedMs: Date.now() - started };
}

if (require.main === module) {
  try {
    const result = refreshStatsCache();
    console.log(JSON.stringify({
      ok: true,
      elapsedMs: result.elapsedMs,
      expired90: result.expired90,
      expiring90: result.expiring90,
    }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message || String(err) }));
    process.exit(1);
  }
}

module.exports = {
  buildStats,
  refreshStatsCache,
  visibleDroppedCandidateWhere,
  recentExpiredWhere,
  recentExpiringDomainUnionSql,
};
