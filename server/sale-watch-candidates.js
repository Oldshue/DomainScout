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

// Day-ordered partial expression indexes for the two candidate reads whose
// filter is the JSON departure day: rows not yet (re)indexed (the "missing"
// evidence fallback) and rows a rescore demoted. Built by the indexer worker
// (ensureSearchIndex -> ensureTapeIndexes), never on the HTTP thread or at
// boot on main; CREATE INDEX is atomic, so an interrupted build simply
// restarts on the next pass. Readers use them only once present.
const MISSING_DAY_INDEX = 'idx_sale_watch_tape_missing_day';
const RESCORED_DAY_INDEX = 'idx_sale_watch_tape_rescored_day';
const TAPE_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS ${MISSING_DAY_INDEX} ON ${CANDIDATES_TABLE} (${DEPARTURE_DATE_SQL}, domain)
    WHERE search_text IS NULL AND evidence_json IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${RESCORED_DAY_INDEX} ON ${CANDIDATES_TABLE} (${DEPARTURE_DATE_SQL})
    WHERE outcome IN (${sqlList(RESCORED_EXCLUSIONS)})`,
];
// The missing read is bounded: past this many unindexed rows in the window
// (only during a bulk re-index) the rest are reported as capped, not read.
const MISSING_CAP = 5000;
// Stale-document count bound while an in-place re-render is running.
const STALE_CAP = 10000;

/** Builds the tape's day indexes. Writable handle, indexer worker only. */
function ensureTapeIndexes(db) {
  // The day indexes this branch first built with CREATE INDEX are retired
  // (replaced by chunked maintained tables); drop any left by an earlier build.
  const started = Date.now();
  const dropped = [];
  for (const name of [MISSING_DAY_INDEX, RESCORED_DAY_INDEX, DOC_KEY_INDEX]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
      dropped.push(name);
    }
  }
  return dropped.length ? { dropped, ms: Date.now() - started } : null;
}

/** True when both tape day indexes exist (read-only). */
function tapeIndexesReady(db) {
  return missingDaysReady(db);
}

function missingRowsSql(db, { capped = false } = {}) {
  // The maintained missing set once backfilled: a PK range per window, each
  // row re-checked on the candidate by primary key. Until then the existing
  // partial index (search_text IS NULL AND evidence_json IS NOT NULL).
  if (missingDaysReady(db)) {
    return `${EVIDENCE_CENSUS_SELECT}
    FROM ${MISSING_DAY_TABLE} m CROSS JOIN sale_watch_candidates ON domain = m.name
    WHERE m.day >= @from AND m.day <= @to AND search_text IS NULL AND ${TAPE_WHERE_SQL}${capped ? `\n    LIMIT ${MISSING_CAP + 1}` : ''}`;
  }
  return `${EVIDENCE_CENSUS_SELECT}
    FROM sale_watch_candidates INDEXED BY idx_sale_watch_search_missing
    WHERE search_text IS NULL AND ${TAPE_WHERE_SQL}`;
}

// Per-day unindexed rows, read only for the days a page spans once the
// window read hit MISSING_CAP, so rows past the window cap stay reachable.
// Same day index range, one day, bounded.
const MISSING_DAY_CAP = 20000;
function missingDayRowsSql(db) {
  return `${missingRowsSql(db)}
    LIMIT ${MISSING_DAY_CAP + 1}`;
}

function rescoredCountSql(db) {
  // Read from the trigger-maintained per-day table once the worker built it:
  // a SUM over at most MAX_DAYS primary-key rows, no candidates read at all.
  if (rescoredDaysReady(db)) return RESCORED_DAY_SUM_SQL;
  return `SELECT COUNT(*) AS n FROM sale_watch_candidates INDEXED BY idx_sale_watch_outcome
    WHERE outcome IN (${sqlList(RESCORED_EXCLUSIONS)})
      AND ${DEPARTURE_DATE_SQL} >= @from AND ${DEPARTURE_DATE_SQL} <= @to`;
}

// Documents in the window built by an older SEARCH_VERSION, index-only on
// idx_sale_watch_search_docs_version and capped. Only run while the stored
// version is not current (a recorded current version means none remain).
const STALE_COUNT_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${DOCS_TABLE}
    WHERE (search_version IS NULL OR search_version < @version OR search_version > @version)
      AND report_day >= @from AND report_day <= @to
    LIMIT ${STALE_CAP})`;

