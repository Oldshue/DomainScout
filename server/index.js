// ── EMERGENCY DISK CLEANUP ─────────────────────────────────────────────────
// Must run BEFORE require('./db') — if the Railway volume is full, SQLite's
// WAL mode cannot write and the process crashes before the server starts.
// Zone data is preserved in zone_index.db; raw zone files are safe to delete.
(function purgeZoneFilesSync() {
  const _fs = require('fs');
  const _path = require('path');
  const zonesDir = _path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH || _path.join(__dirname, '../data'),
    'zones'
  );
  if (!_fs.existsSync(zonesDir)) return;
  let deleted = 0;
  for (const f of _fs.readdirSync(zonesDir)) {
    if (/\.(zone|zone\.gz)(\.part)?$/.test(f)) {
      try { _fs.unlinkSync(_path.join(zonesDir, f)); deleted++; }
      catch (_) {}
    }
  }
  if (deleted > 0) console.log(`[Startup] Purged ${deleted} zone files from disk (freeing volume space)`);
})();
// ───────────────────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const session = require('express-session');
const { spawn } = require('child_process');
const DATA_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
const SERVER_LOCK_PATH = path.join(DATA_BASE_PATH, 'server.lock.json');

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function acquireServerLock() {
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  if (fs.existsSync(SERVER_LOCK_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(SERVER_LOCK_PATH, 'utf8'));
      if (existing.pid !== process.pid && isPidAlive(existing.pid)) {
        console.error(`[Startup] DomainScout already running as pid ${existing.pid}; exiting duplicate process before DB init.`);
        process.exit(0);
      }
      fs.unlinkSync(SERVER_LOCK_PATH);
    } catch (_) {
      try { fs.unlinkSync(SERVER_LOCK_PATH); } catch (_) {}
    }
  }

  fs.writeFileSync(SERVER_LOCK_PATH, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2));

  process.on('exit', () => {
    try {
      const lock = JSON.parse(fs.readFileSync(SERVER_LOCK_PATH, 'utf8'));
      if (Number(lock.pid) === process.pid) fs.unlinkSync(SERVER_LOCK_PATH);
    } catch (_) {}
  });
}

if (process.env.DOMAINSCOUT_SKIP_SERVER_LOCK !== '1') acquireServerLock();

const db = require('./db');
const { startWorker } = require('./tlds-worker');
const { checkTldsTakenFull } = require('../enrichment');
const { getCheckTlds, getTldSource, refreshLogicalTlds } = require('./tlds-list');
const { indexAllPendingZoneFiles, queryZoneIndex, getZoneIndexStats,
        getTldTrends, getKeywordTrends, hasTrendData, getNameTlds, getIndexedTldSet } = require('./zone-indexer');
const { normalizePrefix } = require('./research-prefix-index');
const { activeAuctionWhere, purgeEndedAuctions } = require('./auction-cleanup');
const { isGoDaddyInventoryStream, readGoDaddyInventoryCache } = require('./godaddy-cache');

// ATTACH zone_index.db for cross-DB "also taken in" filtering.
// Called after zone-indexer has had a chance to create the file.
const SCRAPE_LOCK_PATH = path.join(DATA_BASE_PATH, 'scrape.lock.json');
let _zoneIndexAttached = false;

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readActiveScrapeLock() {
  if (!fs.existsSync(SCRAPE_LOCK_PATH)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(SCRAPE_LOCK_PATH, 'utf8'));
    if (isProcessAlive(lock.pid)) return lock;
    fs.unlinkSync(SCRAPE_LOCK_PATH);
    console.warn(`[Scrape] Removed stale scrape lock for pid ${lock.pid || 'unknown'}`);
  } catch (err) {
    try { fs.unlinkSync(SCRAPE_LOCK_PATH); } catch (_) {}
    console.warn('[Scrape] Removed unreadable scrape lock:', err.message);
  }
  return null;
}

function writeScrapeLock(lock, flags = 'w') {
  fs.mkdirSync(DATA_BASE_PATH, { recursive: true });
  fs.writeFileSync(SCRAPE_LOCK_PATH, JSON.stringify(lock, null, 2), { flag: flags });
}

function releaseScrapeLock(pid) {
  try {
    const lock = JSON.parse(fs.readFileSync(SCRAPE_LOCK_PATH, 'utf8'));
    if (Number(lock.pid) === Number(pid)) fs.unlinkSync(SCRAPE_LOCK_PATH);
  } catch (_) {}
}

function startScrapeWorker(reason, options = {}) {
  const active = readActiveScrapeLock();
  if (active) {
    return {
      ok: false,
      message: 'Scrape already running',
      pid: active.pid,
      reason: active.reason,
      startedAt: active.startedAt,
    };
  }

  const reservation = {
    pid: process.pid,
    parentPid: process.pid,
    reason,
    startedAt: new Date().toISOString(),
    reserving: true,
  };

  try {
    writeScrapeLock(reservation, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const lock = readActiveScrapeLock();
    return {
      ok: false,
      message: 'Scrape already running',
      pid: lock?.pid,
      reason: lock?.reason,
      startedAt: lock?.startedAt,
    };
  }

  const childArgs = [path.join(__dirname, 'scrape-all.js')];
  if (options.includeCZDS) childArgs.push('--czds');

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  const child = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DOMAINSCOUT_SCRAPE_REASON: reason,
      DOMAINSCOUT_SKIP_DB_MAINTENANCE: '1',
    },
    stdio: 'inherit',
  });

  const lock = {
    pid: child.pid,
    parentPid: process.pid,
    reason,
    includeCZDS: options.includeCZDS === true,
    startedAt: new Date().toISOString(),
  };
  writeScrapeLock(lock);
  console.log(`[Scrape] Started ${reason} scrape worker pid ${child.pid}`);

  child.on('exit', (code, signal) => {
    console.log(`[Scrape] Worker pid ${child.pid} finished (${signal || code})`);
    releaseScrapeLock(child.pid);
    bustCache();
    invalidateStatsCache();
  });

  child.on('error', (err) => {
    console.error('[Scrape] Worker failed to start:', err.message);
    releaseScrapeLock(child.pid);
  });

  return { ok: true, pid: child.pid, reason, startedAt: lock.startedAt };
}

function attachZoneIndex() {
  if (_zoneIndexAttached) return;
  const zoneDbPath = path.join(DATA_BASE_PATH, 'zone_index.db');
  if (!fs.existsSync(zoneDbPath)) return;
  try {
    db.exec(`ATTACH DATABASE '${zoneDbPath}' AS zi`);
    _zoneIndexAttached = true;
    console.log('[ZoneFilter] zone_index.db attached for cross-DB filtering');
  } catch (err) {
    if (!err.message.includes('already')) console.warn('[ZoneFilter] ATTACH failed:', err.message);
  }
}

function domainBaseName(domain) {
  const d = String(domain || '').toLowerCase();
  const dot = d.lastIndexOf('.');
  return dot > 0 ? d.slice(0, dot) : d;
}

function baseNameSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `LOWER(SUBSTR(${p}domain, 1, INSTR(${p}domain, '.') - 1))`;
}

function bestTldCountSql(alias = '') {
  const baseExpr = baseNameSql(alias);
  const zonePart = _zoneIndexAttached
    ? `COALESCE((SELECT ns.tld_count FROM zi.name_summary ns WHERE ns.base_name = ${baseExpr}), 0)`
    : '0';
  return `MAX(
    COALESCE((SELECT tc.count FROM tld_check_cache tc WHERE tc.base_name = ${baseExpr}), 0),
    ${zonePart},
    COALESCE(${alias ? `${alias}.` : ''}tlds_taken, 0)
  )`;
}

const BASE_TLD_COUNTS_STATE_KEY = 'base_tld_counts_state';

function getBaseTldCountsSnapshot() {
  const domainBases = db.prepare(`
    SELECT COUNT(*) AS n
    FROM (
      SELECT base_name
      FROM domains
      WHERE base_name IS NOT NULL AND base_name != ''
      GROUP BY base_name
    )
  `).get().n;
  const materializedRows = db.prepare('SELECT COUNT(*) AS n FROM base_tld_counts').get().n;
  const zoneStats = getZoneIndexStats();
  return {
    domainBases,
    materializedRows,
    zoneTlds: zoneStats.tlds || 0,
    zoneNames: zoneStats.names || 0,
  };
}

function shouldSkipBaseTldCountSync(snapshot, force) {
  if (force || snapshot.materializedRows === 0) return false;
  if (snapshot.materializedRows < snapshot.domainBases) return false;

  const cached = getPersistentCache(BASE_TLD_COUNTS_STATE_KEY)?.value;
  if (!cached) return false;

  return cached.domainBases === snapshot.domainBases &&
    cached.zoneTlds === snapshot.zoneTlds &&
    cached.zoneNames === snapshot.zoneNames;
}

function syncDomainTldCountsFromBaseCounts() {
  const result = db.prepare(`
    UPDATE domains
    SET tlds_taken = (
      SELECT btc.tld_count
      FROM base_tld_counts btc
      WHERE btc.base_name = domains.base_name
    )
    WHERE base_name IS NOT NULL
      AND base_name != ''
      AND EXISTS (
        SELECT 1 FROM base_tld_counts btc
        WHERE btc.base_name = domains.base_name
      )
      AND COALESCE(tlds_taken, -1) != COALESCE((
        SELECT btc.tld_count
        FROM base_tld_counts btc
        WHERE btc.base_name = domains.base_name
      ), -1)
  `).run();
  return result.changes;
}

