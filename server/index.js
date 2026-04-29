require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
const db = require('./db');
const { scrapeAll } = require('./scrape-all');
const { startWorker } = require('./tlds-worker');
const { checkTldsTakenFull } = require('../enrichment');
const { CHECK_TLDS } = require('./tlds-list');

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
const SESSION_SECRET = process.env.SESSION_SECRET || 'domainscout-secret-' + Math.random();

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
    // Exclude domains where expiry_date was backfilled from auction_end (not a real RDAP date)
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

  // Expiry filter: expiringDays=90 shows domains expiring within N days
  if (req.query.expiringDays) {
    const days = parseInt(req.query.expiringDays);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString();
    conditions.push("expiry_date IS NOT NULL AND expiry_date <= @expiryCutoff AND expiry_date >= datetime('now')");
    params.expiryCutoff = cutoff;
  }

  const allowedFields = ['discovered_at', 'domain', 'length', 'tlds_taken', 'auction_price', 'age_years', 'wayback_snapshots', 'expiry_date', 'auction_end'];
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

  // Already expired counts by window — exclude auction_end backfills
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
app.post('/api/scrape', async (req, res) => {
  res.json({ ok: true, message: 'Scrape started in background' });
  scrapeAll().then(() => bustCache()).catch(err => console.error('[Manual Scrape]', err));
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

// ── GET /api/config-status ──────────────────────────────────────────────────
app.get('/api/config-status', (req, res) => {
  res.json({
    czdsConfigured: !!(process.env.CZDS_USER && process.env.CZDS_PASS),
    envFile: require('fs').existsSync(path.join(__dirname, '../.env')),
  });
});

// ── Cron: run every 6 hours ─────────────────────────────────────────────────
cron.schedule('0 */6 * * *', () => {
  console.log('[Cron] Running scheduled scrape...');
  scrapeAll().then(() => bustCache()).catch(err => console.error('[Cron Error]', err));
});

// ── Serve frontend ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Migration: fix closeout stream misclassification
db.prepare(`UPDATE domains SET stream = 'godaddy-closeout' WHERE source = 'GoDaddy Closeout' AND stream = 'godaddy-auction'`).run();
// Migration: reset bad tlds_taken=0 values from old broken DNS resolver so they get re-checked with DoH
db.prepare(`UPDATE domains SET tlds_taken = NULL, tlds_checked_at = NULL WHERE tlds_taken = 0`).run();

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
});