// Keyset page index: a departure day's documents by destination set, then
// domain, so a page reads one cohort-size group's rows after the cursor with
// LIMIT limit+1 instead of the whole day. Built by the indexer worker
// (ensureTapeIndexes), never on main; readers use it only once present.
const DOC_KEY_INDEX = 'idx_sale_watch_tape_docs_day_key';
const DOC_KEY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${DOC_KEY_INDEX}
    ON ${DOCS_TABLE} (report_day, COALESCE(destination_key, ''), domain)`;

/** True when the keyset page index exists (read-only). */
function docKeyIndexReady(db) {
  return versionReady(db, DOC_KEY_TABLE, DOC_KEY_VERSION_KEY, DOC_KEY_VERSION);
}

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

// ── per-day tld/built census ───────────────────────────────────────────────
// sale_watch_tape_day holds, per (departure day, tld, built), the number of
// eligible indexed rows with evidence that are not expiry-origin departures:
// exactly what the built/tld per-day count used to aggregate over the window
// on every request. built is 1/0 for probed rows and -1 for unprobed ones (an
// explicit built filter never matches them). Triggers on the writable handle
// keep it current; readers only SELECT from it.
const TAPE_DAY_TABLE = 'sale_watch_tape_day';
const TAPE_DAY_VERSION = 'sale-watch-tape-day/v1';
const TAPE_DAY_PROGRESS_KEY = 'tape_day_progress';
const tldSqlOf = x => `substr(${x}, length(rtrim(${x}, replace(${x}, '.', ''))) + 1)`;
const builtSqlOf = (c, d) => `CASE WHEN ${c}.probe_count > 0 THEN
    (CASE WHEN COALESCE(${d}.site_class, '') = 'built' OR COALESCE(${d}.buyer_use, 0) = 1 THEN 1 ELSE 0 END)
    ELSE -1 END`;
const tapeDayEligibleSql = (c, d) => `COALESCE(${d}.expiry_origin, 0) <> 1 AND ${c}.evidence_json IS NOT NULL AND ${censusEligibleSql(c)}`;

function tapeDayContributionSql(c, d, from, joinOn, sign) {
  return `INSERT INTO ${TAPE_DAY_TABLE} (day, tld, built, n)
    SELECT COALESCE(${d}.report_day, ''), ${tldSqlOf(`${d}.domain`)}, ${builtSqlOf(c, d)}, ${sign}
    FROM ${from} WHERE ${joinOn} AND ${tapeDayEligibleSql(c, d)}
    ON CONFLICT(day, tld, built) DO UPDATE SET n = n + excluded.n;`;
}

/** Creates the per-day tld/built census and its triggers. Writable handle only. */
function ensureTapeDaySchema(db) {
  const T = TAPE_DAY_TABLE;
  const C = CANDIDATES_TABLE;
  const docsFrom = `${DOCS_TABLE} d`;
  const candFrom = `${C} c`;
  const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${T} (
      day TEXT NOT NULL, tld TEXT NOT NULL, built INTEGER NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, tld, built)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_ci AFTER INSERT ON ${C} BEGIN
      ${tapeDayContributionSql('NEW', 'd', docsFrom, 'd.domain = NEW.domain', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_cd AFTER DELETE ON ${C} BEGIN
      ${tapeDayContributionSql('OLD', 'd', docsFrom, 'd.domain = OLD.domain', -1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_cu AFTER UPDATE ON ${C}
      WHEN OLD.state IS NOT NEW.state OR OLD.outcome IS NOT NEW.outcome OR OLD.domain IS NOT NEW.domain
        OR (OLD.evidence_json IS NULL) <> (NEW.evidence_json IS NULL)
        OR (OLD.search_text IS NULL) <> (NEW.search_text IS NULL)
        OR (COALESCE(OLD.probe_count, 0) > 0) <> (COALESCE(NEW.probe_count, 0) > 0)
    BEGIN
      ${tapeDayContributionSql('OLD', 'd', docsFrom, 'd.domain = OLD.domain', -1)}
      ${tapeDayContributionSql('NEW', 'd', docsFrom, 'd.domain = NEW.domain', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_di AFTER INSERT ON ${DOCS_TABLE} BEGIN
      ${tapeDayContributionSql('c', 'NEW', candFrom, 'c.domain = NEW.domain', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_dd AFTER DELETE ON ${DOCS_TABLE} BEGIN
      ${tapeDayContributionSql('c', 'OLD', candFrom, 'c.domain = OLD.domain', -1)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${T}_v1_du AFTER UPDATE ON ${DOCS_TABLE}
      WHEN OLD.domain IS NOT NEW.domain OR OLD.report_day IS NOT NEW.report_day OR OLD.expiry_origin IS NOT NEW.expiry_origin
        OR OLD.site_class IS NOT NEW.site_class OR OLD.buyer_use IS NOT NEW.buyer_use
    BEGIN
      ${tapeDayContributionSql('c', 'OLD', candFrom, 'c.domain = OLD.domain', -1)}
      ${tapeDayContributionSql('c', 'NEW', candFrom, 'c.domain = NEW.domain', 1)}
    END;
  `);
  // Schema creation never marks the census ready: triggers can be absent
  // while rows are written (a bulk load pauses them, an older build never
  // had them), so only rebuildTapeDays in the indexer worker sets the mark.
  // A newly created table also forgets any resume position left by an
  // earlier table, so the backfill starts from the first day.
  if (!existed) {
    db.prepare('DELETE FROM sale_watch_meta WHERE key IN (?, ?)').run('tape_day_version', TAPE_DAY_PROGRESS_KEY);
  }
}

/**
 * Resumable backfill of sale_watch_tape_day: one departure day per
 * transaction in ascending order, recording the last finished day in
 * sale_watch_meta(tape_day_progress) so an interrupted pass resumes after it.
 * The triggers exist before any day is recomputed, so finished days stay exact.
 * Writable handle, indexer worker only.
 */
async function rebuildTapeDays(db) {
  const started = Date.now();
  ensureTapeDaySchema(db);
  const T = TAPE_DAY_TABLE;
  const groupInsert = where => db.prepare(`INSERT INTO ${T} (day, tld, built, n)
    SELECT COALESCE(d.report_day, ''), ${tldSqlOf('d.domain')}, ${builtSqlOf('c', 'd')}, COUNT(*)
    FROM ${DOCS_TABLE} d JOIN ${CANDIDATES_TABLE} c ON c.domain = d.domain
    WHERE ${where} AND ${tapeDayEligibleSql('c', 'd')}
    GROUP BY 1, 2, 3
    ON CONFLICT(day, tld, built) DO UPDATE SET n = n + excluded.n`);
  const dated = groupInsert('d.report_day = @day');
  const blank = groupInsert("(d.report_day = '' OR d.report_day IS NULL)");
  const clear = db.prepare(`DELETE FROM ${T} WHERE day = ?`);
  const saveProgress = db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('${TAPE_DAY_PROGRESS_KEY}', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  let resumeAfter = null;
  try {
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(TAPE_DAY_PROGRESS_KEY);
    const progress = row ? JSON.parse(row.value) : null;
    if (progress && progress.version === TAPE_DAY_VERSION && typeof progress.day === 'string') resumeAfter = progress.day;
  } catch (_) { resumeAfter = null; }
  const days = [...new Set(db.prepare(`SELECT DISTINCT report_day AS day FROM ${DOCS_TABLE}`).all().map(row => row.day || ''))].sort();
  let rebuilt = 0;
  for (const day of days) {
    if (resumeAfter !== null && day <= resumeAfter) continue;
    db.transaction(() => {
      clear.run(day);
      if (day) dated.run({ day }); else blank.run();
      saveProgress.run(JSON.stringify({ version: TAPE_DAY_VERSION, day }));
    })();
    rebuilt += 1;
    await new Promise(resolve => setImmediate(resolve));
  }
  const live = new Set(days);
  db.transaction(() => {
    for (const { day } of db.prepare(`SELECT DISTINCT day FROM ${T}`).all()) if (!live.has(day)) clear.run(day);
    db.prepare(`DELETE FROM ${T} WHERE n = 0`).run();
    db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES('tape_day_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(TAPE_DAY_VERSION);
    // A finished backfill drops its resume position, so a later rebuild
    // (version mark cleared) recomputes every day instead of none.
    db.prepare('DELETE FROM sale_watch_meta WHERE key = ?').run(TAPE_DAY_PROGRESS_KEY);
  })();
  return { version: TAPE_DAY_VERSION, days: days.length, rebuilt, resumedAfter: resumeAfter, ms: Date.now() - started };
}

/** True when the per-day tld/built census exists at the current version (read-only). */
function tapeDaysReady(db) {
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(TAPE_DAY_TABLE)) return false;
    const row = db.prepare("SELECT value FROM sale_watch_meta WHERE key = 'tape_day_version'").get();
    return !!row && row.value === TAPE_DAY_VERSION;
  } catch (_) {
    return false;
  }
}