let baseTldCountSyncRunning = false;
function syncBaseTldCounts({ force = false, reason = 'background' } = {}) {
  if (baseTldCountSyncRunning) return { ok: false, running: true };
  baseTldCountSyncRunning = true;
  const t0 = Date.now();
  try {
    attachZoneIndex();
    const before = getBaseTldCountsSnapshot();
    if (shouldSkipBaseTldCountSync(before, force)) {
      console.log(`[TLDCounts] Fresh (${before.materializedRows.toLocaleString()} base counts); skipped ${reason} sync`);
      return { ok: true, skipped: true };
    }

    const zoneJoin = _zoneIndexAttached
      ? 'LEFT JOIN zi.name_summary ns ON ns.base_name = b.base_name'
      : '';
    const zoneCount = _zoneIndexAttached ? 'COALESCE(ns.tld_count, 0)' : '0';
    const result = db.prepare(`
      INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
      SELECT
        b.base_name,
        MAX(COALESCE(tc.count, 0), ${zoneCount}, COALESCE(b.domain_count, 0)) AS tld_count,
        CASE
          WHEN COALESCE(tc.count, 0) >= ${zoneCount} AND COALESCE(tc.count, 0) >= COALESCE(b.domain_count, 0) THEN 'hybrid-cache'
          WHEN ${zoneCount} >= COALESCE(b.domain_count, 0) THEN 'zone-summary'
          ELSE 'domains'
        END AS source,
        datetime('now') AS updated_at
      FROM (
        SELECT base_name, MAX(COALESCE(tlds_taken, 0)) AS domain_count
        FROM domains
        WHERE base_name IS NOT NULL AND base_name != ''
        GROUP BY base_name
      ) b
      LEFT JOIN tld_check_cache tc ON tc.base_name = b.base_name
      ${zoneJoin}
      ON CONFLICT(base_name) DO UPDATE SET
        tld_count = excluded.tld_count,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run();
    const domainUpdates = syncDomainTldCountsFromBaseCounts();
    const after = getBaseTldCountsSnapshot();
    setPersistentCache(BASE_TLD_COUNTS_STATE_KEY, after);
    console.log(`[TLDCounts] Synced ${result.changes.toLocaleString()} base counts, updated ${domainUpdates.toLocaleString()} domains in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { ok: true, changes: result.changes, domainUpdates };
  } catch (err) {
    console.warn('[TLDCounts] sync failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    baseTldCountSyncRunning = false;
  }
}

function enrichPageTldCounts(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return domains;
  attachZoneIndex();
  const bases = [...new Set(domains.map(d => domainBaseName(d.domain)).filter(Boolean))];
  const counts = new Map();

  const bestStmt = db.prepare('SELECT tld_count FROM base_tld_counts WHERE base_name = ?');
  const cacheStmt = db.prepare('SELECT count FROM tld_check_cache WHERE base_name = ?');
  const zoneStmt = _zoneIndexAttached
    ? db.prepare('SELECT tld_count FROM zi.name_summary WHERE base_name = ?')
    : null;

  for (const baseName of bases) {
    const materializedCount = Number(bestStmt.get(baseName)?.tld_count || 0);
    const cacheCount = Number(cacheStmt.get(baseName)?.count || 0);
    const zoneCount = zoneStmt ? Number(zoneStmt.get(baseName)?.tld_count || 0) : 0;
    const best = Math.max(materializedCount, cacheCount, zoneCount);
    if (best > 0) counts.set(baseName, best);
  }

  for (const d of domains) {
    const best = counts.get(domainBaseName(d.domain));
    if (best && best > Number(d.tlds_taken || 0)) d.tlds_taken = best;
  }
  return domains;
}

const app = express();
const PORT = process.env.PORT || 3737;

const AGENTFORGE_MANIFEST = {
  name: 'DomainScout',
  description: 'Local domain discovery, auction, closeout, pending-delete, marketplace, and domain research dashboard. Use the live UI for orientation, and use the app-owned API for large candidate sets and source-backed evidence.',
  primaryUrl: '/',
  workflows: [
    {
      name: 'Discover available domain streams and categories',
      usage: 'Start with /api/agentforge/streams when the user names a category such as auction, closeout, premium, marketplace, pending delete, expired, or expiring. It returns the app-owned stream names and counts agents can query.',
    },
    {
      name: 'Retrieve candidate domains from any DomainScout stream',
      usage: 'Query /api/agentforge/domain-candidates?stream=<stream>&limit=<rows> for candidate rows with raw metrics, source URLs, and research signals. Use a larger limit for best/top/research tasks that need a broad candidate pool. Use stream aliases such as godaddy-auction, godaddy-closeout, namecheap-auction, marketplace, pending-delete, or all.',
    },
    {
      name: 'Retrieve current auction candidates',
      usage: 'Query /api/agentforge/domain-candidates?stream=godaddy-auction&limit=<rows> for current GoDaddy auctions. For a specific auction day, add date=today, date=tomorrow, or date=YYYY-MM-DD.',
    },
    {
      name: 'Inspect visible domain rows',
      usage: 'Use the browser table for quick confirmation of active filters, selected sort, prices, bids, TLD spread, and auction end dates.',
    },
  ],
  endpoints: [
    {
      method: 'GET',
      path: '/api/agentforge/streams',
      usage: 'Agent-facing inventory of DomainScout streams/categories with counts and useful date/price metadata.',
    },
    {
      method: 'GET',
      path: '/api/agentforge/domain-candidates',
      usage: 'Agent-facing candidate rows from any DomainScout stream/category. Optional params: stream/category, limit, candidates, date=today|tomorrow|YYYY-MM-DD, tld, q, searchMode, maxPrice, minLength, maxLength, noNumbers, noHyphens, hasBids, hasWayback, takenIn, domainSuffix, sortField, and sortDir. sortField accepts source field names and common aliases such as bids, price, auctionEnd, expiryDate, tldsTaken, ageYears, and waybackSnapshots.',
    },
    {
      method: 'GET',
      path: '/api/domains',
      usage: 'Paginated domain rows. Useful params include stream, tld, q, searchMode, sortField, sortDir, page, limit, maxPrice, noNumbers, noHyphens, hasBids, takenIn, domainSuffix, and expiryToday.',
    },
    {
      method: 'GET',
      path: '/api/stats',
      usage: 'Current dataset counts by stream and TLD.',
    },
  ],
  agentNotes: [
    'For recommendation tasks, inspect enough candidates and explain your own selection criteria from the raw fields, source URLs, and research signals; do not present endpoint order as a final verdict by itself.',
    'GoDaddy auctions, GoDaddy closeouts, premium/marketplace listings, pending-delete, and discovered domains are DomainScout streams/categories; do not treat a follow-up category as an undefined external web concept before checking DomainScout streams.',
    'GoDaddy closeouts are current BuyNow snapshot rows from closeout_listings.json.zip. For that stream, auctionEnd is the original auction transition time; do not reject a closeout solely because auctionEnd is in the past.',
    'The expiryToday filter means ending today only. It is narrower than a request for today/current/latest data.',
  ],
  examples: [
    {
      name: 'Discover streams/categories',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/streams'",
      usage: 'Use this before deciding which stream to query.',
    },
    {
      name: 'GoDaddy auction candidate pool',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/domain-candidates?stream=godaddy-auction&limit=1000'",
      usage: 'Use this to retrieve current GoDaddy auction candidates, then compare the rows yourself.',
    },
    {
      name: 'GoDaddy auction candidate pool for tomorrow',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/domain-candidates?stream=godaddy-auction&limit=1000&date=tomorrow'",
      usage: 'Use this when the request names tomorrow or another specific auction day, then make the final selection yourself.',
    },
    {
      name: 'GoDaddy closeout candidate pool',
      command: "curl -fsS 'http://127.0.0.1:3737/api/agentforge/domain-candidates?stream=godaddy-closeout&limit=1000'",
      usage: 'Use this for closeout follow-ups, then decide which names merit deeper research from the returned evidence.',
    },
  ],
};

app.get('/.well-known/agentforge.json', (_req, res) => res.json(AGENTFORGE_MANIFEST));
app.get('/agentforge.json', (_req, res) => res.json(AGENTFORGE_MANIFEST));

// ── In-memory query cache ────────────────────────────────────────────────────
const queryCache = new Map();
const CACHE_TTL  = 60_000; // 60 seconds
const STATS_CACHE_TTL = 5 * 60_000;

function getCached(key) {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { queryCache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  if (queryCache.size >= 150) {
    // evict oldest
    let oldest = null;
    for (const [k, v] of queryCache) if (!oldest || v.ts < oldest[1].ts) oldest = [k, v];
    if (oldest) queryCache.delete(oldest[0]);
  }
  queryCache.set(key, { data, ts: Date.now() });
}
function bustCache() { queryCache.clear(); }

function getPersistentCache(key) {
  const row = db.prepare('SELECT value_json, updated_at FROM app_cache WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value_json), updatedAt: row.updated_at };
  } catch (_) {
    return null;
  }
}

function setPersistentCache(key, value) {
  db.prepare(`
    INSERT INTO app_cache (key, value_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

let statsRefreshRunning = false;
function buildStats() {
  const activeAuctions = activeAuctionWhere();
  const total = db.prepare(`SELECT COUNT(*) as n FROM domains WHERE ${activeAuctions}`).get().n;
  const saved = db.prepare(`SELECT COUNT(*) as n FROM domains WHERE saved = 1 AND ${activeAuctions}`).get().n;
  const unseen = db.prepare(`SELECT COUNT(*) as n FROM domains WHERE seen = 0 AND skipped = 0 AND ${activeAuctions}`).get().n;
  const byStream = db.prepare(`SELECT stream, COUNT(*) as n FROM domains WHERE ${activeAuctions} GROUP BY stream`).all();
  const byTld = db.prepare(`SELECT tld, COUNT(*) as n FROM domains WHERE ${activeAuctions} GROUP BY tld ORDER BY n DESC`).all();
  const lastRun = db.prepare(`
    SELECT ran_at, stream, domains_found, domains_new FROM scrape_log
    ORDER BY ran_at DESC LIMIT 8
  `).all();

  const expiredCount = (days) => db.prepare(
    `SELECT COUNT(*) as n FROM domains WHERE expiry_date IS NOT NULL AND expiry_date < datetime('now') AND expiry_date >= datetime('now','-${days} days') AND (auction_end IS NULL OR expiry_date != auction_end)`
  ).get().n;
  const expiryCount = (days) => db.prepare(
    `SELECT COUNT(*) as n FROM domains WHERE expiry_date IS NOT NULL AND expiry_date > datetime('now') AND expiry_date <= datetime('now','+${days} days') AND stream NOT IN ('godaddy-auction','namecheap-auction','marketplace')`
  ).get().n;

  return {
    total, saved, unseen,
    expired7: expiredCount(7),
    expired14: expiredCount(14),
    expired30: expiredCount(30),
    expired60: expiredCount(60),
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

function refreshStatsCache() {
  if (statsRefreshRunning) return;
  statsRefreshRunning = true;
  setImmediate(() => {
    try {
      setPersistentCache('stats', buildStats());
    } catch (err) {
      console.warn('[Stats] refresh failed:', err.message);
    } finally {
      statsRefreshRunning = false;
    }
  });
}

function invalidateStatsCache() {
  try { db.prepare("DELETE FROM app_cache WHERE key = 'stats'").run(); } catch (_) {}
  refreshStatsCache();
}

const APP_USER = 'Admin';
const APP_PASS = 'Gofuckyourselfclaudeyouretard';
const SESSION_SECRET = process.env.SESSION_SECRET || 'domainscout-secret-fixed-key-xk9p2m';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

// ── Auth middleware ──────────────────────────────────────────────────────────
function normalizeRemoteIp(rawIp) {
  return String(rawIp || '')
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function isTrustedPrivateIp(rawIp) {
  const ip = normalizeRemoteIp(rawIp);
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }
  const parts = ip.split('.').map(n => Number(n));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
}

function isLocalRequest(req) {
  if (process.env.DISABLE_AUTH === '1') return true;
  const host = (req.headers.host || '').split(':')[0];
  const ip = normalizeRemoteIp(req.ip || req.socket?.remoteAddress || '');
  return ['localhost', '127.0.0.1', '::1'].includes(host) ||
         ip === '127.0.0.1' ||
         isTrustedPrivateIp(ip);
}

function requireAuth(req, res, next) {
  if (isLocalRequest(req)) return next();
  if (req.session?.authed) return next();
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/stats') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (isLocalRequest(req)) return res.redirect('/');
  if (req.session?.authed) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DomainScout — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: 'JetBrains Mono', monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { width: 360px; }
    .wordmark { font-size: 28px; font-weight: 700; letter-spacing: -1px; margin-bottom: 32px; }
    .wordmark span { color: #22c55e; }
    form { display: flex; flex-direction: column; gap: 12px; }
    input { background: #16161e; border: 1px solid #2a2a3a; color: #e0e0e0; padding: 12px 14px; border-radius: 6px; font-family: inherit; font-size: 14px; outline: none; }
    input:focus { border-color: #22c55e; }
    button { background: #22c55e; color: #0a0a0f; border: none; padding: 12px; border-radius: 6px; font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer; margin-top: 4px; }
    button:hover { background: #16a34a; }
    .err { color: #f87171; font-size: 13px; display: none; }
    .err.show { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="wordmark">domain<span>scout</span></div>
    <form method="POST" action="/api/login">
      <input name="username" type="text" placeholder="username" autocomplete="username" autofocus>
      <input name="password" type="password" placeholder="password" autocomplete="current-password">
      <p class="err ${req.query.err ? 'show' : ''}">Invalid credentials</p>
      <button type="submit">Sign in →</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === APP_USER && password === APP_PASS) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.redirect('/login?err=1');
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// All routes below require auth
app.use(requireAuth);
app.use(express.static(path.join(__dirname, '../public')));

// ── GET /api/domains ────────────────────────────────────────────────────────
// Filters: stream, tld, minLength, maxLength, noNumbers, noHyphens,
//          minAge, maxAge, hasWayback, dnsAvailable, q (search), seen, saved, skipped
// Sort: field, dir. Pagination: page, limit

function parseBoundedPositiveInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function compactMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'no listed price';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function daysUntil(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}

function localDateWindow(offsetDays = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString(), label: start.toISOString().slice(0, 10) };
}

function parseAgentAuctionDateWindow(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'current' || raw === 'latest' || raw === 'active') return null;
  if (raw === 'today') return localDateWindow(0);
  if (raw === 'tomorrow') return localDateWindow(1);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString(), label: raw };
}

function countPhrase(value, singular, plural = `${singular}s`) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

const AGENTFORGE_STREAM_ALIASES = new Map(Object.entries({
  auction: 'godaddy-auction',
  auctions: 'godaddy-auction',
  'godaddy-auctions': 'godaddy-auction',
  'godaddy auction': 'godaddy-auction',
  'godaddy auctions': 'godaddy-auction',
  closeout: 'godaddy-closeout',
  closeouts: 'godaddy-closeout',
  'godaddy closeout': 'godaddy-closeout',
  'godaddy closeouts': 'godaddy-closeout',
  premium: 'marketplace',
  premiums: 'marketplace',
  marketplace: 'marketplace',
  market: 'marketplace',
  pending: 'pending-delete',
  'pending delete': 'pending-delete',
  'pending-delete': 'pending-delete',
  pendingdelete: 'pending-delete',
  namecheap: 'namecheap-auction',
  'namecheap auction': 'namecheap-auction',
  'namecheap auctions': 'namecheap-auction',
  discovered: 'discovered',
  all: 'all',
}));

function normalizeAgentStream(value, fallback = 'godaddy-auction') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  const cleaned = raw.replace(/_/g, '-').replace(/\s+/g, ' ');
  return AGENTFORGE_STREAM_ALIASES.get(cleaned) || cleaned.replace(/\s+/g, '-');
}

const DOMAIN_SORT_FIELD_ALIASES = new Map(Object.entries({
  bids: 'bid_count',
  bidcount: 'bid_count',
  bid_count: 'bid_count',
  numberofbids: 'bid_count',
  price: 'auction_price',
  auctionprice: 'auction_price',
  auction_price: 'auction_price',
  end: 'auction_end',
  ends: 'auction_end',
  ending: 'auction_end',
  auctionend: 'auction_end',
  auction_end: 'auction_end',
  expiry: 'expiry_date',
  expirydate: 'expiry_date',
  expiry_date: 'expiry_date',
  drop: 'drop_date',
  dropdate: 'drop_date',
  drop_date: 'drop_date',
  tldstaken: 'tlds_taken',
  tlds_taken: 'tlds_taken',
  age: 'age_years',
  ageyears: 'age_years',
  age_years: 'age_years',
  wayback: 'wayback_snapshots',
  waybacksnapshots: 'wayback_snapshots',
  wayback_snapshots: 'wayback_snapshots',
}));

function normalizeDomainSortField(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const snake = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
  return DOMAIN_SORT_FIELD_ALIASES.get(compact) || DOMAIN_SORT_FIELD_ALIASES.get(snake) || snake;
}

function agentStreamLabel(stream) {
  return {
    'godaddy-auction': 'GoDaddy auction',
    'godaddy-closeout': 'GoDaddy closeout',
    'namecheap-auction': 'Namecheap auction',
    marketplace: 'marketplace/premium',
    'pending-delete': 'pending-delete',
    discovered: 'discovered',
    all: 'all active',
  }[stream] || stream;
}

function isGoDaddyCloseoutStream(streamOrDomain) {
  if (!streamOrDomain) return false;
  if (typeof streamOrDomain === 'string') return streamOrDomain === 'godaddy-closeout';
  return streamOrDomain.stream === 'godaddy-closeout' || /closeout/i.test(String(streamOrDomain.source || ''));
}

function closeoutInventoryMetadata() {
  return {
    status: 'current GoDaddy BuyNow closeout snapshot',
    sourceFeed: 'closeout_listings.json.zip',
    dateFieldMeaning: 'auctionEnd is the original auction transition time, not active closeout expiry or availability proof',
  };
}

function buildAgentResearchSignals(domain) {
  const signals = [];
  const length = Number(domain.length || String(domain.domain || '').split('.')[0]?.length || 0);
  const isCloseout = isGoDaddyCloseoutStream(domain);
  if (isCloseout) signals.push('GoDaddy BuyNow closeout snapshot');
  if (domain.tld) signals.push(`extension=${domain.tld}`);
  if (length) signals.push(`length=${length}`);
  if (!domain.has_numbers && !domain.has_hyphens) signals.push('clean spelling');
  if (Number(domain.tlds_taken || 0) > 0) signals.push(`${countPhrase(domain.tlds_taken, 'TLD')} already registered`);
  if (Number(domain.bid_count || 0) > 0) signals.push(`${countPhrase(domain.bid_count, 'bid')} visible`);
  if (Number(domain.auction_price || 0) > 0) signals.push(`price=${compactMoney(domain.auction_price)}`);
  if (Number(domain.age_years || 0) > 0) signals.push(`${countPhrase(domain.age_years, 'year')} old`);
  if (Number(domain.wayback_snapshots || 0) > 0) signals.push(`${countPhrase(domain.wayback_snapshots, 'Wayback snapshot')} recorded`);
  if (isCloseout && domain.auction_end) {
    signals.push(`originalAuctionTransition=${domain.auction_end}`);
  } else if (domain.auction_end || domain.expiry_date || domain.drop_date) {
    signals.push(`date=${domain.auction_end || domain.expiry_date || domain.drop_date}`);
  }
  return signals.filter(Boolean);
}

function agentCandidateFromDomain(domain, index) {
  const isCloseout = isGoDaddyCloseoutStream(domain);
  return {
    candidateIndex: index + 1,
    domain: domain.domain,
    stream: domain.stream,
    source: domain.source,
    inventoryStatus: isCloseout ? 'current GoDaddy BuyNow closeout snapshot' : 'current active listing',
    tld: domain.tld,
    length: domain.length,
    price: domain.auction_price,
    bids: domain.bid_count,
    tldsTaken: domain.tlds_taken,
    ageYears: domain.age_years,
    waybackSnapshots: domain.wayback_snapshots,
    auctionEnd: domain.auction_end || null,
    auctionEndMeaning: isCloseout ? closeoutInventoryMetadata().dateFieldMeaning : null,
    expiryDate: domain.expiry_date || null,
    dropDate: domain.drop_date || null,
    researchSignals: buildAgentResearchSignals(domain),
    auctionUrl: domain.auction_url,
    sourceUrl: domain.auction_url,
  };
}

function latestScrapeForStream(stream) {
  if (!stream || stream === 'all') return null;
  try {
    return db.prepare(`
      SELECT ran_at, domains_found, domains_new, error
      FROM scrape_log
      WHERE stream = @stream
      ORDER BY ran_at DESC
      LIMIT 1
    `).get({ stream }) || null;
  } catch (_) {
    return null;
  }
}

function agentDomainPickFilters(req, stream) {
  const conditions = [activeAuctionWhere()];
  const params = {};

  if (stream && stream !== 'all') {
    conditions.push('stream = @stream');
    params.stream = stream;
  }

  const requestedDateWindow = parseAgentAuctionDateWindow(req.query.date || req.query.day || req.query.auctionDate);
  const isCloseout = isGoDaddyCloseoutStream(stream);
  const dateFilterIgnoredReason = requestedDateWindow && isCloseout
    ? 'GoDaddy closeouts are a current BuyNow snapshot feed; date filters based on auctionEnd are ignored because auctionEnd is only the original auction transition time.'
    : null;
  const dateWindow = dateFilterIgnoredReason ? null : requestedDateWindow;
  if (dateWindow) {
    conditions.push(`COALESCE(auction_end, expiry_date, drop_date) IS NOT NULL
      AND datetime(COALESCE(auction_end, expiry_date, drop_date)) >= datetime(@dateStart)
      AND datetime(COALESCE(auction_end, expiry_date, drop_date)) < datetime(@dateEnd)`);
    params.dateStart = dateWindow.start;
    params.dateEnd = dateWindow.end;
  }

  const tld = req.query.tld;
  if (tld && tld !== 'all') {
    const tlds = String(tld).split(',').map(t => t.trim()).filter(Boolean);
    if (tlds.length === 1) {
      conditions.push('tld = @tld');
      params.tld = tlds[0].startsWith('.') ? tlds[0] : `.${tlds[0]}`;
    } else if (tlds.length > 1) {
      const placeholders = tlds.map((_, i) => `@tld${i}`).join(',');
      conditions.push(`tld IN (${placeholders})`);
      tlds.forEach((entry, i) => {
        params[`tld${i}`] = entry.startsWith('.') ? entry : `.${entry}`;
      });
    }
  }

  if (req.query.q) {
    const q = String(req.query.q).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const mode = req.query.searchMode || 'contains';
    if (mode === 'starts') {
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `${q}%`;
    } else if (mode === 'ends') {
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `%${q}`;
    } else {
      conditions.push('LOWER(domain) LIKE @q');
      params.q = `%${q}%`;
    }
  }

  if (req.query.maxPrice) {
    conditions.push('auction_price IS NOT NULL AND auction_price <= @maxPrice');
    params.maxPrice = parseFloat(req.query.maxPrice);
  }
  if (req.query.minPrice) {
    conditions.push('auction_price IS NOT NULL AND auction_price >= @minPrice');
    params.minPrice = parseFloat(req.query.minPrice);
  }
  if (req.query.minLength) {
    conditions.push('length >= @minLength');
    params.minLength = parseInt(req.query.minLength, 10);
  }
  if (req.query.maxLength) {
    conditions.push('length <= @maxLength');
    params.maxLength = parseInt(req.query.maxLength, 10);
  }
  if (req.query.noNumbers === '1') conditions.push('has_numbers = 0');
  if (req.query.noHyphens === '1') conditions.push('has_hyphens = 0');
  if (req.query.hasBids === '1') conditions.push('bid_count > 0');
  if (req.query.hasWayback === '1') conditions.push('wayback_snapshots > 0');
  if (req.query.saved === '1') conditions.push('saved = 1');
  if (req.query.seen === '0') conditions.push('seen = 0');
  if (req.query.skipped === '0') conditions.push('skipped = 0');

  if (req.query.domainSuffix) {
    const suffixes = String(req.query.domainSuffix).split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length === 1) {
      params.sfx0 = `%${suffixes[0]}`;
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx0");
    } else if (suffixes.length > 1) {
      const orParts = suffixes.map((s, i) => {
        params[`sfx${i}`] = `%${s}`;
        return `LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx${i}`;
      });
      conditions.push(`(${orParts.join(' OR ')})`);
    }
  }

  if (req.query.takenIn) {
    const tlds = String(req.query.takenIn).split(',').map(t => t.trim()).filter(Boolean)
      .map(t => t.startsWith('.') ? t : `.${t}`);
    attachZoneIndex();
    tlds.forEach((t, i) => {
      const key = `takenIn${i}`;
      params[key] = t;
      if (_zoneIndexAttached) {
        conditions.push(`${baseNameSql()} IN (
          SELECT base_name FROM domains WHERE tld = @${key}
          UNION
          SELECT base_name FROM zi.zone_names WHERE tld = @${key}
        )`);
      } else {
        conditions.push(`${baseNameSql()} IN (SELECT base_name FROM domains WHERE tld = @${key})`);
      }
    });
  }

  return { conditions, params, dateWindow, requestedDateWindow, dateFilterIgnoredReason };
}

function baseNameFromRow(row) {
  return String(row.domain || '').split('.')[0].toLowerCase();
}

function compareNullableValues(a, b, dir, stringMode = false) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (stringMode) return String(a).localeCompare(String(b)) * dir;
  const aNum = typeof a === 'number' ? a : Number(a);
  const bNum = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return (aNum - bNum) * dir;
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return (aTime - bTime) * dir;
  return String(a).localeCompare(String(b)) * dir;
}

function buildGoDaddyCacheCandidatesResponse(req, context) {
  const {
    stream,
    limitNum,
    candidateLimit,
    dateWindow,
    requestedDateWindow,
    dateFilterIgnoredReason,
    isCloseout,
    rawSortField,
    sortField,
    sortDir,
    allowedSortFields,
  } = context;

  if (!isGoDaddyInventoryStream(stream)) return null;
  if (req.query.takenIn || req.query.saved || req.query.seen || req.query.skipped) return null;

  const cache = readGoDaddyInventoryCache(stream);
  if (!cache || !Array.isArray(cache.domains)) return null;

  let rows = cache.domains;

  if (dateWindow && !dateFilterIgnoredReason) {
    const start = new Date(dateWindow.start).getTime();
    const end = new Date(dateWindow.end).getTime();
    rows = rows.filter((row) => {
      const time = new Date(row.auction_end || row.expiry_date || row.drop_date || '').getTime();
      return Number.isFinite(time) && time >= start && time < end;
    });
  }

  const tld = req.query.tld;
  if (tld && tld !== 'all') {
    const wanted = new Set(String(tld).split(',').map(t => t.trim()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`));
    rows = rows.filter(row => wanted.has(row.tld));
  }

  if (req.query.q) {
    const q = String(req.query.q).toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const mode = req.query.searchMode || 'contains';
    rows = rows.filter((row) => {
      const base = baseNameFromRow(row);
      if (mode === 'starts') return base.startsWith(q);
      if (mode === 'ends') return base.endsWith(q);
      return String(row.domain || '').toLowerCase().includes(q);
    });
  }

  if (req.query.domainSuffix) {
    const suffixes = String(req.query.domainSuffix).split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length) rows = rows.filter(row => suffixes.some(s => baseNameFromRow(row).endsWith(s)));
  }

  if (req.query.maxPrice) rows = rows.filter(row => row.auction_price != null && Number(row.auction_price) <= parseFloat(req.query.maxPrice));
  if (req.query.minPrice) rows = rows.filter(row => row.auction_price != null && Number(row.auction_price) >= parseFloat(req.query.minPrice));
  if (req.query.minLength) rows = rows.filter(row => Number(row.length) >= parseInt(req.query.minLength, 10));
  if (req.query.maxLength) rows = rows.filter(row => Number(row.length) <= parseInt(req.query.maxLength, 10));
  if (req.query.noNumbers === '1') rows = rows.filter(row => !row.has_numbers);
  if (req.query.noHyphens === '1') rows = rows.filter(row => !row.has_hyphens);
  if (req.query.hasBids === '1') rows = rows.filter(row => Number(row.bid_count || 0) > 0);
  if (req.query.hasWayback === '1') rows = rows.filter(row => Number(row.wayback_snapshots || 0) > 0);

  const dir = sortDir === 'ASC' ? 1 : -1;
  if (allowedSortFields.has(sortField)) {
    rows = [...rows].sort((a, b) => (
      compareNullableValues(a[sortField], b[sortField], dir, sortField === 'domain')
      || compareNullableValues(a.auction_end || a.expiry_date || a.drop_date, b.auction_end || b.expiry_date || b.drop_date, 1)
      || String(a.domain).localeCompare(String(b.domain))
    ));
  } else {
    rows = [...rows].sort((a, b) => (
      compareNullableValues(a.auction_end || a.expiry_date || a.drop_date, b.auction_end || b.expiry_date || b.drop_date, 1)
      || String(a.domain).localeCompare(String(b.domain))
    ));
  }

  const reviewedRows = rows.slice(0, candidateLimit);
  const candidates = reviewedRows.slice(0, limitNum).map(agentCandidateFromDomain);

  return {
    source: dateWindow
      ? `DomainScout ${agentStreamLabel(stream)} bulk inventory cache for ${dateWindow.label}`
      : `DomainScout current ${agentStreamLabel(stream)} bulk inventory cache`,
    stream,
    category: agentStreamLabel(stream),
    generatedAt: new Date().toISOString(),
    inventory: {
      ...(isCloseout ? closeoutInventoryMetadata() : { status: 'current active listing dataset' }),
      sourceFeed: stream === 'godaddy-auction' ? 'GoDaddy bulk biddable/expiring auction inventory' : 'closeout_listings.json.zip',
      latestCacheAt: cache.generatedAt,
      domainsInCache: cache.count,
      note: 'Served from raw GoDaddy bulk inventory cache so agents can work while the SQLite import/enrichment job continues.',
    },
    dateFilter: dateWindow ? { label: dateWindow.label, start: dateWindow.start, end: dateWindow.end } : null,
    requestedDateFilter: requestedDateWindow ? { label: requestedDateWindow.label, start: requestedDateWindow.start, end: requestedDateWindow.end, applied: !dateFilterIgnoredReason, ignoredReason: dateFilterIgnoredReason } : null,
    candidatesReviewed: reviewedRows.length,
    totalCandidatesMatched: rows.length,
    requestedLimit: limitNum,
    candidateOrdering: allowedSortFields.has(sortField)
      ? [`${sortField} ${sortDir}${rawSortField && rawSortField !== sortField ? ` (from sortField=${rawSortField})` : ''}`, 'then neutral date/discovery tie-breakers']
      : [
        'nearest relevant date',
        'domain name tie-breaker',
      ],
    sortableFields: [...allowedSortFields],
    availableSignals: [
      'tld',
      'length',
      'has_numbers',
      'has_hyphens',
      'bids',
      'price',
      'ageYears',
      'auctionEnd',
      'sourceUrl',
    ],
    notes: [
      isCloseout
        ? 'GoDaddy closeouts are BuyNow closeout snapshot rows from closeout_listings.json.zip; auctionEnd is the original auction transition time, not proof the closeout is unavailable.'
        : null,
      dateFilterIgnoredReason,
      dateWindow
        ? 'The date filter matches domains whose auction_end falls inside the requested local calendar day.'
        : 'No date filter was applied; current/latest means the current active dataset for the selected stream.',
      'This endpoint returns candidate data, not a purchase recommendation or final ranking.',
      'No third-party valuation fields are used here; agents should reason from the raw auction facts and follow-up research.',
    ].filter(Boolean),
    candidates,
  };
}

