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
    if (/\.(zone|zone\.gz)$/.test(f)) {
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
const db = require('./db');
const { scrapeAll } = require('./scrape-all');
const { startWorker } = require('./tlds-worker');
const { checkTldsTakenFull } = require('../enrichment');
const { CHECK_TLDS } = require('./tlds-list');
const { indexAllPendingZoneFiles, queryZoneIndex, getZoneIndexStats,
        getTldTrends, getKeywordTrends, hasTrendData, getNameTlds, getIndexedTldSet } = require('./zone-indexer');

// ATTACH zone_index.db for cross-DB "also taken in" filtering.
// Called after zone-indexer has had a chance to create the file.
const DATA_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
let _zoneIndexAttached = false;
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

const app = express();
const PORT = process.env.PORT || 3737;

// ── In-memory query cache ────────────────────────────────────────────────────
const queryCache = new Map();
const CACHE_TTL  = 60_000; // 60 seconds

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
function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/stats') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
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
        conditions.push(`base_name IN (
          SELECT base_name FROM domains WHERE tld = @${key}
          UNION
          SELECT base_name FROM zi.zone_names WHERE tld = @${key}
        )`);
      } else {
        // Fallback: internal DB only (always works)
        conditions.push(`base_name IN (SELECT base_name FROM domains WHERE tld = @${key})`);
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
  const sortBy = allowedFields.includes(sortField) ? sortField : 'discovered_at';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';

  // When sorting auction_end ASC (soonest ending), hide already-ended auctions.
  // datetime(auction_end) normalises the ISO-8601 'T'/'Z' format so the comparison
  // works correctly regardless of the separator character.
  if (sortBy === 'auction_end' && dir === 'ASC') {
    conditions.push("datetime(auction_end) > datetime('now')");
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  // NULLS LAST lets SQLite use the index directly; expression-based sorts force a filesort
  const nullsLastFields = ['expiry_date', 'auction_price', 'age_years', 'tlds_taken', 'wayback_snapshots'];
  const orderClause = nullsLastFields.includes(sortBy)
    ? `${sortBy} ${dir} NULLS LAST`
    : `${sortBy} ${dir}`;

  // If client already knows the total (e.g. from stats), skip the COUNT(*) scan
  const knownTotal = req.query.knownTotal ? parseInt(req.query.knownTotal) : null;
  const total = (knownTotal != null && Number.isFinite(knownTotal))
    ? knownTotal
    : db.prepare(`SELECT COUNT(DISTINCT domain) as n FROM domains ${where}`).get(params).n;

  // Deduplicate: same domain may exist in multiple streams (e.g. marketplace + namecheap-auction).
  // Show cheapest price per unique domain. ROW_NUMBER() picks the best row; outer query sorts/paginates.
  const domains = db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY domain
        ORDER BY COALESCE(auction_price, 9999999) ASC, id ASC
      ) AS _rn
      FROM domains ${where}
    ) WHERE _rn = 1 ORDER BY ${orderClause} LIMIT ${limitNum} OFFSET ${offset}
  `).all(params);

  const result = { total, page: pageNum, limit: limitNum, domains };
  setCached(cacheKey, result);
  res.json(result);
});

// ── GET /api/stats ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM domains').get().n;
  const saved = db.prepare('SELECT COUNT(*) as n FROM domains WHERE saved = 1').get().n;
  const unseen = db.prepare('SELECT COUNT(*) as n FROM domains WHERE seen = 0 AND skipped = 0').get().n;
  const byStream = db.prepare(`
    SELECT stream, COUNT(*) as n FROM domains GROUP BY stream
  `).all();
  const byTld = db.prepare(`
    SELECT tld, COUNT(*) as n FROM domains GROUP BY tld ORDER BY n DESC
  `).all();
  const lastRun = db.prepare(`
    SELECT ran_at, stream, domains_found, domains_new FROM scrape_log
    ORDER BY ran_at DESC LIMIT 8
  `).all();

  // Already expired counts by window — exclude auction_end backfills (not real RDAP/WHOIS dates)
  const expiredCount = (days) => db.prepare(
    `SELECT COUNT(*) as n FROM domains WHERE expiry_date IS NOT NULL AND expiry_date < datetime('now') AND expiry_date >= datetime('now','-${days} days') AND (auction_end IS NULL OR expiry_date != auction_end)`
  ).get().n;
  const expired7  = expiredCount(7);
  const expired14 = expiredCount(14);
  const expired30 = expiredCount(30);
  const expired60 = expiredCount(60);

  // Expiring soon counts — future expiry_date only, no auctions
  const expiryCount = (days) => db.prepare(
    `SELECT COUNT(*) as n FROM domains WHERE expiry_date IS NOT NULL AND expiry_date > datetime('now') AND expiry_date <= datetime('now','+${days} days') AND stream NOT IN ('godaddy-auction','namecheap-auction','marketplace')`
  ).get().n;
  const expiring1  = expiryCount(1);
  const expiring7  = expiryCount(7);
  const expiring14 = expiryCount(14);
  const expiring30 = expiryCount(30);
  const expiring60 = expiryCount(60);
  const expiring90 = expiryCount(90);

  res.json({ total, saved, unseen, expired7, expired14, expired30, expired60, byStream, byTld, lastRun, expiring1, expiring7, expiring14, expiring30, expiring60, expiring90 });
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
let scrapeRunning = false;
app.post('/api/scrape', async (req, res) => {
  if (scrapeRunning) return res.json({ ok: false, message: 'Scrape already running' });
  res.json({ ok: true, message: 'Scrape started in background' });
  scrapeRunning = true;
  scrapeAll().then(() => bustCache()).catch(err => console.error('[Manual Scrape]', err)).finally(() => { scrapeRunning = false; });
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
    const { count, taken } = await checkTldsTakenFull(raw);
    db.prepare(`UPDATE domains SET tlds_taken = ?, tlds_checked_at = datetime('now')
                WHERE SUBSTR(domain, 1, INSTR(domain, '.') - 1) = ?`).run(count, raw);
    bustCache();
    res.json({ baseName: raw, count, taken, all: CHECK_TLDS, checkedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sedo keyword search ──────────────────────────────────────────────────────
// Searches Sedo's marketplace for domains containing a keyword.
// Returns an array of { base_name, com: {price, url}|null, ai: {price, url}|null }
async function searchSedoKeyword(keyword) {
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
        // Only include names that START WITH the keyword
        if (!baseName.startsWith(keyword.toLowerCase())) return;
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

// ── GET /api/name-research ──────────────────────────────────────────────────
// Returns unique base names matching a prefix, sorted by tlds_taken DESC NULLS LAST.
// Sources: zone index (pre-built from CZDS files) + internal DB + Sedo (if configured).
app.get('/api/name-research', async (req, res) => {
  try {
  const { prefix = '', mode = 'prefix' } = req.query;
  const searchMode = mode === 'suffix' ? 'suffix' : 'prefix';
  const cleanTerm = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanTerm || cleanTerm.length < 2) {
    return res.status(400).json({ error: 'prefix must be at least 2 characters' });
  }
  const cleanPrefix = cleanTerm;

  // ── Kick off Sedo async (zone index is sync) ──
  const sedoPromise = searchSedoKeyword(cleanTerm);

  // ── Zone index query — full universe ──
  const zoneRows = queryZoneIndex(cleanTerm, searchMode);

  // Build resultMap from zone index first (most comprehensive tld_count source)
  const resultMap = {};
  for (const row of zoneRows) {
    resultMap[row.base_name] = {
      base_name:  row.base_name,
      tlds_taken: row.tld_count,
      tld_list:   row.tld_list ? row.tld_list.split(',').sort() : [],
      com: null,
      ai:  null,
    };
  }

  // ── Internal DB: all base names matching prefix ──
  // Adds names not yet in zone index (expiring/auction domains), and enriches
  // tlds_taken where the DNS-checked value exceeds the zone index count.
  const dbNames = db.prepare(`
    SELECT
      LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) as base_name,
      MAX(tlds_taken) as tlds_taken,
      COUNT(*) as domain_count
    FROM domains
    WHERE LOWER(SUBSTR(domain, 1, INSTR(domain, '.') - 1)) LIKE @prefix
    GROUP BY base_name
    ORDER BY tlds_taken DESC NULLS LAST, domain_count DESC
  `).all({
    prefix: searchMode === 'suffix' ? `%${cleanPrefix}` : `${cleanPrefix}%`,
  });

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

  // Filter zone-only names to tld_count >= 2 — single-TLD zone entries have no signal value.
  // DB names (expiring/auction) and Sedo names are always kept.
  for (const [name, entry] of Object.entries(resultMap)) {
    if (!dbNameSet.has(name) && (entry.tlds_taken == null || entry.tlds_taken < 2)) {
      delete resultMap[name];
    }
  }

  // ── .com / .ai enrichment — single prefix query per TLD (fast: uses tld index) ──
  // All names in resultMap share the same prefix, so one LIKE query covers everything.
  const domainPattern = searchMode === 'suffix'
    ? `%${cleanPrefix}`
    : `${cleanPrefix}%`;
  for (const row of db.prepare(`
    SELECT LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) as base_name,
           domain, auction_price, auction_url, stream, source
    FROM domains WHERE tld='.com' AND LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) LIKE ?
  `).all(domainPattern)) {
    const e = resultMap[row.base_name];
    if (e && (!e.com || (row.auction_price && !e.com.price)))
      e.com = { exists: true, price: row.auction_price, url: row.auction_url, stream: row.stream, source: row.source };
  }
  for (const row of db.prepare(`
    SELECT LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) as base_name,
           domain, auction_price, auction_url, stream, source
    FROM domains WHERE tld='.ai' AND LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1)) LIKE ?
  `).all(domainPattern)) {
    const e = resultMap[row.base_name];
    if (e && (!e.ai || (row.auction_price && !e.ai.price)))
      e.ai = { exists: true, price: row.auction_price, url: row.auction_url, stream: row.stream, source: row.source };
  }

  // ── Merge Sedo results ──
  const { results: sedoResults, configured: sedoConfigured } = await sedoPromise;
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
    sedoConfigured,
    sedoCount:       Object.keys(sedoResults).length,
    zoneIndexedTlds: zoneStats.tlds,
    zoneIndexedNames: zoneStats.names,
    zoneResultCount: zoneRows.length,
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
    const indexedTlds = getIndexedTldSet();
    const gapTlds = CHECK_TLDS.filter(t => !indexedTlds.has(t));
    if (gapTlds.length === 0) {
      return res.json({ live: [], gapChecked: 0, zoneCoversAll: true });
    }
    const axios = require('axios');
    const DOH = 'https://cloudflare-dns.com/dns-query';
    const results = await Promise.all(gapTlds.map(async tld => {
      try {
        const r = await axios.get(DOH, {
          params: { name: baseName + tld, type: 'NS' },
          headers: { Accept: 'application/dns-json' },
          timeout: 3000,
        });
        if (r.data.Status === 3) return null;
        return r.data.Answer?.length ? tld : null;
      } catch (_) { return null; }
    }));
    const live = results.filter(Boolean).sort();
    res.json({ live, gapChecked: gapTlds.length, zoneCoversAll: false });
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
  res.json({
    czdsConfigured: !!(process.env.CZDS_USER && process.env.CZDS_PASS),
    envFile: require('fs').existsSync(path.join(__dirname, '../.env')),
  });
});

// ── Cron: run every 6 hours ─────────────────────────────────────────────────
cron.schedule('0 */6 * * *', () => {
  if (scrapeRunning) { console.log('[Cron] Skipping — scrape already running'); return; }
  console.log('[Cron] Running scheduled scrape...');
  scrapeRunning = true;
  scrapeAll().then(() => bustCache()).catch(err => console.error('[Cron Error]', err)).finally(() => { scrapeRunning = false; });
});

// ── GET /api/trends ──────────────────────────────────────────────────────────
// Returns TLD registration growth % and trending keywords from today's zone diff.
app.get('/api/trends', requireAuth, (req, res) => {
  res.json({
    hasData:  hasTrendData(),
    tlds:     getTldTrends(150),
    keywords: getKeywordTrends(300),
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

  // Auto-scrape on startup if the database is empty
  const domainCount = db.prepare('SELECT COUNT(*) as n FROM domains').get().n;
  if (domainCount === 0) {
    console.log('[Startup] DB empty — running initial scrape...');
    scrapeAll().catch(err => console.error('[Startup Scrape Error]', err));
  }

  // Start background tlds_taken worker
  startWorker();

  // Start background zone file indexing — builds zone_index.db from any downloaded
  // CZDS zone files. Runs silently; research queries use the index once it's built.
  setTimeout(() => {
    indexAllPendingZoneFiles().catch(err => console.error('[ZoneIndex startup]', err.message));
    attachZoneIndex(); // attach for cross-DB filtering (zone_index.db created by zone-indexer)
  }, 8000);

  // Run migrations + rescrape after server is healthy (non-blocking)
  setTimeout(async () => {
    try {
      const c1 = db.prepare(`UPDATE domains SET stream = 'godaddy-closeout' WHERE source = 'GoDaddy Closeout' AND stream = 'godaddy-auction'`).run();
      console.log(`[Migration] closeout re-tag: ${c1.changes} rows`);
      const c2 = db.prepare(`UPDATE domains SET tlds_taken = NULL, tlds_checked_at = NULL WHERE tlds_taken = 0`).run();
      console.log(`[Migration] tlds_taken reset: ${c2.changes} rows`);
      // Remove duplicate GoDaddy rows: if a domain exists in both streams, keep the closeout row only
      const c3 = db.prepare(`DELETE FROM domains WHERE stream = 'godaddy-auction' AND domain IN (SELECT domain FROM domains WHERE stream = 'godaddy-closeout')`).run();
      console.log(`[Migration] GoDaddy dedup: removed ${c3.changes} auction rows that also had a closeout row`);
      bustCache();
    } catch (err) {
      console.error('[Migration error]', err.message);
    }
    // Re-scrape if closeout stream is empty (first deploy after split)
    const closeoutCount = db.prepare(`SELECT COUNT(*) as n FROM domains WHERE stream = 'godaddy-closeout'`).get().n;
    if (closeoutCount === 0) {
      console.log('[Startup] godaddy-closeout empty — running scrape to populate...');
      scrapeAll().catch(err => console.error('[Startup scrape error]', err.message));
    }
  }, 5000);
});