// Per-day count of candidates a rescore demoted (outcome platform-/expiry-
// excluded), keyed by the JSON departure day. Kept exact by triggers on
// sale_watch_candidates; built by the indexer worker in one transaction
// (atomic: an interrupted build leaves no version mark and simply reruns on
// the next pass). Readers SELECT a SUM over at most MAX_DAYS primary-key rows.
const RESCORED_DAY_TABLE = 'sale_watch_tape_rescored_day';
const RESCORED_DAY_VERSION = 'sale-watch-tape-rescored-day/v1';
const RESCORED_DAY_VERSION_KEY = 'tape_rescored_day_version';
const RESCORED_DAY_PROGRESS_KEY = 'tape_rescored_day_progress';
const departureOf = r => DEPARTURE_DATE_SQL
  .replace(/evidence_json/g, `${r}.evidence_json`)
  .replace(/exit_observed_day/g, `${r}.exit_observed_day`);
const rescoredIn = r => `${r}.outcome IN (${sqlList(RESCORED_EXCLUSIONS)})`;
const rescoredContributionSql = (r, sign) => `INSERT INTO ${RESCORED_DAY_TABLE} (day, n)
      SELECT ${departureOf(r)}, ${sign} WHERE ${rescoredIn(r)}
      ON CONFLICT(day) DO UPDATE SET n = n + excluded.n;`;
const RESCORED_DAY_SUM_SQL = `SELECT COALESCE(SUM(n), 0) AS n FROM ${RESCORED_DAY_TABLE}
    WHERE day >= @from AND day <= @to`;

/**
 * Per-day chunked, resumable backfill shared by the rescored and document
 * version tables: the triggers already exist, so a day recomputed in its own
 * transaction stays exact afterwards; the last finished day is saved under
 * progressKey so an interrupted pass resumes after it; the version mark is
 * written only after every day (readers use the bounded fallback until then).
 */
async function backfillPerDay(db, { table, days, recompute, progressKey, versionKey, version, pruneZero = true }) {
  const clear = db.prepare(`DELETE FROM ${table} WHERE day = ?`);
  const save = db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  let resumeAfter = null;
  try {
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(progressKey);
    const p = row ? JSON.parse(row.value) : null;
    if (p && p.version === version && typeof p.day === 'string') resumeAfter = p.day;
  } catch (_) { resumeAfter = null; }
  const sorted = [...new Set(days)].sort();
  let rebuilt = 0;
  for (const day of sorted) {
    if (resumeAfter !== null && day <= resumeAfter) continue;
    db.transaction(() => { clear.run(day); recompute(day); save.run(progressKey, JSON.stringify({ version, day })); })();
    rebuilt += 1;
    await new Promise(resolve => setImmediate(resolve));
  }
  const live = new Set(sorted);
  db.transaction(() => {
    // Days no longer present, found by skipping along the primary key (one
    // probe per day, never a scan of the table).
    const nextDay = db.prepare(`SELECT day FROM ${table} WHERE day > ? ORDER BY day LIMIT 1`);
    const stale = [];
    if (!live.has('') && db.prepare(`SELECT 1 FROM ${table} WHERE day = '' LIMIT 1`).get()) stale.push('');
    for (let row = nextDay.get(''); row; row = nextDay.get(row.day)) if (!live.has(row.day)) stale.push(row.day);
    stale.forEach(day => clear.run(day));
    if (pruneZero) db.prepare(`DELETE FROM ${table} WHERE n = 0`).run();
    save.run(versionKey, version);
    db.prepare('DELETE FROM sale_watch_meta WHERE key = ?').run(progressKey);
  })();
  return { days: sorted.length, rebuilt, resumedAfter: resumeAfter };
}