function buildAgentDomainCandidatesResponse(req, defaults = {}) {
  const limitNum = parseBoundedPositiveInt(req.query.limit, defaults.limit || 25, 1, 5000);
  const candidateLimit = parseBoundedPositiveInt(
    req.query.candidates,
    Math.max(250, limitNum),
    limitNum,
    10000
  );
  const stream = normalizeAgentStream(req.query.stream || req.query.category || defaults.stream, defaults.stream || 'godaddy-auction');
  const { conditions, params, dateWindow, requestedDateWindow, dateFilterIgnoredReason } = agentDomainPickFilters(req, stream);
  const scrapeInfo = latestScrapeForStream(stream);
  const isCloseout = isGoDaddyCloseoutStream(stream);
  const rawSortField = String(req.query.sortField || '').trim();
  const sortField = normalizeDomainSortField(rawSortField);
  const sortDir = req.query.sortDir === 'ASC' ? 'ASC' : 'DESC';
  const allowedSortFields = new Set(['auction_price', 'bid_count', 'tlds_taken', 'age_years', 'wayback_snapshots', 'length', 'auction_end', 'expiry_date', 'drop_date', 'domain']);
  const defaultOrdering = `
    COALESCE(auction_end, expiry_date, drop_date, discovered_at) ASC,
    discovered_at DESC
  `;
  const primarySort = allowedSortFields.has(sortField)
    ? `${sortField} ${sortDir} NULLS LAST, ${defaultOrdering}`
    : defaultOrdering;

  const cacheResponse = buildGoDaddyCacheCandidatesResponse(req, {
    stream,
    limitNum,
    candidateLimit,
    dateWindow,
    requestedDateWindow,
    dateFilterIgnoredReason,
    isCloseout,
    rawSortField,
    sortField,
    sortDir,
    allowedSortFields,
  });
  if (cacheResponse) return cacheResponse;

  const rows = db.prepare(`
    SELECT *
    FROM domains
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${primarySort},
      domain ASC
    LIMIT ${candidateLimit}
  `).all(params);

  enrichPageTldCounts(rows);
  const candidates = rows.slice(0, limitNum).map(agentCandidateFromDomain);

  return {
    source: dateWindow
      ? `DomainScout ${agentStreamLabel(stream)} dataset for ${dateWindow.label}`
      : `DomainScout current ${agentStreamLabel(stream)} dataset`,
    stream,
    category: agentStreamLabel(stream),
    generatedAt: new Date().toISOString(),
    inventory: scrapeInfo ? {
      ...(isCloseout ? closeoutInventoryMetadata() : { status: 'current active listing dataset' }),
      latestScrapeAt: scrapeInfo.ran_at,
      domainsFoundInLatestScrape: scrapeInfo.domains_found,
      domainsNewInLatestScrape: scrapeInfo.domains_new,
      error: scrapeInfo.error || null,
    } : (isCloseout ? closeoutInventoryMetadata() : null),
    dateFilter: dateWindow ? { label: dateWindow.label, start: dateWindow.start, end: dateWindow.end } : null,
    requestedDateFilter: requestedDateWindow ? { label: requestedDateWindow.label, start: requestedDateWindow.start, end: requestedDateWindow.end, applied: !dateFilterIgnoredReason, ignoredReason: dateFilterIgnoredReason } : null,
    candidatesReviewed: rows.length,
    requestedLimit: limitNum,
    candidateOrdering: allowedSortFields.has(sortField)
      ? [`${sortField} ${sortDir}${rawSortField && rawSortField !== sortField ? ` (from sortField=${rawSortField})` : ''}`, 'then neutral date/discovery tie-breakers']
      : [
        'nearest relevant date',
        'newer discovery timestamp',
      ],
    sortableFields: [...allowedSortFields],
    availableSignals: [
      'tld',
      'length',
      'has_numbers',
      'has_hyphens',
      'tldsTaken',
      'bids',
      'price',
      'ageYears',
      'waybackSnapshots',
      'auctionEnd/expiryDate/dropDate',
      'sourceUrl',
    ],
    notes: [
      isCloseout
        ? 'GoDaddy closeouts are BuyNow closeout snapshot rows from closeout_listings.json.zip; auctionEnd is the original auction transition time, not proof the closeout is unavailable.'
        : null,
      dateFilterIgnoredReason,
      dateWindow
        ? 'The date filter matches domains whose auction_end/expiry_date/drop_date falls inside the requested local calendar day.'
        : 'No date filter was applied; current/latest means the current active dataset for the selected stream.',
      'This endpoint returns candidate data, not a purchase recommendation or final ranking.',
      'Use sourceUrl and researchSignals for follow-up research on individual names.',
    ].filter(Boolean),
    candidates,
  };
}

