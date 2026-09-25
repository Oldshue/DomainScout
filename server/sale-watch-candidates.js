'use strict';

/**
 * GET /api/sale-watch/candidates — the full weekly sale-candidate tape.
 *
 * The Sale Watch ledger (/api/sale-watch) is a PRE-SCORED projection: it pages
 * adjudicated evidence and, in its probable view, holds tens of rows. A research
 * run that wants "every likely sale this week" needs the tape underneath it: the
 * ~1,000-1,800 departures a day that survive the ingest-time platform/parking
 * batch and expiry exclusions, whether or not a probe wave has reached them yet.
 *
 * This module is a READER ONLY. It writes no rows and owns NO second classifier:
 *
 *   - platform/parking-batch and expiry exclusions are applied once, at ingest,
 *     by ingestMovementCandidates() in server/sale-watch-reconstruction.js — an
 *     excluded departure is never inserted into sale_watch_candidates at all, so
 *     "survived the exclusions" is exactly "present in the table". The per-day
 *     counts it already persisted into sale_watch_movement_imports.summary_json
 *     are what coverage.excludedByReason reports.
 *   - the owner signal policy reuses ELIGIBLE_SIGNAL_SQL from that same module.
 *   - rows a later rescore demoted to platform-excluded/expiry-excluded are
 *     dropped here too, and the candidate-state gate matches the one
 *     readReconstructionEntries() uses, so this tape's exclusions are the
 *     ledger's exclusions. What it deliberately does NOT apply is the ledger's
 *     evidence tiering/view gate — that gate is what shrinks the ledger to the
 *     same handful of recurring names.
 *
 * Order is newest departureDay first, then cohortSize ascending (independent
 * buyers ahead of bulk moves), then domain.
 */

const crypto = require('crypto');
const { nsSetKey } = require('./nameserver-classes');
const { SELLER_PARKING_NAMESERVERS } = require('./zone-ns-universe');
const { ELIGIBLE_SIGNAL_SQL, DEPARTURE_DATE_SQL } = require('./sale-watch-reconstruction');

const SCHEMA = 'domainscout.sale-watch-candidates/v1';
const DEFAULT_DAYS = 7;
const MAX_DAYS = 14;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
// A destination nameserver set taking this many names in the window is one
// actor moving a block, not that many independent buyers.
const BATCH_MIN_NAMES = 10;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// The same candidate states readReconstructionEntries() pages (resolved,
// abandoned and expired are terminal non-sale outcomes and stay out of both).
const TAPE_STATES = ['detected', 'transferring', 'probing', 'parked-watch', 'exited'];
// Outcomes a later rescore pass assigns when a destination turns out to be a
// platform/parking or expiry lander after all.
const RESCORED_EXCLUSIONS = ['platform-excluded', 'expiry-excluded'];

const sqlList = values => values.map(value => `'${value.replace(/'/g, "''")}'`).join(',');

const TAPE_WHERE_SQL = `evidence_json IS NOT NULL
  AND state IN (${sqlList(TAPE_STATES)})
  AND (outcome IS NULL OR outcome NOT IN (${sqlList(RESCORED_EXCLUSIONS)}))
  AND ${ELIGIBLE_SIGNAL_SQL}
  AND ${DEPARTURE_DATE_SQL} >= @from
  AND ${DEPARTURE_DATE_SQL} <= @to`;

// The destination set: the movement's recovered current nameservers, falling
// back to the stored buyerNameservers for rows written by other intake paths.
const DESTINATION_JSON_SQL = `COALESCE(
  json_extract(evidence_json,'$.discovery.movement.currentNameservers'),
  json_extract(evidence_json,'$.buyerNameservers'))`;

class CandidateQueryError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'CandidateQueryError';
    this.status = status;
  }
}

function todayUtc(now) {
  return new Date(now || Date.now()).toISOString().slice(0, 10);
}

function dateMinusDays(day, days) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// Cheap derivation against the same seller/parking table the ledger's compact
// surface uses. No network lookups and no new classification.
function marketplaceFromNameservers(nameservers) {
  for (const raw of nameservers || []) {
    const host = String(raw || '').toLowerCase().replace(/\.$/, '');
    if (!host) continue;
    const match = SELLER_PARKING_NAMESERVERS.find(row => host === row.nameserver || host.endsWith(`.${row.nameserver}`));
    if (match) return match.provider;
  }
  return null;
}

