'use strict';

// Per-stream whole-root receipt coverage for /api/tld-accuracy-status.
//
// Provider-neutral: every stream in `domains` is counted through SQL, and every
// snapshot-only stream (large-provider snapshots such as godaddy-closeout that
// never insert into `domains`) is counted through its immutable snapshot index.
// A base name that appears in both places for the same stream is counted once.
// "verified" means exactly what every list view means: a current complete
// receipt for the full universe with zero failures. No lower bounds are reported.

const { DEFAULT_MAX_AGE_MS } = require('./nameverse-coverage');
const { snapshotDemandCandidates } = require('./provider-snapshot-demand');

const DEFAULT_DOMAIN_STREAMS = ['godaddy-auction', 'godaddy-closeout', 'namecheap-auction'];
const DEFAULT_SNAPSHOT_STREAMS = ['godaddy-auction', 'godaddy-closeout'];
const TIME_BOUND_STREAMS = new Set(['godaddy-auction', 'namecheap-auction']);
const IN_BATCH = 900;

function receiptPredicate(alias) {
  const a = alias ? `${alias}.` : '';
  return `
    ${a}universe_id = @universeId
    AND ${a}universe_version = @universeVersion
    AND ${a}checked_count = ${a}total_count
    AND ${a}total_count = @totalCount
    AND ${a}coverage_status = 'complete'
    AND ${a}failures_json = '[]'
    AND julianday(${a}completed_at) >= julianday('now') - ${DEFAULT_MAX_AGE_MS / 86400000}
    AND julianday(${a}completed_at) <= julianday('now')
  `;
}

function domainScopeWhere(stream) {
  const timeBound = TIME_BOUND_STREAMS.has(stream);
  return `
    d.stream = @stream
    AND d.base_name IS NOT NULL
    AND d.base_name != ''
    ${timeBound ? "AND (d.auction_end IS NULL OR datetime(d.auction_end) > datetime('now'))" : ''}
  `;
}

function countDomainStream(database, stream, universe) {
  const params = { stream, universeId: universe.id, universeVersion: universe.version, totalCount: universe.count };
  const total = database.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT d.base_name FROM domains d WHERE ${domainScopeWhere(stream)} GROUP BY d.base_name
    )
  `).get(params).n;
  const verified = database.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT d.base_name
      FROM domains d
      JOIN tld_check_cache tc ON tc.base_name = d.base_name AND ${receiptPredicate('tc')}
      WHERE ${domainScopeWhere(stream)}
      GROUP BY d.base_name
    )
  `).get(params).n;
  return { total, verified };
}

function batched(names, fn) {
  for (let i = 0; i < names.length; i += IN_BATCH) fn(names.slice(i, i + IN_BATCH));
}

// Snapshot-only rows for `stream` that are NOT already represented in `domains`
// for the same stream, and how many of those carry a current complete receipt.
function countSnapshotOnly(database, stream, index, universe, nowMs) {
  const candidates = snapshotDemandCandidates(index, { nowMs, endIsExpiry: stream !== 'godaddy-closeout' });
  if (!candidates.length) return { total: 0, verified: 0, snapshotRows: 0 };
  const names = candidates.map(c => c.base_name);
  const inDomains = new Set();
  const verified = new Set();
  batched(names, batch => {
    const placeholders = batch.map(() => '?').join(',');
    for (const row of database.prepare(
      `SELECT DISTINCT base_name FROM domains WHERE stream = ? AND base_name IN (${placeholders}) ${TIME_BOUND_STREAMS.has(stream) ? "AND (auction_end IS NULL OR datetime(auction_end) > datetime('now'))" : ''}`
    ).all(stream, ...batch)) inDomains.add(row.base_name);
    for (const row of database.prepare(
      `SELECT base_name FROM tld_check_cache WHERE ${receiptPredicate('')} AND base_name IN (${placeholders})`
    ).all({ universeId: universe.id, universeVersion: universe.version, totalCount: universe.count }, ...batch)) {
      verified.add(row.base_name);
    }
  });
  let total = 0;
  let verifiedOnly = 0;
  for (const name of names) {
    if (inDomains.has(name)) continue;
    total += 1;
    if (verified.has(name)) verifiedOnly += 1;
  }
  return { total, verified: verifiedOnly, snapshotRows: names.length };
}

function describeZoneTruth(zoneTruth, universe) {
  if (!zoneTruth) return null;
  const indexedSet = new Set(universe.indexedTlds || []);
  return {
    source: zoneTruth.source || 'none',
    asOf: zoneTruth.asOf || null,
    zoneTlds: typeof zoneTruth.zoneTldSet === 'function' ? zoneTruth.zoneTldSet().size : 0,
    exactForAbsentLabels: zoneTruth.exactForAbsentLabels === true,
    anchorTlds: Array.isArray(zoneTruth.anchorTlds) ? zoneTruth.anchorTlds : [],
    indexedCount: indexedSet.size,
    dnsCount: (universe.dnsTlds || []).length,
  };
}

function buildTldAccuracyStatus(options) {
  const {
    database, universe, zoneTruth = null,
    domainStreams = DEFAULT_DOMAIN_STREAMS,
    snapshotStreams = DEFAULT_SNAPSHOT_STREAMS,
    readSnapshotIndex = null,
    releaseSnapshotIndex = null,
    nowMs = Date.now(),
  } = options;
  if (!database || !universe) throw new Error('database and universe are required');

  const streams = {};
  const ensure = stream => {
    if (!streams[stream]) streams[stream] = { total: 0, verified: 0, remaining: 0, sources: [] };
    return streams[stream];
  };

  for (const stream of domainStreams) {
    const counts = countDomainStream(database, stream, universe);
    const entry = ensure(stream);
    entry.total += counts.total;
    entry.verified += counts.verified;
    entry.sources.push('domains');
  }

  const snapshotErrors = [];
  if (typeof readSnapshotIndex === 'function') {
    for (const stream of snapshotStreams) {
      let index = null;
      try { index = readSnapshotIndex(stream); } catch (err) {
        snapshotErrors.push({ stream, error: String(err?.message || err).slice(0, 300) });
        continue;
      }
      if (!index) continue;
      try {
        const counts = countSnapshotOnly(database, stream, index, universe, nowMs);
        const entry = ensure(stream);
        entry.total += counts.total;
        entry.verified += counts.verified;
        entry.sources.push('snapshot');
        entry.snapshotRows = counts.snapshotRows;
      } finally {
        index = null;
        if (typeof releaseSnapshotIndex === 'function') { try { releaseSnapshotIndex(stream); } catch (_) {} }
      }
    }
  }

  let total = 0;
  let verified = 0;
  for (const entry of Object.values(streams)) {
    entry.remaining = Math.max(0, entry.total - entry.verified);
    total += entry.total;
    verified += entry.verified;
  }
  return {
    total,
    verified,
    remaining: Math.max(0, total - verified),
    streams,
    snapshotErrors,
    zoneTruth: describeZoneTruth(zoneTruth, universe),
  };
}

module.exports = {
  DEFAULT_DOMAIN_STREAMS,
  DEFAULT_SNAPSHOT_STREAMS,
  buildTldAccuracyStatus,
  countSnapshotOnly,
};