/** Creates the rescored per-day table, then backfills it one day per transaction. Writable handle, indexer worker only. */
async function rebuildRescoredDays(db) {
  const started = Date.now();
  const T = RESCORED_DAY_TABLE;
  const C = CANDIDATES_TABLE;
  db.transaction(() => {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${T} (day TEXT NOT NULL PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_ci AFTER INSERT ON ${C} WHEN ${rescoredIn('NEW')} BEGIN
        ${rescoredContributionSql('NEW', 1)}
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_cd AFTER DELETE ON ${C} WHEN ${rescoredIn('OLD')} BEGIN
        ${rescoredContributionSql('OLD', -1)}
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_cu AFTER UPDATE ON ${C}
        WHEN (${rescoredIn('OLD')} OR ${rescoredIn('NEW')})
          AND (OLD.outcome IS NOT NEW.outcome OR ${departureOf('OLD')} IS NOT ${departureOf('NEW')})
      BEGIN
        ${rescoredContributionSql('OLD', -1)}
        ${rescoredContributionSql('NEW', 1)}
      END;
    `);
    if (!existed) db.prepare('DELETE FROM sale_watch_meta WHERE key IN (?, ?)').run(RESCORED_DAY_VERSION_KEY, RESCORED_DAY_PROGRESS_KEY);
  })();
  // Both reads walk only the existing partial outcome index (rescored rows), never the table.
  const by = ' INDEXED BY idx_sale_watch_outcome';
  const days = db.prepare(`SELECT DISTINCT ${DEPARTURE_DATE_SQL} AS day FROM ${C}${by} WHERE ${rescoredIn(C)}`).all().map(r => r.day || '');
  const insert = db.prepare(`INSERT INTO ${T} (day, n) SELECT @day, COUNT(*) FROM ${C}${by}
      WHERE ${rescoredIn(C)} AND ${DEPARTURE_DATE_SQL} = @day HAVING COUNT(*) > 0`);
  const r = await backfillPerDay(db, { table: T, days, recompute: day => insert.run({ day }),
    progressKey: RESCORED_DAY_PROGRESS_KEY, versionKey: RESCORED_DAY_VERSION_KEY, version: RESCORED_DAY_VERSION });
  return { version: RESCORED_DAY_VERSION, ...r, ms: Date.now() - started };
}

/** True when the rescored per-day table exists at the current version (read-only). */
function rescoredDaysReady(db) {
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(RESCORED_DAY_TABLE)) return false;
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(RESCORED_DAY_VERSION_KEY);
    return !!row && row.value === RESCORED_DAY_VERSION;
  } catch (_) {
    return false;
  }
}

// Per-day count of search documents by the SEARCH_VERSION they were built
// with ('' for none). Kept exact by triggers on the documents table (the
// indexer's upsert fires the UPDATE trigger); built by the indexer worker in
// one transaction (atomic: an interrupted build leaves no version mark and
// reruns on the next pass). The stale count is then a SUM over the window's
// primary-key range, never a read of the documents table.
const DOC_VERSION_DAY_TABLE = 'sale_watch_tape_doc_version_day';
const DOC_VERSION_DAY_VERSION = 'sale-watch-tape-doc-version-day/v1';
const DOC_VERSION_DAY_VERSION_KEY = 'tape_doc_version_day_version';
const DOC_VERSION_DAY_PROGRESS_KEY = 'tape_doc_version_day_progress';
const docVersionContributionSql = (r, sign) => `INSERT INTO ${DOC_VERSION_DAY_TABLE} (day, version, n)
      VALUES (COALESCE(${r}.report_day, ''), COALESCE(${r}.search_version, ''), ${sign})
      ON CONFLICT(day, version) DO UPDATE SET n = n + excluded.n;`;
const STALE_DAY_SUM_SQL = `SELECT COALESCE(SUM(n), 0) AS n FROM ${DOC_VERSION_DAY_TABLE}
    WHERE day >= @from AND day <= @to AND version <> @version`;

/** Creates the per-day document version table, then backfills it one day per transaction. Writable handle, indexer worker only. */
async function rebuildDocVersionDays(db) {
  const started = Date.now();
  const T = DOC_VERSION_DAY_TABLE;
  db.transaction(() => {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${T} (
        day TEXT NOT NULL, version TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, version)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_di AFTER INSERT ON ${DOCS_TABLE} BEGIN
        ${docVersionContributionSql('NEW', 1)}
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_dd AFTER DELETE ON ${DOCS_TABLE} BEGIN
        ${docVersionContributionSql('OLD', -1)}
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_du AFTER UPDATE ON ${DOCS_TABLE}
        WHEN OLD.search_version IS NOT NEW.search_version OR OLD.report_day IS NOT NEW.report_day
      BEGIN
        ${docVersionContributionSql('OLD', -1)}
        ${docVersionContributionSql('NEW', 1)}
      END;
    `);
    if (!existed) db.prepare('DELETE FROM sale_watch_meta WHERE key IN (?, ?)').run(DOC_VERSION_DAY_VERSION_KEY, DOC_VERSION_DAY_PROGRESS_KEY);
  })();
  // Day list and per-day counts read the docs census index (report_day first): the day list is
  // index-only, each day is one report_day range plus a narrow docs-row lookup (no candidates read).
  const days = db.prepare(`SELECT DISTINCT COALESCE(report_day, '') AS day FROM ${DOCS_TABLE} INDEXED BY idx_sale_watch_search_docs_census`).all().map(r => r.day);
  const dated = db.prepare(`INSERT INTO ${T} (day, version, n)
      SELECT @day, COALESCE(search_version, ''), COUNT(*) FROM ${DOCS_TABLE} INDEXED BY idx_sale_watch_search_docs_census WHERE report_day = @day GROUP BY 2`);
  const blank = db.prepare(`INSERT INTO ${T} (day, version, n)
      SELECT '', COALESCE(search_version, ''), COUNT(*) FROM ${DOCS_TABLE} WHERE report_day IS NULL OR report_day = '' GROUP BY 2`);
  const r = await backfillPerDay(db, { table: T, days, recompute: day => (day ? dated.run({ day }) : blank.run()),
    progressKey: DOC_VERSION_DAY_PROGRESS_KEY, versionKey: DOC_VERSION_DAY_VERSION_KEY, version: DOC_VERSION_DAY_VERSION });
  return { version: DOC_VERSION_DAY_VERSION, ...r, ms: Date.now() - started };
}

/** True when the per-day document version table exists at the current version (read-only). */
function docVersionDaysReady(db) {
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(DOC_VERSION_DAY_TABLE)) return false;
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(DOC_VERSION_DAY_VERSION_KEY);
    return !!row && row.value === DOC_VERSION_DAY_VERSION;
  } catch (_) {
    return false;
  }
}

// ── maintained missing set and keyset table ────────────────────────────────
// Both replace CREATE INDEX builds. A CREATE INDEX is one statement that holds
// the write lock for a full table read (on the 21 GB file that read walks the
// evidence_json overflow chains to reach search_text). Each structure here is
// a small WITHOUT ROWID table kept exact by triggers that exist before its
// backfill; the backfill runs in bounded IMMEDIATE transactions, saves its
// position after each, and writes the version mark readers gate on last.

// Unindexed tape rows (search_text NULL, evidence present, tape-eligible),
// keyed by JSON departure day.
const MISSING_DAY_TABLE = 'sale_watch_tape_missing_day';
const MISSING_DAY_VERSION = 'sale-watch-tape-missing-day/v1';
const MISSING_DAY_VERSION_KEY = 'tape_missing_day_version';
const MISSING_DAY_PROGRESS_KEY = 'tape_missing_day_progress';
const MISSING_BACKFILL_CHUNK = 2000;
const MISSING_BACKFILL_SAME_DAY_SQL = `SELECT rowid AS rid, exit_observed_day AS x FROM ${CANDIDATES_TABLE} INDEXED BY idx_sale_watch_search_missing
      WHERE search_text IS NULL AND evidence_json IS NOT NULL AND exit_observed_day = @x AND rowid > @rid
      ORDER BY rowid LIMIT @n`;
