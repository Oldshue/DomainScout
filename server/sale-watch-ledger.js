'use strict';

// Sale Watch ledger: the complete record of seller departures by day.
//
// The lead feed (server/sale-watch-insights.js) shows only names strong enough
// to be worth a look. The ledger keeps EVERY name that left a marketplace or
// parking nameserver, one row per name per departure day, with its verdict as
// a field, so the owner can read sales as a tape and count words over time.
//
// Rows come from the two places a seller departure is decided, and nowhere else:
//   * the stored assessment (server/sale-watch-assessments.js assessDomains):
//     every seller-origin candidate, whatever its strength, under the verdict
//     group of its classification (sale-watch-evidence.js ledgerVerdict);
//   * the movement import (server/sale-watch-reconstruction.js): a departure
//     the import does not admit as a candidate because it went to another
//     marketplace / parking platform ('moved') or to an expiry host ('expired').
//
// Storage (all in sale_watch.db; one narrow table and three derived ones):
//   sale_watch_ledger        id INTEGER PRIMARY KEY, domain, dayn, verdict,
//                            cls, dest, src, words. The id encodes
//                            (day, verdict, name length, name hash), so a day's
//                            rows of one verdict are ONE primary-key range,
//                            shortest names first, with no secondary index.
//   sale_watch_ledger_days   per-day row counts by verdict   (trigger-kept)
//   sale_watch_ledger_words  per-word, per-day counts by verdict (trigger-kept)
//   sale_watch_ledger_names  FTS5 over the name words (external content)
// The derived tables are maintained only by triggers on sale_watch_ledger, so
// a write site inserts or deletes a ledger row and nothing else. A row's day,
// verdict and words never change in place: a change is delete + insert.
//
// Every read here is a primary-key range or point read (SQL is exported so
// tests assert each plan). Writes happen on writable handles off the main
// thread (indexer worker, movement import), in the caller's small transaction.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { LEDGER_VERDICTS } = require('./sale-watch-evidence');

const TABLE = 'sale_watch_ledger';
const DAYS_TABLE = 'sale_watch_ledger_days';
const WORDS_TABLE = 'sale_watch_ledger_words';
const FTS_TABLE = 'sale_watch_ledger_names';
const LEDGER_SCHEMA = 'domainscout.sale-watch-ledger/v1';
const TREND_SCHEMA = 'domainscout.sale-watch-trend/v1';
const RISING_SCHEMA = 'domainscout.sale-watch-trend-rising/v1';

const VERDICTS = LEDGER_VERDICTS; // ['sold','lead','moved','expired','unknown','portfolio']
const DEFAULT_VERDICTS = Object.freeze(['sold', 'lead']);
const VERDICT_LABELS = Object.freeze({ sold: 'Sold / probably sold', lead: 'Lead', moved: 'Moved to another seller or parking', expired: 'Expired', unknown: 'Unknown', portfolio: 'Portfolio move' });
// Classification codes stored in cls (append only: stored rows keep their code).
const CLASSIFICATIONS = Object.freeze(['unconfirmed-move', 'likely-sale', 'transferred-and-built', 'transfer-completed', 'acquisition-candidate',
  'seller-departure', 'transfer-in-progress', 'platform-destination', 'lander-migration', 'expiration', 'portfolio-kit', 'registry-hold', 'reported-sale']);
const SRC_ASSESSMENT = 0;
const SRC_IMPORT = 1;

// The ledger keeps this many days; the longest window a request may ask for is
// MAX_WINDOW_DAYS. Older rows are deleted by the indexer worker (pruneLedger).
const RETENTION_DAYS = (() => { const n = parseInt(process.env.DOMAINSCOUT_SALE_LEDGER_RETENTION_DAYS, 10); return Number.isFinite(n) && n >= 30 && n <= 400 ? n : 95; })();
// Size bound (the table set must stay under ~300 MB whatever the daily volume):
// measured 110 bytes per row with everything derived from it, so 2.5 million
// rows is about 275 MB. Over the bound, the oldest days give up their 'moved'
// and 'expired' rows (the bulk the import decides alone); sold, lead, unknown
// and portfolio rows always keep the whole retention window.
const MAX_ROWS = (() => { const n = parseInt(process.env.DOMAINSCOUT_SALE_LEDGER_MAX_ROWS, 10); return Number.isFinite(n) && n >= 1000 ? n : 2500000; })();
const BULK_VERDICTS = Object.freeze(['moved', 'expired']);
const META_BULK_FLOOR = 'ledger_bulk_floor';
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 14;
const PAGE_ROWS = 200;
const Q_MAX = 100;
// A name-word search reads at most this many newest matches in the window.
const SEARCH_CAP = 5000;
const RISING_DAYS = 28;
const RISING_RECENT_DAYS = 7;
const RISING_MIN_COUNT = 3;
const RISING_MAX = 60;
const META_RISING = 'ledger_rising';
const META_BACKFILL_PREFIX = 'ledger_import_day:';
const PRUNE_BATCH = 1000;
const BACKFILL_BATCH = 250;