function tldOf(domain) {
  return String(domain || '').replace(/\.$/, '').split('.').at(-1) || '';
}

function queryDigest({ from, to, q, tld, built }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([from, to, q, tld, built]))
    .digest('hex')
    .slice(0, 16);
}

// The cursor carries the full sort key plus a digest of the query that issued
// it, so a caller cannot silently walk one query's cursor into another query's
// result set and believe it paged the whole tape.
function encodeCursor(row, digest) {
  return Buffer.from(JSON.stringify({ d: row.departureDay, c: row.cohortSize, n: row.domain, h: digest }))
    .toString('base64url');
}

function decodeCursor(value, digest) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const invalid = () => new CandidateQueryError('cursor is not a valid sale-watch candidates cursor');
  if (raw.length > 1024) throw invalid();
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object'
    || typeof parsed.d !== 'string' || !DAY_PATTERN.test(parsed.d)
    || !Number.isFinite(Number(parsed.c))
    || typeof parsed.n !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(parsed.n)) throw invalid();
  if (parsed.h !== digest) {
    throw new CandidateQueryError('cursor was issued for a different query; restart paging without a cursor');
  }
  return { departureDay: parsed.d, cohortSize: Number(parsed.c), domain: parsed.n };
}

function normalizeQuery(params = {}, { now } = {}) {
  const raw = params || {};
  const fromRaw = String(raw.from ?? '').trim();
  const toRaw = String(raw.to ?? '').trim();
  let from;
  let to;
  let days = null;
  if (fromRaw || toRaw) {
    if (!DAY_PATTERN.test(fromRaw) || !DAY_PATTERN.test(toRaw)) {
      throw new CandidateQueryError('from and to must both be supplied as YYYY-MM-DD');
    }
    if (fromRaw > toRaw) throw new CandidateQueryError('from must not be later than to');
    from = fromRaw;
    to = toRaw;
  } else {
    days = raw.days === undefined || raw.days === null || raw.days === ''
      ? DEFAULT_DAYS
      : Math.floor(Number(raw.days));
    if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
      throw new CandidateQueryError(`days must be an integer between 1 and ${MAX_DAYS}`);
    }
    to = todayUtc(now);
    from = dateMinusDays(to, days - 1);
  }

  const q = String(raw.q ?? '').trim().toLowerCase();
  if (q.length > 100) throw new CandidateQueryError('q must be 100 characters or fewer');

  const tld = String(raw.tld ?? '').trim().toLowerCase().replace(/^\./, '');
  if (tld && !/^[a-z0-9-]{2,63}$/.test(tld)) throw new CandidateQueryError('tld must be a bare suffix such as com');

  let built = null;
  if (raw.built !== undefined && raw.built !== null && raw.built !== '') {
    const value = String(raw.built).toLowerCase();
    if (!['true', 'false', '1', '0'].includes(value)) throw new CandidateQueryError('built must be true or false');
    built = value === 'true' || value === '1';
  }

  const limit = raw.limit === undefined || raw.limit === null || raw.limit === ''
    ? DEFAULT_LIMIT
    : Math.floor(Number(raw.limit));
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CandidateQueryError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  const query = { from, to, days, q, tld, built, limit };
  query.digest = queryDigest(query);
  query.cursor = decodeCursor(raw.cursor, query.digest);
  return query;
}

function compareTapeRows(a, b) {
  if (a.departureDay !== b.departureDay) return a.departureDay < b.departureDay ? 1 : -1;
  if (a.cohortSize !== b.cohortSize) return a.cohortSize - b.cohortSize;
  return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
}

function isAfterCursor(row, cursor) {
  return !cursor || compareTapeRows(row, cursor) > 0;
}