app.get('/api/domains', (req, res) => {
  const cacheKey = req.url;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);
  const {
    stream, tld, q,
    minLength, maxLength,
    noNumbers, noHyphens,
    minAge, maxAge,
    hasWayback, dnsAvailable,
    seen, saved, skipped,
    takenIn,
    sortField = 'discovered_at', sortDir = 'DESC',
    page = 1, limit = 100,
  } = req.query;

  const conditions = [];
  const params = {};

  // Virtual "expiring" streams — actual registration expiry dates only (not auction close dates)
  const expiringMatch = stream && stream.match(/^_expiring(\d+)$/);
  if (expiringMatch) {
    const days = parseInt(expiringMatch[1]);
    conditions.push(`expiry_date IS NOT NULL AND expiry_date > datetime('now') AND expiry_date <= datetime('now','+${days} days') AND stream NOT IN ('godaddy-auction','namecheap-auction','marketplace')`);
    // Default sort for expiring view: soonest first
    if (!req.query.sortField) {
      Object.assign(req.query, { sortField: 'expiry_date', sortDir: 'ASC' });
    }
  } else if (stream && stream.match(/^_expired(\d+)$/)) {
    // Already expired — within the last N days
    // Exclude domains where expiry_date was backfilled from auction_end (not a real RDAP/WHOIS date).
    // auction_end is the marketplace/auction close date, NOT the domain registration expiry.
    const days = parseInt(stream.match(/^_expired(\d+)$/)[1]);
    conditions.push(`expiry_date IS NOT NULL AND expiry_date < datetime('now') AND expiry_date >= datetime('now','-${days} days') AND (auction_end IS NULL OR expiry_date != auction_end)`);
    if (!req.query.sortField) {
      Object.assign(req.query, { sortField: 'expiry_date', sortDir: 'DESC' });
    }
  } else if (stream && stream !== 'all') {
    conditions.push('stream = @stream');
    params.stream = stream;
  } else if (!stream || stream === 'all') {
    // ccTLDs (.ai/.io/.sh/.bot) are seeded almost entirely via crt.sh → 'discovered'.
    // When the user explicitly filters by a ccTLD, show all discovered for that TLD —
    // RDAP polling may not have run yet so filtering by expiry_date would show nothing.
    // For 'all TLDs', still hide unpolled discovered to avoid flooding with active sites.
    const ccTLDs = ['.ai', '.io', '.sh', '.bot'];
    const filteredTlds = tld && tld !== 'all'
      ? tld.split(',').map(t => t.trim()).map(t => t.startsWith('.') ? t : '.' + t)
      : [];
    const filteringByCcTLD = filteredTlds.length > 0 && filteredTlds.every(t => ccTLDs.includes(t));
    if (!filteringByCcTLD) {
      conditions.push("(stream != 'discovered' OR (expiry_date IS NOT NULL AND expiry_date <= datetime('now','+30 days')))");
    }
  }
  if (tld && tld !== 'all') {
    const tlds = tld.split(',').map(t => t.trim()).filter(Boolean);
    if (tlds.length === 1) {
      conditions.push('tld = @tld');
      params.tld = tlds[0].startsWith('.') ? tlds[0] : '.' + tlds[0];
    } else {
      const placeholders = tlds.map((t, i) => `@tld${i}`).join(',');
      conditions.push(`tld IN (${placeholders})`);
      tlds.forEach((t, i) => params[`tld${i}`] = t.startsWith('.') ? t : '.' + t);
    }
  }
  if (q) {
    const mode = req.query.searchMode || 'contains';
    if (mode === 'starts') {
      // Match base name starts with q (strip TLD: SUBSTR up to first dot)
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `${q.toLowerCase()}%`;
    } else if (mode === 'ends') {
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @q");
      params.q = `%${q.toLowerCase()}`;
    } else {
      conditions.push('domain LIKE @q');
      params.q = `%${q.toLowerCase()}%`;
    }
  }
  if (req.query.maxPrice) { conditions.push('auction_price IS NOT NULL AND auction_price <= @maxPrice'); params.maxPrice = parseFloat(req.query.maxPrice); }
  if (minLength) { conditions.push('length >= @minLength'); params.minLength = parseInt(minLength); }
  if (maxLength) { conditions.push('length <= @maxLength'); params.maxLength = parseInt(maxLength); }
  if (noNumbers === '1') conditions.push('has_numbers = 0');
  if (noHyphens === '1') conditions.push('has_hyphens = 0');
  if (minAge) { conditions.push('age_years >= @minAge'); params.minAge = parseInt(minAge); }
  if (maxAge) { conditions.push('age_years <= @maxAge'); params.maxAge = parseInt(maxAge); }
  if (hasWayback === '1') conditions.push('wayback_snapshots > 0');
  if (dnsAvailable === '1') conditions.push('dns_available = 1');
  if (req.query.hasBids === '1') conditions.push('bid_count > 0');
  if (seen === '1') conditions.push('seen = 1');
  if (seen === '0') conditions.push('seen = 0');
  if (saved === '1') conditions.push('saved = 1');
  if (skipped === '1') conditions.push('skipped = 1');
  if (skipped === '0') conditions.push('skipped = 0');
  conditions.push(activeAuctionWhere());

  // "Also taken in" filter — queries internal domains table (works for all TLDs immediately)
  // plus zone_names when the zone index is attached (broader coverage for gTLDs).
  if (takenIn) {
    const tlds = takenIn.split(',').map(t => t.trim()).filter(Boolean)
      .map(t => t.startsWith('.') ? t : '.' + t);
    attachZoneIndex();
    tlds.forEach((t, i) => {
      const key = `takenIn${i}`;
      params[key] = t;
      if (_zoneIndexAttached) {
        // Use both sources: internal DB + zone index (union covers ccTLDs and gTLDs)
        conditions.push(`${baseNameSql()} IN (
          SELECT base_name FROM domains WHERE tld = @${key}
          UNION
          SELECT base_name FROM zi.zone_names WHERE tld = @${key}
        )`);
      } else {
        // Fallback: internal DB only (always works)
        conditions.push(`${baseNameSql()} IN (SELECT base_name FROM domains WHERE tld = @${key})`);
      }
    });
  }

  // Expiry filter: expiringDays=90 shows domains expiring within N days
  if (req.query.expiringDays) {
    const days = parseInt(req.query.expiringDays);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString();
    conditions.push("expiry_date IS NOT NULL AND expiry_date <= @expiryCutoff AND expiry_date >= datetime('now')");
    params.expiryCutoff = cutoff;
  }

  // Expiry today: only domains whose expiry_date falls today
  if (req.query.expiryToday === '1') {
    conditions.push("expiry_date IS NOT NULL AND DATE(expiry_date) = DATE('now')");
  }

  // Domain suffix filter: comma-separated list of base-name suffixes (OR match)
  if (req.query.domainSuffix) {
    const suffixes = req.query.domainSuffix.split(',')
      .map(s => s.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
    if (suffixes.length === 1) {
      params.sfx0 = `%${suffixes[0]}`;
      conditions.push("LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx0");
    } else if (suffixes.length > 1) {
      const orParts = suffixes.map((s, i) => { params[`sfx${i}`] = `%${s}`; return `LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @sfx${i}`; });
      conditions.push(`(${orParts.join(' OR ')})`);
    }
  }

  const allowedFields = ['discovered_at', 'domain', 'length', 'tlds_taken', 'auction_price', 'age_years', 'wayback_snapshots', 'expiry_date', 'auction_end', 'bid_count'];
  const normalizedSortField = normalizeDomainSortField(sortField);
  const sortBy = allowedFields.includes(normalizedSortField) ? normalizedSortField : 'discovered_at';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
  const sortingByTlds = sortBy === 'tlds_taken';

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(10000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  // NULLS LAST lets SQLite use the index directly; expression-based sorts force a filesort
  const nullsLastFields = ['expiry_date', 'auction_price', 'age_years', 'tlds_taken', 'wayback_snapshots'];
  const orderClause = sortingByTlds
    ? `tlds_taken ${dir} NULLS LAST, domain ASC`
    : nullsLastFields.includes(sortBy)
    ? `${sortBy} ${dir} NULLS LAST`
    : `${sortBy} ${dir}`;

  const canUseFastList = !takenIn && !q && !req.query.domainSuffix;

  // If client already knows the total (e.g. from stats), skip the COUNT scan
  const knownTotal = req.query.knownTotal ? parseInt(req.query.knownTotal) : null;
  const total = (knownTotal != null && Number.isFinite(knownTotal))
    ? knownTotal
    : canUseFastList
      ? db.prepare(`SELECT COUNT(*) as n FROM domains ${where}`).get(params).n
      : db.prepare(`SELECT COUNT(DISTINCT domain) as n FROM domains ${where}`).get(params).n;

  let domains;
  if (canUseFastList) {
    domains = db.prepare(`
      SELECT *
      FROM domains ${where}
      ORDER BY ${orderClause}
      LIMIT ${limitNum} OFFSET ${offset}
    `).all(params);
  } else {
    // Deduplicate only for searches/filters where cross-stream duplicates are
    // likely enough to justify the expensive window function.
    domains = db.prepare(`
      SELECT * FROM (
        SELECT d.*, ROW_NUMBER() OVER (
          PARTITION BY domain
          ORDER BY COALESCE(auction_price, 9999999) ASC, id ASC
        ) AS _rn
        FROM domains d ${where}
      ) WHERE _rn = 1 ORDER BY ${orderClause} LIMIT ${limitNum} OFFSET ${offset}
    `).all(params);
  }
  enrichPageTldCounts(domains);

  const result = { total, page: pageNum, limit: limitNum, domains };
  setCached(cacheKey, result);
  res.json(result);
});

// ── AgentForge app-owned APIs ────────────────────────────────────────────────
app.get('/api/agentforge/streams', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        stream,
        COUNT(*) AS total,
        MIN(auction_price) AS minPrice,
        AVG(auction_price) AS avgPrice,
        MIN(COALESCE(auction_end, expiry_date, drop_date)) AS firstDate,
        MAX(COALESCE(auction_end, expiry_date, drop_date)) AS lastDate
      FROM domains
      WHERE ${activeAuctionWhere()}
      GROUP BY stream
      ORDER BY total DESC
    `).all();
    res.json({
      source: 'DomainScout stream inventory',
      generatedAt: new Date().toISOString(),
      streams: rows.map(row => {
        const scrapeInfo = latestScrapeForStream(row.stream);
        const closeout = isGoDaddyCloseoutStream(row.stream);
        return {
          stream: row.stream,
          category: agentStreamLabel(row.stream),
          total: row.total,
          minPrice: row.minPrice,
          avgPrice: row.avgPrice ? Number(row.avgPrice.toFixed(2)) : null,
          firstDate: row.firstDate,
          lastDate: row.lastDate,
          dateFieldMeaning: closeout
            ? closeoutInventoryMetadata().dateFieldMeaning
            : 'listing date range from auctionEnd, expiryDate, or dropDate',
          inventory: scrapeInfo ? {
            ...(closeout ? closeoutInventoryMetadata() : { status: 'current active listing dataset' }),
            latestScrapeAt: scrapeInfo.ran_at,
            domainsFoundInLatestScrape: scrapeInfo.domains_found,
            domainsNewInLatestScrape: scrapeInfo.domains_new,
            error: scrapeInfo.error || null,
          } : (closeout ? closeoutInventoryMetadata() : null),
          queryUrl: `/api/agentforge/domain-candidates?stream=${encodeURIComponent(row.stream)}&limit=1000`,
        };
      }),
      aliases: Object.fromEntries(AGENTFORGE_STREAM_ALIASES),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agentforge/domain-candidates', (req, res) => {
  try {
    res.json(buildAgentDomainCandidatesResponse(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compatibility endpoints for existing AgentForge prompts/runs.
app.get('/api/agentforge/domain-picks', (req, res) => {
  try {
    res.json(buildAgentDomainCandidatesResponse(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agentforge/godaddy-auction-picks', (req, res) => {
  try {
    res.json(buildAgentDomainCandidatesResponse(
      { query: { ...req.query, stream: 'godaddy-auction' } },
      { stream: 'godaddy-auction' }
    ));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const cached = getPersistentCache('stats');
  if (cached) {
    return res.json({ ...cached.value, cached: true, statsUpdatedAt: cached.updatedAt });
  }

  // First-ever run has no cache. Return a minimal indexed snapshot immediately
  // and compute the expensive expiry buckets in the background.
  const quick = {
    total: db.prepare(`SELECT COUNT(*) as n FROM domains WHERE ${activeAuctionWhere()}`).get().n,
    saved: db.prepare(`SELECT COUNT(*) as n FROM domains WHERE saved = 1 AND ${activeAuctionWhere()}`).get().n,
    unseen: db.prepare(`SELECT COUNT(*) as n FROM domains WHERE seen = 0 AND skipped = 0 AND ${activeAuctionWhere()}`).get().n,
    byStream: db.prepare(`SELECT stream, COUNT(*) as n FROM domains WHERE ${activeAuctionWhere()} GROUP BY stream`).all(),
    byTld: db.prepare(`SELECT tld, COUNT(*) as n FROM domains WHERE ${activeAuctionWhere()} GROUP BY tld ORDER BY n DESC`).all(),
    lastRun: db.prepare(`
      SELECT ran_at, stream, domains_found, domains_new FROM scrape_log
      ORDER BY ran_at DESC LIMIT 8
    `).all(),
    expired7: 0, expired14: 0, expired30: 0, expired60: 0,
    expiring1: 0, expiring7: 0, expiring14: 0, expiring30: 0, expiring60: 0, expiring90: 0,
    cached: false,
  };
  res.json(quick);
});

// ── PATCH /api/domains/:id ──────────────────────────────────────────────────
app.patch('/api/domains/:id', (req, res) => {
  const { seen, saved, skipped, notes } = req.body;
  const updates = [];
  const params = { id: req.params.id };

  if (seen !== undefined) { updates.push('seen = @seen'); params.seen = seen ? 1 : 0; }
  if (saved !== undefined) { updates.push('saved = @saved'); params.saved = saved ? 1 : 0; }
  if (skipped !== undefined) { updates.push('skipped = @skipped'); params.skipped = skipped ? 1 : 0; }
  if (notes !== undefined) { updates.push('notes = @notes'); params.notes = notes; }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  db.prepare(`UPDATE domains SET ${updates.join(', ')} WHERE id = @id`).run(params);
  res.json({ ok: true });
});

// ── DELETE /api/domains/:id ─────────────────────────────────────────────────
app.delete('/api/domains/:id', (req, res) => {
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── POST /api/scrape ────────────────────────────────────────────────────────
app.post('/api/scrape', (req, res) => {
  const result = startScrapeWorker('manual', { includeCZDS: false });
  res.json({
    ...result,
    message: result.ok ? 'Scrape started in background' : result.message,
  });
});

// ── GET /api/scrape-log ─────────────────────────────────────────────────────
app.get('/api/scrape-log', (req, res) => {
  const rows = db.prepare('SELECT * FROM scrape_log ORDER BY ran_at DESC LIMIT 50').all();
  res.json(rows);
});

// ── GET /api/tlds-check?baseName=botfuel ────────────────────────────────────
// On-demand TLD coverage check — runs DNS NS lookups across all ~160 TLDs,
// returns which are taken, updates tlds_taken in the DB for this base name.
app.get('/api/tlds-check', async (req, res) => {
  const raw = (req.query.baseName || '').toLowerCase().trim();
  if (!raw || !/^[a-z0-9-]+$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid baseName' });
  }
  try {
    const cached = req.query.force ? null : getCachedTldCheck(raw);
    if (cached && cached.allCount === getCheckTlds().length) {
      return res.json({
        baseName: raw,
        count: cached.count,
        taken: cached.taken,
        all: getCheckTlds(),
        cached: true,
        checkedAt: cached.checkedAt,
        tldUniverse: getTldSource(),
      });
    }
    const { count, taken } = await checkTldsTakenFull(raw);
    storeTldCheck(raw, taken, getCheckTlds().length, 'dns-full');
    bustCache();
    res.json({ baseName: raw, count, taken, all: getCheckTlds(), cached: false, tldUniverse: getTldSource(), checkedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sedo keyword search ──────────────────────────────────────────────────────
// Searches Sedo's marketplace for domains containing a keyword.
// Returns an array of { base_name, com: {price, url}|null, ai: {price, url}|null }
async function searchSedoKeyword(keyword, mode = 'prefix') {
  const partnerId = process.env.SEDO_PARTNER_ID;
  const signKey   = process.env.SEDO_SIGN_KEY;
  if (!partnerId || !signKey) return { results: [], configured: false };

  const axios = require('axios');
  const cheerio = require('cheerio');
  const allResults = {};   // base_name → { com, ai }

  // Search .com and .ai (the two TLDs we care about for this tool)
  const extensions = ['.com', '.ai', '.io', '.net', '.org', '.app', '.dev'];

  for (const ext of extensions) {
    let offset = 0;
    const loadsize = 200;

    // One page per TLD (Sedo can be slow — keep it targeted)
    const soap = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://sedo.com/namespaces/">
  <SOAP-ENV:Header>
    <ns1:Security>
      <ns1:UserAuth>
        <ns1:partnerid>${partnerId}</ns1:partnerid>
        <ns1:signkey>${signKey}</ns1:signkey>
      </ns1:UserAuth>
    </ns1:Security>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <ns1:DomainSearch>
      <ns1:keyword>${keyword}</ns1:keyword>
      <ns1:minimum_price>0</ns1:minimum_price>
      <ns1:maximum_price>10000000</ns1:maximum_price>
      <ns1:available_extensions>${ext}</ns1:available_extensions>
      <ns1:language>us</ns1:language>
      <ns1:sortby>domainalph</ns1:sortby>
      <ns1:offset>${offset}</ns1:offset>
      <ns1:loadsize>${loadsize}</ns1:loadsize>
    </ns1:DomainSearch>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

    try {
      const resp = await axios.post('https://api.sedo.com/api/v1/', soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': 'DomainSearch' },
        timeout: 20000,
      });
      const $ = cheerio.load(resp.data, { xmlMode: true });
      $('domain').each((_, el) => {
        const domainText = $(el).find('domainname').text().toLowerCase().trim();
        if (!domainText) return;
        const dotIdx = domainText.lastIndexOf('.');
        if (dotIdx < 0) return;
        const baseName = domainText.slice(0, dotIdx);
        const tld = domainText.slice(dotIdx);
        const cleanKeyword = keyword.toLowerCase();
        const matches = mode === 'suffix'
          ? baseName.endsWith(cleanKeyword)
          : mode === 'contains'
            ? baseName.includes(cleanKeyword)
            : baseName.startsWith(cleanKeyword);
        if (!matches) return;
        if (!allResults[baseName]) allResults[baseName] = { com: null, ai: null };
        const price = parseFloat($(el).find('price').text()) || null;
        const url = $(el).find('domainlink').text().trim() || `https://sedo.com/search/details/?domain=${domainText}`;
        const info = { exists: true, price, url, stream: 'marketplace', source: 'Sedo' };
        if (tld === '.com') allResults[baseName].com = info;
        else if (tld === '.ai') allResults[baseName].ai = info;
      });
    } catch (_) { /* skip failed TLD */ }

    await new Promise(r => setTimeout(r, 400));
  }

  return { results: allResults, configured: true };
}