// ── id layout ─────────────────────────────────────────────────────────────
// id = ((dayn * 8 + verdict) * 128 + min(len, 127)) * 2^28 + hash28(domain)
// dayn = days since 2000-01-01 (below 32768 until 2089), so id < 2^53.
const EPOCH_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 86400000;
const HASH_SPAN = 2 ** 28;
const LEN_SPAN = 128;
const BUCKET_SPAN = LEN_SPAN * HASH_SPAN; // ids of one (day, verdict)
const DAY_SPAN = 8 * BUCKET_SPAN; // ids of one day
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(day) {
  const s = String(day || '').slice(0, 10);
  if (!DAY_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return null;
  const n = Math.round((t - EPOCH_MS) / DAY_MS);
  return n > 0 && n < 32768 ? n : null;
}
function dayOf(dayn) { return new Date(EPOCH_MS + Number(dayn) * DAY_MS).toISOString().slice(0, 10); }
function isoDay(at) { return new Date(at == null ? Date.now() : at).toISOString().slice(0, 10); }
function dayMinus(day, n) { return dayOf(dayNumber(day) - n); }
function bucketLo(dayn, verdict) { return (dayn * 8 + verdict) * BUCKET_SPAN; }
function idDay(id) { return Math.floor(id / DAY_SPAN); }
function idVerdict(id) { return Math.floor(id / BUCKET_SPAN) % 8; }
function hash28(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % HASH_SPAN;
}
function slotBase(dayn, verdict, domain) {
  return bucketLo(dayn, verdict) + Math.min(domain.length, LEN_SPAN - 1) * HASH_SPAN;
}

/** The name words a ledger row is found and counted by: its segmented words, else its label parts. */
function ledgerWords(domain) {
  const { nameTerms } = require('./sale-watch-search');
  let terms = [];
  let segments = [];
  try { ({ terms, segments } = nameTerms(domain)); } catch (_) { terms = []; segments = []; }
  const pick = segments.length ? segments : terms;
  const out = [];
  for (const word of pick) if (/^[a-z0-9]{2,40}$/.test(word) && !out.includes(word)) out.push(word);
  return out.slice(0, 8).join(' ');
}

// ── schema ────────────────────────────────────────────────────────────────
const N_COLS = VERDICTS.map((_, i) => `n${i}`);
// json_each over the space-separated words (tokens are [a-z0-9] only).
const wordsJson = p => `'["' || replace(${p}.words, ' ', '","') || '"]'`;
const bump = (p, sign) => N_COLS.map((c, i) => `${c} = ${c} ${sign} (${p}.verdict = ${i})`).join(', ');

function schemaSql() {
  return `
    CREATE TABLE IF NOT EXISTS sale_watch_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      dayn INTEGER NOT NULL,
      verdict INTEGER NOT NULL,
      cls INTEGER,
      dest TEXT,
      src INTEGER NOT NULL DEFAULT 0,
      words TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${DAYS_TABLE} (
      dayn INTEGER PRIMARY KEY,
      ${N_COLS.map(c => `${c} INTEGER NOT NULL DEFAULT 0`).join(', ')}
    );
    CREATE TABLE IF NOT EXISTS ${WORDS_TABLE} (
      word TEXT NOT NULL,
      dayn INTEGER NOT NULL,
      ${N_COLS.map(c => `${c} INTEGER NOT NULL DEFAULT 0`).join(', ')},
      PRIMARY KEY (word, dayn)
    ) WITHOUT ROWID;
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      words, content='${TABLE}', content_rowid='id', tokenize='unicode61', detail=none, columnsize=0
    );
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_ai AFTER INSERT ON ${TABLE} BEGIN
      INSERT INTO ${DAYS_TABLE}(dayn) SELECT new.dayn WHERE NOT EXISTS (SELECT 1 FROM ${DAYS_TABLE} WHERE dayn = new.dayn);
      UPDATE ${DAYS_TABLE} SET ${bump('new', '+')} WHERE dayn = new.dayn;
      INSERT INTO ${WORDS_TABLE}(word, dayn) SELECT j.value, new.dayn FROM json_each(${wordsJson('new')}) j
        WHERE new.words <> '' AND NOT EXISTS (SELECT 1 FROM ${WORDS_TABLE} w WHERE w.word = j.value AND w.dayn = new.dayn);
      UPDATE ${WORDS_TABLE} SET ${bump('new', '+')}
        WHERE new.words <> '' AND dayn = new.dayn AND word IN (SELECT value FROM json_each(${wordsJson('new')}));
      INSERT INTO ${FTS_TABLE}(rowid, words) VALUES (new.id, new.words);
    END;
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_ad AFTER DELETE ON ${TABLE} BEGIN
      UPDATE ${DAYS_TABLE} SET ${bump('old', '-')} WHERE dayn = old.dayn;
      DELETE FROM ${DAYS_TABLE} WHERE dayn = old.dayn AND ${N_COLS.join(' + ')} <= 0;
      UPDATE ${WORDS_TABLE} SET ${bump('old', '-')}
        WHERE old.words <> '' AND dayn = old.dayn AND word IN (SELECT value FROM json_each(${wordsJson('old')}));
      DELETE FROM ${WORDS_TABLE}
        WHERE old.words <> '' AND dayn = old.dayn AND word IN (SELECT value FROM json_each(${wordsJson('old')})) AND ${N_COLS.join(' + ')} <= 0;
      INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, words) VALUES ('delete', old.id, old.words);
    END;
  `;
}

/** Creates the ledger tables and triggers (metadata only; no row is touched). Writable handle only. */
function ensureLedgerSchema(db) {
  const run = () => db.exec(schemaSql());
  if (db.inTransaction) run();
  else db.transaction(run).immediate();
}

function ledgerAvailable(db) {
  try { db.prepare(`SELECT 1 FROM ${TABLE} LIMIT 1`).get(); return true; } catch (_) { return false; }
}

// ── writes ────────────────────────────────────────────────────────────────
const writeCache = new WeakMap();
function writeStatements(db) {
  let s = writeCache.get(db);
  if (!s) {
    s = {
      byId: db.prepare(`SELECT id, domain, dayn, verdict, cls, dest, src, words FROM ${TABLE} WHERE id = ?`),
      insert: db.prepare(`INSERT INTO ${TABLE}(id, domain, dayn, verdict, cls, dest, src, words) VALUES (@id, @domain, @dayn, @verdict, @cls, @dest, @src, @words)`),
      touch: db.prepare(`UPDATE ${TABLE} SET cls = @cls, dest = @dest, src = @src WHERE id = @id`),
      remove: db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`),
    };
    writeCache.set(db, s);
  }
  return s;
}

function retentionFloor(now) { return dayNumber(isoDay(now)) - RETENTION_DAYS; }

// First day whose 'moved' / 'expired' rows are kept (0: all of them). Set by
// pruneLedger when the size bound trims the oldest days; cached per handle.
const bulkFloorCache = new WeakMap();
function bulkFloor(db, { fresh = false } = {}) {
  const hit = bulkFloorCache.get(db);
  if (!fresh && hit && Date.now() - hit.at < 5000) return hit.value;
  const value = Number(getMeta(db, META_BULK_FLOOR)) || 0;
  bulkFloorCache.set(db, { at: Date.now(), value });
  return value;
}

/** Deletes one ledger row by id (a no-op when it is gone). Returns rows deleted. */
function deleteLedgerRow(db, id) {
  if (id == null) return 0;
  return writeStatements(db).remove.run(id).changes;
}

/**
 * Writes one name's ledger row and returns its id, or null when the row does
 * not belong (unknown verdict, undated, or older than the retention window).
 * previousId is the row this name held before (its stored assessment's
 * ledger_id): when the day or verdict moved, that row is deleted first, so a
 * name never holds two rows for one departure. Idempotent: writing the same
 * (domain, day, verdict) again touches nothing but cls / dest.
 */
function writeLedgerRow(db, { domain, day, verdict, classification = null, dest = null, src = SRC_ASSESSMENT, previousId = null, now = null } = {}) {
  const s = writeStatements(db);
  const name = String(domain || '').toLowerCase();
  const v = VERDICTS.indexOf(verdict);
  const dayn = dayNumber(day);
  if (!name || v < 0 || dayn == null || dayn < retentionFloor(now) || (BULK_VERDICTS.includes(verdict) && dayn < bulkFloor(db))) {
    if (previousId != null) s.remove.run(previousId);
    return null;
  }
  const clsCode = CLASSIFICATIONS.indexOf(classification);
  const cls = clsCode < 0 ? null : clsCode;
  const destText = dest ? String(dest).slice(0, 40) : null;
  const base = slotBase(dayn, v, name);
  const start = hash28(name);
  let reuse = null;
  if (previousId != null) {
    const prev = s.byId.get(previousId);
    if (prev && prev.domain === name && prev.dayn === dayn && prev.verdict === v) reuse = prev;
    else if (prev && prev.domain === name) s.remove.run(previousId);
  }
  // Open addressing inside the (day, verdict, length) slot: a different name
  // on the same hash moves to the next id.
  for (let probe = 0; probe < 64 && !reuse; probe += 1) {
    const id = base + ((start + probe) % HASH_SPAN);
    const row = s.byId.get(id);
    if (!row) {
      s.insert.run({ id, domain: name, dayn, verdict: v, cls, dest: destText, src, words: ledgerWords(name) });
      return id;
    }
    if (row.domain === name) reuse = row;
  }
  if (!reuse) return null;
  if (reuse.cls !== cls || reuse.dest !== destText || reuse.src !== src) s.touch.run({ id: reuse.id, cls, dest: destText, src });
  return reuse.id;
}

/**
 * Records a departure the movement import does not admit as a candidate
 * (platform or expiry destination). Never throws: the import must not fail on
 * the ledger. Returns the row id or null.
 */
function recordImportDeparture(db, { domain, day, verdict, classification, dest = null, now = null } = {}) {
  try {
    return writeLedgerRow(db, { domain, day, verdict, classification, dest, src: SRC_IMPORT, now });
  } catch (error) {
    if (!recordImportDeparture.warned) {
      recordImportDeparture.warned = true;
      try { console.warn(`[SaleWatchLedger] import departure not recorded: ${error.message}`); } catch (_) { /* advisory */ }
    }
    return null;
  }
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO sale_watch_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function getMeta(db, key) {
  try { const row = db.prepare('SELECT value FROM sale_watch_meta WHERE key = ?').get(key); return row ? row.value : null; } catch (_) { return null; }
}
/** Marks a day's import departures as recorded in the ledger (the backfill skips it). */
function markImportDay(db, day, signature = '') { setMeta(db, `${META_BACKFILL_PREFIX}${day}`, String(signature || '1')); }
function importDayMarked(db, day) { return getMeta(db, `${META_BACKFILL_PREFIX}${day}`) != null; }

// ── reads (read-only lane; plain data only) ───────────────────────────────
const SQL = Object.freeze({
  // One (day, verdict) page: a primary-key range, shortest names first.
  bucketPage: `SELECT id, domain, cls, dest, src FROM ${TABLE} WHERE id > @after AND id < @hi ORDER BY id LIMIT @take`,
  dayCounts: `SELECT dayn, ${N_COLS.join(', ')} FROM ${DAYS_TABLE} WHERE dayn >= @from AND dayn <= @to ORDER BY dayn DESC`,
  imports: 'SELECT day, imported_at, departures, queued, summary_json FROM sale_watch_movement_imports WHERE day >= @from AND day <= @to ORDER BY day DESC',
  // Newest name-word matches in the window: the FTS index, by rowid range.
  search: `SELECT rowid AS id FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH @match AND rowid >= @lo AND rowid < @hi ORDER BY rowid DESC LIMIT @cap`,
  rowsById: `SELECT id, domain, cls, dest, src FROM ${TABLE} WHERE id IN (SELECT value FROM json_each(@ids))`,
  wordDays: `SELECT dayn, ${N_COLS.join(', ')} FROM ${WORDS_TABLE} WHERE word = @word AND dayn >= @from AND dayn <= @to ORDER BY dayn`,
  // Rising words: the sold rows of one day (a primary-key range).
  soldWords: `SELECT words FROM ${TABLE} WHERE id >= @lo AND id < @hi`,
  pruneIds: `SELECT id FROM ${TABLE} WHERE id < @hi ORDER BY id LIMIT @take`,
});

class LedgerQueryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.code = 'SALE_WATCH_LEDGER_QUERY'; }
}

function validDay(value) { return typeof value === 'string' && DAY_RE.test(value) && dayNumber(value) != null && dayOf(dayNumber(value)) === value; }
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(cursor) {
  try {
    const v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString());
    if (!v || typeof v !== 'object' || v.v !== 1) throw new Error('bad');
    return v;
  } catch (_) { throw new LedgerQueryError('cursor: invalid page cursor'); }
}

/** Parses verdict=sold,lead (or all). Throws LedgerQueryError on an unknown group. */
function parseVerdicts(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_VERDICTS.slice();
  const list = (Array.isArray(raw) ? raw.join(',') : String(raw)).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes('all')) return VERDICTS.slice();
  for (const v of list) if (!VERDICTS.includes(v)) throw new LedgerQueryError(`verdict: must be all or a list of ${VERDICTS.join(', ')}`);
  if (!list.length) return DEFAULT_VERDICTS.slice();
  return VERDICTS.filter(v => list.includes(v));
}

/** The whole-word name query: lowercase [a-z0-9] words, at most 6. */
function queryWords(q) {
  return (String(q || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length >= 2 && w.length <= 40).slice(0, 6);
}

/** Parses ?from&to&window&verdict&q&cursor for scope=ledger. */
function normalizeLedgerQuery(query = {}, { now = null } = {}) {
  const today = isoDay(now);
  let windowDays = DEFAULT_WINDOW_DAYS;
  if (query.window !== undefined && query.window !== '') {
    if (!/^\d+$/.test(String(query.window)) || Number(query.window) < 1 || Number(query.window) > MAX_WINDOW_DAYS) throw new LedgerQueryError(`window: must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
    windowDays = Number(query.window);
  }
  const to = query.to === undefined || query.to === '' ? today : query.to;
  if (!validDay(to)) throw new LedgerQueryError('to: must be a YYYY-MM-DD date');
  const from = query.from === undefined || query.from === '' ? dayMinus(to, windowDays - 1) : query.from;
  if (!validDay(from)) throw new LedgerQueryError('from: must be a YYYY-MM-DD date');
  if (from > to) throw new LedgerQueryError('from: must not be after to');
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_WINDOW_DAYS) throw new LedgerQueryError(`from/to: window must be at most ${MAX_WINDOW_DAYS} days`);
  const verdicts = parseVerdicts(query.verdict);
  const rawQ = query.q === undefined ? '' : query.q;
  if (typeof rawQ !== 'string') throw new LedgerQueryError('q: must be a string');
  if (rawQ.length > Q_MAX) throw new LedgerQueryError(`q: must be at most ${Q_MAX} characters`);
  const q = rawQ.trim().toLowerCase();
  const cursor = query.cursor ? String(query.cursor).slice(0, 1024) : null;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c.from !== from || c.to !== to || c.verdicts !== verdicts.join(',') || String(c.q || '') !== q) throw new LedgerQueryError('cursor: minted for a different query');
  }
  return { scope: 'ledger', from, to, verdicts, q, cursor };
}