function compact(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function truthy(value) {
  return value === 1 || value === true || value === '1' || value === 'true';
}

/**
 * Reads the tape. `db` is a better-sqlite3 handle (the read-only worker handle
 * in the cloud deployment). Throws on a failing read so the route answers 503
 * with detail instead of a misleading empty list.
 */
// There is NO stored `siteClass` field: the homepage probe in
// server/sale-watch-discovery.js persists the booleans it actually observed
// ({active, parked, placeholder, status, error, title, ...}). The built/
// siteClass a caller sees is therefore derived from that stored evidence with
// the same precedence the probe itself used (parked beats placeholder beats
// active), never from an invented column that would read NULL forever.
const SITE_CLASS_SQL = `CASE
    WHEN json_extract(evidence_json,'$.discovery.homepage.error') IS NOT NULL THEN NULL
    WHEN json_extract(evidence_json,'$.discovery.homepage.parked') = 1 THEN 'parked'
    WHEN json_extract(evidence_json,'$.discovery.homepage.placeholder') = 1 THEN 'placeholder'
    WHEN json_extract(evidence_json,'$.discovery.homepage.active') = 1 THEN 'built'
    WHEN json_extract(evidence_json,'$.discovery.homepage.status') IS NOT NULL THEN 'inactive'
    ELSE NULL END`;

function readSaleWatchCandidates(db, params = {}) {
  const query = normalizeQuery(params, { now: params.now });
  const { from, to } = query;

  // Pass 1: the whole eligible window, minimal columns. cohortSize and batches
  // are window-wide facts, so they are computed before any user filter.
  const census = db.prepare(`
    SELECT domain,
      ${DEPARTURE_DATE_SQL} AS departureDay,
      ${DESTINATION_JSON_SQL} AS destinationJson,
      ${SITE_CLASS_SQL} AS siteClass,
      json_extract(evidence_json,'$.discovery.buyerUse') AS buyerUse,
      probe_count AS probeCount,
      CASE WHEN @q = '' OR instr(domain, @q) > 0 OR instr(lower(evidence_json), @q) > 0 THEN 1 ELSE 0 END AS matchesQuery
    FROM sale_watch_candidates
    WHERE ${TAPE_WHERE_SQL}
  `).all({ from, to, q: query.q });

  const cohortCounts = new Map();
  const destinationHosts = new Map();
  for (const row of census) {
    const hosts = parseJsonArray(row.destinationJson);
    const key = nsSetKey(hosts);
    row.destinationKey = key;
    cohortCounts.set(key, (cohortCounts.get(key) || 0) + 1);
    if (!destinationHosts.has(key)) destinationHosts.set(key, key ? key.split(',') : []);
  }

  const batches = [...cohortCounts.entries()]
    .filter(([key, count]) => key && count >= BATCH_MIN_NAMES)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({ nsKey: key, destinationNameservers: destinationHosts.get(key), count }));

  const matching = [];
  for (const row of census) {
    if (!row.matchesQuery) continue;
    if (query.tld && tldOf(row.domain) !== query.tld) continue;
    const probed = Number(row.probeCount) > 0;
    const built = probed ? (String(row.siteClass || '') === 'built' || truthy(row.buyerUse)) : null;
    // built=true and built=false both mean "a probe decided this"; an unprobed
    // row is unknown, not false, so an explicit built filter excludes it.
    if (query.built !== null && built !== query.built) continue;
    matching.push({
      domain: row.domain,
      departureDay: String(row.departureDay || ''),
      cohortSize: cohortCounts.get(row.destinationKey) || 1,
    });
  }
  matching.sort(compareTapeRows);

  const afterCursor = query.cursor ? matching.filter(row => isAfterCursor(row, query.cursor)) : matching;
  const page = afterCursor.slice(0, query.limit);
  const hasMore = afterCursor.length > page.length;

  // Pass 2: hydrate only the page. No OFFSET is used anywhere, so a caller can
  // page through every row in the window with no offset ceiling.
  const byDomain = new Map();
  for (let index = 0; index < page.length; index += 400) {
    const slice = page.slice(index, index + 400);
    const placeholders = slice.map(() => '?').join(',');
    const hydrated = db.prepare(`
      SELECT domain, state, outcome_tier AS ledgerTier, probe_count AS probeCount,
        json_extract(evidence_json,'$.sellerNameservers') AS sellerJson,
        ${DESTINATION_JSON_SQL} AS destinationJson,
        json_extract(evidence_json,'$.discovery.movement.source') AS departureDaySource,
        ${SITE_CLASS_SQL} AS siteClass,
        json_extract(evidence_json,'$.discovery.homepage.title') AS homepageTitle,
        json_extract(evidence_json,'$.buyerTitle') AS buyerTitle,
        json_extract(evidence_json,'$.discovery.buyerUse') AS buyerUse,
        json_extract(evidence_json,'$.discovery.rdap.registrar') AS registrar,
        json_extract(evidence_json,'$.discovery.rdap.transferAt') AS transferAt,
        json_extract(evidence_json,'$.discovery.rdap.error') AS rdapError,
        json_extract(evidence_json,'$.discovery.homepage.error') AS homepageError
      FROM sale_watch_candidates WHERE domain IN (${placeholders})
    `).all(slice.map(row => row.domain));
    for (const row of hydrated) byDomain.set(row.domain, row);
  }

  const rows = page.map(entry => {
    const detail = byDomain.get(entry.domain) || {};
    const probed = Number(detail.probeCount) > 0;
    const failed = probed && (detail.rdapError || detail.homepageError);
    const sellerNameservers = parseJsonArray(detail.sellerJson).map(host => String(host).toLowerCase());
    const destination = parseJsonArray(detail.destinationJson).map(host => String(host).toLowerCase());
    const siteClass = probed ? (detail.siteClass || null) : null;
    return compact({
      domain: entry.domain,
      tld: tldOf(entry.domain),
      departureDay: entry.departureDay,
      departureDaySource: detail.departureDaySource || 'exit-observed-day',
      sellerNameservers,
      marketplace: marketplaceFromNameservers(sellerNameservers),
      destinationNameservers: destination,
      cohortSize: entry.cohortSize,
      state: detail.state || null,
      probeState: !probed ? 'unprobed' : (failed ? 'probe-failed' : 'probed'),
      built: probed ? (siteClass === 'built' || truthy(detail.buyerUse)) : null,
      siteClass,
      buyerTitle: probed ? (detail.buyerTitle || detail.homepageTitle || null) : null,
      registrar: detail.registrar || null,
      transferAt: detail.transferAt || null,
      ledgerTier: detail.ledgerTier || null,
    });
  });

  // coverage: the ingest receipts already written for these days are the
  // authority on what was excluded and why; nothing is re-derived here.
  const imports = db.prepare(
    'SELECT day, summary_json FROM sale_watch_movement_imports WHERE day >= ? AND day <= ? ORDER BY day DESC'
  ).all(from, to);
  const excludedByReason = { platformBatch: 0, expiry: 0, signalPolicy: 0, rescoredPlatformOrExpiry: 0 };
  let departures = 0;
  let eligibleAtIngest = 0;
  const days = [];
  for (const row of imports) {
    let summary = {};
    try { summary = JSON.parse(row.summary_json) || {}; } catch (_) { summary = {}; }
    departures += Number(summary.departures) || 0;
    eligibleAtIngest += Number(summary.eligible) || 0;
    excludedByReason.platformBatch += Number(summary.platformExcluded) || 0;
    excludedByReason.expiry += Number(summary.expiryExcluded) || 0;
    excludedByReason.signalPolicy += Number(summary.excludedByPolicy) || 0;
    days.push({
      day: row.day,
      departures: Number(summary.departures) || 0,
      eligible: Number(summary.eligible) || 0,
      cursorComplete: summary.cursorComplete === true,
    });
  }
  excludedByReason.rescoredPlatformOrExpiry = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM sale_watch_candidates
    WHERE outcome IN (${sqlList(RESCORED_EXCLUSIONS)})
      AND ${DEPARTURE_DATE_SQL} >= @from AND ${DEPARTURE_DATE_SQL} <= @to
  `).get({ from, to })?.n || 0);

  return {
    schema: SCHEMA,
    generatedAt: new Date(params.now || Date.now()).toISOString(),
    query: {
      from,
      to,
      days: query.days,
      q: query.q || null,
      tld: query.tld || null,
      built: query.built,
      limit: query.limit,
    },
    coverage: {
      from,
      to,
      departures,
      eligible: census.length,
      eligibleAtIngest,
      excludedByReason,
      days,
    },
    batches,
    batchThreshold: BATCH_MIN_NAMES,
    matched: matching.length,
    rows,
    pagination: {
      limit: query.limit,
      returned: rows.length,
      remaining: Math.max(0, afterCursor.length - rows.length),
      nextCursor: hasMore && rows.length ? encodeCursor(page.at(-1), query.digest) : null,
    },
  };
}

module.exports = {
  SCHEMA,
  DEFAULT_DAYS,
  MAX_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  BATCH_MIN_NAMES,
  CandidateQueryError,
  normalizeQuery,
  encodeCursor,
  decodeCursor,
  queryDigest,
  compareTapeRows,
  marketplaceFromNameservers,
  readSaleWatchCandidates,
};