const MISSING_BACKFILL_NEXT_DAY_SQL = `SELECT rowid AS rid, exit_observed_day AS x FROM ${CANDIDATES_TABLE} INDEXED BY idx_sale_watch_search_missing
      WHERE search_text IS NULL AND evidence_json IS NOT NULL AND exit_observed_day > @x
      ORDER BY exit_observed_day, rowid LIMIT @n`;
const missingIn = r => `${r}.search_text IS NULL AND ${r}.evidence_json IS NOT NULL
      AND ${r}.state IN (${sqlList(TAPE_STATES)})
      AND (${r}.outcome IS NULL OR ${r}.outcome NOT IN (${sqlList(RESCORED_EXCLUSIONS)}))
      AND ${ELIGIBLE_SIGNAL_SQL.replace(/lower\(domain\)/g, `lower(${r}.domain)`)}`;

function metaDelete(db, ...keys) {
  db.prepare(`DELETE FROM sale_watch_meta WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
}
function metaSet(db, key, value) {
  db.prepare('INSERT INTO sale_watch_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function metaJson(db, key) {
  try { const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(key); return row ? JSON.parse(row.value) : null; } catch (_) { return null; }
}
function versionReady(db, table, key, version) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(key);
    return !!row && row.value === version;
  } catch (_) {
    return false;
  }
}

/** Creates the missing set and its triggers; never marks it ready. Writable handle only. */
function ensureMissingDaySchema(db) {
  const T = MISSING_DAY_TABLE;
  const C = CANDIDATES_TABLE;
  db.transaction(() => {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${T} (day TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (day, name)) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_ci AFTER INSERT ON ${C} WHEN ${missingIn('NEW')} BEGIN
        INSERT OR IGNORE INTO ${T} (day, name) VALUES (${departureOf('NEW')}, NEW.domain);
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_cd AFTER DELETE ON ${C} WHEN ${missingIn('OLD')} BEGIN
        DELETE FROM ${T} WHERE day = ${departureOf('OLD')} AND name = OLD.domain;
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_cu AFTER UPDATE ON ${C} WHEN (${missingIn('OLD')}) OR (${missingIn('NEW')}) BEGIN
        DELETE FROM ${T} WHERE day = ${departureOf('OLD')} AND name = OLD.domain;
        INSERT OR IGNORE INTO ${T} (day, name) SELECT ${departureOf('NEW')}, NEW.domain WHERE ${missingIn('NEW')};
      END;
    `);
    if (!existed) metaDelete(db, MISSING_DAY_VERSION_KEY, MISSING_DAY_PROGRESS_KEY);
  })();
}

/**
 * Chunked, resumable backfill of the missing set: a keyset walk of the
 * existing partial index idx_sale_watch_search_missing (exit_observed_day,
 * rowid), `chunk` rows per IMMEDIATE transaction, position saved after each.
 * maxChunks bounds one call (the next pass resumes). Indexer worker only.
 */