function parseResearchTerms(raw) {
  return [...new Set(
    String(raw || '')
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2 && t !== 'or' && t !== 'and')
  )].slice(0, 6);
}

function nextPrefix(s) {
  if (!s) return '\uffff';
  const chars = s.split('');
  chars[chars.length - 1] = String.fromCharCode(chars[chars.length - 1].charCodeAt(0) + 1);
  return chars.join('');
}

function getCachedTldCheck(baseName) {
  const row = db.prepare(`
    SELECT base_name, count, taken_json, all_count, source, checked_at
    FROM tld_check_cache
    WHERE base_name = ?
  `).get(baseName);
  if (!row) return null;
  let taken = [];
  try { taken = JSON.parse(row.taken_json) || []; } catch (_) {}
  return {
    baseName: row.base_name,
    count: row.count,
    taken,
    allCount: row.all_count,
    source: row.source || 'cache',
    checkedAt: row.checked_at,
  };
}

const upsertTldCheckCache = db.prepare(`
  INSERT INTO tld_check_cache (base_name, count, taken_json, all_count, source, checked_at)
  VALUES (@baseName, @count, @takenJson, @allCount, @source, datetime('now'))
  ON CONFLICT(base_name) DO UPDATE SET
    count = excluded.count,
    taken_json = excluded.taken_json,
    all_count = excluded.all_count,
    source = excluded.source,
    checked_at = excluded.checked_at
`);

