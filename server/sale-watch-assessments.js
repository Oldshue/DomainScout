'use strict';

// Stored Sale Watch ledger assessments.
//
// The ledger used to run assessSaleEntry over the whole departure window on
// every request (a SQL function per row) and again in readSaleWatchLedger.
// This module persists each candidate's assessment instead:
//
//   sale_watch_assessments       one row per candidate: assessment VERSION,
//                                tier, classification, reportDate,
//                                evidenceRank, rationale, the assessment
//                                object (basis, departureDaySource, signals,
//                                counterEvidence, ...) and the transfer
//                                evidence the classifier adds to discovery.
//   sale_watch_assessment_views  view membership, keyed
//                                (view, report_date DESC, evidence_rank,
//                                dlen, domain): one index walk serves any
//                                view page in display order.
//
// Trigger bodies never rely on INSERT OR IGNORE: an outer upsert's conflict
// policy overrides it inside a trigger and raised UNIQUE failures on ingest.
// Triggers on sale_watch_candidates mark a row dirty whenever its evidence,
// state or other assessment inputs change; the row keeps serving its previous
// assessment until the indexer worker (server/sale-watch-index-worker.js)
// rewrites it. A VERSION bump rebuilds in place the same way. Rows whose
// assessment depends on the clock (72 h staleness, the 3-day seller-departure
// window, the 14-day off-market rule) carry refresh_at and are re-assessed by
// the worker when that boundary passes, so no request ever assesses.
//
// Writes happen only on a writable handle, in small transactions, normally on
// the indexer worker thread. Reads (readStoredLedgerEntries) are plain indexed
// SELECTs and work on readonly connections.

const { assessSaleEntry, matchesSaleView, evidenceRank, VERSION } = require('./sale-watch-evidence');

const TABLE = 'sale_watch_assessments';
const VIEWS_TABLE = 'sale_watch_assessment_views';
const SALE_VIEWS = Object.freeze(['all', 'leads', 'focus', 'alpha', 'transfer', 'probable', 'suspected', 'excluded']);
const STRONG_VIEWS = new Set(['focus', 'probable', 'transfer', 'alpha']);
// Completion marker: JSON { version, completeAt, rows }, written by the worker
// only when a pass ends with no dirty or older-VERSION rows left. Until a
// marker exists the ledger is served by the read-time path (f3c6494); once one
// exists (any VERSION) the stored path serves, and a later VERSION bump is
// rebuilt in place without falling back.
const META_READY = 'assessment_store';
// Plain-version key written by earlier unreleased builds of this branch.
const META_READY_LEGACY = 'assessment_store_version';
const META_SEEDED = 'assessment_store_seeded';
// Window marker: JSON { version, windowDays, from, completeAt }, written once
// every candidate departing on/after `from` has a clean assessment on VERSION.
// Lets a windowed ledger read (days <= windowDays) serve stored pages before
// the whole-table pass completes.
const META_WINDOW = 'assessment_store_window';
const DEFAULT_WINDOW_DAYS = 30;
// The window marker tolerates this share of dirty rows in the window: a dirty
// row keeps serving its previous stored assessment until the worker rewrites
// it, so a trickle of evidence changes never blocks the switchover.
const WINDOW_DIRTY_MAX_RATIO = 0.005;
const DEFAULT_BATCH = 100;
const SEED_CHUNK = 2000;
const DAY_MS = 86400000;
const LIVE_STATES_SQL = "('detected','transferring','probing','parked-watch','exited')";
// Candidate columns the adjudicator reads (candidateEntry / candidateSelectSql
// eligibility): a change to one of their INPUT KEYS (inputKeySql) marks the
// assessment dirty. Bookkeeping columns are deliberately absent and can never
// dirty a row: search_text and the search documents (search_version, theme,
// census facts), probe_priority, next_probe_at, last_seen_day, last_price.
// The stale search rebuild and the probe-priority backfill rewrite those on
// every row and must not re-dirty assessments the worker has just written.
const INPUT_COLUMNS = ['evidence_json', 'state', 'outcome', 'outcome_tier', 'probe_count', 'exit_observed_day', 'first_seen_day', 'last_stream', 'updated_at'];
// Bookkeeping paths inside evidence_json the adjudicator never reads (the
// adoption-kit pass restamps markedAt on every run).
const EVIDENCE_BOOKKEEPING_PATHS = Object.freeze(['$.discovery.kit.markedAt']);

/**
 * SQL for one input column's comparison key, optionally on a row alias
 * ('old.' / 'new.' in triggers). evidence_json drops bookkeeping paths;
 * updated_at only matters as the lastObservedAt fallback, so it is NULL
 * whenever the evidence carries its own lastObservedAt.
 */