async function rebuildMissingDays(db, { chunk = MISSING_BACKFILL_CHUNK, maxChunks = Infinity } = {}) {
  const started = Date.now();
  ensureMissingDaySchema(db);
  const T = MISSING_DAY_TABLE;
  const C = CANDIDATES_TABLE;
  const n = Math.max(1, Math.floor(Number(chunk)) || MISSING_BACKFILL_CHUNK);
  const nulls = db.prepare(`SELECT rowid AS rid FROM ${C} INDEXED BY idx_sale_watch_search_missing
      WHERE search_text IS NULL AND evidence_json IS NOT NULL AND exit_observed_day IS NULL AND rowid > @rid
      ORDER BY rowid LIMIT @n`);
  // Keyset walk in two seeks: the rest of the current exit day after the
  // saved rowid, then the next exit days. A row-value (day, rowid) range
  // would seek on the day alone and re-read the day's earlier rows.
  const sameDay = db.prepare(MISSING_BACKFILL_SAME_DAY_SQL);
  const nextDay = db.prepare(MISSING_BACKFILL_NEXT_DAY_SQL);
  const datedBatch = () => { const same = sameDay.all({ x: pos.x, rid: pos.rid, n }); return same.length ? same : nextDay.all({ x: pos.x, n }); };
  const add = db.prepare(`INSERT OR IGNORE INTO ${T} (day, name) SELECT ${DEPARTURE_DATE_SQL}, domain FROM ${C}
      WHERE rowid IN (SELECT value FROM json_each(@ids)) AND ${missingIn(C)}`);
  const saved = metaJson(db, MISSING_DAY_PROGRESS_KEY);
  const resumedFrom = saved && saved.version === MISSING_DAY_VERSION ? saved : null;
  let pos = resumedFrom ? { ...resumedFrom } : { version: MISSING_DAY_VERSION, phase: 'null', x: '', rid: 0 };
  let chunks = 0;
  let rows = 0;
  const step = db.transaction(() => {
    const batch = pos.phase === 'null' ? nulls.all({ rid: pos.rid, n }) : datedBatch();
    if (!batch.length) {
      if (pos.phase !== 'null') return true;
      pos = { version: MISSING_DAY_VERSION, phase: 'dated', x: '', rid: 0 };
    } else {
      add.run({ ids: JSON.stringify(batch.map(r => r.rid)) });
      const last = batch[batch.length - 1];
      pos = { version: MISSING_DAY_VERSION, phase: pos.phase, x: pos.phase === 'null' ? '' : last.x, rid: last.rid };
      rows += batch.length;
    }
    metaSet(db, MISSING_DAY_PROGRESS_KEY, JSON.stringify(pos));
    return false;
  });
  for (;;) {
    if (chunks >= maxChunks) return { version: MISSING_DAY_VERSION, complete: false, chunks, rows, resumedFrom, ms: Date.now() - started };
    const done = step.immediate();
    chunks += 1;
    if (done) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  db.transaction(() => { metaSet(db, MISSING_DAY_VERSION_KEY, MISSING_DAY_VERSION); metaDelete(db, MISSING_DAY_PROGRESS_KEY); }).immediate();
  return { version: MISSING_DAY_VERSION, complete: true, chunks, rows, resumedFrom, ms: Date.now() - started };
}

/** True when the missing set is backfilled at the current version (read-only). */
function missingDaysReady(db) {
  return versionReady(db, MISSING_DAY_TABLE, MISSING_DAY_VERSION_KEY, MISSING_DAY_VERSION);
}

// Keyset page keys: (departure day, destination set, domain) of every search
// document, so a page reads one cohort-size group's rows after the cursor.
const DOC_KEY_TABLE = 'sale_watch_tape_doc_key';
const DOC_KEY_VERSION = 'sale-watch-tape-doc-key/v1';
const DOC_KEY_VERSION_KEY = 'tape_doc_key_version';
const DOC_KEY_PROGRESS_KEY = 'tape_doc_key_progress';
const docKeyValues = r => `COALESCE(${r}.report_day, ''), COALESCE(${r}.destination_key, ''), ${r}.domain`;

/** Creates the keyset table and triggers, then backfills it one day per transaction. Indexer worker only. */
async function rebuildDocKeys(db) {
  const started = Date.now();
  const T = DOC_KEY_TABLE;
  const D = DOCS_TABLE;
  db.transaction(() => {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${T} (day TEXT NOT NULL, ns_key TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (day, ns_key, name)) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_di AFTER INSERT ON ${D} BEGIN
        INSERT OR IGNORE INTO ${T} (day, ns_key, name) VALUES (${docKeyValues('NEW')});
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_dd AFTER DELETE ON ${D} BEGIN
        DELETE FROM ${T} WHERE day = COALESCE(OLD.report_day, '') AND ns_key = COALESCE(OLD.destination_key, '') AND name = OLD.domain;
      END;
      CREATE TRIGGER IF NOT EXISTS ${T}_v1_du AFTER UPDATE ON ${D}
        WHEN OLD.domain IS NOT NEW.domain OR OLD.report_day IS NOT NEW.report_day OR OLD.destination_key IS NOT NEW.destination_key
      BEGIN
        DELETE FROM ${T} WHERE day = COALESCE(OLD.report_day, '') AND ns_key = COALESCE(OLD.destination_key, '') AND name = OLD.domain;
        INSERT OR IGNORE INTO ${T} (day, ns_key, name) VALUES (${docKeyValues('NEW')});
      END;
    `);
    if (!existed) metaDelete(db, DOC_KEY_VERSION_KEY, DOC_KEY_PROGRESS_KEY);
  })();
  const days = db.prepare(`SELECT DISTINCT COALESCE(report_day, '') AS day FROM ${D} INDEXED BY idx_sale_watch_search_docs_census`).all().map(r => r.day);
  const dated = db.prepare(`INSERT OR IGNORE INTO ${T} (day, ns_key, name)
      SELECT ${docKeyValues(D)} FROM ${D} INDEXED BY idx_sale_watch_search_docs_census WHERE report_day = @day`);
  const nulls = db.prepare(`INSERT OR IGNORE INTO ${T} (day, ns_key, name)
      SELECT ${docKeyValues(D)} FROM ${D} INDEXED BY idx_sale_watch_search_docs_census WHERE report_day IS NULL`);
  const r = await backfillPerDay(db, { table: T, days, pruneZero: false,
    recompute: day => { dated.run({ day }); if (day === '') nulls.run(); },
    progressKey: DOC_KEY_PROGRESS_KEY, versionKey: DOC_KEY_VERSION_KEY, version: DOC_KEY_VERSION });
  return { version: DOC_KEY_VERSION, ...r, ms: Date.now() - started };
}

// The built/tld per-day matching count: a SUM over the small PK range.
const TAPE_DAY_COUNT_SQL = `SELECT day, SUM(n) AS n FROM ${TAPE_DAY_TABLE}
    WHERE day >= @from AND day <= @to
      AND (@tld = '' OR tld = @tld)
      AND (@built IS NULL OR built = @built)
    GROUP BY day`;

/** Worker-side maintenance of every maintained tape structure. Writable handle only. */
async function rebuildMaintainedTape(db) {
  const indexes = ensureTapeIndexes(db);
  const missingDays = missingDaysReady(db) ? null : await rebuildMissingDays(db);
  const docKeys = docKeyIndexReady(db) ? null : await rebuildDocKeys(db);
  const tapeDays = tapeDaysReady(db) ? null : await rebuildTapeDays(db);
  const rescoredDays = rescoredDaysReady(db) ? null : await rebuildRescoredDays(db);
  const docVersionDays = docVersionDaysReady(db) ? null : await rebuildDocVersionDays(db);
  return { indexes, missingDays, docKeys, tapeDays, rescoredDays, docVersionDays };
}

/**
 * Search-index coverage for the window's eligible rows (read-only):
 * indexedCurrent rows carry a SEARCH_VERSION document, indexedStale rows still
 * serve an older version's document (an in-place rebuild has not reached them
 * yet), missing rows have no document, and running reports a live indexer
 * (fresh heartbeat in sale_watch_meta, or a pass in this process).
 */
function searchIndexCoverage(db, { from, to, indexed, pending, pendingCapped = false }) {
  const search = require('./sale-watch-search');
  // A pass in this process: running state and stored version come from the
  // controller's in-memory snapshot (worker messages), never from
  // sale_watch_meta, which the worker heartbeats while it holds the write
  // lock. Only with no local pass (an indexer in another process, or idle)
  // is the meta row read.
  let local = null;
  try { local = require('./sale-watch-search-indexer').searchIndexerState(); } catch (_) { local = null; }
  let running = false;
  let storedVersion = null;
  if (local && local.running) {
    running = true;
    storedVersion = local.storedVersion == null ? null : local.storedVersion;
  } else {
    try { running = search.searchIndexerStatus(db).running === true; } catch (_) { running = false; }
    storedVersion = search.storedSearchVersion(db);
  }
  // No per-request window aggregate: once SEARCH_VERSION is recorded every
  // document is current (it is recorded only when none are stale), so the
  // capped index-only count runs only during an in-place re-render.
  let stale = 0;
  let staleCapped = false;
  if (indexed > 0 && storedVersion !== search.SEARCH_VERSION) {
    try {
      if (docVersionDaysReady(db)) {
        // Exact, from the maintained table: a SUM over the window's PK range.
        stale = Number(db.prepare(STALE_DAY_SUM_SQL).get({ from, to, version: search.SEARCH_VERSION }).n || 0);
      } else {
        const hasVersion = db.prepare(`PRAGMA table_info(${DOCS_TABLE})`).all().some(column => column.name === 'search_version');
        if (hasVersion) {
          stale = Number(db.prepare(STALE_COUNT_SQL).get({ from, to, version: search.SEARCH_VERSION }).n || 0);
          staleCapped = stale >= STALE_CAP;
        }
      }
    } catch (_) { stale = 0; }
  }
  stale = Math.min(stale, indexed);
  return {
    version: search.SEARCH_VERSION,
    storedVersion,
    indexedCurrent: indexed - stale,
    indexedStale: stale,
    ...(staleCapped ? { indexedStaleCapped: true } : {}),
    missing: pending,
    ...(pendingCapped ? { missingCapped: true } : {}),
    running,
    indexed,
    pending,
    complete: pending === 0 && stale === 0 && !pendingCapped,
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
function encodeCursor(row, digest, offset = null) {
  const o = Number.isInteger(offset) && offset >= 0 ? { o: offset } : {};
  return Buffer.from(JSON.stringify({ r: Number(row.matchRank) || 0, d: row.departureDay, c: row.cohortSize, n: row.domain, ...o, h: digest }))
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
    || (parsed.o !== undefined && !(Number.isInteger(parsed.o) && parsed.o >= 0))
    || typeof parsed.n !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(parsed.n)) throw invalid();
  if (parsed.h !== digest) {
    throw new CandidateQueryError('cursor was issued for a different query; restart paging without a cursor');
  }
  return { matchRank: Number(parsed.r) || 0, departureDay: parsed.d, cohortSize: Number(parsed.c), domain: parsed.n, ...(parsed.o !== undefined ? { offset: parsed.o } : {}) };
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
    const missing = db.prepare(missingRowsSql(db)).all({ from, to });
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
  // Same per-handle cache windowScanPass uses (keyed on data_version and
  // total_changes, so never stale): cursor pages and repeat reads of one
  // window reuse the SUM over the maintained table.
  for (const r of cachedCohorts(db, `dd|${from}|${to}`, () => windowDestinationCohorts(db, from, to))) {
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

  const missingRead = db.prepare(missingRowsSql(db, { capped: true })).all({ from, to });
  const pendingCapped = missingRead.length > MISSING_CAP;
  const missing = pendingCapped ? missingRead.slice(0, MISSING_CAP) : missingRead;
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
  const base = { census: 'destination-day', batches, eligibleCount, expiryOriginExcluded, searchIndexIndexed: indexed, searchIndexPending: missing.length, pendingCapped, awaitingEvidence };

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
  const filterParams = { from, to, tld: query.tld || '', built: query.built === null ? null : (query.built ? 1 : 0) };
  const counted = filtered && tapeDaysReady(db)
    ? db.prepare(TAPE_DAY_COUNT_SQL).all(filterParams)
    : filtered
    ? db.prepare(`SELECT d.report_day AS day, COUNT(*) AS n ${eligibleRows}
        AND d.report_day >= @from AND d.report_day <= @to
        AND (@tld = '' OR d.domain LIKE '%.' || @tld)
        AND (@built IS NULL OR (c.probe_count > 0
          AND (CASE WHEN COALESCE(d.site_class, '') = 'built' OR COALESCE(d.buyer_use, 0) = 1 THEN 1 ELSE 0 END) = @built))
        GROUP BY d.report_day`).all(filterParams)
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
  // Once the window read of unindexed rows hit MISSING_CAP, a page reads the
  // unindexed rows of each day it spans from the same day index (one day,
  // bounded by MISSING_DAY_CAP), so rows past the window cap stay reachable.
  const dayMissing = pendingCapped ? db.prepare(missingDayRowsSql(db)) : null;
  const dayPending = day => {
    if (!dayMissing) return pendingByDay.get(day) || [];
    const out = [];
    for (const row of dayMissing.all({ from: day, to: day }).slice(0, MISSING_DAY_CAP)) {
      const sellerHosts = parseJsonArray(row.sellerJson);
      const sellerKey = nsSetKey(sellerHosts);
      if (sellerKey) {
        if (!expiryOriginByKey.has(sellerKey)) expiryOriginByKey.set(sellerKey, isExpiryDestination(sellerHosts).isExpiry === true);
        if (expiryOriginByKey.get(sellerKey)) continue;
      }
      row.destinationKey = nsSetKey(parseJsonArray(row.destinationJson));
      row.departureDay = String(row.departureDay || '');
      if (keep(row)) out.push(row);
    }
    return out;
  };
  const cursor = query.cursor;
  const collected = [];
  let before = 0;
  if (!docKeyIndexReady(db)) {
    // Until the worker built the keyset index: whole page days, as before.
    for (const day of days) {
      if (cursor && day > cursor.departureDay) { before += dayCounts.get(day); continue; }
      if (collected.length > query.limit) break;
      const entries = dayRows.all({ day }).filter(keep).concat(dayPending(day))
        .map(row => entryFor(row, null)).sort(compareTapeRows);
      for (const entry of entries) {
        if (cursor && !isAfterCursor(entry, cursor)) { before += 1; continue; }
        if (collected.length > query.limit) break;
        collected.push(entry);
      }
    }
    const legacyPage = collected.slice(0, query.limit);
    return { ...base, page: legacyPage, hasMore: collected.length > legacyPage.length, matched, remaining: matched - before - legacyPage.length };
  }

  // Keyset page. Order is day DESC, cohortSize ASC, domain ASC. Within a day
  // the destination sets are grouped by window cohort size (read from the
  // day's sale_watch_destination_day PK rows); each group is read after the
  // cursor in domain order with LIMIT, either from its keys (DOC_KEY_INDEX)
  // or by walking the day's domain order (census index), whichever reads
  // fewer rows. The cursor carries its position, so remaining needs no count.
  if (cursor) {
    if (Number.isInteger(cursor.offset)) before = cursor.offset;
    else for (const day of days) if (day > cursor.departureDay) before += dayCounts.get(day);
  }
  const want = query.limit + 1;
  const keysetJoin = 'JOIN sale_watch_candidates c INDEXED BY idx_sale_watch_candidates_census ON c.domain = d.domain';
  const keysetWhere = `WHERE d.report_day = @day AND COALESCE(d.destination_key, '') IN (SELECT value FROM json_each(@keys))
        AND d.domain > @after AND COALESCE(d.expiry_origin, 0) <> 1 AND c.evidence_json IS NOT NULL AND ${censusEligibleSql('c')}
        AND (@tld = '' OR d.domain LIKE '%.' || @tld)
        AND (@built IS NULL OR (c.probe_count > 0
          AND (CASE WHEN COALESCE(d.site_class, '') = 'built' OR COALESCE(d.buyer_use, 0) = 1 THEN 1 ELSE 0 END) = @built))
      ORDER BY d.domain LIMIT @n`;
  const walkRows = db.prepare(`${INDEXED_ROW_SELECT} FROM ${DOCS_TABLE} d INDEXED BY idx_sale_watch_search_docs_census ${keysetJoin} ${keysetWhere}`);
  // Keyed group rows come from the maintained keyset table, each re-checked
  // on its document and candidate by primary key.
  const keyedWhere = keysetWhere
    .replace("WHERE d.report_day = @day AND COALESCE(d.destination_key, '') IN (SELECT value FROM json_each(@keys))",
      "WHERE k.day = @day AND k.ns_key IN (SELECT value FROM json_each(@keys)) AND d.report_day = @day AND COALESCE(d.destination_key, '') = k.ns_key")
    .replace('AND d.domain > @after', 'AND k.name > @after')
    .replace('ORDER BY d.domain LIMIT @n', 'ORDER BY k.name LIMIT @n');
  const keyRows = db.prepare(`${INDEXED_ROW_SELECT} FROM ${DOC_KEY_TABLE} k CROSS JOIN ${DOCS_TABLE} d ON d.domain = k.name CROSS ${keysetJoin} ${keyedWhere}`);
  const dayKeys = db.prepare(`SELECT ns_key AS k, n - e AS n FROM ${DESTINATION_DAY_TABLE} WHERE day = ? AND n - e > 0`);
  for (const day of days) {
    if (collected.length >= want) break;
    if (cursor && day > cursor.departureDay) continue;
    const groups = new Map();
    const group = size => {
      if (!groups.has(size)) groups.set(size, { keys: [], rows: 0, pending: [] });
      return groups.get(size);
    };
    let dayTotal = 0;
    for (const r of dayKeys.all(day)) {
      const g = group(cohortCounts.get(r.k || '') || 1);
      g.keys.push(r.k || '');
      g.rows += Number(r.n) || 0;
      dayTotal += Number(r.n) || 0;
    }
    for (const row of dayPending(day)) group(cohortCounts.get(row.destinationKey || '') || 1).pending.push(row);
    const atCursor = !!cursor && day === cursor.departureDay;
    for (const size of [...groups.keys()].sort((a, b) => a - b)) {
      if (collected.length >= want) break;
      if (atCursor && size < cursor.cohortSize) continue;
      const after = atCursor && size === cursor.cohortSize ? cursor.domain : '';
      const g = groups.get(size);
      const need = want - collected.length;
      const fetched = [];
      if (g.keys.length) {
        const byKey = g.rows <= need || g.rows * g.rows <= need * dayTotal;
        const params = { day, keys: JSON.stringify(g.keys), after, n: need, tld: filterParams.tld, built: filterParams.built };
        for (const row of (byKey ? keyRows : walkRows).all(params)) if (keep(row)) fetched.push(row);
      }
      for (const row of g.pending) if (row.domain > after) fetched.push(row);
      collected.push(...fetched.map(row => entryFor(row, null)).sort(compareTapeRows).slice(0, need));
    }
  }
  const page = collected.slice(0, query.limit);
  return { ...base, page, hasMore: collected.length > page.length, matched, remaining: matched - before - page.length, nextOffset: before + page.length };
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
  excludedByReason.rescoredPlatformOrExpiry = Number(db.prepare(rescoredCountSql(db)).get({ from, to })?.n || 0);
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
      searchIndex: searchIndexCoverage(db, { from, to, indexed: searchIndexIndexed, pending: searchIndexPending, pendingCapped: pass.pendingCapped === true }),
    },
    batches,
    batchThreshold: BATCH_MIN_NAMES,
    matched: pass.matched,
    rows,
    pagination: {
      limit: query.limit,
      returned: rows.length,
      remaining: Math.max(0, pass.remaining),
      nextCursor: hasMore && rows.length ? encodeCursor(page.at(-1), query.digest, Number.isInteger(pass.nextOffset) ? pass.nextOffset : null) : null,
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
  MISSING_DAY_INDEX,
  RESCORED_DAY_INDEX,
  MISSING_CAP,
  STALE_CAP,
  STALE_COUNT_SQL,
  ensureTapeIndexes,
  rebuildMaintainedTape,
  tapeIndexesReady,
  missingRowsSql,
  rescoredCountSql,
  TAPE_DAY_TABLE,
  TAPE_DAY_VERSION,
  TAPE_DAY_COUNT_SQL,
  ensureTapeDaySchema,
  rebuildTapeDays,
  tapeDaysReady,
  RESCORED_DAY_TABLE,
  RESCORED_DAY_VERSION,
  RESCORED_DAY_SUM_SQL,
  rebuildRescoredDays,
  rescoredDaysReady,
  DOC_VERSION_DAY_TABLE,
  DOC_VERSION_DAY_VERSION,
  STALE_DAY_SUM_SQL,
  rebuildDocVersionDays,
  docVersionDaysReady,
  DOC_KEY_INDEX,
  docKeyIndexReady,
  MISSING_DAY_TABLE,
  MISSING_BACKFILL_SAME_DAY_SQL,
  MISSING_BACKFILL_NEXT_DAY_SQL,
  MISSING_DAY_VERSION,
  rebuildMissingDays,
  missingDaysReady,
  DOC_KEY_TABLE,
  DOC_KEY_VERSION,
  rebuildDocKeys,
};