const upsertBaseTldCount = db.prepare(`
  INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
  VALUES (@baseName, @count, @source, datetime('now'))
  ON CONFLICT(base_name) DO UPDATE SET
    tld_count = excluded.tld_count,
    source = excluded.source,
    updated_at = excluded.updated_at
`);

function storeTldCheck(baseName, taken, allCount, source) {
  const cleanTaken = [...new Set(taken || [])].sort();
  upsertTldCheckCache.run({
    baseName,
    count: cleanTaken.length,
    takenJson: JSON.stringify(cleanTaken),
    allCount,
    source,
  });
  upsertBaseTldCount.run({
    baseName,
    count: cleanTaken.length,
    source: source || 'hybrid-cache',
  });
  db.prepare(`UPDATE domains SET tlds_taken = ?, tlds_checked_at = datetime('now')
              WHERE base_name = ?`).run(cleanTaken.length, baseName);
  return cleanTaken;
}

const researchHydrationQueue = new Set();
function queueResearchHydration(baseName) {
  const cleanBase = String(baseName || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanBase || researchHydrationQueue.has(cleanBase)) return false;
  researchHydrationQueue.add(cleanBase);
  setImmediate(async () => {
    try {
      await runHybridTldCheck(cleanBase);
    } catch (err) {
      console.warn(`[Research] background hydration failed for ${cleanBase}:`, err.message);
    } finally {
      researchHydrationQueue.delete(cleanBase);
    }
  });
  return true;
}

async function runHybridTldCheck(baseName, { force = false } = {}) {
  const cleanBase = String(baseName || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanBase) throw new Error('baseName required');

  const indexedTlds = getIndexedTldSet();
  const allTlds = getCheckTlds();
  const cached = force ? null : getCachedTldCheck(cleanBase);
  if (cached && cached.allCount === allTlds.length) {
    return {
      baseName: cleanBase,
      live: cached.taken,
      taken: cached.taken,
      count: cached.count,
      gapChecked: 0,
      zoneCoversAll: true,
      allCount: allTlds.length,
      cached: true,
      checkedAt: cached.checkedAt,
      tldUniverse: getTldSource(),
    };
  }

  const zoneTlds = getNameTlds(cleanBase);
  const gapTlds = allTlds.filter(t => !indexedTlds.has(t));
  if (gapTlds.length === 0) {
    const taken = storeTldCheck(cleanBase, zoneTlds, allTlds.length, 'zone-full');
    return {
      baseName: cleanBase,
      live: [],
      taken,
      count: taken.length,
      gapChecked: 0,
      zoneCoversAll: true,
      allCount: allTlds.length,
      cached: false,
      tldUniverse: getTldSource(),
    };
  }

  const dns = require('dns').promises;
  const resolveNs = async (domain, timeoutMs = 1800) => {
    try {
      await Promise.race([
        dns.resolveNs(domain),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs)),
      ]);
      return true;
    } catch (_) {
      return false;
    }
  };

  const results = [];
  const CONCURRENCY = 120;
  for (let i = 0; i < gapTlds.length; i += CONCURRENCY) {
    const batch = gapTlds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async tld =>
      (await resolveNs(cleanBase + tld)) ? tld : null
    ));
    results.push(...batchResults);
  }

  const live = results.filter(Boolean).sort();
  const taken = storeTldCheck(cleanBase, [...zoneTlds, ...live], allTlds.length, indexedTlds.size ? 'zone+dns-gap' : 'dns-full');
  bustCache();

  return {
    baseName: cleanBase,
    live,
    taken,
    count: taken.length,
    gapChecked: gapTlds.length,
    zoneCoversAll: false,
    allCount: allTlds.length,
    cached: false,
    tldUniverse: getTldSource(),
  };
}