function rowOut(r, id = r.id) {
  const v = idVerdict(id);
  return {
    domain: r.domain,
    day: dayOf(idDay(id)),
    verdict: VERDICTS[v],
    classification: r.cls == null ? null : (CLASSIFICATIONS[r.cls] || null),
    dest: r.dest || null,
    // 'assessment': a watched candidate with stored evidence; 'import': decided by the movement import alone.
    source: r.src === SRC_IMPORT ? 'import' : 'assessment',
  };
}

function zeroCounts() { const o = {}; for (const v of VERDICTS) o[v] = 0; return o; }
function countsOf(row) { const o = zeroCounts(); if (row) VERDICTS.forEach((v, i) => { o[v] = Number(row[`n${i}`]) || 0; }); return o; }
function total(counts) { return VERDICTS.reduce((n, v) => n + (counts[v] || 0), 0); }

/**
 * Per-day completeness: what the movement import recorded against what the
 * ledger holds. recorded = seller departures the import read for the day;
 * policyExcluded = departures on extensions the owner's signal policy gives
 * zero weight (never stored); expected = recorded - policyExcluded;
 * difference = expected - ledger (0 when every departure is in the ledger).
 */
function completenessFor(importRow, ledgerRows, { trimmed = false } = {}) {
  if (!importRow || trimmed) return { recorded: importRow ? Number(importRow.departures) || 0 : null, policyExcluded: null, expected: null, ledger: ledgerRows, difference: null, importedAt: importRow ? importRow.imported_at || null : null, ...(trimmed ? { trimmed: true } : {}) };
  let summary = {};
  try { summary = JSON.parse(importRow.summary_json) || {}; } catch (_) { summary = {}; }
  const recorded = Number(importRow.departures) || 0;
  const policyExcluded = Number(summary.excludedByPolicy) || 0;
  const expected = recorded - policyExcluded;
  return {
    recorded, policyExcluded, expected, ledger: ledgerRows, difference: expected - ledgerRows, importedAt: importRow.imported_at || null,
    zones: Number(summary.zones) || null, movedAtImport: Number(summary.platformExcluded) || 0, expiredAtImport: Number(summary.expiryExcluded) || 0, admitted: Number(importRow.queued) || 0,
  };
}

