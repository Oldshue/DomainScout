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
const { nsSetKey, isExpiryDestination } = require('./nameserver-classes');
const { SELLER_PARKING_NAMESERVERS } = require('./zone-ns-universe');
const { ELIGIBLE_SIGNAL_SQL, DEPARTURE_DATE_SQL } = require('./sale-watch-reconstruction');
const { searchCandidates, resolveMatchedTerm, resultRank, searchIndexAvailable, DOCS_TABLE, domainSubstringMatch } = require('./sale-watch-search');

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

// ── per-day destination-set census ─────────────────────────────────────────
// sale_watch_destination_day holds, per (departure day, destination nsSetKey),
// exactly what the window census used to count row by row over the indexed
// rows: n = eligible indexed rows with evidence, e = how many of those are
// expiry-origin departures, u = eligible indexed rows with no probe evidence
// yet (kept under ns_key '' and never part of a cohort). Triggers on the
// writable handle keep it current whenever a row is inserted/deleted, its
// state/outcome/evidence presence/search_text presence changes, or its search
// document's day/destination/expiry facts change. A window's cohort sizes are
// then a SUM over its days. Readers only SELECT from it.
const DESTINATION_DAY_TABLE = 'sale_watch_destination_day';
const DESTINATION_DAY_VERSION = 'sale-watch-destination-day/v1';
const CANDIDATES_TABLE = 'sale_watch_candidates';

function censusEligibleSql(c) {
  return `${c}.search_text IS NOT NULL
    AND ${c}.state IN (${sqlList(TAPE_STATES)})
    AND (${c}.outcome IS NULL OR ${c}.outcome NOT IN (${sqlList(RESCORED_EXCLUSIONS)}))
    AND ${ELIGIBLE_SIGNAL_SQL.replace(/lower\(domain\)/g, `lower(${c}.domain)`)}`;
}

function contributionSql(c, d, from, joinOn, sign) {
  return `INSERT INTO ${DESTINATION_DAY_TABLE} (day, ns_key, n, e, u)
    SELECT COALESCE(${d}.report_day, ''),
      CASE WHEN ${c}.evidence_json IS NULL THEN '' ELSE COALESCE(${d}.destination_key, '') END,
      CASE WHEN ${c}.evidence_json IS NULL THEN 0 ELSE ${sign} END,
      CASE WHEN ${c}.evidence_json IS NOT NULL AND ${d}.expiry_origin = 1 THEN ${sign} ELSE 0 END,
      CASE WHEN ${c}.evidence_json IS NULL THEN ${sign} ELSE 0 END
    FROM ${from} WHERE ${joinOn} AND ${censusEligibleSql(c)}
    ON CONFLICT(day, ns_key) DO UPDATE SET n = n + excluded.n, e = e + excluded.e, u = u + excluded.u;`;
}

