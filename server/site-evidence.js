'use strict';

/**
 * Portfolio Engine — Stage 8: built-site evidence.
 *
 * "Start from the top with sites set up by end users as the criteria, not
 * just sites registered." A registration is not demand; a live site an end
 * user built on the name is. This module turns homepage inspection
 * (server/sale-watch-discovery.js#inspectHomepage) into stored, cacheable
 * evidence of what a domain currently is — built, parked, placeholder,
 * for-sale, dead, or unknown — and rolls that evidence up into a
 * built-rate signal for a theme (a LIKE pattern over NRD registrations in
 * zone_index.db).
 *
 * House style of server/portfolio-engine.js: caller passes better-sqlite3
 * handles (db = sale_watch.db for the site_evidence table, zoneDb =
 * zone_index.db for registration sampling); every side-effecting
 * dependency is opts-injectable; orchestrators never throw.
 * [SiteEvidence] log prefix throughout. Nothing runs at require-time;
 * inspectHomepage (the only network call this module makes) is required
 * lazily so this module never opens a connection on its own.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUDGET = 200;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_SPACING_MS = 200;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_SAMPLE_DAYS = 60;
const DEFAULT_SAMPLE_LIMIT = 300;

const FOR_SALE_TEXT = /for sale|buy this domain|make an offer|is available|dan\.com|afternic|sedo|hugedomains|buydomains|squadhelp|atom\.com/i;

/** Creates (IF NOT EXISTS) the site_evidence table this module owns. */
function ensureSiteEvidenceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_evidence (
      domain TEXT PRIMARY KEY,
      checked_at TEXT,
      status TEXT,
      title TEXT,
      final_host TEXT,
      http_status INTEGER,
      source TEXT
    );
  `);
}

/**
 * Classifies one domain's live homepage via opts.inspect (default:
 * sale-watch-discovery's inspectHomepage). error/no response -> 'dead';
 * parked -> 'parked' ('for-sale' when the title or final URL reads as a
 * sales lander); placeholder -> 'placeholder'; active with a non-empty
 * title -> 'built'; else 'unknown'. Never throws.
 */
async function classifySite(domain, opts = {}) {
  const inspect = opts.inspect || require('./sale-watch-discovery').inspectHomepage;
  let result = null;
  try {
    result = await inspect(domain);
  } catch (_) {
    result = null;
  }
  if (!result || result.error || !result.finalUrl) {
    return {
      status: 'dead',
      title: (result && result.title) || null,
      finalHost: (result && result.finalHost) || null,
      httpStatus: (result && result.status) || null,
    };
  }
  const title = result.title || null;
  const finalHost = result.finalHost || null;
  const httpStatus = result.status || null;
  if (result.parked) {
    const sample = `${title || ''}\n${result.finalUrl || ''}`;
    return { status: FOR_SALE_TEXT.test(sample) ? 'for-sale' : 'parked', title, finalHost, httpStatus };
  }
  if (result.placeholder) {
    return { status: 'placeholder', title, finalHost, httpStatus };
  }
  if (result.active && title) {
    return { status: 'built', title, finalHost, httpStatus };
  }
  return { status: 'unknown', title, finalHost, httpStatus };
}

/**
 * Refreshes stored site_evidence for `domains`: skips rows checked within
 * maxAgeDays, probes the rest oldest-first (never-checked first) up to
 * `budget` with bounded concurrency and per-check spacing, and upserts.
 * Never throws; always returns a summary.
 */
async function refreshSiteEvidence(db, domains, opts = {}) {
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? Math.floor(opts.budget) : DEFAULT_BUDGET;
  const concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0 ? Math.floor(opts.concurrency) : DEFAULT_CONCURRENCY;
  const spacingMs = Number.isFinite(opts.spacingMs) && opts.spacingMs >= 0 ? opts.spacingMs : DEFAULT_SPACING_MS;
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) && opts.maxAgeDays >= 0 ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const inspectOpt = opts.inspect;

  const summary = { checked: 0, built: 0, parked: 0, forSale: 0, placeholder: 0, dead: 0, unknown: 0 };
  try {
    ensureSiteEvidenceSchema(db);
    const uniqueDomains = [...new Set((domains || []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))];
    if (!uniqueDomains.length) return summary;

    const cutoff = new Date(Date.now() - maxAgeDays * DAY_MS).toISOString();
    const placeholders = uniqueDomains.map(() => '?').join(',');
    const rows = db.prepare(`SELECT domain, checked_at FROM site_evidence WHERE domain IN (${placeholders})`).all(...uniqueDomains);
    const checkedAtByDomain = new Map(rows.map((row) => [row.domain, row.checked_at || null]));

    const stale = uniqueDomains.filter((domain) => {
      const checkedAt = checkedAtByDomain.get(domain);
      return !checkedAt || checkedAt < cutoff;
    });
    stale.sort((a, b) => {
      const aAt = checkedAtByDomain.get(a) || '';
      const bAt = checkedAtByDomain.get(b) || '';
      return aAt < bAt ? -1 : (aAt > bAt ? 1 : 0);
    });

    const targets = stale.slice(0, budget);
    if (!targets.length) return summary;

    const upsert = db.prepare(`
      INSERT INTO site_evidence (domain, checked_at, status, title, final_host, http_status, source)
      VALUES (@domain, @checkedAt, @status, @title, @finalHost, @httpStatus, @source)
      ON CONFLICT(domain) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, title = excluded.title, final_host = excluded.final_host, http_status = excluded.http_status, source = excluded.source
    `);

    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const domain = targets[cursor++];
        if (spacingMs) await new Promise((resolve) => setTimeout(resolve, spacingMs));
        let classified;
        try {
          classified = await classifySite(domain, { inspect: inspectOpt });
        } catch (_) {
          classified = { status: 'dead', title: null, finalHost: null, httpStatus: null };
        }
        const checkedAt = new Date().toISOString();
        try {
          upsert.run({
            domain,
            checkedAt,
            status: classified.status,
            title: classified.title || null,
            finalHost: classified.finalHost || null,
            httpStatus: classified.httpStatus || null,
            source: 'site-evidence',
          });
        } catch (err) {
          console.warn(`[SiteEvidence] refreshSiteEvidence: upsert failed for ${domain}: ${err.message}`);
        }
        summary.checked += 1;
        if (classified.status === 'built') summary.built += 1;
        else if (classified.status === 'parked') summary.parked += 1;
        else if (classified.status === 'for-sale') summary.forSale += 1;
        else if (classified.status === 'placeholder') summary.placeholder += 1;
        else if (classified.status === 'dead') summary.dead += 1;
        else summary.unknown += 1;
      }
    }

    const poolSize = Math.min(concurrency, targets.length);
    const workers = [];
    for (let i = 0; i < poolSize; i++) workers.push(worker());
    await Promise.all(workers);

    return summary;
  } catch (err) {
    console.warn(`[SiteEvidence] refreshSiteEvidence failed: ${err.message}`);
    return summary;
  }
}

/** {known, built, rate} over `domains` from stored evidence. Never throws. */
function builtRate(db, domains) {
  try {
    ensureSiteEvidenceSchema(db);
    const uniqueDomains = [...new Set((domains || []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))];
    if (!uniqueDomains.length) return { known: 0, built: 0, rate: null };
    const placeholders = uniqueDomains.map(() => '?').join(',');
    const rows = db.prepare(`SELECT status FROM site_evidence WHERE domain IN (${placeholders})`).all(...uniqueDomains);
    const known = rows.length;
    const built = rows.filter((row) => row.status === 'built').length;
    return { known, built, rate: known > 0 ? built / known : null };
  } catch (err) {
    console.warn(`[SiteEvidence] builtRate failed: ${err.message}`);
    return { known: 0, built: 0, rate: null };
  }
}

/**
 * Cheap SQL sample of recent .com NRDs matching `pattern` (SQL LIKE against
 * base_name) from zone_daily_new_names, most recent first, deduped, capped
 * at `limit`. Never throws.
 */
function sampleThemeRegistrations(zoneDb, opts = {}) {
  try {
    const pattern = opts.pattern;
    if (!pattern) return [];
    const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.floor(opts.days) : DEFAULT_SAMPLE_DAYS;
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_SAMPLE_LIMIT;

    const maxDayRow = zoneDb.prepare("SELECT MAX(report_date) AS day FROM zone_daily_new_names WHERE tld = 'com'").get();
    const endDay = (maxDayRow && maxDayRow.day) || new Date().toISOString().slice(0, 10);
    const startDay = new Date(new Date(`${endDay}T00:00:00.000Z`).getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);

    const rows = zoneDb.prepare(`
      SELECT base_name, report_date
      FROM zone_daily_new_names
      WHERE tld = 'com' AND report_date >= ? AND report_date <= ? AND base_name LIKE ?
      ORDER BY report_date DESC
    `).all(startDay, endDay, pattern);

    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const domain = `${row.base_name}.com`;
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push(domain);
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    console.warn(`[SiteEvidence] sampleThemeRegistrations failed: ${err.message}`);
    return [];
  }
}

/**
 * Never-throw theme demand signal: samples recent theme registrations via
 * sampleThemeRegistrations, refreshes their site_evidence, and returns the
 * built rate plus a handful of built examples with titles.
 */
async function themeBuiltSignal(db, zoneDb, opts = {}) {
  const empty = { sampled: 0, known: 0, built: 0, rate: null, examples: [] };
  try {
    const sample = sampleThemeRegistrations(zoneDb, { pattern: opts.pattern, days: opts.days, limit: opts.limit });
    if (!sample.length) return empty;
    await refreshSiteEvidence(db, sample, { budget: opts.budget, inspect: opts.inspect });
    const rate = builtRate(db, sample);
    let examples = [];
    try {
      const placeholders = sample.map(() => '?').join(',');
      const rows = db.prepare(`SELECT domain, title FROM site_evidence WHERE status = 'built' AND domain IN (${placeholders}) LIMIT 8`).all(...sample);
      examples = rows.map((row) => ({ domain: row.domain, title: row.title || null }));
    } catch (err) {
      console.warn(`[SiteEvidence] themeBuiltSignal examples failed: ${err.message}`);
    }
    return { sampled: sample.length, known: rate.known, built: rate.built, rate: rate.rate, examples };
  } catch (err) {
    console.warn(`[SiteEvidence] themeBuiltSignal failed: ${err.message}`);
    return empty;
  }
}

module.exports = {
  ensureSiteEvidenceSchema,
  classifySite,
  refreshSiteEvidence,
  builtRate,
  sampleThemeRegistrations,
  themeBuiltSignal,
};