function ftsMatch(words) { return words.map(w => `"${w}"`).join(' AND '); }

/** Ids of the newest name-word matches in [fromN, toN]: { ids, words, capped }. */
function searchIds(db, { q, fromN, toN }) {
  let words = queryWords(q);
  if (!words.length) return { ids: [], words, capped: false };
  const run = list => db.prepare(SQL.search).all({ match: ftsMatch(list), lo: fromN * DAY_SPAN, hi: (toN + 1) * DAY_SPAN, cap: SEARCH_CAP + 1 }).map(r => r.id);
  let ids = run(words);
  if (!ids.length && words.length === 1) {
    // "matrixinference" typed whole: search its own words (matrix AND inference).
    const parts = ledgerWords(`${words[0]}.com`).split(' ').filter(Boolean);
    if (parts.length > 1) { words = parts; ids = run(parts); }
  }
  const capped = ids.length > SEARCH_CAP;
  return { ids: capped ? ids.slice(0, SEARCH_CAP) : ids, words, capped };
}

/**
 * GET /api/sale-watch/daily?scope=ledger. Days newest first; inside a day the
 * verdict groups in VERDICTS order, shortest names first. Every day carries
 * its counts by verdict and its completeness numbers whatever the filter; the
 * rows are the requested verdicts only. With q the rows are the names holding
 * every query word (whole words, name only) and matchCounts counts them.
 */