/** Creates the per-day census table and its triggers. Writable handle only. */
function ensureDestinationDaySchema(db) {
  const T = DESTINATION_DAY_TABLE;
  const C = CANDIDATES_TABLE;
  const docsFrom = `${DOCS_TABLE} d`;
  const candFrom = `${C} c`;
  const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${T} (
      day TEXT NOT NULL, ns_key TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0, e INTEGER NOT NULL DEFAULT 0, u INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, ns_key)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_ci AFTER INSERT ON ${C} BEGIN
      ${contributionSql('NEW', 'd', docsFrom, 'd.domain = NEW.domain', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_cd AFTER DELETE ON ${C} BEGIN
      ${contributionSql('OLD', 'd', docsFrom, 'd.domain = OLD.domain', -1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_cu AFTER UPDATE ON ${C}
      WHEN OLD.state IS NOT NEW.state OR OLD.outcome IS NOT NEW.outcome OR OLD.domain IS NOT NEW.domain
        OR (OLD.evidence_json IS NULL) <> (NEW.evidence_json IS NULL)
        OR (OLD.search_text IS NULL) <> (NEW.search_text IS NULL)
    BEGIN
      ${contributionSql('OLD', 'd', docsFrom, 'd.domain = OLD.domain', -1)}
      ${contributionSql('NEW', 'd', docsFrom, 'd.domain = NEW.domain', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_di AFTER INSERT ON ${DOCS_TABLE} BEGIN
      ${contributionSql('c', 'NEW', candFrom, 'c.domain = NEW.domain', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_dd AFTER DELETE ON ${DOCS_TABLE} BEGIN
      ${contributionSql('c', 'OLD', candFrom, 'c.domain = OLD.domain', -1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_du AFTER UPDATE ON ${DOCS_TABLE}
      WHEN OLD.domain IS NOT NEW.domain OR OLD.report_day IS NOT NEW.report_day
        OR OLD.destination_key IS NOT NEW.destination_key OR OLD.expiry_origin IS NOT NEW.expiry_origin
    BEGIN
      ${contributionSql('c', 'OLD', candFrom, 'c.domain = OLD.domain', -1)}
      ${contributionSql('c', 'NEW', candFrom, 'c.domain = NEW.domain', 1)}
    END;
  `);
  // A fresh table over an empty docs table is already exact (the triggers
  // count every later write), so it needs no rebuild.
  if (!existed && !db.prepare(`SELECT 1 FROM ${DOCS_TABLE} LIMIT 1`).get()) {
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('destination_day_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DESTINATION_DAY_VERSION);
  }
}

/**
 * Recomputes sale_watch_destination_day one departure day per transaction,
 * yielding between days, then records DESTINATION_DAY_VERSION. Triggers keep
 * already-recomputed days exact while it runs. Writable handle only.
 */
async function rebuildDestinationDays(db) {
  const started = Date.now();
  ensureDestinationDaySchema(db);
  const T = DESTINATION_DAY_TABLE;
  const groupInsert = where => db.prepare(`INSERT INTO ${T} (day, ns_key, n, e, u)
    SELECT COALESCE(d.report_day, ''),
      CASE WHEN c.evidence_json IS NULL THEN '' ELSE COALESCE(d.destination_key, '') END,
      SUM(CASE WHEN c.evidence_json IS NULL THEN 0 ELSE 1 END),
      SUM(CASE WHEN c.evidence_json IS NOT NULL AND d.expiry_origin = 1 THEN 1 ELSE 0 END),
      SUM(CASE WHEN c.evidence_json IS NULL THEN 1 ELSE 0 END)
    FROM ${DOCS_TABLE} d JOIN ${CANDIDATES_TABLE} c ON c.domain = d.domain
    WHERE ${where} AND ${censusEligibleSql('c')}
    GROUP BY 1, 2
    ON CONFLICT(day, ns_key) DO UPDATE SET n = n + excluded.n, e = e + excluded.e, u = u + excluded.u`);
  const dated = groupInsert('d.report_day = @day');
  const blank = groupInsert("(d.report_day = '' OR d.report_day IS NULL)");
  const clear = db.prepare(`DELETE FROM ${T} WHERE day = ?`);
  const days = [...new Set(db.prepare(`SELECT DISTINCT report_day AS day FROM ${DOCS_TABLE}`).all().map(row => row.day || ''))];
  for (const day of days) {
    db.transaction(() => {
      clear.run(day);
      if (day) dated.run({ day }); else blank.run();
    })();
    await new Promise(resolve => setImmediate(resolve));
  }
  const live = new Set(days);
  db.transaction(() => {
    for (const { day } of db.prepare(`SELECT DISTINCT day FROM ${T}`).all()) if (!live.has(day)) clear.run(day);
    db.prepare(`DELETE FROM ${T} WHERE n = 0 AND e = 0 AND u = 0`).run();
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('destination_day_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DESTINATION_DAY_VERSION);
  })();
  return { version: DESTINATION_DAY_VERSION, days: days.length, ms: Date.now() - started };
}

/** True when the per-day census exists and is at the current version (read-only). */
function destinationDaysReady(db) {
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(DESTINATION_DAY_TABLE);
    if (!table) return false;
    const row = db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'destination_day_version'").get();
    return !!row && row.value === DESTINATION_DAY_VERSION;
  } catch (_) {
    return false;
  }
}

/** Window cohorts as a SUM over days: [{ k, n, e, u }] (read-only). */
function windowDestinationCohorts(db, from, to) {
  return db.prepare(`SELECT ns_key AS k, SUM(n) AS n, SUM(e) AS e, SUM(u) AS u FROM ${DESTINATION_DAY_TABLE}
    WHERE day >= ? AND day <= ? GROUP BY ns_key`).all(from, to);
}

/**
 * Search-index coverage for the window's eligible rows (read-only):
 * indexedCurrent rows carry a SEARCH_VERSION document, indexedStale rows still
 * serve an older version's document (an in-place rebuild has not reached them
 * yet), missing rows have no document, and running reports a live indexer
 * (fresh heartbeat in sale_watch_meta, or a pass in this process).
 */
function searchIndexCoverage(db, { from, to, indexed, pending }) {
  const search = require('./sale-watch-search');
  let stale = 0;
  try {
    const hasVersion = db.prepare(`PRAGMA table_info(${DOCS_TABLE})`).all().some(column => column.name === 'search_version');
    if (hasVersion && indexed > 0) {
      stale = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${DOCS_TABLE} d JOIN ${CANDIDATES_TABLE} c ON c.domain = d.domain
        WHERE d.report_day >= @from AND d.report_day <= @to
          AND (d.search_version IS NULL OR d.search_version <> @version)
          AND c.evidence_json IS NOT NULL AND ${censusEligibleSql('c')}`).get({ from, to, version: search.SEARCH_VERSION }).n || 0);
    }
  } catch (_) { stale = 0; }
  stale = Math.min(stale, indexed);
  let running = false;
  try { running = search.searchIndexerStatus(db).running === true; } catch (_) { running = false; }
  try { running = running || require('./sale-watch-search-indexer').searchIndexerState().running === true; } catch (_) { /* advisory */ }
  return {
    version: search.SEARCH_VERSION,
    storedVersion: search.storedSearchVersion(db),
    indexedCurrent: indexed - stale,
    indexedStale: stale,
    missing: pending,
    running,
    indexed,
    pending,
    complete: pending === 0 && stale === 0,
  };
}

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
  return Buffer.from(JSON.stringify({ r: Number(row.matchRank) || 0, d: row.departureDay, c: row.cohortSize, n: row.domain, h: digest }))
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
    || (parsed.r !== undefined && !Number.isFinite(Number(parsed.r)))
    || typeof parsed.n !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(parsed.n)) throw invalid();
  if (parsed.h !== digest) {
    throw new CandidateQueryError('cursor was issued for a different query; restart paging without a cursor');
  }
  return { matchRank: Number(parsed.r) || 0, departureDay: parsed.d, cohortSize: Number(parsed.c), domain: parsed.n };
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
  // A q search ranks by resultRank (built on-theme sites, alpha names, the
  // rest, kit/batch rows last; name > site > theme within each); without q
  // every row has rank 0 and the chronological order is unchanged.
  const rankA = Number(a.matchRank) || 0;
  const rankB = Number(b.matchRank) || 0;
  if (rankA !== rankB) return rankA - rankB;
  if (a.departureDay !== b.departureDay) return a.departureDay < b.departureDay ? 1 : -1;
  if (a.cohortSize !== b.cohortSize) return a.cohortSize - b.cohortSize;
  return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
}

function isAfterCursor(row, cursor) {
  return !cursor || compareTapeRows(row, cursor) > 0;
}

// Why a census row matches q: the index verdict, or (for rows not yet
// indexed) a segment-bounded domain match. Never a raw substring.
function queryMatch(search, domain, q) {
  const indexed = (search && search.matches.get(domain)) || null;
  if (indexed && indexed.matchedOn === 'name') return indexed;
  if (domainSubstringMatch(domain, q)) return { ...(indexed || {}), matchedOn: 'name', matchedTerm: q };
  return indexed;
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

// The census fast path needs the search tables plus their covering indexes
// (created on the writable handle by ensureSearchSchema). A read-only handle
// over an older file falls back to the evidence scan.
function censusIndexAvailable(db) {
  if (!searchIndexAvailable(db)) return false;
  try {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN
      ('idx_sale_watch_search_docs_census','idx_sale_watch_candidates_census','idx_sale_watch_search_missing')`).all();
    return names.length === 3;
  } catch (_) {
    return false;
  }
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

// Narrow census facts of a row not yet (re)indexed, extracted from evidence.
const EVIDENCE_CENSUS_SELECT = `SELECT domain,
      ${DEPARTURE_DATE_SQL} AS departureDay,
      ${DESTINATION_JSON_SQL} AS destinationJson,
      json_extract(evidence_json,'$.sellerNameservers') AS sellerJson,
      ${SITE_CLASS_SQL} AS siteClass,
      json_extract(evidence_json,'$.discovery.buyerUse') AS buyerUse,
      probe_count AS probeCount`;

// options.census: 'window-scan' forces the reference pass 1 (tests compare
// it with the per-day census); by default the per-day census is used when
// the handle has it at the current version.
function readSaleWatchCandidates(db, params = {}, options = {}) {
  return readSaleWatchCandidatesImpl(db, params, options);
}

function batchList(cohortCounts, destinationHosts) {
  return [...cohortCounts.entries()]
    .filter(([key, count]) => key && count >= BATCH_MIN_NAMES)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({ nsKey: key, destinationNameservers: destinationHosts.get(key), count }));
}

// Window cohort aggregates are the same for every q over one window until the
// store changes. They are cached per handle, keyed on the window plus PRAGMA
// data_version (commits by other connections) and total_changes() (writes on
// this connection), so a cached value is never stale. Read-only: no writes.
const cohortCache = new WeakMap();
function storeVersion(db) {
  try {
    const dv = db.pragma('data_version', { simple: true });
    const tc = db.prepare('SELECT total_changes() AS n').get().n;
    return `${dv}:${tc}`;
  } catch (_) {
    return null;
  }
}
function cachedCohorts(db, key, compute) {
  const version = storeVersion(db);
  if (version === null) return compute();
  let byKey = cohortCache.get(db);
  if (!byKey) { byKey = new Map(); cohortCache.set(db, byKey); }
  const hit = byKey.get(key);
  if (hit && hit.version === version) return hit.value;
  const value = compute();
  byKey.set(key, { version, value });
  while (byKey.size > 32) byKey.delete(byKey.keys().next().value);
  return value;
}

// Reference pass 1: a row-by-row scan of the whole window. Used when the
// handle has no current per-day census (an older read-only file, or while
// the census is being rebuilt) and as the equivalence oracle in tests.
function windowScanPass(db, query, search) {
  const { from, to } = query;

  // Pass 1: the whole eligible window, minimal columns. cohortSize and batches
  // are window-wide facts, so they are computed before any user filter.
  // q never touches evidence_json: it is answered from the persisted
  // buyer-meaningful search index (server/sale-watch-search.js).
  // Indexed rows (search_text written on the writable handle) take their
  // narrow census facts from the persisted search document; only rows not yet
  // indexed fall back to extracting them from evidence_json.
  const evidenceCensusSelect = EVIDENCE_CENSUS_SELECT;
  let rawCensus;
  // Search-index coverage over the window's eligible rows: indexed rows have
  // a current search document; pending rows (search_text NULL, e.g. while a
  // background rebuild is running) can still match q by domain substring or
  // their previous document, but a site/theme match may be missing, so the
  // count is reported instead of silently dropping them. Read-only and free:
  // both numbers come from rows this read already selects.
  let searchIndexIndexed = 0;
  let searchIndexPending = 0;
  // Window-wide cohort sizes / expiry counts aggregated in SQL (q path only).
  let sqlCohorts = null;
  if (censusIndexAvailable(db)) {
    // Indexed rows: covering-index join, no evidence_json access.
    const indexedCols = `SELECT d.domain AS domain, d.domain AS docDomain, d.report_day AS departureDay,
        d.destination_key AS docDestinationKey, d.expiry_origin AS docExpiryOrigin,
        d.site_class AS siteClass, d.buyer_use AS buyerUse, c.probe_count AS probeCount`;
    const indexedFromWhere = `
      FROM ${DOCS_TABLE} d INDEXED BY idx_sale_watch_search_docs_census
      JOIN sale_watch_candidates c INDEXED BY idx_sale_watch_candidates_census ON c.domain = d.domain
      WHERE d.report_day >= @from AND d.report_day <= @to
        AND c.evidence_json IS NOT NULL AND c.search_text IS NOT NULL
        AND c.state IN (${sqlList(TAPE_STATES)})
        AND (c.outcome IS NULL OR c.outcome NOT IN (${sqlList(RESCORED_EXCLUSIONS)}))
        AND ${ELIGIBLE_SIGNAL_SQL.replace(/lower\(domain\)/g, 'lower(d.domain)')}`;
    let indexed;
    if (query.q) {
      // A q search needs window-wide cohort facts but only the matching rows:
      // aggregate cohorts in SQL, then fetch just the name/index matches.
      sqlCohorts = cachedCohorts(db, `${from}|${to}`, () => db.prepare(`SELECT d.destination_key AS k, COUNT(*) AS n,
          SUM(CASE WHEN d.expiry_origin = 1 THEN 1 ELSE 0 END) AS e
        ${indexedFromWhere} GROUP BY d.destination_key`).all({ from, to }));
      indexed = db.prepare(`${indexedCols} ${indexedFromWhere}
        AND COALESCE(d.expiry_origin, 0) <> 1
        AND ((length(@q) > 3 AND instr(d.domain, @q) > 0) OR d.domain IN (SELECT value FROM json_each(@matched)))`)
        .all({ from, to, q: query.q, matched: JSON.stringify([...search.matches.keys()]) });
    } else {
      indexed = db.prepare(`${indexedCols} ${indexedFromWhere}`).all({ from, to });
    }
    // Rows not yet (re)indexed by the writable handle: evidence fallback,
    // bounded by the partial index over search_text IS NULL.
    const missing = db.prepare(`${evidenceCensusSelect}
      FROM sale_watch_candidates INDEXED BY idx_sale_watch_search_missing
      WHERE search_text IS NULL AND ${TAPE_WHERE_SQL}
    `).all({ from, to });
    rawCensus = indexed.concat(missing);
    searchIndexIndexed = sqlCohorts
      ? sqlCohorts.reduce((sum, r) => sum + (Number(r.n) || 0), 0)
      : indexed.length;
    searchIndexPending = missing.length;
  } else {
    rawCensus = db.prepare(`${evidenceCensusSelect} FROM sale_watch_candidates WHERE ${TAPE_WHERE_SQL}`).all({ from, to });
    searchIndexPending = rawCensus.length;
  }

  // A departure FROM expiry/renewal/redemption nameservers is the owner
  // renewing or recovering the name, not a sale. Same classifier the
  // adjudicator's priorExpiryOrigin uses (nameserver-classes isExpiryDestination).
  const expiryOriginByKey = new Map();
  let expiryOriginExcluded = 0;
  if (sqlCohorts) for (const r of sqlCohorts) expiryOriginExcluded += Number(r.e) || 0;
  const census = [];
  for (const row of rawCensus) {
    if (row.docDomain) {
      if (Number(row.docExpiryOrigin) === 1) { expiryOriginExcluded += 1; continue; }
      row.destinationKey = row.docDestinationKey || '';
      census.push(row);
      continue;
    }
    const sellerHosts = parseJsonArray(row.sellerJson);
    const sellerKey = nsSetKey(sellerHosts);
    if (sellerKey) {
      if (!expiryOriginByKey.has(sellerKey)) expiryOriginByKey.set(sellerKey, isExpiryDestination(sellerHosts).isExpiry === true);
      if (expiryOriginByKey.get(sellerKey)) { expiryOriginExcluded += 1; continue; }
    }
    census.push(row);
  }

  const cohortCounts = new Map();
  const destinationHosts = new Map();
  if (sqlCohorts) {
    for (const r of sqlCohorts) {
      const key = r.k || '';
      const n = (Number(r.n) || 0) - (Number(r.e) || 0);
      if (n <= 0) continue;
      cohortCounts.set(key, (cohortCounts.get(key) || 0) + n);
      if (!destinationHosts.has(key)) destinationHosts.set(key, key ? key.split(',') : []);
    }
  }
  for (const row of census) {
    // Indexed rows already carry the persisted destination key; only
    // unindexed rows derive it from the stored evidence.
    const key = row.docDomain ? (row.destinationKey || '') : nsSetKey(parseJsonArray(row.destinationJson));
    row.destinationKey = key;
    // Indexed rows were already counted by the SQL aggregate on the q path.
    if (!(sqlCohorts && row.docDomain)) cohortCounts.set(key, (cohortCounts.get(key) || 0) + 1);
    if (!destinationHosts.has(key)) destinationHosts.set(key, key ? key.split(',') : []);
  }

  const batches = batchList(cohortCounts, destinationHosts);

  // Window-wide eligible count. On the q path census holds only the matching
  // indexed rows, so indexed eligibility comes from the SQL aggregate.
  const eligibleCount = sqlCohorts
    ? sqlCohorts.reduce((sum, r) => sum + Math.max(0, (Number(r.n) || 0) - (Number(r.e) || 0)), 0)
      + census.filter(row => !row.docDomain).length
    : census.length;

  const matching = [];
  for (const row of census) {
    if (query.tld && tldOf(row.domain) !== query.tld) continue;
    let match = null;
    if (query.q) {
      match = queryMatch(search, row.domain, query.q);
      if (!match) continue;
    }
    const probed = Number(row.probeCount) > 0;
    const built = probed ? (String(row.siteClass || '') === 'built' || truthy(row.buyerUse)) : null;
    // built=true and built=false both mean "a probe decided this"; an unprobed
    // row is unknown, not false, so an explicit built filter excludes it.
    if (query.built !== null && built !== query.built) continue;
    const cohortSize = cohortCounts.get(row.destinationKey) || 1;
    matching.push({
      domain: row.domain,
      departureDay: String(row.departureDay || ''),
      cohortSize,
      matchRank: match ? resultRank(match, { domain: row.domain, built: built === true, batch: cohortSize >= BATCH_MIN_NAMES }) : 0,
      match,
    });
  }
  matching.sort(compareTapeRows);

  const afterCursor = query.cursor ? matching.filter(row => isAfterCursor(row, query.cursor)) : matching;
  const page = afterCursor.slice(0, query.limit);
  const hasMore = afterCursor.length > page.length;
  return {
    census: 'window-scan', page, hasMore, matched: matching.length, remaining: afterCursor.length - page.length,
    batches, eligibleCount, expiryOriginExcluded, searchIndexIndexed, searchIndexPending, awaitingEvidence: 0,
  };
}

const INDEXED_ROW_SELECT = `SELECT d.domain AS domain, d.report_day AS departureDay,
    COALESCE(d.destination_key, '') AS destinationKey, d.site_class AS siteClass,
    d.buyer_use AS buyerUse, c.probe_count AS probeCount`;

/**
 * Pass 1 over the per-day destination census. The window's cohort sizes,
 * batches, eligible and expiry-origin counts are SUMs over
 * sale_watch_destination_day; rows are read only for the days the requested
 * page spans (no q) or for the q matches. Rows not yet (re)indexed are added
 * from their evidence exactly as windowScanPass does. A q search also
 * returns matching rows that have no probe evidence yet (unprobed, cohortSize
 * 1, never part of a cohort or the eligible count). Read-only.
 */
function destinationDayPass(db, query, search) {
  const { from, to } = query;
  let indexed = 0;
  let expiryOriginExcluded = 0;
  let awaitingEvidence = 0;
  let eligibleCount = 0;
  const cohortCounts = new Map();
  const destinationHosts = new Map();
  for (const r of windowDestinationCohorts(db, from, to)) {
    const n = Number(r.n) || 0;
    const e = Number(r.e) || 0;
    indexed += n;
    expiryOriginExcluded += e;
    awaitingEvidence += Number(r.u) || 0;
    if (n - e <= 0) continue;
    const key = r.k || '';
    eligibleCount += n - e;
    cohortCounts.set(key, n - e);
    destinationHosts.set(key, key ? key.split(',') : []);
  }

  const missing = db.prepare(`${EVIDENCE_CENSUS_SELECT}
    FROM sale_watch_candidates INDEXED BY idx_sale_watch_search_missing
    WHERE search_text IS NULL AND ${TAPE_WHERE_SQL}`).all({ from, to });
  const expiryOriginByKey = new Map();
  const pending = [];
  for (const row of missing) {
    const sellerHosts = parseJsonArray(row.sellerJson);
    const sellerKey = nsSetKey(sellerHosts);
    if (sellerKey) {
      if (!expiryOriginByKey.has(sellerKey)) expiryOriginByKey.set(sellerKey, isExpiryDestination(sellerHosts).isExpiry === true);
      if (expiryOriginByKey.get(sellerKey)) { expiryOriginExcluded += 1; continue; }
    }
    const key = nsSetKey(parseJsonArray(row.destinationJson));
    row.destinationKey = key;
    row.departureDay = String(row.departureDay || '');
    cohortCounts.set(key, (cohortCounts.get(key) || 0) + 1);
    if (!destinationHosts.has(key)) destinationHosts.set(key, key ? key.split(',') : []);
    eligibleCount += 1;
    pending.push(row);
  }
  const batches = batchList(cohortCounts, destinationHosts);

  const keep = row => {
    if (query.tld && tldOf(row.domain) !== query.tld) return false;
    if (query.built === null) return true;
    const probed = Number(row.probeCount) > 0;
    const built = probed ? (String(row.siteClass || '') === 'built' || truthy(row.buyerUse)) : null;
    return built === query.built;
  };
  const entryFor = (row, match) => {
    const cohortSize = Number(row.unprobed) === 1 ? 1 : (cohortCounts.get(row.destinationKey || '') || 1);
    const built = Number(row.probeCount) > 0 && (String(row.siteClass || '') === 'built' || truthy(row.buyerUse));
    return {
      domain: row.domain,
      departureDay: String(row.departureDay || ''),
      cohortSize,
      matchRank: match ? resultRank(match, { domain: row.domain, built, batch: cohortSize >= BATCH_MIN_NAMES }) : 0,
      match,
    };
  };
  const base = { census: 'destination-day', batches, eligibleCount, expiryOriginExcluded, searchIndexIndexed: indexed, searchIndexPending: missing.length, awaitingEvidence };

  if (query.q) {
    const rows = db.prepare(`${INDEXED_ROW_SELECT}, CASE WHEN c.evidence_json IS NULL THEN 1 ELSE 0 END AS unprobed
      FROM ${DOCS_TABLE} d INDEXED BY idx_sale_watch_search_docs_census
      JOIN sale_watch_candidates c ON c.domain = d.domain
      WHERE d.report_day >= @from AND d.report_day <= @to
        AND ((length(@q) > 3 AND instr(d.domain, @q) > 0) OR d.domain IN (SELECT value FROM json_each(@matched)))
        AND COALESCE(d.expiry_origin, 0) <> 1
        AND ${censusEligibleSql('c')}`)
      .all({ from, to, q: query.q, matched: JSON.stringify([...search.matches.keys()]) })
      .concat(pending);
    const matching = [];
    for (const row of rows) {
      if (!keep(row)) continue;
      const match = queryMatch(search, row.domain, query.q);
      if (!match) continue;
      matching.push(entryFor(row, match));
    }
    matching.sort(compareTapeRows);
    const afterCursor = query.cursor ? matching.filter(row => isAfterCursor(row, query.cursor)) : matching;
    const page = afterCursor.slice(0, query.limit);
    return { ...base, page, hasMore: afterCursor.length > page.length, matched: matching.length, remaining: afterCursor.length - page.length };
  }

  // No q: per-day matching counts (from the census, or one index-only
  // aggregate when tld/built narrow the tape), then rows for the page's days.
  const eligibleRows = `FROM ${DOCS_TABLE} d INDEXED BY idx_sale_watch_search_docs_census
      JOIN sale_watch_candidates c INDEXED BY idx_sale_watch_candidates_census ON c.domain = d.domain
      WHERE COALESCE(d.expiry_origin, 0) <> 1 AND c.evidence_json IS NOT NULL AND ${censusEligibleSql('c')}`;
  const filtered = !!query.tld || query.built !== null;
  const counted = filtered
    ? db.prepare(`SELECT d.report_day AS day, COUNT(*) AS n ${eligibleRows}
        AND d.report_day >= @from AND d.report_day <= @to
        AND (@tld = '' OR d.domain LIKE '%.' || @tld)
        AND (@built IS NULL OR (c.probe_count > 0
          AND (CASE WHEN COALESCE(d.site_class, '') = 'built' OR COALESCE(d.buyer_use, 0) = 1 THEN 1 ELSE 0 END) = @built))
        GROUP BY d.report_day`).all({ from, to, tld: query.tld || '', built: query.built === null ? null : (query.built ? 1 : 0) })
    : db.prepare(`SELECT day, SUM(n - e) AS n FROM ${DESTINATION_DAY_TABLE} WHERE day >= @from AND day <= @to GROUP BY day`).all({ from, to });
  const dayCounts = new Map();
  for (const r of counted) dayCounts.set(r.day, Number(r.n) || 0);
  const pendingByDay = new Map();
  for (const row of pending) {
    if (!keep(row)) continue;
    if (!pendingByDay.has(row.departureDay)) pendingByDay.set(row.departureDay, []);
    pendingByDay.get(row.departureDay).push(row);
    dayCounts.set(row.departureDay, (dayCounts.get(row.departureDay) || 0) + 1);
  }
  let matched = 0;
  for (const n of dayCounts.values()) matched += n;
  const days = [...dayCounts.keys()].filter(day => dayCounts.get(day) > 0).sort().reverse();
  const dayRows = db.prepare(`${INDEXED_ROW_SELECT} ${eligibleRows} AND d.report_day = @day`);
  const cursor = query.cursor;
  const collected = [];
  let before = 0;
  for (const day of days) {
    if (cursor && day > cursor.departureDay) { before += dayCounts.get(day); continue; }
    if (collected.length > query.limit) break;
    const entries = dayRows.all({ day }).filter(keep).concat(pendingByDay.get(day) || [])
      .map(row => entryFor(row, null)).sort(compareTapeRows);
    for (const entry of entries) {
      if (cursor && !isAfterCursor(entry, cursor)) { before += 1; continue; }
      if (collected.length > query.limit) break;
      collected.push(entry);
    }
  }
  const page = collected.slice(0, query.limit);
  return { ...base, page, hasMore: collected.length > page.length, matched, remaining: matched - before - page.length };
}

function readSaleWatchCandidatesImpl(db, params = {}, options = {}) {
  const query = normalizeQuery(params, { now: params.now });
  const { from, to } = query;
  // q never touches evidence_json: it is answered from the persisted
  // buyer-meaningful search index (server/sale-watch-search.js).
  const search = query.q ? searchCandidates(db, query.q) : null;
  const pass = options.census !== 'window-scan' && censusIndexAvailable(db) && destinationDaysReady(db)
    ? destinationDayPass(db, query, search)
    : windowScanPass(db, query, search);
  const { page, hasMore, batches, eligibleCount, expiryOriginExcluded, searchIndexIndexed, searchIndexPending } = pass;

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
      matchedOn: entry.match ? entry.match.matchedOn : null,
      matchedTerm: entry.match ? resolveMatchedTerm(entry.match, search && search.families) : null,
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
  // Expiry-origin departures the tape dropped above count as expiry too.
  excludedByReason.expiry += expiryOriginExcluded;

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
      ...(query.q ? { matchMode: search && search.available ? 'search-index' : 'domain-only' } : {}),
    },
    coverage: {
      from,
      to,
      departures,
      eligible: eligibleCount,
      eligibleAtIngest,
      excludedByReason,
      expiryOriginExcluded,
      awaitingEvidence: pass.awaitingEvidence,
      census: pass.census,
      days,
      searchIndex: searchIndexCoverage(db, { from, to, indexed: searchIndexIndexed, pending: searchIndexPending }),
    },
    batches,
    batchThreshold: BATCH_MIN_NAMES,
    matched: pass.matched,
    rows,
    pagination: {
      limit: query.limit,
      returned: rows.length,
      remaining: Math.max(0, pass.remaining),
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
  DESTINATION_DAY_TABLE,
  DESTINATION_DAY_VERSION,
  ensureDestinationDaySchema,
  rebuildDestinationDays,
  destinationDaysReady,
  windowDestinationCohorts,
};