function inputKeySql(column, p = '') {
  const c = `${p}${column}`;
  if (column === 'evidence_json') {
    return `CASE WHEN json_valid(${c}) THEN json_remove(${c}, ${EVIDENCE_BOOKKEEPING_PATHS.map(path => `'${path}'`).join(', ')}) ELSE ${c} END`;
  }
  if (column === 'updated_at') {
    return `CASE WHEN json_valid(${p}evidence_json) AND COALESCE(json_extract(${p}evidence_json, '$.lastObservedAt'), '') <> '' THEN NULL ELSE ${c} END`;
  }
  return c;
}
const INPUT_KEYS_SQL = INPUT_COLUMNS.map((c, i) => `${inputKeySql(c)} AS input_k${i}`).join(', ');

function recon() { return require('./sale-watch-reconstruction'); }

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

/** Creates the stored-assessment tables, indexes and dirty triggers. Writable handle only. */
function ensureAssessmentSchema(db) {
  const changed = INPUT_COLUMNS.map(c => `(${inputKeySql(c, 'old.')}) IS NOT (${inputKeySql(c, 'new.')})`).join(' OR ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      domain TEXT PRIMARY KEY,
      version TEXT,
      assessed_at TEXT,
      refresh_at TEXT,
      dirty INTEGER NOT NULL DEFAULT 1,
      eligible INTEGER NOT NULL DEFAULT 0,
      tier TEXT,
      classification TEXT,
      report_date TEXT NOT NULL DEFAULT '',
      evidence_rank INTEGER NOT NULL DEFAULT 7,
      rationale TEXT,
      assessment_json TEXT,
      transfer_json TEXT,
      views TEXT
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_dirty ON ${TABLE} (domain) WHERE dirty = 1;
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_refresh ON ${TABLE} (refresh_at, domain) WHERE refresh_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ${VIEWS_TABLE} (
      view TEXT NOT NULL,
      report_date TEXT NOT NULL,
      evidence_rank INTEGER NOT NULL,
      dlen INTEGER NOT NULL,
      domain TEXT NOT NULL,
      PRIMARY KEY (view, report_date DESC, evidence_rank, dlen, domain)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_${VIEWS_TABLE}_domain ON ${VIEWS_TABLE} (domain, view);
    DROP TRIGGER IF EXISTS ${TABLE}_cand_ai;
    DROP TRIGGER IF EXISTS ${TABLE}_cand_au;
    DROP TRIGGER IF EXISTS ${TABLE}_cand_ad;
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_cand_ai AFTER INSERT ON sale_watch_candidates BEGIN
      INSERT INTO ${TABLE}(domain, dirty) SELECT new.domain, 1 WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE domain = new.domain);
      UPDATE ${TABLE} SET dirty = 1 WHERE domain = new.domain AND dirty = 0;
    END;
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_cand_au AFTER UPDATE OF ${INPUT_COLUMNS.join(', ')} ON sale_watch_candidates
    WHEN ${changed} BEGIN
      INSERT INTO ${TABLE}(domain, dirty) SELECT new.domain, 1 WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE domain = new.domain);
      UPDATE ${TABLE} SET dirty = 1 WHERE domain = new.domain AND dirty = 0;
    END;
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_cand_ad AFTER DELETE ON sale_watch_candidates BEGIN
      DELETE FROM ${VIEWS_TABLE} WHERE domain = old.domain;
      DELETE FROM ${TABLE} WHERE domain = old.domain;
    END;
  `);
}

function metaValue(db, key) {
  try {
    const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (_) {
    return null;
  }
}

function setMeta(db, key, value) {
  db.prepare(`INSERT INTO sale_watch_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** The completion marker { version, completeAt, rows }, or null before the first complete pass. */
function storeMarker(db) {
  const raw = metaValue(db, META_READY) ?? metaValue(db, META_READY_LEGACY);
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string' && parsed.version) {
    return { version: parsed.version, completeAt: parsed.completeAt || null, rows: Number.isFinite(Number(parsed.rows)) ? Number(parsed.rows) : null };
  }
  const version = typeof parsed === 'string' ? parsed : String(raw);
  return version ? { version, completeAt: null, rows: null } : null;
}

/** VERSION of the last complete stored-assessment pass, or null before the first one. */
function storedAssessmentVersion(db) {
  const marker = storeMarker(db);
  return marker ? marker.version : null;
}

/**
 * Writes the completion marker for the current VERSION, only when no row is
 * dirty or on another VERSION. Returns the marker, or null when rows remain.
 */
function recordStoreComplete(db) {
  const left = db.prepare(`SELECT 1 FROM ${TABLE} WHERE dirty = 1 OR version IS NULL OR version <> ? LIMIT 1`).get(VERSION);
  if (left) return null;
  const rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n) || 0;
  const marker = { version: VERSION, completeAt: new Date().toISOString(), rows };
  setMeta(db, META_READY, JSON.stringify(marker));
  return marker;
}