function readLedgerDaily(db, query = {}) {
  const { from, to, verdicts, q = '', cursor = null } = query.scope === 'ledger' && Array.isArray(query.verdicts) ? query : normalizeLedgerQuery(query, { now: query.now || null });
  const base = { schema: LEDGER_SCHEMA, scope: 'ledger', from, to, q, verdicts, verdictOrder: VERDICTS.slice(), verdictLabels: VERDICT_LABELS, retentionDays: RETENTION_DAYS };
  if (!ledgerAvailable(db)) return { ...base, status: 'pending', detail: 'The ledger is being built by the indexer', days: [], pagination: { nextCursor: null } };
  const fromN = dayNumber(from);
  const toN = dayNumber(to);
  const vIdx = verdicts.map(v => VERDICTS.indexOf(v));
  const countRows = new Map(db.prepare(SQL.dayCounts).all({ from: fromN, to: toN }).map(r => [r.dayn, r]));
  let importRows = new Map();
  try { importRows = new Map(db.prepare(SQL.imports).all({ from, to }).map(r => [r.day, r])); } catch (_) { importRows = new Map(); }
  // Days before the bulk floor no longer hold their moved / expired rows (size bound).
  const floorN = bulkFloor(db);
  const trimmedDay = dayn => floorN > 0 && dayn < floorN;
  const start = cursor ? decodeCursor(cursor) : null;
  const days = [];
  let nextCursor = null;
  let shown = 0;
  const mint = extra => encodeCursor({ v: 1, from, to, verdicts: verdicts.join(','), q, ...extra });
  const dayShell = (dayn, continued) => {
    const counts = countsOf(countRows.get(dayn));
    const day = dayOf(dayn);
    return { day, continued, counts, ledgerRows: total(counts), completeness: completenessFor(importRows.get(day), total(counts), { trimmed: trimmedDay(dayn) }), rows: [] };
  };

  let search = null;
  if (q) {
    // Name-word search: FTS ids in the window (newest first, capped), the
    // verdict read from the id itself, then the page's rows by primary key.
    const found = searchIds(db, { q, fromN, toN });
    const all = found.ids.filter(id => vIdx.includes(idVerdict(id)));
    const matchCounts = zeroCounts();
    for (const id of found.ids) matchCounts[VERDICTS[idVerdict(id)]] += 1;
    // Day DESC, then verdict order and shortest first (the id order inside a day).
    all.sort((a, b) => (idDay(b) - idDay(a)) || (a - b));
    const offset = start && Number.isInteger(start.offset) && start.offset > 0 ? start.offset : 0;
    const pageIds = all.slice(offset, offset + PAGE_ROWS);
    const byId = new Map(db.prepare(SQL.rowsById).all({ ids: JSON.stringify(pageIds) }).map(r => [r.id, r]));
    let current = null;
    for (const id of pageIds) {
      const row = byId.get(id);
      if (!row) continue;
      const dayn = idDay(id);
      if (!current || current.dayn !== dayn) { current = { dayn, shell: dayShell(dayn, false) }; current.shell.matches = 0; days.push(current.shell); }
      current.shell.rows.push(rowOut(row, id));
    }
    const perDay = new Map();
    for (const id of all) perDay.set(idDay(id), (perDay.get(idDay(id)) || 0) + 1);
    for (const d of days) d.matches = perDay.get(dayNumber(d.day)) || 0;
    if (offset + pageIds.length < all.length) nextCursor = mint({ offset: offset + pageIds.length });
    search = { words: found.words, matches: all.length, matchCounts, capped: found.capped, cap: SEARCH_CAP };
  } else {
    const page = db.prepare(SQL.bucketPage);
    let dayn = start && Number.isInteger(start.dayn) ? Math.min(start.dayn, toN) : toN;
    let vPos = start && Number.isInteger(start.vPos) ? start.vPos : 0;
    let after = start && Number.isFinite(start.after) ? start.after : null;
    outer: for (; dayn >= fromN; dayn -= 1, vPos = 0, after = null) {
      const counts = countRows.get(dayn);
      const shell = dayShell(dayn, !!(start && dayn === start.dayn && (start.vPos > 0 || start.after != null)));
      // Days with no ledger rows and no import record are not listed.
      if (!counts && !importRows.has(shell.day)) continue;
      days.push(shell);
      for (; vPos < vIdx.length; vPos += 1, after = null) {
        const v = vIdx[vPos];
        if (!counts || !(Number(counts[`n${v}`]) > 0)) continue;
        const lo = bucketLo(dayn, v);
        const take = PAGE_ROWS - shown;
        if (take <= 0) { nextCursor = mint({ dayn, vPos, after }); break outer; }
        const rows = page.all({ after: after == null ? lo - 1 : after, hi: lo + BUCKET_SPAN, take: take + 1 });
        const more = rows.length > take;
        for (const r of rows.slice(0, take)) shell.rows.push(rowOut(r));
        shown += Math.min(rows.length, take);
        if (more) { nextCursor = mint({ dayn, vPos, after: rows[take - 1].id }); break outer; }
      }
    }
  }

  const out = { ...base, days, pagination: { nextCursor } };
  if (search) out.search = search;
  if (!cursor) {
    // Whole-window totals and completeness, from the per-day counts (<= 90 rows).
    const totals = zeroCounts();
    const sum = { recorded: 0, policyExcluded: 0, expected: 0, ledger: 0, difference: 0, daysWithImport: 0, daysMismatched: 0, daysWithoutImport: 0 };
    const perDay = [];
    for (let dayn = toN; dayn >= fromN; dayn -= 1) {
      const counts = countsOf(countRows.get(dayn));
      for (const v of VERDICTS) totals[v] += counts[v];
      const day = dayOf(dayn);
      const c = completenessFor(importRows.get(day), total(counts), { trimmed: trimmedDay(dayn) });
      if (c.trimmed) { if (importRows.has(day) || total(counts)) sum.daysTrimmed = (sum.daysTrimmed || 0) + 1; }
      else if (c.recorded == null) { if (total(counts)) sum.daysWithoutImport += 1; }
      else {
        sum.daysWithImport += 1; sum.recorded += c.recorded; sum.policyExcluded += c.policyExcluded; sum.expected += c.expected; sum.difference += c.difference;
        if (c.difference !== 0) sum.daysMismatched += 1;
      }
      sum.ledger += total(counts);
      if (countRows.has(dayn) || importRows.has(day)) perDay.push({ day, counts, ledgerRows: total(counts), recorded: c.recorded, expected: c.expected, difference: c.difference });
    }
    out.window = { from, to, totals, completeness: sum, days: perDay, ...(floorN > 0 && floorN > fromN ? { bulkKeptFrom: dayOf(floorN) } : {}) };
  }
  return out;
}

