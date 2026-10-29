'use strict';
// A single persistent index owns its cache; expensive parsing, aggregation and
// SQLite baselines never run on the HTTP event loop.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const databases = new Map();
function database(name) {
  if (!databases.has(name)) {
    const db = new (require('better-sqlite3'))(path.join(workerData.dataDir, name), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 30000');
    databases.set(name, db);
  }
  return databases.get(name);
}
const trends = require('./live-trends').createLiveTrends({
  universeDir: workerData.universeDir,
  cacheDir: workerData.cacheDir,
  // Registration-history builds continue in the existing background warmer.
  // Interactive queries must not wait for entire daily registration tapes.
  buildBudget: 0,
  salesLoader: !workerData.salesEnabled ? null : async ({ sinceDate }) => {
    if (!workerData.salesEnabled) return null;
    const rows = database('sale_watch.db').prepare("SELECT domain, price_usd, venue, side, chart_date FROM sales_comps WHERE side = 'enduser' AND chart_date >= ? ORDER BY chart_date DESC LIMIT 20000").all(sinceDate);
    return rows.map(r => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r.chart_date || ''));
      return { domain: r.domain, price: r.price_usd, venue: r.venue, side: r.side, date: r.chart_date, sourceUrl: m ? `https://www.dnjournal.com/archive/domainsales/${m[1]}/${m[2]}${m[3]}.htm` : null };
    });
  },
  baselineLoader: async terms => {
    // Months of CZDS zone-add token history (zone_daily_tokens, 60-day window).
    const db = database('zone_index.db');
    const out = new Map();
    const range = db.prepare('SELECT MIN(report_date) AS lo, MAX(report_date) AS hi, COUNT(DISTINCT report_date) AS days FROM zone_daily_tokens').get();
    if (!range || !range.days) return out;
    let total = null;
    try { total = db.prepare('SELECT COUNT(*) AS n FROM zone_daily_new_names').get().n || null; } catch (_) { total = null; }
    const words = terms.filter(t => !t.includes(' ')).slice(0, 2000);
    for (let i = 0; i < words.length; i += 400) {
      const chunk = words.slice(i, i + 400);
      const rows = db.prepare(`SELECT token, SUM(reg_count) AS n FROM zone_daily_tokens WHERE token IN (${chunk.map(() => '?').join(',')}) GROUP BY token`).all(...chunk);
      const found = new Map(rows.map(r => [r.token, r.n]));
      for (const term of chunk) out.set(term, { count: found.get(term) || 0, days: range.days, total });
    }
    return out;
  },
});
parentPort.on('message', async ({ id, method, input }) => {
  try {
    if (!['query', 'refresh'].includes(method)) throw new Error('Unsupported trends operation');
    const value = await trends[method](input);
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, statusCode: error.statusCode } });
  }
});