/** True once a complete pass has stored assessments (any VERSION). Read-only. */
function storedAssessmentsReady(db) {
  if (!storedAssessmentVersion(db)) return false;
  try {
    db.prepare(`SELECT 1 FROM ${VIEWS_TABLE} LIMIT 1`).get();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Which ledger read path serves and how far the store is:
 * { version (of the completed store, null before the first pass), currentVersion,
 *   complete (marker matches VERSION), serving ('stored' | 'read-time'),
 *   completeAt, assessed (rows on VERSION, not dirty), total (candidates) }.
 * counts: false skips the two COUNTs (page reads). Read-only.
 */
function ledgerStoreStatus(db, { counts = true } = {}) {
  const marker = storeMarker(db);
  const status = {
    version: marker ? marker.version : null,
    currentVersion: VERSION,
    complete: Boolean(marker && marker.version === VERSION),
    serving: storedAssessmentsReady(db) ? 'stored' : 'read-time',
    completeAt: marker ? marker.completeAt : null,
  };
  if (counts) {
    try { status.assessed = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE version = ? AND dirty = 0`).get(VERSION).n) || 0; } catch (_) { status.assessed = 0; }
    try { status.total = Number(db.prepare('SELECT COUNT(*) AS n FROM sale_watch_candidates').get().n) || 0; } catch (_) { status.total = null; }
  }
  return status;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/**
 * The ledger entry a candidate row reads as (the exact shape the old
 * readReconstructionEntries produced, minus the live reconstruction block).
 */
function candidateEntry(row, evidence = parseJson(row.evidence_json, {}) || {}) {
  return {
    domain: row.domain,
    tier: row.outcome_tier || evidence.tier || null,
    buyer: evidence.buyer || 'Buyer not yet identified',
    reportDate: evidence.reportDate || row.exit_observed_day || null,
    reportedPriceUsd: null,
    venue: evidence.venue || null,
    precision: evidence.precision || null,
    sellerNameservers: evidence.sellerNameservers || [],
    buyerNameservers: evidence.buyerNameservers || [],
    buyerTitle: evidence.buyerTitle || null,
    buyerUrl: evidence.buyerUrl || `https://${row.domain}/`,
    sourceUrl: evidence.sourceUrl || null,
    rationale: evidence.rationale || '',
    firstObservedAt: row.first_seen_day || null,
    lastObservedAt: evidence.lastObservedAt || row.updated_at || null,
    observationCount: Number.isFinite(Number(row.probe_count)) ? Number(row.probe_count) : null,
    observationStatus: 'reconstruction',
    discovery: evidence.discovery || null,
  };
}

// Earliest future instant at which a clock-dependent rule in assessSaleEntry
// could change this entry's result; null when nothing time-dependent remains.
function nextRefreshAt(assessed, now) {
  const nowMs = Date.parse(new Date(now).toISOString());
  const marks = [];
  const dated = Date.parse(assessed.lastObservedAt || assessed.discovery?.rdap?.checkedAt || '');
  if (Number.isFinite(dated)) marks.push(dated + 3 * DAY_MS, dated - DAY_MS);
  const dep = Date.parse(assessed.assessment?.departureDay || assessed.reportDate || '');
  if (Number.isFinite(dep)) for (const days of [3, 4, 14, 15]) marks.push(dep + days * DAY_MS);
  // The off-market rationale states its day count; keep it current daily.
  if (assessed.assessment?.basis === 'off-market') marks.push(nowMs + DAY_MS);
  const future = marks.map(m => m + 1000).filter(m => m > nowMs);
  return future.length ? new Date(Math.min(...future)).toISOString() : null;
}

/**
 * Assesses one candidate row (selected with the eligible / strong / alpha_pre
 * SQL predicates) exactly as the read-time path did: the row's ledger entry,
 * normalized by server/sale-watch.js normalizeEntry, through assessSaleEntry.
 */
function assessCandidateRow(row, { now = new Date() } = {}) {
  const { normalizeEntry } = require('./sale-watch');
  const normalized = normalizeEntry(candidateEntry(row));
  if (!normalized) return null;
  const assessed = assessSaleEntry(normalized, { now: new Date(now) });
  const eligible = Number(row.eligible) === 1;
  const views = eligible ? SALE_VIEWS.filter(view => matchesSaleView(assessed, view)
    && (!STRONG_VIEWS.has(view) || Number(row.strong) === 1)
    && (view !== 'alpha' || Number(row.alpha_pre) === 1)) : [];
  return {
    domain: row.domain,
    eligible: eligible ? 1 : 0,
    tier: assessed.tier,
    classification: assessed.classification || null,
    reportDate: String(assessed.reportDate || '').slice(0, 10),
    rank: evidenceRank(assessed),
    rationale: assessed.rationale || '',
    assessmentJson: JSON.stringify(assessed.assessment || null),
    transferJson: assessed.discovery && assessed.discovery.transferEvidence ? JSON.stringify(assessed.discovery.transferEvidence) : null,
    views,
    refreshAt: nextRefreshAt(assessed, now),
    // Page order keys: the departure tape's display order (raw evidence
    // reportDate / classification rank), so stored pages and cursors match
    // the read-time ordering exactly.
    orderDate: String(row.order_date || ''),
    orderRank: Number.isFinite(Number(row.order_rank)) ? Number(row.order_rank) : 7,
  };
}

function candidateSelectSql() {
  const { ELIGIBLE_SIGNAL_SQL, STRONG_EVIDENCE_SQL, ALPHA_PREFILTER_SQL, DEPARTURE_DATE_SQL, EVIDENCE_RANK_SQL } = recon();
  const eligible = `COALESCE((evidence_json IS NOT NULL
    AND (probe_count > 0 OR state IN ('detected','transferring') OR last_stream IN ('historical-departure','zone-seller-departure'))
    AND state IN ${LIVE_STATES_SQL} AND ${ELIGIBLE_SIGNAL_SQL}), 0)`;
  return `SELECT domain, ${INPUT_COLUMNS.join(', ')}, ${INPUT_KEYS_SQL},
      ${eligible} AS eligible,
      COALESCE((${STRONG_EVIDENCE_SQL}), 0) AS strong,
      COALESCE((${ALPHA_PREFILTER_SQL}), 0) AS alpha_pre,
      ${DEPARTURE_DATE_SQL} AS order_date,
      ${EVIDENCE_RANK_SQL} AS order_rank
    FROM sale_watch_candidates WHERE domain IN (SELECT value FROM json_each(?))`;
}

const statementCache = new WeakMap();
function statementsFor(db) {
  let s = statementCache.get(db);
  if (!s) {
    s = {
      selectRows: db.prepare(candidateSelectSql()),
      fingerprint: db.prepare(`SELECT ${INPUT_KEYS_SQL} FROM sale_watch_candidates WHERE domain = ?`),
      upsert: db.prepare(`INSERT INTO ${TABLE} (domain, version, assessed_at, refresh_at, dirty, eligible, tier, classification, report_date, evidence_rank, rationale, assessment_json, transfer_json, views)
        VALUES (@domain, @version, @assessedAt, @refreshAt, 0, @eligible, @tier, @classification, @reportDate, @rank, @rationale, @assessmentJson, @transferJson, @views)
        ON CONFLICT(domain) DO UPDATE SET version = excluded.version, assessed_at = excluded.assessed_at, refresh_at = excluded.refresh_at,
          dirty = 0, eligible = excluded.eligible, tier = excluded.tier, classification = excluded.classification,
          report_date = excluded.report_date, evidence_rank = excluded.evidence_rank, rationale = excluded.rationale,
          assessment_json = excluded.assessment_json, transfer_json = excluded.transfer_json, views = excluded.views`),
      clearViews: db.prepare(`DELETE FROM ${VIEWS_TABLE} WHERE domain = ?`),
      addView: db.prepare(`INSERT OR REPLACE INTO ${VIEWS_TABLE} (view, report_date, evidence_rank, dlen, domain) VALUES (?, ?, ?, ?, ?)`),
      drop: db.prepare(`DELETE FROM ${TABLE} WHERE domain = ?`),
    };
    statementCache.set(db, s);
  }
  return s;
}

function sameInputs(a, b) {
  return INPUT_COLUMNS.every((_, i) => (a[`input_k${i}`] ?? null) === (b[`input_k${i}`] ?? null));
}

/**
 * Assesses and stores the given domains. Assessment runs OUTSIDE the write
 * transaction; the transaction re-checks each row's inputs and skips any row
 * the main writer changed meanwhile (it stays dirty for the next batch), so a
 * concurrent evidence write is never overwritten by an older assessment.
 * Returns { written, skipped, failed, dropped }.
 */
function assessDomains(db, domains, { now = new Date(), onBatch = null } = {}) {
  const s = statementsFor(db);
  const rows = domains.length ? s.selectRows.all(JSON.stringify(domains)) : [];
  const found = new Set(rows.map(r => r.domain));
  const results = [];
  let failed = 0;
  for (const row of rows) {
    let record = null;
    try { record = assessCandidateRow(row, { now }); } catch (_) { record = null; }
    if (!record) {
      failed += 1;
      record = { domain: row.domain, eligible: 0, tier: null, classification: null, reportDate: '', rank: 7, rationale: 'assessment failed', assessmentJson: null, transferJson: null, views: [], refreshAt: null, orderDate: String(row.order_date || ''), orderRank: 7 };
    }
    results.push({ row, record });
  }
  const assessedAt = new Date(now).toISOString();
  let written = 0, skipped = 0, dropped = 0;
  db.transaction(() => {
    for (const domain of domains) {
      if (!found.has(domain)) { s.clearViews.run(domain); dropped += s.drop.run(domain).changes; }
    }
    for (const { row, record } of results) {
      const current = s.fingerprint.get(row.domain);
      if (!current || !sameInputs(current, row)) { skipped += 1; continue; }
      s.upsert.run({
        domain: record.domain, version: VERSION, assessedAt, refreshAt: record.refreshAt, eligible: record.eligible,
        tier: record.tier, classification: record.classification, reportDate: record.reportDate, rank: record.rank,
        rationale: record.rationale, assessmentJson: record.assessmentJson, transferJson: record.transferJson, views: record.views.join(','),
      });
      s.clearViews.run(record.domain);
      for (const view of record.views) s.addView.run(view, record.orderDate, record.orderRank, record.domain.length, record.domain);
      written += 1;
    }
    if (onBatch) onBatch(db);
  })();
  return { written, skipped, failed, dropped };
}

// Walks one keyset-ordered queue in `batch`-row transactions, yielding between them.
async function drainQueue(db, { select, cursorOf, initial, now, batch, limit, onBatch, onProgress, phase, totals }) {
  let cursor = initial;
  let exhausted = false;
  const phaseStarted = Date.now();
  const before = { examined: totals.examined, written: totals.written, skipped: totals.skipped };
  while (totals.examined < limit) {
    const take = Math.min(batch, limit - totals.examined);
    const keys = select.all({ ...cursor, take });
    if (keys.length) {
      const result = assessDomains(db, keys.map(k => k.domain), { now, onBatch });
      totals.examined += keys.length;
      totals.written += result.written;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
      totals.dropped += result.dropped;
      totals.pages += 1;
      cursor = cursorOf(keys[keys.length - 1]);
      if (onProgress && totals.pages % 100 === 0) {
        try { onProgress({ phase, indexed: totals.written, examined: totals.examined, ms: Date.now() - totals.started }); } catch (_) { /* never fails the pass */ }
      }
    }
    await require('./sale-watch-yield').yieldBetweenTransactions();
    if (keys.length < take) { exhausted = true; break; }
  }
  const ms = Date.now() - phaseStarted;
  const examined = totals.examined - before.examined;
  const stat = { phase, examined, written: totals.written - before.written, skipped: totals.skipped - before.skipped, exhausted, ms, rowsPerSec: ms > 0 ? Math.round(examined * 1000 / ms) : examined };
  if (totals.phases) totals.phases.push(stat);
  if (onProgress && examined > 0) {
    try { onProgress({ phase, indexed: stat.written, examined, ms, rowsPerSec: stat.rowsPerSec, done: true }); } catch (_) { /* never fails the pass */ }
  }
  return exhausted;
}

/** The window marker { version, windowDays, from, completeAt }, or null. Read-only. */
function windowMarker(db) {
  const raw = metaValue(db, META_WINDOW);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.version === 'string' && typeof parsed.from === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Window coverage for the switchover: { from, total, dirty, stale, ready }.
 * total: candidates departing on/after `from`; dirty: window rows marked dirty
 * or not yet seeded (they serve their previous stored assessment, if any);
 * stale: clean rows still on an older VERSION. ready when stale = 0 and
 * dirty <= 0.5% of total. Only the window counts: rows outside it, search
 * documents and probe priority play no part. Read-only.
 */
function windowCoverage(db, { now = new Date(), windowDays = DEFAULT_WINDOW_DAYS, maxDirtyRatio = WINDOW_DIRTY_MAX_RATIO } = {}) {
  const wDays = Math.max(1, Math.floor(Number(windowDays)) || DEFAULT_WINDOW_DAYS);
  const from = dayMinus(new Date(now || Date.now()).toISOString().slice(0, 10), wDays);
  const row = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN a.domain IS NULL OR a.dirty = 1 THEN 1 ELSE 0 END), 0) AS dirty,
      COALESCE(SUM(CASE WHEN a.domain IS NOT NULL AND a.dirty = 0 AND (a.version IS NULL OR a.version <> @version) THEN 1 ELSE 0 END), 0) AS stale
    FROM sale_watch_candidates c LEFT JOIN ${TABLE} a ON a.domain = c.domain
    WHERE c.exit_observed_day >= @from`).get({ from, version: VERSION });
  const total = Number(row.total) || 0;
  const dirty = Number(row.dirty) || 0;
  const stale = Number(row.stale) || 0;
  const ratio = Number.isFinite(Number(maxDirtyRatio)) && Number(maxDirtyRatio) >= 0 ? Number(maxDirtyRatio) : WINDOW_DIRTY_MAX_RATIO;
  return { from, windowDays: wDays, total, dirty, stale, maxDirty: Math.floor(total * ratio), ready: stale === 0 && dirty <= Math.floor(total * ratio) };
}

/** Writes the window marker when windowCoverage is ready; returns { coverage, marker | null }. Writable handle only. */
function recordWindowMarker(db, { now = new Date(), windowDays = DEFAULT_WINDOW_DAYS, maxDirtyRatio = WINDOW_DIRTY_MAX_RATIO } = {}) {
  const coverage = windowCoverage(db, { now, windowDays, maxDirtyRatio });
  if (!coverage.ready) return { coverage, marker: null };
  const marker = { version: VERSION, windowDays: coverage.windowDays, from: coverage.from, completeAt: new Date().toISOString(), total: coverage.total, dirty: coverage.dirty };
  setMeta(db, META_WINDOW, JSON.stringify(marker));
  return { coverage, marker };
}

/**
 * True when a ledger read limited to `days` can be served from the stored
 * assessment: the full store is ready, or the window marker (current VERSION)
 * covers every departure since today - days. Read-only.
 */
function storedWindowReady(db, { days = null, now = new Date() } = {}) {
  const dayCount = Math.floor(Number(days));
  if (!Number.isFinite(dayCount) || dayCount < 1) return false;
  const marker = windowMarker(db);
  if (!marker || marker.version !== VERSION) return false;
  const today = new Date(now || Date.now()).toISOString().slice(0, 10);
  if (dayMinus(today, dayCount) < marker.from) return false;
  try {
    db.prepare(`SELECT 1 FROM ${VIEWS_TABLE} LIMIT 1`).get();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The stored-assessment pass, run by the indexer worker after the search pass.
 *   1. the current window FIRST: every candidate departing within
 *      `windowDays` (default 30) with no clean VERSION assessment (missing,
 *      dirty or older VERSION), newest exit_observed_day first, then records
 *      the window marker. Needs no seeding (LEFT JOIN);
 *   2. first boot: seeds a dirty placeholder for every candidate (rowid chunks);
 *   3. re-assesses dirty rows (evidence / state changed, or new);
 *   4. on a VERSION change, re-assesses rows still on an older version, in
 *      place (they keep serving until replaced);
 *   5. re-assesses rows whose clock-dependent refresh_at has passed.
 * Every write clears dirty (dirty = 0). windowOnly stops after step 1.
 * Records META_READY = VERSION once every queue drained. Each phase reports
 * rows/s (result.phases). Writable handle only.
 */
async function ensureStoredAssessments(db, {
  now = new Date(), batch = DEFAULT_BATCH, limit = Infinity, onBatch = null, onProgress = null,
  windowDays = DEFAULT_WINDOW_DAYS, windowOnly = false,
} = {}) {
  await yieldToEventLoop();
  ensureAssessmentSchema(db);
  const nowDate = new Date(now || Date.now());
  const size = Math.max(1, Math.floor(Number(batch)) || DEFAULT_BATCH);
  const max = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : Infinity;
  const totals = { examined: 0, written: 0, skipped: 0, failed: 0, dropped: 0, pages: 0, seeded: 0, started: Date.now(), phases: [] };
  const common = { now: nowDate, batch: size, limit: max, onBatch, onProgress, totals };
  let windowDone = null;
  const wDays = Math.floor(Number(windowDays));
  if (Number.isFinite(wDays) && wDays >= 1) {
    const from = dayMinus(nowDate.toISOString().slice(0, 10), wDays);
    const unassessed = `(a.domain IS NULL OR a.dirty = 1 OR a.version IS NULL OR a.version <> @version)`;
    windowDone = await drainQueue(db, {
      ...common, phase: 'assess-window',
      initial: { day: '￿', rid: Number.MAX_SAFE_INTEGER, from, version: VERSION },
      cursorOf: k => ({ day: k.day, rid: k.rid, from, version: VERSION }),
      select: db.prepare(`SELECT c.rowid AS rid, c.exit_observed_day AS day, c.domain AS domain
        FROM sale_watch_candidates c LEFT JOIN ${TABLE} a ON a.domain = c.domain
        WHERE c.exit_observed_day >= @from AND (c.exit_observed_day, c.rowid) < (@day, @rid) AND ${unassessed}
        ORDER BY c.exit_observed_day DESC, c.rowid DESC LIMIT @take`),
    });
    // Rows a concurrent writer re-dirtied stay dirty and keep serving their
    // previous assessment; the marker tolerates up to 0.5% of the window.
    if (windowDone) recordWindowMarker(db, { now: nowDate, windowDays: wDays });
  }
  if (windowOnly) {
    return { version: VERSION, windowOnly: true, windowComplete: Boolean(windowMarker(db) && windowMarker(db).version === VERSION),
      examined: totals.examined, assessed: totals.written, skipped: totals.skipped, failed: totals.failed, dropped: totals.dropped,
      pages: totals.pages, phases: totals.phases, ms: Date.now() - totals.started };
  }
  if (metaValue(db, META_SEEDED) !== '1') {
    const chunk = db.prepare('SELECT rowid AS rid, domain FROM sale_watch_candidates WHERE rowid > ? ORDER BY rowid LIMIT ?');
    const insert = db.prepare(`INSERT OR IGNORE INTO ${TABLE}(domain, dirty) VALUES (?, 1)`);
    const seed = db.transaction(rows => { let n = 0; for (const r of rows) n += insert.run(r.domain).changes; return n; });
    let rid = 0;
    for (;;) {
      const rows = chunk.all(rid, SEED_CHUNK);
      if (!rows.length) break;
      totals.seeded += seed(rows);
      rid = rows[rows.length - 1].rid;
      await yieldToEventLoop();
      if (rows.length < SEED_CHUNK) break;
    }
    setMeta(db, META_SEEDED, '1');
  }
  const dirtyDone = await drainQueue(db, {
    ...common, phase: 'assess-dirty', initial: { domain: '' }, cursorOf: k => ({ domain: k.domain }),
    select: db.prepare(`SELECT domain FROM ${TABLE} WHERE dirty = 1 AND domain > @domain ORDER BY domain LIMIT @take`),
  });
  const rebuild = storedAssessmentVersion(db) !== VERSION;
  const versionDone = !rebuild || await drainQueue(db, {
    ...common, phase: 'assess-version', initial: { domain: '', version: VERSION }, cursorOf: k => ({ domain: k.domain, version: VERSION }),
    select: db.prepare(`SELECT domain FROM ${TABLE} WHERE (version IS NULL OR version <> @version) AND domain > @domain ORDER BY domain LIMIT @take`),
  });
  const nowIso = nowDate.toISOString();
  const refreshDone = await drainQueue(db, {
    ...common, phase: 'assess-refresh', initial: { at: '', domain: '', now: nowIso }, cursorOf: k => ({ at: k.refresh_at, domain: k.domain, now: nowIso }),
    select: db.prepare(`SELECT domain, refresh_at FROM ${TABLE} WHERE refresh_at IS NOT NULL AND refresh_at <= @now
      AND (refresh_at, domain) > (@at, @domain) ORDER BY refresh_at, domain LIMIT @take`),
  });
  const complete = dirtyDone && versionDone && refreshDone && totals.skipped === 0;
  if (complete && storedAssessmentVersion(db) !== VERSION) recordStoreComplete(db);
  return {
    version: VERSION,
    rebuilt: rebuild,
    versionRecorded: storedAssessmentVersion(db) === VERSION,
    complete,
    windowComplete: Boolean(windowMarker(db) && windowMarker(db).version === VERSION),
    seeded: totals.seeded,
    examined: totals.examined,
    assessed: totals.written,
    skipped: totals.skipped,
    failed: totals.failed,
    dropped: totals.dropped,
    pages: totals.pages,
    phases: totals.phases,
    ms: Date.now() - totals.started,
  };
}

function dayMinus(today, days) {
  const value = new Date(`${today}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/**
 * Reads one ledger page straight from the stored assessment, in display order
 * (reportDate DESC, evidenceRank, domain length, domain), via the
 * (view, report_date, evidence_rank, ...) key. A q search intersects with the
 * search index (and the domain substring) inside the same indexed walk. Never
 * assesses. Returns { status: 'pending' } only when no stored assessment
 * exists yet (first boot), else { status: 'ready', entries, version }.
 */
function readStoredLedgerEntries(db, { view = 'all', q = '', after = null, limit = 1000, offset = 0, days = null, now } = {}) {
  // A windowed read (days) is served once the window-first stage has stored
  // every departure in that window, before the whole-table pass completes.
  if (!storedAssessmentsReady(db) && !storedWindowReady(db, { days, now })) return { status: 'pending', entries: [] };
  const v = SALE_VIEWS.includes(view) ? view : 'all';
  const params = { view: v, limit: Math.max(1, Math.floor(Number(limit) || 1)), offset: Math.max(0, Math.floor(Number(offset) || 0)) };
  const where = ['v.view = @view'];
  const dayCount = Math.floor(Number(days));
  if (Number.isFinite(dayCount) && dayCount >= 1) {
    const today = new Date(now || Date.now()).toISOString().slice(0, 10);
    params.cutoff = dayMinus(today, dayCount);
    where.push('v.report_date >= @cutoff');
  }
  if (after && typeof after.domain === 'string') {
    params.cDate = String(after.date || '');
    params.cRank = Number.isFinite(after.rank) ? after.rank : 0;
    params.cLen = after.domain.length;
    params.cDomain = after.domain;
    where.push(`v.report_date <= @cDate AND (v.report_date < @cDate OR (v.evidence_rank > @cRank OR (v.evidence_rank = @cRank
      AND (v.dlen > @cLen OR (v.dlen = @cLen AND v.domain > @cDomain)))))`);
  }
  const needle = String(q || '').toLowerCase().slice(0, 100).trim();
  if (needle) {
    const search = require('./sale-watch-search');
    const compiled = search.compileSearch(needle);
    const matched = compiled && compiled.any && search.searchIndexAvailable(db) ? [...search.searchCandidates(db, needle).matches.keys()] : [];
    params.matched = JSON.stringify(matched);
    const clauses = ['v.domain IN (SELECT value FROM json_each(@matched))'];
    if (needle.length > 3) { params.q = needle; clauses.push('instr(v.domain, @q) > 0'); }
    where.push(`(${clauses.join(' OR ')})`);
  }
  const rows = db.prepare(`
    SELECT v.domain AS domain, c.state, c.next_probe_at, c.first_seen_day, c.updated_at, c.probe_count, c.outcome_tier, c.exit_observed_day, c.evidence_json,
      a.version AS a_version, a.tier AS a_tier, a.classification AS a_classification, a.report_date AS a_report_date, a.rationale AS a_rationale,
      a.assessment_json AS a_assessment, a.transfer_json AS a_transfer
    FROM ${VIEWS_TABLE} v
    JOIN ${TABLE} a ON a.domain = v.domain
    JOIN sale_watch_candidates c ON c.domain = v.domain
    WHERE ${where.join(' AND ')}
    ORDER BY v.report_date DESC, v.evidence_rank ASC, v.dlen ASC, v.domain ASC
    LIMIT @limit OFFSET @offset`).all(params);
  const observations = db.prepare('SELECT observed_at, kind, evidence_json FROM sale_watch_observations WHERE domain = ? ORDER BY observed_at DESC LIMIT 8');
  const entries = rows.map(row => {
    const evidence = parseJson(row.evidence_json, {}) || {};
    const base = candidateEntry(row, evidence);
    const transfer = parseJson(row.a_transfer, null);
    return {
      ...base,
      tier: row.a_tier,
      classification: row.a_classification,
      rationale: row.a_rationale || '',
      reportDate: row.a_report_date || null,
      assessment: parseJson(row.a_assessment, null),
      discovery: base.discovery ? (transfer ? { ...base.discovery, transferEvidence: transfer } : base.discovery) : null,
      reconstruction: {
        state: row.state,
        nextProbeAt: row.next_probe_at,
        observations: observations.all(row.domain).reverse().map(o => ({ at: o.observed_at, kind: o.kind, ...parseJson(o.evidence_json, {}) })),
      },
      storedAssessment: row.a_version || VERSION,
    };
  });
  return { status: 'ready', source: 'stored', entries, version: storedAssessmentVersion(db), ledgerStore: ledgerStoreStatus(db, { counts: false }) };
}

/**
 * Synchronous form of ensureStoredAssessments for in-memory handles, tests and
 * maintenance scripts: seeds missing rows, then assesses every dirty, older-
 * VERSION or refresh-due row in `batch`-row transactions and records
 * META_READY. Never used on the HTTP thread for file-backed databases.
 */
function storeAssessmentsSync(db, { now = new Date(), batch = 500 } = {}) {
  ensureAssessmentSchema(db);
  const nowDate = new Date(now || Date.now());
  const nowIso = nowDate.toISOString();
  db.prepare(`INSERT INTO ${TABLE}(domain, dirty) SELECT c.domain, 1 FROM sale_watch_candidates c
    WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} a WHERE a.domain = c.domain)`).run();
  setMeta(db, META_SEEDED, '1');
  const select = db.prepare(`SELECT domain FROM ${TABLE}
    WHERE (dirty = 1 OR version IS NULL OR version <> @version OR (refresh_at IS NOT NULL AND refresh_at <= @now)) AND domain > @after
    ORDER BY domain LIMIT @take`);
  const totals = { examined: 0, assessed: 0, skipped: 0, failed: 0, dropped: 0 };
  let after = '';
  for (;;) {
    const keys = select.all({ version: VERSION, now: nowIso, after, take: Math.max(1, Math.floor(batch) || 500) });
    if (!keys.length) break;
    const r = assessDomains(db, keys.map(k => k.domain), { now: nowDate });
    totals.examined += keys.length;
    totals.assessed += r.written;
    totals.skipped += r.skipped;
    totals.failed += r.failed;
    totals.dropped += r.dropped;
    after = keys[keys.length - 1].domain;
  }
  if (!totals.skipped) recordStoreComplete(db);
  return { version: VERSION, ...totals };
}

module.exports = {
  TABLE,
  VIEWS_TABLE,
  SALE_VIEWS,
  META_READY,
  META_WINDOW,
  DEFAULT_WINDOW_DAYS,
  WINDOW_DIRTY_MAX_RATIO,
  windowCoverage,
  recordWindowMarker,
  windowMarker,
  storedWindowReady,
  ensureAssessmentSchema,
  storeMarker,
  recordStoreComplete,
  ledgerStoreStatus,
  storedAssessmentVersion,
  storedAssessmentsReady,
  candidateEntry,
  assessCandidateRow,
  assessDomains,
  ensureStoredAssessments,
  storeAssessmentsSync,
  readStoredLedgerEntries,
  nextRefreshAt,
};
