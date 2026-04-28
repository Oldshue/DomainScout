require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const { scrapeAll } = require('./scrape-all');

const app = express();
const PORT = process.env.PORT || 3737;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── GET /api/domains ────────────────────────────────────────────────────────
// Filters: stream, tld, minLength, maxLength, noNumbers, noHyphens,
//          minAge, maxAge, hasWayback, dnsAvailable, q (search), seen, saved, skipped
// Sort: field, dir. Pagination: page, limit
app.get('/api/domains', (req, res) => {
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

  if (stream && stream !== 'all') {
    conditions.push('stream = @stream');
    params.stream = stream;
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
    conditions.push('domain LIKE @q');
    params.q = `%${q.toLowerCase()}%`;
  }
  if (minLength) { conditions.push('length >= @minLength'); params.minLength = parseInt(minLength); }
  if (maxLength) { conditions.push('length <= @maxLength'); params.maxLength = parseInt(maxLength); }
  if (noNumbers === '1') conditions.push('has_numbers = 0');
  if (noHyphens === '1') conditions.push('has_hyphens = 0');
  if (minAge) { conditions.push('age_years >= @minAge'); params.minAge = parseInt(minAge); }
  if (maxAge) { conditions.push('age_years <= @maxAge'); params.maxAge = parseInt(maxAge); }
  if (hasWayback === '1') conditions.push('wayback_snapshots > 0');
  if (dnsAvailable === '1') conditions.push('dns_available = 1');
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

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const allowedFields = ['discovered_at', 'domain', 'length', 'auction_price', 'age_years', 'wayback_snapshots', 'expiry_date'];
  const sortBy = allowedFields.includes(sortField) ? sortField : 'discovered_at';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  // For nullable fields, always push NULLs last regardless of sort direction
  const orderClause = sortBy === 'expiry_date' || sortBy === 'auction_price' || sortBy === 'age_years'
    ? `${sortBy} IS NULL ASC, ${sortBy} ${dir}`
    : `${sortBy} ${dir}`;

  const total = db.prepare(`SELECT COUNT(*) as n FROM domains ${where}`).get(params).n;
  const rows = db.prepare(
    `SELECT * FROM domains ${where} ORDER BY ${orderClause} LIMIT ${limitNum} OFFSET ${offset}`
  ).all(params);

  res.json({ total, page: pageNum, limit: limitNum, domains: rows });
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

  res.json({ total, saved, unseen, byStream, byTld, lastRun });
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
  scrapeAll().catch(err => console.error('[Manual Scrape]', err));
});

// ── GET /api/scrape-log ─────────────────────────────────────────────────────
app.get('/api/scrape-log', (req, res) => {
  const rows = db.prepare('SELECT * FROM scrape_log ORDER BY ran_at DESC LIMIT 50').all();
  res.json(rows);
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
  scrapeAll().catch(err => console.error('[Cron Error]', err));
});

// ── Serve frontend ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🔭 DomainScout running at http://localhost:${PORT}`);
  console.log('Scrape schedule: every 6 hours');
  console.log('Run manual scrape: POST /api/scrape\n');
});