function weekStart(day) {
  // ISO week: Monday.
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Parses ?q&days for the trend route. */
function normalizeTrendQuery(query = {}) {
  const words = queryWords(typeof query.q === 'string' ? query.q.slice(0, Q_MAX) : '');
  if (words.length !== 1) throw new LedgerQueryError('q: must be one word of 2 to 40 letters or digits');
  let days = 90;
  if (query.days !== undefined && query.days !== '') {
    if (!/^\d+$/.test(String(query.days)) || Number(query.days) < 1 || Number(query.days) > MAX_WINDOW_DAYS) throw new LedgerQueryError(`days: must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
    days = Number(query.days);
  }
  return { q: words[0], days };
}

/**
 * GET /api/sale-watch/trend?q=<word>&days=<=90: per-day and per-week counts of
 * ledger rows whose name holds the word, by verdict group. One primary-key
 * range on the precomputed word-day table (at most `days` rows).
 */
function readLedgerTrend(db, query = {}) {
  const { q, days } = normalizeTrendQuery(query);
  const to = isoDay(query.now || null);
  const toN = dayNumber(to);
  const fromN = toN - days + 1;
  const base = { schema: TREND_SCHEMA, q, days, from: dayOf(fromN), to, verdictOrder: VERDICTS.slice() };
  if (!ledgerAvailable(db)) return { ...base, status: 'pending', byDay: [], byWeek: [], totals: zeroCounts() };
  const stored = new Map(db.prepare(SQL.wordDays).all({ word: q, from: fromN, to: toN }).map(r => [r.dayn, r]));
  const byDay = [];
  const weeks = new Map();
  const totals = zeroCounts();
  for (let dayn = fromN; dayn <= toN; dayn += 1) {
    const counts = countsOf(stored.get(dayn));
    const day = dayOf(dayn);
    byDay.push({ day, ...counts, total: total(counts) });
    const wk = weekStart(day);
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, days: 0, ...zeroCounts(), total: 0 });
    const w = weeks.get(wk);
    w.days += 1;
    for (const v of VERDICTS) { w[v] += counts[v]; totals[v] += counts[v]; }
    w.total += total(counts);
  }
  return { ...base, byDay, byWeek: [...weeks.values()], totals };
}

/**
 * Words rising among sold + probably sold names: the last `recentDays` days
 * against the `days - recentDays` before them. Reads only the sold rows of
 * each day (primary-key ranges). rise = recent - prior scaled to the same
 * number of days; a word needs at least `min` recent names to be listed.
 */
function computeRising(db, { now = null, days = RISING_DAYS, recentDays = RISING_RECENT_DAYS, min = RISING_MIN_COUNT, max = RISING_MAX } = {}) {
  const to = isoDay(now);
  const toN = dayNumber(to);
  const fromN = toN - days + 1;
  const recentFrom = toN - recentDays + 1;
  const priorDays = days - recentDays;
  const stmt = db.prepare(SQL.soldWords);
  const sold = VERDICTS.indexOf('sold');
  const tally = new Map();
  let recentNames = 0;
  let priorNames = 0;
  for (let dayn = fromN; dayn <= toN; dayn += 1) {
    const lo = bucketLo(dayn, sold);
    const recent = dayn >= recentFrom;
    for (const row of stmt.iterate({ lo, hi: lo + BUCKET_SPAN })) {
      if (recent) recentNames += 1; else priorNames += 1;
      for (const word of String(row.words || '').split(' ')) {
        if (!word) continue;
        let t = tally.get(word);
        if (!t) { t = { recent: 0, prior: 0 }; tally.set(word, t); }
        if (recent) t.recent += 1; else t.prior += 1;
      }
    }
  }
  const scale = priorDays > 0 ? recentDays / priorDays : 0;
  const words = [];
  for (const [word, t] of tally) {
    if (t.recent < min) continue;
    const expected = t.prior * scale;
    const rise = t.recent - expected;
    if (rise <= 0) continue;
    words.push({ word, recent: t.recent, prior: t.prior, priorPerWindow: Math.round(expected * 100) / 100, rise: Math.round(rise * 100) / 100, ratio: expected > 0 ? Math.round((t.recent / expected) * 100) / 100 : null });
  }
  words.sort((a, b) => b.rise - a.rise || b.recent - a.recent || (a.word < b.word ? -1 : 1));
  return { schema: RISING_SCHEMA, generatedAt: new Date().toISOString(), to, days, recentDays, priorDays, minCount: min, soldNames: { recent: recentNames, prior: priorNames }, words: words.slice(0, max) };
}

function normalizeRisingQuery(query = {}) {
  let days = RISING_DAYS;
  if (query.days !== undefined && query.days !== '') {
    if (!/^\d+$/.test(String(query.days)) || Number(query.days) < 14 || Number(query.days) > MAX_WINDOW_DAYS) throw new LedgerQueryError(`days: must be an integer from 14 to ${MAX_WINDOW_DAYS}`);
    days = Number(query.days);
  }
  return { days };
}

/**
 * GET /api/sale-watch/trend/rising?days=28: the precomputed list the indexer
 * worker stores after every pass (one meta row). Another window, or a stored
 * list from before today, is computed from the sold rows of the window.
 */
function readLedgerRising(db, query = {}) {
  const { days } = normalizeRisingQuery(query);
  if (!ledgerAvailable(db)) return { schema: RISING_SCHEMA, status: 'pending', days, words: [] };
  const today = isoDay(query.now || null);
  if (days === RISING_DAYS) {
    try {
      const stored = JSON.parse(getMeta(db, META_RISING) || 'null');
      if (stored && stored.schema === RISING_SCHEMA && stored.to === today && stored.days === days) return { ...stored, source: 'stored' };
    } catch (_) { /* fall through to the live read */ }
  }
  return { ...computeRising(db, { now: query.now || null, days }), source: 'live' };
}

// ── indexer-worker maintenance (writable handle, small transactions) ──────
function pause() { return require('./sale-watch-yield').yieldBetweenTransactions(); }

/**
 * Keeps the ledger inside its bounds, PRUNE_BATCH rows per transaction:
 *   1. deletes every row older than the retention window;
 *   2. while more than maxRows rows remain, deletes the 'moved' and 'expired'
 *      rows of the oldest day that still has them and moves the bulk floor
 *      past that day (writeLedgerRow then refuses those verdicts before it).
 * Returns { deleted, trimmedDays, bulkFloor }.
 */
async function pruneLedger(db, { now = null, batch = PRUNE_BATCH, limit = 200000, maxRows = MAX_ROWS } = {}) {
  const select = db.prepare(SQL.pruneIds);
  const range = db.prepare(SQL.bucketPage);
  const remove = writeStatements(db).remove;
  let deleted = 0;
  const removeIds = ids => db.transaction(() => { let n = 0; for (const id of ids) n += remove.run(id).changes; return n; }).immediate();
  const hi = retentionFloor(now) * DAY_SPAN;
  while (deleted < limit) {
    const ids = select.all({ hi, take: batch }).map(r => r.id);
    if (!ids.length) break;
    deleted += removeIds(ids);
    await pause();
    if (ids.length < batch) break;
  }
  let trimmedDays = 0;
  const todayN = dayNumber(isoDay(now));
  const counts = db.prepare(SQL.dayCounts).all({ from: 0, to: todayN }).reverse(); // oldest first
  let rows = counts.reduce((n, r) => n + N_COLS.reduce((m, c) => m + (Number(r[c]) || 0), 0), 0);
  const bulk = BULK_VERDICTS.map(v => VERDICTS.indexOf(v));
  for (const day of counts) {
    if (rows <= maxRows || deleted >= limit) break;
    if (day.dayn >= todayN - 1) break; // never today's or yesterday's rows
    if (!bulk.some(v => Number(day[`n${v}`]) > 0)) continue;
    // The floor moves first, so a concurrent write cannot refill the day.
    setMeta(db, META_BULK_FLOOR, String(day.dayn + 1));
    bulkFloor(db, { fresh: true });
    for (const v of bulk) {
      const lo = bucketLo(day.dayn, v);
      for (;;) {
        const ids = range.all({ after: lo - 1, hi: lo + BUCKET_SPAN, take: batch }).map(r => r.id);
        if (!ids.length) break;
        const n = removeIds(ids);
        deleted += n; rows -= n;
        await pause();
        if (ids.length < batch) break;
      }
    }
    trimmedDays += 1;
  }
  return { deleted, trimmedDays, bulkFloor: bulkFloor(db, { fresh: true }) || null };
}

/** Recomputes the rising-words list and stores it in one meta row. */
function storeRising(db, { now = null } = {}) {
  const value = computeRising(db, { now });
  setMeta(db, META_RISING, JSON.stringify(value));
  return { words: value.words.length };
}

/**
 * The verdict the movement import gives a departure it does not admit:
 * { verdict, classification, dest } for a platform or expiry destination, or
 * null (the departure becomes a candidate, or the signal policy drops it).
 * The same admission test as ingestMovementCandidates (which records its own
 * rows with the same rule; this function serves the tape backfill).
 */
function importDepartureVerdict(row, { platformMatcher, learnedPlatformKeys, nsSetKey, registrableNsDomain, isExpiryDestination }) {
  const today = row.today_ns || [];
  const nsKey = nsSetKey(today);
  const staticMatch = platformMatcher(today);
  const expiry = isExpiryDestination(today);
  if (staticMatch.isPlatform || (nsKey && learnedPlatformKeys.has(nsKey))) {
    const label = staticMatch.isPlatform ? staticMatch.provider : registrableNsDomain(nsKey.split(',')[0]);
    // An expiry or redemption host is 'expired' even where the platform table also lists it.
    return expiry.isExpiry ? { verdict: 'expired', classification: 'expiration', dest: expiry.provider || label } : { verdict: 'moved', classification: 'platform-destination', dest: label };
  }
  if (expiry.isExpiry) return { verdict: 'expired', classification: 'expiration', dest: expiry.provider || null };
  return null;
}

/**
 * Records the platform / expiry departures of already-imported days whose
 * tapes are still on disk and that predate the ledger (no import-day mark):
 * each day's movement tapes are read once, BACKFILL_BATCH rows per
 * transaction, with a pause between transactions. Learned platforms come from
 * the persisted per-day counts, exactly as the import derives them. A day
 * with no tape on disk is marked 'no-tape' and stays without those rows.
 */
async function backfillImportDepartures(db, { directory = null, now = null, maxDays = RETENTION_DAYS, log = null } = {}) {
  const out = { days: 0, rows: 0, missingTapes: 0 };
  if (!directory) return out;
  let dayDirs;
  try { dayDirs = new Set(fs.readdirSync(directory).filter(d => DAY_RE.test(d))); } catch (_) { return out; }
  const today = isoDay(now);
  const floor = dayOf(Math.max(1, dayNumber(today) - Math.min(maxDays, RETENTION_DAYS)));
  let imported = [];
  try { imported = db.prepare('SELECT day FROM sale_watch_movement_imports WHERE day >= ? ORDER BY day DESC').all(floor).map(r => r.day); } catch (_) { return out; }
  const classes = require('./nameserver-classes');
  const platformMatcher = classes.buildPlatformMatcher();
  for (const day of imported) {
    if (importDayMarked(db, day)) continue;
    if (!dayDirs.has(day)) { setMeta(db, `${META_BACKFILL_PREFIX}${day}`, 'no-tape'); out.missingTapes += 1; continue; }
    const tapes = require('./universe-lane').dayMovementTapes(directory, day);
    if (!tapes.length) { setMeta(db, `${META_BACKFILL_PREFIX}${day}`, 'no-tape'); out.missingTapes += 1; continue; }
    // Learned platforms for the day: its persisted destination counts plus the trailing window.
    const learnedPlatformKeys = new Set();
    try {
      const trailingStart = dayMinus(day, classes.LEARNED_PLATFORM_TRAILING_DAYS);
      const trailing = db.prepare('SELECT SUM(count) AS c FROM sale_watch_learned_platform_days WHERE ns_key = ? AND day >= ? AND day < ?');
      for (const r of db.prepare('SELECT ns_key, count FROM sale_watch_learned_platform_days WHERE day = ?').iterate(day)) {
        if (classes.isLearnedPlatformCohort({ dailyCount: r.count, trailingCount: trailing.get(r.ns_key, trailingStart, day)?.c || 0 }).learned) learnedPlatformKeys.add(r.ns_key);
      }
    } catch (_) { /* no learned table: static platforms only */ }
    const helpers = { platformMatcher, learnedPlatformKeys, nsSetKey: classes.nsSetKey, registrableNsDomain: classes.registrableNsDomain, isExpiryDestination: classes.isExpiryDestination };
    const save = db.transaction(batch => { let n = 0; for (const item of batch) if (recordImportDeparture(db, { ...item, day, now }) != null) n += 1; return n; });
    let dayRows = 0;
    for (const tape of tapes) {
      const lines = readline.createInterface({ input: fs.createReadStream(tape.tape), crlfDelay: Infinity });
      let batch = [];
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch (_) { continue; }
        if (!row.domain) continue;
        const isDeparture = (row.selection === 'departures' || row.kind === 'dropped') && ['seller', 'parking'].includes(row.prev_class) && Array.isArray(row.prev_ns);
        if (!isDeparture) continue;
        const verdict = importDepartureVerdict(row, helpers);
        if (!verdict) continue;
        batch.push({ domain: row.domain, ...verdict });
        if (batch.length >= BACKFILL_BATCH) { dayRows += save.immediate(batch); batch = []; await pause(); }
      }
      if (batch.length) { dayRows += save.immediate(batch); await pause(); }
    }
    markImportDay(db, day, 'backfill');
    out.days += 1;
    out.rows += dayRows;
    if (log) { try { log.log(`[SaleWatchLedger] backfilled ${day}: ${dayRows} platform/expiry departures`); } catch (_) { /* advisory */ } }
  }
  return out;
}

/**
 * The ledger stage of the indexer worker's bulk pass: schema, the import
 * backfill for days that predate the ledger, retention, and the rising list.
 * Candidate rows are written by the stored-assessment pass itself.
 */
async function maintainLedger(db, { now = null, directory = undefined, log = undefined } = {}) {
  ensureLedgerSchema(db);
  const dir = directory !== undefined ? directory
    : (process.env.DOMAINSCOUT_UNIVERSE_DIR || (db.name && db.name !== ':memory:' && !db.memory ? path.join(path.dirname(db.name), 'universe') : null));
  const logger = log === undefined ? (db.memory ? null : console) : log;
  const backfill = await backfillImportDepartures(db, { directory: dir, now, log: logger });
  const pruned = await pruneLedger(db, { now });
  const rising = storeRising(db, { now });
  return { examined: backfill.rows + pruned.deleted, backfill, pruned, rising };
}

/** Registers the ledger read operations' HTTP routes (trend + rising). The daily route is in sale-watch-insights. */
function registerLedgerRoutes(app, options = {}) {
  const fail = (res, schema, error) => {
    if (error instanceof LedgerQueryError) return res.status(error.status || 400).json({ schema, error: 'Invalid Sale Watch ledger request', detail: error.message });
    res.set('Retry-After', '5');
    return res.status(503).json({ schema, status: 'pending', error: 'Sale Watch ledger is temporarily busy', detail: String((error && error.message) || error), retryAfterMs: 5000 });
  };
  const route = (pathname, schema, normalize, loaderName) => app.get(pathname, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const query = normalize(req.query || {});
      if (typeof options[loaderName] !== 'function') throw new Error('Sale Watch ledger is not configured on this deployment');
      const value = await options[loaderName](query);
      if (!value || typeof value !== 'object') throw new Error('Sale Watch ledger read returned nothing');
      res.json(value);
    } catch (error) { fail(res, schema, error); }
  });
  // The rising route is registered first: Express matches /trend/rising before /trend.
  route('/api/sale-watch/trend/rising', RISING_SCHEMA, normalizeRisingQuery, 'ledgerRisingLoader');
  route('/api/sale-watch/trend', TREND_SCHEMA, normalizeTrendQuery, 'ledgerTrendLoader');
}

module.exports = {
  TABLE, DAYS_TABLE, WORDS_TABLE, FTS_TABLE, LEDGER_SCHEMA, TREND_SCHEMA, RISING_SCHEMA,
  VERDICTS, DEFAULT_VERDICTS, VERDICT_LABELS, CLASSIFICATIONS, SRC_ASSESSMENT, SRC_IMPORT,
  RETENTION_DAYS, MAX_ROWS, META_BULK_FLOOR, MAX_WINDOW_DAYS, PAGE_ROWS, SEARCH_CAP, RISING_DAYS, RISING_RECENT_DAYS, RISING_MIN_COUNT, META_RISING,
  SQL, LedgerQueryError,
  dayNumber, dayOf, bucketLo, idDay, idVerdict, BUCKET_SPAN, DAY_SPAN, ledgerWords,
  ensureLedgerSchema, ledgerAvailable, writeLedgerRow, deleteLedgerRow, recordImportDeparture, markImportDay, importDayMarked, importDepartureVerdict,
  parseVerdicts, queryWords, normalizeLedgerQuery, normalizeTrendQuery, normalizeRisingQuery,
  readLedgerDaily, readLedgerTrend, readLedgerRising, computeRising, completenessFor,
  pruneLedger, storeRising, backfillImportDepartures, maintainLedger, registerLedgerRoutes,
};
