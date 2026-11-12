'use strict';

// Verified whole-root extension counts for Sale Watch daily pages.
//
// The count is the one the Research / taken-in extension-count columns and
// /api/tlds-check publish: a complete Nameverse receipt in domains.db
// (base_tld_counts marks the receipt-bearing bases, tld_check_cache holds the
// receipt), projected by nameverse-coverage.projectCoverageReceipt. Only a
// verified receipt yields a number; a lower bound, a zone-index observation or
// a partial receipt yields nothing (null), never an estimate.
//
// readVerifiedExtensionCounts runs in a domains.db read lane (db-read-worker
// operation 'tld.verified-counts'), never on the Sale Watch read lane, which
// only opens sale_watch.db. enrichDailyExtensionCounts runs on the main thread
// over an already-read page: one bounded batch per page for the names not in
// its per-domain cache, and unverified names go to the existing whole-root
// queue (tld_work_queue via the caller's enqueue).

const { projectCoverageReceipt } = require('./nameverse-coverage');

const MAX_BATCH = 200;
const CACHE_MAX = 20000;
const CACHE_MS = 10 * 60_000;

const SQL = Object.freeze({
  receiptCandidates: `SELECT base_name FROM base_tld_counts
    WHERE base_name IN (SELECT value FROM json_each(@bases))
      AND (source = 'nameverse-complete' OR source = @source)`,
  receipts: `SELECT * FROM tld_check_cache INDEXED BY sqlite_autoindex_tld_check_cache_1
    WHERE base_name IN (SELECT value FROM json_each(@bases))
      AND universe_id = @universeId AND universe_version = @universeVersion
      AND checked_count = total_count AND total_count = @totalCount
      AND coverage_status = 'complete' AND failures_json = '[]'`,
});

const baseOf = domain => String(domain || '').toLowerCase().split('.')[0] || '';

/**
 * params: { bases: string[], universe: { id, version, count } }.
 * Returns plain { counts: { [base]: n } } holding verified bases only.
 */
function readVerifiedExtensionCounts(db, params = {}) {
  const bases = [...new Set((Array.isArray(params.bases) ? params.bases : []).map(b => String(b || '').toLowerCase()).filter(b => /^[a-z0-9-]+$/.test(b)))].slice(0, MAX_BATCH);
  const universe = params.universe || {};
  const counts = {};
  if (!bases.length || !universe.id) return { counts };
  const candidates = db.prepare(SQL.receiptCandidates).all({ bases: JSON.stringify(bases), source: `nameverse:${universe.version}` }).map(r => r.base_name);
  if (!candidates.length) return { counts };
  const rows = db.prepare(SQL.receipts).all({ bases: JSON.stringify(candidates), universeId: universe.id, universeVersion: universe.version, totalCount: universe.count });
  for (const row of rows) {
    const p = projectCoverageReceipt(row, universe);
    if (p.verified === true && Number.isInteger(p.extensions) && p.extensions >= 0) counts[row.base_name] = p.extensions;
  }
  return { counts };
}

/**
 * Creates the page enricher. options.readCounts(bases) -> Promise<{ counts }>
 * (one call per page, at most MAX_BATCH bases); options.enqueue(bases) queues
 * unverified names for whole-root verification (optional).
 */
function createDailyExtensionEnricher({ readCounts, enqueue = null, now = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  const cache = new Map(); // base -> { at, count|null }
  const fresh = e => e && now() - e.at < cacheMs;
  async function enrich(page) {
    if (!page || !Array.isArray(page.days)) return page;
    const rows = page.days.flatMap(d => (Array.isArray(d.rows) ? d.rows : []));
    const bases = [...new Set(rows.map(r => baseOf(r.domain)).filter(Boolean))];
    const misses = bases.filter(b => !fresh(cache.get(b))).slice(0, MAX_BATCH);
    if (misses.length && typeof readCounts === 'function') {
      try {
        const got = await readCounts(misses);
        const counts = (got && got.counts) || {};
        const at = now();
        for (const b of misses) cache.set(b, { at, count: Number.isInteger(counts[b]) ? counts[b] : null });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      } catch (_) { /* reader busy: rows show no count this time */ }
    }
    const unverified = [];
    for (const row of rows) {
      const base = baseOf(row.domain);
      const e = cache.get(base);
      const stored = row.derived && Number.isInteger(row.derived.otherExtensions) ? row.derived.otherExtensions : null;
      const count = e && Number.isInteger(e.count) ? e.count : stored;
      row.derived = { ...(row.derived || {}), otherExtensions: count, otherExtensionsVerified: count != null };
      if (count == null && e) unverified.push(base);
    }
    if (unverified.length && typeof enqueue === 'function') { try { enqueue([...new Set(unverified)]); } catch (_) { /* queue optional */ } }
    return page;
  }
  return { enrich, cache };
}

module.exports = { SQL, MAX_BATCH, readVerifiedExtensionCounts, createDailyExtensionEnricher };