// ── GET /api/name-research ──────────────────────────────────────────────────
// Returns unique base names matching a prefix, sorted by tlds_taken DESC NULLS LAST.
// Sources: zone index (pre-built from CZDS files) + internal DB + Sedo (if configured).
app.get('/api/name-research', async (req, res) => {
  try {
  const prefix = req.query.prefix ?? req.query.term ?? '';
  const rawMode = String(req.query.mode || 'prefix').toLowerCase();
  const modeAliases = {
    start: 'prefix',
    starts: 'prefix',
    startswith: 'prefix',
    prefix: 'prefix',
    contains: 'contains',
    contain: 'contains',
    suffix: 'suffix',
    ends: 'suffix',
    endswith: 'suffix',
  };
  const searchMode = modeAliases[rawMode] || 'prefix';
  const includeMarket = ['1', 'true', 'yes'].includes(String(req.query.market || req.query.includeMarket || req.query.sedo || '').toLowerCase());
  const includeTldLists = ['1', 'true', 'yes'].includes(String(req.query.tldLists || req.query.includeTldLists || '').toLowerCase());
  const terms = parseResearchTerms(prefix);
  if (!terms.length) {
    return res.status(400).json({ error: 'enter at least one term with 2+ characters' });
  }

  // ── Marketplace search is intentionally opt-in ────────────────────────────
  // The research view's critical path is the local zone/cache index. Sedo is
  // network-bound and can add seconds to every query, so only run it when the
  // caller explicitly asks for marketplace enrichment.
  const sedoPromise = includeMarket
    ? Promise.all(terms.map(term => searchSedoKeyword(term, searchMode)))
    : Promise.resolve([]);

  // ── Zone index query — full universe ──
  const zoneRows = [];
  for (const term of terms) {
    zoneRows.push(...queryZoneIndex(term, searchMode, { includeTldList: includeTldLists }));
  }

  // Build resultMap from zone index first (most comprehensive tld_count source)
  const resultMap = {};
  for (const row of zoneRows) {
    const tldList = row.tld_list ? row.tld_list.split(',').sort() : undefined;
    resultMap[row.base_name] = {
      base_name:  row.base_name,
      tlds_taken: row.tld_count,
      tld_list:   tldList,
      com: null,
      ai:  null,
    };
  }

  const mergeTldCoverage = (baseName, tldCount, tldList = []) => {
    const incoming = [...new Set(tldList || [])].sort();
    if (!resultMap[baseName]) {
      resultMap[baseName] = {
        base_name: baseName,
        tlds_taken: incoming.length || tldCount || null,
        tld_list: incoming,
        com: null,
        ai: null,
      };
      return;
    }
    const existing = resultMap[baseName].tld_list || [];
    const merged = [...new Set([...existing, ...incoming])].sort();
    if (merged.length) resultMap[baseName].tld_list = merged;
    resultMap[baseName].tlds_taken = Math.max(
      resultMap[baseName].tlds_taken || 0,
      tldCount || 0,
      merged.length || 0,
    );
  };

  // ── Internal DB: all base names matching prefix ──
  // Adds names not yet in zone index (expiring/auction domains), and enriches
  // tlds_taken where the DNS-checked value exceeds the zone index count.
  const dbWhere = terms.map((_, i) => searchMode === 'prefix'
    ? `(domain >= @term${i}Lo AND domain < @term${i}Hi)`
    : `LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @term${i}`
  ).join(' OR ');
  const dbParams = {};
  terms.forEach((term, i) => {
    if (searchMode === 'prefix') {
      dbParams[`term${i}Lo`] = term;
      dbParams[`term${i}Hi`] = nextPrefix(term);
    } else if (searchMode === 'suffix') {
      dbParams[`term${i}`] = `%${term}`;
    } else {
      dbParams[`term${i}`] = `%${term}%`;
    }
  });
  const dbNames = db.prepare(`
    SELECT
      LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) as base_name,
      MAX(tlds_taken) as tlds_taken,
      COUNT(*) as domain_count
    FROM domains
    WHERE ${dbWhere}
    GROUP BY base_name
    ORDER BY tlds_taken DESC NULLS LAST, domain_count DESC
  `).all(dbParams);

  // Track which names came from the internal DB (always shown regardless of tld_count)
  const dbNameSet = new Set();
  for (const n of dbNames) {
    dbNameSet.add(n.base_name);
    if (!resultMap[n.base_name]) {
      resultMap[n.base_name] = { base_name: n.base_name, tlds_taken: n.tlds_taken, com: null, ai: null };
    } else if (n.tlds_taken != null &&
               (resultMap[n.base_name].tlds_taken == null || n.tlds_taken > resultMap[n.base_name].tlds_taken)) {
      resultMap[n.base_name].tlds_taken = n.tlds_taken;
    }
  }

  // ── Cached exact TLD checks ───────────────────────────────────────────────
  // This is the ExpiredDomains-style fast path: research should sort from a
  // persisted index/cache, not live-check every row in the browser.
  const cacheWhere = terms.map((_, i) => searchMode === 'prefix'
    ? `(base_name >= @term${i}Lo AND base_name < @term${i}Hi)`
    : `base_name LIKE @term${i}`
  ).join(' OR ');
  const cacheNameSet = new Set();
  const cachedRows = db.prepare(`
    SELECT base_name, count, taken_json, all_count, checked_at
    FROM tld_check_cache
    WHERE ${cacheWhere}
  `).all(dbParams);
  for (const row of cachedRows) {
    cacheNameSet.add(row.base_name);
    let tldList = [];
    try { tldList = JSON.parse(row.taken_json) || []; } catch (_) {}
    const shouldIncludeTldList = includeTldLists || terms.includes(row.base_name);
    if (!resultMap[row.base_name]) {
      resultMap[row.base_name] = {
        base_name: row.base_name,
        tlds_taken: row.count,
        tld_list: shouldIncludeTldList ? tldList : undefined,
        com: null,
        ai: null,
      };
    } else {
      resultMap[row.base_name].tlds_taken = row.count;
      if (shouldIncludeTldList) resultMap[row.base_name].tld_list = tldList;
      resultMap[row.base_name].tlds_checked_at = row.checked_at;
    }
  }

  // Keep single-TLD names. Research is a universe view; ranking/filtering can
  // happen in the UI, but the API should not hide real registered names.

  // Exact terms should be definitive immediately. Prefix/contains searches can
  // render from the zone index first, but if the user searches "agenttools",
  // returning only the partial zone count is misleading while CZDS is still
  // building. Hydrate exact matches through the hybrid zone+DNS gap checker.
  const exactHydrated = [];
  const exactQueued = [];
  for (const baseName of terms.filter(t => resultMap[t]).slice(0, 3)) {
    const cached = getCachedTldCheck(baseName);
    const needsHydration = !cached || cached.allCount !== getCheckTlds().length;
    if (!needsHydration) continue;
    if (queueResearchHydration(baseName)) exactQueued.push(baseName);
  }

  // ── .com / .ai enrichment — single prefix query per TLD (fast: uses tld index) ──
  // All names in resultMap share the same prefix, so one LIKE query covers everything.
  const domainWhere = terms.map((_, i) => searchMode === 'prefix'
    ? `(domain >= ? AND domain < ?)`
    : `LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) LIKE ?`
  ).join(' OR ');
  const domainPatterns = terms.flatMap(term => {
    if (searchMode === 'prefix') return [term, nextPrefix(term)];
    if (searchMode === 'suffix') return [`%${term}`];
    return [`%${term}%`];
  });
  for (const row of db.prepare(`
    SELECT LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) as base_name,
           domain, auction_price, auction_url, stream, source
    FROM domains WHERE tld='.com' AND (${domainWhere})
  `).all(...domainPatterns)) {
    const e = resultMap[row.base_name];
    if (e && (!e.com || (row.auction_price && !e.com.price)))
      e.com = { exists: true, price: row.auction_price, url: row.auction_url, stream: row.stream, source: row.source };
  }
  for (const row of db.prepare(`
    SELECT LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) as base_name,
           domain, auction_price, auction_url, stream, source
    FROM domains WHERE tld='.ai' AND (${domainWhere})
  `).all(...domainPatterns)) {
    const e = resultMap[row.base_name];
    if (e && (!e.ai || (row.auction_price && !e.ai.price)))
      e.ai = { exists: true, price: row.auction_price, url: row.auction_url, stream: row.stream, source: row.source };
  }

  // ── Merge Sedo results ──
  const sedoResponses = await sedoPromise;
  const sedoConfigured = sedoResponses.some(r => r.configured);
  const sedoResults = {};
  for (const response of sedoResponses) {
    for (const [baseName, info] of Object.entries(response.results || {})) {
      if (!sedoResults[baseName]) sedoResults[baseName] = { com: null, ai: null };
      if (info.com && (!sedoResults[baseName].com || (!sedoResults[baseName].com.price && info.com.price))) {
        sedoResults[baseName].com = info.com;
      }
      if (info.ai && (!sedoResults[baseName].ai || (!sedoResults[baseName].ai.price && info.ai.price))) {
        sedoResults[baseName].ai = info.ai;
      }
    }
  }
  for (const [baseName, info] of Object.entries(sedoResults)) {
    if (!resultMap[baseName]) {
      resultMap[baseName] = { base_name: baseName, tlds_taken: null, com: null, ai: null };
    }
    const e = resultMap[baseName];
    if (info.com && (!e.com || (!e.com.price && info.com.price))) e.com = info.com;
    if (info.ai  && (!e.ai  || (!e.ai.price  && info.ai.price)))  e.ai  = info.ai;
  }

  // Sort: tlds_taken DESC NULLS LAST, then alphabetically
  const sorted = Object.values(resultMap).sort((a, b) => {
    if (a.tlds_taken != null && b.tlds_taken != null) return b.tlds_taken - a.tlds_taken;
    if (a.tlds_taken != null) return -1;
    if (b.tlds_taken != null) return 1;
    return a.base_name.localeCompare(b.base_name);
  });

  const zoneStats = getZoneIndexStats();
  res.json({
    names: sorted,
    total: sorted.length,
    sedoConfigured,
    sedoCount:       Object.keys(sedoResults).length,
    zoneIndexedTlds: zoneStats.tlds,
    zoneIndexedNames: zoneStats.names,
    zoneAuthoritative: zoneStats.tlds > 0 && zoneStats.names > 0,
    summaryNames: zoneStats.summaryNames,
    summaryHits: zoneStats.summaryHits,
    zoneResultCount: zoneRows.length,
    exactHydrated,
    exactQueued,
    terms,
    tldUniverse: getTldSource(),
  });
  } catch (err) {
    console.error('[Research] handler error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// ── GET /api/zone-tlds ──────────────────────────────────────────────────────
// Returns all TLDs a base name is registered in (from zone index).
app.get('/api/zone-tlds', (req, res) => {
  const baseName = (req.query.baseName || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!baseName) return res.status(400).json({ error: 'baseName required' });
  const tlds = getNameTlds(baseName);
  res.json({ baseName, tlds });
});

// ── GET /api/tlds-check-hybrid ───────────────────────────────────────────────
// Live DNS check for all CHECK_TLDS not yet covered by the zone index.
// ccTLDs (e.g. .de .jp .br) will always be gap TLDs since CZDS only covers gTLDs.
// gTLDs auto-retire from the gap list once their zone file is indexed.
app.get('/api/tlds-check-hybrid', async (req, res) => {
  const baseName = (req.query.baseName || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!baseName) return res.status(400).json({ error: 'baseName required' });
  try {
    res.json(await runHybridTldCheck(baseName, { force: !!req.query.force }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/bulk-availability ─────────────────────────────────────────────
// Batch check domain availability via GoDaddy API. Returns available + price
// for each domain in one call, so frontend can skip lander checks for unregistered names.
app.post('/api/bulk-availability', express.json(), async (req, res) => {
  const domains = req.body;
  if (!Array.isArray(domains) || !domains.length) return res.json({ domains: [] });
  const apiKey    = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(503).json({ error: 'GoDaddy API not configured' });

  // Sanitize — only valid-looking domain strings, max 500
  const clean = domains
    .filter(d => typeof d === 'string' && /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(d))
    .slice(0, 500);
  if (!clean.length) return res.json({ domains: [] });

  try {
    const axios = require('axios');
    const resp = await axios.post(
      'https://api.godaddy.com/v1/domains/available?checkType=FAST',
      clean,
      {
        headers: {
          Authorization: `sso-key ${apiKey}:${apiSecret}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /api/lander-check ───────────────────────────────────────────────────
// Check if a domain is listed for sale via HTTP lander detection.
// Checks internal DB first, then makes an HTTP request to detect landers.
const landerCache = new Map();
const LANDER_CACHE_TTL = 30 * 60 * 1000; // 30 min

const LANDER_PLATFORMS = [
  ['afternic', 'Afternic'],
  ['sedo.com', 'Sedo'],
  ['sedo.de', 'Sedo'],
  ['dan.com', 'Dan.com'],
  ['efty.com', 'Efty'],
  ['undeveloped.com', 'Undeveloped'],
  ['squadhelp', 'Squadhelp'],
  ['hugedomains', 'HugeDomains'],
  ['brandpa', 'Brandpa'],
  ['cashparking', 'GoDaddy Parking'],
  ['uniregistry', 'Uniregistry'],
  ['bolddomains', 'BoldDomains'],
  ['atom.com', 'Atom'],
  ['brandroot', 'Brandroot'],
  ['saw.com', 'Saw.com'],
  ['namerific', 'Namerific'],
  ['domainsbot', 'DomainsBOT'],
  ['epik.com', 'Epik'],
  ['namecheap.com/market', 'Namecheap Market'],
];

const FOR_SALE_PHRASES = [
  'for sale', 'buy this domain', 'purchase this domain',
  'make an offer', 'domain for sale', 'buy domain', 'acquire this domain',
  'buy now', 'buy this domain name', 'lease to own', 'own this domain',
  'this domain is available', 'domain is for sale', 'inquire about this domain',
];

async function checkLander(domain) {
  const axios = require('axios');
  const opts = {
    timeout: 7000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DomainResearch/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    responseType: 'text',
    maxContentLength: 40000,
    validateStatus: () => true,
  };

  const tryCheck = async (url) => {
    const resp = await axios.get(url, opts);
    const body = typeof resp.data === 'string' ? resp.data : '';
    const bodyLow = body.toLowerCase().slice(0, 40000);
    const finalUrl = ((resp.request && resp.request.res && resp.request.res.responseUrl) || url).toLowerCase();

    // If the domain redirected to a completely different hostname, it's a marketplace lander
    const origHost = url.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase();
    const finalHost = finalUrl.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase();
    const wasRedirected = finalHost && origHost && finalHost !== origHost;

    let platform = null;
    for (const [kw, name] of LANDER_PLATFORMS) {
      if (finalUrl.includes(kw) || bodyLow.includes(kw)) { platform = name; break; }
    }
    // If redirected to an unrecognised marketplace, label it by the destination hostname
    if (!platform && wasRedirected) platform = finalHost.replace(/^www\./, '');

    const isForSale = !!platform || wasRedirected || FOR_SALE_PHRASES.some(p => bodyLow.includes(p));

    let price = null;
    if (isForSale) {
      // HugeDomains-specific: fetch their profile page directly for accurate price
      if (platform === 'HugeDomains' && finalUrl.includes('hugedomains')) {
        try {
          const hdResp = await axios.get(finalUrl, { ...opts, maxRedirects: 2 });
          const hdBody = typeof hdResp.data === 'string' ? hdResp.data : '';
          // Try JSON-in-HTML patterns first (e.g. data attributes, embedded JSON)
          const jsonPrice = hdBody.match(/"(?:price|listPrice|buyPrice|salePrice)"\s*:\s*(\d+)/i);
          if (jsonPrice) {
            const v = parseInt(jsonPrice[1]);
            if (v >= 100 && v <= 50000000) price = v;
          }
          // Fallback: dollar-amount regex on their page
          if (!price) {
            const matches = hdBody.match(/\$\s*([\d,]{3,})/g) || [];
            for (const m of matches) {
              const v = parseInt(m.replace(/[^\d]/g, ''));
              if (v >= 100 && v <= 50000000) { price = v; break; }
            }
          }
        } catch (_) {}
      }

      // Generic price extraction — tries multiple sources in order of reliability

      // 1. JSON-LD structured data (present in initial HTML even on React SPAs)
      if (!price) {
        const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let ldm;
        while ((ldm = ldRe.exec(body)) !== null && !price) {
          const pm = ldm[1].match(/"price"\s*:\s*"?([\d.]+)"?/i);
          if (pm) { const v = parseFloat(pm[1]); if (v >= 100 && v <= 50000000) price = Math.round(v); }
        }
      }

      // 2. JSON-embedded price in script tags / data blobs
      if (!price) {
        const jsonPrice = body.match(/"(?:price|listPrice|buyPrice|salePrice|buyNowPrice|askingPrice)"\s*:\s*"?([\d.]+)"?/i);
        if (jsonPrice) { const v = parseFloat(jsonPrice[1]); if (v >= 100 && v <= 50000000) price = Math.round(v); }
      }

      // 3. Meta tags — og:description / name="description" (SPAs put price here for SEO)
      if (!price) {
        const metaRe = /<meta[^>]+content=["']([^"']{0,400})["'][^>]*>/gi;
        let mm;
        while ((mm = metaRe.exec(body)) !== null && !price) {
          const pm = mm[1].match(/\$([\d,]+)/);
          if (pm) { const v = parseInt(pm[1].replace(/,/g, '')); if (v >= 100 && v <= 50000000) price = v; }
        }
      }

      // 4. Dollar-amount anywhere in the body
      if (!price) {
        const matches = body.match(/\$\s*([\d,]{3,})/g) || [];
        for (const m of matches) {
          const val = parseInt(m.replace(/[^\d]/g, ''));
          if (val >= 500 && val <= 50000000) { price = val; break; }
        }
      }
    }

    return { forSale: isForSale, price, platform };
  };

  // Try HTTP first, fall back to HTTPS
  try {
    return await tryCheck(`http://${domain}/`);
  } catch (err) {
    try {
      return await tryCheck(`https://${domain}/`);
    } catch (err2) {
      const msg = err2.code || err2.message || 'error';
      if (msg === 'ENOTFOUND') return { forSale: false, error: 'not resolving' };
      if (msg.includes('TIMEOUT') || msg === 'ETIMEDOUT') return { forSale: false, error: 'timeout' };
      return { forSale: false, error: msg.slice(0, 40) };
    }
  }
}

app.get('/api/lander-check', async (req, res) => {
  const { domain } = req.query;
  if (!domain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain' });
  }
  const d = domain.toLowerCase().trim();

  // Memory cache
  const cached = landerCache.get(d);
  if (cached && Date.now() - cached.ts < LANDER_CACHE_TTL) {
    return res.json(cached.data);
  }

  // Internal DB check first
  const dbRow = db.prepare(`
    SELECT domain, auction_price, auction_url, stream, source
    FROM domains WHERE domain = ? LIMIT 1
  `).get(d);

  if (dbRow && (dbRow.auction_price || dbRow.stream === 'marketplace' || dbRow.stream === 'godaddy-premium')) {
    const result = {
      domain: d, forSale: true, source: 'db',
      price: dbRow.auction_price, url: dbRow.auction_url,
      platform: dbRow.source || dbRow.stream,
    };
    landerCache.set(d, { data: result, ts: Date.now() });
    return res.json(result);
  }

  try {
    const result = await checkLander(d);
    result.domain = d;
    result.source = 'http';
    landerCache.set(d, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    res.json({ domain: d, forSale: false, error: err.message });
  }
});

// ── GET /api/config-status ──────────────────────────────────────────────────
app.get('/api/config-status', (req, res) => {
  const zoneStats = getZoneIndexStats();
  res.json({
    czdsConfigured: !!(process.env.CZDS_USER && process.env.CZDS_PASS),
    czdsSyncRunning,
    czdsWorkerPid: czdsChild?.pid || null,
    prefixScanRunning,
    prefixScanPrefix,
    prefixScanPid: prefixScanChild?.pid || null,
    envFile: require('fs').existsSync(path.join(__dirname, '../.env')),
    tldUniverse: getTldSource(),
    zoneIndex: zoneStats,
  });
});

let czdsSyncRunning = false;
let czdsChild = null;
let prefixScanRunning = false;
let prefixScanChild = null;
let prefixScanPrefix = null;
function startCzdsSync(reason = 'manual', options = {}) {
  if (czdsSyncRunning) {
    console.log(`[CZDS] ${reason} sync skipped - already running`);
    return false;
  }
  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    console.warn(`[CZDS] ${reason} sync skipped - CZDS_USER and CZDS_PASS are required`);
    return false;
  }
  czdsSyncRunning = true;
  const script = path.join(__dirname, 'czds-sync.js');
  const childArgs = [script, options.includeHeavy ? '--full' : '--fast'];
  if (options.maxTlds) childArgs.push(`--max-tlds=${options.maxTlds}`);
  if (options.maxZoneMb) childArgs.push(`--max-zone-mb=${options.maxZoneMb}`);

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  console.log(`[CZDS] Starting ${reason} sync in worker process...`);
  czdsChild = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  czdsChild.on('exit', (code, signal) => {
    czdsSyncRunning = false;
    czdsChild = null;
    bustCache();
    const stats = getZoneIndexStats();
    setImmediate(() => syncBaseTldCounts({ force: true, reason: 'CZDS worker completion' }));
    console.log(`[CZDS] Worker finished (${signal || code}); ${stats.tlds} TLDs, ${stats.names.toLocaleString()} names indexed`);
  });
  czdsChild.on('error', (err) => {
    czdsSyncRunning = false;
    czdsChild = null;
    console.error('[CZDS] Worker failed to start:', err.message);
  });
  return true;
}

app.post('/api/czds-sync', requireAuth, async (req, res) => {
  if (czdsSyncRunning) return res.status(409).json({ error: 'CZDS sync already running' });
  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    return res.status(400).json({ error: 'CZDS_USER and CZDS_PASS are required in .env' });
  }
  const full = req.query.full === '1' || req.body?.full === true;
  startCzdsSync(full ? 'manual full' : 'manual fast', {
    fast: !full,
    includeHeavy: full,
  });
  res.json({
    ok: true,
    mode: full ? 'full' : 'fast',
    message: full
      ? 'Full CZDS sync started. This includes heavyweight zones and can run for hours.'
      : 'Fast CZDS sync started. Heavyweight zones are deferred; research fills from smaller zones first.',
  });
});

function startPrefixScan(prefix, { force = false } = {}) {
  const cleanPrefix = normalizePrefix(prefix);
  if (!cleanPrefix || cleanPrefix.length < 2) return { ok: false, error: 'Enter a prefix with 2+ characters' };
  if (prefixScanRunning) {
    return { ok: false, error: `Deep prefix scan already running for "${prefixScanPrefix}"` };
  }
  if (!process.env.CZDS_USER || !process.env.CZDS_PASS) {
    return { ok: false, error: 'CZDS_USER and CZDS_PASS are required in .env' };
  }

  const script = path.join(__dirname, 'czds-prefix-scan.js');
  const childArgs = [script, `--prefix=${cleanPrefix}`];
  if (force) childArgs.push('--force');

  let command = process.execPath;
  let args = childArgs;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    command = '/usr/bin/nice';
    args = ['-n', '10', process.execPath, ...childArgs];
  }

  prefixScanRunning = true;
  prefixScanPrefix = cleanPrefix;
  console.log(`[PrefixScan] Starting deep prefix scan for "${cleanPrefix}" in worker process...`);
  prefixScanChild = spawn(command, args, {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  prefixScanChild.on('exit', (code, signal) => {
    console.log(`[PrefixScan] Worker finished for "${cleanPrefix}" (${signal || code})`);
    prefixScanRunning = false;
    prefixScanChild = null;
    prefixScanPrefix = null;
    bustCache();
  });
  prefixScanChild.on('error', (err) => {
    console.error('[PrefixScan] Worker failed to start:', err.message);
    prefixScanRunning = false;
    prefixScanChild = null;
    prefixScanPrefix = null;
  });
  return { ok: true, prefix: cleanPrefix };
}

app.post('/api/research-prefix-sync', requireAuth, async (req, res) => {
  const prefix = req.query.prefix || req.body?.prefix || '';
  const force = req.query.force === '1' || req.body?.force === true;
  const result = startPrefixScan(prefix, { force });
  if (!result.ok) return res.status(409).json(result);
  res.json({
    ok: true,
    prefix: result.prefix,
    message: `Deep prefix scan started for "${result.prefix}". Research will fill as each TLD is streamed.`,
  });
});

// ── Cron: auctions/market/expiry every 6h, CZDS zone universe daily ─────────
cron.schedule('0 */6 * * *', () => {
  const result = startScrapeWorker('scheduled', { includeCZDS: false });
  if (!result.ok) {
    console.log(`[Cron] Skipping — ${result.message}${result.pid ? ` (pid ${result.pid})` : ''}`);
  }
});

cron.schedule('15 2 * * *', () => {
  startCzdsSync('daily full', { fast: false, includeHeavy: true });
});

// ── GET /api/trends ──────────────────────────────────────────────────────────
// Returns TLD registration growth % and trending keywords from today's zone diff.
app.get('/api/trends', requireAuth, (req, res) => {
  const tlds = getTldTrends(Math.min(500, Math.max(1, parseInt(req.query.tldLimit || 150))));
  const keywords = getKeywordTrends(Math.min(1000, Math.max(1, parseInt(req.query.keywordLimit || 300))));
  res.json({
    hasData:  hasTrendData(),
    tlds,
    keywords,
    tldMode: tlds.some(t => t.baseline) ? 'baseline' : 'growth',
    keywordMode: keywords.some(k => k.source === 'coverage-baseline') ? 'coverage-baseline' : 'daily-diff',
  });
});

app.get('/api/tld-trends', requireAuth, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || 150)));
  const tlds = getTldTrends(limit);
  res.json({
    hasData: tlds.length > 0,
    mode: tlds.some(t => t.baseline) ? 'baseline' : 'growth',
    tlds,
  });
});

app.get('/api/keyword-trends', requireAuth, (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || 300)));
  const keywords = getKeywordTrends(limit);
  res.json({
    hasData: keywords.length > 0,
    mode: keywords.some(k => k.source === 'coverage-baseline') ? 'coverage-baseline' : 'daily-diff',
    keywords,
  });
});

// ── GET /api/zone-index-status ──────────────────────────────────────────────
// Returns how many TLDs and names are currently in the zone index.
app.get('/api/zone-index-status', requireAuth, (req, res) => {
  const stats = getZoneIndexStats();
  res.json(stats);
});

// ── POST /api/zone-index-rebuild ─────────────────────────────────────────────
// Trigger a background rebuild of the zone index from downloaded zone files.
app.post('/api/zone-index-rebuild', requireAuth, (req, res) => {
  indexAllPendingZoneFiles().catch(err => console.error('[ZoneIndex rebuild]', err.message));
  res.json({ ok: true, message: 'Zone index rebuild started in background' });
});

// ── Serve frontend ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🔭 DomainScout running at http://localhost:${PORT} [build:godaddy-split]`);
  console.log('Scrape schedule: every 6 hours');
  console.log('Run manual scrape: POST /api/scrape\n');

  refreshLogicalTlds()
    .then(info => console.log(`[TLDs] ${info.count} logical TLDs loaded from ${info.source}${info.error ? ` (refresh error: ${info.error})` : ''}`))
    .catch(err => console.warn('[TLDs] refresh failed:', err.message));

  // Auto-scrape on startup if the database is empty
  const domainCount = db.prepare('SELECT COUNT(*) as n FROM domains').get().n;
  if (domainCount === 0) {
    const result = startScrapeWorker('startup-empty-db', { includeCZDS: false });
    if (!result.ok) console.log(`[Startup] Initial scrape skipped — ${result.message}`);
  }

  // The CZDS zone index is the primary fast TLD-coverage source. The legacy
  // DNS worker is opt-in because checking every local base name across the full
  // IANA TLD universe can monopolize SQLite and make the app feel slow.
  if (process.env.ENABLE_TLDS_WORKER === '1') {
    startWorker();
  } else {
    console.log('[TLDs Worker] Disabled (set ENABLE_TLDS_WORKER=1 to enable legacy DNS backfill)');
  }

  // Start background zone file indexing — builds zone_index.db from any downloaded
  // CZDS zone files. Runs silently; research queries use the index once it's built.
  setTimeout(() => {
    indexAllPendingZoneFiles().catch(err => console.error('[ZoneIndex startup]', err.message));
    attachZoneIndex(); // attach for cross-DB filtering (zone_index.db created by zone-indexer)
    if (process.env.ENABLE_STARTUP_TLD_COUNT_SYNC === '1') {
      setImmediate(() => syncBaseTldCounts({ reason: 'startup' }));
    } else {
      console.log('[TLDCounts] Startup sync disabled; set ENABLE_STARTUP_TLD_COUNT_SYNC=1 for maintenance');
    }
  }, 8000);

  // Run migrations + rescrape after server is healthy (non-blocking)
  setTimeout(async () => {
    try {
      const c1 = db.prepare(`UPDATE domains SET stream = 'godaddy-closeout' WHERE source = 'GoDaddy Closeout' AND stream = 'godaddy-auction'`).run();
      console.log(`[Migration] closeout re-tag: ${c1.changes} rows`);
      // Remove duplicate GoDaddy rows: if a domain exists in both streams, keep the closeout row only
      const c3 = db.prepare(`DELETE FROM domains WHERE stream = 'godaddy-auction' AND domain IN (SELECT domain FROM domains WHERE stream = 'godaddy-closeout')`).run();
      console.log(`[Migration] GoDaddy dedup: removed ${c3.changes} auction rows that also had a closeout row`);
      const c4 = purgeEndedAuctions(db);
      console.log(`[Migration] ended auction purge: removed ${c4} rows`);
      if (c1.changes || c3.changes || c4) {
        bustCache();
        invalidateStatsCache();
      }
    } catch (err) {
      console.error('[Migration error]', err.message);
    }
    // Re-scrape if closeout stream is empty (first deploy after split)
    const closeoutCount = db.prepare(`SELECT COUNT(*) as n FROM domains WHERE stream = 'godaddy-closeout'`).get().n;
    if (closeoutCount === 0) {
      const result = startScrapeWorker('startup-empty-closeout', { includeCZDS: false });
      if (!result.ok) console.log(`[Startup] closeout scrape skipped — ${result.message}`);
    }
  }, 5000);
});
